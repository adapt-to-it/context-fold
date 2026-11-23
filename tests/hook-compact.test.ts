import { describe, expect, it, vi } from 'vitest';
import { heldStore } from '../hooks/context-fold.ts';
import type { Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };
type Outcome = { messages?: SessionMessage[]; skip?: string };
type Handler = (...args: never[]) => Promise<unknown>;

/** The reply the summary model gives: the fold parser reads its STATE and PARTS. */
const FOLD_REPLY = '## STATE\nThe parser must stay strict.\n\n## PARTS\n- **S01**: fixed the parser, read src/p.ts\n';

const DEFAULT_OPTIONS = { pruneTopics: false, smallContextChars: 1, decisionLog: false };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

/** About 3000 characters of distinct lines. */
function bulk(tag: string): string {
  let text = '';
  for (let j = 0; text.length < 3000; j++) text += `${tag} line ${j}: value ${j * 7 + tag.length}\n`;
  return text;
}

/** A request, eighteen read calls with their results, a closing text: about 40 messages. */
function conversation(): SessionMessage[] {
  const out: SessionMessage[] = [message('user', 'Refactor the parser so it stays strict.', { handle: 'h-0' })];
  for (let i = 1; i <= 18; i++) {
    out.push(call(`t${i}`, 'Read', { file_path: `src/f${i}.ts` }, `Reading file ${i}`));
    out.push(result(`t${i}`, bulk(`file ${i}`)));
  }
  out.push(message('assistant', 'The parser is refactored.', { handle: 'h-end' }));
  return out;
}

/**
 * The plugin registered on a fake engine. Every test gets a fresh module, so the unfold tool
 * registered by one test does not count for the next.
 */
async function harness(options: Record<string, unknown> = {}) {
  vi.resetModules();
  const { register } = await import('../hooks/context-fold.ts');
  const handlers = new Map<string, Handler>();
  const on = (name: string, matcherOrHandler: unknown, handler?: unknown) => {
    handlers.set(name, (typeof matcherOrHandler === 'function' ? matcherOrHandler : handler) as Handler);
    // The session.compact handler is chained with a catch: the fake keeps it as well.
    return {
      catch: (fallback: unknown) => {
        handlers.set(`${name}:catch`, fallback as Handler);
      },
    };
  };

  const files = new Map<string, string>();
  const complete = vi.fn(async () => ({ isAnswered: true, text: FOLD_REPLY, usage: { output_tokens: 10 } }));
  const toolRegister = vi.fn(async () => undefined);
  const status = vi.fn();
  const toast = vi.fn();
  const settingsRead = vi.fn(async () => ({}));
  const httpFetch = vi.fn();
  const next = vi.fn(async () => ({ messages: [message('user', 'BUILT-IN')] }));
  /** The context's tokens as the engine reports them; a test sets it before a turn ends. */
  const usage = { tokens: 0 };
  const sessionCompact = vi.fn(async (): Promise<unknown> => ({ messages: [] }));
  const commandRun = vi.fn(async () => undefined);

  const $ = {
    session: {
      id: async () => 'sess-1',
      root: async () => '/work',
      usage: async () => ({ context: { tokens: usage.tokens, window: 400_000 } }),
      compact: sessionCompact,
      messages: async () => [],
    },
    command: { run: commandRun },
    fs: {
      read: async (path: string) => files.get(path),
      write: async (path: string, text: string) => {
        files.set(path, text);
      },
      list: async (dir: string) =>
        [...files.keys()]
          .filter((path) => path.startsWith(`${dir}/`))
          .map((path) => ({ name: path.slice(dir.length + 1), kind: 'file' })),
    },
    env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
    model: { complete },
    tool: { register: toolRegister },
    ui: { status, toast },
    settings: { read: settingsRead },
    http: { fetch: httpFetch },
  } as never;

  register(on as never, { ...DEFAULT_OPTIONS, ...options } as never);
  const handler = handlers.get('session.compact') as (...args: unknown[]) => Promise<Outcome>;
  const compact = (trigger: string, messages: SessionMessage[]) =>
    handler($, { trigger, messages, agentId: undefined }, next);

  const turnEnd = handlers.get('turn.complete') as (...args: unknown[]) => Promise<unknown>;
  /** A main-loop turn ends with the context at `tokens`. */
  const endTurn = (tokens: number) => {
    usage.tokens = tokens;
    return turnEnd($, { turnId: 't' }, async () => ({}));
  };

  return { compact, files, complete, toolRegister, status, next, endTurn, sessionCompact, commandRun };
}

function firstText(outcome: Outcome): string {
  return outcome.messages?.[0]?.text ?? '';
}

describe('held store', () => {
  it('holds writes until flush, merges names on list, flushes once', async () => {
    const under = new Map<string, string>();
    const writes = vi.fn(async (path: string, text: string) => {
      under.set(path, text);
    });
    const store = {
      read: async (path: string) => under.get(path),
      write: writes,
      list: async (dir: string) =>
        [...under.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
    };
    under.set('/d/a.json', 'old');
    under.set('/d/b.json', 'B');

    const held = heldStore(store as never);
    await held.store.write('/d/a.json', 'A');
    await held.store.write('/d/c.json', 'C');

    expect(under.get('/d/a.json')).toBe('old');
    expect(under.has('/d/c.json')).toBe(false);
    expect(writes).not.toHaveBeenCalled();
    expect(await held.store.read('/d/a.json')).toBe('A');
    expect(await held.store.list('/d')).toEqual(['a.json', 'b.json', 'c.json']);

    await held.flush();
    expect(under.get('/d/a.json')).toBe('A');
    expect(under.get('/d/c.json')).toBe('C');
    expect(writes).toHaveBeenCalledTimes(2);

    await held.flush();
    expect(writes).toHaveBeenCalledTimes(2);
  });
});

describe('precompute', () => {
  it('folds without side effects', async () => {
    const h = await harness();
    const messages = conversation();

    const pre = await h.compact('precompute', messages);

    expect(firstText(pre)).toContain('The parser must stay strict.');
    const tail = pre.messages!.slice(-2);
    expect(tail[0]).toBe(messages[messages.length - 2]);
    expect(tail[1]).toBe(messages[messages.length - 1]);
    expect([...h.files.keys()].some((path) => path.includes('folds'))).toBe(false);
    expect(h.toolRegister).not.toHaveBeenCalled();
    expect(h.status.mock.calls.some((args) => typeof args[0] === 'string')).toBe(false);
  });

  it('is reused by an auto compaction of the same messages plus two new ones', async () => {
    const h = await harness();
    const messages = conversation();
    const pre = await h.compact('precompute', messages);
    const completions = h.complete.mock.calls.length;

    const added = [message('user', 'one more', { handle: 'h-new1' }), message('assistant', 'ok', { handle: 'h-new2' })];
    const auto = await h.compact('auto', [...messages, ...added]);

    expect(auto.messages!.length).toBe(pre.messages!.length + 2);
    expect(auto.messages!.slice(0, pre.messages!.length).every((m, i) => m === pre.messages![i])).toBe(true);
    expect(auto.messages!.slice(-2)[0]).toBe(added[0]);
    expect(auto.messages!.slice(-2)[1]).toBe(added[1]);
    expect(h.complete.mock.calls.length).toBe(completions);
    expect([...h.files.keys()].some((path) => path.includes('folds'))).toBe(true);
    expect(h.toolRegister).toHaveBeenCalled();
  });

  it('is worked out again when the unfold tool is refused', async () => {
    const h = await harness();
    h.toolRegister.mockRejectedValue(new Error('refused'));
    const messages = conversation();
    await h.compact('precompute', messages);

    const added = [message('user', 'one more', { handle: 'h-new1' }), message('assistant', 'ok', { handle: 'h-new2' })];
    const auto = await h.compact('auto', [...messages, ...added]);

    expect(h.next).toHaveBeenCalled();
    expect(firstText(auto)).toBe('BUILT-IN');
  });

  it('leaves no fold file and registers no tool when the summary model refuses', async () => {
    const h = await harness();
    h.complete.mockResolvedValue({ isAnswered: false, reason: 'x', text: '' } as never);

    const pre = await h.compact('precompute', conversation());

    expect(pre).toBeDefined();
    expect([...h.files.keys()].some((path) => path.includes('folds'))).toBe(false);
    expect(h.toolRegister).not.toHaveBeenCalled();
  });

  it('is not reused when the first message differs', async () => {
    const h = await harness();
    const messages = conversation();
    await h.compact('precompute', messages);
    const completions = h.complete.mock.calls.length;

    const other = [message('user', 'Another start', { handle: 'h-other' }), ...messages.slice(1)];
    await h.compact('auto', other);

    expect(h.complete.mock.calls.length).toBeGreaterThan(completions);
  });
});

describe('auto', () => {
  it('folds the older part alone when nothing was precomputed', async () => {
    const h = await harness();

    const auto = await h.compact('auto', conversation());

    expect(firstText(auto)).toContain('The parser must stay strict.');
    expect([...h.files.keys()].some((path) => path.includes('folds'))).toBe(true);
    expect(h.next).not.toHaveBeenCalled();
  });
});

describe('flow', () => {
  it('is due past the threshold, once the context has gained enough since the last compaction', async () => {
    const { flowDue, FLOW_MIN_GROWTH_TOKENS } = await import('../hooks/context-fold.ts');
    expect(flowDue(149_999, 150_000, undefined)).toBe(false);
    expect(flowDue(150_000, 150_000, undefined)).toBe(true);
    expect(flowDue(400_000, 0, undefined)).toBe(false);
    expect(flowDue(170_000, 150_000, 170_000 - FLOW_MIN_GROWTH_TOKENS + 1)).toBe(false);
    expect(flowDue(170_000, 150_000, 170_000 - FLOW_MIN_GROWTH_TOKENS)).toBe(true);
  });

  it('compacts at a turn end past the threshold and not below it', async () => {
    const h = await harness({ foldAtTokens: 150_000 });
    await h.endTurn(120_000);
    expect(h.sessionCompact).not.toHaveBeenCalled();
    await h.endTurn(160_000);
    expect(h.sessionCompact).toHaveBeenCalledTimes(1);
    expect(h.commandRun).not.toHaveBeenCalled();
  });

  it('runs the compact command where the engine refuses a plugin, and remembers it', async () => {
    const h = await harness({ foldAtTokens: 150_000 });
    h.sessionCompact.mockRejectedValue(new Error('not available in a headless session'));
    await h.endTurn(160_000);
    expect(h.commandRun).toHaveBeenCalledWith({ command: 'compact' });
    await h.endTurn(200_000);
    expect(h.commandRun).toHaveBeenCalledTimes(2);
    expect(h.sessionCompact).toHaveBeenCalledTimes(1);
  });

  it('waits for the context to grow before it folds again', async () => {
    const h = await harness({ foldAtTokens: 150_000 });
    await h.endTurn(160_000);
    // The compaction changed nothing: the context is still past the threshold.
    await h.endTurn(165_000);
    expect(h.sessionCompact).toHaveBeenCalledTimes(1);
    await h.endTurn(195_000);
    expect(h.sessionCompact).toHaveBeenCalledTimes(2);
  });

  it('counts the growth from the size after a compaction', async () => {
    const h = await harness({ foldAtTokens: 150_000 });
    await h.endTurn(160_000);
    await h.compact('manual', conversation());
    // First turn end after the compaction: 140,000 is the new floor.
    await h.endTurn(140_000);
    await h.endTurn(165_000);
    expect(h.sessionCompact).toHaveBeenCalledTimes(1);
    await h.endTurn(171_000);
    expect(h.sessionCompact).toHaveBeenCalledTimes(2);
  });

  it('is off at 0', async () => {
    const h = await harness({ foldAtTokens: 0 });
    await h.endTurn(390_000);
    expect(h.sessionCompact).not.toHaveBeenCalled();
    expect(h.commandRun).not.toHaveBeenCalled();
  });
});
