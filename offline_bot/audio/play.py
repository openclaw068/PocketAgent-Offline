from __future__ import annotations

import os
import subprocess


def play_wav(*, wav_path: str, device: str = "default") -> None:
    if not os.path.exists(wav_path):
        raise FileNotFoundError(wav_path)

    args = ["aplay"]
    if device:
        args += ["-D", device]
    args.append(wav_path)

    res = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"aplay failed ({res.returncode}): {(res.stderr or '').strip()}")
