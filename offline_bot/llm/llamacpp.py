from __future__ import annotations

import json
import subprocess


def run_json_intent(
    *,
    llama_bin: str,
    model_path: str,
    prompt: str,
    temperature: float = 0.1,
    ctx: int = 2048,
    max_tokens: int = 256,
):
    """Run llama.cpp CLI and parse strict JSON from output.

    Assumes llama.cpp binary supports arguments similar to:
      -m <model>
      -p <prompt>
      -n <tokens>
      --temp <temp>
      -c <ctx>

    Returns parsed dict.
    """

    args = [
        llama_bin,
        "-m",
        model_path,
        "-c",
        str(ctx),
        "-n",
        str(max_tokens),
        "--temp",
        str(temperature),
        "-p",
        prompt,
    ]

    res = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"llama.cpp failed ({res.returncode}): {(res.stderr or '').strip()}")

    out = (res.stdout or "").strip()
    # Extract first JSON object
    start = out.find("{")
    end = out.rfind("}")
    if start >= 0 and end > start:
        blob = out[start : end + 1]
        try:
            return json.loads(blob)
        except Exception as e:
            raise RuntimeError(f"Failed to parse JSON from llama output: {e}\nOutput:\n{out[-2000:]}")

    raise RuntimeError(f"No JSON found in llama output:\n{out[-2000:]}")
