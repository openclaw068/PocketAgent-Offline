import fs from 'node:fs';
import { spawn } from 'node:child_process';

export async function recordToWav({ outPath, sampleRateHertz = 16000, device = null, secondsMax = 20 }) {
  // Uses arecord (ALSA). Hold-to-talk can be implemented by stopping the process.
  // WAV container, 16-bit LE, mono.
  return new Promise((resolve, reject) => {
    const args = [
      '-q',
      '-D', device ?? 'default',
      '-f', 'S16_LE',
      '-c', '1',
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

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 || code === 130) return resolve({ outPath });
      reject(new Error(`arecord failed (code ${code}): ${stderr}`));
    });

    // Caller can stop by sending SIGINT to the child process by deleting file? Instead expose proc? For v1,
    // we rely on the timeout and manual SIGINT not wired yet.
  });
}

export async function playWav({ wavPath, cmd = 'aplay' }) {
  if (!fs.existsSync(wavPath)) throw new Error(`Missing wav file: ${wavPath}`);
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, [wavPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} failed (code ${code}): ${stderr}`));
    });
  });
}
