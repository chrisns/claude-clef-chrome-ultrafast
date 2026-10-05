// Read claude-in-chrome's read_page text into the elements the grounding step chooses from.
//
// read_page lines look like:   `  checkbox "on" [ref_16] type="checkbox"`
// The interactive filter drops the <label> wrappers, so the terms box reads as `checkbox "on"`.
// Read the full tree instead, and name a field from its label parent or the label just before it.

export type Kind = 'click' | 'fill' | 'select'

export type Element = {
  id: string // unique per element; for select options `${ref}#${n}`
  ref: string
  role: string
  label: string
  kind: Kind
  value?: string // the option text for a select
  hint?: string // e.g. "submit": what a bare name does not say
  inputType?: string // the type="..." attribute: "search", "email", "text", ...
}

type Line = { depth: number; role: string; name: string; ref?: string; rest: string }

const LINE = /^(\s*)(\S+)(?: "((?:[^"\\]|\\.)*)")?(?: \[(ref_\d+)\])?(.*)$/
const FILL = new Set(['textbox', 'searchbox', 'spinbutton'])
const CLICK = new Set([
  'link',
  'button',
  'checkbox',
  'radio',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'treeitem',
  'slider',
])
const WEAK = new Set(['', 'on', 'off', 'choose…', 'choose...', 'select', 'select…', 'select...'])

export function lines(text: string): Line[] {
  const out: Line[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.startsWith('Viewport:') || raw.startsWith('Tab Context')) continue
    const m = LINE.exec(raw)
    if (!m) continue
    out.push({ depth: (m[1] ?? '').length, role: m[2] ?? '', name: (m[3] ?? '').replace(/\\"/g, '"'), ref: m[4], rest: m[5] ?? '' })
  }
  return out
}

// The text of the <label> that names line i: an ancestor label, or the label line just before it.
function labelFor(all: Line[], i: number): string | undefined {
  const me = all[i]
  if (!me) return undefined
  for (let j = i - 1, depth = me.depth; j >= 0 && depth > 0; j--) {
    const up = all[j]!
    if (up.depth < depth) {
      depth = up.depth
      if (up.role === 'label' && up.name) return up.name
      if (me.depth - depth > 2) break
    }
  }
  for (let j = i - 1; j >= 0; j--) {
    const prev = all[j]!
    if (prev.depth < me.depth) break
    if (prev.depth === me.depth) return prev.role === 'label' && prev.name ? prev.name : undefined
  }
  return undefined
}

export function parse(text: string): Element[] {
  const all = lines(text)
  const out: Element[] = []
  all.forEach((line, i) => {
    if (!line.ref) return
    const label = labelFor(all, i)
    const weak = WEAK.has(line.name.trim().toLowerCase())
    // Only a weak name ("on", "Choose…", empty) takes the label: the label line before a
    // button usually names a different field.
    const name = label && weak ? label : line.name
    if (line.role === 'combobox') {
      const options: string[] = []
      for (let j = i + 1; j < all.length && all[j]!.depth > line.depth; j++) {
        const o = all[j]!
        if (o.role === 'option' && o.depth === line.depth + 1) options.push(o.name)
      }
      if (options.length) {
        options.forEach((opt, n) =>
          out.push({ id: `${line.ref}#${n}`, ref: line.ref!, role: 'combobox', label: `${name} → ${opt}`, kind: 'select', value: opt }),
        )
        return
      }
      out.push({ id: line.ref, ref: line.ref, role: 'combobox', label: name, kind: 'fill', inputType: /\btype="(\w+)"/.exec(line.rest)?.[1] ?? 'combobox' })
      return
    }
    // "click the submit button" needs to know that "Subscribe" submits the form.
    const hint = /\btype="submit"/.test(line.rest) ? { hint: 'submit' } : {}
    const inputType = /\btype="(\w+)"/.exec(line.rest)?.[1]
    if (FILL.has(line.role)) out.push({ id: line.ref, ref: line.ref, role: line.role, label: name, kind: 'fill', ...(inputType ? { inputType } : {}) })
    else if (CLICK.has(line.role) && name) out.push({ id: line.ref, ref: line.ref, role: line.role, label: name, kind: 'click', ...hint })
  })
  return out
}

// claude-in-chrome's own find output, so a local answer reads the same as the real one.
export function findText(found: Element[]): string {
  if (!found.length) return 'No matching elements found.'
  const head = `Found ${found.length} matching element${found.length === 1 ? '' : 's'}`
  const rows = found.map(e => `- ${e.ref}: ${e.role} "${e.kind === 'select' ? e.label.split(' → ')[0] : e.label}" (${e.role})`)
  return `${head}\n\n${rows.join('\n')}`
}
