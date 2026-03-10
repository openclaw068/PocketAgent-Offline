import { chat } from './openai.js';

// LLM-based intent router for natural reminder speech.
// This replaces brittle regex-based phrase matching.
// The reminders daemon remains the source of truth; we only decide which local API to call.

export async function routeUtterance({ baseUrl, apiKeyEnv, model, text, hasLastNotified = false }) {
  const schema = {
    intent: [
      'create_reminder',
      'query_reminders',
      'ack_reminder',
      'update_followup_defaults',
      'update_reminder',
      'delete_reminder',
      'set_volume',
      'general_chat',
      'unknown'
    ],
    // create_reminder
    reminderText: 'string|null',
    timeText: 'string|null',
    // recurrence (optional)
    recurrence: {
      kind: 'none|rrule',
      // RFC5545 RRULE, e.g. FREQ=WEEKLY;BYDAY=TU;INTERVAL=2
      rrule: 'string|null',
      timezone: 'string|null'
    },
    // query_reminders
    queryText: 'string|null',
    // ack_reminder
    ackTarget: 'latest|by_text|null',
    ackText: 'string|null',
    // update_followup_defaults
    defaultsText: 'string|null',

    // update/delete reminders
    target: 'latest|by_text|null',
    targetText: 'string|null',
    update: {
      timeText: 'string|null',
      reminderText: 'string|null',
      followupEveryMin: 'number|null'
    },

    // set_volume
    volumePercent: 'number|null'
  };

  const sys =
    'You are PocketAgent. Your job is to route the user\'s utterance into one of a few intents for a local, offline reminders system. ' +
    'Return ONLY valid JSON with no markdown. ' +
    'Prefer reminders intents when the user is asking about reminders, scheduling, completing, canceling, or what\'s coming up. ' +
    'If the user is just chatting (trivia, random questions), choose intent="general_chat". ' +
    'IMPORTANT: If the user says anything like "remind me" / "set a reminder" / "remember to" then intent MUST be "create_reminder". ' +
    'IMPORTANT: If the user is answering a follow-up timing question with something like "every 5 minutes", "every five minutes", "every hour", etc., set intent="unknown" (do NOT change defaults). ' +
    'Only choose intent="update_followup_defaults" when the user clearly says they want to change DEFAULTS (e.g. "set my default follow-ups to every 5 minutes"). ' +
    'For updating reminders: if user says "change/update/edit" a reminder, choose intent="update_reminder". Use target="latest" when they say "latest" or if there is only one open reminder. Use target="by_text" when they describe it; put that description in targetText. Put changes in update (timeText, reminderText, followupEveryMin). ' +
    'For deleting reminders: if user says "delete/remove/cancel" a reminder, choose intent="delete_reminder" with the same target fields. ' +
    'For acknowledgements: if user indicates completion (done/complete/finished) and there is a recent reminder context, choose intent="ack_reminder" with ackTarget="latest". ' +
    'If the user says to complete a specific reminder by description, choose ackTarget="by_text" and set ackText to the short description (e.g., "trash"). ' +
    'For creating reminders, extract reminderText and timeText in the user\'s words. timeText can be a clock time ("7am") OR a relative time ("in 5 minutes", "in one minute"). ' +
    'If the user asks for a repeating reminder (e.g. "every other Tuesday", "weekends", "every day"), set recurrence.kind="rrule" and provide an RFC5545 RRULE string (no DTSTART) plus timezone (usually America/Chicago unless user says otherwise). ' +
    'If it is not repeating, set recurrence.kind="none". ' +
    'If time is missing for creation, still choose create_reminder and leave timeText=null.';

  const user = {
    text,
    hasLastNotified,
    schema
  };

  const content = await chat({
    baseUrl,
    apiKeyEnv,
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(user) }
    ]
  });

  try {
    return JSON.parse(content);
  } catch {
    return { intent: 'general_chat' };
  }
}
