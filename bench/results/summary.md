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
