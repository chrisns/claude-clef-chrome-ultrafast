// Sort a browser action: routine (navigate, search, filter, sort, open) may skip Claude Code's
// per-action classifier; anything else goes through it as normal. clef-flash never approves a
// risky action; it only says "routine" or not, and any doubt means review. Fixed words come first.

import { ask, type Client } from './systemone.ts'

export type Action = { url: string; step: string; element: string; value?: string }
export type Verdict = { routine: boolean; p: number; reason: 'words' | 'model' | 'error' }

// Any of these in the step, the element's name or the typed value: always review.
export const RISK_WORDS =
  /\b(buy|purchas\w*|order\w*|checkout|check out|basket|cart|pay\w*|book\w*|reserv\w*|send\w*|post|publish\w*|share|delet\w*|remov\w*|unsubscrib\w*|subscrib\w*|sign ?up|register\w*|log ?in|sign ?in|password|passcode|pin|confirm\w*|submit\w*|transfer\w*|withdraw\w*|donat\w*|download\w*|install\w*|upload\w*|accept\w*|agree\w*|consent\w*|apply|settings?|visibility|permission\w*|email|e-mail|phone|address|postcode|card|cvv|iban|sort code|account number|name)\b/i

// A page whose address says checkout, payment, compose, settings, ...: always review, whatever
// the button says ("Continue" on a checkout page).
export const RISK_URL =
  /(checkout|\/buy|\/pay|payment|billing|basket|cart|order|compose|transfer|send|settings|account|admin|delete|remove|signin|sign-in|login|logon|register|signup|sign-up|subscribe|confirm|wallet|bank)/i

const QUESTION =
  'Is this browser action routine and low-risk? Routine means it only navigates, searches, filters, sorts, scrolls or opens a page or a link to read. ' +
  'It is NOT routine if it could buy, pay, book, send, post, delete, submit personal data, sign in, accept terms, download, change settings, or continue a checkout or a form.'

export function wordsSayRisky(a: Action): boolean {
  // The element's name only: role hints such as "(button, submit)" are on every search form.
  const name = a.element.replace(/\s*\([^)]*\)\s*$/, '')
  if (RISK_WORDS.test(`${a.step} ${name} ${a.value ?? ''}`)) return true
  let path = a.url
  try {
    const u = new URL(a.url)
    path = `${u.pathname} ${u.search} ${u.hash}`
  } catch {}
  return RISK_URL.test(path)
}

export async function isRoutine(client: Client, a: Action, at = 0.9): Promise<Verdict> {
  if (wordsSayRisky(a)) return { routine: false, p: 0, reason: 'words' }
  try {
    const answers = await ask(client, { page_url: a.url, step: a.step, element: a.element, ...(a.value ? { typed_value: a.value } : {}) }, {
      q: {
        type: 'noul',
        instructions: QUESTION,
        criteria: {
          true: 'The action only navigates, searches, filters, sorts, scrolls or opens something to read.',
          false: 'The action could commit, send, buy, delete, submit data or change something, or it is unclear.',
        },
      },
    })
    const p = (answers.q as { noul: number }).noul
    return { routine: p >= at, p, reason: 'model' }
  } catch {
    return { routine: false, p: 0, reason: 'error' }
  }
}

// Many actions in one request: one yes/no per action (~0.25 s each after the first), where one
// request per action cost ~1 s each. Risk words still answer first, with no model call.
export async function areRoutine(client: Client, actions: Action[], at = 0.65): Promise<Verdict[]> {
  const out: (Verdict | undefined)[] = actions.map(a => (wordsSayRisky(a) ? { routine: false, p: 0, reason: 'words' } : undefined))
  const ask_ = actions.map((a, i) => [a, i] as const).filter(([, i]) => !out[i])
  if (ask_.length) {
    try {
      // The actions go in the state as a numbered list, as structured data; each question names
      // one. With the action inside the question text instead, routine scores fell (bench/safety.ts).
      const state = { actions: ask_.map(([a], n) => ({ n: n + 1, page_url: a.url, step: a.step, element: a.element, ...(a.value ? { typed_value: a.value } : {}) })) }
      const questions = Object.fromEntries(
        ask_.map((_, n) => [
          `q${n}`,
          {
            type: 'noul' as const,
            instructions: `About action ${n + 1} only: ${QUESTION}`,
            criteria: {
              true: `Action ${n + 1} only navigates, searches, filters, sorts, scrolls or opens something to read.`,
              false: `Action ${n + 1} could commit, send, buy, delete, submit data or change something, or it is unclear.`,
            },
          },
        ]),
      )
      const answers = await ask(client, state, questions)
      ask_.forEach(([, i], n) => {
        const p = (answers[`q${n}`] as { noul: number }).noul
        out[i] = { routine: p >= at, p, reason: 'model' }
      })
    } catch {
      ask_.forEach(([, i]) => (out[i] = { routine: false, p: 0, reason: 'error' }))
    }
  }
  return out as Verdict[]
}
