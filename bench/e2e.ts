// End-to-end jobs with Claude-in-Chrome, headless. Success is read from the page (the fixture
// beacon, or the tab URL the browser reported), never from Claude's own claim.
//
//   bun bench/server.ts &                       # fixtures with the beacon on :8791
//   bun bench/e2e.ts --label baseline           # plain Claude-in-Chrome
//   bun bench/e2e.ts --label mod --mod          # with clef-chrome in active mode
//   options: --runs N  --model opus  --jobs hotels,signup  --set key=value (mod options)

import { warm } from './warm.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const BASE = 'http://127.0.0.1:8791/'
type State = { title: string; url: string; text: string } | null
type Job = { name: string; prompt: string; ok: (s: State, lastUrl: string) => boolean }

export const JOBS: Job[] = [
  {
    name: 'hotels',
    prompt: `Open ${BASE}hotels.html. Search for hotels in Lisbon with the "Design hotels" and "Free cancellation" filters ticked, then open the Casa Flora result.`,
    // the beacon, or the URL the browser reported (the beacon missed one docs run)
    ok: (s, url) => !!s?.title.startsWith('Casa Flora') || url.endsWith('#hotel-Casa-Flora'),
  },
  {
    name: 'signup',
    prompt: `Open ${BASE}signup.html and sign up to the newsletter: full name Ada Lovelace, email ada@example.com, weekly, accept the terms, and submit.`,
    ok: s => !!s && s.text.includes('Thanks, Ada Lovelace') && s.text.includes('weekly'),
  },
  {
    name: 'docs',
    prompt: `Open ${BASE}docs.html and open the docs page about API keys and tokens.`,
    ok: (s, url) => !!s?.title.startsWith('Authentication') || url.endsWith('#Authentication'),
  },
  {
    name: 'wikipedia',
    prompt: 'Go to https://en.wikipedia.org/wiki/Main_Page and use the site search box to search for "Gödel incompleteness theorems", then open that article.',
    ok: (_s, url) => /wikipedia\.org\/wiki\/G%C3%B6del%27s_incompleteness_theorems|incompleteness/i.test(decodeURIComponent(url)),
  },
  {
    name: 'govuk',
    prompt: 'Go to https://www.gov.uk/ and use the site search to search for "renew passport", then open the GOV.UK guide about renewing or replacing an adult passport.',
    ok: (_s, url) => /gov\.uk\/renew-adult-passport/.test(url),
  },
]

const SYSTEM = 'You are running a browser task with the Claude-in-Chrome tools. Create your own tab. Do the task, then reply DONE in one word.'

type ToolUse = { name: string; resultChars: number; images: number; input?: unknown; text?: string }
type RunResult = {
  job: string
  label: string
  ok: boolean
  wallMs: number
  apiMs: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  tools: ToolUse[]
  lastUrl: string
  final: string
}

const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : d)

function settingsJson(): string {
  const options: Record<string, unknown> = { mode: 'active' }
  process.argv.forEach((a, i) => {
    if (a !== '--set') return
    const [k, v] = process.argv[i + 1]!.split('=')
    options[k!] = v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v)
  })
  return JSON.stringify({ pluginConfigs: { 'clef-chrome': { options } } })
}

async function runOne(job: Job, label: string, withMod: boolean, model: string): Promise<RunResult> {
  await fetch(`${BASE}__reset`)
  const args = [
    '-p', job.prompt,
    '--chrome',
    '--model', model,
    '--output-format', 'stream-json', '--verbose',
    // One harmless built-in, in both configurations: with --tools "" the engine also refuses
    // every plugin tool, so the mod's browse and check would never be offered.
    '--tools', 'TodoWrite',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--append-system-prompt', SYSTEM,
    '--permission-mode', 'bypassPermissions',
  ]
  if (withMod) args.push('--plugin-dir', new URL('../mod', import.meta.url).pathname, '--settings', settingsJson())
  if (process.argv.includes('--debug')) args.push('--debug-file', new URL(`./results/debug-${label}-${job.name}.txt`, import.meta.url).pathname)
  const started = Date.now()
  const child = spawn('claude', args, { cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'] })
  let buf = ''
  const events: any[] = []
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) try { events.push(JSON.parse(line)) } catch {}
    }
  })
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  await new Promise(r => child.on('close', r))
  const wallMs = Date.now() - started

  const names = new Map<string, string>()
  const inputs = new Map<string, unknown>()
  const tools: ToolUse[] = []
  let lastUrl = ''
  for (const ev of events) {
    const content = ev.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b.type === 'tool_use') {
        names.set(b.id, b.name)
        inputs.set(b.id, b.input)
      }
      if (b.type === 'tool_result') {
        const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }]
        const text = parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n')
        const name = names.get(b.tool_use_id) ?? '?'
        // Keep the mod's own calls whole, to see what Claude asked and what came back.
        const mine = name.includes('clef-chrome') ? { input: inputs.get(b.tool_use_id), text } : {}
        tools.push({ name, resultChars: text.length, images: parts.filter((p: any) => p.type === 'image').length, ...mine })
        // The browser reports the tab it acted on: "Executed on tabId: N ... (url)".
        const m = [...text.matchAll(/Executed on tabId: (\d+)[\s\S]*?tabId \1: "[^"]*" \("([^"]+)"\)/g)].at(-1)
        if (m) lastUrl = m[2]!
        const nav = [...text.matchAll(/Navigated to (\S+)/g)].at(-1)
        if (nav) lastUrl = nav[1]!
        // clef-chrome's browse relays the tab URL from tabs_context_mcp, i.e. from the browser.
        const now = [...text.matchAll(/Page now: "[^"]*" \((\S+)\)/g)].at(-1)
        if (now) lastUrl = now[1]!
      }
    }
  }
  const result = events.findLast(e => e.type === 'result') ?? {}
  const u = result.usage ?? {}
  const state = (await (await fetch(`${BASE}__state`)).json()) as State
  if (!result.type) console.error(stderr.slice(-2000))
  return {
    job: job.name,
    label,
    ok: job.ok(state, lastUrl),
    wallMs,
    apiMs: result.duration_api_ms ?? 0,
    turns: result.num_turns ?? 0,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    costUsd: result.total_cost_usd ?? 0,
    tools,
    lastUrl,
    final: String(result.result ?? '').slice(0, 200),
  }
}

if (import.meta.main) {
  const label = arg('--label', 'baseline')
  const withMod = process.argv.includes('--mod')
  const runs = Number(arg('--runs', '1'))
  const model = arg('--model', 'opus')
  const only = arg('--jobs', '').split(',').filter(Boolean)
  const dir = new URL('./results/', import.meta.url).pathname
  mkdirSync(dir, { recursive: true })
  if (withMod) await warm()
  const all: RunResult[] = []
  for (const job of JOBS.filter(j => !only.length || only.includes(j.name))) {
    for (let n = 0; n < runs; n++) {
      const r = await runOne(job, label, withMod, model)
      all.push(r)
      const byTool = Object.entries(
        r.tools.reduce<Record<string, number>>((m, t) => ((m[t.name.replace('mcp__claude-in-chrome__', '')] = (m[t.name.replace('mcp__claude-in-chrome__', '')] ?? 0) + 1), m), {}),
      )
        .map(([k, v]) => `${k}×${v}`)
        .join(' ')
      console.log(
        `${r.ok ? 'PASS' : 'FAIL'} ${job.name.padEnd(9)} ${(r.wallMs / 1000).toFixed(1).padStart(6)}s (api ${(r.apiMs / 1000).toFixed(1)}s)  turns ${String(r.turns).padStart(2)}  ` +
          `in ${r.inputTokens + r.cacheRead + r.cacheWrite} out ${r.outputTokens}  $${r.costUsd.toFixed(3)}  ${byTool}`,
      )
      writeFileSync(`${dir}e2e-${label}.json`, JSON.stringify(all, null, 2))
    }
  }
}
