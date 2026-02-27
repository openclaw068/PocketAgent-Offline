import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleUtterance } from '../pocketagent/agent.js';
import { loadJson, saveJson } from '../pocketagent/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DATA_DIR = process.env.POCKETAGENT_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const defaultsPath = process.env.POCKETAGENT_DEFAULTS_FILE || path.join(DATA_DIR, 'defaults.json');

const state = {
  pending: null,
  defaults: loadJson(defaultsPath, {
    timezone: 'America/Chicago',
    followup: { mode: 'repeat', everyMin: 15, maxCount: null, quietHours: { start: 23, end: 7 } }
  })
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (d) => (buf += d.toString('utf8')));
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const apiKeyEnv = 'OPENAI_API_KEY';
const model = process.env.POCKETAGENT_CHAT_MODEL || 'gpt-4o-mini';

const server = http.createServer(async (req, res) => {
  try {
    // Static
    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/assets/') || req.url === '/app.js' || req.url === '/style.css')) {
      const url = req.url === '/' ? '/index.html' : req.url;
      const filePath = path.join(__dirname, url);
      if (!filePath.startsWith(__dirname)) return send(res, 403, {}, 'Forbidden');
      const ext = path.extname(filePath);
      const type = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.js' ? 'application/javascript; charset=utf-8'
        : 'application/octet-stream';
      const content = fs.readFileSync(filePath);
      return send(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-store' }, content);
    }

    // Health
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });

    // Chat turn
    if (req.method === 'POST' && req.url === '/api/turn') {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const text = String(body.text || '');

      const result = await handleUtterance({ baseUrl, apiKeyEnv, model, text, state });

      // Apply defaults patch if present
      if (result.intent === 'update_defaults' && result.defaultsPatch) {
        const p = result.defaultsPatch;
        state.defaults.followup.mode = p.mode === 'once' ? 'once' : 'repeat';
        if (state.defaults.followup.mode === 'repeat') {
          if (p.everyMin != null) state.defaults.followup.everyMin = Number(p.everyMin);
          state.defaults.followup.maxCount = p.maxCount ?? null;
          if (p.quietHours) state.defaults.followup.quietHours = p.quietHours;
        }
        saveJson(defaultsPath, state.defaults);
      }

      return json(res, 200, {
        ok: true,
        user: text,
        assistant: result.say || '',
        debug: {
          intent: result.intent,
          pending: state.pending,
          defaults: state.defaults
        }
      });
    }

    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`PocketAgent web tester listening on :${PORT}`);
});
