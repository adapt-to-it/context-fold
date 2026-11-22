import { describe, expect, it } from 'vitest';
import { RERUN_HINT } from '../src/compact.js';
import {
  carriedLines,
  foldDir,
  foldNote,
  foldOlder,
  foldPath,
  foldPrompt,
  nextFoldNumbers,
  parseFoldReply,
  pointResults,
  segmentFold,
  writeFolds,
} from '../src/fold.js';
import { FOLD_LINE_CHARS, FOLD_NOTE_HEAD, UNFOLD_TOOL_NAME } from '../src/fold-spec.js';
import type { FoldEntry, FoldInput, FoldStore } from '../src/fold-spec.js';
import type { Message } from '../src/types.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

/** `turns` user requests, each followed by one reply. */
function conversation(turns: number): Message[] {
  const out: Message[] = [];
  for (let n = 1; n <= turns; n++) out.push(message('user', `request ${n}`), message('assistant', `reply ${n}`));
  return out;
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

describe('foldDir', () => {
  it('replaces every character outside A-Za-z0-9_- of the session id', () => {
    expect(foldDir('/root', 'a b.c/d')).toBe('/root/a_b_c_d');
    expect(foldDir('/root', 'abc-DEF_9')).toBe('/root/abc-DEF_9');
  });
});

describe('foldPath', () => {
  it('joins the folder, the id and .json', () => {
    expect(foldPath('/root/s1', 'f3')).toBe('/root/s1/f3.json');
  });
});

describe('nextFoldNumbers', () => {
  it('takes 1 + the highest number of each kind', () => {
    expect(nextFoldNumbers(['f1.json', 'f3.json', 'r2.json', 'x.json', 'f10.json'])).toEqual({ f: 11, r: 3 });
  });

  it('starts at 1 when there is no fold', () => {
    expect(nextFoldNumbers([])).toEqual({ f: 1, r: 1 });
  });
});

describe('segmentFold', () => {
  it('has no segment for no messages', () => {
    expect(segmentFold([])).toEqual([]);
  });

  it('makes one segment per turn, keyed in order', () => {
    const segments = segmentFold(conversation(2));
    expect(segments).toEqual([
      { key: 'S01', start: 0, end: 2, request: 'request 1', continued: false },
      { key: 'S02', start: 2, end: 4, request: 'request 2', continued: false },
    ]);
  });

  it('adds a segment without request for the messages before the first request', () => {
    const segments = segmentFold([message('assistant', 'hello'), ...conversation(1)]);
    expect(segments.map((segment) => [segment.key, segment.start, segment.end, segment.request])).toEqual([
      ['S01', 0, 1, ''],
      ['S02', 1, 3, 'request 1'],
    ]);
  });

  it('splits a turn of three 30,000-character tool results into continued segments', () => {
    const results = ['a', 'b', 'c'].map((id) => ({ tool_use_id: id, text: 'x'.repeat(30_000) }));
    const messages = [
      message('user', 'run three'),
      message('assistant', '', {
        toolUses: [
          { tool_use_id: 'a', tool: 'Bash', input: { command: '1' } },
          { tool_use_id: 'b', tool: 'Bash', input: { command: '2' } },
          { tool_use_id: 'c', tool: 'Bash', input: { command: '3' } },
        ],
      }),
      message('user', '', { toolResults: results }),
      message('assistant', 'done'),
    ];
    const segments = segmentFold(messages);
    expect(segments).toEqual([
      { key: 'S01', start: 0, end: 3, request: 'run three', continued: false },
      { key: 'S02', start: 3, end: 4, request: 'run three', continued: true },
    ]);
  });
});

describe('foldPrompt', () => {
  it('puts the instructions, then the segments under their headers', () => {
    const messages = conversation(2);
    const prompt = foldPrompt('Fold it.', segmentFold(messages), messages);
    expect(prompt.startsWith('Fold it.\n\n<conversation>\n=== S01: request 1 ===\n[0] USER:\nrequest 1')).toBe(true);
    expect(prompt).toContain('=== S02: request 2 ===\n[0] USER:\nrequest 2');
    expect(prompt.endsWith('</conversation>')).toBe(true);
  });

  it('marks a continued segment with (continues) after its request', () => {
    const results = ['a', 'b', 'c'].map((id) => ({ tool_use_id: id, text: 'x'.repeat(30_000) }));
    const messages = [
      message('user', 'run three'),
      message('assistant', '', {
        toolUses: ['a', 'b', 'c'].map((id) => ({ tool_use_id: id, tool: 'Bash', input: {} })),
      }),
      message('user', '', { toolResults: results }),
      message('assistant', 'done'),
    ];
    const prompt = foldPrompt('Fold it.', segmentFold(messages), messages);
    expect(prompt).toContain('=== S02: run three (continues) ===');
  });

  it('renders again with a smaller limit when the whole exceeds FOLD_PROMPT_CHARS', () => {
    const messages = [
      message('user', `q1 ${'x'.repeat(400_000)}`),
      message('assistant', 'y'),
      message('user', 'q2'),
      message('assistant', 'z'.repeat(400_000)),
    ];
    const segments = segmentFold(messages, 1e9);
    const prompt = foldPrompt('Fold it.', segments, messages);
    expect(prompt.split('[…earlier part cut]').length - 1).toBe(segments.length);
  });
});

describe('parseFoldReply', () => {
  it('reads the state and the lines under markdown headers, ignoring a missing key', () => {
    const text = '## STATE\nThe parser must stay strict.\n\n## PARTS\n- **S01**: fixed the parser, read src/p.ts\n';
    expect(parseFoldReply(text, ['S01', 'S02'])).toEqual({
      state: 'The parser must stay strict.',
      lines: { S01: 'fixed the parser, read src/p.ts' },
    });
  });

  it('keeps the first line of a key, collapses whitespace and cuts long lines', () => {
    const long = 'word '.repeat(200);
    const text = `STATE: goal\nPARTS:\nS01: first   line\nS01: second\nS02: ${long}`;
    const { state, lines } = parseFoldReply(text, ['S01', 'S02']);
    expect(state).toBe('goal');
    expect(lines.S01).toBe('first line');
    expect(lines.S02!.length).toBeLessThanOrEqual(FOLD_LINE_CHARS);
  });

  it('takes everything after STATE as the state without PARTS, and no state without STATE', () => {
    expect(parseFoldReply('STATE:\nall of it', ['S01'])).toEqual({ state: 'all of it', lines: {} });
    expect(parseFoldReply('S01: alone', ['S01'])).toEqual({ state: '', lines: {} });
  });
});

describe('carriedLines', () => {
  it('takes the fold lines of the notes, each id once and in order', () => {
    const note = `${FOLD_NOTE_HEAD}: stored outside.\nf1 · parsed the config\nf2 · added tests`;
    const messages = [
      message('user', 'a request'),
      message('user', note),
      message('user', `${FOLD_NOTE_HEAD}: again\nf2 · added tests\nf3 · ran lint`),
    ];
    expect(carriedLines(messages)).toEqual(['f1 · parsed the config', 'f2 · added tests', 'f3 · ran lint']);
  });

  it('ignores the lines of messages that are not a note', () => {
    expect(carriedLines([message('user', 'f1 · not a note')])).toEqual([]);
  });
});

describe('foldNote', () => {
  it('is empty when there is no line', () => {
    expect(foldNote([], [])).toBe('');
  });

  it('holds the head, the carried lines, then one line per added fold', () => {
    const note = foldNote(['f1 · parsed the config'], [{ id: 'f2', line: 'added\ntests' }]);
    expect(note).toBe(
      `${FOLD_NOTE_HEAD}: the earlier conversation is stored outside the context, one line per part, oldest first. ` +
        `Call ${UNFOLD_TOOL_NAME} with an id for the original messages, or with a query to search them.\n` +
        'f1 · parsed the config\nf2 · added tests',
    );
  });
});

describe('writeFolds', () => {
  it('writes each entry as JSON indented by 2 under its id', async () => {
    const store = memoryStore();
    const entry: FoldEntry = {
      id: 'r1',
      kind: 'result',
      at: '2026-11-22T10:00:00Z',
      tool: 'Bash',
      input: { command: 'ls' },
      text: 'out',
      isError: false,
    };
    await writeFolds(store, '/root/s1', [entry]);
    expect(store.files.get('/root/s1/r1.json')).toBe(JSON.stringify(entry, null, 2));
  });
});

describe('foldOlder', () => {
  const at = '2026-11-22T10:00:00Z';

  function olderPart(): Message[] {
    return [
      message('user', 'fix the parser'),
      message('assistant', '', {
        toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'src/p.ts' }, text: 'body', isError: false }],
      }),
      message('user', '', { toolResults: [{ tool_use_id: 't1', text: 'body' }] }),
      message('assistant', 'fixed'),
      message('user', 'add tests'),
      message('assistant', 'added'),
    ];
  }

  it('folds each segment, falls back to the request for a missing key and stores the messages', async () => {
    const store = memoryStore();
    const older = olderPart();
    const prompts: string[] = [];
    const input: FoldInput = {
      older,
      reading: older.map((m) => m),
      store,
      dir: '/root/s1',
      instructions: 'Fold it.',
      at,
      complete: async (_system, prompt) => {
        prompts.push(prompt);
        return '## STATE\nThe parser must stay strict.\n\n## PARTS\n- **S01**: fixed the parser, read src/p.ts\n';
      },
    };
    const outcome = await foldOlder(input);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('=== S01: fix the parser ===');
    expect(outcome.ids).toEqual(['f1', 'f2']);
    expect(outcome.state).toBe('The parser must stay strict.');
    expect(outcome.note).toContain('f1 · fixed the parser, read src/p.ts');
    expect(outcome.note).toContain('f2 · add tests');

    const stored = JSON.parse(store.files.get('/root/s1/f1.json')!);
    expect(stored).toMatchObject({ id: 'f1', kind: 'part', at, line: 'fixed the parser, read src/p.ts' });
    expect(stored.messages[1].toolUses[0]).not.toHaveProperty('text');
    expect(stored.messages[2].toolResults).toEqual([{ tool_use_id: 't1', text: 'body' }]);
    expect(JSON.parse(store.files.get('/root/s1/f2.json')!).line).toBe('add tests');
  });

  it('carries the lines of an earlier note found in older and numbers after the folds in the store', async () => {
    const store = memoryStore(new Map([['/root/s1/f1.json', '{}']]));
    const older = [
      message('user', `${FOLD_NOTE_HEAD}: stored outside.\nf1 · parsed the config`),
      message('assistant', 'ok'),
      message('user', 'next'),
      message('assistant', 'done'),
    ];
    const outcome = await foldOlder({
      older,
      reading: older,
      store,
      dir: '/root/s1',
      instructions: 'Fold it.',
      at,
      complete: async () => 'PARTS:\nS01: did it\nS02: and that',
    });
    expect(outcome.ids).toEqual(['f2', 'f3']);
    expect(outcome.note).toContain('f1 · parsed the config\nf2 · did it\nf3 · and that');
  });

  it('rejects when a write fails', async () => {
    const store: FoldStore = {
      read: async () => undefined,
      list: async () => [],
      write: async () => {
        throw new Error('disk full');
      },
    };
    await expect(
      foldOlder({
        older: olderPart(),
        reading: olderPart(),
        store,
        dir: '/root/s1',
        instructions: 'Fold it.',
        at,
        complete: async () => undefined,
      }),
    ).rejects.toThrow('disk full');
  });

  it('asks nothing and writes nothing without a segment', async () => {
    const store = memoryStore();
    let asked = false;
    const outcome = await foldOlder({
      older: [],
      reading: [],
      store,
      dir: '/root/s1',
      instructions: 'Fold it.',
      at,
      complete: async () => {
        asked = true;
        return undefined;
      },
    });
    expect(asked).toBe(false);
    expect(store.files.size).toBe(0);
    expect(outcome).toEqual({ state: '', note: '', ids: [] });
  });
});

describe('pointResults', () => {
  it('leaves untouched messages as the same objects and writes the original text in the entry', () => {
    const full = 'x'.repeat(500);
    const short = `${full.slice(0, 20)}…${RERUN_HINT}`;
    const input = [
      message('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' }, text: full }] }),
      message('user', '', { toolResults: [{ tool_use_id: 't1', text: full }] }),
    ];
    const untouched = message('user', 'hello');
    const output = [
      untouched,
      message('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' }, text: short }] }),
      message('user', '', { toolResults: [{ tool_use_id: 't1', text: short }] }),
    ];
    const at = '2026-11-22T10:00:00Z';
    const { messages, entries } = pointResults(input, output, 5, at);

    expect(messages[0]).toBe(untouched);
    expect(messages[1]).not.toBe(output[1]);
    const hint = `; full text: ${UNFOLD_TOOL_NAME} id r5]`;
    expect(messages[1]!.toolUses[0]!.text).toBe(`${short.slice(0, -RERUN_HINT.length)}${hint}`);
    expect(messages[2]!.toolResults![0]!.text).toBe(`${short.slice(0, -RERUN_HINT.length)}${hint}`);
    expect(entries).toEqual([
      { id: 'r5', kind: 'result', at, tool: 'Bash', input: { command: 'ls' }, text: full, isError: false },
    ]);
  });
});
