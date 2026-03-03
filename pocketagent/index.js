import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './config.js';
import { recordToWav, playWav, runHook } from './audio.js';
import { whisperTranscribe, ttsToAudio, chat as openaiChat } from './openai.js';
import http from 'node:http';

import { handleUtterance } from './agent.js';
import { loadJson, saveJson } from './store.js';
// (openaiChat is imported above with whisperTranscribe/ttsToAudio)
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
    }),

    // Chat mode conversation memory
    chat: {
      sessionId: null,
      messages: [],
      carryover: []
    }
  }
};

function loadChatHistory() {
  return loadJson(DEFAULTS.chatHistoryFile, {
    last10: [],
    lastSessionId: null,
    updatedAtIso: null
  });
}

function saveChatHistory(last10, sessionId = null) {
  saveJson(DEFAULTS.chatHistoryFile, {
    last10,
    lastSessionId: sessionId,
    updatedAtIso: new Date().toISOString()
  });
}

function newSessionId() {
  return Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
}

function bootstrapChatSession() {
  const h = loadChatHistory();
  runtime.state.chat.sessionId = newSessionId();
  runtime.state.chat.carryover = Array.isArray(h.last10) ? h.last10.slice(-DEFAULTS.chatCarryoverCount) : [];
  runtime.state.chat.messages = [...runtime.state.chat.carryover];
  console.log('[PocketAgent] chat session:', { sessionId: runtime.state.chat.sessionId, carryover: runtime.state.chat.carryover.length });
}

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

function normalizeTimeText(s) {
  return String(s || '')
    .trim()
    // normalize punctuation variants: "a.m." -> "am", "p.m." -> "pm"
    .replace(/\b([ap])\s*\.?\s*m\.?\b/gi, (_, ap) => `${ap.toLowerCase()}m`)
    // drop leftover periods ("a.m."/"p.m." variants)
    .replace(/\./g, '')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    // strip common filler words
    .replace(/^at\s+/i, '')
    .trim();
}

function parseDue(timeText) {
  // V1: interpret common short phrases as next occurrence today/tomorrow in local time.
  // For now we use system time. On Pi, set timezone properly.
  const now = new Date();
  const t = normalizeTimeText(timeText);

  // Accept:
  // - "7am", "7 am", "7 a.m.";
  // - "7:30pm", "7:30 pm";
  // - optional "tomorrow" prefix;
  // - optional "at" prefix.
  const m = t.match(/^(tomorrow\s+)?(at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) {
    // fallback: 1 minute from now
    return new Date(Date.now() + 60_000).toISOString();
  }

  const isTomorrow = !!m[1];
  let hh = Number(m[3]);
  const mm = m[4] ? Number(m[4]) : 0;
  const ap = m[5]?.toLowerCase();

  // If no am/pm given, assume next occurrence in the future (24h clock-ish behavior)
  // (e.g. "7" at 6pm -> tomorrow 7:00; at 6am -> today 7:00)
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

async function notifyAndMaybeAck({ id, text, kind }) {
  // Track which reminder we most recently spoke, so "done" can clear the right one.
  runtime.state.lastNotifiedReminderId = id;

  const prompt = kind === 'due'
    ? `Reminder: ${text}. Did you do it?`
    : `Did you do it yet? ${text}`;

  await say(prompt);

  // After speaking, listen briefly for a yes/done response.
  const heard = await listenForAck({ secondsMax: 5 });
  if (isAck(heard)) {
    await remindersPost('/reminders/ack', { id });
    await say("Awesome — I’ll take it off the list.");
  }
}

// Reminders run in a separate daemon (see reminders_daemon.js). The chat agent only
// receives notify callbacks.
if (DEFAULTS.mode === 'chat') {
  bootstrapChatSession();
}

const REMINDERS_HOST = process.env.POCKETAGENT_REMINDERS_HOST || '127.0.0.1';
const REMINDERS_PORT = Number(process.env.POCKETAGENT_REMINDERS_PORT || 3791);

const NOTIFY_HOST = process.env.POCKETAGENT_NOTIFY_HOST || '127.0.0.1';
const NOTIFY_PORT = Number(process.env.POCKETAGENT_NOTIFY_PORT || 3781);

let busy = false;
const notifyQueue = [];

function remindersReqOptions(pathname, method, bodyBuf = null) {
  const headers = bodyBuf
    ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bodyBuf.length }
    : {};
  return {
    method,
    hostname: REMINDERS_HOST,
    port: REMINDERS_PORT,
    path: pathname,
    headers,
    timeout: 10_000
  };
}

async function remindersGet(pathname) {
  return await new Promise((resolve, reject) => {
    const req = http.request(remindersReqOptions(pathname, 'GET'), res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, json: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, json: null, raw });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('reminders GET timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function remindersPost(pathname, payload) {
  const bodyBuf = Buffer.from(JSON.stringify(payload ?? {}));
  return await new Promise((resolve, reject) => {
    const req = http.request(remindersReqOptions(pathname, 'POST', bodyBuf), res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, json: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, json: null, raw });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('reminders POST timeout')));
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function drainNotifyQueue() {
  if (busy) return;
  if (!notifyQueue.length) return;
  busy = true;
  try {
    while (notifyQueue.length) {
      const ev = notifyQueue.shift();
      await notifyAndMaybeAck(ev);
    }
  } finally {
    busy = false;
  }
}

function startNotifyServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && u.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && u.pathname === '/notify') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        const body = raw ? JSON.parse(raw) : {};

        // Enqueue and only speak when idle.
        notifyQueue.push({ id: body.id, text: body.text, kind: body.kind });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, queued: notifyQueue.length }));

        // If idle, drain immediately.
        void drainNotifyQueue();
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message ?? String(e) }));
    }
  });

  server.listen(NOTIFY_PORT, NOTIFY_HOST, () => {
    console.log('[PocketAgent] notify server listening:', { host: NOTIFY_HOST, port: NOTIFY_PORT });
  });
}

startNotifyServer();

async function maybeAnnounceStartupOncePerBoot() {
  if ((process.env.POCKETAGENT_STARTUP_ANNOUNCE ?? 'false').toLowerCase() !== 'true') return;
  if (DEFAULTS.mode !== 'chat') return;

  const bootIdPath = '/proc/sys/kernel/random/boot_id';
  let bootId = null;
  try {
    bootId = fs.readFileSync(bootIdPath, 'utf8').trim();
  } catch {
    // If boot_id isn’t available, fall back to “once per process start”.
    bootId = null;
  }

  const markerPath = path.join(DATA_DIR, 'startup_announce_boot_id.txt');
  let lastBootId = null;
  try {
    lastBootId = fs.readFileSync(markerPath, 'utf8').trim();
  } catch {
    lastBootId = null;
  }

  if (bootId && lastBootId === bootId) return;

  const delayMs = Number(process.env.POCKETAGENT_STARTUP_ANNOUNCE_DELAY_MS ?? 1500);
  const text = (process.env.POCKETAGENT_STARTUP_ANNOUNCE_TEXT || 'PocketAgent is online.').trim();

  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  await say(text);

  // Persist boot marker so we don’t announce again until the next reboot.
  try {
    fs.writeFileSync(markerPath, bootId ? `${bootId}\n` : `started:${new Date().toISOString()}\n`);
  } catch {}
}

// Fire and forget
void maybeAnnounceStartupOncePerBoot();

async function oneTurn({ abortSignal = null } = {}) {
  busy = true;
  try {
    const wavPath = path.join(DATA_DIR, 'input.wav');

    if ((process.env.POCKETAGENT_PROMPT_ON_PRESS ?? 'true').toLowerCase() === 'true') {
      await say('Hold the button and speak.');
    }

    // Ensure we never accidentally reuse a stale recording if arecord fails to create the file.
    try { fs.unlinkSync(wavPath); } catch {}

    const rec = await recordToWav({
      outPath: wavPath,
      sampleRateHertz: DEFAULTS.sampleRateHertz,
      channels: DEFAULTS.recordingChannels,
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

  // CHAT MODE: general voice assistant + reminder control.
  // In chat mode we still allow reminder actions (create/list/ack/etc) by running the
  // reminders state machine first and only falling back to open-ended chat if it
  // wasn’t a reminder-related request.
  if (DEFAULTS.mode === 'chat') {
    // First: try reminders state machine
    const r1 = await handleUtterance({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, text, state: runtime.state });
    runtime.state = r1.state ?? runtime.state;

    // If it looks like a reminders intent, execute it here.
    if (r1?.intent && r1.intent !== 'unknown') {
      // Handle defaults updates
      if (r1.intent === 'update_defaults' && r1.defaultsPatch) {
        const p = r1.defaultsPatch;
        runtime.state.defaults.followup.mode = p.mode === 'once' ? 'once' : 'repeat';
        if (runtime.state.defaults.followup.mode === 'repeat') {
          if (p.everyMin != null) runtime.state.defaults.followup.everyMin = Number(p.everyMin);
          runtime.state.defaults.followup.maxCount = p.maxCount ?? null;
          if (p.quietHours) runtime.state.defaults.followup.quietHours = p.quietHours;
        } else {
          runtime.state.defaults.followup.maxCount = null;
        }
        saveJson(defaultsPath, runtime.state.defaults);
      }

      // If we just collected a full reminder
      if (r1.intent === 'set_followup' && runtime.state.collected) {
        const { reminderText, timeText, followupSpec } = runtime.state.collected;
        runtime.state.collected = null;
        const r = await remindersPost('/reminders/add', { reminderText, timeText, followupSpec });
        if (r?.json?.ok) {
          await say(`Perfect — I’ll remind you at ${timeText}.`);
        } else {
          await say('I had trouble saving that reminder. Check the logs.');
        }
        return;
      }

      // Ack latest reminder (from notification context)
      if (r1.intent === 'ack_latest') {
        const id = runtime.state.lastNotifiedReminderId;
        if (id) await remindersPost('/reminders/ack', { id });
        if (r1.say) {
          await say(r1.say);
        }
        return;
      }

      // Query reminders (list/what’s next/etc)
      if (r1.intent === 'query_reminders') {
        const all = await remindersGet('/reminders/all');
        const reminders = all?.json?.reminders || [];

        const engineLike = {
          listAll: () => reminders,
          listOpen: () => reminders.filter(r => r.status === 'open'),
          listByDateRange: ({ startIso, endIso, status = null }) => {
            const start = startIso ? new Date(startIso).getTime() : -Infinity;
            const end = endIso ? new Date(endIso).getTime() : Infinity;
            return reminders
              .filter(r => {
                const t = new Date(r.dueAtIso).getTime();
                if (Number.isNaN(t)) return false;
                if (t < start || t > end) return false;
                if (status && r.status !== status) return false;
                return true;
              })
              .sort((a, b) => new Date(a.dueAtIso) - new Date(b.dueAtIso));
          }
        };

        const selected = selectRemindersForQuery(engineLike, r1.queryText);
        const answer = await answerReminderQuery({
          baseUrl,
          apiKeyEnv,
          model: DEFAULTS.chatModel,
          queryText: r1.queryText,
          reminders: selected
        });
        await say(answer);
        return;
      }

      // Volume
      if (r1.intent === 'set_volume') {
        const pct = await setVolumePercent({
          card: DEFAULTS.alsaCard,
          control: DEFAULTS.alsaVolumeControl,
          percent: r1.percent
        });
        await say(`Done — volume set to ${pct} percent.`);
        return;
      }

      // Default: speak state machine response if provided
      if (r1.say) {
        await say(r1.say);
        return;
      }
    }

    // Otherwise: fall back to general chat with conversation memory.
    runtime.state.chat.messages.push({ role: 'user', content: text });

    const systemPrompt = (process.env.POCKETAGENT_CHAT_SYSTEM_PROMPT || '').trim() ||
      'You are a helpful, concise voice assistant. Keep replies short and conversational.';

    const messages = [{ role: 'system', content: systemPrompt }, ...runtime.state.chat.messages];

    const reply = await openaiChat({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, messages });
    const assistantText = (reply || '').trim();

    runtime.state.chat.messages.push({ role: 'assistant', content: assistantText });

    const last10 = runtime.state.chat.messages.slice(-DEFAULTS.chatCarryoverCount);
    saveChatHistory(last10, runtime.state.chat.sessionId);

    await say(assistantText || 'Okay.');

    const chatAuto = (process.env.POCKETAGENT_CHAT_AUTO_LISTEN ?? 'false').toLowerCase() === 'true';
    if (chatAuto) {
      const maxTurns = Number(process.env.POCKETAGENT_CHAT_AUTO_LISTEN_MAX_TURNS ?? 2);
      for (let i = 0; i < maxTurns; i++) {
        const text2 = await autoListenOnce();
        if (!text2) break;

        runtime.state.chat.messages.push({ role: 'user', content: text2 });
        const messages2 = [{ role: 'system', content: systemPrompt }, ...runtime.state.chat.messages];
        const reply2 = await openaiChat({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, messages: messages2 });
        const assistantText2 = (reply2 || '').trim();
        runtime.state.chat.messages.push({ role: 'assistant', content: assistantText2 });

        const last10b = runtime.state.chat.messages.slice(-DEFAULTS.chatCarryoverCount);
        saveChatHistory(last10b, runtime.state.chat.sessionId);

        await say(assistantText2 || 'Okay.');
      }
    }

    return;
  }

  // REMINDERS MODE: state machine
  const result = await handleUtterance({ baseUrl, apiKeyEnv, model: DEFAULTS.chatModel, text, state: runtime.state });

  if (result.intent === 'update_defaults' && result.defaultsPatch) {
    const p = result.defaultsPatch;
    runtime.state.defaults.followup.mode = p.mode === 'once' ? 'once' : 'repeat';
    if (runtime.state.defaults.followup.mode === 'repeat') {
      if (p.everyMin != null) runtime.state.defaults.followup.everyMin = Number(p.everyMin);
      runtime.state.defaults.followup.maxCount = p.maxCount ?? null;
      if (p.quietHours) runtime.state.defaults.followup.quietHours = p.quietHours;
    } else {
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
    const r = await remindersPost('/reminders/add', { reminderText, timeText, followupSpec });
    runtime.state.collected = null;
    if (r?.json?.ok) {
      await say(`Perfect — I’ll remind you at ${timeText}.`);
    } else {
      await say('I had trouble saving that reminder. Check the logs.');
    }
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
      const attempts = Number(process.env.POCKETAGENT_AUTO_LISTEN_RECORD_RETRIES ?? 4);
      let lastErr = null;
      for (let i = 0; i < attempts; i++) {
        try {
          await recordToWav({
            outPath: wavPath2,
            sampleRateHertz: DEFAULTS.sampleRateHertz,
            channels: DEFAULTS.recordingChannels,
            device: DEFAULTS.recordingDevice,
            secondsMax
          });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          // backoff a bit and retry (ALSA can be briefly busy right after playback)
          await new Promise(r => setTimeout(r, 250));
        }
      }
      if (lastErr) {
        console.error('[PocketAgent] auto-listen record failed:', lastErr?.message ?? lastErr);
        return '';
      }
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

  if (result.intent === 'ack_latest') {
    const id = runtime.state.lastNotifiedReminderId;
    if (id) await remindersPost('/reminders/ack', { id });
    await say(result.say);
    return;
  }

  if (result.intent === 'query_reminders') {
    // Pull reminders from daemon and answer via LLM
    const all = await remindersGet('/reminders/all');
    const reminders = all?.json?.reminders || [];

    // Minimal engine-like wrapper for selectRemindersForQuery() expectations
    const engineLike = {
      listAll: () => reminders,
      listOpen: () => reminders.filter(r => r.status === 'open'),
      listByDateRange: ({ startIso, endIso, status = null }) => {
        const start = startIso ? new Date(startIso).getTime() : -Infinity;
        const end = endIso ? new Date(endIso).getTime() : Infinity;
        return reminders
          .filter(r => {
            const t = new Date(r.dueAtIso).getTime();
            if (Number.isNaN(t)) return false;
            if (t < start || t > end) return false;
            if (status && r.status !== status) return false;
            return true;
          })
          .sort((a, b) => new Date(a.dueAtIso) - new Date(b.dueAtIso));
      }
    };

    const selected = selectRemindersForQuery(engineLike, result.queryText);
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
  } finally {
    busy = false;
    // If any reminders arrived while we were busy, speak them now.
    void drainNotifyQueue();
  }
}

const PTT_MODE = (process.env.POCKETAGENT_PTT_MODE || 'gpio').toLowerCase();

async function safeOneTurn(abortSignal = null) {
  const onStart = process.env.POCKETAGENT_ON_TURN_START_CMD || '';
  const onEnd = process.env.POCKETAGENT_ON_TURN_END_CMD || '';
  const onEndDelayMs = Number(process.env.POCKETAGENT_ON_TURN_END_DELAY_MS ?? 0);

  try {
    // Stop/duck external audio sources (e.g., shairport-sync) before recording.
    try { await runHook(onStart); } catch (e) { console.error('[PocketAgent] on-turn-start hook failed:', e?.message ?? e); }

    await oneTurn({ abortSignal });
  } catch (e) {
    console.error(e);
    try { await say('Something went wrong. Check the logs.'); } catch {}
  } finally {
    // Resume external audio sources after we finish speaking.
    try {
      if (onEndDelayMs > 0) await new Promise(r => setTimeout(r, onEndDelayMs));
      await runHook(onEnd);
    } catch (e) {
      console.error('[PocketAgent] on-turn-end hook failed:', e?.message ?? e);
    }
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
