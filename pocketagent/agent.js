import { chat } from './openai.js';

export async function handleUtterance({ baseUrl, apiKeyEnv, model, text, state }) {
  // V1: simple heuristic parser + minimal LLM assist for follow-up question.
  // state: { pending: null|{kind:'reminder', text}, defaults }

  const t = text.trim();
  if (!t) return { say: "I didn't catch that. Try again.", state };

  // If we are mid-flow asking for time
  if (state.pending?.kind === 'ask_time') {
    // Accept simple times like 8am, 8:15, tomorrow 8am is handled earlier.
    return { intent: 'set_time', timeText: t, say: `Okay — ${t}. How often should I remind you if you don't answer? You can say something like every 15 minutes, or just once.`, state: { ...state, pending: { kind: 'ask_repeat', reminderText: state.pending.reminderText, timeText: t } } };
  }

  if (state.pending?.kind === 'ask_repeat') {
    return { intent: 'set_repeat', repeatText: t, say: `Got it. I'll set that up.`, state: { ...state, pending: null, collected: { reminderText: state.pending.reminderText, timeText: state.pending.timeText, repeatText: t } } };
  }

  // If user says they completed something
  if (/\b(done|did it|completed|yes i did|yeah i did)\b/i.test(t)) {
    return { intent: 'ack_latest', say: `Nice — I'll mark that as done.`, state };
  }

  // Basic reminder detection
  if (/\b(remind me|i need to remember|don't let me forget|remember to)\b/i.test(t)) {
    return { intent: 'new_reminder', say: `Sure. What time should I remind you?`, state: { ...state, pending: { kind: 'ask_time', reminderText: t } } };
  }

  // Otherwise, fallback to chat for a short reply
  const content = await chat({
    baseUrl,
    apiKeyEnv,
    model,
    messages: [
      { role: 'system', content: 'You are a concise voice assistant running on a Raspberry Pi. Keep replies under 2 short sentences.' },
      { role: 'user', content: t }
    ]
  });

  return { intent: 'chat', say: content, state };
}
