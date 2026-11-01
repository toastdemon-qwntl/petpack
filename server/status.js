#!/usr/bin/env node
// Print both relays' health and room counts (owner: L1). No secrets: /healthz carries counts only.
//   node server/status.js [wss://relay-a/ws wss://relay-b/ws ...]     exit 0 when every relay answers 200
import { RELAYS, healthUrl } from '../shared/protocol.js'

const relays = process.argv.slice(2).length ? process.argv.slice(2) : RELAYS
let down = 0
for (const [i, url] of relays.entries()) {
  const target = healthUrl(url)
  const t0 = Date.now()
  let line
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(8000), cache: 'no-store' })
    const ms = Date.now() - t0
    const h = res.ok ? await res.json() : null
    if (!h?.ok) { down++; line = `DOWN  http ${res.status} in ${ms} ms` } else {
      line = `UP    ${ms} ms  ${h.name ?? '?'}${h.region ? ` (${h.region})` : ''}  rooms ${h.rooms}  online ${h.online}  away ${h.away ?? '?'}` +
        `  cached ${h.cached ?? '?'}  sprites ${h.sprites ?? '?'}  persisted ${h.persisted ?? '?'}  uptime ${h.uptimeS}s`
    }
  } catch (e) { down++; line = `DOWN  ${e.name === 'TimeoutError' ? 'timeout' : e.message}` }
  console.log(`${i === 0 ? 'primary  ' : i === 1 ? 'secondary' : `relay ${i}  `}  ${url}\n           ${line}`)
}
process.exit(down ? 1 : 0)
