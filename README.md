# context-fold

A Claude Code plugin that folds finished work out of a session instead of
summarizing it away. The folded messages go to files, a short state and one
line per part stay in the context, and Claude reads any part back when it
needs it. The recent work stays verbatim.

- **At a compaction**, a small model (Haiku by default) finds the part of
  the session that is finished and folds it. Old tool results are shortened
  and stored the same way.
- **During the session**, the tool `mcp__context-fold__unfold` returns a
  folded part or a stored tool result, or searches all of them.
- **As each turn closes** (optional, `foldTurns`), the turn's tool calls and
  results are folded at once. The messages before the turn are not touched,
  so their prompt cache is reused.
- **Jev** (optional, `useJev`), TypeSafe's System One model, can make the
  choices instead of Haiku.

The plugin was called `fast-jev-compaction` up to version 0.10.3. See
[Moving from fast-jev-compaction](#moving-from-fast-jev-compaction).

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
   `preserveRecentMessages` messages, it shortens every result before them.
   When this cuts at least `minReductionRatio` of the text, the result
   stands. Up to `smallContextChars` characters it stands however little it
   cuts, because a fold of a small context costs more time than it saves.
3. **Older part.** When shortening cuts too little, the plugin folds the
   oldest `summarizeShare` of the text. The cut falls before an assistant
   message, so no tool call is split from its result, and never inside the
   newest `preserveRecentMessages` messages.
4. **Built-in compact.** When none of the steps above applies, or a step
   fails, Claude Code's own compact summarizes the whole session.

### Folds

A fold moves old messages out of the context without losing them:

- The original messages go to
  `~/.claude/context-fold/folds/<session>/f<n>.json`, one file per part. A
  part is a turn; a turn over 40,000 characters is split.
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

The plugin registers the tool `mcp__context-fold__unfold` when the session
gets its first fold. With `foldTurns` on it registers the tool at the start
of the session, because a tool added later rewrites the whole prompt cache
once.

- `id: "f12"` returns the part's original messages, with tool inputs and
  results clipped to 2,000 characters; `message: 7` returns one message in
  full, `full: true` the whole part.
- `id: "r87"` returns a tool result in full.
- `query: "words or a path"` searches the text of every fold of the session
  and returns up to five passages with their ids.

The tool finds the folder from the session id the engine reports, not from
its arguments, so a session reads only its own folds. A session resumed or
forked under a new id does not see the folds of the original one. The folds
hold the text of your sessions, as the transcripts under
`~/.claude/projects` do, and the plugin does not delete them.

### After a compaction

- **Your next prompt.** The text after a manual `/compact` is also the next
  prompt. The plugin submits it, as your own words, once the compaction is
  done. After an automatic compaction started by `compactAtPercent`, the
  plugin submits a short resume prompt instead, unless `resumeAfterCompact`
  is off.
- **Reply language.** Claude Code sends the reply-language rule (the
  `language` setting) once per session, and a compaction can summarize it
  away. When `language` is set, the plugin adds the rule as a short note at
  the end of the compacted conversation.
- **Project rules.** Claude Code re-attaches `CLAUDE.md` after every
  compact, but the decision files it points to are read as tool results,
  and a summary drops their text. With `rulesFiles` set, the plugin adds a
  note with the introduction of each rule file and an index of every
  section, so Claude knows what to re-read. With `useJev` on, the note also
  holds, in full, the 1–2 sections Jev picks for the work in progress. A
  file that is missing in a project is skipped, so one setting can serve
  several projects:

  ```sh
  printf '{"rulesFiles":"CLAUDE.md, docs/decisioni/*.md"}' | claude plugin configure context-fold@context-fold --values-stdin
  ```

  The note is about 1,250 tokens for a project with five rule files and 100
  sections. On 86 labelled compactions of three projects, Jev's first pick
  was a section the following work needed in 84% of the cases. The
  benchmark is in `examples/rules/`.

## Folding turns as they close

Off by default. With `foldTurns` on, the plugin does not wait for the
context to fill. When a turn ends and its tool calls and results hold at
least `foldTurnMinChars` characters (20,000 by default), it stores them as a
fold `f<n>` and leaves:

- the request, as it was;
- the turn's first tool call, as it was, with one note as its result: the
  fold id and one line per call of the turn (tool, target, size);
- the final answer, as it was.

No model is asked: the note is built from the calls themselves.

The messages before the turn are handed back untouched, so their prompt
cache is reused and only the short tail is written again. Two details of
the shape come from measurements:

- The first call stays so the conversation still shows that the answer came
  from tool work. In a test with every call removed, the model answered the
  next request without calling a tool.
- The note is the result of that call, not a message of its own. A message
  added right after the request changes how the request is sent, and the
  cache then stops before it.

Measured on real sessions with Haiku, six turns, four of them reading
24,000-token files, cache tokens taken from each response:

| Session | `foldTurns` | Context at the end | Read from cache after a fold | Written after a fold |
| --- | --- | --- | --- | --- |
| Desktop app's engine (2.1.330, SDK mode) | off | 158,698 tokens | n/a | n/a |
| Desktop app's engine (2.1.330, SDK mode) | on | 41,098 tokens | 39,518 to 40,661 | 345 to 706 |
| Terminal (2.1.312, five turns) | off | 109,299 tokens | n/a | n/a |
| Terminal (2.1.312, five turns) | on | 38,679 tokens | 37,543 to 38,386 | 228 to 472 |

How the fold starts depends on the session:

- In the terminal the plugin asks the engine for a compaction
  (`$.session.compact()`).
- In the desktop app and other SDK sessions the engine refuses that call,
  so the plugin runs the `/compact` command itself. The transcript then
  shows `/compact` and `Compacted` after each folded turn, and the session
  reports one more, empty, result.

A compaction the plugin asked for folds the turn or is skipped. It never
goes on to a full compaction.

What it costs:

- A folded result is no longer in the context. In the terminal test the
  fourth turn asked for two files read earlier: with `foldTurns` on the
  model read them again (47,784 tokens written), with it off it answered
  from the context.
- Each fold shows as a compaction in the transcript.
- A turn is folded only when it ends. A long autonomous turn is not folded
  halfway.

Not measured yet: long sessions, models other than Haiku, and how the
desktop app's window shows the extra `/compact` lines.

## Jev

Off by default, even when a key is set. With `useJev` on, Jev makes three
choices in place of the summary model and the fixed rules:

- the turn where the current work starts (the Choice `topic_start`);
- which old tool results are shortened, instead of all those in the older
  part (`keepThreshold` is the cut);
- the 1–2 project rule sections re-added in full.

When Jev does not answer (no credit, a network error), the plugin does what
it does with Jev off, in the same compaction. After a 402 reply (no credit)
it skips Jev for one hour.

Turn it on:

```sh
printf '{"useJev":"true"}' | claude plugin configure context-fold@context-fold --values-stdin
```

Jev needs a TypeSafe API key. Store it in the plugin's secrets, without
showing it on screen:

```sh
read -rs "k?TypeSafe key: " && printf '{"apiKey":"%s"}' "$k" | claude plugin configure context-fold@context-fold --values-stdin; unset k
```

Without the `apiKey` option, the plugin reads `TYPESAFE_API_KEY` from the
environment, then from the `env` section of `~/.claude/settings.json`. The
desktop app does not read `~/.zshrc`, so a key exported there does not reach
it.

## Install

The plugin needs Claude Code with function hooks (2.1.301 or later). On
builds where function hooks are behind a flag, set it in
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Install from GitHub:

```sh
claude plugin marketplace add adapt-to-it/context-fold
claude plugin install context-fold@context-fold
```

To work on the plugin, install it from a local checkout instead. Claude Code
then reads the folder itself, and `/reload-plugins` applies a change without
a restart:

```sh
claude plugin marketplace add ~/context-fold
claude plugin install context-fold@context-fold
```

Removing the marketplace deletes the plugin's saved options and secrets.

### Moving from fast-jev-compaction

The new name is a clean break. Nothing written under the old name is read:

- the options and the key saved for `fast-jev-compaction` are not carried
  over: set them again with `claude plugin configure`;
- the folds and logs under `~/.claude/fast-jev-compaction/` stay where they
  are, and a session opened before the change no longer reads its folds;
- the notes that start with `[fast-jev-compaction]` in an open session are
  read as ordinary text.

Finish or close the open sessions, then replace the plugin:

```sh
claude plugin uninstall fast-jev-compaction@fast-jev-compaction
claude plugin marketplace remove fast-jev-compaction
claude plugin marketplace add adapt-to-it/context-fold
claude plugin install context-fold@context-fold
```

## Options

Set them with `claude plugin configure context-fold@context-fold`.

Compaction:

| Option | Default | Description |
| --- | --- | --- |
| `summaryModel` | `haiku` | Model that writes the folds and, without Jev, finds finished topics; empty: the built-in compact writes the state |
| `pruneTopics` | `true` | Looks for finished topics (step 1) |
| `topicThreshold` | `0.8` | Minimum probability that the current topic started after a turn |
| `minReductionRatio` | `0.25` | Minimum share of the text a step must cut |
| `smallContextChars` | `100000` | Up to this size, shortened results stand however little they cut |
| `summarizeShare` | `0.75` | Share of the text that counts as the older part (steps 2 and 3) |
| `preserveRecentMessages` | `6` | Newest messages never folded or shortened |
| `truncateHeadChars` | `300` | Characters kept from a shortened tool result |
| `compactAtPercent` | `0` | Context percentage at which the plugin compacts at the end of a turn; 0 leaves the timing to Claude Code |
| `resumeAfterCompact` | `true` | Submits a resume prompt after a compaction started by `compactAtPercent` |
| `rulesFiles` | empty | Rule files re-added after a summary, comma-separated; `dir/*.md` takes a folder |

Turn folds:

| Option | Default | Description |
| --- | --- | --- |
| `foldTurns` | `false` | Folds a turn's tool calls and results when the turn ends |
| `foldTurnMinChars` | `20000` | Smallest size of a turn's tool calls and results that is folded |

Jev:

| Option | Default | Description |
| --- | --- | --- |
| `useJev` | `false` | Lets Jev pick the topics, the results to shorten and the rules; off even with a key set |
| `apiKey` | unset | TypeSafe API key, read with `useJev` on; unset reads `TYPESAFE_API_KEY` |
| `model` | `jev-1.13.0` | Jev model |
| `keepThreshold` | `0.5` | Minimum Jev probability that a tool result is still needed; below it the result is shortened |
| `maxStateTokens` | `25000` | Estimated token budget for the state sent to Jev |
| `maxRequestTokens` | `30000` | Estimated token budget for one Jev request |

Log:

| Option | Default | Description |
| --- | --- | --- |
| `decisionLog` | `false` | Writes the records described under [Decision log](#decision-log) |
| `logDir` | unset | Log folder; unset is `~/.claude/context-fold/logs` |

`lastingThreshold` is still declared for the library. The plugin does not
use it.

## Decision log

With `decisionLog` on, the plugin writes JSON records to
`~/.claude/context-fold/logs/<session>/`:

| File | Written | Holds |
| --- | --- | --- |
| `<time>-<trigger>.json` | at every compaction | the trigger, the outcome (`applied`, `summarized`, `fallback`, `error`), the cut point, the score of each turn, the files of the folded part, the summary model with its time (`summaryMs`), characters read (`summarizedChars`) and output tokens (`summaryOutputTokens`), and the fold ids (`folds`) |
| `<time>-turn-fold.json` | at every turn fold | the fold id, the messages it covered, their characters, the number of calls and how it started (`via`: `engine` or `command`) |
| `<time>-turn-fold-error.json` | when a turn fold fails | the error; the turn stays as it was |
| `<time>-unfold.json` | at every `unfold` call | the id or the query and the number of hits; a search with no hit shows where the index lines were not enough |
| `<time>-cache.json` | at the first request after a compaction or a turn fold | the tokens that request read from the prompt cache, wrote to it and sent uncached (`first`), next to those of the last request before it (`before`) |

A fold that kept the cache shows a `first.read` close to the size of the
context it left and a small `first.written`. To read these numbers, the
plugin follows every model response of the main conversation while the log
is on.

The log is off by default because the records hold request texts and tool
inputs from your sessions. The plugin never writes its API key there. If you
turn the log on, keep the folder private:

```sh
printf '{"decisionLog":"true"}' | claude plugin configure context-fold@context-fold --values-stdin
```

## Timings

Measured on 45 compactions of real sessions, 22–24 October 2026, with
contexts of about 370,000 tokens:

| Step | Compactions | Time |
| --- | --- | --- |
| Shortened tool results | 21 | about 1 s |
| Finished topics, summarized by Haiku | 17 | 12–20 s |
| Older part, summarized by Haiku | 7 | 12–47 s |

The built-in compact took 36–78 s on the same sessions before. These
timings predate the folds: steps 1 and 3 wrote a full summary then, with
Jev on. A turn fold asks no model and took 11–24 ms in the test above.

## Library

`src/` is an npm-style TypeScript library that runs without the engine:

- `src/fold.ts` writes the folds, `src/unfold.ts` reads and searches them,
  `src/turn-fold.ts` folds a closed turn. All three work through a
  `FoldStore`; `src/fold-spec.ts` holds their types and limits.
- `src/plan.ts` holds the topic and cut logic: `planTopics()`,
  `olderPartCut()`, `touchedFiles()`.
- `src/compact.ts` shortens tool results (`shortenResults()`), and still
  holds the original design: `compact()` and `compactMessages()` score tool
  calls and results with Jev and drop or shorten the stale ones. The plugin
  calls it with `resultsOnly: true`, which only shortens results.

## Development

```sh
npm install
npm run typecheck
npm test
claude plugin validate .
```

The unit tests use a fake Jev and never contact TypeSafe.
`npm run demo` runs a live request and needs `TYPESAFE_API_KEY`.
`demo/JevDemo` is the SwiftUI app of the original project, which plays a
scripted compaction for screen recordings; it still shows the old name.

## Credits

This project started as a fork of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
by Tamara Tran. Her version replaced the compaction summary with Jev
decisions: it scored every tool call and result, dropped the stale ones and
kept everything else verbatim. The Jev client, the state fitting, the
token estimates, the tool-call scoring library in `src/` and the demo app
come from her work. Thank you, Tamara.

This project has since taken a different direction, and a different name:
it folds old, finished work and keeps the rest as it is, and Jev is an
option. Report issues here, not upstream.

## License

MIT, as the original project. See [LICENSE](LICENSE).
