# clef-chrome

clef-chrome is a Claude Code mod. It moves small Claude-in-Chrome decisions to a local Ollama decision model: `clef-flash`, through `/v1/systemone`. The decisions are "which element does this step mean?" and "did it work?". Claude keeps the plan. The local model only matches a step to an element and answers yes/no questions about the page. When the local model is not sure, the decision goes back to Claude.

Most of the cost of Claude-in-Chrome comes from the number of Claude turns, not from page size. Each turn re-reads about 55k tokens of context. The `browse` tool lets Claude send a whole sequence of steps in one turn.

## What it adds

| Feature | What it does | Status |
|---|---|---|
| `browse({url?, tabId?, steps, expect?})` | Opens the page and runs plain steps such as `type "Lisbon" into the destination`, `tick "Design hotels"` and `click Search`. It then checks `expect` locally and reports the final page. | **On.** Passed the ladder. See [Results](#results). |
| `check({tabId, question, screenshot?})` | Answers a yes/no question about the open page locally, from its title, URL and text. Set `screenshot: true` to add an image. The answer is `yes`, `no` or `unsure`. | On. `browse` uses it for `expect`. Screenshots help only on visual questions and are not reliable on clef-flash, so they are opt-in. |
| local `find` | Answers `mcp__claude-in-chrome__find` locally in `active` mode. In `shadow` mode, it only compares its answer with the real `find`. | Built and tested. The model called `find` in only 1 of 5 baseline jobs, so the saving is small. |
| shrink `read_page` | Not built. The model called `read_page` once in 5 baseline jobs, and the results were under 2.4k characters. | Dropped by the ladder. |

## The fallback contract

The mod never makes a step fail that Claude would do. Each of these conditions hands the decision back to Claude:

- Ollama is down, returns an error or 413, answers late (`timeout_ms`) or sends JSON that is not valid.
- The gate score is below `gate`.
- Two candidates are closer than `min_margin`.
- The choice is "none of these".
- The page has no element that fits the step.
- A browser tool returns an error.
- An exception occurs.

What happens then:

- **`find`** runs the real tool.
- **`browse`** stops at that step. It reports the completed steps, the steps it did not run, the reason and the current page. Claude then continues with the normal tools.
- **`check`** says `unsure`.

After 3 Ollama failures in a row, a breaker turns the mod off for 5 minutes. The status line shows local decisions, hand-backs and the breaker state.

## Install

Requirements:

- Ollama 0.35 or later, with `clef-flash` and `nomic-embed-text`. The embedding model ranks large pages before `clef-flash` sees them.

Load the mod in one of these ways:

```sh
claude --plugin-dir /Users/cns/httpdocs/claude-decision-mod/mod --chrome
```

Or add it to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.

The default `mode` is `shadow`. Set `active` in `/config` (clef-chrome) to use it.

| Option | Default | |
|---|---|---|
| `mode` | `shadow` | `off`, `shadow` (log only) or `active` |
| `model` | `clef-flash` | any Ollama model with the `decision` capability |
| `embed_model` | `nomic-embed-text` | empty turns the prefilter off |
| `gate` | 0.5 | |
| `min_margin` | 0.15 | |
| `timeout_ms` | 8000 | for each Ollama request |
| `browse`, `find`, `check` | on | switch each feature off on its own |

### Permission mode

`browse` runs the browser tools from inside its hook through `$.tool.call`. Each nested call gets its own permission check:

- **Auto mode:** the classifier gives no verdict for a nested call from a plugin. Thus `browse` can open pages and act only when the person allows the claude-in-chrome tools by rule. Otherwise it hands back at once. `check` and other read-only nested calls work.
- **Other modes:** the bench uses `bypassPermissions` in a headless session that has only the browser tools.

## How it works

1. **Read the page.** `read_page` with the `all` filter gives the element names, including `<label>` text that the `interactive` filter drops, such as `checkbox "on"` inside "I agree to the terms". `read_page` with the `interactive` filter gives the elements that are visible in the viewport. Each step is grounded among the visible elements first, then among all elements.
2. **Ground the step** (`hooks/ground.ts`, a port of laya-browse's policy):
   1. The code reads the verb and the quoted value.
   2. A quoted name is a hard filter. It is dropped when it matches nothing.
   3. An embedding prefilter keeps 25 candidates on a large page.
   4. One `choice` question, with a "none of these" option, ranks the candidates.
   5. One `noul` gate checks the winner: "Would using the element … carry out this instruction?".
3. **Act.**
   - **Text fields** get real keystrokes: `triple_click`, then `type`. Script-driven search boxes (GOV.UK, Wikipedia) dropped a value that `form_input` set.
   - **Checkboxes and radios** are set with `form_input` `true`/`false`, so "tick" never unticks a box.
   - **Selects** use `form_input`.
   - **Before each click, Enter and typing,** the mod takes a 0.1-scale screenshot. Ref clicks on a tab that Chrome is not painting are lost, and the screenshot makes Chrome paint a frame. The screenshot stays inside the hook, so Claude never pays tokens for it.
4. **Settle.** The mod waits 400 ms after each action. It reads the page again (800 ms, then 1,600 ms) when the page may still be loading. Before `expect`, it waits 1 s, and again 1.5 s before it accepts a "no".

## Results

Full tables: [`bench/results/summary.md`](bench/results/summary.md). 5 browser jobs, 3 runs each, Opus 5.5:

| | Plain Claude-in-Chrome | With clef-chrome | Change |
|---|---|---|---|
| Jobs passed | 15/15 | 15/15 | same |
| Mean Claude turns | 8.7 | 3.6 | −59% |
| Claude tokens per job | 502k | 204k | −59% |
| Cost of all 15 runs | $2.39 | $0.86 | −64% |
| Mean wall time | 53.6 s | 45.2 s | −16% |

On element grounding, `clef-flash` matched Claude: 35 of 35 right. When the right element was absent, it never picked a wrong one, and Haiku, Sonnet and Opus each picked 2 wrong ones.

## Layout

```
mod/                 the plugin
  hooks/register.ts  wiring: tools, hooks, fallback contract, breaker, metrics
  hooks/ground.ts    step parsing and grounding
  hooks/tree.ts      read_page text to elements
  hooks/systemone.ts Ollama client, embeddings
  tests/             claude plugin test (faked Ollama and browser)
bench/
  ground.ts          offline grounding: clef-flash | clef | claude-haiku | claude-sonnet | claude-opus
  check.ts           yes/no on page text vs screenshot vs both
  e2e.ts             headless Claude-in-Chrome jobs, baseline vs mod
  server.ts          fixtures with a beacon, so success is read from the page
```

## Run the checks

```sh
claude plugin validate mod && claude plugin test mod
bun bench/ground.ts --backend clef-flash [--negative]
bun bench/server.ts &   # then:
bun bench/e2e.ts --label baseline --runs 3
bun bench/e2e.ts --label mod --mod --runs 3
```
