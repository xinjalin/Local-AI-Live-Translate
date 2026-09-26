# Local AI Live Translate

[![Latest release](https://img.shields.io/github/v/release/xinjalin/Local-AI-Live-Translate)](https://github.com/xinjalin/Local-AI-Live-Translate/releases/latest)
[![Checks](https://github.com/xinjalin/Local-AI-Live-Translate/actions/workflows/checks.yml/badge.svg)](https://github.com/xinjalin/Local-AI-Live-Translate/actions/workflows/checks.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Real-time translated subtitles for any video or stream playing in Chrome: speech recognition and
translation both run on your own PC, using a local LLM served by LM Studio (or Ollama, or optionally
Qwen Cloud).

**Author:** xinjalin · **License:** MIT (open source) · Windows 10/11 (x64)

```
Chrome extension ──audio──> Local AI Live Translate server ──> LM Studio (local LLM)
                  <─subtitles─     (speech recognition)            (translation)
```

## What you need

- **Windows 10 or 11, 64-bit**, and **Google Chrome** (or another Chromium browser).
- **LM Studio** 0.4 or newer — <https://lmstudio.ai> — with a translation model downloaded
  (see *Choosing a model*). Ollama works too.
- About **1 GB** of disk space. Python is **not** needed: the app uses its own private copy in
  `runtime/`, which doesn't touch anything else on the PC.

## Install

**Option A — download a release (easiest):** get `Local-AI-Live-Translate-<version>-windows-x64.zip`
from the [Releases page](https://github.com/xinjalin/Local-AI-Live-Translate/releases/latest) and
unzip it to a folder with a short path, such as `C:\LocalAI\` (Windows limits file paths to 260
characters, and a very deep folder can stop Python from loading). It contains everything, ready to
run offline.

**Option B — from the source code:**

```bash
git clone https://github.com/xinjalin/Local-AI-Live-Translate.git
```

The first run of `START_Local_AI_Live_Translate.bat` downloads what the app needs (~1.1 GB, one time):
a portable Python 3.14 (python.org's NuGet package — no installer, no admin rights), its packages from
PyPI, and the speech models. Every file is checked against a checksum pinned in
[`tools/dependencies.json`](tools/dependencies.json) before it is used. After a `git pull`, anything
new is downloaded the same way on the next start.

## Quick start

1. **Start the server:** double-click `START_Local_AI_Live_Translate.bat`. Leave the window open;
   it shows each recognised and translated line.
2. **Start LM Studio's server:** open LM Studio → **Developer** tab → start the server
   (default `http://127.0.0.1:1234`).
3. **Install the extension (first time only):** open `chrome://extensions`, turn on
   **Developer mode**, click **Load unpacked** and select the `extension` folder.
4. Open a video, click the extension icon, pick your languages and a model on the **Model** tab,
   then press **Start Live Translate**.

Picking a model in the list loads it into LM Studio (and ejects any other loaded model); the ▶ / ⏏
button loads or ejects it manually. **Context Size** (4K / 8K / 16K) is applied when a model loads;
4K is plenty for subtitles.

## Folder layout

| Folder / file | Contents |
|---|---|
| `START_Local_AI_Live_Translate.bat` | Starts the server |
| `extension/` | The Chrome extension (load it unpacked) |
| `server/` | Server source: `live_translate_server.py`, `translator.py`, `qwen_live.py`, `requirements.txt` |
| `tools/` | `setup.ps1` (first-run downloads, pinned in `dependencies.json`), `build_package.py` (release bundle), `check_i18n.js` |
| `models/` | Speech models: Silero VAD, SenseVoice (zh/en/ja/ko/yue), Whisper-Small, Dolphin small (Asian languages), Omnilingual 300M (Hindi, Arabic, …), and the CAM++ speaker model in `models/speaker/` |
| `runtime/` | Private Python 3.14 with all packages installed (in releases; downloaded on first run from source) |
| `transcripts/` | Markdown transcripts, when **Save transcripts** is switched on |

## How it works

- Tab audio is streamed to the server at `ws://127.0.0.1:8000/stream`.
- Silero VAD cuts the audio into sentences (with 0.2 s of pre-roll so the first syllable isn't
  clipped) and SenseVoice, Whisper-Small or Dolphin transcribes them on the CPU.
- Lines already in the target language skip the LLM; Chinese ⇄ Chinese is converted instantly with
  OpenCC (Taiwan phrasing for Traditional Chinese). Everything else is translated by the local LLM,
  with the previous 4 lines as context so names, pronouns and misheard words come out right.
- Recognition and translation run in parallel, and the LLM is called over one kept-alive
  connection, so a finished subtitle typically appears 0.7–1.0 s after the speaker stops.
- With **Label speakers** on, each line also gets a voice fingerprint (3D-Speaker CAM++), computed
  on its own thread at the same time as the speech recognition, so lines don't arrive any later
  (measured: same median latency with it on or off). The fingerprint is compared with the voices
  heard so far in the session: a close match gets that person's number, a new voice becomes the next
  Person n.

## Choosing a model (measured on an RX 9070 XT, 16 GB)

| Model | VRAM | Speed | Per line | Notes |
|---|---|---|---|---|
| **Hy-MT2-7B Q8_0** | 8.0 GB | 63 tok/s | 0.33 s | **recommended**: translation-specialised, fastest and most accurate |
| Qwen2.5-7B-Instruct Q8_0 | 8.0 GB | 43 tok/s | 0.40 s | more literal mistakes |
| Qwen3.5-9B Q8_0 | 11.1 GB | 33 tok/s | 0.57 s | thinking is switched off automatically |
| Qwen3.8-27B UD-Q3_K_XL | 14.9 GB | 18–25 tok/s | 1.0–1.3 s | good wording, very little VRAM left |

- Hy-MT2 (`tencent/Hy-MT2-7B-GGUF` in LM Studio's Discover tab) gets its official prompt template
  and sampling settings automatically.
- Hybrid "thinking" models are asked not to reason (`reasoning_effort: none`), so they answer
  immediately.
- On AMD GPUs keep LM Studio's **Vulkan** runtime; set GPU offload to max and flash attention on.

## Tips

- **Speed and latency** (status card, while captions run): next to the model, the local model's
  generation speed on the last translated line (e.g. *64 t/s*, as LM Studio / Ollama measure it).
  Next to the server, the round trip of the last line — from the moment the speaker stopped to the
  subtitle reaching the page — in green (under 1.5 s), amber (under 3 s) or red. Hover over it for
  the breakdown: pause detection (mostly the Silence Threshold), speech recognition, speaker labels
  (they run at the same time as recognition), waiting behind the previous line, LLM translation
  (tokens, speed and prompt processing) and delivery, plus the average of the last 10 lines. The
  numbers are clock readings taken along the way and sent with each subtitle, so measuring them
  doesn't slow anything down (tested: same latency as before, within a few ms).
- **Qwen Cloud (online, needs an API key from [home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys)):**
  pick *Qwen Cloud* as the LLM Server on the Model tab, paste your key, and choose a model — the list
  shows the models on your account, and you can type any model name.
  - *LiveTranslate models* (`qwen3.8-livetranslate-flash-realtime`, `qwen3.5-…`): the tab's audio is
    streamed to Qwen Cloud, which detects, recognises and translates the speech itself (simultaneous
    interpretation, 60 input languages; Qwen quotes ~2.3 s average lag). The subtitle grows as the
    translation streams in. Local speech recognition and LM Studio aren't used; speaker labels still
    work (computed on this PC). Needs a subtitle translation language. Billed per second of audio
    (see Qwen's pricing), for as long as captions run.
  - *Any other model* (e.g. `qwen-mt-flash`, `qwen-plus`): speech is recognised on this PC as usual and
    Qwen Cloud translates the text through its OpenAI-compatible API (Qwen-MT models get their
    translation options automatically).
  - A wrong key or other Qwen error shows as a ⚠ line in the subtitles. The *API URL* defaults to
    `https://maas.qwencloudapi.com`; other Qwen / DashScope endpoints work too.
- **Search settings:** type in the search box under the start button (or press `/`) to find any
  setting. It's forgiving about typos and abbreviations ("opacty", "fnt sz", "ctx") and knows a few
  synonyms ("transparency", "hotkey", "noise"). Pick a suggestion with the mouse or arrow keys + Enter
  to jump straight to that setting.
- **Keyboard shortcut:** `Alt+Shift+L` starts or stops live translation on the current tab without
  opening the popup (an **ON** badge shows on the icon while it runs). Change it on the Live tab or at
  `chrome://extensions/shortcuts`.
- **Label speakers** (Live tab) puts *Person 1:*, *Person 2:* … in front of each line, in a
  different colour per person, for conversations and group videos. Numbering starts again each time
  you start captions. *Speaker Separation* (Tuning tab, shown while it's on) sets how different two
  voices must be to count as two people: raise it if two people get the same number, lower it if one
  person gets split into two. Works best on clear speech; music, laughter or two people talking at
  once can confuse it, and a very short line (under 1 s) keeps the previous speaker's number.
- **Profiles** (top of the Live tab): save the translation setup — LLM server and address, model,
  context size, video and translation languages, speech engine, bilingual mode, speaker labels and
  the speech detection tuning (Tuning tab: detection threshold, silence threshold, max speech
  duration, speaker separation) — under a name
  (e.g. "Anime JP → EN"), and switch between them from the dropdown. Choosing a profile applies it at
  once and loads its model into LM Studio. The DeepSeek key is never stored in profiles.
- **Display configs** (Display tab): save the subtitle look, layout and timing (the *Subtitle
  Timing* settings on the Tuning tab) separately from profiles, so any profile can be combined with
  any display style.
- Both have the same controls: **+** saves the current settings as a new config, **✓** updates the
  selected config after you've changed something (the panel says when it differs), and the bin deletes
  it (click twice).
- **Export / Import** (under each config panel): *Export* saves all your profiles (or display configs)
  to a `.json` file to back up or share. *Import* opens a page in a new tab — a file picker would close
  the popup — where you choose the file, see what's in it and tick what to add. Imported configs are
  added next to yours (a name that's taken gets " (2)"), and nothing you have is changed. Every value is
  checked before it's saved, and the page warns if a profile points to an LLM server on another computer.
- **Profiles whose model you don't have:** the import page shows each profile's model as installed or
  missing, and offers to download missing ones through LM Studio (with the size). You can click
  *Later* — the profile is imported anyway. When you choose such a profile, the model you were using
  keeps translating, the panel says the model isn't installed, and the Model tab offers the download
  with a progress bar. Downloads keep running in LM Studio when the popup closes; once finished, the
  profile's model is selected and loaded automatically. Exported profiles record where their model
  comes from (LM Studio catalog or Hugging Face repo) — keep the app server running while exporting so
  it can look this up for models added from Hugging Face.
- **Languages:** the video and subtitle languages can each be Traditional or Simplified Chinese,
  English, Japanese, Korean, Spanish, French, German, Russian, Indonesian, Vietnamese, Thai, Malay,
  Filipino, Hindi or Arabic. The popup itself is available in the first ten. Arabic subtitles are
  laid out right to left.
- **Speech engine** (Live tab):

  | Engine | Recognises | Speed (per line) | Notes |
  |---|---|---|---|
  | SenseVoice | Chinese, Cantonese, English, Japanese, Korean | ~0.1 s | The default; best for these |
  | Dolphin (small) | 40 Asian languages (Indonesian, Vietnamese, Thai, Malay, Filipino, Hindi, …) | ~0.2–0.7 s | Used automatically for Indonesian, Vietnamese, Thai, Malay and Filipino |
  | Omnilingual (Meta, 300M) | 1,600+ languages | ~0.3–0.8 s | Used automatically for Hindi and Arabic |
  | Whisper-Small | 99 languages | ~1.5–4 s | Covers everything else (Spanish, French, German, Russian, …) |

  If the chosen engine can't recognise the video language, the server switches to the best one that
  can, and the popup says so: SenseVoice where possible, Dolphin for the five South-East Asian
  languages, Omnilingual for Hindi and Arabic (Dolphin as their fallback), otherwise Whisper-Small.
  Measured on Google FLEURS recordings (errors, Dolphin small vs Whisper-Small):

  | Language | Dolphin small | Whisper-Small |
  |---|---|---|
  | Indonesian | 18.4 % WER | 18.0 % WER |
  | Vietnamese | 10.3 % WER | 10.8 % WER |
  | Malay | 9.9 % WER | 12.6 % WER |
  | Filipino | 28.8 % WER | 35.3 % WER |
  | Thai (per character) | 9.9 % CER | 49.3 % CER |

  Hindi and Arabic (word errors): Omnilingual 6.1 % / 15.8 %, Dolphin small 14.3 % / 19.4 %,
  Whisper-Small 79 % (unusable for Hindi) / 25.5 %. Hy-MT2-7B translates both well (chrF into
  English 65 / 66, ahead of Gemma-4-12B and Qwen3.5-9B). The Arabic test is Modern Standard Arabic;
  dialects (Egyptian, Gulf, …) are untested.

  Dolphin is also ~9× faster: a full subtitle into English took 1.1–1.8 s, against 2.8–5.3 s with
  Whisper-Small. Set the video language rather than *Auto Detect* for languages SenseVoice doesn't
  know; its auto-detect only knows its five.
- **Tuning tab:**
  - *Speech Detection Threshold* — lower picks up quiet voices; raise it (0.5–0.7) for videos with
    music or background noise under the voice.
  - *Silence Threshold* — how long the server waits after speech stops before sending a line;
    0.3–0.4 s feels snappier than 0.5 s. *Max Speech Duration* force-splits long monologues.
  - *Extra Time On Screen* / *Minimum Display Time* — how long each line stays up.
- **Display tab:** colours, background opacity (0 % = no box at all), 7 font sizes, 8 system fonts,
  text weight and shadow/outline, with a live preview. *Subtitle Layout* sets the position (bottom,
  top, or wherever you last dragged the subtitles — double-click them to reset), whether the original
  text goes above or below the translation and how big it is, history lines, and *Keep subtitle box
  on screen*.
- **Save transcripts** (Live tab) is off by default. When on, each session is saved as a Markdown
  file in `transcripts/`, with the original and translated text of every line.
- **Themes** (Display tab): Dark, Light, Hybrid (dark shell with light panels), System, and the OLED
  family with a blue accent — **OLED Light** (white), **OLED Dim** (dark navy) and **OLED Black**
  (true black `#000`, no background glow: on OLED / AMOLED screens black pixels are switched off).
  Themes only change colours; the layout is the same in all of them.

## Server options

```
runtime\python.exe server\live_translate_server.py --threads 8 --preroll 0.2
```

`--threads` sets the CPU threads for speech recognition (default: half your cores, at most 8),
`--speaker-threads` those for speaker labels (default 2; they run alongside recognition), and
`--preroll` the audio kept before each detected speech start.

## Privacy note

Speech recognition and translation run locally. If the local LLM can't be reached, a line falls back
to DeepSeek (only if you entered a key) and then to Google Translate, which are online services.
Choosing **Qwen Cloud** as the LLM server is opt-in and online: the recognised text — or, with a
LiveTranslate model, the tab's audio — is sent to Qwen Cloud. The API key stays in the browser's
extension storage and is never put in exported profiles.

## Releases and development

Pushing a version tag (`vX.Y.Z`, matching `VERSION` in `server/live_translate_server.py` and the
extension's `manifest.json`) makes GitHub Actions build the Windows bundle on a clean machine — with
the same `tools/setup.ps1` a first run uses — and publish it with SHA-256 checksums on the
[Releases page](https://github.com/xinjalin/Local-AI-Live-Translate/releases). Every push also runs
syntax, translation and secret-scan checks. See [DEVELOPMENT.md](DEVELOPMENT.md).

## License and credits

Local AI Live Translate is by **xinjalin** and open source under the [MIT License](LICENSE). It builds
on open-source components: the speech models, Python and the Python packages it downloads keep their
own licenses — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
