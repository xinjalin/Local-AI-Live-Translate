## Download

| File | What it is |
|---|---|
| `Local-AI-Live-Translate-<version>-windows-x64.zip` | **Everything, ready to run** (Windows 10/11, 64-bit): server, speech models, a private Python and the Chrome extension. No installation and no internet needed to start it. |
| `Local-AI-Live-Translate-extension-<version>.zip` | The Chrome extension on its own (it is also inside the full zip). |
| `SHA256SUMS.txt` | Checksums to verify the downloads. |

## Get started

1. Unzip `Local-AI-Live-Translate-<version>-windows-x64.zip` anywhere and run `START_Local_AI_Live_Translate.bat`.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `extension` folder.
3. Start [LM Studio](https://lmstudio.ai/)'s local server with a translation model (Tencent Hy-MT2-7B recommended), or use Ollama or Qwen Cloud.
4. Open a video, click the extension icon, pick your languages and press **Start Live Translate**.

Running from a `git clone` instead? `START_Local_AI_Live_Translate.bat` downloads Python, its packages and the speech models on the first run (~850 MB, each file checked against a pinned checksum).

See the [README](https://github.com/xinjalin/Local-AI-Live-Translate#readme) for all the features and settings.
