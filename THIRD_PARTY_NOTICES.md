# Third-party notices

Local AI Live Translate (author: xinjalin) includes or downloads the following third-party
components. Each remains under its own license; the full license texts ship alongside them
(model folders, and the `*.dist-info` folders in `runtime/Lib/site-packages`).

## Models (`models/`)

| Component | Source | License |
|---|---|---|
| Silero VAD (`silero_vad.onnx`) | <https://github.com/snakers4/silero-vad> | MIT |
| SenseVoice Small, int8 ONNX export (`sherpa-onnx-sense-voice-…`) | <https://github.com/FunAudioLLM/SenseVoice>, export by <https://github.com/k2-fsa/sherpa-onnx> | FunASR model license — see the `LICENSE` file in that folder |
| Whisper Small, int8 ONNX export (`sherpa-onnx-whisper-small`) | <https://github.com/openai/whisper>, export by <https://github.com/k2-fsa/sherpa-onnx> | MIT |
| Dolphin small CTC, int8 ONNX export (`sherpa-onnx-dolphin-small-ctc-multi-lang-int8-2025-04-02`) | <https://github.com/DataoceanAI/Dolphin>, export by <https://github.com/k2-fsa/sherpa-onnx> | Apache-2.0 |
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
