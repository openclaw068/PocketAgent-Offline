import fs from 'node:fs';
import path from 'node:path';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function loadJson(filePath, fallback) {
  try {
    const s = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export function saveJson(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
