// Offline grounding eval: 35 steps over 14 page snapshots, the same element lists for every
// backend. bun bench/ground.ts --backend clef-flash|clef|claude-haiku|claude-sonnet|claude-opus
//
// A local backend runs the mod's own ground() code. A claude-* backend gets the same option
// texts and must name one. A local Fallback is scored as "handed back", not as wrong.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { DEFAULT_TUNING, ground, label, parseStep, poolFor, type Strategy } from '../mod/hooks/ground.ts'
import { Fallback, type Client } from '../mod/hooks/systemone.ts'
import type { Element } from '../mod/hooks/tree.ts'

export const CASES: [string, string, string][] = [
  ['docs-1', 'click Rate limits', 'Rate limits'],
  ['docs-1', 'go to the pricing docs', 'Pricing and billing'],
  ['docs-1', 'open the page about API keys and tokens', 'Authentication'],
  ['docs-1', 'open the list of changes in each release', 'Changelog'],
  ['docs-1', 'type "rate" into the docs search', 'Search docs'],
  ['hotels-1', "type 'Lisbon' into the destination field", 'Destination'],
  ['hotels-1', 'enter "Lisbon" as the city', 'Destination'],
  ['hotels-2', 'tick Design hotels', 'Design hotels'],
  ['hotels-3', 'turn on the free cancellation filter', 'Free cancellation'],
  ['hotels-3', 'only show places that allow dogs', 'Pets allowed'],
  ['hotels-4', 'click Search', 'Search'],
  ['hotels-4', 'run the search', 'Search'],
  ['hotels-5', 'open Casa Flora', 'Casa Flora'],
  ['hotels-5', 'open the first result', 'Casa Flora'],
  ['hotels-6', 'reserve a room', 'Reserve'],
  ['signup-1', "type 'Ada Lovelace' into full name", 'Full name'],
  ['signup-1', 'enter "Ada" as the person\'s name', 'Full name'],
  ['signup-2', "type 'ada@example.com' into email", 'Email'],
  ['signup-3', "select 'weekly' for how often", 'weekly'],
  ['signup-3', 'choose the monthly edition', 'monthly'],
  ['signup-4', 'tick the terms checkbox', 'terms'],
  ['signup-4', 'accept the conditions', 'terms'],
  ['signup-5', 'click Subscribe', 'Subscribe'],
  ['signup-5', 'submit the form', 'Subscribe'],
  ['signup-5', 'clear the form', 'Clear'],
  ['hotels-5', 'open the Casa Flora result', 'Casa Flora'],
  ['hotels-4', 'run the search', 'Search'],
  ['hotels-2', 'tick design hotels', 'Design hotels'],
  ['hotels-3', 'turn on free cancellation', 'Free cancellation'],
  ['docs-1', 'go back to the home page', 'Home'],
  ['docs-1', 'open the security docs', 'Security'],
  ['docs-1', 'read about webhook events', 'Webhooks'],
  ['signup-4', 'tick the box to agree to the terms', 'terms'],
  ['signup-1', 'type "Ada" into the email address field', 'Email'],
  ['hotels-1', 'show only hotels with a pool', 'Pool'],
  // Written by Claude in an e2e run: the quoted phrase is not an element name.
  ['docs-1', 'click the "API keys and tokens" docs link', 'Authentication'],
]

const dir = new URL('.', import.meta.url).pathname

export function elements(snap: string): Element[] {
  const page = JSON.parse(readFileSync(`${dir}cases/${snap}.json`, 'utf8'))
  return page.actions
    .filter((a: any) => a.role && a.kind !== 'wait')
    .map((a: any) => ({
      id: a.id,
      ref: a.id,
      role: a.role,
      label: a.label,
      kind: a.kind,
      ...(a.kind === 'select' ? { value: a.label.split(' → ')[1] } : {}),
    }))
}

export function localClient(model: string, timeoutMs = 30_000): Client {
  return {
    url: process.env.OLLAMA_URL ?? 'http://localhost:11434/v1/systemone',
    model,
    timeoutMs,
    keepAlive: '30m',
    embedModel: process.env.EMBED === 'off' ? undefined : 'nomic-embed-text',
    calls: [],
    post: async (url, body, ms) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(ms) })
      return { status: r.status, text: await r.text() }
    },
  }
}

type Row = { step: string; want: string; got: string | null; ok: boolean; handedBack?: string; ms: number; tokens: number; cost: number }

const CLAUDE_MODELS: Record<string, string> = { 'claude-haiku': 'haiku', 'claude-sonnet': 'sonnet', 'claude-opus': 'opus' }

function askClaude(model: string, step: string, options: string[]) {
  const prompt =
    `Step: ${step}\n\nPage elements, one per line:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\n` +
    'Which page element does this step refer to? Reply with the element number only, or 0 if no element matches.'
  const started = Date.now()
  const r = spawnSync(
    'claude',
    ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
      '--no-session-persistence', '--output-format', 'json', '--system-prompt', 'You match a browser step to a page element. Reply with a number only.', prompt],
    { encoding: 'utf8', cwd: '/tmp' },
  )
  const wall = Date.now() - started
  const out = JSON.parse(r.stdout)
  const n = parseInt(String(out.result).match(/\d+/)?.[0] ?? '0', 10)
  const u = out.usage ?? {}
  return {
    index: n - 1,
    apiMs: out.duration_api_ms as number,
    wallMs: wall,
    tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0),
    cost: out.total_cost_usd as number,
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0
}

export async function run(backend: string, strategy: Strategy = DEFAULT_TUNING.strategy, negative = false, skipGateAt?: number): Promise<{ backend: string; rows: Row[]; summary: Record<string, number | string> }> {
  const rows: Row[] = []
  for (const [snap, text, want] of CASES) {
    const step = parseStep(text)
    const matches = (e: Element) => e.label.toLowerCase().includes(want.toLowerCase())
    // Negative mode removes the right element: the only right answer is to hand back.
    const all = elements(snap).filter(e => !negative || !matches(e))
    if (CLAUDE_MODELS[backend]) {
      // Claude gets the same pool the local model sees, before the name filter.
      const pool = poolFor(all, step)
      const a = askClaude(CLAUDE_MODELS[backend], text, pool.map(label))
      const got = pool[a.index] ?? null
      rows.push({ step: text, want, got: got?.label ?? null, ok: negative ? !got : !!got && matches(got), ms: a.apiMs, tokens: a.tokens, cost: a.cost })
    } else {
      const client = localClient(backend)
      const started = Date.now()
      try {
        const g = await ground(client, step, all, { ...DEFAULT_TUNING, strategy, ...(skipGateAt !== undefined ? { skipGateAt } : {}) })
        rows.push({ step: text, want, got: g.element.label, ok: !negative && matches(g.element), ms: Date.now() - started, tokens: 0, cost: 0 })
      } catch (err) {
        if (!(err instanceof Fallback)) throw err
        rows.push({ step: text, want, got: null, ok: negative, handedBack: err.message, ms: Date.now() - started, tokens: 0, cost: 0 })
      }
    }
    const r = rows.at(-1)!
    console.log(`${r.ok ? 'ok  ' : r.handedBack ? 'back' : 'MISS'} ${String(r.ms).padStart(6)}ms  ${text}  ->  ${r.got ?? r.handedBack}`)
  }
  const ms = rows.map(r => r.ms)
  const right = rows.filter(r => r.ok).length
  const back = rows.filter(r => r.handedBack).length
  const summary = {
    backend,
    strategy: CLAUDE_MODELS[backend] ? '-' : strategy,
    negative: negative ? 'yes' : 'no',
    right,
    wrong: rows.filter(r => !r.ok && !r.handedBack).length,
    handedBack: back,
    total: rows.length,
    p50Ms: pct(ms, 50),
    p95Ms: pct(ms, 95),
    tokens: rows.reduce((s, r) => s + r.tokens, 0),
    costUsd: +rows.reduce((s, r) => s + r.cost, 0).toFixed(4),
  }
  return { backend, rows, summary }
}

if (import.meta.main) {
  const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d)
  const backend = arg('--backend', 'clef-flash')
  const strategy = arg('--strategy', DEFAULT_TUNING.strategy) as Strategy
  const negative = process.argv.includes('--negative')
  const skip = process.argv.includes('--skip-gate-at') ? Number(arg('--skip-gate-at', '1')) : undefined
  const result = await run(backend, strategy, negative, skip)
  console.log(JSON.stringify(result.summary))
  mkdirSync(`${dir}results`, { recursive: true })
  const name = `ground-${backend}${CLAUDE_MODELS[backend] ? '' : `-${strategy}`}${skip !== undefined ? `-skip${skip}` : ''}${negative ? '-neg' : ''}`
  writeFileSync(`${dir}results/${name}.json`, JSON.stringify(result, null, 2))
}
