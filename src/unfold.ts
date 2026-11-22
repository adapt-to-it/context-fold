import { renderMessage } from './render.js';
import { truncate } from './state.js';
import {
  FOLD_ID,
  SEARCH_HITS,
  SNIPPET_CHARS,
  UNFOLD_CHARS,
  UNFOLD_FULL_CHARS,
  UNFOLD_PART_CHARS,
} from './fold-spec.js';
import type {
  FoldEntry,
  FoldHit,
  ListFolds,
  ReadFold,
  SearchFolds,
  Unfold,
  UnfoldAnswer,
} from './fold-spec.js';
import type { Message } from './types.js';

type PartFold = Extract<FoldEntry, { kind: 'part' }>;
type ResultFold = Extract<FoldEntry, { kind: 'result' }>;

/** The stored fold of `id`; undefined when it is missing, unreadable, not JSON or has no known kind. */
export const readFold: ReadFold = async (store, dir, id) => {
  if (!FOLD_ID.test(id)) return undefined;
  let text: string | undefined;
  try {
    text = await store.read(`${dir}/${id}.json`);
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const kind = typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined;
  return kind === 'part' || kind === 'result' ? (value as FoldEntry) : undefined;
};

/** Every readable fold of `dir` whose file name is `<FOLD_ID>.json`; none when the folder cannot be listed. */
export const listFolds: ListFolds = async (store, dir) => {
  let names: string[];
  try {
    names = await store.list(dir);
  } catch {
    return [];
  }
  const ids = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => FOLD_ID.test(id));
  const entries = await Promise.all(ids.map((id) => readFold(store, dir, id)));
  return entries.filter((entry): entry is FoldEntry => entry !== undefined);
};

/** The text a message is searched by: its text, each tool input as JSON, each tool result text. */
const messageText = (message: Message): string =>
  [
    message.text,
    ...message.toolUses.map((use) => JSON.stringify(use.input)),
    ...(message.toolResults ?? []).map((result) => result.text),
  ].join('\n');

export const searchFolds: SearchFolds = (entries, query, limit = SEARCH_HITS) => {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  const whole = terms.join(' ');
  const found: { hit: FoldHit; num: number; index: number }[] = [];
  for (const entry of entries) {
    const num = Number(entry.id.slice(1));
    const units: { message?: number; text: string }[] =
      entry.kind === 'part'
        ? entry.messages.map((message, index) => ({ message: index, text: messageText(message) }))
        : [{ text: entry.text }];
    for (const unit of units) {
      const lower = unit.text.toLowerCase();
      let score = terms.filter((term) => lower.includes(term)).length;
      if (terms.length > 1 && lower.includes(whole)) score++;
      if (score === 0) continue;
      const needle = lower.includes(whole) ? whole : (terms.find((term) => lower.includes(term)) ?? '');
      const start = lower.indexOf(needle);
      const from = Math.max(0, start - SNIPPET_CHARS);
      const to = Math.min(unit.text.length, start + needle.length + SNIPPET_CHARS);
      let snippet = unit.text.slice(from, to).replace(/\s+/g, ' ').trim();
      if (from > 0) snippet = `…${snippet}`;
      if (to < unit.text.length) snippet = `${snippet}…`;
      const hit: FoldHit = { id: entry.id, score, snippet };
      if (unit.message !== undefined) hit.message = unit.message;
      found.push({ hit, num, index: unit.message ?? 0 });
    }
  }
  found.sort((a, b) => b.hit.score - a.hit.score || b.num - a.num || a.index - b.index);
  return found.slice(0, limit).map((item) => item.hit);
};

/** `text` cut to `limit` characters, the cut counted in the suffix. */
const clipAt = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)} […${text.length - limit} chars cut]`;

const answerError = (text: string): UnfoldAnswer => ({ text, isError: true, hits: 0 });

const searchAnswer = (entries: readonly FoldEntry[], query: string): UnfoldAnswer => {
  const hits = searchFolds(entries, query);
  if (hits.length === 0) {
    return { text: `Nothing folded in this session matches "${query}".`, isError: false, hits: 0 };
  }
  const blocks = hits.map((hit) => `${hit.id}${hit.message === undefined ? '' : ` [${hit.message}]`} ${hit.snippet}`);
  return {
    text: `${blocks.join('\n\n')}\n\nCall again with an id (and message: n) for the full text.`,
    isError: false,
    hits: hits.length,
  };
};

const resultAnswer = (entry: ResultFold): UnfoldAnswer => {
  const head = `${entry.id} · ${entry.tool} ${truncate(JSON.stringify(entry.input), 200)}`;
  return { text: `${head}\n${clipAt(entry.text, UNFOLD_FULL_CHARS)}`, isError: false, hits: 1 };
};

const partAnswer = (entry: PartFold, message: unknown, full: boolean): UnfoldAnswer => {
  const head = `${entry.id} · ${entry.line}`;
  const last = entry.messages.length - 1;
  if (message !== undefined) {
    const index = typeof message === 'number' && Number.isInteger(message) ? message : -1;
    const target = entry.messages[index];
    if (target === undefined) {
      return answerError(`Fold ${entry.id} has messages 0–${last}.`);
    }
    const text = renderMessage(target, index, UNFOLD_FULL_CHARS);
    return { text: `${head}\n${clipAt(text, UNFOLD_FULL_CHARS)}`, isError: false, hits: 1 };
  }
  const cap = full ? UNFOLD_FULL_CHARS : UNFOLD_PART_CHARS;
  const budget = full ? UNFOLD_FULL_CHARS : UNFOLD_CHARS;
  let body = '';
  let shown = 0;
  for (const [i, part] of entry.messages.entries()) {
    const block = renderMessage(part, i, cap);
    const next = shown === 0 ? block : `${body}\n\n${block}`;
    if (shown > 0 && next.length > budget) break;
    body = next;
    shown++;
  }
  let text = body === '' ? head : `${head}\n${body}`;
  if (shown < entry.messages.length) {
    text += `\n\n[messages ${shown}–${last} not shown: ask for one with message: n]`;
  }
  return { text, isError: false, hits: 1 };
};

export const unfold: Unfold = async (input, store, dir) => {
  const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const id = typeof args.id === 'string' && args.id.trim() !== '' ? args.id : undefined;
  const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : undefined;
  if (id === undefined) {
    if (query === undefined) return answerError('Pass an id (f12, r87) or a query.');
    return searchAnswer(await listFolds(store, dir), query);
  }
  const entry = FOLD_ID.test(id) ? await readFold(store, dir, id) : undefined;
  if (entry === undefined) return answerError(`No fold ${id} in this session.`);
  if (query !== undefined) return searchAnswer([entry], query);
  if (entry.kind === 'result') return resultAnswer(entry);
  return partAnswer(entry, args.message, args.full === true);
};
