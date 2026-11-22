import { RERUN_HINT, messageChars } from './compact.js';
import { renderTranscript } from './render.js';
import { truncate } from './state.js';
import { segmentTurns } from './turns.js';
import type { Message, ToolResult, ToolUse } from './types.js';
import {
  FOLD_LINE_CHARS,
  FOLD_NOTE_HEAD,
  FOLD_PROMPT_CHARS,
  FOLD_SEGMENT_CHARS,
  FOLD_SYSTEM,
  UNFOLD_TOOL_NAME,
} from './fold-spec.js';
import type {
  CarriedLines,
  FoldDir,
  FoldEntry,
  FoldNote,
  FoldOlder,
  FoldPath,
  FoldPrompt,
  FoldSegment,
  NextFoldNumbers,
  ParseFoldReply,
  PointResults,
  SegmentFold,
  WriteFolds,
} from './fold-spec.js';

/** Collapses whitespace runs to one space: an index line never holds a line break. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Headers of the reply: `STATE` and `PARTS` at a line start, in any case, with `#`, `*` and spaces around. */
const STATE_HEADER = /^[ \t#*]*STATE(?![A-Za-z])[ \t#*]*:?[ \t#*]*/gim;
const PARTS_HEADER = /^[ \t#*]*PARTS(?![A-Za-z])[ \t#*]*:?[ \t#*]*/gim;
/** A reply line `<key>: <line>`, the key possibly after `- `, inside `*` or backticks. */
const PART_LINE = /^\s*(?:[-*+]\s+)?[*`\s]*([^\s:*`]+)[*`\s]*:[*`\s]*(.*)$/;

/** The first header of `pattern` at or after `from`. */
function headerAt(pattern: RegExp, text: string, from: number): RegExpExecArray | null {
  pattern.lastIndex = from;
  return pattern.exec(text);
}

/** The line of a segment the model gave none for: its request, or a generic label. */
function fallbackLine(segment: FoldSegment): string {
  const head = segment.continued ? '(continues) ' : '';
  const request = oneLine(segment.request);
  return head + (request ? truncate(request, 200) : 'earlier summary and notes');
}

/** The header of a segment in the prompt. */
function segmentHeader(segment: FoldSegment): string {
  const continued = segment.continued ? ' (continues)' : '';
  return segment.request ? `=== ${segment.key}: ${segment.request}${continued} ===` : `=== ${segment.key}${continued} ===`;
}

/** The messages as stored: the `Message` fields only, a tool use without its outcome when the part holds the result. */
export function storedMessages(messages: readonly Message[]): Message[] {
  const held = new Set<string>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) held.add(result.tool_use_id);
  }
  return messages.map((message) => {
    const stored: Message = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((use) => {
        const kept: ToolUse = { tool_use_id: use.tool_use_id, tool: use.tool, input: use.input };
        if (!held.has(use.tool_use_id)) {
          if (use.text !== undefined) kept.text = use.text;
          if (use.isError !== undefined) kept.isError = use.isError;
        }
        return kept;
      }),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      stored.toolResults = message.toolResults.map((result) => {
        const kept: ToolResult = { tool_use_id: result.tool_use_id, text: result.text };
        if (result.isError !== undefined) kept.isError = result.isError;
        return kept;
      });
    }
    return stored;
  });
}

export const foldDir: FoldDir = (root, sessionId) => `${root}/${sessionId.replace(/[^A-Za-z0-9_-]/gu, '_')}`;

export const foldPath: FoldPath = (dir, id) => `${dir}/${id}.json`;

export const nextFoldNumbers: NextFoldNumbers = (names) => {
  let f = 0;
  let r = 0;
  for (const name of names) {
    const match = /^([fr])([1-9]\d*)\.json$/.exec(name);
    if (!match) continue;
    const n = Number(match[2]);
    if (match[1] === 'f') f = Math.max(f, n);
    else r = Math.max(r, n);
  }
  return { f: f + 1, r: r + 1 };
};

export const segmentFold: SegmentFold = (messages, maxChars = FOLD_SEGMENT_CHARS) => {
  if (messages.length === 0) return [];
  const turns = segmentTurns(messages, 0);
  const bounds: { start: number; end: number; request: string }[] = [];
  const first = turns.length > 0 ? turns[0]!.start : messages.length;
  if (first > 0) bounds.push({ start: 0, end: first, request: '' });
  for (const turn of turns) bounds.push({ start: turn.start, end: turn.end, request: turn.request });

  const pieces: Omit<FoldSegment, 'key'>[] = [];
  for (const bound of bounds) {
    let total = 0;
    for (let i = bound.start; i < bound.end; i++) total += messageChars(messages[i]!);
    let start = bound.start;
    let continued = false;
    let chars = 0;
    for (let i = bound.start; i < bound.end; i++) {
      const cut =
        total > maxChars &&
        i > start &&
        messages[i]!.role === 'assistant' &&
        messages[i - 1]!.role === 'user' &&
        chars >= maxChars;
      if (cut) {
        pieces.push({ start, end: i, request: bound.request, continued });
        start = i;
        continued = true;
        chars = 0;
      }
      chars += messageChars(messages[i]!);
    }
    pieces.push({ start, end: bound.end, request: bound.request, continued });
  }
  return pieces.map((piece, n) => ({ key: `S${String(n + 1).padStart(2, '0')}`, ...piece }));
};

export const foldPrompt: FoldPrompt = (instructions, segments, reading) => {
  const wrap = (limit?: number): string => {
    const body = segments
      .map((segment) => `${segmentHeader(segment)}\n${renderTranscript(reading.slice(segment.start, segment.end), limit)}`)
      .join('\n\n');
    return `${instructions}\n\n<conversation>\n${body}\n</conversation>`;
  };
  const prompt = wrap();
  return prompt.length <= FOLD_PROMPT_CHARS ? prompt : wrap(Math.floor(FOLD_PROMPT_CHARS / segments.length));
};

export const parseFoldReply: ParseFoldReply = (text, keys) => {
  const stateHeader = headerAt(STATE_HEADER, text, 0);
  const from = stateHeader ? stateHeader.index + stateHeader[0].length : 0;
  const partsHeader = headerAt(PARTS_HEADER, text, from);
  const state = stateHeader ? text.slice(from, partsHeader ? partsHeader.index : text.length).trim() : '';

  const lines: Record<string, string> = {};
  if (partsHeader) {
    for (const line of text.slice(partsHeader.index + partsHeader[0].length).split('\n')) {
      const match = PART_LINE.exec(line);
      if (!match) continue;
      const key = match[1]!;
      if (keys.includes(key) && !(key in lines)) lines[key] = truncate(oneLine(match[2]!), FOLD_LINE_CHARS);
    }
  }
  return { state, lines };
};

export const carriedLines: CarriedLines = (messages) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of messages) {
    if (!message.text.startsWith(FOLD_NOTE_HEAD)) continue;
    for (const line of message.text.split('\n')) {
      const match = /^(f[1-9]\d*) · /.exec(line);
      if (!match || seen.has(match[1]!)) continue;
      seen.add(match[1]!);
      out.push(line);
    }
  }
  return out;
};

export const foldNote: FoldNote = (carried, added) => {
  if (carried.length === 0 && added.length === 0) return '';
  const head =
    `${FOLD_NOTE_HEAD}: the earlier conversation is stored outside the context, one line per part, oldest first. ` +
    `Call ${UNFOLD_TOOL_NAME} with an id for the original messages, or with a query to search them.`;
  return [head, ...carried, ...added.map((fold) => `${fold.id} · ${oneLine(fold.line)}`)].join('\n');
};

export const writeFolds: WriteFolds = async (store, dir, entries) => {
  await Promise.all(entries.map((entry) => store.write(foldPath(dir, entry.id), JSON.stringify(entry, null, 2))));
};

export const foldOlder: FoldOlder = async (input) => {
  const carried = carriedLines(input.older);
  const segments = segmentFold(input.older);
  if (segments.length === 0) return { state: '', note: foldNote(carried, []), ids: [] };

  const { f } = nextFoldNumbers(await input.store.list(input.dir));
  const answer = await input.complete(
    FOLD_SYSTEM,
    foldPrompt(input.instructions, segments, input.reading),
  );
  const reply = answer === undefined ? undefined : parseFoldReply(answer, segments.map((segment) => segment.key));

  const added = segments.map((segment, n) => ({
    id: `f${f + n}`,
    line: reply?.lines[segment.key] || fallbackLine(segment),
  }));
  const entries = segments.map((segment, n): FoldEntry => ({
    id: added[n]!.id,
    kind: 'part',
    at: input.at,
    line: added[n]!.line,
    messages: storedMessages(input.older.slice(segment.start, segment.end)),
  }));
  await writeFolds(input.store, input.dir, entries);

  return { state: reply?.state ?? '', note: foldNote(carried, added), ids: added.map((fold) => fold.id) };
};

export const pointResults: PointResults = (input, output, start, at) => {
  const inputResults = new Map<string, ToolResult>();
  const inputUses = new Map<string, ToolUse>();
  for (const message of input) {
    for (const use of message.toolUses) inputUses.set(use.tool_use_id, use);
    for (const result of message.toolResults ?? []) inputResults.set(result.tool_use_id, result);
  }
  const countsUse = (use: ToolUse) =>
    use.text !== undefined && use.text.endsWith(RERUN_HINT) && use.text !== inputUses.get(use.tool_use_id)?.text;
  const countsResult = (result: ToolResult) =>
    result.text.endsWith(RERUN_HINT) && result.text !== inputResults.get(result.tool_use_id)?.text;

  const ids = new Map<string, string>();
  const idOf = (toolUseId: string): string => {
    let id = ids.get(toolUseId);
    if (id === undefined) {
      id = `r${start + ids.size}`;
      ids.set(toolUseId, id);
    }
    return id;
  };
  for (const message of output) {
    for (const use of message.toolUses) if (countsUse(use)) idOf(use.tool_use_id);
    for (const result of message.toolResults ?? []) if (countsResult(result)) idOf(result.tool_use_id);
  }

  const rewrite = (text: string, id: string): string =>
    `${text.slice(0, -RERUN_HINT.length)}; full text: ${UNFOLD_TOOL_NAME} id ${id}]`;

  const messages = output.map((message): Message => {
    const usesChanged = message.toolUses.some(countsUse);
    const resultsChanged = (message.toolResults ?? []).some(countsResult);
    if (!usesChanged && !resultsChanged) return message;
    const changed: Message = {
      ...message,
      toolUses: message.toolUses.map((use) =>
        countsUse(use) ? { ...use, text: rewrite(use.text!, ids.get(use.tool_use_id)!) } : use,
      ),
    };
    if (message.toolResults) {
      changed.toolResults = message.toolResults.map((result) =>
        countsResult(result) ? { ...result, text: rewrite(result.text, ids.get(result.tool_use_id)!) } : result,
      );
    }
    return changed;
  });

  const entries: FoldEntry[] = [];
  for (const [toolUseId, id] of ids) {
    const result = inputResults.get(toolUseId);
    const use = inputUses.get(toolUseId);
    entries.push({
      id,
      kind: 'result',
      at,
      tool: use?.tool ?? '',
      input: use?.input ?? {},
      text: result?.text ?? '',
      isError: result?.isError ?? false,
    });
  }
  return { messages, entries };
};
