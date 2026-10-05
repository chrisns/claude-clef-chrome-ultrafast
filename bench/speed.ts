// browse speed with fixed arguments, so Claude's own choices do not add noise. Each run is a
// headless session that is told to make exactly one browse call; the time is the mod's own
// TIMING line in the debug log.
//   bun bench/speed.ts --label s0 [--runs 3] [--set settle_ms=400] [--jobs hotels,govuk]

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:8791/'
const JOBS: Record<string, { url: string; steps: string[]; expect: string; ok: RegExp }> = {
  hotels: {
    url: `${BASE}hotels.html`,
    steps: ['type "Lisbon" into the destination field', 'tick "Design hotels"', 'tick "Free cancellation"', 'click "Search"', 'click "Casa Flora"'],
    expect: 'Does the page show the Casa Flora hotel?',
    ok: /#hotel-Casa-Flora/,
  },
  signup: {
    url: `${BASE}signup.html`,
    steps: ['type "Ada Lovelace" into the full name field', 'type "ada@example.com" into the email field', 'select "weekly" for how often', 'tick the terms checkbox', 'click the submit button'],
    expect: 'Does the page confirm the newsletter signup?',
    ok: /Page now: "Subscribed"/,
  },
  wikipedia: {
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    steps: ['type "Gödel incompleteness theorems" into the search box', 'press enter'],
    expect: "Is this the Wikipedia article about Gödel's incompleteness theorems?",
    ok: /wiki\/G%C3%B6del/,
  },
  govuk: {
    url: 'https://www.gov.uk/',
    steps: ['type "renew passport" into the search box', 'press enter', 'open the result about renewing or replacing an adult passport'],
    expect: 'Is this the GOV.UK guide about renewing or replacing an adult passport?',
    ok: /gov\.uk\/renew-adult-passport/,
  },
}

const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : d)
const label = arg('--label', 'speed')
const runs = Number(arg('--runs', '3'))
const only = arg('--jobs', '').split(',').filter(Boolean)
const modDir = arg('--mod-dir', new URL('../mod', import.meta.url).pathname)
const options: Record<string, unknown> = { mode: 'active' }
process.argv.forEach((a, i) => {
  if (a !== '--set') return
  const [k, v] = process.argv[i + 1]!.split('=')
  options[k!] = v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v)
})
const dir = new URL('./results/', import.meta.url).pathname
mkdirSync(dir, { recursive: true })
const rows: unknown[] = []
for (const [name, job] of Object.entries(JOBS).filter(([n]) => !only.length || only.includes(n))) {
  for (let n = 0; n < runs; n++) {
    const debug = `${dir}debug-${label}-${name}-${n}.txt`
    const args = JSON.stringify({ url: job.url, steps: job.steps, expect: job.expect })
    const prompt = `Call the tool mcp__clef-chrome__browse exactly once with these arguments and nothing else: ${args}. Then reply with its result verbatim. Do not call any other tool.`
    const started = Date.now()
    const r = spawnSync(
      'claude',
      ['-p', prompt, '--chrome', '--model', 'sonnet', '--output-format', 'json', '--tools', 'TodoWrite', '--setting-sources', '',
        '--disable-slash-commands', '--no-session-persistence', '--permission-mode', 'bypassPermissions',
        '--plugin-dir', modDir, '--settings', JSON.stringify({ pluginConfigs: { 'clef-chrome': { options } } }),
        '--debug-file', debug],
      { encoding: 'utf8', cwd: '/tmp', timeout: 300_000 },
    )
    const wallMs = Date.now() - started
    let text = ''
    try {
      text = String(JSON.parse(r.stdout).result ?? '')
    } catch {}
    let log = ''
    try {
      log = readFileSync(debug, 'utf8')
    } catch {}
    const timing = /TIMING browse (\d+) steps (\d+)ms(.*)$/m.exec(log)
    const ms = timing ? Number(timing[2]) : NaN
    const ok = job.ok.test(text) && !text.includes('✗')
    rows.push({ job: name, run: n, ok, ms, wallMs, phases: timing?.[3]?.trim() ?? '' })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(9)} wall ${(wallMs / 1000).toFixed(1)}s browse ${(ms / 1000).toFixed(1)}s ${timing?.[3]?.trim().slice(0, 150) ?? ''}`)
  }
}
writeFileSync(`${dir}speed-${label}.json`, JSON.stringify(rows, null, 2))
