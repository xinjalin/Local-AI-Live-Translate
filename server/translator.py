"""Subtitle translation through a local LLM (LM Studio / any OpenAI-compatible server, or Ollama),
or - only when the user has turned on cloud providers in the popup - an online AI provider.

Part of Local AI Live Translate.  Author: xinjalin

Nothing is sent online unless an online provider is the chosen translator: there is no online
fallback. API keys arrive with the extension's config for the session and are only ever sent to
their provider's own HTTPS address (CLOUD_PROVIDERS, QWEN_HOSTS), never to a URL from the config,
and never logged.

One shared HTTP client is kept open for the lifetime of the server: creating an httpx client
per request costs ~220 ms on Windows, because OpenSSL 3 re-parses the whole CA bundle every time.
"""

import asyncio
import json
import logging
import re
import time
from collections import deque
from dataclasses import dataclass, field

import httpx

from urllib.parse import urlsplit

from prompt_templates import TemplateStore, build_messages

log = logging.getLogger("translator")

LANG_NAMES = {
    "zh-TW": "Traditional Chinese", "zh-CN": "Simplified Chinese", "en": "English", "ja": "Japanese",
    "ko": "Korean", "es": "Spanish", "fr": "French", "de": "German", "ru": "Russian", "id": "Indonesian",
    "vi": "Vietnamese", "th": "Thai", "ms": "Malay", "fil": "Filipino", "hi": "Hindi", "ar": "Arabic",
    "pt": "Portuguese", "it": "Italian", "tr": "Turkish", "pl": "Polish", "uk": "Ukrainian", "nl": "Dutch",
    "bn": "Bengali",
}

# Online AI providers: display name and API address. Keys are only ever sent there.
CLOUD_PROVIDERS = {
    "qwencloud": {"name": "Qwen Cloud", "base": None},  # one of QWEN_HOSTS, chosen in the popup
    "openai": {"name": "OpenAI", "base": "https://api.openai.com/v1"},
    "anthropic": {"name": "Anthropic", "base": "https://api.anthropic.com/v1"},
    "deepseek": {"name": "DeepSeek", "base": "https://api.deepseek.com/v1"},
    "google": {"name": "Google Gemini", "base": "https://generativelanguage.googleapis.com/v1beta/openai"},
    "xai": {"name": "xAI Grok", "base": "https://api.x.ai/v1"},
}
LOCAL_PROVIDERS = ("lmstudio", "ollama")
# Qwen Cloud / Alibaba Cloud Model Studio endpoints (the first is the default)
QWEN_HOSTS = ("maas.qwencloudapi.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com",
              "dashscope.aliyuncs.com")


def qwen_base(url):
    """https://<host> for a Qwen endpoint from the config, if it's one of QWEN_HOSTS; else the default."""
    try:
        parts = urlsplit((url or "").strip())
        if parts.scheme == "https" and parts.hostname in QWEN_HOSTS and not parts.port:
            return f"https://{parts.hostname}"
    except ValueError:
        pass
    return f"https://{QWEN_HOSTS[0]}"


def cloud_host(cfg):
    """Where an online provider's requests go, for the logs (e.g. api.openai.com)."""
    base = qwen_base(cfg.url) if cfg.provider == "qwencloud" else CLOUD_PROVIDERS[cfg.provider]["base"]
    return urlsplit(base).hostname

# Source language names for templates' {source} (the speech engine may report "zh" or "yue").
SOURCE_NAMES = {**LANG_NAMES, "zh": "Chinese", "yue": "Cantonese"}

THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
# "(upbeat music)", "[MUSIC PLAYING]", "♪♪" ... nothing to translate.
NON_SPEECH_RE = re.compile(r"^\s*(?:[\(\[（【][^\)\]）】]*[\)\]）】]|[♪\s.…!?！？,，、。-]+)\s*$")

@dataclass
class LlmConfig:
    provider: str = "lmstudio"            # "lmstudio" (any OpenAI-compatible server), "ollama", or a CLOUD_PROVIDERS id
    api_key: str = ""                     # online provider's API key (never logged)
    url: str = "http://127.0.0.1:1234"    # local server; for Qwen Cloud its endpoint (checked against QWEN_HOSTS)
    model: str = ""
    context_lines: int = 4                # previous subtitle lines sent as context
    context_reset: float = 90.0           # seconds of silence before the context is forgotten
    template: str = "auto"                # prompt template id (prompt_templates.py), "auto": by model

    @property
    def cloud(self):
        return self.provider in CLOUD_PROVIDERS

    def __repr__(self):  # (so a key can't end up in a log or traceback through this object)
        return (f"LlmConfig(provider={self.provider!r}, url={self.url!r}, model={self.model!r}, "
                f"key={'set' if self.api_key else 'none'})")


@dataclass
class _History:
    lines: deque = field(default_factory=deque)
    last: float = 0.0


def collapse_repeats(text, keep=3):
    """Cut degenerate loops such as 'wait, wait, wait, wait, ...' down to `keep` repeats."""
    spaced = " " in text.strip()
    units = re.findall(r"\S+\s*", text) if spaced else list(text)
    max_n = 6 if spaced else 10

    def norm(chunk):
        return [u.strip(" ,，、.。!！?？").lower() for u in chunk]

    i = 0
    while i < len(units):
        for n in range(1, max_n + 1):
            unit = norm(units[i:i + n])
            if len(unit) < n:
                break
            reps = 1
            while norm(units[i + reps * n:i + (reps + 1) * n]) == unit:
                reps += 1
            if reps > keep + 1:
                del units[i + keep * n:i + reps * n]
                break
        i += 1
    return "".join(units).strip()


def clean_output(text):
    """Strip reasoning blocks, extra lines and repetition loops from the model output."""
    text = THINK_RE.sub("", text or "")
    if "<think>" in text.lower():  # ran out of tokens while reasoning
        text = text[: text.lower().index("<think>")]
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    return collapse_repeats(lines[0]) if lines else ""


def redact(text, key):
    """`text` with the API key in it (e.g. an error echoing the request) replaced."""
    return text.replace(key, "***") if key and len(key) >= 8 else text


class Translator:
    def __init__(self, templates=None):
        # Prompt templates (built-in, plus the user's when given a TemplateStore)
        self.templates = templates or TemplateStore("")
        # Last online provider error (e.g. a wrong API key), shown once on the page; None when working
        self.cloud_error = None
        # Option values an online model turned down (HTTP 400 naming them): (provider, model) -> {option: index}
        self._declined = {}
        # Local servers are plain HTTP; one pooled client, kept alive between subtitles.
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=3.0),
                                        limits=httpx.Limits(max_keepalive_connections=8, keepalive_expiry=300))
        self._histories = {}
        self._local_down_until = 0.0  # skip the local LLM for a while after a connection failure

    async def close(self):
        await self.client.aclose()

    def _context(self, key, cfg):
        h = self._histories.get(key)
        if not h or time.monotonic() - h.last > cfg.context_reset:
            return []
        return list(h.lines)

    def _remember(self, key, cfg, source, translation):
        h = self._histories.get(key)
        if not h or time.monotonic() - h.last > cfg.context_reset:
            h = self._histories[key] = _History(deque(maxlen=max(cfg.context_lines, 0)))
        h.lines.append((source, translation))
        h.last = time.monotonic()

    async def translate(self, text, target_code, cfg: LlmConfig, source_code=None):
        """Translate one subtitle line. Returns (translation, engine_name, stats).

        source_code: the line's language if known (for templates that name it, e.g. MiLMMT's).

        stats: {"tokens": generated tokens, "tps": generation speed in tokens per second (as LM
        Studio / Ollama report it), "prompt": prompt processing ms}, or None.

        When the translator can't be reached or fails, the line comes back untranslated: nothing is
        sent anywhere else.
        """
        if NON_SPEECH_RE.match(text):
            return text, "passthrough", None
        target = LANG_NAMES.get(target_code, target_code)

        usable = cfg.model and (cfg.api_key if cfg.cloud else True)
        if usable and time.monotonic() >= self._local_down_until:
            key = (cfg.provider, cfg.url, cfg.model, target_code)
            context = self._context(key, cfg) if cfg.context_lines > 0 else []
            _, template = self.templates.resolve(cfg.template, cfg.model)
            source = SOURCE_NAMES.get(source_code or "", "the original language")
            messages, sampling = build_messages(template, target, target_code, text, context, source)
            max_tokens = min(max(3 * len(text) + 24, 48), 256)
            try:
                if cfg.provider == "ollama":
                    out, tokens, speed = await self._ollama(cfg, messages, sampling, max_tokens)
                elif cfg.provider == "anthropic":
                    out, tokens, speed = await self._anthropic(cfg, messages, sampling)
                elif cfg.cloud and cfg.provider != "qwencloud":
                    out, tokens, speed = await self._cloud_openai(cfg, messages, sampling)
                else:
                    out, tokens, speed = await self._openai(cfg, messages, sampling, max_tokens,
                                                            mt_text=text, mt_target=target)
                if out:
                    self.cloud_error = None
                    self._remember(key, cfg, text, out)
                    stats = None
                    if tokens and speed["gen_s"] > 0:
                        stats = {"tokens": tokens, "tps": round(tokens / speed["gen_s"], 1),
                                 "prompt": round(speed["prompt_s"] * 1000)}
                    return out, cfg.model, stats
                log.warning("The model returned an empty translation for: %s", text)
            except (httpx.ConnectError, httpx.ConnectTimeout) as e:
                # Server not running (or offline): don't wait on it for every line, retry in 30 s.
                self._local_down_until = time.monotonic() + 30
                where = cloud_host(cfg) if cfg.cloud else cfg.url
                log.warning("LLM at %s unreachable (%s); retrying in 30 s", where, type(e).__name__)
                if cfg.cloud:
                    self.cloud_error = "can't be reached - check the internet connection"
            except httpx.HTTPStatusError as e:
                status = e.response.status_code
                log.warning("LLM translation failed: HTTP %s %s", status, redact(e.response.text[:200], cfg.api_key))
                if cfg.cloud:
                    self.cloud_error = f"HTTP {status}" + (
                        " - check the API key" if status in (401, 403) else
                        " - rate limit or quota reached" if status == 429 else
                        " - check the model name" if status == 404 else "")
            except Exception as e:
                log.warning("LLM translation failed: %s: %s", type(e).__name__, redact(str(e), cfg.api_key))

        return text, "untranslated", None

    async def _openai(self, cfg, messages, sampling, max_tokens, mt_text=None, mt_target=None):
        """Returns (text, generated tokens, {"prompt_s", "gen_s"}).

        Streamed only to time the model: the first token marks the end of prompt processing, the
        rest is generation (how LM Studio measures its tokens/s). The line is still used whole, and
        the total time is the same as without streaming.
        """
        body = {"model": cfg.model, "messages": messages, "max_tokens": max_tokens,
                "stream": True, "stream_options": {"include_usage": True}}
        headers = {}
        if cfg.provider == "qwencloud":
            # Qwen Cloud's OpenAI-compatible API (any chat or MT model on the account).
            headers["Authorization"] = f"Bearer {cfg.api_key}"
            body["enable_thinking"] = False  # Qwen3 hybrid models: answer directly
            url = f"{qwen_base(cfg.url)}/compatible-mode/v1/chat/completions"
            body.update({k: v for k, v in sampling.items() if k in ("temperature", "top_p")})
            if cfg.model.lower().startswith("qwen-mt"):
                # Qwen-MT translation models take the bare text plus translation_options.
                body["messages"] = [{"role": "user", "content": mt_text or messages[-1]["content"]}]
                target = {"Simplified Chinese": "Chinese"}.get(mt_target, mt_target)
                body["translation_options"] = {"source_lang": "auto", "target_lang": target}
        else:
            url = f"{cfg.url.rstrip('/').removesuffix('/v1')}/v1/chat/completions"
            # LM Studio honours this per request for hybrid thinking models (Qwen3.5/3.8, ...).
            body["reasoning_effort"] = "none"
            body.update(sampling)
        t0 = time.perf_counter()
        first = None
        parts = []
        tokens = None
        async with self.client.stream("POST", url, json=body, headers=headers) as r:
            if r.status_code >= 400:
                await r.aread()
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                data = json.loads(payload)
                tokens = (data.get("usage") or {}).get("completion_tokens") or tokens
                for choice in data.get("choices") or []:
                    piece = (choice.get("delta") or {}).get("content")
                    if piece:
                        if first is None:
                            first = time.perf_counter()
                        parts.append(piece)
        end = time.perf_counter()
        tokens = tokens or len(parts)  # servers that don't report usage send about a token per chunk
        if first is None or len(parts) < 2:
            # Nothing to separate (e.g. the whole line in one chunk): count the whole request.
            speed = {"prompt_s": 0.0, "gen_s": end - t0}
        else:
            speed = {"prompt_s": first - t0, "gen_s": end - first}
        return clean_output("".join(parts)), tokens, speed

    async def _stream(self, url, body, headers, parse):
        """POST `body` as a streamed request; parse(event) gives (text piece, completion tokens or
        None) for each server-sent event. Returns (text, generated tokens, {"prompt_s", "gen_s"})."""
        t0 = time.perf_counter()
        first = None
        parts = []
        tokens = None
        async with self.client.stream("POST", url, json=body, headers=headers) as r:
            if r.status_code >= 400:
                await r.aread()
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                piece, used = parse(json.loads(payload))
                tokens = used or tokens
                if piece:
                    if first is None:
                        first = time.perf_counter()
                    parts.append(piece)
        end = time.perf_counter()
        tokens = tokens or len(parts)
        if first is None or len(parts) < 2:
            speed = {"prompt_s": 0.0, "gen_s": end - t0}
        else:
            speed = {"prompt_s": first - t0, "gen_s": end - first}
        return clean_output("".join(parts)), tokens, speed

    async def _with_options(self, cfg, send, options):
        """send(chosen options) with the fastest option values the model accepts.

        options: {name: [value, next value, ..., None]}. Online models differ in what they take
        (OpenAI's reasoning models refuse `temperature`; models know different reasoning_effort
        values): when a request is refused with HTTP 400 naming an option, its next value is tried
        (None leaves it out), and remembered for the model."""
        declined = self._declined.setdefault((cfg.provider, cfg.model), {})
        for _ in range(8):
            chosen = {}
            for name, values in options.items():
                index = declined.get(name, 0)
                if index < len(values) and values[index] is not None:
                    chosen[name] = values[index]
            try:
                return await send(chosen)
            except httpx.HTTPStatusError as e:
                if e.response.status_code != 400:
                    raise
                text = e.response.text.lower()
                named = [name for name in chosen if name in text]
                if not named:
                    raise
                for name in named:
                    declined[name] = declined.get(name, 0) + 1
                    log.info("%s %s doesn't take %s=%s; trying without it", CLOUD_PROVIDERS[cfg.provider]["name"],
                             cfg.model, name, chosen[name])
        raise RuntimeError("the model turned down every request")

    async def _cloud_openai(self, cfg, messages, sampling):
        """OpenAI, DeepSeek, Google Gemini and xAI Grok, through their OpenAI-compatible APIs."""
        url = f"{CLOUD_PROVIDERS[cfg.provider]['base']}/chat/completions"
        headers = {"Authorization": f"Bearer {cfg.api_key}"}
        # (room for a short answer, and for a little reasoning where it can't be switched off)
        tokens_param = "max_completion_tokens" if cfg.provider == "openai" else "max_tokens"
        options = {"temperature": [sampling.get("temperature", 0.2), None]}
        if cfg.provider == "openai":
            options["reasoning_effort"] = ["none", "minimal", "low", None]
        elif cfg.provider == "google":
            options["reasoning_effort"] = ["none", "low", None]

        def parse(data):
            used = (data.get("usage") or {}).get("completion_tokens")
            piece = "".join((c.get("delta") or {}).get("content") or "" for c in data.get("choices") or [])
            return piece, used

        async def send(chosen):
            body = {"model": cfg.model, "messages": messages, tokens_param: 1024, "stream": True,
                    "stream_options": {"include_usage": True}, **chosen}
            return await self._stream(url, body, headers, parse)

        return await self._with_options(cfg, send, options)

    async def _anthropic(self, cfg, messages, sampling):
        """Anthropic's Messages API (the system prompt is a separate field)."""
        url = f"{CLOUD_PROVIDERS['anthropic']['base']}/messages"
        headers = {"x-api-key": cfg.api_key, "anthropic-version": "2023-06-01"}
        system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
        turns = [m for m in messages if m["role"] != "system"]

        def parse(data):
            kind = data.get("type")
            if kind == "content_block_delta" and (data.get("delta") or {}).get("type") == "text_delta":
                return data["delta"].get("text"), None
            if kind == "message_delta":
                return None, (data.get("usage") or {}).get("output_tokens")
            if kind == "error":
                raise RuntimeError((data.get("error") or {}).get("message") or "error")
            return None, None

        async def send(chosen):
            body = {"model": cfg.model, "max_tokens": 1024, "messages": turns, "stream": True, **chosen}
            if system:
                body["system"] = system
            return await self._stream(url, body, headers, parse)

        return await self._with_options(cfg, send, {"temperature": [sampling.get("temperature", 0.2), None]})

    async def _ollama(self, cfg, messages, sampling, max_tokens):
        options = {"temperature": sampling.get("temperature", 0.2), "num_predict": max_tokens}
        for k in ("top_p", "top_k"):
            if k in sampling:
                options[k] = sampling[k]
        if "repeat_penalty" in sampling:
            options["repeat_penalty"] = sampling["repeat_penalty"]
        body = {"model": cfg.model, "messages": messages, "stream": False, "think": False,
                "keep_alive": "30m", "options": options}
        r = await self.client.post(f"{cfg.url.rstrip('/')}/api/chat", json=body)
        r.raise_for_status()
        data = r.json()
        # Ollama reports its own prompt and generation times (ns).
        speed = {"prompt_s": (data.get("prompt_eval_duration") or 0) / 1e9,
                 "gen_s": (data.get("eval_duration") or 0) / 1e9}
        return clean_output((data.get("message") or {}).get("content")), data.get("eval_count"), speed


async def _selftest():
    """python translator.py  ->  translate a few lines with the model loaded in LM Studio."""
    import sys
    t = Translator()
    cfg = LlmConfig(model=sys.argv[1] if len(sys.argv) > 1 else "hy-mt2-7b")
    for line in ["ちょっと待って!やばいやばいやばい!", "しおりちゃんが教えてくれたんだよね。", "(upbeat music)"]:
        t0 = time.perf_counter()
        out, engine, stats = await t.translate(line, "en", cfg)
        speed = f" {stats['tps']:.0f} t/s" if stats else ""
        print(f"{(time.perf_counter() - t0) * 1000:5.0f} ms [{engine}{speed}] {line} => {out}")
    await t.close()


if __name__ == "__main__":
    asyncio.run(_selftest())
