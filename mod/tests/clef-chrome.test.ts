import { describe, expect, mock, test } from 'claude-code/testing'
import { groups } from '../hooks/ground.ts'
import { parse } from '../hooks/tree.ts'
import { fastAllowed } from '../hooks/register.ts'

// read_page (filter "all") of bench/fixtures/signup.html, as claude-in-chrome returned it.
const SIGNUP = `main [ref_34]
 heading "Join our newsletter" [ref_35]
 form [ref_36]
  label "Full name" [ref_37]
  textbox "Full name" [ref_13] type="text"
  label "Email address" [ref_38]
  textbox "Email address" [ref_14] type="email"
  label "How often" [ref_39]
  combobox "Choose…" [ref_15]
   option "Choose…" (selected)
   option "daily"
   option "weekly"
   option "monthly"
   generic "Choose…" [ref_40]
  label "I agree to the terms" [ref_44]
   checkbox "on" [ref_16] type="checkbox"
  button "Subscribe" [ref_17] type="submit"
  button "Clear" [ref_18] type="reset"
contentinfo [ref_45]
 link "About" [ref_19] href="#f0"
 link "Terms" [ref_20] href="#f1"

Viewport: 2217x1118`

const REAL_FIND = 'Found 1 matching element\n\n- ref_16: checkbox "on" (checkbox) - the terms box'
const TAB = 1

type Scenario = {
  status?: number
  raw?: string // a body that replaces the answers
  pick?: string // the choice whose option text contains this wins with p 0.9
  gate?: number // every noul answer
  flat?: boolean // the choice is a near tie (margin below 0.15)
}

// Answer each systemone question from the request body, the way Ollama would.
function ollama(s: Scenario) {
  const seen: { questions: Record<string, { type: string; criteria?: Record<string, string> }> }[] = []
  const hook = async (_$: unknown, e: { url: string; init?: { body?: string } }) => {
    const req = JSON.parse(e.init?.body ?? '{}')
    seen.push(req)
    if (s.raw !== undefined || s.status) return { value: { status: s.status ?? 200, ok: !s.status, headers: {}, text: s.raw ?? 'error' } }
    const answers: Record<string, unknown> = {}
    for (const [k, q] of Object.entries(req.questions as Record<string, { type: string; criteria: Record<string, string> }>)) {
      if (q.type === 'noul') answers[k] = { type: 'noul', noul: s.gate ?? 0.95 }
      else {
        const keys = Object.keys(q.criteria)
        const win = keys.find(k2 => (q.criteria[k2] ?? k2).includes(s.pick ?? '\u0000')) ?? keys[0]
        // flat: a near tie, the winner 0.45 and the runner-up 0.40.
        const second = keys.find(k2 => k2 !== win)
        const rest = keys.length > 2 ? (s.flat ? 0.15 : 0.1) / (keys.length - (s.flat ? 2 : 1)) : 0
        const probabilities = Object.fromEntries(
          keys.map(k2 => [k2, k2 === win ? (s.flat ? 0.45 : 0.9) : s.flat && k2 === second ? 0.4 : s.flat ? rest : 0.1 / (keys.length - 1)]),
        )
        answers[k] = { type: 'choice', choice: win, probabilities, confidence: 0.8 }
      }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } }
  }
  return { hook, seen }
}

// The browser beneath the mod: read_page returns the signup tree, find answers REAL_FIND,
// and every action is recorded.
function browser(on: Parameters<Parameters<typeof test>[1] extends never ? never : any>[1], opts: { readPageError?: boolean; tree?: string } = {}) {
  const actions: Record<string, unknown>[] = []
  let realFinds = 0
  let batches = 0
  // One answer per tool, used by the single-tool calls and by browser_batch alike.
  const answer = (tool: string, e: Record<string, unknown>): { text: string; error?: boolean } => {
    if (tool === 'read_page') return opts.readPageError ? { text: 'tab closed', error: true } : { text: opts.tree ?? SIGNUP }
    if (tool === 'find') {
      realFinds++
      return { text: REAL_FIND }
    }
    if (tool === 'navigate') return { text: `Navigated to ${String(e.url)}` }
    // the settle waits are not actions on the page
    if (!(tool === 'computer' && e.action === 'wait')) actions.push({ ...e, tool })
    return { text: tool === 'get_page_text' ? 'Thanks, Ada Lovelace. You will get the weekly edition.' : 'ok' }
  }
  for (const t of ['read_page', 'find', 'navigate', 'computer', 'form_input', 'get_page_text'] as const) {
    on('tool.call', { tool: `mcp__claude-in-chrome__${t}` }, (_$: unknown, e: Record<string, unknown>) => {
      const a = answer(t, e)
      return a.error ? { isError: true, result: a.text, text: a.text } : { result: { content: [{ type: 'text', text: a.text }], isError: false } }
    })
  }
  // browser_batch as the extension answers it: one "[tool(:action)] output" block per item,
  // and an error that names the failed item.
  on('tool.call', { tool: 'mcp__claude-in-chrome__browser_batch' }, (_$: unknown, e: { actions: { name: string; input: Record<string, unknown> }[] }) => {
    batches++
    const blocks: { type: string; text: string }[] = []
    for (const [n, item] of e.actions.entries()) {
      const a = answer(item.name, item.input)
      if (a.error) {
        const text = `actions[${n}] (${item.name}) failed: ${a.text}`
        return { isError: true, result: text, text }
      }
      blocks.push({ type: 'text', text: `[${item.name}${item.input.action ? `:${String(item.input.action)}` : ''}] ${a.text}` })
    }
    return { result: { content: blocks, isError: false } }
  })
  return { actions, realFinds: () => realFinds, batches: () => batches }
}

const ACTIVE = { options: { mode: 'active' } }

// Move a mocked clock until the call settles: browse sleeps after each action.
async function drive<T>(clock: { advance: (ms: number) => Promise<void> }, call: Promise<T>): Promise<T> {
  let done = false
  const out = call.finally(() => (done = true))
  for (let i = 0; i < 50 && !done; i++) await clock.advance(1000)
  return out
}

// session.start registers the browse and check tools; the test answers the engine's part.
async function start($: any, on: any) {
  on('session.start', () => ({ cwd: '/tmp' }))
  on('tool.register', (_$: unknown, e: { name: string }) => ({ value: { tool: `mcp__clef-chrome__${e.name}` } }))
  await $.session.start({ source: 'startup', cwd: '/tmp' })
}

// A test hook's own { result } carries no `text`; the engine adds it only for real tools.
function textOf(r: { text?: string; result?: unknown }): string {
  if (r.text !== undefined) return r.text
  if (typeof r.result === 'string') return r.result
  const c = (r.result as { content?: { text?: string }[] } | undefined)?.content
  return c ? c.map(b => b.text ?? '').join('\n') : JSON.stringify(r.result)
}

describe('the read_page parser', () => {
  test('names a weak field from its label and splits a select into options', async () => {
    const els = parse(SIGNUP)
    expect(els.find(e => e.ref === 'ref_16')?.label).toBe('I agree to the terms')
    expect(els.filter(e => e.kind === 'select').map(e => e.label)).toContain('How often → weekly')
    expect(els.find(e => e.ref === 'ref_17')?.label).toBe('Subscribe')
    expect(els.find(e => e.ref === 'ref_17')?.hint).toBe('submit')
  })
  test('never makes a group of 1', async () => {
    for (let n = 2; n <= 120; n++) {
      const sizes = groups([...Array(n).keys()]).map(g => g.length)
      expect(Math.min(...sizes) >= 2 && Math.max(...sizes) <= 26).toBe(true)
    }
  })
})

describe('find, active mode', () => {
  test('answers locally with the right ref', ACTIVE, async ($, on) => {
    mock.store(on)
    mock.clock(on)
    const b = browser(on)
    on('http.fetch', ollama({ pick: 'terms' }).hook)
    const r = await $.tool.call({ tool: 'mcp__claude-in-chrome__find', tabId: TAB, query: 'the box to agree to the terms' } as never)
    expect(textOf(r)).toContain('ref_16')
    expect(b.realFinds()).toBe(0)
  })

  const fallbacks: [string, Scenario, { readPageError?: boolean; tree?: string }][] = [
    ['Ollama 500', { status: 500 }, {}],
    ['a 413', { status: 413 }, {}],
    ['JSON that is not valid', { raw: '<html>' }, {}],
    ['a missing answer', { raw: '{"answers":{}}' }, {}],
    ['a gate below the threshold', { pick: 'terms', gate: 0.2 }, {}],
    ['a margin below the threshold', { pick: 'terms', flat: true }, {}],
    ['an empty tree', { pick: 'terms' }, { tree: 'main [ref_1]\n heading "Nothing here" [ref_2]' }],
    ['a read_page error', { pick: 'terms' }, { readPageError: true }],
  ]
  for (const [name, scenario, page] of fallbacks) {
    test(`falls back to the real find on ${name}`, ACTIVE, async ($, on) => {
      mock.store(on)
      mock.clock(on)
      const b = browser(on, page)
      on('http.fetch', ollama(scenario).hook)
      const r = await $.tool.call({ tool: 'mcp__claude-in-chrome__find', tabId: TAB, query: 'the thing to agree to the terms' } as never)
      expect(b.realFinds()).toBe(1)
      expect(textOf(r)).toBe(REAL_FIND)
    })
  }

  test('falls back on a timeout', { options: { mode: 'active', timeout_ms: 1000 } }, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const b = browser(on)
    on('http.fetch', async () => {
      await clock.sleep(60_000)
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    })
    const pending = $.tool.call({ tool: 'mcp__claude-in-chrome__find', tabId: TAB, query: 'terms box' } as never)
    await clock.advance(1500)
    const r = await pending
    expect(b.realFinds()).toBe(1)
    expect(textOf(r)).toBe(REAL_FIND)
  })

  test('opens the breaker after 3 Ollama failures and closes it after 5 minutes', ACTIVE, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    const b = browser(on)
    const o = ollama({ status: 500 })
    on('http.fetch', o.hook)
    const find = () => $.tool.call({ tool: 'mcp__claude-in-chrome__find', tabId: TAB, query: 'the terms box' } as never)
    for (let i = 0; i < 3; i++) await find()
    expect(o.seen.length).toBe(3)
    await find()
    expect(o.seen.length).toBe(3) // breaker open: no request
    expect(b.realFinds()).toBe(4)
    await clock.advance(5 * 60_000 + 1)
    await find()
    expect(o.seen.length).toBe(4)
  })
})

describe('find, shadow mode', () => {
  test('the real find answers and the local answer is only counted', async ($, on) => {
    mock.store(on)
    mock.clock(on)
    const statuses: (string | undefined)[] = []
    on('ui.status', (_$: unknown, e: { text: string | undefined }) => {
      statuses.push(e.text)
      return { value: undefined }
    })
    const b = browser(on)
    on('http.fetch', ollama({ pick: 'terms' }).hook)
    const r = await $.tool.call({ tool: 'mcp__claude-in-chrome__find', tabId: TAB, query: 'the box to agree to the terms' } as never)
    expect(textOf(r)).toBe(REAL_FIND)
    expect(b.realFinds()).toBe(1)
    expect(statuses.at(-1)).toContain('shadow 1/1 agree')
  })
})

describe('browse', () => {
  test('runs each step on the grounded element', ACTIVE, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const b = browser(on)
    const o = ollama({ pick: 'Full name' })
    on('http.fetch', o.hook)
    await start($, on)
    const r = await drive(clock, $.tool.call({ tool: 'mcp__clef-chrome__browse', tabId: TAB, steps: ['type "Ada" into the name field', "select 'weekly' for how often", 'tick "I agree to the terms"', 'press enter'] } as never))
    expect(b.actions.map(a => [a.tool, a.ref ?? a.text, a.value])).toEqual([
      ['form_input', 'ref_13', 'Ada'], // a plain text field: form_input (1Password takes keystrokes)
      ['form_input', 'ref_15', 'weekly'],
      ['form_input', 'ref_16', true],
      ['computer', undefined, undefined],
      ['computer', 'Enter', undefined],
    ])
    expect(textOf(r)).toContain('All steps done')
    // one batch reads the page; the fill, select and tick wait in the queue and go with Enter
    expect(b.batches()).toBe(2)
  })

  test('types real keystrokes into a search box', ACTIVE, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const b = browser(on, { tree: 'main [ref_1]\n search [ref_2]\n  searchbox "Search Wikipedia" [ref_3] type="search"\n  button "Search" [ref_4]' })
    on('http.fetch', ollama({ pick: 'Search Wikipedia' }).hook)
    await start($, on)
    await drive(clock, $.tool.call({ tool: 'mcp__clef-chrome__browse', tabId: TAB, steps: ['type "Gödel" into the search box'] } as never))
    expect(b.actions.map(a => [a.tool, a.action, a.ref ?? a.text])).toEqual([
      ['computer', 'screenshot', undefined], // the tiny screenshot that makes the tab draw a frame
      ['computer', 'triple_click', 'ref_3'],
      ['computer', 'type', 'Gödel'],
    ])
  })

  test('stops at the first unsure step and hands the rest back to Claude', ACTIVE, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const b = browser(on)
    on('http.fetch', ollama({ pick: 'Full name', gate: 0.1 }).hook)
    await start($, on)
    const r = await drive(clock, $.tool.call({ tool: 'mcp__clef-chrome__browse', tabId: TAB, steps: ['type "Ada" into the name field', 'click Subscribe'] } as never))
    const text = textOf(r)
    expect(text).toContain('✗ type "Ada" into the name field')
    expect(text).toContain('Not run: "click Subscribe"')
    expect(text).toContain('Continue with the normal claude-in-chrome tools')
    expect(b.actions.length).toBe(0)
  })
})

test('browse hands back on input it cannot read', ACTIVE, async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const b = browser(on)
  on('http.fetch', ollama({}).hook)
  await start($, on)
  const r = await $.tool.call({ tool: 'mcp__clef-chrome__browse', tabId: TAB, steps: 'click Subscribe' } as never)
  expect(textOf(r)).toContain('use the normal claude-in-chrome tools')
  expect(b.actions.length).toBe(0)
})

describe('browse over the local bridge', () => {
  const BRIDGE = { options: { mode: 'active', bridge: true } }
  // call.py, faked: answers each tool as the extension would and records what went over it.
  function bridgeWorld(on: any, decision: 'allow' | 'ask' | 'deny') {
    const viaBridge: string[] = []
    on('tool.check', () => ({ decision }))
    on('process.run', (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
      const req = JSON.parse(e.init?.stdin ?? '{}') as { tool: string; args: Record<string, unknown> }
      const one = (tool: string, args: Record<string, unknown>) => {
        viaBridge.push(`${tool}${args.action ? `:${String(args.action)}` : ''}`)
        if (tool === 'read_page') return SIGNUP
        if (tool === 'tabs_context_mcp') return JSON.stringify({ availableTabs: [{ tabId: 9, title: 'Acme Docs', url: 'http://127.0.0.1:8791/docs.html' }] })
        if (tool === 'tabs_create_mcp') return 'Created new tab. Tab ID: 9'
        return 'ok'
      }
      const text =
        req.tool === 'browser_batch'
          ? (req.args.actions as { name: string; input: Record<string, unknown> }[])
              .map(x => `[${x.name}${x.input.action ? `:${String(x.input.action)}` : ''}] ${one(x.name, x.input)}`)
              .join('\n')
          : one(req.tool, req.args)
      return { value: { exitCode: 0, stdout: JSON.stringify({ socket: '/tmp/x.sock', result: { content: [{ type: 'text', text }] } }), stderr: '' } }
    })
    return viaBridge
  }
  const go = ($: any, steps: string[]) => $.tool.call({ tool: 'mcp__clef-chrome__browse', url: 'http://127.0.0.1:8791/docs.html', steps } as never)

  test('a routine browse runs over the bridge, not Claude Code\'s tools', BRIDGE, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const b = browser(on)
    const viaBridge = bridgeWorld(on, 'allow')
    on('http.fetch', ollama({ pick: 'Clear', gate: 0.97 }).hook)
    await start($, on)
    const r = await drive(clock, go($, ['click "Clear"']))
    expect(textOf(r)).toContain('Ran over the local Comet bridge')
    expect(viaBridge).toContain('navigate')
    expect(viaBridge).toContain('computer:left_click')
    expect(b.batches()).toBe(0)
  })

  test('a step with a risk word keeps the whole browse on the normal tools', BRIDGE, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const b = browser(on)
    const viaBridge = bridgeWorld(on, 'allow')
    on('http.fetch', ollama({ pick: 'Subscribe', gate: 0.97 }).hook)
    await start($, on)
    const r = await drive(clock, go($, ['click "Subscribe"']))
    expect(textOf(r)).not.toContain('over the local')
    expect(viaBridge.length).toBe(0)
    void b
  })

  test('fails closed: only allow, or ask where nobody would be asked', async () => {
    expect(fastAllowed('allow', 'default')).toBe(true)
    expect(fastAllowed('deny', 'bypassPermissions')).toBe(false)
    for (const mode of ['auto', 'bypassPermissions']) expect(fastAllowed('ask', mode)).toBe(true)
    for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', undefined]) expect(fastAllowed('ask', mode)).toBe(false)
  })

  for (const [mode, bridged] of [['auto', true], ['default', false]] as const) {
    test(`with no rule, mode ${mode} ${bridged ? 'uses' : 'does not use'} the bridge`, BRIDGE, async ($, on) => {
      mock.store(on)
      const clock = mock.clock(on)
      browser(on)
      const viaBridge = bridgeWorld(on, 'ask')
      on('http.fetch', ollama({ pick: 'Clear', gate: 0.97 }).hook)
      on('classic.UserPromptSubmit', () => ({}))
      await start($, on)
      await $.classic.UserPromptSubmit({ prompt: 'clear the form', permission_mode: mode } as never)
      await drive(clock, go($, ['click "Clear"']))
      expect(viaBridge.length > 0).toBe(bridged)
    })
  }

  test('a deny rule keeps the browse off the bridge', BRIDGE, async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    browser(on)
    const viaBridge = bridgeWorld(on, 'deny')
    on('http.fetch', ollama({ pick: 'Clear', gate: 0.97 }).hook)
    await start($, on)
    await drive(clock, go($, ['click "Clear"']))
    expect(viaBridge.length).toBe(0)
  })
})

describe('check', () => {
  test('says yes only when sure', ACTIVE, async ($, on) => {
    mock.store(on)
    mock.clock(on)
    browser(on)
    on('http.fetch', ollama({ gate: 0.97 }).hook)
    await start($, on)
    const r = await $.tool.call({ tool: 'mcp__clef-chrome__check', tabId: TAB, question: 'Was the form sent?' } as never)
    expect(textOf(r)).toMatch(/^yes/)
  })
  test('says unsure in the middle and when Ollama is down', ACTIVE, async ($, on) => {
    mock.store(on)
    mock.clock(on)
    browser(on)
    let gate = 0.6
    on('http.fetch', async (_$: unknown, e: never) => (gate < 0 ? ollama({ status: 500 }) : ollama({ gate })).hook(_$, e))
    await start($, on)
    const ask = () => $.tool.call({ tool: 'mcp__clef-chrome__check', tabId: TAB, question: 'Was the form sent?' } as never)
    expect(textOf(await ask())).toMatch(/^unsure/)
    gate = -1
    expect(textOf(await ask())).toMatch(/^unsure: the local check failed/)
  })
})
