from __future__ import annotations

import json
import subprocess


def transcribe_wav(
    *,
    whispercpp_bin: str,
    model_path: str,
    wav_path: str,
    language: str = "en",
):
    """Run whisper.cpp on a WAV file.

    Assumes whisper.cpp supports:
      -m <model>
      -f <wav>
      -l <lang>
      -oj (JSON)

    Returns: text string.
    """

    args = [
        whispercpp_bin,
        "-m",
        model_path,
        "-f",
        wav_path,
        "-l",
        language,
        "-oj",
    ]

    res = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"whisper.cpp failed ({res.returncode}): {(res.stderr or '').strip()}")

    # whisper.cpp typically writes JSON to a .json file, not stdout.
    # Some builds print JSON to stdout. We support both.
    out = (res.stdout or "").strip()
    if out.startswith("{"):
        try:
            j = json.loads(out)
            return (j.get("text") or "").strip()
        except Exception:
            pass

    # Fallback: read the generated json file alongside wav
    json_path = wav_path + ".json"
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            j = json.load(f)
        return (j.get("text") or "").strip()
    except Exception:
        # Final fallback: parse plain text from stdout
        return out
