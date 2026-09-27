"""Prompt templates: how each subtitle line is put to the translation model.

Part of Local AI Live Translate.  Author: xinjalin

The app's own templates cover general chat models, Tencent Hy-MT and Xiaomi MiLMMT (which each expect
their own prompt format). They ship as templates/generic.json, hy-mt.json and milmmt.json, and can be
edited there; BUILTIN below is the same content, used when a file is missing or can't be read. Users
add their own as more JSON files in that folder (see templates/README.md). "auto" picks the template
whose `match` words appear in the model's name (the user's first), else the general one.
"""

import json
import logging
import re
from pathlib import Path

log = logging.getLogger("templates")

GENERIC_SYSTEM = (
    "You are a professional subtitle translator for live video. Translate each subtitle line the user "
    "sends into natural, concise {target}. The lines come from automatic speech recognition, so they can "
    "contain misheard words; use the earlier lines of the conversation to infer the intended meaning and "
    "keep names and terms consistent. Output only the {target} translation of the latest line, as a single "
    "line of plain text, with no notes, quotes, romanization, or original text.{target_rules}"
)
# {target_rules}: extra instructions for some target languages.
TARGET_RULES = {
    "zh-TW": " Use Traditional Chinese characters with Taiwan usage only; never output Simplified Chinese.",
}

BUILTIN = {
    "generic": {
        "name": "General (any chat model)",
        "description": "Subtitle-translator instructions, with the earlier lines as conversation history.",
        "system": GENERIC_SYSTEM,
        "history": True,
        "user": "{text}",
        "sampling": {"temperature": 0.2},
    },
    # Tencent Hy-MT has no system prompt; it uses fixed templates (see its model card).
    "hy-mt": {
        "name": "Hy-MT (Tencent)",
        "description": "Tencent's official Hy-MT / Hunyuan-MT templates and sampling.",
        "match": ["hy-mt", "hymt", "hunyuan-mt"],
        "user": ("Translate the following text into {target}. Note that you should only output the "
                 "translated result without any additional explanation:\n\n{text}"),
        "user_with_context": ("[Background Information]\n{context}\n\nPlease translate the following text "
                              "into {target}, taking the provided background information into "
                              "consideration. Only output the translated result.\n\n[Source Text]\n{text}"),
        "sampling": {"temperature": 0.7, "top_p": 0.6, "top_k": 20, "repeat_penalty": 1.05},
    },
    # Xiaomi MiLMMT (a Gemma 3 fine-tune whose chat template only joins the messages): its documented
    # prompt, greedy. It ignores system prompts, so earlier lines aren't sent.
    "milmmt": {
        "name": "MiLMMT (Xiaomi)",
        "description": "Xiaomi MiLMMT's own format: 'Translate this from X to Y'.",
        "match": ["milmmt"],
        "user": "Translate this from {source} to {target}:\n{source}: {text}\n{target}:",
        "sampling": {"temperature": 0.0},
    },
}

PLACEHOLDER_RE = re.compile(r"\{(text|target|source|context|target_rules)\}")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
SAMPLING_KEYS = {"temperature", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty",
                 "frequency_penalty"}
MAX_FILE_BYTES = 64 * 1024


def _text(value, limit):
    return value.strip()[:limit] if isinstance(value, str) else ""


def parse_template(data):
    """A user template (parsed JSON) checked and trimmed to the known fields. Raises ValueError."""
    if not isinstance(data, dict):
        raise ValueError("not a JSON object")
    user = data.get("user")
    if not isinstance(user, str) or "{text}" not in user:
        raise ValueError('"user" must be text containing {text}')
    t = {"user": user[:4000]}
    for key in ("system", "user_with_context"):
        if isinstance(data.get(key), str) and data[key].strip():
            t[key] = data[key][:4000]
    if "user_with_context" in t and ("{text}" not in t["user_with_context"] or "{context}" not in t["user_with_context"]):
        raise ValueError('"user_with_context" must contain {text} and {context}')
    t["name"] = _text(data.get("name"), 60)
    t["description"] = _text(data.get("description"), 200)
    t["history"] = data.get("history") is True
    match = data.get("match") or []
    t["match"] = [m.strip()[:60] for m in (match if isinstance(match, list) else []) if isinstance(m, str) and m.strip()][:10]
    sampling = data.get("sampling") or {}
    t["sampling"] = {k: float(v) for k, v in sampling.items()
                     if k in SAMPLING_KEYS and isinstance(v, (int, float)) and not isinstance(v, bool)} \
        if isinstance(sampling, dict) else {}
    if "top_k" in t["sampling"]:
        t["sampling"]["top_k"] = int(t["sampling"]["top_k"])
    return t


class TemplateStore:
    """The templates in the templates folder: the app's own (generic.json, hy-mt.json, milmmt.json;
    their built-in copies are used when a file is missing or can't be read) and the user's. Re-read
    whenever the folder changes."""

    def __init__(self, folder):
        self.folder = Path(folder)
        self._signature = None
        self._files = {}

    def _load(self):
        try:
            files = sorted(f for f in self.folder.glob("*.json") if not f.name.startswith(("_", ".")))
            signature = tuple((f.name, f.stat().st_mtime_ns, f.stat().st_size) for f in files)
        except OSError:
            files, signature = [], ()
        if signature == self._signature:
            return self._files
        self._signature = signature
        self._files = {}
        for f in files:
            tid = f.stem.lower()
            if not ID_RE.match(tid) or tid == "auto":
                log.warning("Prompt template %s skipped: rename it (letters, digits, - . _; not \"auto\")", f.name)
                continue
            try:
                if f.stat().st_size > MAX_FILE_BYTES:
                    raise ValueError("file too large")
                template = parse_template(json.loads(f.read_text(encoding="utf-8-sig")))
            except (OSError, ValueError) as e:  # json.JSONDecodeError is a ValueError
                extra = "; using the built-in copy" if tid in BUILTIN else ""
                log.warning("Prompt template %s skipped: %s%s", f.name, e, extra)
                continue
            template["name"] = template["name"] or (BUILTIN[tid]["name"] if tid in BUILTIN else f.stem)
            self._files[tid] = template
        missing = [f"{tid}.json" for tid in BUILTIN if tid not in self._files]
        if missing:
            log.info("Prompt templates: using the built-in copy of %s", ", ".join(missing))
        yours = [tid for tid in self._files if tid not in BUILTIN]
        if yours:
            log.info("Prompt templates of your own: %s", ", ".join(yours))
        return self._files

    def templates(self):
        """id -> template: the app's own first, then the user's."""
        files = self._load()
        out = {tid: files.get(tid, t) for tid, t in BUILTIN.items()}
        out.update({tid: t for tid, t in files.items() if tid not in BUILTIN})
        return out

    def listing(self):
        """For the popup's menu: [{id, name, description, builtin, match}]."""
        return [{"id": tid, "name": t["name"], "description": t.get("description", ""), "builtin": tid in BUILTIN,
                 "match": t.get("match", [])} for tid, t in self.templates().items()]

    def resolve(self, template_id, model):
        """(id, template) to use: the chosen one if it exists, else the one matching the model
        (the user's templates first, then the app's), else the general one."""
        templates = self.templates()
        if template_id and template_id != "auto" and template_id in templates:
            return template_id, templates[template_id]
        name = (model or "").lower()
        order = [tid for tid in templates if tid not in BUILTIN] + [tid for tid in BUILTIN if tid != "generic"]
        for tid in order:
            if any(word.lower() in name for word in templates[tid].get("match", [])):
                return tid, templates[tid]
        return "generic", templates["generic"]


def build_messages(template, target, target_code, text, context, source):
    """Chat messages and sampling settings for one subtitle line.

    context: [(earlier original line, its translation), ...], oldest first.
    """
    values = {
        "text": text,
        "target": target,
        "source": source,
        "context": "\n".join(f"{src} => {out}" for src, out in context),
        "target_rules": TARGET_RULES.get(target_code, ""),
    }

    def fill(s):
        # One pass, so braces in the subtitle text itself are never treated as placeholders.
        return PLACEHOLDER_RE.sub(lambda m: values[m.group(1)], s)

    messages = []
    if template.get("system"):
        messages.append({"role": "system", "content": fill(template["system"])})
    if template.get("history"):
        for src, out in context:
            messages.append({"role": "user", "content": src})
            messages.append({"role": "assistant", "content": out})
    user = template["user_with_context"] if context and template.get("user_with_context") else template["user"]
    messages.append({"role": "user", "content": fill(user)})
    return messages, dict(template.get("sampling") or {})
