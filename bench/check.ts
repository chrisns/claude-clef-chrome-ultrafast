// Eval for check / browse(expect): does clef-flash answer a yes/no about a page better from its
// text, its screenshot, or both? bun bench/check.ts [--model clef-flash] [--modes text,image,both]
//
// bench/check/<state>.txt is get_page_text output, <state>.jpg a screenshot of the same page
// (captured with Claude-in-Chrome, save_to_disk). The verdict thresholds are the mod's own.

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { ask } from '../mod/hooks/systemone.ts'
import { localClient } from './ground.ts'

type Case = { state: string; question: string; want: boolean; visualOnly?: boolean }

const CASES: Case[] = [
  { state: 'signup-thanks', question: 'Does the page confirm the newsletter signup was successful?', want: true },
  { state: 'signup-filled', question: 'Does the page confirm the newsletter signup was successful?', want: false },
  { state: 'signup-thanks', question: 'Does the page show an error message?', want: false },
  { state: 'signup-filled', question: 'Is the "I agree to the terms" box ticked?', want: true, visualOnly: true },
  { state: 'signup-empty', question: 'Is the "I agree to the terms" box ticked?', want: false, visualOnly: true },
  { state: 'signup-filled', question: 'Is "weekly" chosen for how often?', want: true, visualOnly: true },
  { state: 'signup-empty', question: 'Is "weekly" chosen for how often?', want: false, visualOnly: true },
  { state: 'hotel-casa', question: 'Does the page show the Casa Flora hotel?', want: true },
  { state: 'hotels-results', question: 'Does the page show the Casa Flora hotel details?', want: false },
  { state: 'hotels-results', question: 'Does the page list hotel search results?', want: true },
  { state: 'hotels-empty', question: 'Does the page list hotel search results?', want: false },
  { state: 'docs-auth', question: 'Is the Authentication docs page open?', want: true },
  { state: 'docs-home', question: 'Is the Authentication docs page open?', want: false },
  { state: 'wiki-godel', question: "Is the page the Wikipedia article about Gödel's incompleteness theorems?", want: true },
  { state: 'wiki-main', question: "Is the page the Wikipedia article about Gödel's incompleteness theorems?", want: false },
  { state: 'govuk-guide', question: 'Is this the GOV.UK guide about renewing or replacing an adult passport?', want: true },
  { state: 'govuk-results', question: 'Is this the GOV.UK guide about renewing or replacing an adult passport?', want: false },
  { state: 'govuk-results', question: 'Does the page show search results for "renew passport"?', want: true },
]

const dir = new URL('./check/', import.meta.url).pathname
const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : d)
const model = arg('--model', 'clef-flash')
const chars = Number(arg('--chars', '2000'))
const modes = arg('--modes', 'text,image,both').split(',') as ('text' | 'image' | 'both' | 'page' | 'pageimg')[]
const GATE = 0.5 // the mod's default: yes at p >= 0.8, no at p <= 0.2, otherwise unsure
const verdict = (p: number) => (p >= 1 - (1 - GATE) / 2.5 ? 'yes' : p <= GATE / 2.5 ? 'no' : 'unsure')

const client = localClient(model, 60_000)
const out: Record<string, unknown> = {}
for (const mode of modes) {
  let right = 0, wrong = 0, unsure = 0, visRight = 0, visTotal = 0
  const ms: number[] = []
  for (const c of CASES) {
    const txt = `${dir}${c.state}.txt`
    const img = `${dir}${c.state}.jpg`
    if (!existsSync(txt) || !existsSync(img)) {
      console.log(`skip ${c.state}: capture missing`)
      continue
    }
    const text = readFileSync(txt, 'utf8').slice(0, 12_000)
    const image = readFileSync(img).toString('base64')
    // 'page': title and URL as their own fields, and the question asked about the page itself,
    // not about the links on it (a results page lists the page you are asking about).
    const head = Object.fromEntries(text.split('\n---\n')[0]!.split('\n').map(l => [l.split(': ')[0]!.toLowerCase(), l.split(': ').slice(1).join(': ')]))
    const body = text.split('\n---\n').slice(1).join('\n')
    const state =
      mode === 'image'
        ? 'A screenshot of the browser page is attached.'
        : mode === 'page' || mode === 'pageimg'
          ? { page_title: head.title, page_url: head.url, page_text: body.slice(0, chars) }
          : { page_text: text }
    const started = Date.now()
    const a = await ask(
      client,
      state,
      {
        q: {
          type: 'noul',
          instructions: mode === 'page' || mode === 'pageimg' ? `About the page that is open now (its title, URL and main content), not about the links on it: ${c.question}` : c.question,
          criteria: {
            true: mode === 'text' || mode === 'page' ? 'The page text shows that the answer is yes.' : 'The page shows that the answer is yes.',
            false: mode === 'text' || mode === 'page' ? 'The page text does not show that the answer is yes.' : 'The page does not show that the answer is yes.',
          },
        },
      },
      mode === 'text' || mode === 'page' ? undefined : [image],
    )
    ms.push(Date.now() - started)
    const p = (a.q as { noul: number }).noul
    const v = verdict(p)
    const ok = v === (c.want ? 'yes' : 'no')
    if (v === 'unsure') unsure++
    else if (ok) right++
    else wrong++
    if (c.visualOnly) {
      visTotal++
      if (ok) visRight++
    }
    console.log(`${mode.padEnd(5)} ${ok ? 'ok  ' : v === 'unsure' ? '??  ' : 'MISS'} p=${p.toFixed(2)} ${String(Date.now() - started).padStart(5)}ms  ${c.state}: ${c.question}`)
  }
  ms.sort((a, b) => a - b)
  const summary = { mode, right, wrong, unsure, total: right + wrong + unsure, visualOnlyRight: `${visRight}/${visTotal}`, p50Ms: ms[Math.floor(ms.length / 2)] }
  console.log(JSON.stringify(summary))
  out[mode] = summary
}
writeFileSync(new URL(`./results/check-${model}.json`, import.meta.url).pathname, JSON.stringify(out, null, 2))
