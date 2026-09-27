# Third-party notices

Local AI Live Translate (author: xinjalin) grew out of an earlier open-source project, and includes
or downloads the following third-party components. Each remains under its own license; the full
license texts ship alongside them (model folders, and the `*.dist-info` folders in
`runtime/Lib/site-packages`).

## Origin: LiveCaption by Studio0808

This project started from **LiveCaption** by begin0808 (Studio0808 Maker Lab / Studio0808 智造實驗室),
<https://github.com/begin0808/LiveCaption>, a real-time bilingual subtitle system for browser tab audio
built on Silero VAD, SenseVoice-Small (via sherpa-onnx), Ollama and DeepSeek. Its design shaped this
one: a Chrome extension that captures the tab's audio in an offscreen document, streams it to a local
server over a WebSocket, splits speech into sentences with a VAD, recognises them with a local speech
model, translates them with an LLM and shows the result as subtitles on the page.

The server here is a rewrite, but parts of the extension still come from LiveCaption: the tab-capture
and WebSocket code in `extension/offscreen.js`, the message handling in `extension/background.js`,
the basis of the subtitle overlay in `extension/content.js`, and some element and setting names in
`extension/popup.js`.

LiveCaption's README states that it is licensed under the MIT License (the repository has no separate
license file, and its README footer reads "Copyright © 2026 Studio0808 Maker Lab. All rights
reserved."). The MIT License it names:

> Copyright (c) 2026 Studio0808 Maker Lab
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
> OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Thank you to begin0808 for the original project and the idea.

## Models (`models/`)

| Component | Source | License |
|---|---|---|
| Silero VAD (`silero_vad.onnx`) | <https://github.com/snakers4/silero-vad> | MIT |
| SenseVoice Small, int8 ONNX export (`sherpa-onnx-sense-voice-…`) | <https://github.com/FunAudioLLM/SenseVoice>, export by <https://github.com/k2-fsa/sherpa-onnx> | FunASR model license — see the `LICENSE` file in that folder |
| Whisper Small, int8 ONNX export (`sherpa-onnx-whisper-small`) | <https://github.com/openai/whisper>, export by <https://github.com/k2-fsa/sherpa-onnx> | MIT |
| Dolphin small CTC, int8 ONNX export (`sherpa-onnx-dolphin-small-ctc-multi-lang-int8-2025-04-02`) | <https://github.com/DataoceanAI/Dolphin>, export by <https://github.com/k2-fsa/sherpa-onnx> | Apache-2.0 |
| Omnilingual ASR 300M CTC v2, int8 ONNX export (`sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05`) | <https://github.com/facebookresearch/omnilingual-asr> (Meta), export by <https://github.com/k2-fsa/sherpa-onnx> | Apache-2.0 |
| 3D-Speaker CAM++ zh/en speaker embedding, ONNX export (`speaker/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`) | <https://github.com/modelscope/3D-Speaker>, export by <https://github.com/k2-fsa/sherpa-onnx> | Apache-2.0 |

## Python runtime and packages (`runtime/`)

| Component | License |
|---|---|
| CPython 3.14 | Python Software Foundation License (`runtime/LICENSE.txt`) |
| sherpa-onnx / sherpa-onnx-core (includes ONNX Runtime) | Apache-2.0 (ONNX Runtime: MIT) |
| NumPy | BSD-3-Clause |
| websockets | BSD-3-Clause |
| httpx, httpcore | BSD-3-Clause |
| anyio, h11 | MIT |
| typing_extensions | Python Software Foundation License |
| idna | BSD-3-Clause |
| certifi | MPL-2.0 |
| OpenCC (Python binding and dictionaries) | Apache-2.0 |

## Fonts

The extension popup loads **Plus Jakarta Sans** from Google Fonts (SIL Open Font License 1.1).
