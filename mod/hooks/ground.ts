// Find the element for one plain-language step. A port of laya-browse policy.ground()
// (~/httpdocs/claude-laya-ultrafast), retuned for Ollama's clef models:
//   - groups of up to 26 options, split evenly, never a group of 1 (Ollama answers 400)
//   - gate threshold 0.5 (right elements median 0.956, wrong 0.037 on clef-flash)
// The code reads the verb and the quoted value; the model only matches a step to an element.

import { ask, type Client, type ChoiceAnswer, cosine, embed, Fallback, type Question } from './systemone.ts'
import type { Element, Kind } from './tree.ts'

export const MATCH_QUESTION = 'Which page element does this step refer to?'
export const GATE_QUESTION = "Would using the element '{element}' carry out this instruction?"
const MAX_GROUP = 26
const GATED = 3 // finalists that get a yes/no gate
export const PREFILTER = 25 // a larger pool is cut to one choice group (25 + "none of these") first
const LABEL_CHARS = 80

// 'any' is a find query: it can name an element of any kind.
export type StepKind = Kind | 'any' | 'enter' | 'scroll_down' | 'scroll_up' | 'wait'
export type Step = { text: string; kind: StepKind; value?: string }

export type Strategy = 'gate1' | 'none+gate1'
export type Tuning = { gate: number; minMargin: number; strategy: Strategy }
export const DEFAULT_TUNING: Tuning = { gate: 0.5, minMargin: 0.15, strategy: 'none+gate1' }
const NONE = '__none__'

export type Grounded = {
  element: Element
  gate: number
  rounds: number
  finalists: { element: Element; gate: number }[]
}

const TYPE_VERBS = 'type|enter|fill|write|input|put|search for|set'
const SELECT_VERBS = 'select|choose|pick'
// A single quote counts only at a word edge, so "Gödel's" is not a quote.
const QUOTED = /"([^"]*)"|“([^”]*)”|(?<![\p{L}\p{N}_])'([^']*)'(?![\p{L}\p{N}_])/u

export function parseStep(text: string): Step {
  const t = text.trim()
  const low = t.toLowerCase()
  const q = QUOTED.exec(t)
  const value = q ? (q[1] ?? q[2] ?? q[3]) : undefined
  if (/^(press|hit) (enter|return)( key)?\.?$/.test(low)) return { text: t, kind: 'enter' }
  if (/^scroll( down)?\.?$/.test(low)) return { text: t, kind: 'scroll_down' }
  if (/^scroll up\.?$/.test(low)) return { text: t, kind: 'scroll_up' }
  if (/^wait( for the page)?( to load)?\.?$/.test(low)) return { text: t, kind: 'wait' }
  if (value !== undefined && new RegExp(`^(${TYPE_VERBS})\\b`).test(low)) return { text: t, kind: 'fill', value }
  if (new RegExp(`^(${SELECT_VERBS})\\b`).test(low)) return { text: t, kind: 'select', value }
  return { text: t, kind: 'click', value }
}

// The option text for one element. "Label (role)" scored best in laya-browse evals/ground.py.
export function label(e: Element): string {
  const text = e.label.split(/\s+/).join(' ').slice(0, LABEL_CHARS)
  if (e.kind === 'select') {
    const [field, option] = text.split(' → ')
    return `${option} (option of ${field})`
  }
  return `${text} (${[e.role, e.hint].filter(Boolean).join(', ')})`
}

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])

function named(e: Element, name: string): boolean {
  const have = words(e.label)
  return [...words(name)].every(w => have.has(w))
}

// Elements whose whole label appears in the step with the same capitals, longest first.
// "open the Casa Flora result" names an element; "the page about API keys" must not pick "About".
function mentioned(step: Step, pool: Element[]): Element[] {
  const text = ` ${(step.text.match(/[\p{L}\p{N}_]+/gu) ?? []).join(' ')} `
  let best = 0
  const hits: [Element, number][] = []
  for (const e of pool) {
    const name = (e.label.split(' → ').pop()!.match(/[\p{L}\p{N}_]+/gu) ?? []).join(' ')
    if (name.length >= 3 && text.includes(` ${name} `)) {
      hits.push([e, name.length])
      best = Math.max(best, name.length)
    }
  }
  return hits.filter(([, n]) => n === best).map(([e]) => e)
}

// The elements that can carry out this kind of step. A quoted name on a click or select step
// is a hard filter, so the gate cannot let a wrong element through when the right one is absent.
export function poolFor(elements: Element[], step: Step): Element[] {
  const kinds: Set<Kind> =
    step.kind === 'any'
      ? new Set(['click', 'fill', 'select'])
      : step.kind === 'fill'
        ? new Set(['fill'])
        : step.kind === 'select'
          ? new Set(['select', 'click'])
          : new Set(['click'])
  return elements.filter(e => {
    if (!kinds.has(e.kind)) return false
    if (e.kind === 'click' && e.label.startsWith('Open ') && ['textbox', 'searchbox', 'spinbutton'].includes(e.role)) return false
    if (step.value !== undefined && step.kind !== 'fill' && !named(e, step.value)) return false
    return true
  })
}

// Split into groups of at most MAX_GROUP, sizes as even as possible, so none has 1 option.
export function groups<T>(items: T[]): T[][] {
  const n = Math.ceil(items.length / MAX_GROUP)
  const out: T[][] = []
  for (let i = 0, start = 0; i < n; i++) {
    const size = Math.floor(items.length / n) + (i < items.length % n ? 1 : 0)
    out.push(items.slice(start, start + size))
    start += size
  }
  return out
}

// Throws Fallback when the model cannot be trusted with this step: Claude then does it.
export async function ground(client: Client, step: Step, elements: Element[], tuning = DEFAULT_TUNING): Promise<Grounded> {
  if (!elements.length) throw new Fallback('no-elements', 'the page has no interactive elements')
  let pool = poolFor(elements, step)
  let namedStep = step.value !== undefined && step.kind !== 'fill'
  // A quoted phrase that names no element ('click the link about "API keys" and tokens') is
  // not a name: drop the filter and let the gate decide, as for an unquoted step.
  if (!pool.length && namedStep) {
    step = { ...step, value: undefined }
    pool = poolFor(elements, step)
    namedStep = false
  }
  if (!pool.length) throw new Fallback('no-elements', `no element can "${step.kind}" for: ${step.text}`)
  if (!namedStep) {
    const byName = mentioned(step, pool)
    if (byName.length) {
      pool = byName
      namedStep = true
    }
  }
  const only = pool[0]
  if (namedStep && pool.length === 1 && only) return { element: only, gate: 1, rounds: 0, finalists: [{ element: only, gate: 1 }] }

  // A large page (Wikipedia has 300+ links) would need many tournament groups at ~42 ms per
  // option. One embedding call ranks the whole pool; the decision model sees the top few.
  if (!namedStep && pool.length > PREFILTER) {
    const vectors = await embed(client, step.text, pool.map(label))
    if (vectors) {
      const [q, ...docs] = vectors
      const scored = pool.map((e, i) => [e, cosine(q!, docs[i]!)] as const).sort((a, b) => b[1] - a[1])
      pool = scored.slice(0, PREFILTER).map(([e]) => e)
    }
  }
  const byId = new Map(pool.map(e => [e.id, e]))
  // Two elements can share a label (a link and a button "Search"): keep the option text unique.
  const seen = new Map<string, number>()
  let options = new Map(
    pool.map(e => {
      const base = label(e)
      const k = (seen.get(base) ?? 0) + 1
      seen.set(base, k)
      return [e.id, k === 1 ? base : `${base} #${k}`]
    }),
  )
  const state = { instruction: step.text }
  let rounds = 0
  // The final choice holds at most 26 options, "none of these" included (Ollama answers 400 above).
  const withNone = tuning.strategy === 'none+gate1'
  const finalMax = MAX_GROUP - (withNone ? 1 : 0)
  while (options.size > finalMax) {
    const gs = groups([...options])
    const qs: Record<string, Question> = {}
    gs.forEach((g, n) => (qs[`g${n}`] = { type: 'choice', instructions: MATCH_QUESTION, criteria: Object.fromEntries(g) }))
    const answers = await ask(client, state, qs)
    rounds++
    const next = new Map<string, string>()
    gs.forEach((g, n) => {
      const a = answers[`g${n}`] as ChoiceAnswer
      const best = Object.entries(a.probabilities ?? { [a.choice]: 1 }).sort((x, y) => y[1] - x[1]).slice(0, 2)
      for (const [id] of best) next.set(id, new Map(g).get(id)!)
    })
    options = next
  }
  // One choice ranks the remaining options, then a yes/no gate checks the winner. Measured on
  // clef-flash (bench/ground.ts): each choice option costs ~42 ms and each noul ~0.25 s, so
  // gating only the winner is the fast path. With 'none+gate1' the choice also offers "none
  // of these", which cut wrong picks on steps whose element is absent from 2/35 to 0/35.
  const criteria: Record<string, string | null> = Object.fromEntries(options)
  if (withNone) criteria[NONE] = 'None of these elements matches the step'
  let ranked: [string, number][] = [[[...options.keys()][0]!, 1]]
  if (Object.keys(criteria).length > 1) {
    const answers = await ask(client, state, { match: { type: 'choice', instructions: MATCH_QUESTION, criteria } })
    rounds++
    const match = answers.match as ChoiceAnswer
    ranked = Object.entries(match.probabilities ?? { [match.choice]: 1 }).sort((a, b) => b[1] - a[1])
  }
  const [top, second] = ranked
  if (!top) throw new Fallback('missing-answer', 'empty choice')
  if (top[0] === NONE) throw new Fallback('low-gate', `"none of these" p=${top[1].toFixed(2)}`)
  const rest = ranked.filter(([id]) => id !== NONE)
  const runnerUp = second && second[0] !== NONE ? second : rest[1]

  const gateOf = async (ids: string[]) => {
    const qs: Record<string, Question> = {}
    ids.forEach((id, n) => {
      qs[`v${n}`] = {
        type: 'noul',
        instructions: GATE_QUESTION.replace('{element}', options.get(id) ?? id),
        criteria: {
          true: 'The instruction is about this element.',
          false: 'The instruction is about a different element, or this element cannot carry it out.',
        },
      }
    })
    const answers = await ask(client, state, qs)
    rounds++
    return ids.map((id, n) => [id, (answers[`v${n}`] as { noul: number }).noul] as [string, number])
  }
  const gate = new Map(await gateOf([top[0]]))
  // The winner fails the gate: gate the next two and take the best one that passes.
  if (gate.get(top[0])! <= tuning.gate && !namedStep && rest.length > 1) {
    for (const [id, g] of await gateOf(rest.slice(1, GATED).map(([id]) => id))) gate.set(id, g)
  }
  // A near tie between the top two: gate the runner-up too, so the check below can see it.
  const close = !!runnerUp && top[1] - runnerUp[1] < tuning.minMargin
  if (close && !namedStep && !gate.has(runnerUp[0])) for (const [id, g] of await gateOf([runnerUp[0]])) gate.set(id, g)
  const finalists = [...gate].map(([id, g]) => ({ element: byId.get(id)!, gate: g })).sort((a, b) => b.gate - a.gate)
  let choice = top[0]
  if (gate.get(choice)! <= tuning.gate && !namedStep) {
    const best = finalists[0]!
    if (best.gate <= tuning.gate) throw new Fallback('low-gate', `best "${best.element.label}" scored ${best.gate.toFixed(2)}`)
    choice = best.element.id
  }
  // Two finalists pass the gate and the match cannot tell them apart: let Claude decide.
  const passing = finalists.filter(f => f.gate > tuning.gate)
  if (!namedStep && passing.length > 1 && close) {
    throw new Fallback('low-margin', passing.map(f => `"${f.element.label}" ${f.gate.toFixed(2)}`).join(', '))
  }
  return { element: byId.get(choice)!, gate: gate.get(choice)!, rounds, finalists }
}
