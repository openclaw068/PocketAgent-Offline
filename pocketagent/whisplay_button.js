import { spawn } from 'node:child_process';

export function startWhisplayButtonWatcher() {
  const proc = spawn('/usr/bin/python3', ['/opt/pocketagent/pocketagent/whisplay_ptt_rpigpio.py'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  const listeners = { press: [], release: [] };
  const emit = (kind) => { for (const fn of listeners[kind]) { try { fn(); } catch {} } };

  proc.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      const t = line.trim().toLowerCase();
      if (t === 'press') emit('press');
      if (t === 'release') emit('release');
    }
  });

  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error('[PocketAgent][whisplay] py:', msg);
  });

  proc.on('exit', (code, signal) => {
    console.error('[PocketAgent][whisplay] listener exited:', { code, signal });
  });

  console.log('[PocketAgent][whisplay] button listener started');
  return {
    onPress(fn) { listeners.press.push(fn); return this; },
    onRelease(fn) { listeners.release.push(fn); return this; },
    stop() { try { proc.kill('SIGTERM'); } catch {} }
  };
}
