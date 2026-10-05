// clef-chrome: answer small Claude-in-Chrome decisions with a local Ollama decision model.
//
// The fallback contract: any doubt goes back to Claude. A Fallback (Ollama down, timeout, bad
// answer, low gate, low margin, no elements, tool error) or any exception means the real tool
// runs (find), or the tool stops and hands the rest of the job back to Claude (browse, check).
// Three Ollama failures in a row open a breaker for five minutes.

import type { Register } from 'claude-code'
import type { ClefChromeMetrics } from '../types'
import { DEFAULT_TUNING, ground, parseStep, type Tuning } from './ground.ts'
import { ask, type Client, embed, Fallback, type Reason } from './systemone.ts'
import { type Element, findText, parse } from './tree.ts'
import { type Action, areRoutine, wordsSayRisky } from './safety.ts'

const PLUGIN = 'clef-chrome'
const CHROME = 'mcp__claude-in-chrome__'
const BROWSE = `mcp__${PLUGIN}__browse`
const CHECK = `mcp__${PLUGIN}__check`
const BREAKER_FAILS = 3
const BREAKER_MS = 5 * 60_000
// The title, URL and start of the text decide a check; 12k characters of Wikipedia made each
// check take 4 to 8 s.
const PAGE_TEXT_CHARS = 800 // as accurate as 2,000 on bench/check.ts (14/2/2), p50 0.53 s against 0.91 s
// A click or Enter can start a page load or a re-render that read_page would miss.
const SEARCHY = (e: Element) => e.role === 'combobox' || e.role === 'searchbox' || e.inputType === 'search'
const TOGGLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'])
const OFF = /\b(untick|uncheck|turn off|switch off|clear|deselect|disable|remove)\b/i
const RETRY_MS = [800, 1600]
const MAX_TABS = 3 // tabs the mod keeps in its own bridge group
// expect polls the tab's title and URL until the last click or Enter has changed the page,
// then checks once; a "no" gets one quick second look.
const EXPECT_POLL_MS = 250
const EXPECT_POLL_MAX_MS = 2000
const EXPECT_RETRY_MS = 600
const OLLAMA_REASONS: Reason[] = ['ollama-down', 'http-error', 'timeout', 'bad-json']

const metricsRef = { plugin: 'clef-chrome', key: 'metrics' } as const
const EMPTY: ClefChromeMetrics = { local: 0, fallback: {}, shadow: { agree: 0, disagree: 0 }, ms: 0 }

type $ = Parameters<Parameters<Parameters<Register>[0]>[2]>[0]

type Cfg = { mode: 'off' | 'shadow' | 'active'; tuning: Tuning; timeoutMs: number; url: string; model: string; embedModel: string; settleMs: number; bridge: boolean; bridgeBrowser: string; routineAt: number }

// Kept per module load: a hot reload closes the breaker, which is fine.
let fails = 0
let openUntil = 0
let lastNow = 0
// Label embeddings, so later steps on the same page embed only the step text.
const EMBEDS = new Map<string, number[]>()

// Where a browse call spends its time, by phase (debug log only). Date.now, not $.clock, so the
// mocked clock in tests is not touched.
let timing: Record<string, [number, number]> | undefined
function tick(key: string, since: number) {
  if (!timing) return
  const t = (timing[key] ??= [0, 0])
  t[0] += Date.now() - since
  t[1]++
}
function logTiming($: $, steps: number, startedAt: number) {
  const phases = Object.entries(timing ?? {})
    .sort((a, b) => b[1][0] - a[1][0])
    .map(([k, [ms, n]]) => `${k}=${ms}ms/${n}`)
    .join(' ')
  $.ui.log(`${PLUGIN}: TIMING browse ${steps} steps ${Date.now() - startedAt}ms ${phases}`, { to: 'debug' })
  timing = undefined
}

async function pause($: $, ms: number) {
  const t = Date.now()
  await $.clock.sleep(ms)
  tick('sleep', t)
}

function makeClient($: $, cfg: Cfg): Client {
  return {
    url: cfg.url,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    keepAlive: '30m',
    embedModel: cfg.embedModel || undefined,
    embedCache: EMBEDS,
    post: async (url, body, ms) => {
      const started = await $.clock.now()
      const res = await Promise.race([
        $.http.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
        $.clock.sleep(ms).then(() => 'timeout' as const),
      ])
      const took = (await $.clock.now()) - started
      tick(url.endsWith('/api/embed') ? 'ollama:embed' : 'ollama:systemone', Date.now() - took)
      $.ui.log(`${PLUGIN}: ${url.endsWith('/api/embed') ? 'embed' : 'systemone'} ${body.length} chars ${res === 'timeout' ? 'TIMEOUT' : res.status} ${took} ms`, { to: 'debug' })
      if (res === 'timeout') throw new Fallback('timeout', `${ms} ms`)
      return { status: res.status, text: res.text }
    },
  }
}

async function record($: $, cfg: Cfg, change: (m: ClefChromeMetrics) => void) {
  const t = Date.now()
  const { value } = await $.state.get(metricsRef)
  const m: ClefChromeMetrics = JSON.parse(JSON.stringify(value ?? ((await $.store.get('metrics')) as ClefChromeMetrics | undefined) ?? EMPTY))
  change(m)
  await $.state.set(metricsRef, m)
  await $.store.set('metrics', m)
  const back = Object.values(m.fallback).reduce((a, b) => a + b, 0)
  const shadow = cfg.mode === 'shadow' ? ` · shadow ${m.shadow.agree}/${m.shadow.agree + m.shadow.disagree} agree` : ''
  const breaker = lastNow < openUntil ? ' · breaker open' : ''
  $.ui.status(`clef: ${m.local} local · ${back} → claude${shadow}${breaker}`)
  tick('record', t)
}

type Guarded<T> = { ok: true; value: T } | { ok: false; reason: Reason; detail: string }

// Run one local decision under the contract. Resolves the value, or the Fallback reason.
async function guarded<T>($: $, cfg: Cfg, work: () => Promise<T>): Promise<Guarded<T>> {
  const now = (lastNow = await $.clock.now())
  if (now < openUntil) return { ok: false, reason: 'breaker-open', detail: 'Ollama failed 3 times in a row' }
  try {
    const value = await work()
    fails = 0
    const ms = (await $.clock.now()) - now
    await record($, cfg, m => {
      m.local++
      m.ms += ms
    })
    return { ok: true, value }
  } catch (err) {
    const reason: Reason = err instanceof Fallback ? err.reason : 'exception'
    if (OLLAMA_REASONS.includes(reason) && ++fails >= BREAKER_FAILS) {
      openUntil = now + BREAKER_MS
      fails = 0
    }
    await record($, cfg, m => (m.fallback[reason] = (m.fallback[reason] ?? 0) + 1))
    return { ok: false, reason, detail: err instanceof Error ? err.message : String(err) }
  }
}

// A browser tool called from inside a hook. Any error or deny is a Fallback.
async function chrome($: $, tool: string, args: Record<string, unknown>): Promise<string> {
  if (via) return bridgeTool($, tool, args)
  const t = Date.now()
  const r = await $.tool.call({ tool: `${CHROME}${tool}`, ...args } as never)
  tick(`chrome:${tool}${args.action ? `:${String(args.action)}` : ''}${args.filter ? `:${String(args.filter)}` : ''}`, t)
  if (r.deny !== undefined) throw new Fallback('tool-error', `${tool} denied: ${r.deny}`)
  if (r.isError) throw new Fallback('tool-error', `${tool}: ${r.text ?? 'failed'}`)
  return r.text ?? textOf(r.result)
}

// The text of a tool result that has no `text` (another plugin's hook answered it).
function textOf(result: unknown): string {
  if (typeof result === 'string') return result
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content
  return Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') : ''
}

// A yes/no about the page text. Never a low-confidence yes or no.
async function checkPage($: $, cfg: Cfg, tabId: number, question: string, screenshot = false, pageText?: string): Promise<string> {
  const r = await guarded($, cfg, async () => {
    // Title and URL as their own fields, and the question asked about the open page itself: on
    // a GOV.UK results page "is this the passport guide?" scored 0.94 from plain text, because
    // the guide is the first result (bench/check.ts, mode "page").
    // The last batch can carry the page text, which saves a round trip.
    const raw = pageText ?? (await chrome($, 'get_page_text', { tabId }))
    const [head = '', ...rest] = raw.split('\n---\n')
    const field = (k: string) => new RegExp(`^${k}: (.*)$`, 'm').exec(head)?.[1] ?? ''
    const state = { page_title: field('Title'), page_url: field('URL'), page_text: rest.join('\n---\n').slice(0, PAGE_TEXT_CHARS) }
    // A screenshot answers what the text cannot (a ticked box: 3/4 visual-only questions against
    // 2/4 from text) for ~1.4 s more, so it is the caller's choice.
    const images = screenshot ? await screenshotOf($, tabId) : undefined
    const a = await ask(
      makeClient($, cfg),
      state,
      {
        q: {
          type: 'noul',
          instructions: `About the page that is open now (its title, URL and main content), not about the links on it: ${question}`,
          criteria: { true: 'The page shows that the answer is yes.', false: 'The page does not show that the answer is yes.' },
        },
      },
      images,
    )
    return (a.q as { noul: number }).noul
  })
  if (!r.ok) return `unsure: the local check failed (${r.detail}). Look at the page with read_page or a screenshot.`
  const p = r.value
  if (p >= 1 - (1 - cfg.tuning.gate) / 2.5) return `yes (p=${p.toFixed(2)})`
  if (p <= cfg.tuning.gate / 2.5) return `no (p=${p.toFixed(2)})`
  return `unsure (p=${p.toFixed(2)}). Look at the page with read_page or a screenshot.`
}

// A half-scale screenshot as base64, for the decision model's `images`. A plugin's own tool call
// gets the result's text blocks only, not the image, so the screenshot is saved to disk and read.
async function screenshotOf($: $, tabId: number): Promise<string[]> {
  const text = await chrome($, 'computer', { tabId, action: 'screenshot', scale: 0.5, save_to_disk: true })
  const path = /Screenshot saved to: (\S+)/.exec(text)?.[1]
  if (!path) throw new Fallback('tool-error', 'the screenshot was not saved')
  const { base64 } = (await $.fs.read(path, { as: 'bytes' })) as { base64: string }
  if (!base64) throw new Fallback('tool-error', 'the saved screenshot was empty')
  return [base64]
}

type Page = { all: Element[]; visible: Element[]; key: string }
type Item = { name: string; input: Record<string, unknown> }

// Several claude-in-chrome actions in one browser_batch call. On its own, an input action
// (click, type, key, form_input) took 2 to 9 s inside the mod; in a batch the same click took
// 130 ms (bench/results/summary.md, speed). Returns each item's text, in order.
// The URL each tab last reported, read from tool output, so the safety sort needs no extra
// tabs_context call per batch.
const urlOf = new Map<number, string>()
function noteUrls(text: string) {
  for (const m of text.matchAll(/tabId (\d+): "[^"\n]*" \("([^"\n]+)"\)/g)) urlOf.set(Number(m[1]), m[2]!)
}

async function batch($: $, items: Item[]): Promise<string[]> {
  const text = await chrome($, 'browser_batch', { actions: items })
  noteUrls(text)
  const starts: [number, number][] = []
  let from = 0
  for (const item of items) {
    const m = new RegExp(`\\[${item.name}(?::\\w+)?\\] ?`).exec(text.slice(from))
    if (!m) throw new Fallback('tool-error', `browser_batch: no output for ${item.name}`)
    starts.push([from + m.index, from + m.index + m[0].length])
    from = from + m.index + m[0].length
  }
  return starts.map(([, body], n) => {
    const end = n + 1 < starts.length ? starts[n + 1]![0] : text.length
    return text.slice(body, end).split('\n\nTab Context:')[0]!.trim()
  })
}

// The local bridge (option "bridge", off by default). The browser's native host for the Claude
// in Chrome extension listens on /tmp/claude-mcp-browser-bridge-$USER/<pid>.sock; mod/bridge/
// call.py sends one framed call to it and prints the reply (~50-300 ms). A call there is not
// one of Claude Code's tool calls, so it gets no per-action review (~2 s each): the extension's
// own site permissions, blocklists and tab-group limit still apply, and the mod's own sort is
// the review. The bridge's tab group is the mod's own, in the chosen browser (Comet by default),
// with your sign-ins; Claude's tools cannot reach its tabs.
let via: { browser: string; socket?: string } | undefined

async function bridgeTool($: $, tool: string, args: Record<string, unknown>): Promise<string> {
  const t = Date.now()
  const request = JSON.stringify({ tool, args, browser: via!.browser, ...(via!.socket ? { socket: via!.socket } : {}), timeout: 20 })
  const run = await $.process.run(['python3', `${$.plugin.root}/bridge/call.py`], { stdin: request, timeoutMs: 25_000 })
  tick(`bridge:${tool}${args.action ? `:${String(args.action)}` : ''}${args.filter ? `:${String(args.filter)}` : ''}`, t)
  let out: { socket?: string; result?: { content?: { type: string; text?: string }[] }; error?: unknown }
  try {
    out = JSON.parse(run.stdout)
  } catch {
    throw new Fallback('tool-error', `bridge: ${(run.stderr || run.stdout).slice(0, 300)}`)
  }
  if (out.socket) via!.socket = out.socket
  if (out.error !== undefined || !out.result) throw new Fallback('tool-error', `bridge ${tool}: ${JSON.stringify(out.error).slice(0, 300)}`)
  return textOf(out.result)
}

// The session's permission mode, from the classic hooks (a tool.call input does not carry it).
// It can change during a session (Shift+Tab), so it is read again at each prompt.
let permissionMode: string | undefined

// Fail closed. A rule that denies: never. A rule that allows: yes. No rule ("ask"): only where
// no person would be asked anyway, auto (the classifier would decide; clef-flash's routine
// verdict decides instead) and bypassPermissions. In default, acceptEdits, plan or dontAsk
// mode, or an unknown one, "ask" means a prompt to the person or a refusal: the built-in path.
export function fastAllowed(decision: string, mode: string | undefined): boolean {
  if (decision === 'allow') return true
  if (decision !== 'ask') return false
  return mode === 'auto' || mode === 'bypassPermissions'
}

// Before a browse goes over the bridge: your rules and mode allow opening the page, and no risk
// word or injection is in the URL or a step. clef-flash judges the grounded elements before each
// batch runs (allRoutine).
async function bridgeable($: $, cfg: Cfg, url: string, steps: string[]): Promise<boolean> {
  if (!cfg.bridge) return false
  const t = Date.now()
  try {
    const { decision } = await $.tool.check({ tool: `${CHROME}navigate`, input: { url } } as never)
    if (!fastAllowed(decision, permissionMode)) {
      $.ui.log(`${PLUGIN}: bridge not used (rules ${decision}, mode ${permissionMode})`, { to: 'debug' })
      return false
    }
    const actions = [{ step: 'open the page', element: 'the page (link)' }, ...steps.map(step => ({ step, element: step }))].map(a => ({ ...a, url }))
    const risky = actions.find(a => wordsSayRisky(a))
    if (risky) {
      $.ui.log(`${PLUGIN}: bridge not used: risk word in "${risky.step}" or ${url}`, { to: 'debug' })
      return false
    }
    // No model call here: a step-level sort of 5 steps cost 2.8 s and mostly repeated what the
    // word rules show. The model judges each grounded element where that adds information.
    return true
  } catch {
    return false
  } finally {
    tick('bridge:sort', t)
  }
}

// Every queued action is routine. A scroll or wait always is; the rest go through isRoutine
// with the tab's current URL.
type Safety = Omit<Action, 'url'> | 'safe'
async function allRoutine($: $, cfg: Cfg, tabId: number, actions: Safety[]): Promise<boolean> {
  const t = Date.now()
  try {
    const url = urlOf.get(tabId) ?? /\((\S+)\)$/.exec(await pageNow($, tabId))?.[1] ?? ''
    if (!url) return false
    // The model judges an element only where it adds information: its name has words the step
    // lacked, or the step names nothing in quotes ("click the blue button"). An exact-name step
    // on an exactly-named element is settled by the word rules, which run on every action.
    const checked = actions
      .filter((a): a is Omit<Action, 'url'> => a !== 'safe')
      .map(a => ({ ...a, url }))
      .filter(a => wordsSayRisky(a) || addsWords(a.step, a.element) || !/["“]/.test(a.step))
    const verdicts = await areRoutine(makeClient($, cfg), checked, cfg.routineAt)
    verdicts.forEach((v, n) => $.ui.log(`${PLUGIN}: SORT ${v.routine ? 'routine' : 'review'} p=${v.p.toFixed(2)} ${v.reason} "${checked[n]!.step}" -> ${checked[n]!.element} @ ${url}`, { to: 'debug' }))
    return verdicts.every(v => v.routine)
  } finally {
    tick('bridge:sort', t)
  }
}

const wordsOf = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map(w => w.replace(/(ing|ed|es|s)$/, ''))
// True when the element's name (role hints aside) has a word the step text lacks.
function addsWords(step: string, element: string): boolean {
  const have = new Set(wordsOf(step))
  return wordsOf(element.replace(/\s*\([^)]*\)\s*$/, '')).some(w => !have.has(w))
}

// read_page "interactive" lists the elements in the viewport and "all" names them (with the
// <label> text "interactive" drops); the refs are the same in both.
function readItems(tabId: number): Item[] {
  return [
    { name: 'read_page', input: { tabId, filter: 'interactive' } },
    { name: 'read_page', input: { tabId, filter: 'all' } },
  ]
}

function pageOf(interactive: string, all: string): Page {
  const refs = new Set(interactive.match(/\bref_\d+\b/g) ?? [])
  const elements = parse(all)
  return { all: elements, visible: elements.filter(e => refs.has(e.ref)), key: all }
}

async function readPage($: $, tabId: number): Promise<Page> {
  const [interactive = '', all = ''] = await batch($, readItems(tabId))
  return pageOf(interactive, all)
}

const soft = (err: unknown) => err instanceof Fallback && ['no-elements', 'low-gate'].includes(err.reason)

// The elements in the viewport first: read_page "all" also lists hidden elements (GOV.UK's
// collapsed banner search box won once, and Enter in it did nothing). Then only the rest, so no
// element is asked about twice.
async function groundIn($: $, cfg: Cfg, step: ReturnType<typeof parseStep>, page: Page): Promise<Element> {
  if (page.visible.length) {
    try {
      return (await ground(makeClient($, cfg), step, page.visible, cfg.tuning)).element
    } catch (err) {
      if (!soft(err)) throw err
    }
  }
  const shown = new Set(page.visible)
  const rest = page.all.filter(e => !shown.has(e))
  if (!rest.length && page.visible.length) throw new Fallback('low-gate', `nothing on the page matches: ${step.text}`)
  return (await ground(makeClient($, cfg), step, rest, cfg.tuning)).element
}

// Ground a step. When the page may still be loading (no element, low gate, read_page refused
// mid-navigation), read it again after a pause; a stale page is cheaper to retry than a Claude
// turn. A third try runs only when the page changed: on docs one hopeless step used to cost 18
// model calls and 30 s.
async function groundSettled($: $, cfg: Cfg, step: ReturnType<typeof parseStep>, tabId: number, page: Page | undefined): Promise<{ el: Element; page: Page }> {
  let current = page
  for (let attempt = 0; ; attempt++) {
    try {
      current ??= await readPage($, tabId)
      return { el: await groundIn($, cfg, step, current), page: current }
    } catch (err) {
      const wait = RETRY_MS[attempt]
      const stale = soft(err) || (err instanceof Fallback && /web page first|loading/i.test(err.message))
      if (!stale || wait === undefined) throw err
      const before = current?.key
      await pause($, wait)
      current = undefined
      try {
        current = await readPage($, tabId)
      } catch {
        continue
      }
      if (attempt >= 1 && current.key === before) throw err
    }
  }
}

// Load the models before the first browse step: a cold clef-flash took more than 8 s once,
// timed out, and the job fell back to Claude. Errors are ignored.
async function warm($: $, cfg: Cfg) {
  const client = { ...makeClient($, cfg), timeoutMs: 120_000 }
  try {
    await ask(client, 'warm-up', { w: { type: 'noul', instructions: 'Is this text a warm-up?' } })
    await embed(client, 'warm-up', ['warm-up'])
  } catch {
    // the first real request pays the load instead
  }
}

// The tab's title and URL as the browser reports them.
async function pageNow($: $, tabId: number): Promise<string> {
  try {
    const text = await chrome($, 'tabs_context_mcp', {})
    const tabs = (JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { availableTabs?: { tabId: number; title: string; url: string }[] }).availableTabs
    const tab = tabs?.find(t => t.tabId === tabId)
    return tab ? `Page now: "${tab.title}" (${tab.url})` : ''
  } catch {
    return ''
  }
}

// A tab Chrome is not painting (visibilityState "hidden") ignores ref clicks until a frame is
// drawn; a tiny screenshot draws one. Plain Claude never sees this: it screenshots often. It goes
// into the step's batch, so Claude never pays tokens for it. No Escape: it closed a 1Password
// menu once, but it also clears GOV.UK's search box.
function paint(tabId: number): Item[] {
  // On the bridge too: with the Comet window behind, clicks and typing were lost without it.
  return [{ name: 'computer', input: { tabId, action: 'screenshot', scale: 0.1 } }]
}

async function elementsOf($: $, tabId: number) {
  return parse(await chrome($, 'read_page', { tabId, filter: 'all' }))
}

export const register: Register = (on, options) => {
  const mode = String(options.mode ?? 'shadow') as 'off' | 'shadow' | 'active'
  const tuning: Tuning = {
    ...DEFAULT_TUNING,
    gate: Number(options.gate ?? DEFAULT_TUNING.gate),
    minMargin: Number(options.min_margin ?? DEFAULT_TUNING.minMargin),
    // 0.95: no wrong pick on the 36 negative steps; at 0.8 one wrong pick (bench/ground.ts).
    ...(Number(options.skip_gate_at ?? 0.95) < 1 ? { skipGateAt: Number(options.skip_gate_at ?? 0.95) } : {}),
  }
  const cfg: Cfg = {
    mode,
    tuning,
    timeoutMs: Number(options.timeout_ms ?? 8000),
    url: String(options.ollama_url ?? 'http://localhost:11434/v1/systemone'),
    model: String(options.model ?? 'clef-flash'),
    embedModel: String(options.embed_model ?? 'nomic-embed-text'),
    settleMs: Number(options.settle_ms ?? 0),
    bridge: options.bridge === true,
    bridgeBrowser: String(options.bridge_browser ?? 'Comet'),
    // 0.65: in batches, risky actions scored 0.54 at most and routine ones 0.68 at least (bar one
    // at 0.37), bench/safety.ts on 49 actions: a small margin on a small set.
    routineAt: Number(options.routine_at ?? 0.65),
  }
  const feature = (k: string) => mode !== 'off' && options[k] !== false

  on('classic.SessionStart', ($, e, next) => {
    permissionMode = (e as { permission_mode?: string }).permission_mode ?? permissionMode
    return next(e)
  })
  on('classic.UserPromptSubmit', ($, e, next) => {
    permissionMode = (e as { permission_mode?: string }).permission_mode ?? permissionMode
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    if (mode !== 'off') $.clock.after(0, () => warm($, cfg))
    // Each tool registers on its own: one refusal (e.g. a session started with --tools "")
    // must not keep the others away.
    if (feature('browse')) {
      await $.tool.register({
        name: 'browse',
        description:
          'Run plain browser steps in Claude-in-Chrome with a fast local model, all in one call, without screenshots. ' +
          'Give `url` to open a page first (a tab is created when you give no tabId). ' +
          'Steps: click/open/tick <thing>, type "value" into <field>, select "option" for <field>, press enter, scroll, scroll up, wait. Put exact names and typed values in quotes. ' +
          'Give `expect`, a yes/no question about the final page (e.g. "Does the page show the Casa Flora hotel?"), to have the result checked locally. ' +
          'It stops at the first step it is not sure about and says which; continue from there with the normal claude-in-chrome tools.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'A page to open before the steps.' },
            tabId: { type: 'number', description: 'The Claude-in-Chrome tab. Omit it with url to create one.' },
            steps: { type: 'array', items: { type: 'string' }, description: 'Plain steps, in order.' },
            expect: { type: 'string', description: 'A yes/no question about the final page.' },
          },
          required: ['steps'],
        },
      }).catch(err => $.ui.log(`${PLUGIN}: browse not offered: ${err}`, { to: 'debug' }))
    }
    if (feature('check')) {
      await $.tool.register({
        name: 'check',
        description:
          'Ask a fast local model a yes/no question about the page open in a Claude-in-Chrome tab, e.g. "Does the page say the form was sent?". ' +
          'Set screenshot: true for a visual question the text cannot answer (is a box ticked, which option is shown). ' +
          'Answers yes, no, or unsure; on unsure, look at the page yourself.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            question: { type: 'string', description: 'A yes/no question about what the page shows.' },
            screenshot: { type: 'boolean', description: 'Also show the model a screenshot. Slower; for visual questions.' },
          },
          required: ['tabId', 'question'],
        },
      }).catch(err => $.ui.log(`${PLUGIN}: check not offered: ${err}`, { to: 'debug' }))
    }
    return out
  })

  // The tool description alone did not get browse used (1 call in 5 jobs, bench/e2e.ts): say when.
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (cfg.mode !== 'active' || !e.tools.includes(BROWSE)) return out
    return {
      sections: [
        ...out.sections,
        {
          id: 'clef-chrome:browse',
          scope: 'session' as const,
          text:
            'Browser tasks: when you can name the steps (open a page, fill fields, tick boxes, click named buttons or links), ' +
            `call ${BROWSE} once with url, all the steps and an expect question, before you take screenshots or read the page. ` +
            'It runs on a local model and saves turns. If it stops at a step, continue from there with the claude-in-chrome tools.',
        },
      ],
    }
  })

  // browse(steps): the saving is in Claude turns. One call opens the page, runs the steps and
  // checks the result, where plain Claude-in-Chrome spends a turn on each of those.
  on('tool.call', { tool: BROWSE }, async ($, e) => {
    const input = e as unknown as { tabId?: unknown; url?: unknown; steps?: unknown; expect?: unknown }
    const steps = input.steps
    const valid =
      Array.isArray(steps) &&
      steps.every(x => typeof x === 'string') &&
      (typeof input.tabId === 'number' || typeof input.url === 'string') &&
      (input.expect === undefined || typeof input.expect === 'string')
    if (!valid) {
      return { result: 'browse needs { steps: string[] } and a tabId or a url. Nothing was done; use the normal claude-in-chrome tools.' }
    }
    const log: string[] = []
    const startedAt = Date.now()
    timing = {}
    let tabId = input.tabId as number | undefined
    let page: Page | undefined
    // Over the local bridge only when the whole browse reads as routine and the mode allows it;
    // a tabId from Claude's own group can only be reached with Claude's tools.
    const bridged = typeof input.url === 'string' && tabId === undefined && (await bridgeable($, cfg, input.url, steps as string[]))
    via = bridged ? { browser: cfg.bridgeBrowser } : undefined
    try {
    if (typeof input.url === 'string') {
      const url = input.url
      const r = await guarded($, cfg, async () => {
        if (tabId === undefined) {
          // A tab, then navigate and the first reads in one round trip (a standalone navigate took
          // 2 to 4 s and the reads another batch). The session's group must exist before
          // tabs_create_mcp works; its first, empty tab is reused.
          const ctx = await chrome($, 'tabs_context_mcp', { createIfEmpty: true })
          const tabs = (JSON.parse(ctx.slice(ctx.indexOf('{'), ctx.lastIndexOf('}') + 1)) as { availableTabs?: { tabId: number; url: string }[] }).availableTabs ?? []
          const empty = tabs.find(t => t.url === '' || t.url === 'about:blank' || t.url.startsWith('chrome://newtab'))
          let id = empty?.tabId
          // The bridge's group is the mod's own: keep it to MAX_TABS by reusing the oldest tab
          // and closing the rest. 33 left-over tabs made Comet's batches 3 to 5 times slower.
          if (id === undefined && via && tabs.length >= MAX_TABS) {
            id = tabs[0]!.tabId
            for (const extra of tabs.slice(MAX_TABS)) await chrome($, 'tabs_close_mcp', { tabId: extra.tabId }).catch(() => undefined)
          }
          if (id === undefined) {
            const text = await chrome($, 'tabs_create_mcp', {})
            id = Number(/Tab ID: (\d+)/.exec(text)?.[1] ?? /Executed on tabId: (\d+)/.exec(text)?.[1])
          }
          if (!Number.isFinite(id)) throw new Fallback('tool-error', 'no tab to open the page in')
          tabId = id
        }
        const id = tabId
        const [, interactive = '', all = ''] = await batch($, [{ name: 'navigate', input: { url, tabId: id } }, ...readItems(id)])
        page = pageOf(interactive, all)
        return id
      })
      if (!r.ok) return { result: `✗ open ${url}: not done (${r.detail}). Use the normal claude-in-chrome tools.` }
      tabId = r.value
      log.push(`✓ opened ${url} in tab ${tabId}${bridged ? ` (${cfg.bridgeBrowser}, over the local bridge)` : ''}`)
    }
    const tab = tabId!
    const all = steps as string[]
    let lastField: Element | undefined
    let lastFieldStep: string | undefined
    let beforeLast: string | undefined
    let finalText: string | undefined
    // Steps that do not change the page (fill, tick, select) are grounded on the page as it is
    // and queued; a click, Enter, scroll or wait closes the batch. Each batch costs ~2.5 s
    // whatever it holds, so signup's five steps now take one batch instead of five.
    let queue: { step: number; items: Item[]; did: string; safety: Safety; changes: boolean }[] = []
    const failAt = async (i: number, detail: string) => {
      log.push(`✗ ${all[i]}: not done (${detail}).`)
      const rest = all.slice(i + 1)
      if (rest.length) log.push(`Not run: ${rest.map(x => JSON.stringify(x)).join(', ')}.`)
      const now = await pageNow($, tab)
      if (bridged) {
        log.push(`Tab ${tab} is in clef-chrome's own tab group in ${cfg.bridgeBrowser}; your tools cannot reach it.`)
        log.push('Continue with the normal claude-in-chrome tools: open the page below in your own tab and do this step and the rest there.')
      } else {
        log.push(`Continue with the normal claude-in-chrome tools from this step (tab ${tab}).`)
      }
      logTiming($, i + 1, startedAt)
      if (now) log.push(now)
      return { result: log.join('\n') }
    }
    // Run the queued actions, then read the page for the next step (not after the last one:
    // expect reads the page text itself). Resolves the failed step, if any.
    const flush = async (last: boolean): Promise<{ step: number; detail: string } | undefined> => {
      if (!queue.length) return undefined
      const items = queue.flatMap(q => q.items)
      const owner = queue.flatMap(q => q.items.map(() => q.step))
      if (bridged && !(await allRoutine($, cfg, tab, queue.map(q => q.safety)))) {
        // Fail closed: nothing in this batch runs. Claude does it, reviewed, in its own tab.
        const first = queue[0]!.step
        queue = []
        page = undefined
        return { step: first, detail: 'this action needs a review, so it was not run over the bridge' }
      }
      const before = page?.key
      const expectsChange = queue.some(q => q.changes)
      const r = await guarded($, cfg, async () => {
        // No settle wait by default (settle_ms): the extension already waits after a batch of input
        // actions, and a page that is still changing is caught by groundSettled's retry.
        const settle: Item[] = cfg.settleMs > 0 ? [{ name: 'computer', input: { tabId: tab, action: 'wait', duration: cfg.settleMs / 1000 } }] : []
        const tail: Item[] = last ? (typeof input.expect === 'string' ? [{ name: 'get_page_text', input: { tabId: tab } }] : []) : readItems(tab)
        const out = await batch($, [...items, ...settle, ...tail])
        if (last && tail.length) finalText = out[out.length - 1]
        page = last ? undefined : pageOf(out[out.length - 2] ?? '', out[out.length - 1] ?? '')
        // A click or Enter that left the page exactly as it was did not land (a lost click, an
        // empty search): grounding the next step on the old page clicked a wrong link once
        // (GOV.UK home page, bench/speed.ts). Look once more, then stop.
        if (page && before !== undefined && expectsChange && page.key === before) {
          await pause($, RETRY_MS[0]!)
          page = await readPage($, tab)
          if (page.key === before) throw new Fallback('no-elements', 'the page did not change, so the action probably did not land')
        }
      })
      const n = r.ok ? undefined : /actions\[(\d+)\]/.exec(r.detail)?.[1]
      if (!r.ok && n !== undefined && Number(n) >= items.length) {
        // Only a read failed (a page mid-navigation: "Page script returned
        // empty result"): the actions ran. Read the page again before the next step.
        page = undefined
      } else if (!r.ok) {
        const failed = n !== undefined ? owner[Number(n)] ?? queue[0]!.step : queue[0]!.step
        for (const q of queue) if (q.step < failed) log.push(`✓ ${all[q.step]}${q.did ? ` → ${q.did}` : ''}`)
        queue = []
        page = undefined
        return { step: failed, detail: r.detail }
      }
      for (const q of queue) log.push(`✓ ${all[q.step]}${q.did ? ` → ${q.did}` : ''}`)
      queue = []
      return undefined
    }
    for (const [i, text] of all.entries()) {
      const step = parseStep(text)
      const lastStep = i === all.length - 1
      let items: Item[]
      let did = ''
      let changes = true
      let safety: Safety = 'safe'
      if (step.kind === 'enter') {
        // Enter submits the field just filled: it shares that field's check (an unknown field: the model).
        safety = lastFieldStep && lastField ? { step: lastFieldStep, element: `${lastField.label} (${lastField.role})` } : { step: text, element: 'the focused field' }
        items = [...paint(tab), { name: 'computer', input: { tabId: tab, action: 'key', text: 'Enter', action_summary: 'Presses Enter' } }]
      } else if (step.kind === 'wait') {
        items = [{ name: 'computer', input: { tabId: tab, action: 'wait', duration: 1 } }]
      } else if (step.kind === 'scroll_down' || step.kind === 'scroll_up') {
        const direction = step.kind === 'scroll_down' ? 'down' : 'up'
        items = [{ name: 'computer', input: { tabId: tab, action: 'scroll', coordinate: [600, 400], scroll_direction: direction } }]
      } else {
        // With actions queued the page is not yet up to date: one try on it, and on a miss run
        // the queue and ground again with the retries (a typed search can add suggestions).
        let g = queue.length && page
          ? await guarded($, cfg, async () => ({ el: await groundIn($, cfg, step, page!), page: page! }))
          : await guarded($, cfg, () => groundSettled($, cfg, step, tab, page))
        if (!g.ok && queue.length) {
          const f = await flush(false)
          if (f) return failAt(f.step, f.detail)
          g = await guarded($, cfg, () => groundSettled($, cfg, step, tab, page))
        }
        if (!g.ok) {
          const f = await flush(true)
          return failAt(f ? f.step : i, f ? f.detail : g.detail)
        }
        const el = g.value.el
        page = g.value.page
        did = `${el.label} [${el.ref}]`
        safety = { step: text, element: `${el.label} (${[el.role, el.hint].filter(Boolean).join(', ')})`, ...(step.value ? { value: step.value } : {}) }
        if (el.kind === 'fill') {
          lastField = el
          lastFieldStep = text
        }
        changes = false
        if (el.kind === 'click' && TOGGLES.has(el.role)) {
          // form_input sets the state, so "tick X" never unticks a box that is already ticked.
          const ticked = !OFF.test(step.text)
          items = [{ name: 'form_input', input: { tabId: tab, ref: el.ref, value: ticked, action_summary: `${ticked ? 'Ticks' : 'Unticks'} "${el.label}"` } }]
        } else if (el.kind === 'click') {
          items = [...paint(tab), { name: 'computer', input: { tabId: tab, action: 'left_click', ref: el.ref, action_summary: `Clicks "${el.label}"` } }]
          changes = true
        } else if (el.kind === 'fill' && SEARCHY(el)) {
          // A script-driven search box (GOV.UK, Wikipedia) keeps its own copy of the text: a value
          // set by form_input was dropped on submit and the search ran empty. Keystrokes are seen.
          // Only search boxes: on a name or email field 1Password's menu took the keystrokes
          // ("Cannot access a chrome-extension:// URL"), and form_input works there.
          const value = step.value ?? ''
          items = [
            ...paint(tab),
            { name: 'computer', input: { tabId: tab, action: 'triple_click', ref: el.ref, action_summary: `Selects the text in "${el.label}"` } },
            { name: 'computer', input: { tabId: tab, action: 'type', text: value, action_summary: `Types "${value}" into "${el.label}"` } },
          ]
        } else {
          const value = el.kind === 'select' ? el.value! : step.value ?? ''
          items = [{ name: 'form_input', input: { tabId: tab, ref: el.ref, value, action_summary: `Sets "${el.label.split(' → ')[0]}" to "${value}"` } }]
        }
      }
      queue.push({ step: i, items, did, safety, changes })
      if (changes || lastStep) {
        // The page as it was before the last action: expect waits until it is not.
        if (lastStep && changes && typeof input.expect === 'string') beforeLast = await pageNow($, tab)
        const f = await flush(lastStep)
        if (f) return failAt(f.step, f.detail)
      }
    }
    log.push(`All steps done in tab ${tab}.`)
    if (bridged) log.push(`Ran over the local ${cfg.bridgeBrowser} bridge: no per-action review; the extension's site rules applied. Tab ${tab} is in clef-chrome's own tab group.`)
    tick('steps-total', startedAt)
    const expectAt = Date.now()
    if (typeof input.expect === 'string') {
      // Check at once, on the page text the last batch read. Only a "no" or "unsure" waits: poll
      // the title and URL until the last click or Enter has changed the page (a navigation can
      // outlast the batch: Wikipedia search did), at most 2 s, then look once more.
      let verdict = await checkPage($, cfg, tab, input.expect, false, finalText)
      if (!verdict.startsWith('yes')) {
        if (beforeLast !== undefined) {
          const until = Date.now() + EXPECT_POLL_MAX_MS
          while (Date.now() < until && (await pageNow($, tab)) === beforeLast) await pause($, EXPECT_POLL_MS)
        } else {
          await pause($, EXPECT_RETRY_MS)
        }
        verdict = await checkPage($, cfg, tab, input.expect)
      }
      log.push(`Check "${input.expect}": ${verdict}`)
    }
    tick('expect', expectAt)
    const now = await pageNow($, tab)
    if (now) log.push(now)
    logTiming($, (steps as string[]).length, startedAt)
    return { result: log.join('\n') }
    } finally {
      // The bridge serves this browse only; check, find and the next browse decide again.
      via = undefined
    }
  })

  // check(question): a yes/no about the page text. Never a low-confidence yes or no.
  on('tool.call', { tool: CHECK }, async ($, e) => {
    const { tabId, question, screenshot } = e as unknown as { tabId: number; question: string; screenshot?: boolean }
    if (typeof tabId !== 'number' || typeof question !== 'string') {
      return { result: 'unsure: check needs { tabId: number, question: string }. Look at the page yourself.' }
    }
    return { result: await checkPage($, cfg, tabId, question, screenshot === true) }
  })

  // find: answer locally when confident; otherwise, and in shadow mode, the real find runs.
  on('tool.call', { tool: `${CHROME}find` }, async ($, e, next) => {
    if (!feature('find')) return next(e)
    const { tabId, query } = e as unknown as { tabId: number; query: string }
    const local = () =>
      guarded($, cfg, async () => {
        const g = await ground(makeClient($, cfg), { text: String(query), kind: 'any' }, await elementsOf($, tabId), tuning)
        return g.element
      })
    if (mode === 'shadow') {
      const [real, mine] = await Promise.all([next(e), local()])
      const realText = real.deny === undefined && !real.isError ? (real.text ?? textOf(real.result)) : ''
      if (mine.ok && realText) {
        const agree = new RegExp(`\\b${mine.value.ref}\\b`).test(realText)
        await record($, cfg, m => (agree ? m.shadow.agree++ : m.shadow.disagree++))
        $.ui.log(`${PLUGIN} shadow find "${query}": local ${mine.value.ref} ${agree ? 'agrees' : 'DISAGREES'}`, { to: 'debug' })
      }
      return real
    }
    const mine = await local()
    if (!mine.ok) return next(e)
    return { result: { content: [{ type: 'text', text: findText([mine.value]) }], isError: false } }
  })
}
