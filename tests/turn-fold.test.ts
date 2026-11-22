import { describe, expect, it } from 'vitest';
import { messageChars } from '../src/compact.js';
import { closedTurnSteps, foldTurn, turnNote } from '../src/turn-fold.js';
import { TURN_CALL_CHARS, TURN_FOLD_MIN_CHARS, TURN_NOTE_CALLS, TURN_NOTE_HEAD, UNFOLD_TOOL_NAME } from '../src/fold-spec.js';
import type { FoldStore, TurnFoldInput } from '../src/fold-spec.js';
import type { Message, ToolResult } from '../src/types.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

/** A FoldStore over a map of path to text; `list` returns the names directly under the folder. */
function memoryStore(files = new Map<string, string>()): FoldStore & { files: Map<string, string> } {
  return {
    files,
    async read(path) {
      return files.get(path);
    },
    async write(path, text) {
      files.set(path, text);
    },
    async list(dir) {
      return [...files.keys()]
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1))
        .filter((name) => !name.includes('/'));
    },
  };
}

/** A request, one tool call whose result holds `chars` characters, then the answer. */
function turnWithTools(request: string, chars = 30_000): Message[] {
  return [
    message('user', request),
    message('assistant', 'looking', { toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'src/p.ts' } }] }),
    message('user', '', { toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(chars) }] }),
    message('assistant', 'fixed'),
  ];
}

/** The user message that carries the results. */
const answer = (results: readonly ToolResult[]): Message => message('user', '', { toolResults: [...results] });
const at = '2026-11-22T10:00:00Z';

function input(messages: Message[], store: FoldStore, extra: Partial<TurnFoldInput<Message>> = {}): TurnFoldInput<Message> {
  return { messages, store, dir: '/root/s1', at, result: answer, ...extra };
}

describe('closedTurnSteps', () => {
  it('is undefined when the list ends with a tool use', () => {
    const messages = [
      ...turnWithTools('req'),
      message('assistant', '', { toolUses: [{ tool_use_id: 't2', tool: 'Bash', input: { command: 'ls' } }] }),
    ];
    expect(closedTurnSteps(messages)).toBeUndefined();
  });

  it('is undefined when the list ends with a user message', () => {
    expect(closedTurnSteps([...turnWithTools('req'), message('user', 'thanks')])).toBeUndefined();
  });

  it('is undefined when the turn holds no tool result', () => {
    expect(closedTurnSteps([message('user', 'hi'), message('assistant', 'hello')])).toBeUndefined();
  });

  it('returns the steps of the last turn only', () => {
    const messages = [...turnWithTools('first'), ...turnWithTools('second')];
    expect(closedTurnSteps(messages)).toEqual({
      start: 5,
      end: 7,
      chars: messageChars(messages[5]!) + messageChars(messages[6]!),
    });
  });

  it('moves start after a user message without results in the middle of the turn', () => {
    const messages = [
      message('user', 'req'),
      message('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }] }),
      message('user', 'also check'),
      message('assistant', '', { toolUses: [{ tool_use_id: 't2', tool: 'Read', input: { file_path: 'b.ts' } }] }),
      message('user', '', { toolResults: [{ tool_use_id: 't2', text: 'ok' }] }),
      message('assistant', 'done'),
    ];
    expect(closedTurnSteps(messages)).toMatchObject({ start: 3, end: 5 });
  });

  it('keeps every closing assistant message after the steps', () => {
    const messages = [...turnWithTools('req').slice(0, 3), message('assistant', 'a'), message('assistant', 'b')];
    expect(closedTurnSteps(messages)).toMatchObject({ start: 1, end: 3 });
  });
});

describe('foldTurn', () => {
  it('folds only the last turn and keeps the other messages as the same objects', async () => {
    const messages = [...turnWithTools('first'), ...turnWithTools('second')];
    const outcome = await foldTurn(input(messages, memoryStore()));

    expect(outcome).toBeDefined();
    expect(outcome!.start).toBe(5);
    expect(outcome!.end).toBe(7);
    expect(outcome!.calls).toBe(1);
    expect(outcome!.messages).toHaveLength(8);
    for (let i = 0; i < 5; i++) expect(outcome!.messages[i]).toBe(messages[i]);
    expect(outcome!.messages[5]).toBe(messages[5]);
    expect(outcome!.messages[6]!.role).toBe('user');
    expect(outcome!.messages[6]!.toolResults![0]!.text.startsWith(TURN_NOTE_HEAD)).toBe(true);
    expect(outcome!.messages[7]).toBe(messages[7]);
  });

  it('keeps several closing assistant messages as the same objects, the result after the kept call', async () => {
    const messages = [...turnWithTools('req').slice(0, 3), message('assistant', 'a'), message('assistant', 'b')];
    const outcome = await foldTurn(input(messages, memoryStore()));

    expect(outcome!.messages).toHaveLength(5);
    expect(outcome!.messages[0]).toBe(messages[0]);
    expect(outcome!.messages[1]).toBe(messages[1]);
    expect(outcome!.messages[2]!.toolResults![0]!.text.startsWith(TURN_NOTE_HEAD)).toBe(true);
    expect(outcome!.messages[3]).toBe(messages[3]);
    expect(outcome!.messages[4]).toBe(messages[4]);
  });

  it('keeps the first call before the result, then the closing answer', async () => {
    const messages = [...turnWithTools('first'), ...turnWithTools('second')];
    const outcome = await foldTurn(input(messages, memoryStore()));

    expect(outcome!.messages[outcome!.start]).toBe(messages[outcome!.start]);
    expect(outcome!.messages[outcome!.start]!.toolUses).toHaveLength(1);
    expect(outcome!.messages[outcome!.start + 1]!.toolResults![0]!.text.startsWith(TURN_NOTE_HEAD)).toBe(true);
    expect(outcome!.messages[outcome!.start + 2]).toBe(messages[outcome!.end]);
    expect(outcome!.messages[outcome!.start + 2]!.text).toBe('fixed');
  });

  it('answers each tool use of the kept message: the note first, then a pointer to it', async () => {
    const messages = [
      message('user', 'req'),
      message('assistant', 'looking', {
        toolUses: [
          { tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } },
          { tool_use_id: 't2', tool: 'Bash', input: { command: 'ls' } },
        ],
      }),
      message('user', '', {
        toolResults: [
          { tool_use_id: 't1', text: 'x'.repeat(30_000) },
          { tool_use_id: 't2', text: 'y' },
        ],
      }),
      message('assistant', 'fixed'),
    ];
    const outcome = await foldTurn(input(messages, memoryStore()));
    const results = outcome!.messages[2]!.toolResults!;

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ tool_use_id: 't1', text: turnNote('f1', messages.slice(1, 3)), isError: false });
    expect(results[1]).toEqual({
      tool_use_id: 't2',
      text: `${TURN_NOTE_HEAD} (f1): see the first result of this message.`,
      isError: false,
    });
  });

  it('keeps an assistant text-only step before the first call as the same object', async () => {
    const messages = [
      message('user', 'req'),
      message('assistant', 'let me think'),
      message('assistant', 'looking', { toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }] }),
      message('user', '', { toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(30_000) }] }),
      message('assistant', 'fixed'),
    ];
    const outcome = await foldTurn(input(messages, memoryStore()));

    expect(outcome!.messages).toHaveLength(5);
    expect(outcome!.messages[0]).toBe(messages[0]);
    expect(outcome!.messages[1]).toBe(messages[1]);
    expect(outcome!.messages[2]).toBe(messages[2]);
    expect(outcome!.messages[3]!.toolResults![0]!.text.startsWith(TURN_NOTE_HEAD)).toBe(true);
    expect(outcome!.messages[4]).toBe(messages[4]);
  });

  it('calls result once with the results of the kept message', async () => {
    const seen: ToolResult[][] = [];
    const outcome = await foldTurn(
      input(turnWithTools('req'), memoryStore(), {
        result: (results) => {
          seen.push([...results]);
          return answer(results);
        },
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((result) => result.tool_use_id)).toEqual(['t1']);
    expect(outcome!.messages[2]).toEqual(answer(seen[0]!));
  });

  it('is undefined and writes nothing when no step holds a tool use', async () => {
    const store = memoryStore();
    const messages = [
      message('user', 'req'),
      message('assistant', 'a'),
      message('user', '', { toolResults: [{ tool_use_id: 't9', text: 'x'.repeat(30_000) }] }),
      message('assistant', 'b'),
    ];
    expect(await foldTurn(input(messages, store, { minChars: 1 }))).toBeUndefined();
    expect(store.files.size).toBe(0);
  });

  it('is undefined and writes nothing when the steps are under minChars', async () => {
    const store = memoryStore();
    const outcome = await foldTurn(input(turnWithTools('req', 100), store));
    expect(outcome).toBeUndefined();
    expect(store.files.size).toBe(0);
  });

  it('folds steps under a given minChars', async () => {
    const outcome = await foldTurn(input(turnWithTools('req', 100), memoryStore(), { minChars: 1 }));
    expect(outcome!.id).toBe('f1');
  });

  it('stores the steps as a part entry without the outcome of the calls it holds', async () => {
    const store = memoryStore();
    const messages = [
      message('user', 'find   the bug'),
      message('assistant', 'looking', {
        toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'src/p.ts' }, text: 'x'.repeat(30_000), isError: false }],
      }),
      message('user', '', { toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(30_000) }] }),
      message('assistant', 'fixed'),
    ];
    const outcome = await foldTurn(input(messages, store));

    expect(outcome!.id).toBe('f1');
    const stored = JSON.parse(store.files.get('/root/s1/f1.json')!);
    expect(stored).toMatchObject({
      id: 'f1',
      kind: 'part',
      at,
      line: 'steps of the turn "find the bug": 1 tool calls',
    });
    expect(stored.messages[0].toolUses[0]).toEqual({ tool_use_id: 't1', tool: 'Read', input: { file_path: 'src/p.ts' } });
    expect(stored.messages[1].toolResults[0].text).toHaveLength(30_000);
  });

  it('takes the next f number after the folds in the store, the r files do not move it', async () => {
    const store = memoryStore(
      new Map([
        ['/root/s1/f1.json', '{}'],
        ['/root/s1/r9.json', '{}'],
      ]),
    );
    const outcome = await foldTurn(input(turnWithTools('req'), store));
    expect(outcome!.id).toBe('f2');
    expect(store.files.has('/root/s1/f2.json')).toBe(true);
  });

  it('rejects when a write fails', async () => {
    const store: FoldStore = {
      read: async () => undefined,
      list: async () => [],
      write: async () => {
        throw new Error('disk full');
      },
    };
    await expect(foldTurn(input(turnWithTools('req'), store))).rejects.toThrow('disk full');
  });
});

describe('turnNote', () => {
  it('starts with the id, the call and character counts, and the unfold hint', () => {
    const steps = turnWithTools('req', 40).slice(1, 3);
    const chars = messageChars(steps[0]!) + messageChars(steps[1]!);
    const lines = turnNote('f3', steps).split('\n');

    expect(lines[0]).toBe(
      `${TURN_NOTE_HEAD} (f3): 1 tool calls, ${chars} characters, stored outside the context. ` +
        `Call ${UNFOLD_TOOL_NAME} with id f3 for the original messages.`,
    );
    expect(lines[1]).toBe('- Read src/p.ts → 40 chars');
  });

  it.each(['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt'])(
    'takes the brief from %s with whitespace runs as one space',
    (key) => {
      const steps = [message('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Tool', input: { [key]: 'a  b\n c' } }] })];
      expect(turnNote('f1', steps).split('\n')[1]).toBe('- Tool a b c');
    },
  );

  it('prefers file_path to the other brief keys', () => {
    const steps = [
      message('assistant', '', {
        toolUses: [{ tool_use_id: 't1', tool: 'Tool', input: { command: 'ls', file_path: 'src/a.ts' } }],
      }),
    ];
    expect(turnNote('f1', steps).split('\n')[1]).toBe('- Tool src/a.ts');
  });

  it('writes the input as JSON when no brief key holds a string', () => {
    const steps = [
      message('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Tool', input: { limit: 5, offset: 2 } }] }),
    ];
    expect(turnNote('f1', steps).split('\n')[1]).toBe('- Tool {"limit":5,"offset":2}');
  });

  it('adds `, error` to the size of a failed result', () => {
    const steps = [
      message('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' } }] }),
      message('user', '', { toolResults: [{ tool_use_id: 't1', text: 'boom', isError: true }] }),
    ];
    expect(turnNote('f1', steps).split('\n')[1]).toBe('- Bash ls → 4 chars, error');
  });

  it('adds no suffix when the result is not among the steps', () => {
    const steps = [message('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' } }] })];
    expect(turnNote('f1', steps).split('\n')[1]).toBe('- Bash ls');
  });

  it('cuts the call line before adding the size of its result', () => {
    const steps = [
      message('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'x'.repeat(500) } }] }),
      message('user', '', { toolResults: [{ tool_use_id: 't1', text: 'y'.repeat(300) }] }),
    ];
    const line = turnNote('f1', steps).split('\n')[1];
    expect(line).toBe(`- Bash ${'x'.repeat(TURN_CALL_CHARS - 8)}… → 300 chars`);
  });

  it('counts the calls beyond the cap in one last line', () => {
    const uses = Array.from({ length: TURN_NOTE_CALLS + 1 }, (_, n) => ({
      tool_use_id: `t${n}`,
      tool: 'Bash',
      input: { command: `ls ${n}` },
    }));
    const lines = turnNote('f1', [message('assistant', '', { toolUses: uses })]).split('\n');

    expect(lines).toHaveLength(TURN_NOTE_CALLS + 2);
    expect(lines[0]).toContain(`(f1): ${TURN_NOTE_CALLS + 1} tool calls`);
    expect(lines[lines.length - 1]).toBe('… and 1 more calls');
  });
});
