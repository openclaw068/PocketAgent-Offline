import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './config.js';
import { recordToWav, playWav } from './audio.js';
import { whisperTranscribe, ttsToWav } from './openai.js';
import { ReminderEngine, newId } from './reminders.js';
import { handleUtterance } from './agent.js';
import { loadJson, saveJson } from './store.js';

const DATA_DIR = process.env.POCKETAGENT_DATA_DIR || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultsPath = DEFAULTS.defaultsFile;
const remindersPath = DEFAULTS.remindersDbFile;

const baseUrl = DEFAULTS.openaiBaseUrl;
const apiKeyEnv = DEFAULTS.openaiApiKeyEnv;

const runtime = {
  state: {
    pending: null,
    defaults: loadJson(defaultsPath, {
      timezone: DEFAULTS.timezone,
      followup: {
        mode: 'ask', // ask|once|repeat
        everyMin: 15,
        maxCount: null,
        quietHours: { start: 23, end: 7 }
      }
    })
  }
};

function parseFollowup(followupText) {
  const t = (followupText || '').toLowerCase().trim();

  // Use default
  if (t.includes('default') || t.includes('use the default') || t === 'yes') {
    const d = runtime.state.defaults.followup;
    if (d.mode === 'once') return { followupEveryMin: null };
    if (d.mode === 'repeat') {
      return {
        followupEveryMin: d.everyMin ?? 15,
        followupMaxCount: d.maxCount ?? null,
        followupQuietHours: d.quietHours ?? { start: 23, end: 7 }
      };
    }
    // mode=ask fallback
    return { followupEveryMin: d.everyMin ?? 15 };
  }

  // Just once
  if (t.includes('just once') || (t.includes('once') && !t.includes('every'))) return { followupEveryMin: null };

  // Parse "every 15 minutes"
  const m = t.match(/every\s+(\d+)\s*(min|mins|minute|minutes)/);
  if (m) return { followupEveryMin: Number(m[1]) };

  // Parse "repeat" without number
  if (t.includes('repeat')) return { followupEveryMin: runtime.state.defaults.followup.everyMin ?? 15 };

  // Fallback to default repeat interval
  return { followupEveryMin: runtime.state.defaults.followup.everyMin ?? 15 };
}

function parseDue(timeText) {
  // V1: interpret "8am" as next occurrence today/tomorrow in local time.
  // For now we use system time. On Pi, set timezone properly.
  const now = new Date();
  const m = timeText.trim().match(/^(tomorrow\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) {
    // fallback: 1 minute from now
    return new Date(Date.now() + 60_000).toISOString();
  }
  const isTomorrow = !!m[1];
  let hh = Number(m[2]);
  const mm = m[3] ? Number(m[3]) : 0;
  const ap = m[4]?.toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;

  const due = new Date(now);
  due.setSeconds(0, 0);
  due.setHours(hh, mm, 0, 0);

  if (isTomorrow || due <= now) {
    due.setDate(due.getDate() + 1);
  }
  return due.toISOString();
}

async function say(text) {
  const wav = await ttsToWav({
    baseUrl,
    apiKeyEnv,
    model: DEFAULTS.ttsModel,
    voice: DEFAULTS.ttsVoice,
    text
  });
  const out = path.join(DATA_DIR, 'tts.wav');
  fs.writeFileSync(out, wav);
  await playWav({ wavPath: out, cmd: DEFAULTS.playbackCommand });
}

async function listenForAck({ secondsMax = 3 }) {
  const wavPath = path.join(DATA_DIR, 'ack.wav');
  try {
    await recordToWav({
      outPath: wavPath,
      sampleRateHertz: DEFAULTS.sampleRateHertz,
      device: DEFAULTS.recordingDevice,
      secondsMax
    });
    const text = await whisperTranscribe({ baseUrl, apiKeyEnv, audioPath: wavPath, model: DEFAULTS.whisperModel });
    return (text || '').trim();
  } catch {
    return '';
  }
}

function isAck(text) {
  return /\b(yes|yeah|yep|done|did it|i did|completed)\b/i.test(text);
}

async function notify(reminder, meta) {
  const prompt = meta.kind === 'due'
    ? `Reminder: ${reminder.text}. Did you do it?`
    : `Did you do it yet? ${reminder.text}`;

  await say(prompt);

  // After speaking, listen briefly for a yes/done response.
  const heard = await listenForAck({ secondsMax: 3 });
  if (isAck(heard)) {
    engine.acknowledge(reminder.id);
    await say("Awesome — I’ll take it off the list.");
  }
}

const engine = new ReminderEngine({ dbFile: remindersPath, timezone: runtime.state.defaults.timezone });
engine.start(async (r, meta) => notify(r, meta));

async function oneTurn() {
  const wavPath = path.join(DATA_DIR, 'input.wav');
  await say('Hold the button and speak.');
  await recordToWav({ outPath: wavPath, sampleRateHertz: DEFAULTS.sampleRateHertz, device: DEFAULTS.recordingDevice, secondsMax: 8 });

  const text = await whisperTranscribe({ baseUrl, apiKeyEnv, audioPath: wavPath, model: DEFAULTS.whisperModel });
  console.log('Heard:', text);

  // Allow quick global default setting by voice.
  // Example: "set default followups every 15 minutes" or "set default followups once"
  if (/^set default followups?/i.test(text.trim())) {
    const t = text.toLowerCase();
    if (t.includes('once')) {
      runtime.state.defaults.followup.mode = 'once';
    } else {
      const m = t.match(/every\s+(\d+)\s*(min|mins|minute|minutes)/);
      runtime.state.defaults.followup.mode = 'repeat';
      if (m) runtime.state.defaults.followup.everyMin = Number(m[1]);
    }
    saveJson(defaultsPath, runtime.state.defaults);
    await say('Okay — default follow-ups updated.');
    return;
  }

  const result = await handleUtterance({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, text, state: runtime.state });
  runtime.state = result.state ?? runtime.state;

  // If we just collected a full reminder
  if (result.intent === 'set_followup' && runtime.state.collected) {
    const { reminderText, timeText, followupText } = runtime.state.collected;
    const dueAtIso = parseDue(timeText);
    const follow = parseFollowup(followupText);
    engine.add({ id: newId(), text: reminderText, dueAtIso, ...follow });
    runtime.state.collected = null;
    await say(`Okay. I'll remind you at ${timeText}.`);
    return;
  }

  if (result.intent === 'ack_latest') {
    const open = engine.listOpen().sort((a,b)=> (a.dueAtIso||'').localeCompare(b.dueAtIso||''));
    const latest = open[0];
    if (latest) engine.acknowledge(latest.id);
    await say(result.say);
    return;
  }

  await say(result.say || 'Okay.');
}

// V1: loop on stdin ENTER to simulate button press.
console.log('PocketAgent running. Press ENTER to simulate hold-to-talk.');
process.stdin.setEncoding('utf8');
process.stdin.on('data', async () => {
  try {
    await oneTurn();
  } catch (e) {
    console.error(e);
    try { await say('Something went wrong. Check the logs.'); } catch {}
  }
});
