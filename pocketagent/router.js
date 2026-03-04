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
      'set_volume',
      'general_chat'
    ],
    // create_reminder
    reminderText: 'string|null',
    timeText: 'string|null',
    // query_reminders
    queryText: 'string|null',
    // ack_reminder
    ackTarget: 'latest|by_text|null',
    ackText: 'string|null',
    // update_followup_defaults
    defaultsText: 'string|null',
    // set_volume
    volumePercent: 'number|null'
  };

  const sys =
    'You are PocketAgent. Your job is to route the user\'s utterance into one of a few intents for a local, offline reminders system. ' +
    'Return ONLY valid JSON with no markdown. ' +
    'Prefer reminders intents when the user is asking about reminders, scheduling, completing, canceling, or what\'s coming up. ' +
    'If the user is just chatting (trivia, random questions), choose intent="general_chat". ' +
    'For acknowledgements: if user indicates completion (done/complete/finished) and there is a recent reminder context, choose intent="ack_reminder" with ackTarget="latest". ' +
    'If the user says to complete a specific reminder by description, choose ackTarget="by_text" and set ackText to the short description (e.g., "trash"). ' +
    'For creating reminders, extract reminderText and timeText in the user\'s words (timeText should be a short phrase like "7am" or "tomorrow 7am"). ' +
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
