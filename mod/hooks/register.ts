// clef-chrome: answer small Claude-in-Chrome decisions with a local Ollama decision model.
//
// The fallback contract: any doubt goes back to Claude. A Fallback (Ollama down, timeout, bad
// answer, low gate, low margin, no elements, tool error) or any exception means the real tool
// runs (find), or the tool stops and hands the rest of the job back to Claude (browse, check).
// Three Ollama failures in a row open a breaker for five minutes.

import type { Register } from 'claude-code'
import type { ClefChromeMetrics } from '../types'
import { DEFAULT_TUNING, ground, parseStep, type Tuning } from './ground.ts'
import { ask, type Client, Fallback, type Reason } from './systemone.ts'
import { findText, parse } from './tree.ts'

const PLUGIN = 'clef-chrome'
const CHROME = 'mcp__claude-in-chrome__'
const BROWSE = `mcp__${PLUGIN}__browse`
const CHECK = `mcp__${PLUGIN}__check`
const BREAKER_FAILS = 3
const BREAKER_MS = 5 * 60_000
const PAGE_TEXT_CHARS = 12_000
// A click or Enter can start a page load or a re-render that read_page would miss.
const SETTLE_MS = 400
const TOGGLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'])
const OFF = /\b(untick|uncheck|turn off|switch off|clear|deselect|disable|remove)\b/i
const RETRY_MS = [800, 1600]
const EXPECT_WAIT_MS = [1000, 1500]
const OLLAMA_REASONS: Reason[] = ['ollama-down', 'http-error', 'timeout', 'bad-json']

const metricsRef = { plugin: 'clef-chrome', key: 'metrics' } as const
const EMPTY: ClefChromeMetrics = { local: 0, fallback: {}, shadow: { agree: 0, disagree: 0 }, ms: 0 }

type $ = Parameters<Parameters<Parameters<Register>[0]>[2]>[0]

type Cfg = { mode: 'off' | 'shadow' | 'active'; tuning: Tuning; timeoutMs: number; url: string; model: string; embedModel: string }

// Kept per module load: a hot reload closes the breaker, which is fine.
let fails = 0
let openUntil = 0
let lastNow = 0

function makeClient($: $, cfg: Cfg): Client {
  return {
    url: cfg.url,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    keepAlive: '30m',
    embedModel: cfg.embedModel || undefined,
    post: async (url, body, ms) => {
      const started = await $.clock.now()
      const res = await Promise.race([
        $.http.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
        $.clock.sleep(ms).then(() => 'timeout' as const),
      ])
      const took = (await $.clock.now()) - started
      $.ui.log(`${PLUGIN}: ${url.endsWith('/api/embed') ? 'embed' : 'systemone'} ${body.length} chars ${res === 'timeout' ? 'TIMEOUT' : res.status} ${took} ms`, { to: 'debug' })
      if (res === 'timeout') throw new Fallback('timeout', `${ms} ms`)
      return { status: res.status, text: res.text }
    },
  }
}

async function record($: $, cfg: Cfg, change: (m: ClefChromeMetrics) => void) {
  const { value } = await $.state.get(metricsRef)
  const m: ClefChromeMetrics = JSON.parse(JSON.stringify(value ?? ((await $.store.get('metrics')) as ClefChromeMetrics | undefined) ?? EMPTY))
  change(m)
  await $.state.set(metricsRef, m)
  await $.store.set('metrics', m)
  const back = Object.values(m.fallback).reduce((a, b) => a + b, 0)
  const shadow = cfg.mode === 'shadow' ? ` · shadow ${m.shadow.agree}/${m.shadow.agree + m.shadow.disagree} agree` : ''
  const breaker = lastNow < openUntil ? ' · breaker open' : ''
  $.ui.status(`clef: ${m.local} local · ${back} → claude${shadow}${breaker}`)
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
  const r = await $.tool.call({ tool: `${CHROME}${tool}`, ...args } as never)
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
async function checkPage($: $, cfg: Cfg, tabId: number, question: string, screenshot = false): Promise<string> {
  const r = await guarded($, cfg, async () => {
    // Title and URL as their own fields, and the question asked about the open page itself: on
    // a GOV.UK results page "is this the passport guide?" scored 0.94 from plain text, because
    // the guide is the first result (bench/check.ts, mode "page").
    const raw = await chrome($, 'get_page_text', { tabId })
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

// Ground a step; when the page may still be loading (no element, low gate, read_page refused
// mid-navigation), read it again after a pause. Retrying a stale page is cheaper than a Claude turn.
// Each attempt tries the elements in the viewport first: read_page "all" also lists hidden
// elements (GOV.UK's collapsed banner search box won once, and Enter in it did nothing).
async function groundSettled($: $, cfg: Cfg, step: ReturnType<typeof parseStep>, tabId: number) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { all, visible } = await pageElements($, tabId)
      try {
        if (visible.length) return (await ground(makeClient($, cfg), step, visible, cfg.tuning)).element
      } catch (err) {
        if (!(err instanceof Fallback && ['no-elements', 'low-gate'].includes(err.reason))) throw err
      }
      return (await ground(makeClient($, cfg), step, all, cfg.tuning)).element
    } catch (err) {
      const wait = RETRY_MS[attempt]
      const stale = err instanceof Fallback && (['no-elements', 'low-gate'].includes(err.reason) || /web page first|loading/i.test(err.message))
      if (!stale || wait === undefined) throw err
      await $.clock.sleep(wait)
    }
  }
}

// The page's elements, named from the full tree, and the ones read_page "interactive" lists:
// that filter keeps only elements visible in the viewport, and the refs are the same.
async function pageElements($: $, tabId: number) {
  const shown = await chrome($, 'read_page', { tabId, filter: 'interactive' })
  const refs = new Set(shown.match(/\bref_\d+\b/g) ?? [])
  const all = parse(await chrome($, 'read_page', { tabId, filter: 'all' }))
  return { all, visible: all.filter(e => refs.has(e.ref)) }
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

// Make the next ref click land: a tab Chrome is not painting (visibilityState "hidden")
// ignores ref clicks until a frame is drawn, and a tiny screenshot draws one. Plain Claude never
// sees this: it screenshots often. The screenshot stays inside this hook (no Claude tokens).
// No Escape: it closed a 1Password menu once, but it also clears GOV.UK's search box, and with
// typed fills plus this screenshot the menu no longer blocked a click (bench/e2e.ts, hotels).
async function prepareClick($: $, tabId: number) {
  await chrome($, 'computer', { tabId, action: 'screenshot', scale: 0.1 })
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
  }
  const cfg: Cfg = {
    mode,
    tuning,
    timeoutMs: Number(options.timeout_ms ?? 8000),
    url: String(options.ollama_url ?? 'http://localhost:11434/v1/systemone'),
    model: String(options.model ?? 'clef-flash'),
    embedModel: String(options.embed_model ?? 'nomic-embed-text'),
  }
  const feature = (k: string) => mode !== 'off' && options[k] !== false

  on('session.start', async ($, e, next) => {
    const out = await next(e)
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
    let tabId = input.tabId as number | undefined
    if (typeof input.url === 'string') {
      const r = await guarded($, cfg, async () => {
        const text = await chrome($, 'navigate', tabId === undefined ? { url: input.url } : { url: input.url, tabId })
        const id = Number(/Executed on tabId: (\d+)/.exec(text)?.[1] ?? /tabId (\d+)/.exec(text)?.[1])
        if (!Number.isFinite(id)) throw new Fallback('tool-error', 'no tab id in the navigate result')
        return id
      })
      if (!r.ok) return { result: `✗ open ${input.url}: not done (${r.detail}). Use the normal claude-in-chrome tools.` }
      tabId = r.value
      log.push(`✓ opened ${input.url} in tab ${tabId}`)
    }
    const tab = tabId!
    for (const [i, text] of (steps as string[]).entries()) {
      const step = parseStep(text)
      const r = await guarded($, cfg, async () => {
        if (step.kind === 'enter') {
          await prepareClick($, tab)
          await chrome($, 'computer', { tabId: tab, action: 'key', text: 'Enter', action_summary: 'Presses Enter' })
          return void (await $.clock.sleep(SETTLE_MS))
        }
        if (step.kind === 'wait') return void (await chrome($, 'computer', { tabId: tab, action: 'wait', duration: 1 }))
        if (step.kind === 'scroll_down' || step.kind === 'scroll_up') {
          const direction = step.kind === 'scroll_down' ? 'down' : 'up'
          return void (await chrome($, 'computer', { tabId: tab, action: 'scroll', coordinate: [600, 400], scroll_direction: direction }))
        }
        const el = await groundSettled($, cfg, step, tab)
        if (el.kind === 'click' && TOGGLES.has(el.role)) {
          // form_input sets the state, so "tick X" never unticks a box that is already ticked.
          const ticked = !OFF.test(step.text)
          await chrome($, 'form_input', { tabId: tab, ref: el.ref, value: ticked, action_summary: `${ticked ? 'Ticks' : 'Unticks'} "${el.label}"` })
        } else if (el.kind === 'click') {
          await prepareClick($, tab)
          await chrome($, 'computer', { tabId: tab, action: 'left_click', ref: el.ref, action_summary: `Clicks "${el.label}"` })
        } else if (el.kind === 'fill') {
          // A script-driven box (GOV.UK, Wikipedia search) keeps its own copy of the text: a value
          // set by form_input was dropped on submit and the search ran empty. Keystrokes are seen.
          const value = step.value ?? ''
          await prepareClick($, tab)
          await chrome($, 'computer', { tabId: tab, action: 'triple_click', ref: el.ref, action_summary: `Selects the text in "${el.label}"` })
          await chrome($, 'computer', { tabId: tab, action: 'type', text: value, action_summary: `Types "${value}" into "${el.label}"` })
        } else {
          const value = el.kind === 'select' ? el.value! : step.value ?? ''
          await chrome($, 'form_input', { tabId: tab, ref: el.ref, value, action_summary: `Sets "${el.label.split(' → ')[0]}" to "${value}"` })
        }
        await $.clock.sleep(SETTLE_MS)
        return `${el.label} [${el.ref}]`
      })
      if (!r.ok) {
        log.push(`✗ ${text}: not done (${r.detail}).`)
        const rest = (steps as string[]).slice(i + 1)
        if (rest.length) log.push(`Not run: ${rest.map(x => JSON.stringify(x)).join(', ')}.`)
        log.push(`Continue with the normal claude-in-chrome tools from this step (tab ${tab}).`)
        const now = await pageNow($, tab)
        if (now) log.push(now)
        return { result: log.join('\n') }
      }
      log.push(`✓ ${text}${r.value ? ` → ${r.value}` : ''}`)
    }
    log.push(`All steps done in tab ${tab}.`)
    const now = await pageNow($, tab)
    if (now) log.push(now)
    if (typeof input.expect === 'string') {
      // A click or Enter can start a navigation that outlasts SETTLE_MS (Wikipedia search did):
      // wait, and ask once more before a "no" or "unsure" goes back to Claude.
      await $.clock.sleep(EXPECT_WAIT_MS[0]!)
      let verdict = await checkPage($, cfg, tab, input.expect)
      if (!verdict.startsWith('yes')) {
        await $.clock.sleep(EXPECT_WAIT_MS[1]!)
        verdict = await checkPage($, cfg, tab, input.expect)
      }
      log.push(`Check "${input.expect}": ${verdict}`)
    }
    return { result: log.join('\n') }
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
