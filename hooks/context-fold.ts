import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolSpec,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, messageChars, reductionRatio, resolveOptions, shortenResults } from '../src/compact.js';
import { foldDir, foldOlder, nextFoldNumbers, pointResults, writeFolds } from '../src/fold.js';
import { TURN_FOLD_MIN_CHARS, TURN_NOTE_HEAD, UNFOLD_TOOL, UNFOLD_TOOL_NAME, type FoldStore } from '../src/fold-spec.js';
import { closedTurnSteps, foldTurn } from '../src/turn-fold.js';
import { unfold } from '../src/unfold.js';
import { modelTopicAsker, olderPartCut, planTopics, summaryInstructions, touchedFiles, type TouchedFiles } from '../src/plan.js';
import { collectToolCalls, fitState, latestRequest, recentRequests } from '../src/state.js';
import { pickRules, ruleUnits, rulesNote, rulesQuestion } from '../src/rules.js';
import { compactionLog, logPath, type CompactionLog } from './log.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 0,
  minReductionRatio: 0.25,
  smallContextChars: 100_000,
  summarizeShare: 0.75,
  summaryModel: 'haiku',
  model: DEFAULT_MODEL,
  useJev: false,
  foldTurns: false,
  foldTurnMinChars: TURN_FOLD_MIN_CHARS,
  resumeAfterCompact: true,
  decisionLog: false,
};

/** Opens the message that stands for the folded part; its first words mark it as a notice, never a request. */
const FOLD_INTRO =
  'This session is being continued from an earlier conversation. The earlier part is folded: its state is below, the "Folded parts" note lists what it held, and the newer messages follow verbatim.\n\n';
/** The reply cap of a fold. */
const SUMMARY_MAX_TOKENS = 16_000;
/** After a 402 (no credit) Jev is skipped for this long: every call would fail the same way. */
const JEV_PAUSE_MS = 60 * 60 * 1000;
/** Until when Jev is skipped; 0 when it is in use. */
let jevPausedUntil = 0;
/** Pauses Jev when `error` says the organization has no credit left. */
function pauseOnNoCredit(error: unknown): void {
  if (error instanceof Error && error.message.includes('(402)')) jevPausedUntil = Date.now() + JEV_PAUSE_MS;
}

export { renderTranscript } from '../src/render.js';

/** The prompt submitted after an automatic compaction, so the work goes on unattended. */
export const RESUME_PROMPT =
  'The context was just compacted. Continue the task from where you left off, without asking the user to confirm. If the task was already finished and you were waiting for the user, reply with one short line.';

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  /** At or below these characters the shortened results stand, however little they cut: no summary runs. */
  smallContextChars: number;
  /** Share of the text the built-in summarizer gets when no topic is finished. */
  summarizeShare: number;
  /** The model that writes summaries (`haiku`, `sonnet`, a full id); empty: the built-in compact. */
  summaryModel: string;
  model: string;
  /** Asks Jev for the cut, the results to shorten and the rules to re-add; off, the summary model and fixed rules do it. */
  useJev: boolean;
  /** Folds a turn's tool steps in place when it closes: the messages before them stay as they are, and so does their prompt cache. */
  foldTurns: boolean;
  /** A closed turn is folded when its steps hold at least these characters. */
  foldTurnMinChars: number;
  resumeAfterCompact: boolean;
  /** Writes one JSON record per compaction under `logDir`. */
  decisionLog: boolean;
  /** Absent: `~/.claude/context-fold/logs`. */
  logDir?: string;
  /** Rule files re-added after a summary, relative to the project root; `dir/*.md` takes a folder's files. */
  rulesFiles: string[];
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'topicThreshold',
    'lastingThreshold',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  if (typeof options.pruneTopics === 'boolean') numbers.pruneTopics = options.pruneTopics;
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    smallContextChars: optionNumber(options, 'smallContextChars', HOOK_DEFAULTS.smallContextChars),
    summarizeShare: optionNumber(options, 'summarizeShare', HOOK_DEFAULTS.summarizeShare),
    summaryModel: optionString(options, 'summaryModel') ?? HOOK_DEFAULTS.summaryModel,
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    useJev: typeof options['useJev'] === 'boolean' ? options['useJev'] : HOOK_DEFAULTS.useJev,
    foldTurns: typeof options['foldTurns'] === 'boolean' ? options['foldTurns'] : HOOK_DEFAULTS.foldTurns,
    foldTurnMinChars: optionNumber(options, 'foldTurnMinChars', HOOK_DEFAULTS.foldTurnMinChars),
    resumeAfterCompact:
      typeof options['resumeAfterCompact'] === 'boolean'
        ? options['resumeAfterCompact']
        : HOOK_DEFAULTS.resumeAfterCompact,
    decisionLog:
      typeof options['decisionLog'] === 'boolean'
        ? options['decisionLog']
        : HOOK_DEFAULTS.decisionLog,
    rulesFiles: (optionString(options, 'rulesFiles') ?? '')
      .split(/[,\n]/)
      .map((f) => f.trim())
      .filter(Boolean),
  };
  const logDir = optionString(options, 'logDir');
  if (logDir) config.logDir = logDir;
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** The rule files' texts; a `dir/*.md` entry lists the folder. A file that cannot be read is skipped. */
async function readRuleFiles(
  fs: { read: (path: string) => Promise<unknown>; list: (path: string) => Promise<readonly { name: string; kind: string }[]> },
  root: string,
  entries: readonly string[],
): Promise<{ file: string; text: string }[]> {
  const files: string[] = [];
  for (const entry of entries) {
    const star = entry.match(/^(.*?)\/?\*(\.\w+)?$/);
    if (!star) { files.push(entry); continue; }
    const dir = star[1] ?? '';
    const listed = await fs.list(`${root}/${dir}`).catch(() => []);
    for (const e of [...listed].sort((a, b) => a.name.localeCompare(b.name)))
      if (e.kind === 'file' && (!star[2] || e.name.endsWith(star[2]))) files.push(dir ? `${dir}/${e.name}` : e.name);
  }
  const read = await Promise.all(
    [...new Set(files)].map(async (file) => {
      const text = await fs.read(`${root}/${file}`).catch(() => undefined);
      return typeof text === 'string' ? { file, text } : undefined;
    }),
  );
  return read.filter((f): f is { file: string; text: string } => f !== undefined);
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const send = () =>
        fetchFn(request.url, { method: request.method, headers: request.headers, body: request.body });
      // One retry for a dropped connection or a server error.
      let response: HookFetchResponse;
      try {
        response = await send();
        if (response.status >= 500) response = await send();
      } catch {
        response = await send();
      }
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

/**
 * The files the summarized part used, one per line as `<path> <name> "<action>"`:
 * the summary may drop them, this list stays, so the model knows what to re-read.
 */
export function filesNote(files: TouchedFiles): string {
  const lines = [
    ...files.written.map((path) => [path, 'write'] as const),
    ...files.read.map((path) => [path, 'read'] as const),
    ...files.mentioned.map((path) => [path, 'mentioned'] as const),
  ].map(([path, action]) => `${path} ${path.split('/').pop() ?? path} "${action}"`);
  if (lines.length === 0) return '';
  return `[context-fold] Files used in the summarized part of the conversation (re-read any you need):\n${lines.join('\n')}`;
}

/** The reply-language rule of the `language` setting, or '' when it is not set. */
export function languageNote(language: unknown): string {
  if (typeof language !== 'string' || !language.trim()) return '';
  return `[context-fold] Always respond in ${language.trim()}, short status lines between tool calls included.`;
}

/**
 * `messages` with `note` as a user message near the end: last, or before a
 * closing assistant message with tool calls (its results must follow it).
 */
export function withNote(messages: readonly SessionMessage[], note: string): SessionMessage[] {
  const message = { role: 'user', text: note, toolUses: [] } as unknown as SessionMessage;
  const last = messages[messages.length - 1];
  const at = last && last.role === 'assistant' && last.toolUses.length > 0 ? messages.length - 1 : messages.length;
  return [...messages.slice(0, at), message, ...messages.slice(at)];
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

/** The toast line: what changed for the person, in one short sentence. */
export function headline(result: CompactResult): string {
  const { stats } = result;
  return `${stats.messagesBefore} → ${stats.messagesAfter} messages, context −${percent(reductionRatio(result))} (${stats.resultsDropped} tool results shortened)`;
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * Shows the outcome as a toast only: the transcript stays free of compaction
 * notices. The host draws it under the plugin's name, so the text leaves it out.
 */
function notify(
  $: { ui: { toast: (text: string, options?: { timeoutMs?: number }) => void } },
  text: string,
): void {
  $.ui.toast(text, { timeoutMs: 10_000 });
}

/** A user message the plugin writes. */
const userMessage = (text: string) => ({ role: 'user', text, toolUses: [] }) as unknown as SessionMessage;

/** A user message the plugin writes to answer tool calls. */
const resultsMessage = (results: readonly ToolResult[]) =>
  ({ role: 'user', text: '', toolUses: [], toolResults: results.map(toolResultSummary) }) as unknown as SessionMessage;

/** The engine's file system as a fold store. */
export function foldStore($: {
  fs: {
    read: (path: string) => Promise<unknown>;
    write: (path: string, text: string) => Promise<unknown>;
    list: (path: string) => Promise<readonly { name: string; kind: string }[]>;
  };
}): FoldStore {
  return {
    read: (path) => $.fs.read(path).then((text) => (typeof text === 'string' ? text : undefined), () => undefined),
    write: async (path, text) => {
      await $.fs.write(path, text);
    },
    list: (dir) => $.fs.list(dir).then((entries) => entries.filter((e) => e.kind === 'file').map((e) => e.name), () => []),
  };
}

type HomeHost = { env: { get: (name: string) => Promise<string | undefined> }; session: { id: () => Promise<string> } };

/** The folder of this session's folds: the session id comes from the engine, never from the model. */
async function sessionFolds($: HomeHost): Promise<string> {
  return foldDir(`${await $.env.get('HOME')}/.claude/context-fold/folds`, await $.session.id());
}

/** Whether the unfold tool is registered in this process. */
let unfoldReady = false;
/** Registers the unfold tool once, when the session has or gets its first fold; false when the engine refuses. */
async function ensureUnfold($: { tool: { register: (tool: ToolSpec) => Promise<unknown> } }): Promise<boolean> {
  if (!unfoldReady) unfoldReady = await $.tool.register(UNFOLD_TOOL).then(() => true, () => false);
  return unfoldReady;
}

/** How long a turn fold asked through the `/compact` command waits for the compaction to start. */
const TURN_FOLD_WAIT_MS = 10_000;

/** What one request read from the prompt cache, wrote to it and sent uncached, in tokens. */
type CacheTokens = { read: number; written: number; input: number };
type LogHost = HomeHost & { fs: { write: (path: string, text: string) => Promise<unknown> } };

/** Where the decision log is written. */
async function logDirOf($: HomeHost, config: HookConfig): Promise<string> {
  return config.logDir ?? `${await $.env.get('HOME')}/.claude/context-fold/logs`;
}

/** Writes one record of the decision log; a failed write changes nothing. */
async function logEntry($: LogHost, config: HookConfig, entry: { at: string; sessionId: string; trigger: string } & Record<string, unknown>): Promise<void> {
  await $.fs.write(logPath(await logDirOf($, config), entry), `${JSON.stringify(entry, null, 2)}\n`).catch(() => undefined);
}

export type Precomputed = { input: readonly SessionMessage[]; output: SessionMessage[] };

/**
 * The precomputed compaction applied to `messages`: its output plus every
 * message that came after its input, or undefined when `messages` no longer
 * opens with that input, matched by engine handle.
 */
export function reusePrecomputed(
  precomputed: Precomputed | undefined,
  messages: readonly SessionMessage[],
): SessionMessage[] | undefined {
  if (!precomputed) return undefined;
  const { input, output } = precomputed;
  const opens =
    input.length > 0 &&
    input.length <= messages.length &&
    input.every((m, i) => m.handle !== undefined && m.handle === messages[i]!.handle);
  return opens ? [...output, ...messages.slice(input.length)] : undefined;
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  /** The main conversation's last precomputed compaction: its input and its output. */
  let precomputed: Precomputed | undefined;
  /** The turn fold `turn.complete` asked for: how, and until when the request stands. */
  let turnFold: { until: number; via: 'engine' | 'command' } | undefined;
  /**
   * True once the engine refused `$.session.compact()`: a headless (SDK) session, the desktop app's
   * included, compacts only through the `/compact` command, which the plugin then runs itself.
   */
  let viaCommand = false;
  /** The cache tokens of the main loop's last request. */
  let lastCache: CacheTokens | undefined;
  /** Set by a compaction: the next request's cache tokens are logged against it. */
  let cacheWatch: { after: string; before?: CacheTokens } | undefined;
  on('session.start', async ($, event, next) => {
    // A resumed session has folds already: the tool is there from the first prompt.
    // With turn folds on it is there from the start too: a tool added later rewrites the whole prompt cache.
    try {
      if (configured.foldTurns || (await foldStore($).list(await sessionFolds($))).length > 0) await ensureUnfold($);
    } catch {
      // No folder to read: the tool is registered at the first fold.
    }
    return next(event);
  });

  on('tool.call', { tool: UNFOLD_TOOL_NAME }, async ($, event) => {
    const answer = await unfold(event, foldStore($), await sessionFolds($));
    if (configured.decisionLog) {
      // A search with no hit is the sign the index lines are not enough.
      await logEntry($, configured, { at: new Date().toISOString(), sessionId: await $.session.id(), trigger: 'unfold', id: event['id'], query: event['query'], hits: answer.hits, isError: answer.isError });
    }
    return answer.isError ? { deny: answer.text } : { result: answer.text };
  });

  on('session.compact', async ($, event, next) => {
    // A subagent's compaction goes to the engine as it is.
    if (event.agentId !== undefined) return next(event);
    // The steps of the turn that just closed, folded in place: every message before them is handed back
    // as the engine has it, so the prompt cache of that prefix stands and only the tail is written again.
    // The command reaches this hook as a manual compaction: it is the plugin's own when it carries no
    // instructions and comes within the wait. It folds the turn or is skipped, and never goes on to a
    // full compaction: one at every turn end would cost the whole conversation.
    const asked = turnFold;
    if (asked && (event.trigger === 'plugin' || event.trigger === 'manual') && !event.instructions?.trim() && Date.now() <= asked.until) {
      turnFold = undefined;
      const at = new Date().toISOString();
      try {
        const folded = (await ensureUnfold($))
          ? await foldTurn({ messages: event.messages as readonly SessionMessage[], store: foldStore($), dir: await sessionFolds($), at, minChars: configured.foldTurnMinChars, result: resultsMessage })
          : undefined;
        if (!folded) return { skip: 'no closed turn to fold' };
        cacheWatch = { after: 'turn-fold', ...(lastCache ? { before: lastCache } : {}) };
        if (configured.decisionLog) {
          const { id, start, end, chars, calls } = folded;
          await logEntry($, configured, { at, sessionId: await $.session.id(), trigger: 'turn-fold', via: asked.via, id, start, end, chars, calls, messagesBefore: event.messages.length, messagesAfter: folded.messages.length });
        }
        return { messages: folded.messages };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (configured.decisionLog) await logEntry($, configured, { at, sessionId: await $.session.id(), trigger: 'turn-fold-error', via: asked.via, error: reason });
        return { skip: `turn fold not written (${reason})` };
      }
    }
    // The text after `/compact` is the next prompt: it runs once the compaction stands.
    const followUp =
      event.trigger === 'manual' && event.agentId === undefined ? event.instructions?.trim() : undefined;
    const outcome = await (async () => {
      const isMain = event.agentId === undefined;
      const isPrecompute = event.trigger === 'precompute';
      const record = async (
        log: Pick<Parameters<typeof compactionLog>[0], 'outcome' | 'note'>,
        result?: CompactResult,
        after?: number,
        extra?: Partial<CompactionLog>,
      ) => {
        if (!configured.decisionLog) return;
        try {
          const entry: CompactionLog = compactionLog(
            {
              ...log,
              sessionId: await $.session.id(),
              trigger: event.trigger,
              messages: event.messages,
              preserveRecentMessages: resolveOptions(configured).preserveRecentMessages,
            },
            result,
            after,
          );
          Object.assign(entry, extra);
          await $.fs.write(logPath(await logDirOf($, configured), entry), `${JSON.stringify(entry, null, 2)}\n`);
        } catch {
          // The log is a diagnostic: a failed write never changes the compaction.
        }
      };

      // The engine compacts what was precomputed, plus what came after: answer at once.
      const reused = isMain && !isPrecompute ? reusePrecomputed(precomputed, event.messages) : undefined;
      if (reused) {
        precomputed = undefined;
        notify($, `${event.messages.length} → ${reused.length} messages, from the precomputed compaction`);
        await record({ outcome: 'reused' }, undefined, reused.length);
        return { messages: reused };
      }
      // A new precompute replaces the last one, whatever it comes to.
      if (isMain && isPrecompute) precomputed = undefined;
      if (!isPrecompute) $.ui.status('Compacting the context…');
      try {
        // Jev is asked only when it is switched on, has a key and is not paused.
        const key = configured.useJev && Date.now() >= jevPausedUntil ? await getApiKey($, configured) : undefined;
        const config = { ...configured, apiKey: key };
        const store = foldStore($);
        const dir = await sessionFolds($);
        const at = new Date().toISOString();
        const fetchFn: HookFetch = async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        };
        let planned: Partial<CompactionLog> | undefined;
        /** Where the older part ends: results before it are shortened without Jev, and it is what is folded when no topic is finished. */
        const olderCut = olderPartCut(event.messages, config.summarizeShare, resolveOptions(config).preserveRecentMessages, messageChars);
        const shortenLocally = (): SessionCompaction => {
          // With no older part to tell (its end falls among the newest messages), every result before those goes.
          const result = shortenResults(event.messages, olderCut || event.messages.length, config);
          return { result, messages: toSessionMessages(event.messages, result.messages) };
        };
        /** Old tool results shortened, every call and text kept; computed once. Jev picks them when it is on and answers. */
        let shortening: Promise<SessionCompaction> | undefined;
        const shorten = () =>
          (shortening ??= config.apiKey
            ? compactSession(event.messages, { ...config, resultsOnly: true }, fetchFn).catch((error: unknown) => {
                pauseOnNoCredit(error);
                return shortenLocally();
              })
            : Promise.resolve().then(shortenLocally));
        /** The shortened results stored as folds, each note naming its id; as they are when that fails. */
        const pointed = async (messages: SessionMessage[]): Promise<SessionMessage[]> => {
          try {
            if (!(await ensureUnfold($))) return messages;
            const { r } = nextFoldNumbers(await store.list(dir));
            const out = pointResults(event.messages, messages, r, at);
            await writeFolds(store, dir, out.entries);
            return out.messages as unknown as SessionMessage[];
          } catch {
            return messages;
          }
        };
        /** The rules note for these messages and the picked units, or none when no rule file is set or readable. */
        const rulesFor = async (messages: readonly SessionMessage[]): Promise<{ note: string; picked?: string[] }> => {
          if (config.rulesFiles.length === 0) return { note: '' };
          try {
            const root = await $.session.root();
            const units = ruleUnits(await readRuleFiles({ read: (path) => $.fs.read(path), list: (path) => $.fs.list(path) }, root, config.rulesFiles));
            if (units.length === 0) return { note: '' };
            const questions = rulesQuestion(units);
            let picked: ReturnType<typeof pickRules> = [];
            if (config.apiKey && Object.keys(questions).length > 0) {
              const all = messages as unknown as readonly Message[];
              const options = resolveOptions(config);
              const goal = recentRequests(all, 200, 1000);
              const state = fitState(all, collectToolCalls(all, options.preserveRecentMessages), { ...options, goal });
              const answer = await jevAsker(fetchFn, config.apiKey, config.model)
                .ask(state.state, questions)
                .catch(() => undefined);
              if (answer) picked = pickRules(answer.answers, units);
            }
            return { note: rulesNote(units, picked), picked: picked.map((u) => `${u.file} › ${u.title}`) };
          } catch {
            return { note: '' };
          }
        };
        /**
         * Folds `messages[0..cut)`: the original messages go to disk, a short state and one
         * line per part take their place, the rest stays as it is.
         */
        const foldPart = async (cut: number, what: string, extra: Partial<CompactionLog> = {}) => {
          const older = event.messages.slice(0, cut);
          // The summary model reads the shortened results: less to read, same calls and texts.
          const reading = await shorten().then(
            (s) => (s.messages.length === event.messages.length ? s.messages.slice(0, cut) : older),
            () => older,
          );
          const ref = event.instructions?.trim() || latestRequest(event.messages, 1000);
          const files = touchedFiles(older);
          const total = event.messages.reduce((sum, m) => sum + messageChars(m), 0);
          const share = total > 0 ? older.reduce((sum, m) => sum + messageChars(m), 0) / total : 0;
          const started = Date.now();
          // The project rules the next steps need, read while the fold is written.
          const rules = rulesFor(event.messages);
          const instructions = summaryInstructions(ref, files);
          let outputTokens: number | undefined;
          const complete = async (system: string, prompt: string): Promise<string | undefined> => {
            if (!config.summaryModel) return undefined;
            $.ui.status(`${config.summaryModel} is folding the messages ${what}…`);
            const reply = await $.model
              .complete({ model: config.summaryModel, system, prompt, maxTokens: SUMMARY_MAX_TOKENS, effort: 'low', timeoutMs: 120_000 })
              .catch(() => undefined);
            outputTokens = reply?.usage.output_tokens;
            return reply?.isAnswered && reply.text.trim() ? reply.text : undefined;
          };
          // Without the tool or the folder nothing could be read back: the built-in summary stands alone.
          const fold = (await ensureUnfold($))
            ? await foldOlder({ older, reading, store, dir, instructions, complete, at }).catch(() => undefined)
            : undefined;
          let summarized: { messages?: readonly SessionMessage[] } | undefined;
          let model = 'built-in';
          if (fold?.state) {
            model = config.summaryModel;
            summarized = { messages: [userMessage(FOLD_INTRO + fold.state)] };
          } else {
            // The summary model wrote no state: the built-in summarizer writes it, the index lines stay.
            $.ui.status(`Claude is summarizing the messages ${what}…`);
            summarized = await next({ ...event, messages: reading as typeof older, instructions });
          }
          if (!summarized.messages) return undefined;
          const { note: rulesText, picked } = await rules;
          const messages = [
            ...summarized.messages,
            ...[fold?.note ?? '', filesNote(files), rulesText].filter(Boolean).map(userMessage),
            ...event.messages.slice(cut),
          ];
          const parts = fold ? `folded into ${fold.ids.length} parts` : 'summarized';
          notify($, `${older.length} messages ${what} ${parts} by ${model} in ${Math.round((Date.now() - started) / 1000)} s, ${event.messages.length - cut} kept as they are`);
          await record(
            { outcome: 'summarized', note: `${what}: ${older.length} of ${event.messages.length} messages ${parts} (${percent(share)} of the text)` },
            undefined,
            messages.length,
            {
              ...extra,
              reference: ref,
              cut,
              obsoleteShare: Math.round(share * 100) / 100,
              files,
              summarizedChars: reading.reduce((sum, m) => sum + messageChars(m), 0),
              summaryModel: model,
              summaryMs: Date.now() - started,
              summaryOutputTokens: outputTokens,
              rulesPicked: picked,
              folds: fold?.ids,
            },
          );
          return { messages };
        };
        // Finished topics are folded, alone; the rest stays as it is.
        // Without Jev (no key, no credit, no answer) the summary model picks the cut.
        const summaryModel = config.summaryModel;
        if (!isPrecompute && config.pruneTopics !== false && (config.apiKey || summaryModel)) {
          const reference = event.instructions?.trim() ?? '';
          const empty = { cut: 0, turns: [], stateTokens: 0, stateStage: '' };
          const viaModel = () =>
            summaryModel
              ? planTopics(
                  event.messages,
                  modelTopicAsker(async (prompt) => {
                    $.ui.status(`${summaryModel} is looking for finished topics…`);
                    const reply = await $.model.complete({ model: summaryModel, prompt, maxTokens: 50, effort: 'low', timeoutMs: 30_000 });
                    if (!reply.isAnswered) throw new Error(reply.reason);
                    return reply.text;
                  }, reference || latestRequest(event.messages, 1000)),
                  resolveOptions(config),
                  reference,
                )
              : Promise.resolve(empty);
          // A failed plan only means nothing is summarized: the results path still runs.
          const plan = await (config.apiKey
            ? planTopics(event.messages, jevAsker(fetchFn, config.apiKey, config.model), resolveOptions(config), reference).catch(
                (error: unknown) => {
                  pauseOnNoCredit(error);
                  return viaModel();
                },
              )
            : viaModel()
          ).catch(() => empty);
          const obsolete = event.messages.slice(0, plan.cut);
          const total = event.messages.reduce((sum, m) => sum + messageChars(m), 0);
          const share = total > 0 ? obsolete.reduce((sum, m) => sum + messageChars(m), 0) / total : 0;
          const ref = reference || latestRequest(event.messages, 1000);
          const files = touchedFiles(obsolete);
          planned = { reference: ref, cut: plan.cut, obsoleteShare: Math.round(share * 100) / 100, turns: plan.turns, files };
          if (plan.cut > 0 && share >= config.minReductionRatio) {
            const done = await foldPart(plan.cut, 'on finished topics', planned);
            if (done) return done;
          }
        }
        // Nothing finished to fold: only old tool results are shortened.
        const { result, messages } = await shorten();
        // A small context keeps its shortened results: a fold there costs time and saves little.
        const small = result.stats.charsBefore <= config.smallContextChars && reductionRatio(result) > 0;
        if (!small && reductionRatio(result) < config.minReductionRatio) {
          const note = `below ${percent(config.minReductionRatio)} minimum: ${summarize(result)}`;
          // No finished topic and little to shorten: the older part is folded, the newest stays.
          if (!isPrecompute && olderCut > 0) {
            const done = await foldPart(olderCut, 'in the older part', planned);
            if (done) return done;
          }
          if (!isPrecompute) {
            notify($, `built-in summary used: shortening would cut only ${percent(reductionRatio(result))} of the context`);
          }
          await record({ outcome: 'fallback', note }, result, undefined, planned);
          return next(event);
        }
        const kept = await pointed(messages);
        if (isPrecompute) {
          if (isMain) precomputed = { input: event.messages, output: kept };
          await record({ outcome: 'precomputed', note: summarize(result) }, result, kept.length);
          return { messages: kept };
        }
        notify($, headline(result));
        await record({ outcome: 'applied', note: summarize(result) }, result, kept.length, planned);
        return { messages: kept };
      } catch (error) {
        const note = error instanceof Error ? error.message : String(error);
        if (!isPrecompute) notify($, `built-in summary used: ${note}`);
        await record({ outcome: 'error', note });
        return next(event);
      } finally {
        if (!isPrecompute) $.ui.status(undefined);
      }
    })();
    // The engine sends the language rule once per session: a compaction can summarize it away.
    let final = outcome;
    if (event.trigger !== 'precompute' && outcome.messages) {
      const settings = await $.settings.read().catch(() => ({}) as Readonly<Record<string, unknown>>);
      const note = languageNote(settings['language']);
      if (note) final = { ...outcome, messages: withNote(outcome.messages, note) };
    }
    if (followUp && final.messages) void $.prompt.submit({ text: followUp, asUser: true });
    if (event.trigger !== 'precompute' && final.messages) cacheWatch = { after: event.trigger, ...(lastCache ? { before: lastCache } : {}) };
    return final;
  }).catch(($, event, next) => {
    // A hook that threw or overran its budget: the built-in summary takes over.
    $.ui.status(undefined);
    return next(event);
  });

  // The cache monitor: what each request of the main loop read from the prompt cache and wrote to it,
  // logged for the first request after a compaction next to the last one before it.
  if (configured.decisionLog) {
    on('turn.step', async function* ($, event, next) {
      const result = yield* next(event);
      const usage = result?.usage;
      if (event.agentId !== undefined || !usage) return result;
      const cache: CacheTokens = { read: usage.cache_read_input_tokens, written: usage.cache_creation_input_tokens, input: usage.input_tokens };
      const watch = cacheWatch;
      cacheWatch = undefined;
      lastCache = cache;
      if (watch) await logEntry($, configured, { at: new Date().toISOString(), sessionId: await $.session.id(), trigger: 'cache', ...watch, first: cache, model: usage.model });
      return result;
    });
  }

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    // A subagent's turn or an interrupted one is no point to compact the main loop at.
    if (compacting || event.agentId !== undefined || event.isAborted) return next(event);
    if (configured.foldTurns) {
      try {
        // Asked only for a turn worth folding: a compaction that changes nothing still shows in the transcript.
        // The whole history, the messages a compaction replaced included: only its end is the turn that closed.
        const messages = (await $.session.messages()) as unknown as readonly Message[];
        const steps = closedTurnSteps(messages);
        // A folded turn keeps its first call: one with a large input would be folded again at every turn end.
        const folded =
          steps !== undefined &&
          messages.slice(steps.start, steps.end).some((message) => (message.toolResults ?? []).some((result) => result.text.startsWith(TURN_NOTE_HEAD)));
        if (steps && !folded && steps.chars >= configured.foldTurnMinChars) {
          const until = Date.now() + TURN_FOLD_WAIT_MS;
          if (!viaCommand) {
            turnFold = { until, via: 'engine' };
            compacting = true;
            try {
              await $.session.compact();
            } catch (error) {
              if (!/headless/u.test(error instanceof Error ? error.message : String(error))) throw error;
              viaCommand = true;
            } finally {
              compacting = false;
            }
          }
          if (viaCommand) {
            turnFold = { until, via: 'command' };
            await $.command.run({ command: 'compact' });
          } else {
            turnFold = undefined;
          }
        }
      } catch (error) {
        // The turn stays as it is; the log says why.
        turnFold = undefined;
        if (configured.decisionLog) {
          await logEntry($, configured, { at: new Date().toISOString(), sessionId: await $.session.id(), trigger: 'turn-fold-error', error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    // 0 leaves compaction to the engine's own threshold (`autoCompactWindow`),
    // which compacts mid-turn and goes on without a prompt.
    if (configured.compactAtPercent <= 0) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      const outcome = await $.session.compact();
      // A plugin's prompt runs once the session is idle, so it is not awaited here.
      if (configured.resumeAfterCompact && !('skip' in outcome && outcome.skip)) {
        void $.prompt.submit({ text: RESUME_PROMPT });
      }
    } catch (error) {
      notify($, `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
