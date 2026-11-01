// Run from the repository root after starting the static server on 8113:
// systemd-run --user --scope -p MemoryMax=16G node app/renderer/world/cast-check.mjs
// CAST_BASE_URL and CAST_SHOTS may override the local URL and artifact directory.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) }
catch { ({ chromium } = require(join(homedir(), '.local/lib/node_modules/playwright'))) }
const baseUrl = process.env.CAST_BASE_URL || 'http://127.0.0.1:8113'
const output = process.env.CAST_SHOTS || '/data/lindell/tmp/petpack/shots/r2-cast/round4'
await mkdir(output, { recursive: true })
const report = { baseUrl, checks: [], screenshots: [], consoleErrors: [], pageErrors: [], warnings: [], networkDiagnostics: [] }
const check = (name, passed, detail) => report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) })
let browser, context, relay, secureRelay, certificateDir

try {
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
  const page = await context.newPage()
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push(message.text())
    if (message.type() === 'warning') report.warnings.push(message.text())
  })
  page.on('pageerror', error => report.pageErrors.push(error.message))
  await page.goto(`${baseUrl}/app/renderer/world/dev-cast.html?atlases&paused`)
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 45000 })
  check('Eight atlas fixtures load and render', await page.evaluate(() => window.castDemo.characters.length === 8))
  check('Failed fixture calls each warn once', report.warnings.filter(w => w.startsWith('petpack:')).length === 2, report.warnings)

  const fixtureResults = await page.evaluate(async () => {
    const THREE = await import('three')
    const { createPixelPet } = await import('./pixel-pet.js')
    const results = []
    const readbacks = new WeakMap()
    const read = image => {
      if (!readbacks.has(image)) readbacks.set(image, image.getContext('2d').getImageData(0, 0, 384, 468).data)
      return readbacks.get(image)
    }
    for (const { pet, fixture } of window.castDemo.characters) {
      const sprite = pet.object3d.getObjectByName('Pixel billboard')
      const texture = sprite.material.map
      const pixels = read(texture.image)
      const alphas = new Set()
      for (let i = 3; i < pixels.length; i += 4) alphas.add(pixels[i])
      const result = {
        id: fixture.id, fallback: pet.object3d.name === 'blob pet', expectedFallback: fixture.expectedFallback,
        dimensions: [texture.image.width, texture.image.height], height: pet.height,
        nearest: texture.magFilter === THREE.NearestFilter && texture.minFilter === THREE.NearestFilter && !texture.generateMipmaps,
        hardAlpha: alphas.size === 2 && alphas.has(0) && alphas.has(255), visible: alphas.has(255),
      }
      if (fixture.expectedFallback) {
        const local = createPixelPet({ color: fixture.color })
        const localPixels = read(local.object3d.getObjectByName('Pixel billboard').material.map.image)
        result.matchesColour = pixels.every((value, i) => value === localPixels[i])
        local.dispose()
      }
      results.push(result)
    }
    return results
  })
  for (const fixture of fixtureResults) {
    check(`${fixture.id}: correct imported/fallback pet`, fixture.fallback === fixture.expectedFallback, fixture)
    check(`${fixture.id}: crisp, visible, two-unit pet`, fixture.nearest && fixture.hardAlpha && fixture.visible && fixture.height === 2 && fixture.dimensions.join('x') === '384x468')
    if (fixture.expectedFallback) check(`${fixture.id}: fallback keeps supplied colour`, fixture.matchesColour)
  }

  const animationResults = await page.evaluate(async () => {
    const { createSpritePet } = await import('./sprite-pet.js')
    const { makeSyntheticAtlas } = await import('./atlas.js')
    const results = []
    const normal = window.castDemo.characters.find(item => item.fixture.id === 'png').pet
    const sparse = window.castDemo.characters.find(item => item.fixture.id === 'sparse').pet
    const cases = [['idle', 1, 0, 1], ['run', 1, 1, 2], ['run', -1, 2, 3], ['wave', 1, 3, 4], ['jump', 1, 4, 5], ['failed', 1, 5, 6], ['waiting', 1, 6, 7], ['review', 1, 0, 1]]
    for (const [anim, facing, row, count] of cases) {
      normal.set({ anim, facing, moving: true })
      const sprite = normal.object3d.getObjectByName('Pixel billboard')
      const visited = new Set([sprite.userData.frame.column])
      let valid = sprite.userData.frame.row === row
      for (let i = 0; i < 60; i++) {
        normal.update(.05)
        const frame = sprite.userData.frame
        valid &&= frame.row === row && frame.column >= 0 && frame.column < count
        visited.add(frame.column)
      }
      results.push({ name: `${anim}/${facing}: all ${count} present frames, no missing cells`, passed: valid && visited.size === count })
      sparse.set({ anim, facing, moving: true })
      sparse.update(.1)
      const frame = sparse.object3d.getObjectByName('Pixel billboard').userData.frame
      results.push({ name: `${anim}/${facing}: missing rows use left-only source`, passed: frame.row === 2 && frame.column === 0 && frame.flip === (facing === 1) })
    }
    const canvas = makeSyntheticAtlas({ frames: [0, 0, 0, 0, 0, 0, 0, 8, 0] })
    const fallbackRun = await createSpritePet({ spriteUrl: canvas.toDataURL('image/png') })
    fallbackRun.set({ anim: 'run', moving: true })
    const visited = new Set()
    for (let i = 0; i < 40; i++) { fallbackRun.update(.05); visited.add(fallbackRun.object3d.getObjectByName('Pixel billboard').userData.frame.column) }
    results.push({ name: 'Missing directional rows use all eight frames in row7', passed: visited.size === 8 })
    fallbackRun.dispose(); canvas.width = canvas.height = 1
    for (const { pet, state } of window.castDemo.characters) pet.set(state)
    window.castDemo.render()
    return results
  })
  animationResults.forEach(result => check(result.name, result.passed))

  // Compare actual 1x output with the locked source, independent of the new sampler.
  const lockedSource = execFileSync('git', ['show', 'look-locked-r3:app/renderer/world/sprite-pet.js'], { encoding: 'utf8', cwd: resolve(new URL('../../../', import.meta.url).pathname) })
  const lockedResults = await page.evaluate(async ({ lockedSource, baseUrl }) => {
    const { preparePetAtlas } = await import('./sprite-pet.js')
    const { createBuiltinAtlas, BUILTIN_KINDS } = await import('./cast-creatures.js')
    const { makeSyntheticAtlas } = await import('./atlas.js')
    const rewritten = lockedSource.replace("'./cast-shared.js'", JSON.stringify(`${baseUrl}/app/renderer/world/cast-shared.js`))
    const sourceUrl = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }))
    const original = await import(sourceUrl)
    const results = []
    const pixels = atlas => atlas.texture.image.getContext('2d').getImageData(0, 0, 384, 468).data
    for (const kind of BUILTIN_KINDS) {
      const source = createBuiltinAtlas({ kind, color: '#69b8ae' })
      const before = original.preparePetAtlas(source), after = preparePetAtlas(source)
      const reference = pixels(before), current = pixels(after)
      results.push({ name: `${kind}: locked1x pixels, frames and bounds unchanged`, passed: current.every((v, i) => v === reference[i]) && JSON.stringify(before.frames) === JSON.stringify(after.frames) && JSON.stringify(before.restingBounds) === JSON.stringify(after.restingBounds) })
      before.texture.dispose(); after.texture.dispose(); source.width = source.height = 1
    }
    const standard = preparePetAtlas(makeSyntheticAtlas())
    const reference = pixels(standard)
    for (const [width, height] of [[384, 468], [768, 936], [3072, 3744], [1543, 1880]]) {
      const source = makeSyntheticAtlas({ width, height }), atlas = preparePetAtlas(source)
      results.push({ name: `${width}x${height} PNG: same normalized pixels as1x`, passed: pixels(atlas).every((value, i) => value === reference[i]) })
      atlas.texture.dispose(); source.width = source.height = 1
    }
    const fractional = preparePetAtlas(makeSyntheticAtlas({ width: 1544, height: 1881 }))
    results.push({ name: 'Fractional193x209 source cells preserve all frame counts', passed: JSON.stringify(fractional.frames) === JSON.stringify(standard.frames) })
    standard.texture.dispose(); fractional.texture.dispose(); URL.revokeObjectURL(sourceUrl)
    return results
  }, { lockedSource, baseUrl })
  lockedResults.forEach(result => check(result.name, result.passed))

  // A real second origin verifies CORS, HTTP(S), and cache/reference lifetimes.
  const pngData = await page.evaluate(() => window.castDemo.fixtures.find(f => f.id === 'png').spriteUrl.split(',')[1])
  const png = Buffer.from(pngData, 'base64'), requests = []
  const handleRequest = (req, res) => {
    requests.push({ url: req.url, origin: req.headers.origin, cookie: req.headers.cookie ?? null })
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-store')
    if (req.url.startsWith('/missing')) { res.writeHead(404); res.end('missing'); return }
    if (req.url.startsWith('/decode')) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('not a PNG'); return }
    res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png)
  }
  relay = createServer(handleRequest)
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  const relayUrl = `http://127.0.0.1:${relay.address().port}`
  certificateDir = await mkdtemp(join(tmpdir(), 'petpack-cast-tls-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certificateDir, 'key.pem'), '-out', join(certificateDir, 'cert.pem'), '-subj', '/CN=127.0.0.1', '-days', '1'], { stdio: 'ignore' })
  secureRelay = createSecureServer({ key: await readFile(join(certificateDir, 'key.pem')), cert: await readFile(join(certificateDir, 'cert.pem')) }, handleRequest)
  await new Promise(resolve => secureRelay.listen(0, '127.0.0.1', resolve))
  const secureUrl = `https://127.0.0.1:${secureRelay.address().port}`
  await context.addCookies([{ name: 'cast-check', value: 'anonymous-load-must-omit-this', url: relayUrl }])
  const networkResults = await page.evaluate(async ({ relayUrl, secureUrl }) => {
    const { createSpritePet } = await import('./sprite-pet.js')
    const url = `${relayUrl}/atlas.png`
    const [a, b] = await Promise.all([createSpritePet({ spriteUrl: url }), createSpritePet({ spriteUrl: url })])
    const sprite = pet => pet.object3d.getObjectByName('Pixel billboard')
    const sharedImage = sprite(a).material.map.image === sprite(b).material.map.image
    const priorImage = sprite(a).material.map.image
    const isolatedTexture = sprite(a).material.map !== sprite(b).material.map
    a.dispose(); a.dispose()
    b.set({ anim: 'run', moving: true }); b.update(.1)
    window.castDemo.stage.scene.add(b.object3d); window.castDemo.render()
    const survivor = b.object3d.name === 'Codex pet' && sprite(b).userData.frame.row === 1
    b.dispose()
    await Promise.resolve()
    const c = await createSpritePet({ spriteUrl: url })
    const retry = c.object3d.name === 'Codex pet'
    const reacquiredAfterLastDispose = sprite(c).material.map.image !== priorImage
    c.dispose()
    const secure = await createSpritePet({ spriteUrl: `${secureUrl}/atlas.png` })
    const https = secure.object3d.name === 'Codex pet'; secure.dispose()
    const brokenDecode = await createSpritePet({ spriteUrl: `${relayUrl}/decode.png`, color: '#bf866a' })
    const decodeFallback = brokenDecode.object3d.name === 'blob pet'; brokenDecode.dispose()
    return { sharedImage, isolatedTexture, survivor, retry, reacquiredAfterLastDispose, https, decodeFallback }
  }, { relayUrl, secureUrl })
  Object.entries(networkResults).forEach(([name, passed]) => check(`Relay: ${name}`, passed))
  // Chromium may retain its decoded Image after our texture cache releases it.
  // Fresh normalized artwork above proves reacquisition without assuming HTTP refetch.
  const atlasRequests = requests.filter(r => r.url === '/atlas.png').length
  check('HTTP(S) request count stays bounded for shared and reacquired pets', atlasRequests >= 2 && atlasRequests <= 3, requests)
  check('HTTP(S) loads use anonymous CORS without cookies', requests.every(r => r.origin === new URL(baseUrl).origin && r.cookie === null), requests)
  check('Bad HTTP decode warns once', report.warnings.filter(w => w.startsWith('petpack:')).length === 3)

  // Real404 diagnostics belong to the browser, not application console.error.
  // Record them separately; do not hide them from the report or claim zero here.
  const failurePage = await context.newPage()
  await failurePage.goto(`${baseUrl}/app/renderer/world/dev-cast.html?paused`)
  await failurePage.waitForFunction(() => document.documentElement.dataset.ready === 'true')
  failurePage.on('console', message => report.networkDiagnostics.push({ type: message.type(), text: message.text() }))
  failurePage.on('pageerror', error => report.networkDiagnostics.push({ type: 'pageerror', text: error.message }))
  const missingFallback = await failurePage.evaluate(async relayUrl => {
    const { createSpritePet } = await import('./sprite-pet.js')
    const pet = await createSpritePet({ spriteUrl: `${relayUrl}/missing.png` })
    const fallback = pet.object3d.name === 'blob pet'; pet.dispose()
    return fallback
  }, relayUrl)
  check('RealHTTP404 resolves to a built-in pet', missingFallback)
  check('RealHTTP404 emits one application warning', report.networkDiagnostics.filter(d => d.type === 'warning').length === 1, report.networkDiagnostics)
  await failurePage.close()

  for (const [width, height] of [[1440, 900], [2560, 1600]]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => { window.castDemo.advance(2); window.castDemo.render() })
    await page.screenshot({ path: join(output, `atlases-${width}x${height}.png`) })
    report.screenshots.push(`atlases-${width}x${height}.png`)
  }
  const beforeDefaultWarnings = report.warnings.length
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${baseUrl}/app/renderer/world/dev-cast.html?paused`)
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true')
  check('Original cast sheet remains loadable with40 characters', await page.evaluate(() => window.castDemo.characters.length === 40))
  check('Original cast sheet adds no warning', report.warnings.length === beforeDefaultWarnings)
  await page.screenshot({ path: join(output, 'original-cast-1440x900.png') })
  report.screenshots.push('original-cast-1440x900.png')
  await page.evaluate(() => { window.castDemo.dispose(); window.castDemo.dispose() })
  check('Fixture and default pages: zero console errors', report.consoleErrors.length === 0, report.consoleErrors)
  check('Fixture and default pages: zero page exceptions', report.pageErrors.length === 0, report.pageErrors)
  report.passed = report.checks.every(item => item.passed)
} catch (error) {
  report.failure = error.stack
  report.passed = false
} finally {
  await context?.close()
  await browser?.close()
  await Promise.all([relay, secureRelay].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))))
  if (certificateDir) await rm(certificateDir, { recursive: true, force: true })
  await writeFile(join(output, 'checks.json'), JSON.stringify(report, null, 2) + '\n')
}

console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failed: report.checks.filter(item => !item.passed), consoleErrors: report.consoleErrors, pageErrors: report.pageErrors, failure: report.failure, output }, null, 2))
assert.equal(report.passed, true, 'Cast compatibility check failed; see checks.json')
