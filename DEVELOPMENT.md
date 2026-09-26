# Development notes

- **Running from source:** `START_Local_AI_Live_Translate.bat` first runs `tools/setup.ps1`, which
  downloads anything missing — a portable Python into `runtime/` (python.org's NuGet package), the
  packages in `server/requirements.txt`, and the speech models into `models/` — checking each file
  against the hash pinned in `tools/dependencies.json`. When nothing is missing it returns in well
  under a second. If `server/.venv` exists (a developer environment) it is used instead of `runtime/`.
- **Changing a dependency:** update `server/requirements.txt` (packages are reinstalled when it
  changes) or `tools/dependencies.json` (new URL + SHA-256; the release build's model cache is keyed
  on this file).
- **Release bundle:** `runtime\python.exe tools\build_package.py` (or with `server\.venv\Scripts\python`)
  builds `dist/Local-AI-Live-Translate/`, `dist/Local-AI-Live-Translate-<version>-windows-x64.zip` and
  `dist/Local-AI-Live-Translate-extension-<version>.zip`. Add `--no-whisper` for a smaller build.
- **Publishing a release:** bump `VERSION` in `server/live_translate_server.py` and `version` in
  `extension/manifest.json`, commit, then `git tag vX.Y.Z` and `git push origin vX.Y.Z`. The
  *Release* workflow builds the bundle on a clean Windows runner and publishes it on the Releases page.
- **Checks** (`.github/workflows/checks.yml`, on every push): JavaScript and Python syntax,
  `node tools/check_i18n.js` (all popup languages complete, placeholders intact), JSON validity,
  matching versions, and a gitleaks secret scan.
- `extension/logo.svg` is the source for the icons; the popup header embeds a themed copy of it.
- Transcripts are off by default: the extension sends `save_transcript` in its config message and the
  server only creates a file once a line is written with it switched on. `transcripts/` is git-ignored.
- **Never commit secrets:** API keys (DeepSeek, Qwen Cloud) are entered in the extension and stay in
  the browser's extension storage; they are not part of the code, exported profiles or the repository.
