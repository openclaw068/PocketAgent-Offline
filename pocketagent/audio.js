import fs from 'node:fs';
import { spawn } from 'node:child_process';

export async function recordToWav({ outPath, sampleRateHertz = 16000, channels = 1, device = null, secondsMax = 20, abortSignal = null }) {
  // Uses arecord (ALSA). WAV container, 16-bit LE.
  // If abortSignal is provided, recording stops on abort (push-to-talk release).
  return new Promise((resolve, reject) => {
    const args = [
      '-q',
      '-D', device ?? 'default',
      '-f', 'S16_LE',
      '-c', String(channels),
      '-r', String(sampleRateHertz),
      '-t', 'wav',
      outPath
    ];

    const proc = spawn('arecord', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      try { proc.kill('SIGINT'); } catch {}
    }, secondsMax * 1000);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try { proc.kill('SIGINT'); } catch {}
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener?.('abort', onAbort);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener?.('abort', onAbort);

      // When using push-to-talk we often SIGINT the process mid-stream.
      // arecord may exit with 130 (SIGINT) or sometimes 1 depending on ALSA/device state.
      // If we initiated an abort, treat it as a clean abort regardless of exit code.
      if (aborted) return resolve({ outPath, aborted: true, code });

      if (code === 0 || code === 130) return resolve({ outPath, aborted: false });

      reject(new Error(`arecord failed (code ${code}): ${stderr}`));
    });
  });
}

export async function playWav({ wavPath, cmd = 'aplay', device = null }) {
  if (!fs.existsSync(wavPath)) throw new Error(`Missing wav file: ${wavPath}`);
  return new Promise((resolve, reject) => {
    const args = [];
    if (device) args.push('-D', device);
    args.push(wavPath);
    const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} failed (code ${code}): ${stderr}`));
    });
  });
}

export async function runHook(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return;

  // Use a shell so users can pass simple commands like:
  //   systemctl stop shairport-sync
  //   /usr/bin/logger "..."
  return await new Promise((resolve, reject) => {
    const proc = spawn('sh', ['-lc', s], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`hook failed (code ${code}): ${stderr}`));
    });
  });
}
