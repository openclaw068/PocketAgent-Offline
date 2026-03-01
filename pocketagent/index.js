import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './config.js';
import { recordToWav, playWav } from './audio.js';
import { whisperTranscribe, ttsToWav } from './openai.js';
import { ReminderEngine, newId } from './reminders.js';
import { handleUtterance } from './agent.js';
import { loadJson, saveJson } from './store.js';
import { answerReminderQuery, selectRemindersForQuery } from './query.js';
import { setVolumePercent } from './volume.js';
import { startButtonWatcher } from './gpio_button.js';

const DATA_DIR = process.env.POCKETAGENT_DATA_DIR || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultsPath = process.env.POCKETAGENT_DEFAULTS_FILE || path.join(DATA_DIR, 'defaults.json');
const remindersPath = process.env.POCKETAGENT_REMINDERS_DB || path.join(DATA_DIR, 'reminders.json');

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

function followupFromSpec(spec) {
  const d = runtime.state.defaults.followup;
  const dQuiet = d.quietHours ?? { start: 23, end: 7 };

  if (!spec || spec.kind === 'use_default') {
    if (d.mode === 'once') return { followupEveryMin: null };
    return {
      followupEveryMin: d.everyMin ?? 15,
      followupMaxCount: d.maxCount ?? null,
      followupQuietHours: dQuiet
    };
  }

  // custom
  if (spec.everyMin === null) return { followupEveryMin: null };
  return {
    followupEveryMin: Number(spec.everyMin ?? (d.everyMin ?? 15)),
    followupMaxCount: spec.maxCount ?? null,
    followupQuietHours: spec.quietHours ?? dQuiet
  };
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
  await playWav({ wavPath: out, cmd: DEFAULTS.playbackCommand, device: DEFAULTS.playbackDevice });
}

async function listenForAck({ secondsMax = 5 }) {
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
  // Track which reminder we most recently spoke, so "done" can clear the right one.
  runtime.state.lastNotifiedReminderId = reminder.id;

  const prompt = meta.kind === 'due'
    ? `Reminder: ${reminder.text}. Did you do it?`
    : `Did you do it yet? ${reminder.text}`;

  await say(prompt);

  // After speaking, listen briefly for a yes/done response.
  const heard = await listenForAck({ secondsMax: 5 });
  if (isAck(heard)) {
    engine.acknowledge(reminder.id);
    await say("Awesome — I’ll take it off the list.");
  }
}

const engine = new ReminderEngine({ dbFile: remindersPath, timezone: runtime.state.defaults.timezone });
engine.start(async (r, meta) => notify(r, meta));

async function oneTurn({ abortSignal = null } = {}) {
  const wavPath = path.join(DATA_DIR, 'input.wav');
  await say('Hold the button and speak.');
  await recordToWav({ outPath: wavPath, sampleRateHertz: DEFAULTS.sampleRateHertz, device: DEFAULTS.recordingDevice, secondsMax: 8, abortSignal });

  const text = await whisperTranscribe({ baseUrl, apiKeyEnv, audioPath: wavPath, model: DEFAULTS.whisperModel });
  console.log('Heard:', text);

  const result = await handleUtterance({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, text, state: runtime.state });

  if (result.intent === 'update_defaults' && result.defaultsPatch) {
    const p = result.defaultsPatch;
    runtime.state.defaults.followup.mode = p.mode === 'once' ? 'once' : 'repeat';
    if (runtime.state.defaults.followup.mode === 'repeat') {
      if (p.everyMin != null) runtime.state.defaults.followup.everyMin = Number(p.everyMin);
      runtime.state.defaults.followup.maxCount = p.maxCount ?? null;
      if (p.quietHours) runtime.state.defaults.followup.quietHours = p.quietHours;
    } else {
      // once
      runtime.state.defaults.followup.maxCount = null;
    }

    saveJson(defaultsPath, runtime.state.defaults);

    const d = runtime.state.defaults.followup;
    const quiet = d.quietHours ? `${d.quietHours.start}:00 to ${d.quietHours.end}:00` : 'no quiet hours';
    const summary = d.mode === 'once'
      ? `Got it. Default follow-ups set to just once.`
      : `Got it. Default follow-ups: every ${d.everyMin ?? 15} minutes, max ${d.maxCount ?? 'no limit'}, quiet hours ${quiet}.`;

    await say(summary);
    return;
  }
  runtime.state = result.state ?? runtime.state;

  // If we just collected a full reminder
  if (result.intent === 'set_followup' && runtime.state.collected) {
    const { reminderText, timeText, followupSpec } = runtime.state.collected;
    const dueAtIso = parseDue(timeText);
    const follow = followupFromSpec(followupSpec);
    engine.add({ id: newId(), text: reminderText, dueAtIso, ...follow });
    runtime.state.collected = null;
    await say(`Perfect — I’ll remind you at ${timeText}.`);
    return;
  }

  if (result.intent === 'ack_latest') {
    const id = runtime.state.lastNotifiedReminderId;
    if (id) engine.acknowledge(id);
    await say(result.say);
    return;
  }

  if (result.intent === 'query_reminders') {
    const selected = selectRemindersForQuery(engine, result.queryText);
    const answer = await answerReminderQuery({
      baseUrl,
      apiKeyEnv,
      model: DEFAULTS.chatModel,
      queryText: result.queryText,
      reminders: selected
    });
    await say(answer);
    return;
  }

  if (result.intent === 'set_volume') {
    const pct = await setVolumePercent({
      card: DEFAULTS.alsaCard,
      control: DEFAULTS.alsaVolumeControl,
      percent: result.percent
    });
    await say(`Done — volume set to ${pct} percent.`);
    return;
  }

  await say(result.say || 'Okay.');
}

const PTT_MODE = (process.env.POCKETAGENT_PTT_MODE || 'gpio').toLowerCase();

async function safeOneTurn(abortSignal = null) {
  try {
    await oneTurn({ abortSignal });
  } catch (e) {
    console.error(e);
    try { await say('Something went wrong. Check the logs.'); } catch {}
  }
}

if (PTT_MODE === 'stdin') {
  // Dev mode: press ENTER to simulate a button press.
  console.log('PocketAgent running. Press ENTER to simulate hold-to-talk.');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async () => safeOneTurn(null));
} else {
  // Hardware mode: use ULTRA++ button on GPIO23 by default.
  console.log('PocketAgent running. Waiting for push-to-talk button.');

  let inTurn = false;
  let controller = null;

  const watcher = startButtonWatcher();
  watcher
    .onPress(() => {
      if (inTurn) return;
      inTurn = true;
      controller = new AbortController();
      // Start recording immediately; stop when release aborts.
      void safeOneTurn(controller.signal).finally(() => {
        inTurn = false;
        controller = null;
      });
    })
    .onRelease(() => {
      // Stop recording when user releases button.
      try { controller?.abort(); } catch {}
    });
}
