import schedule from 'node-schedule';
import { loadJson, saveJson } from './store.js';

function nowMs() { return Date.now(); }

export class ReminderEngine {
  constructor({ dbFile, timezone }) {
    this.dbFile = dbFile;
    this.tz = timezone;
    this.state = loadJson(dbFile, { reminders: [] });
    this.jobs = new Map();
  }

  save() {
    saveJson(this.dbFile, this.state);
  }

  listOpen() {
    return this.state.reminders.filter(r => r.status === 'open');
  }

  add(reminder) {
    const r = {
      id: reminder.id,
      text: reminder.text,
      dueAtIso: reminder.dueAtIso,
      createdAtIso: new Date().toISOString(),
      status: 'open',
      // follow-up policy
      followupEveryMin: reminder.followupEveryMin ?? null,
      followupMaxCount: reminder.followupMaxCount ?? null,
      followupQuietHours: reminder.followupQuietHours ?? { start: 23, end: 7 },
      followupCount: 0,
      lastNotifiedAtIso: null,
      acknowledgedAtIso: null
    };
    this.state.reminders.push(r);
    this.save();
    this._scheduleReminder(r);
    return r;
  }

  acknowledge(id) {
    const r = this.state.reminders.find(x => x.id === id);
    if (!r) return null;
    r.status = 'done';
    r.acknowledgedAtIso = new Date().toISOString();
    this.save();
    this._cancel(id);
    return r;
  }

  start(notifyFn) {
    this.notifyFn = notifyFn;
    // schedule all open reminders
    for (const r of this.listOpen()) this._scheduleReminder(r);
  }

  _cancel(id) {
    const job = this.jobs.get(id);
    if (job) job.cancel();
    this.jobs.delete(id);
  }

  _scheduleReminder(r) {
    this._cancel(r.id);
    const date = new Date(r.dueAtIso);
    const job = schedule.scheduleJob({ start: date, rule: date, tz: this.tz }, async () => {
      await this._fire(r.id);
    });
    this.jobs.set(r.id, job);
  }

  async _fire(id) {
    const r = this.state.reminders.find(x => x.id === id);
    if (!r || r.status !== 'open') return;
    r.lastNotifiedAtIso = new Date().toISOString();
    this.save();
    await this.notifyFn?.(r, { kind: 'due' });

    // schedule follow-ups as separate timers
    if (r.followupEveryMin && r.followupEveryMin > 0) {
      this._scheduleFollowup(r);
    }
  }

  _inQuietHours(quiet, d = new Date()) {
    const h = d.getHours();
    const start = quiet?.start ?? 23;
    const end = quiet?.end ?? 7;
    if (start === end) return false;
    if (start < end) return h >= start && h < end;
    return h >= start || h < end; // wraps midnight
  }

  _scheduleFollowup(r) {
    const everyMs = r.followupEveryMin * 60_000;
    const tick = async () => {
      const rr = this.state.reminders.find(x => x.id === r.id);
      if (!rr || rr.status !== 'open') return;
      if (rr.followupMaxCount != null && rr.followupCount >= rr.followupMaxCount) return;
      if (this._inQuietHours(rr.followupQuietHours)) {
        setTimeout(tick, everyMs);
        return;
      }
      rr.followupCount += 1;
      rr.lastNotifiedAtIso = new Date().toISOString();
      this.save();
      await this.notifyFn?.(rr, { kind: 'followup' });
      setTimeout(tick, everyMs);
    };
    setTimeout(tick, everyMs);
  }
}

export function newId() {
  return Math.random().toString(16).slice(2) + '-' + nowMs().toString(16);
}
