from __future__ import annotations

import os
import signal
import subprocess
import time
from dataclasses import dataclass


@dataclass
class RecordResult:
    out_path: str
    aborted: bool
    code: int | None
    stderr: str


def record_to_wav(
    *,
    out_path: str,
    device: str = "default",
    sample_rate_hz: int = 16000,
    channels: int = 1,
    seconds_max: int = 8,
    abort_flag_path: str | None = None,
):
    """Record audio via arecord to a wav file.

    Abort: if abort_flag_path is provided, we poll for file existence and stop when it appears.
    (This is a simple cross-process abort mechanism suitable for a GPIO button watcher.)
    """

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    try:
        os.unlink(out_path)
    except FileNotFoundError:
        pass

    args = [
        "arecord",
        "-q",
        "-D",
        device,
        "-f",
        "S16_LE",
        "-c",
        str(channels),
        "-r",
        str(sample_rate_hz),
        "-t",
        "wav",
        out_path,
    ]

    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    stderr = ""

    deadline = time.time() + float(seconds_max)
    aborted = False

    try:
        while True:
            if proc.poll() is not None:
                break

            if abort_flag_path and os.path.exists(abort_flag_path):
                aborted = True
                try:
                    proc.send_signal(signal.SIGINT)
                except Exception:
                    pass
                break

            if time.time() >= deadline:
                try:
                    proc.send_signal(signal.SIGINT)
                except Exception:
                    pass
                break

            time.sleep(0.02)
    finally:
        try:
            _, err = proc.communicate(timeout=2)
            stderr += err or ""
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    return RecordResult(out_path=out_path, aborted=aborted, code=proc.returncode, stderr=(stderr or "").strip())
