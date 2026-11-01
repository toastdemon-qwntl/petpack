import * as THREE from 'three'
import { ANIMATIONS, createContactShadow, motionState, safeDelta, spring } from './cast-shared.js'

let studioTexture
let studioUsers = 0

// Procedural studio reflections make the gloss readable in any stage light.
function acquireStudio() {
  if (!studioTexture) {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    const sky = ctx.createLinearGradient(0, 0, 0, 256)
    sky.addColorStop(0, '#d6e7f4')
    sky.addColorStop(.45, '#9aa9c1')
    sky.addColorStop(.52, '#48586f')
    sky.addColorStop(1, '#b9c4c5')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, 512, 256)
    for (const [x, y, rx, ry] of [[125, 65, 90, 40], [380, 95, 28, 65]]) {
      ctx.save()
      ctx.translate(x, y)
      ctx.scale(rx, ry)
      const light = ctx.createRadialGradient(0, 0, .2, 0, 0, 1)
      light.addColorStop(0, '#ffffff')
      light.addColorStop(.6, '#fff6e8')
      light.addColorStop(1, 'rgba(255,246,232,0)')
      ctx.fillStyle = light
      ctx.fillRect(-1, -1, 2, 2)
      ctx.restore()
    }
    studioTexture = new THREE.CanvasTexture(canvas)
    studioTexture.colorSpace = THREE.SRGBColorSpace
    studioTexture.mapping = THREE.EquirectangularReflectionMapping
  }
  studioUsers++
  return studioTexture
}

export function createDot({ color = '#0A84FF' } = {}) {
  const object3d = new THREE.Group()
  object3d.name = 'Dot'
  const shadow = createContactShadow()
  object3d.add(shadow.mesh)
  const rig = new THREE.Group()
  object3d.add(rig)
  const form = new THREE.Group()
  form.position.y = .66
  rig.add(form)

  const bodyMaterial = new THREE.MeshPhysicalMaterial({
    color, metalness: .02, roughness: .24, clearcoat: 1, clearcoatRoughness: .13,
    sheen: .22, sheenRoughness: .6, sheenColor: new THREE.Color(color).lerp(new THREE.Color('white'), .45),
    envMap: acquireStudio(), envMapIntensity: .7,
  })
  const whiteMaterial = new THREE.MeshPhysicalMaterial({ color: '#fffdf6', roughness: .32, clearcoat: .5 })
  const pupilMaterial = new THREE.MeshBasicMaterial({ color: '#16283b' })
  const glintMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false })
  const sphere = new THREE.SphereGeometry(1, 40, 28)
  const smallSphere = new THREE.SphereGeometry(1, 20, 16)
  const body = new THREE.Mesh(sphere, bodyMaterial)
  body.scale.setScalar(.64)
  body.castShadow = true
  form.add(body)

  const eyes = [-1, 1].map(side => {
    const eye = new THREE.Group()
    eye.position.set(side * .215, .105, .55)
    eye.rotation.y = side * .16
    form.add(eye)
    const white = new THREE.Mesh(smallSphere, whiteMaterial)
    white.scale.set(.157, .187, .086)
    eye.add(white)
    const pupil = new THREE.Mesh(smallSphere, pupilMaterial)
    pupil.scale.set(.069, .095, .031)
    pupil.position.set(.012, -.006, .078)
    eye.add(pupil)
    const glint = new THREE.Mesh(smallSphere, glintMaterial)
    glint.scale.set(.022 / .069, .022 / .095, .01 / .031)
    glint.position.set(-.022 / .069, .035 / .095, .026 / .031)
    pupil.add(glint)
    return { eye, pupil }
  })

  const smileCurve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-.075, -.145, .626),
    new THREE.Vector3(0, -.205, .635),
    new THREE.Vector3(.075, -.145, .626),
  )
  const smileGeometry = new THREE.TubeGeometry(smileCurve, 16, .013, 6, false)
  const smile = new THREE.Mesh(smileGeometry, pupilMaterial)
  form.add(smile)

  const arms = [-1, 1].map(side => {
    const pivot = new THREE.Group()
    pivot.position.set(side * .57, -.08, .035)
    form.add(pivot)
    const hand = new THREE.Mesh(smallSphere, bodyMaterial)
    hand.position.set(side * .055, -.105, 0)
    hand.scale.set(.115, .195, .13)
    hand.castShadow = true
    pivot.add(hand)
    pivot.rotation.z = side * .22
    return pivot
  })

  const shade = new THREE.Color(color)
  const phase = (shade.r * 2.13 + shade.g * 3.31 + shade.b * 1.57) * Math.PI * 2
  const blinkPeriod = 3.5 + (Math.sin(phase) + 1) * 1.1
  const states = Object.fromEntries(['lift', 'squash', 'lean', 'turn', 'gaze', 'droop', 'wave', 'pop'].map(key => [key, motionState()]))
  let anim = 'idle'
  let facing = 1
  let moving = 0
  let age = 0
  let actionAge = 0
  let hopPhase = 0
  let disposed = false

  function update(dt, t) {
    if (disposed) return
    dt = safeDelta(dt)
    age += dt
    actionAge += dt
    const clock = Number.isFinite(t) ? t : age
    const idle = Math.sin(clock * 2.8 + phase)
    const running = anim === 'run' || moving > .05
    hopPhase = (hopPhase + dt * (9 + Math.min(moving, 4) * 1.5)) % (Math.PI * 2)
    const hop = running ? Math.abs(Math.sin(hopPhase)) : 0
    const jumpPhase = Math.min(actionAge / .85, 1)
    const leap = anim === 'jump' ? Math.sin(jumpPhase * Math.PI) : 0
    const fidget = anim === 'waiting' ? Math.sin(age * 5 + phase) : 0

    const pop = spring(states.pop, 0, dt, 300, 15)
    const lift = spring(states.lift, hop * .22 + leap * .65, dt, 520, 28)
    const squash = spring(states.squash, running ? Math.cos(hopPhase * 2) * -.065 : (anim === 'failed' ? -.14 : idle * .023), dt)
    const droop = spring(states.droop, anim === 'failed' ? 1 : 0, dt)
    const lean = spring(states.lean, anim === 'review' ? facing * -.16 : (anim === 'wave' ? -.07 : fidget * .035), dt)
    const turn = spring(states.turn, facing * (running ? .22 : .065), dt)
    const gaze = spring(states.gaze, facing * (running ? .038 : .014), dt)
    const wave = spring(states.wave, anim === 'wave' ? 1 : 0, dt)
    const sy = 1 + squash + pop * .22
    rig.scale.set(1 / Math.sqrt(Math.max(.5, sy)), sy, 1 / Math.sqrt(Math.max(.5, sy)))
    rig.position.y = Math.max(0, lift + pop * .22)
    rig.rotation.z = lean + (running ? Math.sin(hopPhase) * .045 * facing : 0) + leap * Math.sin(actionAge * 21) * .13
    rig.rotation.y = turn
    form.rotation.x = droop * .15
    smile.scale.y = 1 - droop * .75
    smile.position.y = -droop * .065
    arms[0].rotation.z = -.22 + hop * .16 - fidget * .055
    arms[1].rotation.z = .22 + wave * (2.12 + Math.sin(age * 15) * .3) - hop * .16

    const blinkTime = ((clock + phase) % blinkPeriod + blinkPeriod) % blinkPeriod
    const blink = blinkTime < .16 ? 1 - Math.sin(blinkTime / .16 * Math.PI) * .98 : 1
    for (const { eye, pupil } of eyes) {
      eye.scale.y = Math.max(.025, blink * (1 - droop * .38))
      pupil.position.x = gaze
      pupil.position.y = -.006 - droop * .035 + (anim === 'review' ? .035 : 0)
    }
    shadow.update(rig.position.y, 1 + Math.max(0, -squash) * .3)
  }

  update(0, 0)
  return {
    object3d,
    height: 1.34,
    set(state = {}) {
      if (ANIMATIONS.has(state.anim) && state.anim !== anim) { anim = state.anim; actionAge = 0 }
      if (state.facing === 1 || state.facing === -1) facing = state.facing
      if (Number.isFinite(state.moving)) moving = Math.abs(state.moving)
    },
    pop() { if (!disposed) states.pop.v = 13 },
    update,
    dispose() {
      if (disposed) return
      disposed = true
      object3d.removeFromParent()
      shadow.dispose()
      sphere.dispose()
      smallSphere.dispose()
      smileGeometry.dispose()
      for (const material of [bodyMaterial, whiteMaterial, pupilMaterial, glintMaterial]) material.dispose()
      if (--studioUsers === 0) { studioTexture.dispose(); studioTexture = null }
    },
  }
}
