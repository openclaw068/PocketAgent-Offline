import fs from 'node:fs';
import { spawn } from 'node:child_process';

const AUDIO_DEBUG = (process.env.POCKETAGENT_AUDIO_DEBUG ?? 'false').toLowerCase() === 'true';


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

    if (AUDIO_DEBUG) console.log('[PocketAgent][audio] spawn arecord', { args, outPath, device, sampleRateHertz, channels, secondsMax });
    const proc = spawn('arecord', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      const t = d.toString();
      stderr += t;
      if (AUDIO_DEBUG) console.log('[PocketAgent][audio][arecord:stderr]', t.trim());
    });

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
      if (AUDIO_DEBUG) {
        let bytes = null;
        try { bytes = fs.statSync(outPath).size; } catch {}
        console.log('[PocketAgent][audio] arecord closed', { code, aborted, bytes, stderr: (stderr || '').trim().slice(0, 500) });
      }

      clearTimeout(timeout);
      if (abortSignal) abortSignal.removeEventListener?.('abort', onAbort);

      // When using push-to-talk we often SIGINT the process mid-stream.
      // arecord may exit with 130 (SIGINT) or sometimes 1 depending on ALSA/device state.
      // Guard: ignore near-empty WAVs (button bounce / immediate abort)
      // IMPORTANT: do this even when aborted=true because arecord may create a WAV header (44 bytes)
      // before any audio data is written.
      try {
        const st = fs.statSync(outPath);
        if (st.size < 2048) return resolve({ outPath, aborted: true, code, bytes: st.size });
      } catch {}

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
    proc.stderr.on('data', (d) => {
      const t = d.toString();
      stderr += t;
      if (AUDIO_DEBUG) console.log('[PocketAgent][audio][arecord:stderr]', t.trim());
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (AUDIO_DEBUG) {
        let bytes = null;
        try { bytes = fs.statSync(outPath).size; } catch {}
        console.log('[PocketAgent][audio] arecord closed', { code, aborted, bytes, stderr: (stderr || '').trim().slice(0, 500) });
      }

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
