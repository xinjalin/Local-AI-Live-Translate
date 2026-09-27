"""
Qwen Cloud LiveTranslate (qwen3.8 / qwen3.5-livetranslate-flash-realtime) client.  Author: xinjalin

With a LiveTranslate model the tab's audio is streamed to Qwen Cloud, which detects the speech,
recognises it and translates it itself (simultaneous interpretation); this replaces the local
speech detection, speech recognition and LLM. Protocol (WebSocket, JSON events):

  client: session.update -> input_audio_buffer.append (base64 16 kHz PCM) ... -> session.finish
  server: input_audio_buffer.speech_started / speech_stopped (audio_start_ms / audio_end_ms),
          conversation.item.input_audio_transcription.text / .completed (source text),
          response.text.delta (3.8) or response.text.text (3.5) (translation so far),
          response.text.done (final translation), error, session.finished

Docs: https://docs.qwencloud.com/developer-guides/speech/realtime-translation
"""

import asyncio
import base64
import json
import logging
import time
from urllib.parse import quote, urlsplit

from translator import qwen_base

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

log = logging.getLogger("live-translate")

SAMPLE_RATE = 16000
APPEND_BYTES = 3200  # 100 ms of 16 kHz 16-bit audio per input_audio_buffer.append
# The extension's language codes -> LiveTranslate's
QWEN_LANGS = {"zh-TW": "zh", "zh-CN": "zh"}


def is_livetranslate(model):
    model = (model or "").lower()
    return "livetranslate" in model and "realtime" in model


def realtime_url(base, model):
    """https://maas.qwencloudapi.com (or another of translator.QWEN_HOSTS; anything else becomes the
    default, so the API key only goes to Qwen) -> wss://.../api-ws/v1/realtime?model=..."""
    host = urlsplit(qwen_base(base)).hostname
    return f"wss://{host}/api-ws/v1/realtime?model={quote(model)}"


class Segment:
    """One spoken line: Qwen's speech detection, its transcript and its translation."""

    def __init__(self, item_id, start_ms):
        self.item_id = item_id
        self.start_ms = start_ms
        self.end_ms = None
        self.stopped_at = None     # wall-clock time Qwen said the speech ended
        self.transcript = ""
        self.translation = ""
        self.done = False
        self.speaker_task = None   # local speaker embedding, started when the speech ends


class QwenLiveTranslate:
    """One LiveTranslate connection for one browser tab (see Session in live_translate_server.py)."""

    def __init__(self, session, base, key, model, target_lang, source_lang):
        self.session = session
        self.url = realtime_url(base, model)
        self.key = key
        self.model = model
        self.target_lang = target_lang
        self.source_lang = source_lang
        self.ws = None
        self.audio = asyncio.Queue(maxsize=200)  # ~50 s of 256 ms chunks
        self.segments = []
        self.base_sample = 0       # Session.received when this connection's audio started
        self.tasks = []
        self.closed = False
        self.error_shown = False
        self._finished = asyncio.Event()

    # -- lifecycle -----------------------------------------------------------

    def start(self):
        self.tasks = [asyncio.create_task(self._run())]

    async def close(self):
        self.closed = True
        ws = self.ws
        if ws is not None:
            try:
                # Without session.finish the last line's translation is lost.
                await ws.send(json.dumps({"type": "session.finish"}))
                await asyncio.wait_for(self._finished.wait(), 3)
            except (ConnectionClosed, asyncio.TimeoutError, OSError):
                pass
            await ws.close()
        for task in self.tasks:
            task.cancel()

    def send_audio(self, pcm_bytes):
        if self.closed:
            return
        try:
            self.audio.put_nowait(pcm_bytes)
        except asyncio.QueueFull:  # not connected for a long time: drop the oldest audio
            self.audio.get_nowait()
            self.audio.put_nowait(pcm_bytes)

    async def _run(self):
        delay = 2
        while not self.closed:
            self._finished = asyncio.Event()
            try:
                async with connect(self.url, additional_headers={"Authorization": f"Bearer {self.key}"},
                                   max_size=2 ** 22, open_timeout=10) as ws:
                    self.ws = ws
                    await ws.send(json.dumps(self._session_update()))
                    # Audio from now on belongs to this connection (Qwen's audio_start_ms counts from here).
                    while not self.audio.empty():
                        self.audio.get_nowait()
                    self.base_sample = self.session.received
                    self.segments = []
                    log.info("Qwen Cloud LiveTranslate connected: %s -> %s", self.model, self.target_lang)
                    delay = 2
                    self.error_shown = False
                    sender = asyncio.create_task(self._send_loop(ws))
                    try:
                        async for message in ws:
                            await self._on_event(json.loads(message))
                    finally:
                        sender.cancel()
                        self.ws = None
            except InvalidStatus as e:
                status = e.response.status_code
                await self._show_error(f"HTTP {status}" + (" - check the API key" if status in (401, 403) else ""))
                delay = 30 if status in (401, 403) else delay
            except (OSError, ConnectionClosed, asyncio.TimeoutError) as e:
                if not self.closed:
                    log.warning("Qwen Cloud connection lost: %s", e)
            except Exception:
                log.exception("Qwen Cloud LiveTranslate failed")
            if self.closed:
                break
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)

    def _session_update(self):
        target = QWEN_LANGS.get(self.target_lang, self.target_lang)
        session = {"translation": {"language": target}, "input_audio_format": "pcm", "sample_rate": SAMPLE_RATE}
        if "3.5" in self.model:
            session["modalities"] = ["text"]
            if self.source_lang != "auto":
                session["input_audio_transcription"] = {"language": QWEN_LANGS.get(self.source_lang, self.source_lang)}
        else:
            session["output_modalities"] = ["text"]  # subtitles only: no synthesized speech
        return {"type": "session.update", "session": session}

    async def _send_loop(self, ws):
        while True:
            pcm = await self.audio.get()
            for i in range(0, len(pcm), APPEND_BYTES):
                await ws.send(json.dumps({"type": "input_audio_buffer.append",
                                          "audio": base64.b64encode(pcm[i:i + APPEND_BYTES]).decode()}))

    # -- events --------------------------------------------------------------

    def _current(self):
        """The line whose translation is being written: the oldest one not finished yet. A
        translation without a speech_started (e.g. a long speech split in two) gets a new line."""
        for seg in self.segments:
            if not seg.done:
                return seg
        seg = Segment(None, int((self.session.received - self.base_sample) * 1000 / SAMPLE_RATE))
        self.segments.append(seg)
        return seg

    def _by_item(self, item_id):
        for seg in self.segments:
            if seg.item_id == item_id:
                return seg
        return None

    async def _on_event(self, ev):
        kind = ev.get("type", "")
        if kind == "input_audio_buffer.speech_started":
            self.segments.append(Segment(ev.get("item_id"), ev.get("audio_start_ms", 0)))
            del self.segments[:-20]
        elif kind == "input_audio_buffer.speech_stopped":
            seg = next((s for s in reversed(self.segments) if s.end_ms is None), None)
            if seg:
                seg.end_ms = ev.get("audio_end_ms", seg.start_ms)
                seg.stopped_at = time.time()
                seg.speaker_task = self.session.cloud_speaker(self._sample(seg.start_ms), self._sample(seg.end_ms))
        elif kind == "conversation.item.input_audio_transcription.text":
            seg = self._by_item(ev.get("item_id"))
            if seg:
                seg.transcript = (ev.get("text") or "") + (ev.get("stash") or "")
        elif kind == "conversation.item.input_audio_transcription.completed":
            seg = self._by_item(ev.get("item_id"))
            if seg:
                seg.transcript = ev.get("transcript") or seg.transcript
        elif kind == "response.text.delta":
            seg = self._current()
            seg.translation += ev.get("delta") or ""
            await self._emit(seg, final=False)
        elif kind == "response.text.text":  # qwen3.5: confirmed text + text still being decided
            seg = self._current()
            seg.translation = (ev.get("text") or "") + (ev.get("stash") or "")
            await self._emit(seg, final=False)
        elif kind == "response.text.done":
            seg = self._current()
            seg.translation = ev.get("text") or seg.translation
            seg.done = True
            await self._emit(seg, final=True)
        elif kind == "session.finished":
            self._finished.set()
        elif kind == "error":
            err = ev.get("error") or {}
            await self._show_error(err.get("message") or err.get("code") or "error")

    def _sample(self, ms):
        return self.base_sample + int(ms * SAMPLE_RATE / 1000)

    async def _emit(self, seg, final):
        text = seg.translation.strip()
        if not text:
            return
        if self.target_lang == "zh-TW":  # LiveTranslate writes Simplified Chinese
            text = self.session.cc["zh-TW"].convert(text)
        end_ms = seg.end_ms if seg.end_ms is not None else seg.start_ms
        msg = {"event": "subtitle", "text_raw": seg.transcript.strip() or text, "text_zh": text,
               "start": round(seg.start_ms / 1000, 3), "duration": round(max(end_ms - seg.start_ms, 0) / 1000, 2),
               "engine": self.model}
        speaker = None
        if final and seg.speaker_task is not None:
            speaker = await seg.speaker_task
        elif seg.speaker_task is not None and seg.speaker_task.done():
            speaker = seg.speaker_task.result()
        if speaker is not None:
            msg["speaker"] = speaker
        if final:
            now = time.time()
            speech_end = self.session._captured_at(self._sample(end_ms)) if seg.end_ms is not None else now
            msg["timing"] = {"speech_end": round(speech_end * 1000), "cloud": round(max(now - speech_end, 0) * 1000),
                             "server": round(max(now - speech_end, 0) * 1000), "engine": self.model}
            self.segments.remove(seg)
            log.info("[Qwen %s] %s%s => %s", self.model, f"P{speaker} " if speaker else "", msg["text_raw"], text)
            self.session.write_transcript(seg.start_ms / 1000, msg["text_raw"], text, speaker)
        await self.session.send(msg)

    async def _show_error(self, message):
        log.warning("Qwen Cloud LiveTranslate: %s", message)
        if self.error_shown:
            return
        self.error_shown = True  # once per connection attempt series, not on every retry
        await self.session.send({"event": "subtitle", "text_raw": "", "text_zh": f"⚠ Qwen Cloud: {message}",
                                 "start": -1, "duration": 3})
