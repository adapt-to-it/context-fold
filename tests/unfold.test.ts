import { describe, expect, it } from 'vitest';
import {
  SEARCH_HITS,
  UNFOLD_CHARS,
  UNFOLD_FULL_CHARS,
  UNFOLD_PART_CHARS,
  type FoldEntry,
  type FoldStore,
} from '../src/fold-spec.js';
import { listFolds, readFold, searchFolds, unfold } from '../src/unfold.js';
import type { Message } from '../src/types.js';

const DIR = '/sessions/s1';
const AT = '2026-01-01T00:00:00.000Z';

type MemoryStore = FoldStore & { files: Map<string, string> };

function memoryStore(): MemoryStore {
  const files = new Map<string, string>();
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

/** A store whose every call fails. */
const broken: FoldStore = {
  async read() {
    throw new Error('disk');
  },
  async write() {},
  async list() {
    throw new Error('disk');
  },
};

function put(store: MemoryStore, entry: FoldEntry) {
  store.files.set(`${DIR}/${entry.id}.json`, JSON.stringify(entry));
}

function user(text: string): Message {
  return { role: 'user', text, toolUses: [] };
}

function part(n: number, texts: string[], line = `part ${n}`): FoldEntry {
  return { id: `f${n}`, kind: 'part', at: AT, line, messages: texts.map((text) => user(text)) };
}

function result(n: number, text: string, tool = 'Bash', input: Record<string, unknown> = { command: 'ls' }): FoldEntry {
  return { id: `r${n}`, kind: 'result', at: AT, tool, input, text, isError: false };
}

const NOTICE = 'Call again with an id (and message: n) for the full text.';
const PASS = 'Pass an id (f12, r87) or a query.';

describe('readFold', () => {
  it('reads a part and a result', async () => {
    const store = memoryStore();
    const p = part(1, ['alpha']);
    const r = result(2, 'out');
    put(store, p);
    put(store, r);
    expect(await readFold(store, DIR, 'f1')).toEqual(p);
    expect(await readFold(store, DIR, 'r2')).toEqual(r);
  });

  it('is undefined for a missing fold', async () => {
    expect(await readFold(memoryStore(), DIR, 'f2')).toBeUndefined();
  });

  it('is undefined for a file that is not JSON', async () => {
    const store = memoryStore();
    store.files.set(`${DIR}/f3.json`, 'not json');
    expect(await readFold(store, DIR, 'f3')).toBeUndefined();
  });

  it('is undefined without a part or result kind', async () => {
    const store = memoryStore();
    store.files.set(`${DIR}/f4.json`, JSON.stringify({ id: 'f4', kind: 'note' }));
    expect(await readFold(store, DIR, 'f4')).toBeUndefined();
  });

  it('is undefined for an id outside FOLD_ID', async () => {
    const store = memoryStore();
    store.files.set(`${DIR}/../f1.json`, JSON.stringify(part(1, ['x'])));
    expect(await readFold(store, DIR, '../f1')).toBeUndefined();
    expect(await readFold(store, DIR, 'f0')).toBeUndefined();
  });

  it('is undefined when the store fails', async () => {
    expect(await readFold(broken, DIR, 'f1')).toBeUndefined();
  });
});

describe('listFolds', () => {
  it('lists the readable folds and skips the other files', async () => {
    const store = memoryStore();
    put(store, part(1, ['a']));
    put(store, part(10, ['b']));
    put(store, result(2, 'c'));
    store.files.set(`${DIR}/notes.txt`, 'notes');
    store.files.set(`${DIR}/f0.json`, JSON.stringify(part(0, ['d'])));
    store.files.set(`${DIR}/f1.json.bak`, JSON.stringify(part(1, ['e'])));
    store.files.set(`${DIR}/f3.json`, 'not json');
    const ids = (await listFolds(store, DIR)).map((entry) => entry.id).sort();
    expect(ids).toEqual(['f1', 'f10', 'r2']);
  });

  it('is empty for a directory with no folds', async () => {
    expect(await listFolds(memoryStore(), DIR)).toEqual([]);
  });

  it('is empty when the store fails', async () => {
    expect(await listFolds(broken, DIR)).toEqual([]);
  });
});

describe('searchFolds', () => {
  const sample: FoldEntry[] = [
    part(1, ['alpha only here']),
    part(2, ['alpha and beta together']),
    part(3, ['beta alone', 'alpha beta']),
  ];

  it('orders hits by score, then by fold number, then by message', () => {
    const hits = searchFolds(sample, 'alpha beta');
    expect(hits.map((hit) => [hit.id, hit.message, hit.score])).toEqual([
      ['f3', 1, 3],
      ['f2', 0, 2],
      ['f3', 0, 1],
      ['f1', 0, 1],
    ]);
  });

  it('matches case-insensitively and finds nothing for a blank query', () => {
    expect(searchFolds(sample, 'ALPHA')).toHaveLength(3);
    expect(searchFolds(sample, '   ')).toEqual([]);
  });

  it('cuts the hits to the limit, SEARCH_HITS by default', () => {
    expect(searchFolds(sample, 'alpha beta', 2)).toHaveLength(2);
    const many = Array.from({ length: 6 }, (_, i) => part(i + 1, ['alpha']));
    expect(searchFolds(many, 'alpha')).toHaveLength(SEARCH_HITS);
  });

  it('cuts the snippet 300 characters each side of the match, with ellipses', () => {
    const text = `${'a'.repeat(400)} needle ${'b'.repeat(400)}`;
    const hits = searchFolds([result(3, text)], 'needle');
    expect(hits).toEqual([{ id: 'r3', score: 1, snippet: `…${'a'.repeat(299)} needle ${'b'.repeat(299)}…` }]);
    expect('message' in hits[0]).toBe(false);
  });
});

describe('unfold', () => {
  it('asks for an id or a query', async () => {
    const store = memoryStore();
    const error = { text: PASS, isError: true, hits: 0 };
    expect(await unfold({}, store, DIR)).toEqual(error);
    expect(await unfold({ query: '   ' }, store, DIR)).toEqual(error);
    expect(await unfold({ id: 3 }, store, DIR)).toEqual(error);
    expect(await unfold(undefined, store, DIR)).toEqual(error);
  });

  it('answers an id outside FOLD_ID or a missing fold', async () => {
    const store = memoryStore();
    expect(await unfold({ id: 'x1' }, store, DIR)).toEqual({
      text: 'No fold x1 in this session.',
      isError: true,
      hits: 0,
    });
    expect(await unfold({ id: 'f9' }, store, DIR)).toEqual({
      text: 'No fold f9 in this session.',
      isError: true,
      hits: 0,
    });
    expect(await unfold({ id: 'f9', query: 'a' }, store, DIR)).toEqual({
      text: 'No fold f9 in this session.',
      isError: true,
      hits: 0,
    });
  });

  it('reads a part: its line, then its messages', async () => {
    const store = memoryStore();
    put(store, {
      id: 'f1',
      kind: 'part',
      at: AT,
      line: 'fixed the parser',
      messages: [
        user('fix the parser'),
        {
          role: 'assistant',
          text: 'done',
          toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: 'src/a.ts' } }],
          toolResults: [{ tool_use_id: 't1', text: 'ok' }],
        },
      ],
    });
    expect(await unfold({ id: 'f1' }, store, DIR)).toEqual({
      text: 'f1 · fixed the parser\n[0] USER:\nfix the parser\n\n[1] ASSISTANT:\ndone\n→ Edit {"file_path":"src/a.ts"}\n← ok',
      isError: false,
      hits: 1,
    });
  });

  it('caps each tool result of a part at UNFOLD_PART_CHARS', async () => {
    const store = memoryStore();
    put(store, {
      id: 'f1',
      kind: 'part',
      at: AT,
      line: 'long output',
      messages: [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(5000) }] }],
    });
    const { text } = await unfold({ id: 'f1' }, store, DIR);
    expect(text).toContain(`${'x'.repeat(UNFOLD_PART_CHARS)} […${5000 - UNFOLD_PART_CHARS} chars cut]`);
    expect(text).not.toContain('x'.repeat(UNFOLD_PART_CHARS + 1));
  });

  it('shows the messages that fit in UNFOLD_CHARS and names the ones left out', async () => {
    const store = memoryStore();
    // Each block is 10010 characters: five fit in 60000, the sixth does not.
    put(store, part(1, Array.from({ length: 8 }, () => 'x'.repeat(10000))));
    const answer = await unfold({ id: 'f1' }, store, DIR);
    expect(answer.isError).toBe(false);
    expect(answer.hits).toBe(1);
    expect(answer.text).toContain('[4] USER:');
    expect(answer.text).not.toContain('[5] USER:');
    expect(answer.text.length).toBeLessThanOrEqual(UNFOLD_CHARS + 'f1 · part 1\n'.length);
    expect(answer.text.endsWith('\n\n[messages 5–7 not shown: ask for one with message: n]')).toBe(true);
  });

  it('shows the whole part, nothing capped, with full: true', async () => {
    const store = memoryStore();
    put(store, {
      id: 'f1',
      kind: 'part',
      at: AT,
      line: 'long output',
      messages: [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'y'.repeat(5000) }] }],
    });
    const { text } = await unfold({ id: 'f1', full: true }, store, DIR);
    expect(text).toContain('y'.repeat(5000));
    expect(text).not.toContain('chars cut');
  });

  it('returns one message in full with message: n', async () => {
    const store = memoryStore();
    put(store, {
      id: 'f1',
      kind: 'part',
      at: AT,
      line: 'part 1',
      messages: [
        user('first'),
        { role: 'user', text: 'second', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'y'.repeat(5000) }] },
      ],
    });
    const answer = await unfold({ id: 'f1', message: 1 }, store, DIR);
    expect(answer.isError).toBe(false);
    expect(answer.hits).toBe(1);
    expect(answer.text.startsWith('f1 · part 1\n[1] USER:\nsecond\n← ')).toBe(true);
    expect(answer.text).toContain('y'.repeat(5000));
    expect(answer.text).not.toContain('chars cut');
    expect(answer.text).not.toContain('first');
  });

  it('answers a message out of range with the range of the part', async () => {
    const store = memoryStore();
    put(store, part(1, ['a', 'b']));
    const error = { text: 'Fold f1 has messages 0–1.', isError: true, hits: 0 };
    expect(await unfold({ id: 'f1', message: 2 }, store, DIR)).toEqual(error);
    expect(await unfold({ id: 'f1', message: -1 }, store, DIR)).toEqual(error);
    expect(await unfold({ id: 'f1', message: 1.5 }, store, DIR)).toEqual(error);
    expect(await unfold({ id: 'f1', message: '1' }, store, DIR)).toEqual(error);
  });

  it('reads a result in full, ignoring message and full', async () => {
    const store = memoryStore();
    put(store, result(1, 'file.txt'));
    const expected = { text: 'r1 · Bash {"command":"ls"}\nfile.txt', isError: false, hits: 1 };
    expect(await unfold({ id: 'r1' }, store, DIR)).toEqual(expected);
    expect(await unfold({ id: 'r1', message: 5, full: true }, store, DIR)).toEqual(expected);
  });

  it('cuts a result beyond UNFOLD_FULL_CHARS', async () => {
    const store = memoryStore();
    put(store, result(1, 'z'.repeat(UNFOLD_FULL_CHARS + 10)));
    const { text } = await unfold({ id: 'r1' }, store, DIR);
    expect(text.endsWith(`${'z'.repeat(UNFOLD_FULL_CHARS)} […10 chars cut]`)).toBe(true);
  });

  it('searches every fold by score, then by fold number', async () => {
    const store = memoryStore();
    put(store, part(1, ['alpha only here']));
    put(store, part(2, ['alpha and beta together']));
    put(store, part(3, ['beta alone', 'alpha beta']));
    expect(await unfold({ query: 'alpha beta' }, store, DIR)).toEqual({
      text: `f3 [1] alpha beta\n\nf2 [0] alpha and beta together\n\nf3 [0] beta alone\n\nf1 [0] alpha only here\n\n${NOTICE}`,
      isError: false,
      hits: 4,
    });
  });

  it('searches only the given fold with an id and a query', async () => {
    const store = memoryStore();
    put(store, part(1, ['alpha only here']));
    put(store, part(2, ['alpha and beta together']));
    expect(await unfold({ id: 'f2', query: 'alpha' }, store, DIR)).toEqual({
      text: `f2 [0] alpha and beta together\n\n${NOTICE}`,
      isError: false,
      hits: 1,
    });
  });

  it('searches result folds without a message', async () => {
    const store = memoryStore();
    put(store, result(1, 'fatal: not a git repository'));
    expect(await unfold({ query: 'git repository' }, store, DIR)).toEqual({
      text: `r1 fatal: not a git repository\n\n${NOTICE}`,
      isError: false,
      hits: 1,
    });
  });

  it('answers a query with no hit as no error', async () => {
    const store = memoryStore();
    put(store, part(1, ['alpha']));
    expect(await unfold({ query: 'zzz' }, store, DIR)).toEqual({
      text: 'Nothing folded in this session matches "zzz".',
      isError: false,
      hits: 0,
    });
  });

  it('skips a file that is not JSON when searching', async () => {
    const store = memoryStore();
    put(store, part(1, ['alpha']));
    store.files.set(`${DIR}/f9.json`, 'not json');
    expect((await unfold({ query: 'alpha' }, store, DIR)).hits).toBe(1);
  });

  it('never rejects when the store fails', async () => {
    expect(await unfold({ id: 'f1' }, broken, DIR)).toEqual({
      text: 'No fold f1 in this session.',
      isError: true,
      hits: 0,
    });
    expect(await unfold({ query: 'x' }, broken, DIR)).toEqual({
      text: 'Nothing folded in this session matches "x".',
      isError: false,
      hits: 0,
    });
  });
});
