// Client for Ollama's /v1/systemone decision endpoint. Pure: the caller injects `post`, so
// the mod runs it on $.http.fetch and the bench runs it on fetch under bun.

export type Post = (url: string, body: string, timeoutMs: number) => Promise<{ status: number; text: string }>

export type Noul = { type: 'noul'; instructions: unknown; criteria?: { true?: string | null; false?: string | null } }
export type Choice = { type: 'choice'; instructions: unknown; criteria: Record<string, string | null> }
export type Score = { type: 'score'; instructions: unknown; criteria: string[] }
export type Question = Noul | Choice | Score

export type NoulAnswer = { type: 'noul'; noul: number }
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export type ScoreAnswer = { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number }
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export type Client = {
  url: string
  model: string
  timeoutMs: number
  keepAlive?: string // Ollama keep_alive, so the model stays loaded between browser steps
  embedModel?: string // e.g. nomic-embed-text: ranks a large page before the decision model sees it
  post: Post
  calls?: { questions: number; ms: number; inputTokens?: number }[]
}

// Every reason the mod hands a decision back to Claude. Kept as a closed set so the
// metrics count them and the tests can name each one.
export type Reason =
  | 'ollama-down'
  | 'http-error'
  | 'too-large'
  | 'timeout'
  | 'bad-json'
  | 'missing-answer'
  | 'low-gate'
  | 'low-margin'
  | 'no-elements'
  | 'tool-error'
  | 'exception'
  | 'breaker-open'

export class Fallback extends Error {
  constructor(
    readonly reason: Reason,
    detail = '',
  ) {
    super(detail ? `${reason}: ${detail}` : reason)
  }
}

export const MAX_STATE_CHARS = 40_000 // 16k-token context; leave room for the questions

export async function ask(
  client: Client,
  state: unknown,
  questions: Record<string, Question>,
  images?: string[],
): Promise<Record<string, Answer>> {
  const body = JSON.stringify({
    model: client.model,
    state,
    questions,
    ...(images ? { images } : {}),
    ...(client.keepAlive ? { keep_alive: client.keepAlive } : {}),
  })
  if (!images && body.length > MAX_STATE_CHARS) throw new Fallback('too-large', `${body.length} chars`)
  const started = Date.now()
  let res: { status: number; text: string }
  try {
    res = await client.post(client.url, body, client.timeoutMs)
  } catch (err) {
    if (err instanceof Fallback) throw err
    throw new Fallback('ollama-down', String(err))
  }
  if (res.status === 413) throw new Fallback('too-large', res.text.slice(0, 200))
  if (res.status < 200 || res.status >= 300) throw new Fallback('http-error', `${res.status} ${res.text.slice(0, 200)}`)
  let parsed: { answers?: Record<string, Answer>; usage?: { input_tokens?: number } }
  try {
    parsed = JSON.parse(res.text)
  } catch {
    throw new Fallback('bad-json', res.text.slice(0, 200))
  }
  const answers = parsed.answers
  if (!answers || typeof answers !== 'object') throw new Fallback('missing-answer', 'no answers')
  for (const [key, q] of Object.entries(questions)) {
    const a = answers[key]
    const ok =
      a &&
      a.type === q.type &&
      (a.type === 'noul'
        ? typeof a.noul === 'number'
        : a.type === 'choice'
          ? typeof a.choice === 'string' && a.choice in (q as Choice).criteria
          : typeof a.score === 'number')
    if (!ok) throw new Fallback('missing-answer', key)
  }
  client.calls?.push({
    questions: Object.keys(questions).length,
    ms: Date.now() - started,
    inputTokens: parsed.usage?.input_tokens,
  })
  return answers
}

// The top two probabilities of a choice answer, as a margin. 1 when there is one option.
export function margin(answer: ChoiceAnswer): number {
  const ps = Object.values(answer.probabilities ?? {}).sort((a, b) => b - a)
  return ps.length < 2 ? 1 : ps[0]! - ps[1]!
}

// Ollama /api/embed on the same host. nomic-embed-text wants the search_query/search_document
// prefixes. Returns undefined on any failure: the prefilter is an optimisation, never a gate.
export async function embed(client: Client, query: string, docs: string[]): Promise<number[][] | undefined> {
  if (!client.embedModel) return undefined
  const url = client.url.replace(/\/v1\/systemone$/, '/api/embed')
  const input = [`search_query: ${query}`, ...docs.map(d => `search_document: ${d}`)]
  try {
    const res = await client.post(url, JSON.stringify({ model: client.embedModel, input, keep_alive: client.keepAlive }), client.timeoutMs)
    if (res.status !== 200) return undefined
    const vectors = (JSON.parse(res.text) as { embeddings?: number[][] }).embeddings
    return vectors?.length === input.length ? vectors : undefined
  } catch {
    return undefined
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
