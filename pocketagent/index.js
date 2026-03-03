import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './config.js';
import { recordToWav, playWav } from './audio.js';
import { whisperTranscribe, ttsToAudio } from './openai.js';
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
  // Never let TTS/audio failures crash the whole loop.
  try {
    const { audio, contentType } = await ttsToAudio({
      baseUrl,
      apiKeyEnv,
      model: DEFAULTS.ttsModel,
      voice: DEFAULTS.ttsVoice,
      text,
      format: 'wav'
    });
    const out = path.join(DATA_DIR, 'tts.wav');
    fs.writeFileSync(out, audio);

    // Quick sanity check to avoid blasting static if the provider returns MP3/etc.
    if (!audio?.slice?.(0, 4)?.equals?.(Buffer.from('RIFF')) && !(contentType || '').includes('wav')) {
      throw new Error(`TTS did not return WAV (content-type=${contentType || 'unknown'})`);
    }

    await playWav({ wavPath: out, cmd: DEFAULTS.playbackCommand, device: DEFAULTS.playbackDevice });
  } catch (e) {
    console.error('say() failed:', e?.message ?? e);
    // Fallback: log the prompt so the system stays usable even if quota is exhausted.
    console.log('SAY:', text);
  }
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
    const text = await whisperTranscribe({
      baseUrl,
      apiKeyEnv,
      audioPath: wavPath,
      model: DEFAULTS.whisperModel,
      prompt: process.env.POCKETAGENT_WHISPER_PROMPT || null,
      language: process.env.POCKETAGENT_WHISPER_LANGUAGE || null,
      responseFormat: process.env.POCKETAGENT_WHISPER_RESPONSE_FORMAT || 'json'
    });
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
  if ((process.env.POCKETAGENT_PROMPT_ON_PRESS ?? 'true').toLowerCase() === 'true') {
    await say('Hold the button and speak.');
  }

  // Ensure we never accidentally reuse a stale recording if arecord fails to create the file.
  try { fs.unlinkSync(wavPath); } catch {}

  const rec = await recordToWav({
    outPath: wavPath,
    sampleRateHertz: DEFAULTS.sampleRateHertz,
    device: DEFAULTS.recordingDevice,
    secondsMax: 8,
    abortSignal
  });

  try {
    const st = fs.statSync(wavPath);
    console.log('[PocketAgent] recorded bytes:', st.size, 'aborted=', !!rec?.aborted);
  } catch {
    console.log('[PocketAgent] recorded bytes: <missing>', 'aborted=', !!rec?.aborted);
  }

  // If the user released immediately, arecord exits (often code 130) and we may have
  // no file. Avoid crashing on ENOENT.
  if (rec?.aborted && !fs.existsSync(wavPath)) {
    console.log('Recording aborted before audio was written; ignoring.');
    return;
  }

  if (!fs.existsSync(wavPath)) {
    console.error('Missing recorded audio file:', wavPath);
    await say('I did not capture any audio. Try holding the button a bit longer.');
    return;
  }

  const text = await whisperTranscribe({
    baseUrl,
    apiKeyEnv,
    audioPath: wavPath,
    model: DEFAULTS.whisperModel,
    prompt: process.env.POCKETAGENT_WHISPER_PROMPT || null,
    language: process.env.POCKETAGENT_WHISPER_LANGUAGE || null,
    responseFormat: process.env.POCKETAGENT_WHISPER_RESPONSE_FORMAT || 'json'
  });
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

  async function autoListenOnce() {
    const secondsMax = Number(process.env.POCKETAGENT_AUTO_LISTEN_SECONDS ?? 6);
    const delayMs = Number(process.env.POCKETAGENT_AUTO_LISTEN_DELAY_MS ?? 250);
    const wavPath2 = path.join(DATA_DIR, 'input.wav');
    try { fs.unlinkSync(wavPath2); } catch {}

    // Give ALSA a moment to settle after playback before opening the capture device.
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

    try {
      await recordToWav({
        outPath: wavPath2,
        sampleRateHertz: DEFAULTS.sampleRateHertz,
        device: DEFAULTS.recordingDevice,
        secondsMax
      });
    } catch (e) {
      console.error('[PocketAgent] auto-listen record failed:', e?.message ?? e);
      return '';
    }

    if (!fs.existsSync(wavPath2)) return '';

    const text2 = await whisperTranscribe({
      baseUrl,
      apiKeyEnv,
      audioPath: wavPath2,
      model: DEFAULTS.whisperModel,
      prompt: process.env.POCKETAGENT_WHISPER_PROMPT || null,
      language: process.env.POCKETAGENT_WHISPER_LANGUAGE || null,
      responseFormat: process.env.POCKETAGENT_WHISPER_RESPONSE_FORMAT || 'json'
    });
    console.log('Heard (auto):', text2);
    return (text2 || '').trim();
  }

  // Conversation mode: after we speak a question (pending state), auto-listen for a reply.
  const autoListenEnabled = (process.env.POCKETAGENT_AUTO_LISTEN_ON_PROMPTS ?? 'false').toLowerCase() === 'true';
  const maxAutoTurns = Number(process.env.POCKETAGENT_AUTO_LISTEN_MAX_TURNS ?? 2);

  // Speak the immediate response first.
  if (result.say) {
    await say(result.say);
  }

  if (autoListenEnabled) {
    for (let i = 0; i < maxAutoTurns; i++) {
      const pendingKind = runtime.state?.pending?.kind;
      if (!pendingKind) break;

      const text2 = await autoListenOnce();
      if (!text2) {
        // If we heard nothing, repeat the question once, then exit.
        if (pendingKind === 'ask_time') await say('What time should I remind you? For example: 7am.');
        break;
      }

      const result2 = await handleUtterance({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, text: text2, state: runtime.state });
      runtime.state = result2.state ?? runtime.state;

      if (result2.say) {
        await say(result2.say);
      }
    }
  }

  return;

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

function logConfig() {
  const sttModel = DEFAULTS.whisperModel;
  const chatModel = DEFAULTS.chatModel;
  const ttsModel = DEFAULTS.ttsModel;
  console.log('[PocketAgent] mode:', PTT_MODE);
  console.log('[PocketAgent] models:', { stt: sttModel, chat: chatModel, tts: ttsModel, voice: DEFAULTS.ttsVoice });
  console.log('[PocketAgent] audio:', {
    sampleRateHertz: DEFAULTS.sampleRateHertz,
    recordingDevice: DEFAULTS.recordingDevice,
    playbackCommand: DEFAULTS.playbackCommand,
    playbackDevice: DEFAULTS.playbackDevice
  });
  if (PTT_MODE !== 'stdin') {
    console.log('[PocketAgent] gpio:', {
      chip: process.env.POCKETAGENT_GPIO_CHIP || 'gpiochip0',
      line: Number(process.env.POCKETAGENT_PTT_GPIO_LINE ?? 23),
      activeLow: (process.env.POCKETAGENT_PTT_ACTIVE_LOW ?? 'true')
    });
  }
}

logConfig();

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
  let pressAtMs = 0;

  const MIN_HOLD_MS = Number(process.env.POCKETAGENT_PTT_MIN_HOLD_MS ?? 600);

  const watcher = startButtonWatcher();
  watcher
    .onPress(() => {
      if (inTurn) return;
      inTurn = true;
      pressAtMs = Date.now();
      controller = new AbortController();
      // Start recording immediately; stop when release aborts.
      void safeOneTurn(controller.signal).finally(() => {
        // Small cooldown reduces edge-chatter / accidental immediate retriggers
        setTimeout(() => {
          inTurn = false;
          controller = null;
          pressAtMs = 0;
        }, Number(process.env.POCKETAGENT_PTT_COOLDOWN_MS ?? 200));
      });
    })
    .onRelease(() => {
      // Stop recording when user releases button.
      // Some buttons bounce and can emit a release edge almost immediately after press.
      // Enforce a minimum hold time before we abort arecord.
      const elapsed = pressAtMs ? (Date.now() - pressAtMs) : Infinity;
      const delay = Math.max(0, MIN_HOLD_MS - elapsed);
      if (delay > 0) {
        setTimeout(() => {
          try { controller?.abort(); } catch {}
        }, delay);
      } else {
        try { controller?.abort(); } catch {}
      }
    });
}
