// Load and exercise the models before a timed run, so the first measured call is not a cold
// one (the first call after a pause took 1.7 s, later ones 0.5 s). keep_alive keeps them loaded.
import { elements, localClient } from './ground.ts'
import { ask, embed } from '../mod/hooks/systemone.ts'
import { label } from '../mod/hooks/ground.ts'

export async function warm(model = 'clef-flash') {
  const c = localClient(model)
  const t = Date.now()
  const opts = Object.fromEntries(elements('docs-1').slice(0, 20).map(e => [e.id, label(e)]))
  for (let i = 0; i < 2; i++) await ask(c, { instruction: 'warm up' }, { w: { type: 'noul', instructions: 'Is this a warm-up?' } })
  await ask(c, { instruction: 'open the security docs' }, { m: { type: 'choice', instructions: 'Which page element does this step refer to?', criteria: opts } })
  await embed(c, 'warm up', Object.values(opts))
  console.log(`warmed ${model} and ${c.embedModel} in ${Date.now() - t} ms`)
}

if (import.meta.main) await warm()
