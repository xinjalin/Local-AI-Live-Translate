"""Subtitle translation through a local LLM (LM Studio / any OpenAI-compatible server, or Ollama).

Part of Local AI Live Translate.  Author: xinjalin

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

from prompt_templates import BUILTIN, GENERIC_SYSTEM, TemplateStore, build_messages

log = logging.getLogger("translator")

LANG_NAMES = {
    "zh-TW": "Traditional Chinese", "zh-CN": "Simplified Chinese", "en": "English", "ja": "Japanese",
    "ko": "Korean", "es": "Spanish", "fr": "French", "de": "German", "ru": "Russian", "id": "Indonesian",
    "vi": "Vietnamese", "th": "Thai", "ms": "Malay", "fil": "Filipino", "hi": "Hindi", "ar": "Arabic",
    "pt": "Portuguese", "it": "Italian", "tr": "Turkish", "pl": "Polish", "uk": "Ukrainian", "nl": "Dutch",
    "bn": "Bengali",
}
GOOGLE_CODES = {"zh-TW": "zh-TW", "zh-CN": "zh-CN", "fil": "tl"}
# Source language names for templates' {source} (the speech engine may report "zh" or "yue").
SOURCE_NAMES = {**LANG_NAMES, "zh": "Chinese", "yue": "Cantonese"}

THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
# "(upbeat music)", "[MUSIC PLAYING]", "♪♪" ... nothing to translate.
NON_SPEECH_RE = re.compile(r"^\s*(?:[\(\[（【][^\)\]）】]*[\)\]）】]|[♪\s.…!?！？,，、。-]+)\s*$")

@dataclass
class LlmConfig:
    provider: str = "lmstudio"            # "lmstudio" (any OpenAI-compatible server), "ollama" or "qwencloud"
    api_key: str = ""                     # Qwen Cloud API key
    url: str = "http://127.0.0.1:1234"
    model: str = ""
    deepseek_key: str = ""
    context_lines: int = 4                # previous subtitle lines sent as context
    context_reset: float = 90.0           # seconds of silence before the context is forgotten
    online_fallback: bool = True          # fall back to Google Translate if everything local fails
    template: str = "auto"                # prompt template id (prompt_templates.py), "auto": by model


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


class Translator:
    def __init__(self, templates=None):
        # Prompt templates (built-in, plus the user's when given a TemplateStore)
        self.templates = templates or TemplateStore("")
        # Last Qwen Cloud error (e.g. a wrong API key), shown once on the page; None when working
        self.cloud_error = None
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

        stats (local LLM only, else None): {"tokens": generated tokens, "tps": generation speed in
        tokens per second (as LM Studio / Ollama report it), "prompt": prompt processing ms}.
        """
        if NON_SPEECH_RE.match(text):
            return text, "passthrough", None
        target = LANG_NAMES.get(target_code, target_code)

        if cfg.model and time.monotonic() >= self._local_down_until:
            key = (cfg.provider, cfg.url, cfg.model, target_code)
            context = self._context(key, cfg) if cfg.context_lines > 0 else []
            _, template = self.templates.resolve(cfg.template, cfg.model)
            source = SOURCE_NAMES.get(source_code or "", "the original language")
            messages, sampling = build_messages(template, target, target_code, text, context, source)
            max_tokens = min(max(3 * len(text) + 24, 48), 256)
            try:
                if cfg.provider == "ollama":
                    out, tokens, speed = await self._ollama(cfg, messages, sampling, max_tokens)
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
                log.warning("Local model returned an empty translation for: %s", text)
            except (httpx.ConnectError, httpx.ConnectTimeout) as e:
                # Server not running: don't wait on it for every line, retry in 30 s.
                self._local_down_until = time.monotonic() + 30
                log.warning("LLM at %s unreachable (%s); retrying in 30 s", cfg.url, type(e).__name__)
            except httpx.HTTPStatusError as e:
                log.warning("LLM translation failed: HTTP %s %s", e.response.status_code, e.response.text[:200])
                if cfg.provider == "qwencloud":
                    status = e.response.status_code
                    self.cloud_error = f"HTTP {status}" + (" - check the API key" if status in (401, 403) else "")
            except Exception as e:
                log.warning("LLM translation failed: %s: %s", type(e).__name__, e)

        if cfg.deepseek_key:
            try:
                return await self._deepseek(cfg, text, target), "DeepSeek", None
            except Exception as e:
                log.warning("DeepSeek translation failed: %s", e)

        if cfg.online_fallback:
            try:
                return await self._google(text, target_code), "Google", None
            except Exception as e:
                log.warning("Google translation failed: %s", e)

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
            base = cfg.url.rstrip("/").removesuffix("/compatible-mode/v1").removesuffix("/compatible-mode")
            url = f"{base}/compatible-mode/v1/chat/completions"
            headers["Authorization"] = f"Bearer {cfg.api_key}"
            body["enable_thinking"] = False  # Qwen3 hybrid models: answer directly
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

    async def _deepseek(self, cfg, text, target):
        r = await self.client.post(
            "https://api.deepseek.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {cfg.deepseek_key}"},
            json={"model": "deepseek-chat", "temperature": 0.3, "messages": [
                {"role": "system", "content": GENERIC_SYSTEM.replace("{target}", target).replace("{target_rules}", "")},
                {"role": "user", "content": text}]},
            timeout=10.0)
        r.raise_for_status()
        return clean_output(r.json()["choices"][0]["message"]["content"])

    async def _google(self, text, target_code):
        tl = GOOGLE_CODES.get(target_code, target_code.split("-")[0])
        r = await self.client.get("https://translate.googleapis.com/translate_a/single",
                                  params={"client": "gtx", "sl": "auto", "tl": tl, "dt": "t", "q": text},
                                  timeout=5.0)
        r.raise_for_status()
        return "".join(part[0] for part in r.json()[0] if part and part[0]).strip()


async def _selftest():
    """python translator.py  ->  translate a few lines with the model loaded in LM Studio."""
    import sys
    t = Translator()
    cfg = LlmConfig(model=sys.argv[1] if len(sys.argv) > 1 else "hy-mt2-7b", online_fallback=False)
    for line in ["ちょっと待って!やばいやばいやばい!", "しおりちゃんが教えてくれたんだよね。", "(upbeat music)"]:
        t0 = time.perf_counter()
        out, engine, stats = await t.translate(line, "en", cfg)
        speed = f" {stats['tps']:.0f} t/s" if stats else ""
        print(f"{(time.perf_counter() - t0) * 1000:5.0f} ms [{engine}{speed}] {line} => {out}")
    await t.close()


if __name__ == "__main__":
    asyncio.run(_selftest())
