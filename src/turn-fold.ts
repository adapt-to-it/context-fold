import { messageChars } from './compact.js';
import { nextFoldNumbers, storedMessages, writeFolds } from './fold.js';
import { truncate } from './state.js';
import type { Message, ToolResult, ToolUse } from './types.js';
import {
  TURN_CALL_CHARS,
  TURN_FOLD_MIN_CHARS,
  TURN_NOTE_CALLS,
  TURN_NOTE_HEAD,
  UNFOLD_TOOL_NAME,
} from './fold-spec.js';
import type { ClosedTurnSteps, FoldTurn, TurnNote } from './fold-spec.js';

/** Keys of a tool input that a call line shows, in order of preference. */
const BRIEF_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt'];

/** Collapses whitespace runs to one space: a call line never holds a line break. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Whether a message holds tool results. */
const hasResults = (message: Message): boolean => (message.toolResults?.length ?? 0) > 0;

/** The argument of a call line: the first brief key holding a string, else the input as JSON. */
function brief(input: Record<string, unknown>): string {
  for (const key of BRIEF_KEYS) {
    const value = input[key];
    if (typeof value === 'string') return oneLine(value);
  }
  return oneLine(JSON.stringify(input));
}

/** One call line: cut to `TURN_CALL_CHARS` first, then the size of its result and `, error` when it failed. */
function callLine(use: ToolUse, result: ToolResult | undefined): string {
  const line = truncate(`- ${use.tool} ${brief(use.input)}`, TURN_CALL_CHARS);
  if (!result) return line;
  return `${line} → ${result.text.length} chars${result.isError ? ', error' : ''}`;
}

export const closedTurnSteps: ClosedTurnSteps = (messages) => {
  // `end` ends up as the index of the closing answer, the first of the run of answers without tool uses.
  let end = messages.length;
  while (end > 0 && messages[end - 1]!.role === 'assistant' && messages[end - 1]!.toolUses.length === 0) end--;
  if (end === messages.length || end === 0) return undefined;
  if (messages[end - 1]!.role !== 'user' || !hasResults(messages[end - 1]!)) return undefined;

  let start = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user' && !hasResults(messages[i]!)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return undefined;

  let chars = 0;
  for (let i = start; i < end; i++) chars += messageChars(messages[i]!);
  return { start, end, chars };
};

export const turnNote: TurnNote = (id, steps) => {
  const results = new Map<string, ToolResult>();
  for (const message of steps) {
    for (const result of message.toolResults ?? []) results.set(result.tool_use_id, result);
  }
  const uses = steps.flatMap((message) => message.toolUses);
  const chars = steps.reduce((total, message) => total + messageChars(message), 0);

  const lines = [
    `${TURN_NOTE_HEAD} (${id}): ${uses.length} tool calls, ${chars} characters, stored outside the context. Call ${UNFOLD_TOOL_NAME} with id ${id} for the original messages.`,
    ...uses.slice(0, TURN_NOTE_CALLS).map((use) => callLine(use, results.get(use.tool_use_id))),
  ];
  if (uses.length > TURN_NOTE_CALLS) lines.push(`… and ${uses.length - TURN_NOTE_CALLS} more calls`);
  return lines.join('\n');
};

export const foldTurn: FoldTurn = async (input) => {
  const { messages, store, dir, at, result } = input;
  const turn = closedTurnSteps(messages);
  if (!turn || turn.chars < (input.minChars ?? TURN_FOLD_MIN_CHARS)) return undefined;

  let first = turn.start;
  while (first < turn.end && messages[first]!.toolUses.length === 0) first++;
  if (first === turn.end) return undefined;

  const steps = messages.slice(turn.start, turn.end);
  const calls = steps.reduce((total, message) => total + message.toolUses.length, 0);
  const id = `f${nextFoldNumbers(await store.list(dir)).f}`;
  const request = truncate(oneLine(messages[turn.start - 1]!.text), 200);
  await writeFolds(store, dir, [
    {
      id,
      kind: 'part',
      at,
      line: `steps of the turn "${request}": ${calls} tool calls`,
      messages: storedMessages(steps),
    },
  ]);

  const answers: ToolResult[] = messages[first]!.toolUses.map((use, n) => ({
    tool_use_id: use.tool_use_id,
    text: n === 0 ? turnNote(id, steps) : `${TURN_NOTE_HEAD} (${id}): see the first result of this message.`,
    isError: false,
  }));

  return {
    messages: [...messages.slice(0, first + 1), result(answers), ...messages.slice(turn.end)],
    id,
    start: turn.start,
    end: turn.end,
    chars: turn.chars,
    calls,
  };
};
