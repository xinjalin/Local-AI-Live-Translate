"""
Local AI Live Translate server.  Author: xinjalin

Speech recognition + translation server for the Chrome extension. WebSocket on
ws://127.0.0.1:8000/stream (16 kHz mono Int16 PCM in, JSON subtitle events out), built for low latency:

  * speech recognition runs on a worker thread, so the event loop keeps receiving audio and
    translations while a segment is being recognized;
  * recognition and translation are pipelined: line N+1 is recognized while line N is translated;
  * each line is also sent as soon as it is recognized ({"pending": true}), before its translation
    (the extension currently waits for the translated line, so the original never flashes up);
  * the local LLM (LM Studio / OpenAI-compatible, or Ollama) is called directly over one pooled
    keep-alive connection, with no per-request client setup;
  * SenseVoice's detected language is used, so speech already in the target language skips the LLM,
    and Chinese <-> Chinese goes through OpenCC instantly;
  * optional speaker detection labels each line Person 1, 2, ... n; the voice embedding runs on its
    own thread alongside speech recognition, so it doesn't delay the line;
  * online option: Qwen Cloud, either as the translator (any chat / MT model) or, with a
    LiveTranslate model, for the whole job - the audio goes to Qwen Cloud (see qwen_live.py).

Run with START_Local_AI_Live_Translate.bat, or:  python server/live_translate_server.py
"""

import argparse
import asyncio
import collections
import datetime
import json
import logging
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from pathlib import Path

import numpy as np
import opencc
import sherpa_onnx
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from qwen_live import QwenLiveTranslate, is_livetranslate
from translator import LlmConfig, Translator

VERSION = "1.0.0"
SAMPLE_RATE = 16000
VAD_WINDOW = 512  # samples per Silero VAD step at 16 kHz
HISTORY_SECONDS = 20  # recent audio kept for pre-roll (must exceed max speech + silence)

APP_NAME = "Local AI Live Translate"
SERVER_ID = "local-ai-live-translate"  # reported by /health; the extension uses it to detect this server

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "models"
TRANSCRIPT_DIR = ROOT / "transcripts"
VAD_MODEL = MODEL_DIR / "silero_vad.onnx"
SENSE_VOICE_DIR = MODEL_DIR / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
WHISPER_DIR = MODEL_DIR / "sherpa-onnx-whisper-small"
# Dolphin small (DataoceanAI): CTC model for 40 Asian languages (Indonesian, Thai, Vietnamese, ...).
DOLPHIN_DIR = MODEL_DIR / "sherpa-onnx-dolphin-small-ctc-multi-lang-int8-2025-04-02"
# Speaker detection: 3D-Speaker CAM++ voice embeddings (192 values per line), Chinese + English
# training data but works for any language since it models the voice, not the words.
SPEAKER_MODEL = MODEL_DIR / "speaker" / "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"

# Source languages SenseVoice can be told about explicitly (better than auto-detect).
SENSE_VOICE_LANGS = {"zh-TW": "zh", "zh-CN": "zh", "en": "en", "ja": "ja", "ko": "ko"}
# Source languages each speech engine can recognise, of those the extension offers (None: all).
# Measured on Google FLEURS recordings, Dolphin small vs Whisper-Small (word / character errors):
#   Indonesian 18.4% vs 18.0% WER, Vietnamese 10.3% vs 10.8%, Malay 9.9% vs 12.6%,
#   Filipino 28.8% vs 35.3%, Thai 9.9% vs 49.3% CER - with Dolphin ~9x faster (~0.05 s per second
#   of speech against ~0.4 s). SenseVoice can't recognise any of these.
ENGINE_LANGS = {
    "sensevoice": {"zh-TW", "zh-CN", "en", "ja", "ko"},
    "dolphin": {"zh-TW", "zh-CN", "ja", "ko", "ru", "id", "vi", "th", "ms", "fil"},
    "whisper": None,
}
# Whisper's codes where they differ from the extension's.
WHISPER_CODES = {"zh-TW": "zh", "zh-CN": "zh", "fil": "tl"}
ENGINE_FILES = {
    "sensevoice": SENSE_VOICE_DIR / "model.int8.onnx",
    "whisper": WHISPER_DIR / "small-encoder.int8.onnx",
    "dolphin": DOLPHIN_DIR / "model.int8.onnx",
}


def available_engines():
    return [e for e, f in ENGINE_FILES.items() if f.exists()]


# Engines to switch to, in order, when the chosen one can't recognise a language: SenseVoice
# wherever it can (fastest), then Whisper-Small, then Dolphin - except where Dolphin small was
# measured to be as accurate or better, and much faster (see ENGINE_LANGS).
DEFAULT_FALLBACK = ("sensevoice", "whisper", "dolphin")
FALLBACK_ORDER = {lang: ("dolphin", "whisper") for lang in ("id", "vi", "th", "ms", "fil")}


def pick_engine(engine, source_lang):
    """The chosen engine if it can recognise the source language, otherwise the best one that can
    (see FALLBACK_ORDER). With auto-detect every engine is used as chosen."""
    def fits(e):
        langs = ENGINE_LANGS.get(e, set())
        return ENGINE_FILES[e].exists() and (source_lang == "auto" or langs is None or source_lang in langs)
    if engine in ENGINE_FILES and fits(engine):
        return engine
    order = FALLBACK_ORDER.get(source_lang, DEFAULT_FALLBACK)
    return next((e for e in order if fits(e)), "sensevoice")
TAG_RE = re.compile(r"<\|.*?\|>")
# SenseVoice sometimes emits spaces between Japanese/Chinese words ("うち の 中学 は"); remove them.
# Hangul is not included: Korean uses spaces.
_CJK = r"\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef"
CJK_SPACE_RE = re.compile(rf"(?<=[{_CJK}]) +(?=[{_CJK}0-9])|(?<=[{_CJK}0-9]) +(?=[{_CJK}])")

# Dolphin writes Thai with a space between every word (Thai has none) and "ำ" as two characters,
# and sometimes leaves out the space after a comma ("paraan,papagurin").
_THAI = r"\u0e00-\u0e7f"
THAI_SPACE_RE = re.compile(rf"(?<=[{_THAI}]) +(?=[{_THAI}])")
# (Latin script only: Chinese and Japanese punctuation takes no space)
PUNCT_SPACE_RE = re.compile(r"([,.;:!?])(?=[A-Za-zÀ-ɏḀ-ỿ])")


def clean_dolphin(text):
    text = THAI_SPACE_RE.sub("", text.replace("\u0e4d\u0e32", "\u0e33"))
    return PUNCT_SPACE_RE.sub(r"\1 ", text)


log = logging.getLogger("live-translate")
args = None


# ---------------------------------------------------------------------------
# Speech recognition (shared by all connections, runs on one worker thread)
# ---------------------------------------------------------------------------

class Asr:
    def __init__(self, threads):
        self.threads = threads
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr")
        self._recognizers = {}  # (engine, language) -> recognizer; keeps only the latest

    def _load(self, engine, language):
        key = (engine, language)
        if key in self._recognizers:
            return self._recognizers[key]
        t0 = time.perf_counter()
        if engine == "dolphin":
            rec = sherpa_onnx.OfflineRecognizer.from_dolphin_ctc(
                model=str(DOLPHIN_DIR / "model.int8.onnx"), tokens=str(DOLPHIN_DIR / "tokens.txt"),
                num_threads=self.threads, provider="cpu")
        elif engine == "whisper":
            rec = sherpa_onnx.OfflineRecognizer.from_whisper(
                encoder=str(WHISPER_DIR / "small-encoder.int8.onnx"),
                decoder=str(WHISPER_DIR / "small-decoder.int8.onnx"),
                tokens=str(WHISPER_DIR / "small-tokens.txt"),
                language=language, task="transcribe", num_threads=self.threads, provider="cpu")
        else:
            rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(SENSE_VOICE_DIR / "model.int8.onnx"), tokens=str(SENSE_VOICE_DIR / "tokens.txt"),
                language=language, use_itn=True, num_threads=self.threads, provider="cpu")
        self._recognizers = {key: rec}
        log.info("Loaded %s ASR (language=%s) in %.1f s", engine, language or "auto", time.perf_counter() - t0)
        return rec

    @staticmethod
    def engine_language(engine, source_lang):
        if engine == "dolphin":
            return ""  # detects the language itself
        if engine == "whisper":
            return "" if source_lang == "auto" else WHISPER_CODES.get(source_lang, source_lang)
        return SENSE_VOICE_LANGS.get(source_lang, "auto")

    def preload(self, engine, source_lang):
        return asyncio.get_running_loop().run_in_executor(
            self.pool, self._load, engine, self.engine_language(engine, source_lang))

    def _recognize(self, engine, language, samples):
        rec = self._load(engine, language)
        stream = rec.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        rec.decode_stream(stream)
        result = stream.result
        text = CJK_SPACE_RE.sub("", TAG_RE.sub("", result.text)).strip()
        if engine == "dolphin":
            text = clean_dolphin(text)
        lang = (getattr(result, "lang", "") or "").strip("<|> ")  # e.g. "<|ja|>" -> "ja"
        return text, lang

    async def recognize(self, engine, source_lang, samples):
        language = self.engine_language(engine, source_lang)
        return await asyncio.get_running_loop().run_in_executor(
            self.pool, self._recognize, engine, language, samples)


# ---------------------------------------------------------------------------
# Speaker detection (optional). Each line gets a voice embedding, computed on its own thread at the
# same time as speech recognition (~30-60 ms, shorter than recognition, so it adds no delay), and
# is matched against the voices heard so far in this session: Person 1, Person 2, ... Person n.
# ---------------------------------------------------------------------------

class SpeakerEmbedder:
    def __init__(self, threads):
        self.threads = threads
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="speaker")
        self._extractor = None

    @staticmethod
    def available():
        return SPEAKER_MODEL.exists()

    def _load(self):
        if self._extractor is None:
            t0 = time.perf_counter()
            self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(SPEAKER_MODEL), num_threads=self.threads, provider="cpu"))
            log.info("Loaded speaker model in %.1f s", time.perf_counter() - t0)
        return self._extractor

    def _embed(self, samples):
        extractor = self._load()
        t0 = time.perf_counter()
        stream = extractor.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        stream.input_finished()
        embedding = np.array(extractor.compute(stream), dtype=np.float32)
        norm = np.linalg.norm(embedding)
        return (embedding / norm if norm else None), (time.perf_counter() - t0) * 1000

    def preload(self):
        return asyncio.get_running_loop().run_in_executor(self.pool, self._load)

    async def embed(self, samples):
        try:
            return await asyncio.get_running_loop().run_in_executor(self.pool, self._embed, samples)
        except Exception:
            log.exception("Speaker embedding failed")
            return None, None


class SpeakerTracker:
    """Online clustering of the voices in one session.

    A line joins the most similar known voice when the cosine similarity reaches `threshold`
    (same person: ~0.7-0.9, different people: below ~0.35 on test recordings), otherwise it starts
    a new voice. Very short lines give unreliable embeddings, so they never start a new voice and
    don't change the stored ones.
    """
    MIN_NEW_SECONDS = 1.0   # shorter lines can't start a new voice
    MAX_SPEAKERS = 20
    MAX_WEIGHT = 30         # later lines still adjust a voice (e.g. someone who starts shouting)

    def __init__(self, threshold=0.5):
        self.threshold = threshold
        self.centroids = []  # unit vectors
        self.weights = []
        self.last = None

    def assign(self, embedding, duration):
        if embedding is None:
            return self.last
        if not self.centroids:
            return self._new(embedding)
        sims = np.array([float(c @ embedding) for c in self.centroids])
        best = int(sims.argmax())
        short = duration < self.MIN_NEW_SECONDS
        if sims[best] >= self.threshold:
            if not short:
                self._update(best, embedding)
            self.last = best + 1
        elif short:
            # Too short to trust: the nearest voice if it's close, else whoever spoke last.
            self.last = best + 1 if sims[best] >= self.threshold * 0.8 or self.last is None else self.last
        elif len(self.centroids) >= self.MAX_SPEAKERS:
            self.last = best + 1
        else:
            return self._new(embedding)
        return self.last

    def _new(self, embedding):
        self.centroids.append(embedding)
        self.weights.append(1)
        self.last = len(self.centroids)
        return self.last

    def _update(self, i, embedding):
        w = self.weights[i]
        c = self.centroids[i] * w + embedding
        self.centroids[i] = c / np.linalg.norm(c)
        self.weights[i] = min(w + 1, self.MAX_WEIGHT)


# ---------------------------------------------------------------------------
# One connected browser tab
# ---------------------------------------------------------------------------

def make_vad(min_silence, max_speech, threshold):
    # threshold: speech probability needed to count as speech. Lower catches quiet voices; higher
    # ignores music and background noise.
    config = sherpa_onnx.VadModelConfig(
        silero_vad=sherpa_onnx.SileroVadModelConfig(
            model=str(VAD_MODEL), threshold=threshold, min_silence_duration=min_silence,
            min_speech_duration=0.15, max_speech_duration=max_speech, window_size=VAD_WINDOW),
        sample_rate=SAMPLE_RATE)
    return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=30)


class Session:
    def __init__(self, ws, asr, translator, cc, embedder):
        self.ws = ws
        self.asr = asr
        self.embedder = embedder
        self.detect_speakers = False
        self.speakers = SpeakerTracker()
        self.translator = translator
        self.cc = cc
        self.source_lang = "auto"
        self.target_lang = "none"
        self.asr_engine = "sensevoice"   # chosen in the popup
        self.engine = "sensevoice"       # used (see pick_engine)
        self.min_silence = 0.5
        self.max_speech = 6.0
        self.vad_threshold = 0.4
        self.llm = LlmConfig()
        self.vad = make_vad(self.min_silence, self.max_speech, self.vad_threshold)
        self.vad_base = 0          # samples fed to previous VAD instances (so start times keep growing)
        self.fed = 0               # samples fed to the current VAD
        self.pending_audio = np.zeros(0, dtype=np.float32)
        # Recent audio, so each segment can start a little before the VAD triggered: Silero reacts
        # slightly late and would otherwise clip the first syllable (e.g. 开放 -> 待放).
        self.history = np.zeros(0, dtype=np.float32)
        self.history_end = 0       # absolute sample index just after the last sample in history
        # When recent audio arrived: (sample index just after the chunk, wall-clock time). The browser
        # sends each chunk as soon as it's captured, so this dates the end of speech for the latency
        # shown in the popup (speech end -> subtitle on screen).
        self.received = 0
        self.arrivals = collections.deque(maxlen=400)  # ~100 s of 4096-sample chunks
        self.asr_queue = asyncio.Queue()
        self.translate_queue = asyncio.Queue()
        # Transcripts are off unless the extension turns them on; the file is created on the first
        # line written, and reused if saving is switched off and on again during the session.
        self.save_transcript = False
        self.transcript = None
        # Qwen Cloud LiveTranslate connection, while a LiveTranslate model is selected
        self.cloud = None
        self.cloud_key = None
        self.shown_cloud_error = None

    # -- config ------------------------------------------------------------

    def apply_config(self, data):
        self.source_lang = data.get("source_lang", self.source_lang)
        self.target_lang = data.get("target_lang", self.target_lang)
        self.asr_engine = data.get("asr_engine", self.asr_engine)
        # e.g. SenseVoice + Indonesian -> Whisper-Small (SenseVoice doesn't know Indonesian)
        self.engine = pick_engine(self.asr_engine, self.source_lang)
        if self.engine != self.asr_engine:
            log.info("%s can't recognise %s speech: using %s", self.asr_engine, self.source_lang, self.engine)

        provider = data.get("llm_provider")
        self.llm.provider = provider if provider in ("ollama", "qwencloud") else "lmstudio"
        self.llm.url = (data.get("llm_url") or self.llm.url).rstrip("/")
        self.llm.model = data.get("model_name", self.llm.model) or ""
        self.llm.deepseek_key = (data.get("deepseek_key") or "").strip()
        self.llm.api_key = (data.get("qwen_key") or "").strip() if self.llm.provider == "qwencloud" else ""
        self._update_cloud()

        wanted = bool(data.get("detect_speakers", False))
        detect = wanted and self.embedder.available()
        if wanted and not detect:
            log.warning("Speaker detection needs %s", SPEAKER_MODEL)
        if detect and not self.detect_speakers:
            self.speakers = SpeakerTracker(self.speakers.threshold)  # numbering starts again at Person 1
            self.embedder.preload()
        self.detect_speakers = detect
        try:
            threshold = float(data.get("speaker_threshold", self.speakers.threshold))
        except (TypeError, ValueError):
            threshold = self.speakers.threshold
        self.speakers.threshold = min(max(threshold, 0.2), 0.9)

        save = bool(data.get("save_transcript", False))
        if save != self.save_transcript:
            log.info("Transcript saving %s", "on" if save else "off")
        self.save_transcript = save

        min_silence = float(data.get("min_silence", self.min_silence))
        max_speech = float(data.get("max_speech", self.max_speech))
        threshold = min(max(float(data.get("vad_threshold", self.vad_threshold)), 0.05), 0.95)
        vad_settings = (min_silence, max_speech, threshold)
        if vad_settings != (self.min_silence, self.max_speech, self.vad_threshold):
            # Only rebuild the VAD when its settings change, so speech in progress isn't dropped.
            self.min_silence, self.max_speech, self.vad_threshold = vad_settings
            self.vad_base += self.fed
            self.fed = 0
            self.vad = make_vad(*vad_settings)

        if not self.cloud:
            self.asr.preload(self.engine, self.source_lang)
        log.info("Config: ASR=%s source=%s target=%s | LLM=%s %s model=%s | "
                 "VAD silence=%.1fs max=%.1fs threshold=%.2f | speakers=%s",
                 "Qwen Cloud LiveTranslate" if self.cloud else self.engine, self.source_lang, self.target_lang,
                 self.llm.provider, self.llm.url,
                 self.llm.model or "-", self.min_silence, self.max_speech, self.vad_threshold,
                 f"on ({self.speakers.threshold:.2f})" if self.detect_speakers else "off")

    # -- Qwen Cloud LiveTranslate -------------------------------------------

    def _update_cloud(self):
        """Start, restart or stop the LiveTranslate connection to match the config. It needs a
        LiveTranslate model, an API key and a translation language (it always translates)."""
        wanted = (self.llm.provider == "qwencloud" and is_livetranslate(self.llm.model)
                  and self.llm.api_key and self.target_lang != "none")
        key = (self.llm.url, self.llm.api_key, self.llm.model, self.target_lang, self.source_lang) if wanted else None
        if key == self.cloud_key:
            return
        old, self.cloud, self.cloud_key = self.cloud, None, key
        if old:
            asyncio.create_task(old.close())
        # Both modes share one sample count (Session.received): flush audio the VAD hadn't taken yet
        # into the history, and give a new VAD the current position.
        if len(self.pending_audio):
            self.history = np.concatenate([self.history, self.pending_audio])[-HISTORY_SECONDS * SAMPLE_RATE:]
            self.history_end += len(self.pending_audio)
            self.pending_audio = np.zeros(0, dtype=np.float32)
        if wanted:
            self.cloud = QwenLiveTranslate(self, self.llm.url, self.llm.api_key, self.llm.model,
                                           self.target_lang, self.source_lang)
            self.cloud.start()
        else:
            self.vad_base, self.fed = self.history_end, 0
            self.vad = make_vad(self.min_silence, self.max_speech, self.vad_threshold)

    def cloud_speaker(self, begin, end):
        """Speaker label for a line Qwen Cloud detected (samples begin..end), computed locally while
        Qwen translates it. Returns a task giving the person's number, or None."""
        if not self.detect_speakers:
            return None
        samples = self._history_slice(begin, end)
        if len(samples) < SAMPLE_RATE // 4:
            return None

        async def label():
            embedding, _ = await self.embedder.embed(samples)
            return self.speakers.assign(embedding, len(samples) / SAMPLE_RATE)
        return asyncio.create_task(label())

    # -- audio -> VAD ------------------------------------------------------

    def feed_audio(self, pcm_bytes):
        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        self.received += len(audio)
        self.arrivals.append((self.received, time.time()))
        if self.cloud:
            # Qwen Cloud detects and recognises the speech; keep the audio for speaker labels.
            self.history = np.concatenate([self.history, audio])[-HISTORY_SECONDS * SAMPLE_RATE:]
            self.history_end += len(audio)
            self.cloud.send_audio(pcm_bytes)
            return
        audio = np.concatenate([self.pending_audio, audio])
        n = len(audio) // VAD_WINDOW * VAD_WINDOW
        for i in range(0, n, VAD_WINDOW):
            self.vad.accept_waveform(audio[i:i + VAD_WINDOW])
        self.fed += n
        self.pending_audio = audio[n:]
        self.history = np.concatenate([self.history, audio[:n]])[-HISTORY_SECONDS * SAMPLE_RATE:]
        self.history_end += n
        while not self.vad.empty():
            seg = self.vad.front
            samples = np.array(seg.samples, dtype=np.float32)
            abs_start = self.vad_base + seg.start
            self.vad.pop()
            if not len(samples):
                continue
            preroll = self._history_slice(abs_start - int(args.preroll * SAMPLE_RATE), abs_start)
            timing = {"speech_end": self._captured_at(abs_start + len(samples)), "ready": time.time()}
            self.asr_queue.put_nowait((abs_start / SAMPLE_RATE, np.concatenate([preroll, samples]),
                                       time.perf_counter(), timing))

    def _captured_at(self, sample):
        # Wall-clock time at which audio sample number `sample` was captured: its chunk arrived when
        # the chunk's last sample had been captured.
        captured = None
        for end, arrived in reversed(self.arrivals):
            if end < sample:
                break
            captured = arrived - (end - sample) / SAMPLE_RATE
        return captured if captured is not None else time.time()

    def _history_slice(self, begin, end):
        history_start = self.history_end - len(self.history)
        begin, end = max(begin, history_start), min(end, self.history_end)
        if end <= begin:
            return np.zeros(0, dtype=np.float32)
        return self.history[begin - history_start:end - history_start]

    # -- workers -----------------------------------------------------------

    async def send(self, payload):
        try:
            await self.ws.send(json.dumps(payload, ensure_ascii=False))
        except ConnectionClosed:
            pass

    async def asr_worker(self):
        while True:
            start, samples, t_seg, timing = await self.asr_queue.get()
            duration = len(samples) / SAMPLE_RATE
            t0 = time.perf_counter()
            # The voice embedding runs on its own thread while the speech is recognized.
            voice = asyncio.ensure_future(self.embedder.embed(samples)) if self.detect_speakers else None
            try:
                raw, lang = await self.asr.recognize(self.engine, self.source_lang, samples)
            except Exception:
                log.exception("Speech recognition failed")
                raw, lang = "", ""
            asr_ms = (time.perf_counter() - t0) * 1000
            speaker = None
            if voice is not None:
                embedding, timing["speaker"] = await voice
                if raw:  # empty lines are usually noise: don't let them shape the voices
                    speaker = self.speakers.assign(embedding, duration)
            timing["recognized"] = time.time()
            if not raw:
                continue
            target = self.target_lang
            if lang == "yue":
                lang = "zh"
            if not lang and self.source_lang != "auto":
                lang = "zh" if self.source_lang.startswith("zh") else self.source_lang
            base = {"event": "subtitle", "text_raw": raw, "start": round(start, 3), "duration": round(duration, 2)}
            if speaker is not None:
                base["speaker"] = speaker
            who = f"P{speaker} " if speaker is not None else ""

            if target == "none" or target == lang:
                log.info("[ASR %4.0f ms] (%s) %s%s", asr_ms, lang or "?", who, raw)
                await self.send({**base, "text_zh": raw, "timing": self.timing_summary(timing)})
                self.write_transcript(start, raw, None, speaker)
            elif lang == "zh" and target in ("zh-TW", "zh-CN"):
                converted = self.cc[target].convert(raw)
                log.info("[ASR %4.0f ms] (zh -> %s, OpenCC) %s%s", asr_ms, target, who, converted)
                await self.send({**base, "text_raw": converted, "text_zh": converted,
                                 "timing": self.timing_summary(timing)})
                self.write_transcript(start, converted, None, speaker)
            else:
                log.info("[ASR %4.0f ms] (%s) %s%s", asr_ms, lang or "?", who, raw)
                # Show the original right away; the translation replaces it (same `start`).
                await self.send({**base, "text_zh": "", "pending": True})
                self.translate_queue.put_nowait((base, raw, target, t_seg, timing))

    async def translate_worker(self):
        # One line at a time, in order, so each translation can use the previous lines as context.
        while True:
            base, raw, target, t_seg, timing = await self.translate_queue.get()
            timing["llm_start"] = time.time()
            t0 = time.perf_counter()
            try:
                out, engine, stats = await self.translator.translate(raw, target, self.llm)
            except Exception:
                log.exception("Translation failed")
                out, engine, stats = raw, "untranslated", None
            now = time.perf_counter()
            timing["translated"] = time.time()
            timing["engine"] = engine
            if stats:
                timing.update(stats)
            log.info("  -> [%s %4.0f ms%s | %4.0f ms after speech end] %s", engine, (now - t0) * 1000,
                     f", {stats['tps']:.0f} t/s" if stats else "", (now - t_seg) * 1000, out)
            await self.send({**base, "text_zh": out, "engine": engine, "timing": self.timing_summary(timing)})
            error = self.translator.cloud_error if self.llm.provider == "qwencloud" else None
            if error and error != self.shown_cloud_error:  # once per problem, not on every line
                await self.send({"event": "subtitle", "text_raw": "", "text_zh": f"⚠ Qwen Cloud: {error}",
                                 "start": -1, "duration": 3})
            self.shown_cloud_error = error
            self.write_transcript(base["start"], raw, out, base.get("speaker"))

    @staticmethod
    def timing_summary(t):
        """Where the time went for one line, in ms, for the popup's latency readout.

        speech_end: when the speech was captured (epoch ms; the browser adds the delivery time),
        vad: waiting for the pause that ends the line, asr: speech recognition (including waiting
        for the line before), speaker: voice embedding (runs at the same time as asr), wait: queued
        behind the previous line's translation, llm: translation, server: speech end -> sent.
        Only clock readings: nothing here slows a line down.
        """
        ms = lambda a, b: round(max(b - a, 0) * 1000)
        sent = time.time()
        out = {"speech_end": round(t["speech_end"] * 1000), "vad": ms(t["speech_end"], t["ready"]),
               "asr": ms(t["ready"], t["recognized"]), "server": ms(t["speech_end"], sent)}
        if t.get("speaker") is not None:
            out["speaker"] = round(t["speaker"])
        if "llm_start" in t:
            out["wait"] = ms(t["recognized"], t["llm_start"])
            out["llm"] = ms(t["llm_start"], t["translated"])
            out["engine"] = t["engine"]
            for k in ("tokens", "tps", "prompt"):
                if t.get(k) is not None:
                    out[k] = t[k]
        return out

    # -- transcript --------------------------------------------------------

    def _open_transcript(self):
        try:
            TRANSCRIPT_DIR.mkdir(exist_ok=True)
            now = datetime.datetime.now()
            path = TRANSCRIPT_DIR / f"transcript_{now:%Y%m%d_%H%M%S}.md"
            path.write_text(f"# {APP_NAME} Transcript\n\n*   **Started**: {now:%Y-%m-%d %H:%M:%S}\n---\n\n",
                            encoding="utf-8")
            log.info("Transcript: %s", path)
            return path
        except OSError as e:
            log.warning("Could not create transcript: %s", e)
            return None

    def write_transcript(self, start, original, translation, speaker=None):
        if not self.save_transcript:
            return
        if self.transcript is None:
            self.transcript = self._open_transcript()
            if self.transcript is None:
                self.save_transcript = False  # don't retry (and warn) on every line
                return
        h, rem = divmod(int(start), 3600)
        m, s = divmod(rem, 60)
        who = f" | Person {speaker}" if speaker is not None else ""
        lines = [f"### [{datetime.datetime.now():%H:%M:%S} | stream {h:02d}:{m:02d}:{s:02d}{who}]",
                 f"*   **Original**: {original}"]
        if translation is not None:
            lines.append(f"*   **Translation**: {translation}")
        try:
            with self.transcript.open("a", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n\n")
        except OSError as e:
            log.warning("Could not write transcript: %s", e)

    # -- main loop ---------------------------------------------------------

    async def run(self):
        await self.send({"event": "server_info", "server": SERVER_ID, "version": VERSION,
                         "features": ["direct_llm", "pending_subtitles", "qwen_cloud"]
                                     + (["speakers"] if self.embedder.available() else [])})
        workers = [asyncio.create_task(self.asr_worker()), asyncio.create_task(self.translate_worker())]
        try:
            async for message in self.ws:
                if isinstance(message, bytes):
                    if message:
                        self.feed_audio(message)
                    continue
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if data.get("event") == "config":
                    self.apply_config(data)
        except ConnectionClosed:
            pass
        finally:
            for w in workers:
                w.cancel()
            if self.cloud:
                await self.cloud.close()


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

def lmstudio_model_sources():
    """Hugging Face repos of the models in LM Studio's models folder, e.g.
    [{"repo": "tencent/Hy-MT2-7B-GGUF", "files": ["HY-MT2-7B-Q8_0.gguf"]}].

    LM Studio's API only reports a short name for models downloaded from Hugging Face; the folder
    layout (<models>/<publisher>/<repo>/<file>.gguf) tells where they came from, so exported
    profiles can include a download link for their model.
    """
    home = Path.home() / ".lmstudio"
    models = home / "models"
    try:
        settings = json.loads((home / "settings.json").read_text(encoding="utf-8"))
        models = Path(settings.get("downloadsFolder") or models)
    except (OSError, ValueError):
        pass
    sources = []
    try:
        for repo in sorted(p for p in models.glob("*/*") if p.is_dir()):
            files = sorted(f.name for f in repo.glob("*.gguf") if not f.name.lower().startswith("mmproj"))
            if files:
                sources.append({"repo": f"{repo.parent.name}/{repo.name}", "files": files})
    except OSError as e:
        log.warning("Could not read LM Studio models folder %s: %s", models, e)
    return sources


class App:
    def __init__(self):
        self.asr = Asr(args.threads)
        self.embedder = SpeakerEmbedder(args.speaker_threads)
        self.translator = Translator()
        self.cc = {"zh-TW": opencc.OpenCC("s2twp"), "zh-CN": opencc.OpenCC("t2s")}
        self.connections = 0

    @staticmethod
    def json_response(connection, payload):
        response = connection.respond(HTTPStatus.OK, json.dumps(payload))
        response.headers["Content-Type"] = "application/json"
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    def process_request(self, connection, request):
        # Plain HTTP health check, used by the extension popup to detect this server.
        if request.path == "/health":
            return self.json_response(connection, {"status": "ok", "server": SERVER_ID, "version": VERSION,
                                                   "connections": self.connections,
                                                   "speakers": self.embedder.available(),
                                                   "engines": available_engines()})
        if request.path == "/model-sources":
            return self.json_response(connection, {"sources": lmstudio_model_sources()})
        if request.path != "/stream":
            return connection.respond(HTTPStatus.NOT_FOUND, "not found\n")
        return None

    async def handler(self, ws):
        self.connections += 1
        log.info("Client connected (%d active)", self.connections)
        try:
            await Session(ws, self.asr, self.translator, self.cc, self.embedder).run()
        finally:
            self.connections -= 1
            log.info("Client disconnected (%d active)", self.connections)

    async def main(self):
        await self.asr.preload("sensevoice", "auto")
        async with serve(self.handler, args.host, args.port, process_request=self.process_request,
                         max_size=2 ** 22, compression=None):
            log.info("%s server %s listening on ws://%s:%d/stream", APP_NAME, VERSION, args.host, args.port)
            try:
                await asyncio.Future()
            finally:
                await self.translator.close()


def main():
    global args
    p = argparse.ArgumentParser(description=f"{APP_NAME} server")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--threads", type=int, default=max(2, min(8, (os.cpu_count() or 4) // 2)),
                   help="CPU threads for speech recognition")
    p.add_argument("--speaker-threads", type=int, default=2,
                   help="CPU threads for speaker detection (runs alongside speech recognition)")
    p.add_argument("--preroll", type=float, default=0.2,
                   help="seconds of audio added before each detected speech start")
    args = p.parse_args()

    # Subtitles contain CJK text; never let a non-UTF-8 console or log file break logging.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore", "websockets"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    for path in (VAD_MODEL, SENSE_VOICE_DIR / "model.int8.onnx"):
        if not path.exists():
            raise SystemExit(f"Model file not found: {path}")
    try:
        asyncio.run(App().main())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
