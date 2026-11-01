import * as THREE from 'three'
import { toonMaterial } from './toon.js'

export function seededRandom(seed = 1) {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let t = Math.imul(state ^ state >>> 15, 1 | state)
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// One instanced draw per shape: a whole village's repeated details stay inexpensive.
export function createPainter(root) {
  const batches = new Map()
  const dummy = new THREE.Object3D()
  const color = new THREE.Color()
  function add(kind, x, y, z, w, h, d, tint, rotation = 0) {
    if (!batches.has(kind)) batches.set(kind, [])
    batches.get(kind).push({ x, y, z, w, h, d, tint, rotation })
  }
  return {
    box: (x, y, z, w, h, d, tint, rotation = 0) => add('box', x, y, z, w, h, d, tint, rotation),
    glow: (x, y, z, w, h, d, tint) => add('glow', x, y, z, w, h, d, tint),
    stone: (x, y, z, w, h, d, tint, rotation = 0) => add('stone', x, y, z, w, h, d, tint, rotation),
    pyramid: (x, y, z, w, h, d, tint, rotation = 0) => add('pyramid', x, y, z, w, h, d, tint, rotation),
    finish() {
      const meshes = []
      for (const [kind, instances] of batches) {
        const geometry = kind === 'stone' ? new THREE.CylinderGeometry(0.43, 0.5, 1, 5) :
          kind === 'pyramid' ? new THREE.ConeGeometry(0.7, 1, 4) : new THREE.BoxGeometry(1, 1, 1)
        const material = toonMaterial({ color: '#ffffff', emissive: kind === 'glow' ? '#a15c18' : '#000000' })
        const mesh = new THREE.InstancedMesh(geometry, material, instances.length)
        mesh.name = `village-${kind}`
        instances.forEach((item, i) => {
          dummy.position.set(item.x, item.y, item.z)
          dummy.rotation.set(0, item.rotation, 0)
          dummy.scale.set(item.w, item.h, item.d)
          dummy.updateMatrix()
          mesh.setMatrixAt(i, dummy.matrix)
          mesh.setColorAt(i, color.set(item.tint))
        })
        mesh.castShadow = kind !== 'glow'
        mesh.receiveShadow = true
        mesh.computeBoundingSphere()
        root.add(mesh)
        meshes.push(mesh)
      }
      batches.clear()
      return meshes
    },
  }
}

export function tree(p, x, z, type, random, scale = 1) {
  const b = (dx, y, dz, w, h, d, c, r = 0) => p.box(x + dx * scale, y * scale, z + dz * scale, w * scale, h * scale, d * scale, c, r)
  const palettes = [
    ['#496943', '#678444', '#86a251', '#a3b55d'],
    ['#355b49', '#497453', '#63875a', '#85a367'],
    ['#7e863e', '#a1a54c', '#b9b85b', '#d6c878'],
  ]
  const palette = palettes[type % palettes.length]
  b(0, 1.15, 0, .4, 2.3, .4, type === 2 ? '#d6cfb0' : '#7b6242')
  b(-.24, 1.8, 0, .65, .22, .24, '#7b6242')
  b(.28, 2.08, -.07, .75, .22, .23, '#7b6242')
  b(0, .09, 0, .8, .18, .7, '#7e7049')
  if (type === 1) {
    for (let level = 0; level < 4; level++) {
      const w = 2.5 - level * .46
      p.pyramid(x, (1.75 + level * .63) * scale, z, w * scale, 1.4 * scale, w * scale, palette[level], Math.PI / 4)
      b(0, 1.13 + level * .63, 0, w * .63, .15, w * .63, palette[Math.max(0, level - 1)])
    }
  } else {
    // Stepped, overlapping leaf masses: bevels are actual voxel silhouettes.
    const offset = type === 2 ? .45 : 0
    b(0, 2.45 + offset, 0, 2.75, .68, 2.15, palette[0])
    b(-.08, 2.94 + offset, -.07, 2.35, .58, 2.42, palette[1])
    b(-.21, 3.38 + offset, -.09, 1.75, .5, 1.72, palette[2])
    b(-.24, 3.72 + offset, -.13, 1.03, .24, .96, palette[3])
    b(-1.12, 2.73 + offset, .1, .61, .5, 1.29, palette[1])
    b(.98, 2.7 + offset, -.35, .73, .62, 1.25, palette[2])
    for (let i = 0; i < 12; i++) {
      const dx = (random() - .5) * 1.9, dz = (random() - .5) * 1.7
      b(dx, 3.17 + offset + (Math.abs(dx) < .7 && Math.abs(dz) < .65 ? .47 : 0), dz, .2 + random() * .25, .07, .18 + random() * .3, palette[2 + (i % 2)])
    }
    if (type === 2) for (let i = 0; i < 4; i++) b(.207, .48 + i * .38, .05, .015, .09, .3, '#776b52')
  }
}

export function fence(p, x, z, length, alongZ = false) {
  const count = Math.ceil(length / 1.1)
  const b = (u, y, w, h, d, c) => p.box(x + (alongZ ? 0 : u), y, z + (alongZ ? u : 0), alongZ ? d : w, h, alongZ ? w : d, c)
  for (let i = 0; i <= count; i++) {
    b(i * length / count, .5, .17, 1, .17, '#977549')
    b(i * length / count, 1.02, .23, .1, .23, '#cdb383')
  }
  b(length / 2, .35, length, .12, .1, '#b3915a')
  b(length / 2, .76, length, .12, .1, '#c5a56c')
}

export function lantern(p, x, z) {
  p.box(x, .9, z, .13, 1.8, .13, '#5b6355')
  p.box(x + .23, 1.81, z, .6, .12, .13, '#5b6355')
  p.box(x + .42, 1.6, z, .055, .36, .055, '#5b6355')
  p.box(x + .42, 1.43, z, .36, .48, .3, '#555c4c')
  p.glow(x + .42, 1.44, z + .015, .23, .33, .24, '#ffe7a1')
  p.pyramid(x + .42, 1.75, z, .53, .23, .43, '#667460', Math.PI / 4)
  p.box(x, .09, z, .38, .18, .36, '#b4af8b')
}

export function flowers(p, x, z, w, d, random, count = 22) {
  p.box(x, .045, z, w, .1, d, '#807453')
  p.box(x, .12, z - d / 2, w + .18, .24, .16, '#b29b75')
  p.box(x, .12, z + d / 2, w + .18, .24, .16, '#cfb88b')
  p.box(x - w / 2, .12, z, .16, .24, d, '#c2aa7e')
  p.box(x + w / 2, .12, z, .16, .24, d, '#b29b75')
  const colors = ['#e9c35d', '#ec9b83', '#d97e75', '#f2e4b8', '#a8a6cf']
  for (let i = 0; i < count; i++) {
    const fx = x + (random() - .5) * (w - .3), fz = z + (random() - .5) * (d - .2)
    const height = .22 + random() * .22, color = colors[i % colors.length]
    p.box(fx, height / 2 + .1, fz, .05, height, .05, '#5e8250')
    p.box(fx, .17, fz, .23, .06, .12, '#6e9053', random() * 3)
    p.box(fx, height + .1, fz, .24, .07, .1, color)
    p.box(fx, height + .1, fz, .1, .07, .24, color)
    p.box(fx, height + .145, fz, .075, .035, .075, '#fff0b2')
  }
}

export function bench(p, x, z) {
  for (const dx of [-.65, .65]) {
    p.box(x + dx, .25, z, .17, .5, .55, '#686553')
    p.box(x + dx, .68, z - .23, .13, .85, .13, '#686553')
  }
  for (let i = 0; i < 3; i++) p.box(x, .53, z + (i - 1) * .18, 1.75, .12, .14, '#b49664')
  p.box(x, .95, z - .26, 1.8, .28, .13, '#c7aa79')
}

const icons = {
  book: ['000000000', '011101110', '110111011', '110111011', '110111011', '110111011', '011111110', '000010000'],
  gear: ['000111000', '010111010', '111111111', '011000110', '111000111', '011000110', '111111111', '010111010', '000111000'],
  flame: ['000010000', '000110000', '000111000', '001111010', '011111110', '011111110', '001111100', '000111000'],
  fist: ['001111000', '001111110', '011111110', '111111110', '111111100', '011111000', '001111000', '001111000'],
}
export function signpost(p, x, z, icon = 'book', direction = 1) {
  p.box(x, .78, z, .15, 1.55, .15, '#806b4b')
  p.box(x, 1.48, z, 1.14, .88, .18, '#735e43')
  p.box(x, 1.5, z + .102, 1, .73, .05, '#dec58f')
  const rows = icons[icon] || icons.book
  rows.forEach((row, y) => [...row].forEach((v, ix) => {
    if (v === '1') p.box(x - .28 + ix * .069, 1.76 - y * .069, z + .14, .07, .07, .025, '#736343')
  }))
  p.box(x + direction * .73, 1.48, z, .3, .3, .18, '#b89761', Math.PI / 4)
}
