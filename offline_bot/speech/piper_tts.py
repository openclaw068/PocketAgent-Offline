from __future__ import annotations

import os
import subprocess


def tts_to_wav(*, piper_bin: str, voice_path: str, text: str, out_wav_path: str, speed: float = 1.0):
    """Run Piper TTS.

    Piper commonly supports:
      echo "text" | piper -m <voice.onnx> -f <out.wav>

    Speed support depends on Piper build/flags. We try a best-effort approach:
    - If speed != 1.0, we pass --length_scale (inverse-ish) when available.
      (Many Piper builds support --length_scale where <1.0 is faster.)

    This wrapper keeps it simple and doesn't hard-fail if the flag isn't supported.
    """

    os.makedirs(os.path.dirname(out_wav_path), exist_ok=True)

    args = [piper_bin, "-m", voice_path, "-f", out_wav_path]

    # best-effort speed: piper uses length_scale (smaller = faster). We'll map speed>1 to smaller.
    extra_args = []
    if speed and speed != 1.0:
        # e.g. speed=1.2 => length_scale ~ 0.83
        length_scale = max(0.5, min(2.0, 1.0 / float(speed)))
        extra_args = ["--length_scale", str(length_scale)]

    res = subprocess.run(
        args + extra_args,
        input=(text or "").strip() + "\n",
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    if res.returncode == 0:
        return

    # Retry without speed flags in case build doesn't support them
    if extra_args:
        res2 = subprocess.run(
            args,
            input=(text or "").strip() + "\n",
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        if res2.returncode == 0:
            return
        raise RuntimeError(f"piper failed ({res2.returncode}): {(res2.stderr or '').strip()}")

    raise RuntimeError(f"piper failed ({res.returncode}): {(res.stderr or '').strip()}")
