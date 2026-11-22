# fast-jev-compaction (adapt-to-it fork)

A Claude Code plugin that makes compaction faster and keeps the recent
work verbatim. A small model (Haiku by default) finds which part of a
session is finished and folds it: the original messages go to disk, a short
state and one line per part stay in the context, and Claude can read any
part back. Jev, TypeSafe's System One model, can make the choices instead;
it is off by default.

## Credits

This project started as a fork of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
by Tamara Tran. Her version replaced the compaction summary with Jev
decisions: it scored every tool call and result, dropped the stale ones and
kept everything else verbatim. The Jev client, the state fitting, the
token estimates, the tool-call scoring library in `src/` and the demo app
come from her work. Thank you, Tamara.

This fork has since taken a different direction. It no longer deletes tool
calls or turns from the plugin's output. It folds old, finished work
and keeps the rest as it is. The two projects now solve the problem in
different ways. Report issues with this fork here, not upstream.

## How a compaction works

On every `/compact` and every automatic compaction, the plugin runs these
steps in order and stops at the first one that applies:

1. **Finished topics.** The plugin splits the session into turns: a user
   request and the replies up to the next request. `summaryModel` reads the
   requests, one per turn, and picks the turn where the current work starts.
   The reference is the text you write after `/compact`, or else your latest
   requests. When the turns before that point hold at least
   `minReductionRatio` of the text, the plugin folds them and keeps the
   later turns verbatim.
2. **Shortened tool results.** With no finished topic, the plugin shortens
   the tool results in the oldest `summarizeShare` of the text and keeps
   every call and every text. When that share ends among the newest
   `preserveRecentMessages` messages, it shortens every result before them. When this cuts at least `minReductionRatio`
   of the text, the result stands. Up to `smallContextChars` characters it
   stands however little it cuts, because a fold of a small context costs
   more time than it saves.
3. **Older part.** When shortening cuts too little, the plugin folds the
   oldest `summarizeShare` of the text. The cut falls before an assistant
   message, so no tool call is split from its result, and never inside the
   newest `preserveRecentMessages` messages.
4. **Built-in compact.** When none of the steps above applies, or a step
   fails, Claude Code's own compact summarizes the whole session.

### Folds

A fold moves old messages out of the context without losing them:

- The original messages go to
  `~/.claude/fast-jev-compaction/folds/<session>/f<n>.json`, one file per
  part. A part is a turn; a turn over 40,000 characters is split.
- `summaryModel` (default `haiku`) writes, in one request, a short state
  (the rules you set, the decisions in force, the open points) and one line
  per part. It reads the part with its old tool results already shortened,
  through the session's own credentials, with low effort and a 16,000-token
  reply cap, and writes in the language the user writes in.
- The context keeps the state, a "Folded parts" note with one line per part
  (`f12 · what was asked and what came of it`), and one line per file the
  folded part used, `<path> <name> "write|read|mentioned"`.
- A later fold carries the earlier lines over as they are, so the ids stay
  valid.

When the summary model does not answer, the built-in compact writes the
state and each part takes its request as its line. When the folds cannot be
written, the built-in compact summarizes the part and nothing is folded.

A shortened tool result is stored the same way, as `r<n>.json`, and its
note names the id.

### Reading a fold back

The plugin registers the tool `mcp__fast-jev-compaction__unfold` when the
session gets its first fold, or at the start with `foldTurns` on (a tool
added later rewrites the whole prompt cache once):

- `id: "f12"` returns the part's original messages, with tool inputs and
  results clipped to 2,000 characters; `message: 7` returns one message in
  full, `full: true` the whole part.
- `id: "r87"` returns a tool result in full.
- `query: "words or a path"` searches the text of every fold of the session
  and returns up to five passages with their ids.

The tool finds the folder from the session id the engine reports, not from
its arguments, so a session reads only its own folds. The folds hold the
text of your sessions, as the transcripts under `~/.claude/projects` do, and
the plugin does not delete them.

### Folding turns as they close (optional)

With `foldTurns` on, the plugin does not wait for the context to fill. When
a turn ends and its tool calls and results hold at least `foldTurnMinChars`
characters (20,000 by default), it stores them as a fold `f<n>` and leaves:

- the request, as it was;
- the turn's first tool call, as it was, with one note as its result: the
  fold id and one line per call of the turn (tool, target, size);
- the final answer, as it was.

The messages before the turn are handed back untouched, so their prompt
cache is reused and only the short tail is written again. The first call
stays so the conversation still shows that the answer came from tool work:
in a test with every call removed, the model answered the next request
without calling a tool.

Measured on a real interactive session (Claude Code 2.1.312, Haiku, five
turns that read 24,000-token files, cache tokens taken from each response):

| | Context at the end | Read from cache after a fold | Written after a fold |
| --- | --- | --- | --- |
| `foldTurns` off | 109,299 tokens | n/a | n/a |
| `foldTurns` on | 38,679 tokens | 37,543 to 38,386 | 228 to 472 |

What it costs: a folded result is no longer in the context. In the same
test the fourth turn asked for two files read earlier; with `foldTurns` on
the model read them again (47,784 tokens written), with it off it answered
from the context. Each fold also shows as a compaction in the transcript.
The option is off by default; it has not been measured on long sessions.

### Jev (optional)

`useJev` is off by default, even when a key is set. Turned on, Jev makes
three choices:

- the turn where the current work starts (the Choice `topic_start`);
- which old tool results are shortened, instead of all those in the older
  part;
- the 1–2 project rule sections re-added in full.

When Jev does not answer (no credit, a network error), the plugin does what
it does with Jev off, in the same compaction. After a 402 reply (no credit)
it skips Jev for one hour.

The text after a manual `/compact` is also the next prompt. The plugin
submits it, as your own words, once the compaction is done. After an
automatic compaction, the plugin submits a short resume prompt instead,
unless `resumeAfterCompact` is off.

### Project rules after a summary

Claude Code re-attaches `CLAUDE.md` after every compact, but the decision
files it points to are read as tool results, and a summary drops their text.
With `rulesFiles` set, the plugin adds a note after the summary with:

- with `useJev` on, the 1–2 sections Jev picks for the work in progress, in
  full;
- the introduction of each rule file;
- an index of every section, so Claude knows what to re-read.

Jev picks the sections in one request, while Haiku writes the fold, so the
compaction takes no longer. The note is about 1,250 tokens for a project with
five rule files and 100 sections. A file that is missing in a project is
skipped, so one setting can serve several projects:

```sh
printf '{"rulesFiles":"CLAUDE.md, docs/decisioni/*.md"}' | claude plugin configure fast-jev-compaction@fast-jev-compaction --values-stdin
```

On 86 labelled compactions of three projects, Jev's first pick was a section
the following work needed in 84% of the cases. The index covers the rest.
The benchmark is in `examples/rules/`.

### Typical timings

Measured on 45 compactions of real sessions, 22–24 October 2026, with
contexts of about 370,000 tokens:

| Step | Compactions | Time |
| --- | --- | --- |
| Shortened tool results | 21 | about 1 s |
| Finished topics, summarized by Haiku | 17 | 12–20 s |
| Older part, summarized by Haiku | 7 | 12–47 s |

The built-in compact took 36–78 s on the same sessions before. These
timings predate the folds: steps 1 and 3 wrote a full summary then, with
Jev on.

### Reply language after a compaction

Claude Code sends the reply-language rule (the `language` setting) once per
session. A compaction can summarize it away. When `language` is set, the plugin
adds the rule as a short note at the end of the compacted conversation, so the
next replies keep the language.

## Install

The plugin needs Claude Code with function hooks (2.1.301 or later). On
builds where function hooks are behind a flag, set it in
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Install from GitHub:

```sh
claude plugin marketplace add adapt-to-it/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

To work on the plugin, install it from a local checkout instead. Claude Code
then reads the folder itself, and `/reload-plugins` applies a change without
a restart:

```sh
claude plugin marketplace add ~/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

### TypeSafe key

Jev is off by default. To use it, turn `useJev` on:

```sh
printf '{"useJev":"true"}' | claude plugin configure fast-jev-compaction@fast-jev-compaction --values-stdin
```

Jev needs a TypeSafe API key. Store it in the plugin's secrets, without
showing it on screen:

```sh
read -rs "k?TypeSafe key: " && printf '{"apiKey":"%s"}' "$k" | claude plugin configure fast-jev-compaction@fast-jev-compaction --values-stdin; unset k
```

Without the `apiKey` option, the plugin reads `TYPESAFE_API_KEY` from the
environment, then from the `env` section of `~/.claude/settings.json`. The
desktop app does not read `~/.zshrc`, so a key exported there does not reach
it. Removing the marketplace deletes the plugin's saved options and secrets.

## Options

Set them with `claude plugin configure fast-jev-compaction@fast-jev-compaction`.

| Option | Default | Description |
| --- | --- | --- |
| `useJev` | `false` | Lets Jev pick the topics, the results to shorten and the rules; off even with a key set |
| `apiKey` | unset | TypeSafe API key, read with `useJev` on; unset reads `TYPESAFE_API_KEY` |
| `model` | `jev-1.13.0` | Jev model |
| `pruneTopics` | `true` | Looks for finished topics (step 1) |
| `topicThreshold` | `0.8` | Minimum probability that the current topic started after a turn |
| `minReductionRatio` | `0.25` | Minimum share of the text a step must cut |
| `smallContextChars` | `100000` | Up to this size, shortened results stand however little they cut |
| `summarizeShare` | `0.75` | Share of the text that counts as the older part (steps 2 and 3) |
| `summaryModel` | `haiku` | Model that writes the folds and, without Jev, finds finished topics; empty: the built-in compact writes the state |
| `preserveRecentMessages` | `6` | Newest messages never folded or shortened |
| `truncateHeadChars` | `300` | Characters kept from a shortened tool result |
| `maxStateTokens` | `25000` | Estimated token budget for the state sent to Jev |
| `maxRequestTokens` | `30000` | Estimated token budget for one Jev request |
| `foldTurns` | `false` | Folds a turn's tool calls and results when the turn ends, keeping the messages before it and their prompt cache |
| `foldTurnMinChars` | `20000` | With `foldTurns` on: smallest size of a turn's tool calls and results that is folded |
| `compactAtPercent` | `0` | Context percentage at which the plugin compacts at the end of a turn; 0 leaves the timing to Claude Code |
| `resumeAfterCompact` | `true` | Submits a resume prompt after an automatic compaction |
| `decisionLog` | `false` | Writes one JSON record per compaction, per turn fold and per `unfold` call, and the prompt-cache tokens of the request after each compaction |
| `rulesFiles` | empty | Rule files re-added after a summary, comma-separated; `dir/*.md` takes a folder |
| `logDir` | unset | Log folder; unset is `~/.claude/fast-jev-compaction/logs` |

`keepThreshold` and `lastingThreshold` still exist for the library. The
plugin no longer uses them.

## Decision log

With `decisionLog` on, every compaction writes a JSON record to
`~/.claude/fast-jev-compaction/logs/<session>/<time>-<trigger>.json`. It
holds the trigger, the outcome (`applied`, `summarized`, `fallback`,
`error`), Jev's score for each turn, the cut point, the files of the
summarized part, and for summaries the model, the time
(`summaryMs`), the characters read (`summarizedChars`) and the output
tokens (`summaryOutputTokens`), and the ids of the folds written (`folds`).
Every `unfold` call writes `<time>-unfold.json` with the id or the query and
the number of hits: a search with no hit shows where the index lines were
not enough. A turn fold writes `<time>-turn-fold.json` with the fold id, the
messages it covered, their characters and the number of calls.

After each compaction or turn fold, `<time>-cache.json` holds the tokens
the next request read from the prompt cache, wrote to it and sent uncached
(`first`), next to those of the last request before it (`before`). A fold
that kept the cache shows `first.read` close to `before.read` plus
`before.written`, less what was folded, and a small `first.written`. With
the log on, the plugin follows every model response of the main
conversation to read these numbers.

The log is off by default because the records hold request texts and tool
inputs from your sessions. The plugin never writes its API key there. If you
turn the log on, keep the folder private:

```sh
printf '{"decisionLog":"true"}' | claude plugin configure fast-jev-compaction@fast-jev-compaction --values-stdin
```

## Library

`src/` is still an npm-style TypeScript library. `compact()` and
`compactMessages()` score tool calls and results with Jev and drop or
shorten the stale ones, as in the upstream design. The plugin calls it with
`resultsOnly: true`, which only shortens results. `planTopics()`,
`olderPartCut()` and `touchedFiles()` in `src/plan.ts` hold the plugin's
topic and cut logic. `src/fold.ts` writes the folds and `src/unfold.ts`
reads and searches them, both through a `FoldStore`, so they run without
the engine.

## Development

```sh
npm install
npm run typecheck
npm test
claude plugin validate .
```

The unit tests use a fake Jev and never contact TypeSafe.
`npm run demo` runs a live request and needs `TYPESAFE_API_KEY`.
`demo/JevDemo` is the upstream SwiftUI app that plays a scripted compaction
for screen recordings.

## License

MIT, as upstream. See [LICENSE](LICENSE).
