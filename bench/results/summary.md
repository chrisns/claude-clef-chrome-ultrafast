# clef-chrome results (5 October 2026)

The machine is an M1 Max with 64 GB. Ollama is 0.35.1. Another process used `gemma4` on the same GPU during the runs, so the local latencies include that load. Claude Code is 2.1.289, and the e2e jobs ran on Opus 5.5.

## 1. End-to-end: the number that matters

5 jobs, 3 runs each. Each run is a headless `claude -p --chrome` session. Success comes from the page: the fixture beacon, or the URL that the browser reported. It never comes from Claude's own claim.

| Job | Baseline: turns / s / $ | Mod `active`: turns / s / $ |
|---|---|---|
| hotels (search, 2 filters, open a result) | 8 / 42 / 0.149 | **2 / 36 / 0.029** |
| signup (4 fields, submit) | 7 / 31 / 0.115 | **3 / 45 / 0.047** |
| docs ("API keys and tokens" → Authentication) | 10 / 74 / 0.182 | 9 / 59 / 0.144 |
| wikipedia (site search, open the article) | 7 / 52 / 0.130 | **2 / 40 / 0.031** |
| govuk (site search, open the guide) | 10 / 78 / 0.192 | **2 / 31 / 0.029** |

The cells are medians of 3 runs.

| All 15 runs | Baseline | Mod | Change |
|---|---|---|---|
| Jobs passed | 15/15 | 15/15 | same |
| Mean Claude turns | 8.7 | 3.6 | **−59%** |
| Mean Claude tokens per job | 502k | 204k | **−59%** |
| Total cost | $2.39 | $0.86 | **−64%** |
| Mean wall time | 53.6 s | 45.2 s | −16% |

- **Where the cost comes from.** Every Claude turn re-reads about 55k tokens of context. The tool results were small: the largest `read_page` was 2.4k characters. So the turn count drives the cost.
- **Why the wall time falls less.** The local steps take time: two `read_page` calls, an embedding call, a choice, a gate, a screenshot and a settle wait. That is 1 to 3 s per step.
- **The docs job always hands back.** "API keys and tokens" means "Authentication", which needs world knowledge. `clef-flash` gave the best candidate 0.09 to 0.35, under the gate of 0.5. In all 3 runs, Claude did that step itself, as the fallback contract requires.

## 2. Offline grounding (`bench/ground.ts`)

There are 35 steps over 14 page snapshots: the laya-browse set, plus one step that Claude wrote in an e2e run. The **negative** run removes the right element, so the only right answer is to hand back. A wrong pick in a negative run is a wrong click.

| Backend | Positive: right / wrong / back | Negative: wrong picks | p50 per step | Cost |
|---|---|---|---|---|
| **clef-flash, `none+gate1`** (the mod) | 35 / 0 / 1 (of 36) | **0 / 36** | 2.0 s | free |
| clef (27B), same code | 31 / 0 / 5 (of 36) | 0 / 36 | 9.8 s | free |
| Claude Haiku 4.5 | 35 / 0 / 0 (of 35) | 2 / 35 | 2.7 s (API) | $0.07 |
| Claude Sonnet 5.5 | 35 / 0 / 0 | 2 / 35 | 1.1 s (API) | $0.09 |
| Claude Opus 5.5 | 35 / 0 / 0 | 2 / 35 | 1.5 s (API) | $0.17 |

`clef` is as safe as `clef-flash`, but about 5 times slower, and it hands back 5 steps that `clef-flash` gets right. The Claude rows use the first 35 steps. The Claude times exclude the start of the `claude -p` process, about 1.3 s. Claude always picks something, even when the right element is absent. `clef-flash` with a "none of these" option plus a yes/no gate never picked a wrong element.

### Strategies tried on clef-flash

| Strategy | Positive | Negative wrong picks | Kept? |
|---|---|---|---|
| tournament of 8, gate every finalist (laya-browse) | 34 / 0 / 1 | not run | no: p50 2.4 s |
| one choice, gate the top 3 | 33 / 0 / 2 | not run | no: slower |
| one choice, gate the winner only (`gate1`) | 34 / 0 / 1 | 2 | no: 2 wrong clicks |
| one choice with a "none" option, no gate | 35 / 0 / 0 | **6** | no: unsafe |
| **"none" option + gate the winner (`none+gate1`)** | 35 / 0 / 0 | **0** | yes |
| the same, with gate wording "Would using … carry out this instruction?" | 35 / 0 / 0 | 0 | yes (the old wording handed back "reserve a room") |
| the same, with an embedding prefilter (nomic, top 25) | p50 2.4 s → 1.7 s | 0 | yes; needed for 300-link pages |

The cost model is about 300 ms + 42 ms per option for a `choice`, and about 250 ms per `noul`. Parallel requests give no gain, because Ollama runs them one after the other.

## 3. `check`: text against screenshot (`bench/check.ts`)

There are 18 yes/no questions on 12 captured page states. 4 questions are visual-only, such as "is the box ticked?".

| Input to clef-flash | Right / wrong / unsure | Visual-only right | p50 |
|---|---|---|---|
| `get_page_text` | 14 / 3 / 1 | 2/4 | 0.7 s |
| screenshot (0.5 scale) | 15 / 2 / 1 | 3/4 | 2.1 s |
| text + screenshot | 15 / 2 / 1 | 3/4 | 2.1 s |
| **title and URL as fields, page-level question** (the mod) | 15 / **1** / 2 | 2/4 | 2.5 s (GPU shared with gemma4) |
| page-level question + screenshot | 15 / 1 / 2 | 2/4 | 3.0 s |
| clef (27B), page-level question | 16 / 2 / 0 | 2/4 | 2.9 s |
| clef (27B), page-level question + screenshot | 17 / 1 / 0 | 3/4 | 8.1 s |

- **A real hazard of text-only checks.** On a GOV.UK results page, "is this the passport guide?" scored 0.94 from plain text, because the guide is the first result. The page-level wording makes this "unsure" (0.24).
- **A second hazard.** `get_page_text` returns one `<article>` as the main content. On the hotel results page it returned one hotel only.
- **The screenshot result.** It gave a small gain on visual questions in the bench. A live headless test still answered "no (p=0.03)" for a ticked box. So `check` takes `screenshot: true` as an opt-in, and the default is text.

## 4. The ladder

| Feature | PoC | Result | Decision |
|---|---|---|---|
| `browse(steps)` | built | −59% tokens, −64% cost, success the same | **on** |
| `check` and `browse(expect)` | built | used inside `browse`, so Claude needs no verification turn | **on** |
| local `find` | built and tested (shadow and active) | Claude called `find` in 1 of 5 baseline jobs | built, on, small effect |
| shrink `read_page` | not built | Claude called `read_page` in 1 of 5 baseline jobs, and the largest result was 2.4k characters | **dropped** |

## 5. What the e2e runs found, in order

Each item failed in a run and is now fixed. The source comments name each one.

1. **`--tools ""`** also removes every plugin tool. The bench now keeps one built-in tool in both configurations.
2. **A tool description alone did not make Claude use `browse`:** 1 call in 5 jobs. A system-prompt section in `active` mode, plus `url` and `expect` inputs, made it the first call.
3. **Stale pages.** The mod now waits briefly after each action, and reads the page again when an element is missing or the page is still loading.
4. **`type="submit"` was dropped,** so "click the submit button" matched "Press". The label now carries the hint `submit`.
5. **Ref clicks on a tab that Chrome is not painting are lost.** A 0.1-scale screenshot before each click fixes this. Plain Claude takes screenshots often, so it never meets the problem.
6. **The 1Password autofill menu** took a click after a `form_input` fill. A blind Escape also clears GOV.UK's search box. Real typing plus the screenshot made the Escape unnecessary.
7. **`form_input` values were dropped** by script-driven search boxes (GOV.UK, Wikipedia), so the searches ran empty. All text fields now get real keystrokes.
8. **`read_page` `all` lists hidden elements.** A collapsed GOV.UK search box was chosen. The mod now grounds among the elements in the viewport (`interactive`) first.
9. **The option cap.** 25 candidates plus "none of these" must stay within Ollama's 26-option limit. The bench caught this, and every affected case handed back safely.
10. **Auto mode** gives no verdict for a plugin's nested browser actions. `browse` therefore needs allow rules for the claude-in-chrome tools, or another permission mode.

## 6. Speed work (commit 7984ec4)

### Where the time went

These numbers come from the `TIMING` debug line in `browse` and from the extension's own log.

| Tool | Extension time (median) | Time until the hook gets the answer (median) |
|---|---|---|
| `browser_batch` | 472 ms | 2,553 ms |
| `navigate` | 540 ms | 3,401 ms |
| `read_page` | 116 ms | 249 ms |

- **The gap is a check, not the browser.** Claude Code checks each browser action call before the extension runs it. The check is a site pre-check plus the auto-mode classifier: a Sonnet request with about 139k characters of context, about 1 to 2.5 s each. It runs in `bypassPermissions` mode too. Read-only calls skip it.
- **The baseline pays it too.** One baseline signup run made 7 classifier calls, and a mod run makes 3 or 4. `total_cost_usd` does not include these calls in either configuration.
- **Where it sits in `browse`.** In one hotels `browse` of 17.6 s, permission checks took 9.9 s, Chrome took 5.3 s and clef-flash took about 2.5 s.

### Changes and results

The changes:

- one `browser_batch` per group of actions;
- the page-neutral steps (fill, tick, select) queued until the next click or Enter;
- the page read in the same batch as the action;
- retries only while the page changes;
- the models loaded at session start;
- an embedding cache;
- the gate skipped when the choice is at least 0.95 sure (0 wrong picks on 36 negative steps; 1 wrong pick at 0.8);
- real typing only in search boxes;
- 3,000 characters of page text for `check`.

Fixed `browse` arguments, wall time of the whole headless run, median of 3 runs, all passed (`bench/speed.ts`):

| Job | v1 (c3c4d0e) | v2 (7984ec4) |
|---|---|---|
| hotels | 37.6 s | 21.9 s |
| signup | 37.6 s | 28.6 s |
| govuk | 34.6 s | 25.1 s |
| wikipedia | 30.9 s | 28.5 s |

End-to-end jobs, Opus, 3 runs each:

| | Mean wall time | Mean turns | Cost of 15 runs | Passed |
|---|---|---|---|---|
| Plain Claude-in-Chrome | 53.6 s | 8.7 | $2.38 | 15/15 |
| Mod v1 | 45.2 s | 3.6 | $0.86 | 15/15 |
| Mod v2 | 35.0 s | 3.9 | $0.98 | 15/15 |

### The routine-action sort (`bench/safety.ts`): measured only, not used

`mod/hooks/safety.ts` sorts an action as routine or as needing review. It uses fixed risk words for the step, the element name and the URL path, and then a clef-flash yes/no. On 49 actions at a threshold of 0.8:

- **0 of 29 risky actions** were scored routine. The words caught 22, and the model caught the rest, which scored 0.29 at most.
- **17 of 20 routine actions** were scored routine. They scored 0.63 at least.

A fast path that used this sort to skip Claude Code's per-action classifier was **not built**. The auto-mode classifier blocked the edit as an auto-mode bypass. Building it is the user's decision.

### Update: the `fast_routine` option (built with the user's approval)

`fast_routine` is opt-in and off by default. A batch goes straight to the extension with `$.mcp.call`, skipping the per-action review, only when all three of these are true:

1. Every action in the batch passes `isRoutine` at `routine_at` (0.8).
2. `$.tool.check` returns `allow`.
3. The call works.

In a live headless run in `bypassPermissions` mode, the sort scored the GOV.UK and Wikipedia actions as routine (0.90 to 0.97) and "type Lisbon" as needing review (0.68). But `$.tool.check` answered `ask` ("Claude in Chrome requires permission."), so every batch took the normal path.

The fast path therefore works only when the person has explicit Claude-in-Chrome allow rules. It was not tested with such rules: adding them is a permission change, and that is the person's decision.

## 7. The local browser bridge (commits 910ee28, dc17d20)

### How it works

Claude Code reviews every action that a plugin starts, by any route, including `$.mcp.call`. That review costs about 2 s for each action call. The bridge avoids it, so the mod talks to the browser's own Claude in Chrome native host:

- **The socket.** The host listens on `/tmp/claude-mcp-browser-bridge-$USER/<pid>.sock`. The socket is mode 0600 and accepts only the same user.
- **The call.** `mod/bridge/call.py` makes one framed call per run, in about 50 to 300 ms. The default browser is Comet.
- **What still applies.** The extension's own site permissions, blocklists and tab-group limit.
- **What replaces Claude Code's review.** The mod's own fail-closed sort:
  1. your rules and mode, through `$.tool.check` and the session's permission mode;
  2. risk words in the URL and the steps;
  3. a filter for element names that address the model;
  4. clef-flash on each grounded batch, at a threshold of 0.65.
- **The fallback.** Anything else takes the normal tools.

### Prompt injection (`bench/inject.ts`)

| Attack | Before the filter | After the filter |
|---|---|---|
| A: element name with an instruction, right element present | 0/108 hijacked | 0/108 (105 right, 3 handed back) |
| B: the same, right element absent | 18/108 wrong clicks | 0/108 (all handed back) |
| C: risky element whose name claims to be harmless | 6/7 sorted as routine | 0/7 (control still routine) |
| D: injected "answer yes" text against `check` | 0/12 false yes | 0/12 false yes |

**What is still open:** a page can give a risky button a plain, honest-looking name, such as "View details" on a button that buys. Neither the filter nor the model can detect that. On the bridge, the remaining defences are the URL risk words, the extension's site gates, and the review of Claude's own `browse` call.

### Three-way benchmark: 5 jobs, 3 runs each, Opus 5.5, bypassPermissions

Each cell is the median wall time / median Claude turns.

| | hotels | signup | docs | wikipedia | govuk | Median per job | Mean per job | Mean turns | Claude tokens per job | Cost, 15 runs | Passed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Plain Claude | 38 s / 8 | 27 s / 7 | 63 s / 11 | 44 s / 7 | 48 s / 9 | 42.9 s | 43.9 s | 8.3 | 473k | $2.74 | 15/15 |
| Claude + clef, Claude Code's review | 24 s / 2 | 27 s / 3 | 58 s / 9 | 22 s / 2 | 33 s / 2 | 30.9 s | 42.1 s | 3.9 | 220k | $1.45 | 15/15 |
| Claude + clef, clef's sort (Comet bridge) | 28 s / 2 | 32 s / 3 | 50 s / 8 | 20 s / 2 | 21 s / 2 | 22.7 s | 30.2 s | 3.9 | 232k | $1.01 | 15/15 |

Notes on this table:

- **Outliers.** The clef-with-review mean includes two outlier runs: a 124 s govuk run that handed back, and a 93 s docs run. Its cost includes one cache-write run of $0.48.
- **Browsers.** The plain and review rows use the browser that `claude --chrome` reaches through the cloud relay. The bridge row uses Comet.
- **Hand-backs on the bridge.**
  - Signup never takes the bridge: `signup` in the URL is a risk word.
  - Docs always hands back, because "API keys and tokens" means "Authentication" and that needs world knowledge.
  - One hotels run handed back at the "type Lisbon" fill, which scored 0.65.
- **Cost.** `total_cost_usd` leaves out Claude Code's classifier calls in every row. The bridge makes no such calls for its own actions.

## 8. Bridge speed work (fixed-argument speed bench, warmed models, 3 runs per job)

| Job | Wall time | Inside `browse` | Plain Claude (median, section 7) |
|---|---|---|---|
| hotels | 15.7–17.0 s | 7.2–9.2 s | 38 s |
| wikipedia | 13.7–16.0 s | 6.7–8.2 s | 44 s |
| govuk | 15.5–20.7 s | 8.8–13.6 s | 48 s |

All 9 runs passed. The changes:

- **The screenshot stays.** Without the tiny screenshot, clicks and typing in a Comet window that was behind were lost. In one govuk run, that left the page unchanged, and the next step was grounded on the old page and clicked a wrong link.
- **A stale-page guard.** If a click or Enter leaves the page exactly as it was, `browse` stops and hands back. It does not ground the next step on the old page.
- **The safety sort asks the model only where that adds information.** Before the run, only the risk words, the injection filter, your rules and the mode decide. After grounding, the model judges an element only if its name adds words to the step, or if the step names nothing in quotes. Enter shares the check of its field. The sort fell from 2.9–4.0 s to 0.7–1.6 s per job.
  - Trade-off: an exact step such as `click "OK"` on an exactly matching element is settled by the word rules only. Claude wrote that step, and Claude Code reviewed the `browse` call that lists it.
- **`expect`.** It polls the tab's title and URL until the last click or Enter has changed the page (250 ms polls, at most 2 s), and then checks 2,000 characters of text. A second look comes after 0.6 s. It now takes 2.0–3.4 s, down from up to 6.5 s.
- **Model warm-up.** The benches warm the models first, and every request sends `keep_alive`. During earlier runs, screenpipe's `gemma4:12b-mlx` shared the GPU, and `clef-flash` calls took 1.2–1.5 s each instead of 0.45–0.7 s.

## 9. More aggressive `expect`, and a tab limit (fixed-argument speed bench, warmed, 3 runs per job)

| Job | Wall time | Inside `browse` | `expect` |
|---|---|---|---|
| hotels | 14.0–16.4 s | 6.1–7.7 s | 0.6 s |
| wikipedia | 15.4–23.9 s | 7.0–16.3 s | 1.2–6.4 s |
| govuk | 14.5–24.0 s | 7.2–15.5 s | 1.0–3.2 s |

All 9 runs passed.

**Changes kept:**
- **`expect` checks at once.** It uses the page text that the last batch read. The tab poll and the retry run only after a "no".
- **`check` reads 800 characters, not 2,000.** On `bench/check.ts` it is just as accurate (14 right, 2 wrong, 2 unsure; the 2 wrong are visual-only questions), and faster: p50 0.53 s against 0.91 s.
- **The bridge keeps at most 3 tabs in its group.** 33 left-over bench tabs had made Comet's batches 3 to 5 times slower.

**Tried and not kept:** gate skip at 0.9, and prefilter to 12 options. Accuracy was the same (35/36 right, 0 wrong picks on 36 negative steps), and the time change was within noise. Each request costs about 0.2–0.3 s before it does any work, each yes/no question about 0.25 s, and each choice option only about 42 ms.

**Outliers:** the slow wikipedia and govuk runs had `clef-flash` calls of about 2.4 s each, against 0.6–1 s in the other runs. That points to other GPU load at the time.

## 10. `OLLAMA_NUM_PARALLEL=2`: tried and taken out

With Ollama restarted and `OLLAMA_NUM_PARALLEL=2`, warmed, M1 Max:

| Run | 2 yes/no, in sequence | 2 yes/no, in parallel | choice + yes/no, in sequence | choice + yes/no, in parallel |
|---|---|---|---|---|
| 1 (just after the warm-up) | 2,257 ms | 2,124 ms | 4,359 ms | 3,286 ms |
| 2 | 985 ms | 794 ms | 1,668 ms | 2,022 ms |
| 3 | 1,046 ms | 830 ms | 1,781 ms | 1,822 ms |

**Result:** the GPU is already busy with one request. Parallel requests saved about 0.2 s on two yes/no questions and nothing on a choice plus a yes/no. That is not worth the extra code, or the extra memory that each parallel slot takes. The setting was removed and Ollama was restarted.
