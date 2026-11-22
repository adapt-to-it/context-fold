import type { Message, ToolResult } from './types.js';

/** Where folds are kept: the engine's file system in the hook, a map in tests. Paths are absolute. */
export interface FoldStore {
  /** The file's text; undefined when it does not exist or cannot be read. */
  read(path: string): Promise<string | undefined>;
  /** Writes the file, creating its folders; rejects when it cannot. */
  write(path: string, text: string): Promise<void>;
  /** The file names in `dir`, without the folder; empty when `dir` does not exist. */
  list(dir: string): Promise<string[]>;
}

/** A fold id: `f<n>` a folded part of the conversation, `r<n>` a shortened tool result. */
export const FOLD_ID = /^[fr][1-9]\d*$/;
/** The tool the model reads folds back with, as it calls it. */
export const UNFOLD_TOOL_NAME = 'mcp__fast-jev-compaction__unfold';
/** Start of the note that lists the folded parts; `[fast-jev-compaction] ` makes it a notice, never a request. */
export const FOLD_NOTE_HEAD = '[fast-jev-compaction] Folded parts';
/** A part longer than this (by `messageChars`) is split into several. */
export const FOLD_SEGMENT_CHARS = 40_000;
/** Longest index line. */
export const FOLD_LINE_CHARS = 300;
/** Caps the conversation the summary model reads. */
export const FOLD_PROMPT_CHARS = 600_000;
/** A part read back: its size, and the cap of each tool input and result in it. */
export const UNFOLD_CHARS = 60_000;
export const UNFOLD_PART_CHARS = 2_000;
/** A part read back with `full`, a single message, or a tool result. */
export const UNFOLD_FULL_CHARS = 200_000;
export const SEARCH_HITS = 5;
/** Characters of a search snippet on each side of the match. */
export const SNIPPET_CHARS = 300;

export const FOLD_SYSTEM =
  'You fold the earlier part of a coding session between a user and an AI assistant. The original messages are stored outside the context and the assistant can read any part again by its id, so do not retell them. ' +
  'Reply in plain text with two sections, in this order.\n' +
  'STATE: what the assistant must know to continue without reading the parts again: the goals, constraints, preferences and rules the user set (their exact wording when it sets a rule), the decisions still in force, the current state of the work and the open points. No chronicle of what was done.\n' +
  'PARTS: one line per part, written `<key>: <line>`, for every key you are given, in order. A line says what the user asked and what came of it, with the names of the files, commands, identifiers and errors someone would search for, in at most 200 characters.\n' +
  'Keep names, paths, identifiers, numbers and versions exact. Do not invent anything. Do not address the user. ' +
  'Write in the language the user writes in, and keep any rule they set about the language of replies.';

/** What `$.tool.register` takes for the unfold tool. */
export const UNFOLD_TOOL = {
  name: 'unfold',
  description:
    'Reads back a part of this conversation that a compaction folded. The "Folded parts" note lists the parts as `f<n> · line`; a shortened tool result names its own id, `r<n>`. ' +
    'Pass `id` for the original messages of a part (long tool inputs and results clipped; `message: n` returns message n in full, `full: true` the whole part) or for a tool result in full. ' +
    'Pass `query` to search every folded part of this session for words, names or paths; with `id`, only that fold.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'A fold id: f12 or r87.' },
      message: { type: 'integer', description: 'With a part id: the index of one message to return in full.' },
      full: { type: 'boolean', description: 'With a part id: nothing clipped.' },
      query: { type: 'string', description: 'Words, names or paths to search for.' },
    },
  },
  isDeferred: false,
} as const;

/** A fold as stored in `<dir>/<id>.json`. */
export type FoldEntry =
  | {
      id: string;
      kind: 'part';
      /** ISO time of the fold. */
      at: string;
      /** The part's index line, without its id. */
      line: string;
      /**
       * The part's messages with the `Message` fields only. A tool use is stored
       * without `text` and `isError` when the part holds that call's result.
       */
      messages: Message[];
    }
  | {
      id: string;
      kind: 'result';
      at: string;
      tool: string;
      input: Record<string, unknown>;
      /** The result's original text. */
      text: string;
      isError: boolean;
    };

/** One slice of the part being folded. */
export interface FoldSegment {
  /** `S01`, `S02`, ... in order: the key the summary model answers with. */
  key: string;
  start: number;
  /** Index after the segment's last message. */
  end: number;
  /** The request that opens the segment's turn, at most 200 characters; '' before the first request. */
  request: string;
  /** The segment continues the turn of the one before it. */
  continued: boolean;
}

export interface FoldInput {
  /** The part to fold as the session holds it: what the folds store. */
  older: readonly Message[];
  /** The same messages, old tool results shortened: what the summary model reads. Same length as `older`. */
  reading: readonly Message[];
  store: FoldStore;
  /** The session's fold folder (`foldDir`). */
  dir: string;
  /** What the summary model is told before the conversation. */
  instructions: string;
  /** Asks the summary model; undefined when it did not answer. */
  complete: (system: string, prompt: string) => Promise<string | undefined>;
  /** The time written in the folds. */
  at: string;
}

export interface FoldOutcome {
  /** The STATE section the model wrote; '' when it did not answer or wrote none. */
  state: string;
  /** The index note (`foldNote`): the lines carried from earlier folds, then the new ones. */
  note: string;
  /** The ids written, in order. */
  ids: string[];
}

/** `<root>/<sessionId>`, every character of the id outside `[A-Za-z0-9_-]` replaced by `_`. */
export type FoldDir = (root: string, sessionId: string) => string;

/** `<dir>/<id>.json`. */
export type FoldPath = (dir: string, id: string) => string;

/** The next free number per kind: 1 + the highest `f<n>.json` and `r<n>.json` among `names`, 1 when none. */
export type NextFoldNumbers = (names: readonly string[]) => { f: number; r: number };

/**
 * One segment per turn (`segmentTurns(messages, 0)`), after one for the
 * messages before the first request when there are any (request ''). With no
 * request at all, one segment holds everything. A segment longer than
 * `maxChars` (by `messageChars`) is split: a new one starts at an assistant
 * message that follows a user message, once the current one holds at least
 * `maxChars`; it has `continued: true` and the same request. The segments
 * cover every message once, in order; none for no messages.
 */
export type SegmentFold = (messages: readonly Message[], maxChars?: number) => FoldSegment[];

/**
 * `instructions`, a blank line, then `<conversation>` ... `</conversation>`
 * holding, per segment, the header `=== <key>: <request> ===` (`=== <key> ===`
 * without a request; ` (continues)` after the request of a continued one) and
 * `renderTranscript(reading.slice(start, end))`, so message indexes restart
 * at 0 in each segment. When the whole exceeds `FOLD_PROMPT_CHARS`, every
 * segment is rendered again with `limit = floor(FOLD_PROMPT_CHARS / segments.length)`.
 */
export type FoldPrompt = (instructions: string, segments: readonly FoldSegment[], reading: readonly Message[]) => string;

/**
 * `state`: the text between the STATE header and the PARTS header, trimmed;
 * text after `STATE:` on the header's own line belongs to it. `lines[key]`:
 * after PARTS, each line `<key>: <line>` whose key is in `keys`; the first
 * one wins, whitespace runs become one space, the line is cut to
 * `FOLD_LINE_CHARS` with `truncate`. Headers match at a line start in any
 * case, with `#`, `*` and spaces around them and an optional colon; a key may
 * come after `- ` and inside `*` or backticks. Without PARTS everything after
 * STATE is the state; without STATE the state is ''.
 */
export type ParseFoldReply = (text: string, keys: readonly string[]) => { state: string; lines: Record<string, string> };

/**
 * The full lines (`f<n> · <line>`) of earlier fold notes: every line matching
 * `/^f[1-9]\d* · /` in the messages whose text starts with `FOLD_NOTE_HEAD`,
 * in order, each id once.
 */
export type CarriedLines = (messages: readonly Message[]) => string[];

/**
 * The index note, '' when there is no line at all:
 * `${FOLD_NOTE_HEAD}: the earlier conversation is stored outside the context, one line per part, oldest first. Call ${UNFOLD_TOOL_NAME} with an id for the original messages, or with a query to search them.`
 * then the carried lines and one `<id> · <line>` per added fold.
 */
export type FoldNote = (carried: readonly string[], added: readonly { id: string; line: string }[]) => string;

/** Writes each entry to `foldPath(dir, entry.id)` as JSON indented by 2, all at once; rejects when one fails. */
export type WriteFolds = (store: FoldStore, dir: string, entries: readonly FoldEntry[]) => Promise<void>;

/**
 * Folds `older`: `carriedLines(older)`, `segmentFold(older)`, the next `f`
 * number from `store.list(dir)`, one request to `complete(FOLD_SYSTEM,
 * foldPrompt(...))`, then one `part` entry per segment, ids ascending, written
 * with `writeFolds`. A segment the model gave no line for takes its request
 * cut to 200 characters, `(continues) ` before it when continued, or
 * `earlier summary and notes` without a request. Rejects when a write fails.
 * No segment: nothing is asked or written, the note holds the carried lines.
 */
export type FoldOlder = (input: FoldInput) => Promise<FoldOutcome>;

/**
 * Gives every shortened tool result of `output` a fold id. A result counts
 * when its text ends with `RERUN_HINT` (src/compact.ts) and differs from the
 * text the same `tool_use_id` has in `input`; so does the `text` of the tool
 * use that mirrors it. Ids are `r<start>`, `r<start + 1>`, ... in order of
 * first appearance, one per `tool_use_id`. The trailing `RERUN_HINT` becomes
 * `; full text: ${UNFOLD_TOOL_NAME} id <id>]`. Each id gets a `result` entry
 * with the original text and `isError` from `input` and the tool name and
 * input of its tool use there ('' and {} when `input` holds no such use).
 * A message with nothing to point is returned as the same object; a changed
 * one is a shallow copy with its changed blocks copied.
 */
export type PointResults = (
  input: readonly Message[],
  output: readonly Message[],
  start: number,
  at: string,
) => { messages: Message[]; entries: FoldEntry[] };

/** The stored fold; undefined when the file is missing, is not JSON or has no `kind` of `part` or `result`. */
export type ReadFold = (store: FoldStore, dir: string, id: string) => Promise<FoldEntry | undefined>;

/** Every readable fold of `dir` whose file name is `<FOLD_ID>.json`. */
export type ListFolds = (store: FoldStore, dir: string) => Promise<FoldEntry[]>;

export interface FoldHit {
  id: string;
  /** Index of the message inside a part; absent for a result fold. */
  message?: number;
  score: number;
  snippet: string;
}

/**
 * Terms: `query` lowercased and split on whitespace, each once. Units: every
 * message of a part (its text, each tool input as JSON and each tool result
 * text, joined by newlines) and the text of a result fold. A unit scores one
 * per term it contains (case-insensitive substring), plus one when the query
 * has several terms and the unit contains it whole; units scoring 0 are left
 * out. Order: score descending, then higher fold number, then lower message
 * index; at most `limit` (default `SEARCH_HITS`). Snippet: `SNIPPET_CHARS`
 * characters on each side of the first occurrence of the whole query, else of
 * the first term found, whitespace runs as one space, `…` at a cut end.
 */
export type SearchFolds = (entries: readonly FoldEntry[], query: string, limit?: number) => FoldHit[];

export interface UnfoldAnswer {
  text: string;
  isError: boolean;
  /** Search hits; 1 for a fold read back, 0 for an error. */
  hits: number;
}

/**
 * Answers a call of the unfold tool; `input` is its arguments, unchecked.
 * - No string `id` and no non-blank string `query`: error `Pass an id (f12, r87) or a query.`
 * - `id` outside `FOLD_ID`, or no such fold: error `No fold <id> in this session.`
 * - `query`: `searchFolds` over the fold `id` when given, else over
 *   `listFolds`. One block per hit, `<id> [<message>] <snippet>` (`<id> <snippet>`
 *   for a result fold), a blank line between, then the line
 *   `Call again with an id (and message: n) for the full text.` No hit:
 *   `Nothing folded in this session matches "<query>".`, 0 hits, not an error.
 * - A part id: the line `<id> · <line>`, then its messages rendered with
 *   `renderMessage(message, index, UNFOLD_PART_CHARS)`, a blank line between,
 *   as many as stay within `UNFOLD_CHARS` (always the first); when some are
 *   left out, a last line `[messages <a>–<b> not shown: ask for one with message: n]`.
 *   `full: true`: no part cap and `UNFOLD_FULL_CHARS`. `message: n`, an
 *   integer in range: that message alone, no part cap; else error
 *   `Fold <id> has messages 0–<last>.`
 * - A result id: `<id> · <tool> <input as JSON, cut to 200 with truncate>`,
 *   then the text; beyond `UNFOLD_FULL_CHARS` it ends with ` […<n> chars cut]`.
 */
export type Unfold = (input: unknown, store: FoldStore, dir: string) => Promise<UnfoldAnswer>;

/** Start of the note that stands for a closed turn's steps; `[fast-jev-compaction] ` makes it a notice, never a request. */
export const TURN_NOTE_HEAD = '[fast-jev-compaction] Steps of this turn folded';
/** A closed turn is folded when its steps hold at least these characters (`messageChars`). */
export const TURN_FOLD_MIN_CHARS = 20_000;
/** Most call lines a turn note lists; the calls beyond them are counted in one last line. */
export const TURN_NOTE_CALLS = 30;
/** Longest call line of a turn note, the `- ` included. */
export const TURN_CALL_CHARS = 160;

/** The steps of the turn that just closed: `messages[start..end)`. */
export interface TurnSteps {
  /** Index after the message that opens the turn. */
  start: number;
  /** Index of the first message of the closing answer. */
  end: number;
  /** `messageChars` of the steps, summed. */
  chars: number;
}

/**
 * The steps of the last turn, when it is closed and ran tools. The closing
 * answer is the run of assistant messages without tool uses that ends the
 * list (at least one); the message before it must be a user message with
 * tool results, and `end` is the index after that one. `start` is the index
 * after the nearest user message before `end` that holds no tool result
 * (`toolResults` absent or empty). Undefined when the list does not end
 * that way or holds no such user message.
 */
export type ClosedTurnSteps = (messages: readonly Message[]) => TurnSteps | undefined;

/**
 * The note that takes the steps' place. First line:
 * `${TURN_NOTE_HEAD} (<id>): <calls> tool calls, <chars> characters, stored outside the context. Call ${UNFOLD_TOOL_NAME} with id <id> for the original messages.`
 * Then one line per tool use, in order, at most `TURN_NOTE_CALLS`:
 * `- <tool> <brief>`, cut to `TURN_CALL_CHARS` with `truncate`, then
 * ` → <n> chars` when the steps hold that call's result (`n` its text length)
 * and `, error` when the result is one. `<brief>` is the first string among
 * the input's `file_path`, `path`, `command`, `pattern`, `query`, `url`,
 * `description`, `prompt`, else the input as JSON; whitespace runs become
 * one space. Calls beyond the cap: a last line `… and <n> more calls`.
 * Numbers are written without separators.
 */
export type TurnNote = (id: string, steps: readonly Message[]) => string;

export interface TurnFoldInput<M extends Message> {
  messages: readonly M[];
  store: FoldStore;
  /** The session's fold folder (`foldDir`). */
  dir: string;
  /** The time written in the fold. */
  at: string;
  /** Absent: `TURN_FOLD_MIN_CHARS`. */
  minChars?: number;
  /** Builds the user message that carries these tool results, in this order. */
  result: (results: readonly ToolResult[]) => M;
}

export interface TurnFoldOutcome<M extends Message> {
  /**
   * `messages[0..first]` as the same objects, `first` being the first step
   * that holds tool uses; then the message `result` built; then
   * `messages[end..]` as the same objects.
   */
  messages: M[];
  /** The fold written: `f<n>`, the next free number in `dir`. */
  id: string;
  start: number;
  end: number;
  chars: number;
  /** Tool uses in the steps. */
  calls: number;
}

/**
 * Folds the closed turn's steps in place: nothing before them changes.
 * The turn keeps its first call, so the conversation still shows that the
 * answer came from tool work (with every call gone, the model was seen to
 * answer the next request without calling any). That call's message stays
 * as it is: the request is then followed by the message it was followed by,
 * and the prompt cache reaches it (measured). Every other step goes.
 * The message built by `result` answers each tool use of the kept message,
 * in order, none an error: the first with `turnNote(id, steps)`, each other
 * with `${TURN_NOTE_HEAD} (<id>): see the first result of this message.`
 * Undefined, with nothing written, when `closedTurnSteps` finds none, when
 * they hold fewer than `minChars`, or when no step holds a tool use. The
 * fold is a `part` entry with every step: `messages` from `storedMessages`,
 * `line` `steps of the turn "<request>": <calls> tool calls` with
 * `<request>` the text of `messages[start - 1]` on one line, cut to 200
 * characters with `truncate`. A failed write rejects.
 */
export type FoldTurn = <M extends Message>(input: TurnFoldInput<M>) => Promise<TurnFoldOutcome<M> | undefined>;
