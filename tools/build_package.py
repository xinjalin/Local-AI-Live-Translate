"""
Build a self-contained, shareable copy of Local AI Live Translate.  Author: xinjalin.  License: MIT.

Creates dist/Local-AI-Live-Translate/ (and a .zip of it) containing the extension, the server, the
speech models and a private Python runtime with every package installed, so the receiving PC needs
neither Python nor an internet connection to run it. Also writes the extension on its own as a zip.

The Python runtime is taken from runtime/ (created by tools/setup.ps1, as in the GitHub release
build), or else copied from the server's venv Python:

    powershell -File tools/setup.ps1  then  runtime/python tools/build_package.py   (like the GitHub build)
    server/.venv/Scripts/python tools/build_package.py                              (from a dev venv)
    --no-zip      folder only
    --no-whisper  leave out Whisper (-375 MB; downloaded on first run if needed)
"""

import argparse
import hashlib
import re
import shutil
import subprocess
import sys
import sysconfig
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
NAME = "Local-AI-Live-Translate"
MODEL_SRC = ROOT / "models"

SENSE_VOICE = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
WHISPER = "sherpa-onnx-whisper-small"
DOLPHIN = "sherpa-onnx-dolphin-small-ctc-multi-lang-int8-2025-04-02"
OMNI = "sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05"

# Parts of the Python install the server never uses.
RUNTIME_LIB_SKIP = {"test", "idlelib", "tkinter", "turtledemo", "ensurepip", "site-packages", "__pycache__"}
RUNTIME_DLL_SKIP = re.compile(r"^(_test.*|_tkinter\.pyd|_ctypes_test\.pyd|tcl.*|tk.*|.*\.ico)$", re.IGNORECASE)
SITE_SKIP = re.compile(r"^(pip|pip-.*\.dist-info|_distutils_hack|distutils-precedence\.pth|__pycache__)$")


def log(msg):
    print(msg, flush=True)


def size_of(path):
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def copytree(src, dst, ignore=None):
    shutil.copytree(src, dst, ignore=ignore, dirs_exist_ok=True)


def version():
    text = (ROOT / "server" / "live_translate_server.py").read_text(encoding="utf-8")
    return re.search(r'^VERSION = "([^"]+)"', text, re.M).group(1)


def copy_setup_runtime(out):
    """runtime/ from tools/setup.ps1: python.org's portable Python with the packages installed."""
    src = ROOT / "runtime"
    skip = RUNTIME_LIB_SKIP - {"site-packages"}
    copytree(src, out / "runtime", ignore=lambda d, names: [
        n for n in names
        if n in skip or (Path(d).name == "DLLs" and RUNTIME_DLL_SKIP.match(n))
        or (Path(d).name == "site-packages" and SITE_SKIP.match(n))])
    log(f"  runtime: {src} ({size_of(out / 'runtime') / 1e6:.0f} MB)")


def build_runtime(out):
    if (ROOT / "runtime" / "python.exe").exists():
        copy_setup_runtime(out)
    else:
        copy_venv_runtime(out)
    # Tells tools/setup.ps1 the packages are already installed (it reinstalls when this differs).
    digest = hashlib.sha256((ROOT / "server" / "requirements.txt").read_bytes()).hexdigest().upper()
    (out / "runtime" / ".requirements-sha256").write_text(digest + "\n", encoding="ascii")


def copy_venv_runtime(out):
    base = Path(sys.base_prefix)
    site = Path(sysconfig.get_paths()["purelib"])
    if base == Path(sys.prefix):
        raise SystemExit("No runtime/ folder: run tools\\setup.ps1 first, or run this script with the "
                         "server's venv Python (server\\.venv\\Scripts\\python)")
    runtime = out / "runtime"
    runtime.mkdir()

    for f in base.iterdir():
        if f.is_file() and (f.suffix.lower() in (".exe", ".dll") or f.name == "LICENSE.txt"):
            shutil.copy2(f, runtime / f.name)
    (runtime / "DLLs").mkdir()
    for f in (base / "DLLs").iterdir():
        if f.is_file() and not RUNTIME_DLL_SKIP.match(f.name):
            shutil.copy2(f, runtime / "DLLs" / f.name)
    copytree(base / "Lib", runtime / "Lib",
             ignore=lambda d, names: [n for n in names if n in RUNTIME_LIB_SKIP])
    copytree(site, runtime / "Lib" / "site-packages",
             ignore=lambda d, names: [n for n in names if SITE_SKIP.match(n)])
    log(f"  runtime: Python {sys.version.split()[0]} from {base} + packages from {site} "
        f"({size_of(runtime) / 1e6:.0f} MB)")


def smoke_test(out):
    py = out / "runtime" / "python.exe"
    code = ("import sherpa_onnx, numpy, websockets, httpx, opencc, sys; "
            "print('runtime OK:', sys.version.split()[0], 'sherpa-onnx', sherpa_onnx.__version__)")
    result = subprocess.run([str(py), "-E", "-s", "-c", code], capture_output=True, text=True, cwd=out)
    if result.returncode:
        raise SystemExit(f"Runtime smoke test failed:\n{result.stderr}")
    log("  " + result.stdout.strip())


def main():
    p = argparse.ArgumentParser(description="Build the shareable Local AI Live Translate package")
    p.add_argument("--no-zip", action="store_true", help="only build the folder")
    p.add_argument("--no-whisper", action="store_true", help="leave out the Whisper-Small model (359 MB)")
    args = p.parse_args()

    ver = version()
    out = DIST / NAME
    t0 = time.perf_counter()
    log(f"Building {NAME} {ver} -> {out}")
    # Empty the folder rather than deleting it, so a build still works while the folder is open
    # in Explorer or a terminal (Windows won't delete a directory that is in use).
    out.mkdir(parents=True, exist_ok=True)
    for child in out.iterdir():
        shutil.rmtree(child) if child.is_dir() else child.unlink()

    for f in ("START_Local_AI_Live_Translate.bat", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"):
        shutil.copy2(ROOT / f, out / f)
    # The first-run setup, so a bundle can repair itself (e.g. if a model file is deleted).
    (out / "tools").mkdir()
    for f in ("setup.ps1", "dependencies.json"):
        shutil.copy2(ROOT / "tools" / f, out / "tools" / f)

    copytree(ROOT / "extension", out / "extension")
    (out / "server").mkdir()
    for f in ("live_translate_server.py", "translator.py", "qwen_live.py", "requirements.txt"):
        shutil.copy2(ROOT / "server" / f, out / "server" / f)
    log("  extension + server copied")

    models = out / "models"
    models.mkdir()
    shutil.copy2(MODEL_SRC / "silero_vad.onnx", models / "silero_vad.onnx")
    copytree(MODEL_SRC / SENSE_VOICE, models / SENSE_VOICE)
    copytree(MODEL_SRC / "speaker", models / "speaker")  # speaker labels (28 MB)
    copytree(MODEL_SRC / DOLPHIN, models / DOLPHIN, ignore=shutil.ignore_patterns("test_wavs"))  # 250 MB
    copytree(MODEL_SRC / OMNI, models / OMNI, ignore=shutil.ignore_patterns("test_wavs"))  # 366 MB
    if not args.no_whisper:
        copytree(MODEL_SRC / WHISPER, models / WHISPER)
    log(f"  models: {size_of(models) / 1e6:.0f} MB")

    build_runtime(out)
    smoke_test(out)
    log(f"Folder ready: {out} ({size_of(out) / 1e6:.0f} MB)")

    if not args.no_zip:
        ext_zip = DIST / f"{NAME}-extension-{ver}.zip"
        ext_zip.unlink(missing_ok=True)
        with zipfile.ZipFile(ext_zip, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted((ROOT / "extension").rglob("*")):
                if f.is_file():
                    z.write(f, Path("extension") / f.relative_to(ROOT / "extension"))
        log(f"Extension zip ready: {ext_zip}")
        zip_path = DIST / f"{NAME}-{ver}-windows-x64.zip"
        zip_path.unlink(missing_ok=True)
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for f in sorted(out.rglob("*")):
                if f.is_file():
                    z.write(f, Path(NAME) / f.relative_to(out))
        log(f"Zip ready: {zip_path} ({zip_path.stat().st_size / 1e6:.0f} MB)")
    log(f"Done in {time.perf_counter() - t0:.0f} s")


if __name__ == "__main__":
    main()
