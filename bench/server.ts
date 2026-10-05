// Serves bench/fixtures on :8791 with a beacon that reports the page's title and text, so a
// job's success is read from the page itself, never from Claude's claim.
// GET /__state -> the last state; POST /__reset clears it.

import { readFileSync } from 'node:fs'

const dir = new URL('./fixtures/', import.meta.url).pathname
const BEACON = `<script>(()=>{let t;const send=()=>navigator.sendBeacon('/__state',JSON.stringify({title:document.title,url:location.href,text:document.body.innerText.slice(0,4000)}));new MutationObserver(()=>{clearTimeout(t);t=setTimeout(send,100)}).observe(document,{subtree:true,childList:true,characterData:true,attributes:true});addEventListener('load',send);addEventListener('change',send,true)})()</script>`
let last: unknown = null

Bun.serve({
  port: Number(process.env.PORT ?? 8791),
  hostname: '127.0.0.1',
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === '/__state' && req.method === 'POST') {
      last = JSON.parse(await req.text())
      return new Response('ok')
    }
    if (pathname === '/__state') return Response.json(last)
    if (pathname === '/__reset') {
      last = null
      return new Response('ok')
    }
    const file = pathname.replace(/^\//, '') || 'index.html'
    if (!/^[\w-]+\.html$/.test(file)) return new Response('not found', { status: 404 })
    try {
      const html = readFileSync(dir + file, 'utf8').replace('</body>', `${BEACON}</body>`)
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  },
})
console.log('fixtures on http://127.0.0.1:8791')
