import fs from 'node:fs';

function getApiKey(envName = 'OPENAI_API_KEY') {
  const key = process.env[envName];
  if (!key) throw new Error(`Missing ${envName} in environment`);
  return key;
}

export async function whisperTranscribe({ baseUrl, apiKeyEnv, audioPath, model }) {
  const apiKey = getApiKey(apiKeyEnv);
  const url = `${baseUrl.replace(/\/$/, '')}/audio/transcriptions`;

  const fd = new FormData();
  fd.append('model', model);
  fd.append('file', new Blob([fs.readFileSync(audioPath)]), 'audio.wav');

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Whisper transcription failed: ${res.status} ${res.statusText} ${t}`);
  }
  const json = await res.json();
  return json.text;
}

export async function chat({ baseUrl, apiKeyEnv, model, messages }) {
  const apiKey = getApiKey(apiKeyEnv);
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Chat failed: ${res.status} ${res.statusText} ${t}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

export async function ttsToWav({ baseUrl, apiKeyEnv, model, voice, text }) {
  const apiKey = getApiKey(apiKeyEnv);
  const url = `${baseUrl.replace(/\/$/, '')}/audio/speech`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, voice, format: 'wav', input: text })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`TTS failed: ${res.status} ${res.statusText} ${t}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
