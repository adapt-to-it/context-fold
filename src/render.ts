import type { Message } from './types.js';

/** Caps the transcript a summary model reads; the newest characters stay. */
const TRANSCRIPT_LIMIT = 600_000;
/** Caps each tool input and result inside that transcript. */
const PART_LIMIT = 4_000;

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)} […${text.length - limit} chars cut]`;

/** One message as plain text under `[index] ROLE:`: its text, tool calls and results, each capped at `partLimit`. */
export function renderMessage(message: Message, index: number, partLimit = PART_LIMIT): string {
  const parts = [`[${index}] ${message.role.toUpperCase()}:`];
  if (message.text) parts.push(message.text);
  for (const use of message.toolUses) {
    let input: string;
    try {
      input = JSON.stringify(use.input);
    } catch {
      input = '{}';
    }
    parts.push(`→ ${use.tool} ${clip(input, partLimit)}`);
  }
  for (const result of message.toolResults ?? []) {
    parts.push(`← ${result.isError ? 'error ' : ''}${clip(result.text, partLimit)}`);
  }
  return parts.join('\n');
}

/** The messages as plain text for a summary model: texts, tool calls and their results. */
export function renderTranscript(messages: readonly Message[], limit = TRANSCRIPT_LIMIT, partLimit = PART_LIMIT): string {
  const text = messages.map((message, i) => renderMessage(message, i, partLimit)).join('\n\n');
  return text.length <= limit ? text : `[…earlier part cut]\n${text.slice(text.length - limit)}`;
}
