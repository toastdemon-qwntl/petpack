/** Presentation-only laptop shells. Mount createWorld in each returned paneHost. */
export function createDesk(root, { layout = 'pair' } = {}) {
  const mode = ['pair', 'solo', 'trio'].includes(layout) ? layout : 'pair'
  const devices = mode === 'solo' ? ['mac'] : mode === 'trio' ? ['mac', 'windows', 'mac'] : ['mac', 'windows']
  const desk = document.createElement('div')
  desk.className = 'petpack-desk'
  desk.dataset.layout = mode
  const row = document.createElement('div')
  row.className = 'desk-row'
  desk.append(row)
  const seats = devices.map((os, index) => {
    const dock = index === 0 ? 'right' : 'left'
    const laptop = document.createElement('section')
    laptop.className = `desk-laptop desk-laptop--${os}`
    laptop.setAttribute('aria-label', os === 'mac' ? 'MacBook Pro with a shared petpack world' : 'Windows 11 laptop with a shared petpack world')
    laptop.innerHTML = `<div class="desk-lid">
      <div class="desk-screen">
        ${os === 'mac' ? macDesktop() : windowsDesktop()}
        <section class="petpack-pane" data-dock="${dock}" aria-label="Shared petpack village, seat ${index + 1}"><div class="world-viewport"></div></section>
      </div>
      <div class="desk-camera ${os === 'mac' ? 'desk-camera--notch' : ''}" aria-hidden="true"><i></i></div>
      <span class="desk-model" aria-hidden="true">${os === 'mac' ? 'MacBook Pro' : 'S U R F A C E'}</span>
    </div>
    <div class="desk-hinge" aria-hidden="true"></div>
    <div class="desk-base" aria-hidden="true"><i></i></div>
    <div class="desk-shadow" aria-hidden="true"></div>`
    row.append(laptop)
    const screen = laptop.querySelector('.desk-screen')
    const landscape = screen.querySelector('.desk-landscape')
    if (landscape) paintLandscape(landscape)
    return { screen, paneHost: screen.querySelector('.world-viewport'), dock }
  })
  root.append(desk)
  return seats
}

const svg = (body, className = '', viewBox = '0 0 24 24') => `<svg class="${className}" viewBox="${viewBox}" aria-hidden="true">${body}</svg>`
const wifi = () => svg('<path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="20" r="1"/>')
const battery = () => '<i class="desk-battery"></i>'
const apple = () => svg('<path d="M12.5 0c.2 2-1.2 3.4-2.8 3.4C9.5 1.7 11 .2 12.5 0ZM15.8 14.3c-.5 1.3-2 4.2-3.7 4.2-1 0-1.4-.6-2.7-.6s-1.8.6-2.7.6c-1.6 0-3.1-2.6-3.9-4.6C1.5 10.8 2 7 4.7 5.6c1.4-.7 2.7-.1 3.7.2.6.2 1 .2 1.6 0 1.5-.6 3.4-1.1 5.3.7-2.6 1.5-2.9 5.6.5 7.8Z"/>', 'desk-apple', '0 0 18 20')
const traffic = () => '<span class="desk-traffic"><i></i><i></i><i></i></span>'
const icon = (kind) => `<i class="desk-app-icon desk-icon--${kind}">${kind === 'terminal' ? '›_' : kind === 'code' ? '〈〉' : kind === 'notes' ? '≡' : ''}</i>`

function macDesktop() {
  return `<div class="desk-mac-wallpaper" aria-hidden="true"><i></i><b></b></div>
    <div class="desk-menu" aria-hidden="true">${apple()}<strong>Codex</strong><span>File</span><span>Edit</span><span>View</span><span>Window</span><span>Help</span>
      <div class="desk-menu-right">${wifi()}${battery()}<span>Sun 1 Nov</span><span>13:16</span></div>
    </div>
    <div class="desk-workspace" aria-hidden="true">
      <div class="desk-workspace-title">${traffic()}<span>petpack</span><span class="desk-workspace-tools">⌘ K &nbsp; ◫</span></div>
      <div class="desk-workspace-body">
        <aside class="desk-sidebar"><div class="desk-sidebar-search">⌕ &nbsp; Search</div><p>Workspace</p><div>⌂ &nbsp; Overview</div><div class="desk-sidebar-active">◇ &nbsp; Welcome flow</div><div>▧ &nbsp; Shared memories</div><div>⌘ &nbsp; Skills</div><p>Today</p><div>◌ &nbsp; First impressions</div><div>◌ &nbsp; A little more joy</div><div>✓ &nbsp; Returning friends</div><span class="desk-sidebar-bottom">◉ &nbsp; Lindell's workspace</span></aside>
        <div class="desk-document"><div class="desk-document-meta">PETPACK <span>/</span> WELCOME FLOW</div><h2>Make room for everyone.</h2><p class="desk-document-intro">A familiar face. A useful answer.<br>A good first day, together.</p>
          <div class="desk-user-request">Make the welcome remember returning teammates.</div>
          <div class="desk-agent-reply"><i>✳</i><div><strong>Starting with a little context</strong><p>I’m checking how the team remembers<br>names and preferences.</p></div></div>
          <div class="desk-change"><div><span>◇ &nbsp; welcome.ts</span><span>+8 &nbsp; −2</span></div><code><span>const</span> friend = <b>await</b> memories.find(pet.id)<br><span>return</span> welcome({<br>&nbsp; name: friend?.name ?? pet.name,<br>&nbsp; greeting: <q>“Good to see you again.”</q><br>})</code></div>
          <div class="desk-checks"><span>✓</span> Keeps everyone’s preferences close.</div>
          <div class="desk-compose"><span>Ask a follow-up</span><i>↑</i></div>
        </div>
      </div>
      <div class="desk-workspace-footer"><span>⑂ &nbsp; welcome-flow</span><span>All changes saved &nbsp; ◉</span></div>
    </div>
    <div class="desk-mac-dock" aria-hidden="true">${['finder', 'safari', 'code', 'terminal', 'notes'].map(icon).join('')}<b></b>${icon('pet')}</div>`
}

function windowsDesktop() {
  return `<canvas class="desk-landscape" width="1500" height="938" aria-hidden="true"></canvas>
    <div class="desk-desktop-icons" aria-hidden="true"><div>${icon('recycle')}<span>Recycle Bin</span></div><div>${icon('folder')}<span>Projects</span></div><div>${icon('edge')}<span>Microsoft Edge</span></div><div>${icon('terminal')}<span>Terminal</span></div><div>${icon('code')}<span>Visual Studio Code</span></div><div>${icon('notes')}<span>Ideas</span></div></div>
    <div class="desk-win-terminal" aria-hidden="true"><div class="desk-win-title"><span>›_ &nbsp; PowerShell</span><span>− &nbsp; □ &nbsp; ×</span></div><div class="desk-win-terminal-body"><p><span>PS</span> C:\\Users\\Alex\\petpack&gt;</p><p>npx petpack</p><p class="desk-terminal-success">✓ Your pet is in good company.</p><p class="desk-terminal-dim">A little world, together.</p><p class="desk-terminal-caret">▏</p></div></div>
    <div class="desk-taskbar" aria-hidden="true"><div class="desk-weather"><i></i><span>16°<small>Partly sunny</small></span></div><div class="desk-taskbar-apps">${icon('start')}<div class="desk-win-search">⌕ <span>Search</span></div>${icon('taskview')}${icon('folder')}${icon('edge')}${icon('code')}${icon('terminal')}<span class="desk-taskbar-active">${icon('pet')}</span></div><div class="desk-tray"><span>⌃</span>${wifi()}${battery()}<span class="desk-win-clock">13:16<small>01/11/2026</small></span></div></div>`
}

/** Original, static canvas landscape; no downloads, timers or retained observers. */
function paintLandscape(canvas) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width, h = canvas.height
  let seed = 1969
  const random = () => ((seed = Math.imul(1664525, seed) + 1013904223 >>> 0) / 4294967296)
  const gradient = (y0, y1, stops) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1)
    stops.forEach(([at, color]) => g.addColorStop(at, color))
    return g
  }
  const polygon = (points, color) => {
    ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))
    ctx.closePath(); ctx.fillStyle = color; ctx.fill()
  }
  ctx.fillStyle = gradient(0, h * .68, [[0, '#80b9df'], [.7, '#c0e0e9'], [1, '#edf0df']])
  ctx.fillRect(0, 0, w, h)
  const glow = ctx.createRadialGradient(1110, 130, 5, 1110, 130, 450)
  glow.addColorStop(0, '#fffbea65'); glow.addColorStop(1, '#fffbea00')
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h)
  // Long, soft cloud shelves, painted in overlapping translucent layers.
  for (const [cx, cy, cw] of [[225, 165, 190], [1180, 238, 220], [640, 125, 130], [450, 335, 220]]) {
    for (let n = 0; n < 22; n++) {
      ctx.beginPath(); ctx.ellipse(cx + (random() - .5) * cw * 2, cy + random() * 22, 20 + random() * 65, 4 + random() * 15, -.05, 0, Math.PI * 2)
      ctx.fillStyle = '#fffef71a'; ctx.fill()
    }
  }
  polygon([[320, 550], [500, 447], [655, 408], [827, 282], [917, 374], [1080, 467], [1270, 549]], gradient(280, 550, [[0, '#91aaba'], [1, '#a4c2c3']]))
  polygon([[477, 550], [627, 431], [757, 328], [830, 228], [866, 240], [950, 354], [1065, 450], [1260, 550]], gradient(235, 550, [[0, '#f0f2eb'], [.38, '#b2c5cf'], [1, '#7e9ba6']]))
  polygon([[830, 228], [866, 240], [950, 354], [1065, 450], [1210, 527], [929, 451], [860, 334]], '#698c9d49')
  polygon([[830, 228], [866, 240], [943, 344], [912, 332], [919, 354], [881, 326], [876, 364], [850, 308], [833, 334], [825, 302], [788, 350], [805, 303], [744, 362]], '#fbfaf0')
  for (let n = 0; n < 36; n++) {
    const x = 777 + random() * 133
    const y = 307 + Math.abs(x - 840) * .36
    ctx.strokeStyle = n % 3 ? '#eff5ed55' : '#537c982d'; ctx.lineWidth = 1 + random() * 3
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (x - 840) * (1.8 + random()), y + 110 + random() * 85); ctx.stroke()
  }
  // Foothills and curving tea fields; each contour is its own painted shape.
  ctx.fillStyle = '#688f78'; ctx.beginPath(); ctx.moveTo(0, 478); ctx.bezierCurveTo(230, 387, 360, 581, 655, 523); ctx.bezierCurveTo(1000, 418, 1270, 470, w, 418); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.fill()
  ctx.fillStyle = gradient(460, h, [[0, '#85a151'], [.45, '#648944'], [1, '#365d43']]); ctx.beginPath(); ctx.moveTo(0, 560); ctx.bezierCurveTo(440, 431, 975, 643, w, 461); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.fill()
  for (let n = 0; n < 18; n++) {
    const y = 552 + n * 27
    ctx.beginPath(); ctx.moveTo(-100, y + 105); ctx.bezierCurveTo(450, y - 155, 945, y + 120, w + 100, y - 90)
    ctx.lineWidth = 8 + n * 1.5; ctx.strokeStyle = n % 2 ? '#95ad514f' : '#304f383f'; ctx.stroke()
    ctx.lineWidth = 2; ctx.strokeStyle = '#c2ca7945'; ctx.stroke()
  }
  for (let n = 0; n < 11500; n++) {
    const x = random() * w, y = 577 + random() * (h - 577)
    const size = 1 + (y / h) * 2
    ctx.fillStyle = ['#d0cd6834', '#b6c05730', '#2d593523', '#f1d98027'][n % 4]
    ctx.fillRect(x, y, size, .8 + random() * 2)
  }
  // A small, quiet foreground treeline gives the wallpaper depth.
  for (let n = 0; n < 43; n++) {
    const x = w - 155 + random() * 220, y = 432 + random() * 26, r = 11 + random() * 24
    ctx.beginPath(); ctx.arc(x, y - r, r, 0, Math.PI * 2); ctx.fillStyle = ['#476749', '#4d7047', '#608047', '#789047'][n % 4]; ctx.fill()
  }
}
