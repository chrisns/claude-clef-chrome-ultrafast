# clef-chrome

clef-chrome is a Claude Code mod that makes Claude-in-Chrome faster and cheaper. Claude still plans the work. A local Ollama decision model, `clef-flash`, makes the small decisions:

- which page element a step means;
- whether a step worked.

When the local model is not sure, the decision goes back to Claude.

## Why it helps

Most of the cost of Claude-in-Chrome comes from the number of Claude turns. Each turn re-reads about 55k tokens of context. With the `browse` tool, Claude sends a whole sequence of steps in one turn: for example `type "Lisbon" into the destination`, then `tick "Design hotels"`, then `click "Search"`. `clef-flash` then finds the element for each step.

## Results

All results come from 5 browser jobs, 3 runs each, with Opus 5.5 in `bypassPermissions` mode, on a quiet machine. All 60 runs passed. The full tables are in [`bench/results/summary.md`](bench/results/summary.md), section 11.

| | Median per job | Mean per job | Claude turns | Cost of 15 runs |
|---|---|---|---|---|
| Plain Claude-in-Chrome | 41.0 s | 42.5 s | 8.1 | $2.76 |
| **clef, route `review`** (default) | 23.6 s | 25.6 s | 3.1 | $1.30 |
| clef, route `bridge` | 19.4 s | 28.2 s | 3.6 | $1.36 |

### Grounding accuracy

- **Right element present:** `clef-flash` chose right in 35 of 36 steps and handed back the other one.
- **Right element absent:** it handed back all 36 steps and clicked nothing. Claude Haiku, Sonnet and Opus each picked a wrong element in 2 of 35.

### Model choice

`clef` (27B) chose right as often, but it was about 5 times slower and handed back more steps. So the default model is `clef-flash`.

## Tools

| Tool | What it does |
|---|---|
| `browse({url?, tabId?, steps, expect?, route?})` | Opens the page and runs the steps. It then checks `expect` locally and reports the final page. |
| `check({tabId, question, screenshot?})` | Answers a yes/no question about the open page from its title, URL and text. The answer is `yes`, `no` or `unsure`. `screenshot: true` adds an image, which helps only on visual questions. |
| `find` | `mcp__claude-in-chrome__find` is answered locally in `active` mode. In `shadow` mode, the local answer is only compared with the real one. |

### Steps that `browse` reads

- `click`, `open` or `tick` an element
- `type "value" into` a field
- `select "option" for` a field
- `press enter`, `scroll`, `scroll up`, `wait`

Put exact names and typed values in quotes. A step that says "if …" is optional: when nothing matches it, `browse` skips it.

## Routes

The `route` setting chooses how the browser actions run. A `browse` call can set its own `route`, which overrides the setting for that call.

### `review` (the default)

Every browser action goes through Claude Code's own permission review, as Claude's own actions do. It works in these modes:

- **`bypassPermissions`:** it works, as benchmarked.
- **default mode:** you are asked to approve each browser action.
- **auto mode: it does not work.** Claude Code's auto-mode classifier gives no verdict for a browser action that a plugin starts, so the action is refused. When the mode changes to auto, the mod adds a note to your next prompt. The note tells Claude not to call `browse`. Claude then does the job with the claude-in-chrome tools, at plain-Claude speed. When the mode changes back, a second note tells Claude that `browse` works again.

Why a note, and not a change to the system prompt: the engine renders the system prompt before a hook gets the permission mode.

### `bridge`

A routine `browse` runs over the browser's local Claude in Chrome bridge: `/tmp/claude-mcp-browser-bridge-$USER/<pid>.sock`. It runs in your real browser (`bridge_browser`, Comet by default), with your sign-ins, in the mod's own tab group. It works in auto mode too.

Claude Code does not review each action on this route. The mod's own fail-closed sort takes that place. Anything it cannot clear takes the review route.

- **The sort:**
  - your permission rules, and the session's mode;
  - risk words in the URL and in the steps (buy, pay, send, delete, sign in, personal data, …);
  - a filter for element names that try to instruct the model;
  - `clef-flash` on each grounded element that adds words to its step (threshold `routine_at`).
- **What still applies:**
  - Claude Code's review of Claude's `browse` call itself, which lists the URL and every step;
  - the extension's own site permissions.
- **When a bridge run stops,** `browse` runs the steps again on the review route, in Claude's own tab group.
- **What stays open:** a page can still give a risky button an ordinary name, for example "View details" on a buy button.

## The fallback contract

The mod never makes a step fail that Claude would do. Each of these conditions hands the step back to Claude:

- Ollama is down, gives an error, answers after `timeout_ms`, or sends JSON that is not valid.
- The gate score is below `gate`.
- Two candidates score closer than `min_margin`.
- The model's choice is "none of these".
- Nothing on the page fits the step.
- A click or Enter leaves the page unchanged.
- A browser tool gives an error.
- An exception occurs.

After 3 Ollama failures in a row, a breaker turns the mod off for 5 minutes.

## Install

You need Ollama 0.35 or later, with `clef-flash` and `nomic-embed-text`.

- **All sessions:** add the `mod` folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Put the options under `pluginConfigs["clef-chrome"].options`.
- **One session:** `claude --plugin-dir ~/httpdocs/claude-decision-mod/mod --chrome`.

| Option | Default | Meaning |
|---|---|---|
| `mode` | `shadow` | `off`; `shadow` (only log the local answers); `active` (use them) |
| `route` | `review` | `review` or `bridge` (see [Routes](#routes)) |
| `bridge_browser` | `Comet` | `Comet` or `Google Chrome` |
| `model` | `clef-flash` | any Ollama model with the `decision` capability |
| `embed_model` | `nomic-embed-text` | ranks a large page before `clef-flash` sees it; an empty value turns it off |
| `gate` | 0.5 | the gate score that an element must pass |
| `skip_gate_at` | 0.95 | at this choice score or higher, there is no gate question |
| `min_margin` | 0.15 | top two candidates closer than this go back to Claude |
| `routine_at` | 0.65 | bridge only: the routine score that an element must reach |
| `timeout_ms` | 8000 | the time limit for each Ollama request |
| `settle_ms` | 0 | an extra wait after each batch of browser actions |
| `browse`, `find`, `check` | on | switch each tool off on its own |

## How `browse` works

1. **Read the page.** `read_page` reads all elements, including `<label>` text, and the elements in the viewport. Each step is matched among the visible elements first, and then among all.
2. **Ground the step** (`hooks/ground.ts`):
   1. The code reads the verb and any quoted value.
   2. A quoted name filters the elements.
   3. On a large page, embeddings keep the best 25 candidates.
   4. One choice question ranks them, with a "none of these" option.
   5. One yes/no gate checks the winner. A choice scored at 0.95 or higher needs no gate.
3. **Act in batches.** Fills, ticks and selects wait in a queue and go in one `browser_batch` with the next click or Enter. That batch also reads the page for the next step. Details:
   - Search boxes get real keystrokes.
   - Checkboxes are set with `form_input`.
   - A 0.1-scale screenshot before a click lets the click land in a background tab.
4. **Check `expect`.** `expect` is checked at once, on the page text that the last batch read. After a "no", `browse` waits until the title or URL changes, at most 2 s, and checks once more.

## Layout

```
mod/                  the plugin
  hooks/register.ts   tools, hooks, routes, the bridge, the fallback contract
  hooks/ground.ts     step parsing and grounding
  hooks/safety.ts     risk words, injection filter, routine sort
  hooks/tree.ts       read_page text to elements
  hooks/systemone.ts  Ollama client and embeddings
  bridge/call.py      one call over the local browser bridge
  tests/              claude plugin test (Ollama, browser and bridge faked)
bench/
  ground.ts  check.ts  safety.ts  inject.ts   offline evaluations
  e2e.ts  speed.ts                            headless Claude-in-Chrome jobs
  server.ts  warm.ts                          fixtures with a beacon; model warm-up
```

## Run the checks

```sh
claude plugin validate mod && claude plugin test mod
bun bench/ground.ts --backend clef-flash [--negative]
bun bench/server.ts &
bun bench/e2e.ts --label base --runs 3
bun bench/e2e.ts --label review --mod --runs 3
bun bench/e2e.ts --label bridge --mod --set route=bridge --runs 3
```
