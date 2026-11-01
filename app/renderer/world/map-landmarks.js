import * as THREE from 'three'
import { toonMaterial } from './toon.js'

// Architecture is made from a shared cube and instance colours: tiny roof tiles,
// window mullions and book spines remain inexpensive at the pane's art resolution.
const P = {
  stone: '#dfc992', pale: '#f6e6bd', mortar: '#ab9d78', wood: '#886047',
  dark: '#573f38', bark: '#684b3c', roof: '#b55c42', tile: '#d98556',
  tileLight: '#e79c66', teal: '#47776c', green: '#759249', leaf: '#9cb85c',
  blue: '#567f96', red: '#a55249', paper: '#fff0c7', glass: '#efc778',
  gold: '#d3a343', iron: '#65777a', ironDark: '#3c5559', mat: '#b4ae74',
}

function builder(parent, name) {
  const root = new THREE.Group()
  root.name = name
  parent.add(root)
  const items = []
  const glows = []
  const cube = new THREE.BoxGeometry(1, 1, 1)
  const box = (x, y, z, w, h, d, color, rx = 0, ry = 0, rz = 0, glow = false) => {
    ;(glow ? glows : items).push({ x, y, z, w, h, d, color, rx, ry, rz })
  }
  const pixel = (pattern, x, y, z, size, color) => {
    const width = Math.max(...pattern.map(row => row.length))
    pattern.forEach((row, j) => [...row].forEach((cell, i) => {
      if (cell !== ' ') box(x + (i - (width - 1) / 2) * size, y - j * size, z, size, size, size * 0.6, typeof color === 'string' ? color : color[cell])
    }))
  }
  const build = () => {
    for (const [parts, glow] of [[items, false], [glows, true]]) {
      if (!parts.length) continue
      const material = toonMaterial({ color: '#ffffff', emissive: glow ? '#705120' : '#000000' })
      if (glow) material.userData.nightGlow = true
      const mesh = new THREE.InstancedMesh(cube, material, parts.length)
      mesh.name = `${name}-${glow ? 'warm-windows' : 'timber-stone-tiles'}`
      const dummy = new THREE.Object3D()
      const color = new THREE.Color()
      parts.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z)
        dummy.scale.set(p.w, p.h, p.d)
        dummy.rotation.set(p.rx, p.ry, p.rz)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        mesh.setColorAt(i, color.set(p.color))
      })
      mesh.castShadow = !glow
      mesh.receiveShadow = true
      mesh.computeBoundingSphere()
      root.add(mesh)
    }
    return root
  }
  return { box, pixel, build, root }
}

function roof(b, x, z, width, depth, eave, color = P.roof) {
  // Discrete terracotta courses form a shallow pitched roof with a crisp eave.
  b.box(x, eave - 0.12, z, width + 0.12, 0.18, depth + 0.12, P.dark)
  const rows = Math.ceil(depth / 0.56)
  for (let row = 0; row < rows; row++) {
    const dz = (row + 0.5) / rows * depth - depth / 2
    const rise = (depth / 2 - Math.abs(dz)) * 0.6
    const tiles = Math.ceil(width / 0.6)
    for (let tile = 0; tile < tiles; tile++) {
      const dx = (tile + 0.5) / tiles * width - width / 2
      const shade = (tile * 3 + row * 5) % 11
      b.box(x + dx, eave + rise, z + dz, width / tiles - 0.025, 0.25, depth / rows + 0.07,
        shade === 0 ? (color === P.teal ? P.leaf : P.tileLight) : shade < 4 ? (color === P.teal ? P.green : P.tile) : color)
    }
  }
  b.box(x, eave + depth * 0.3 + 0.06, z, width + 0.18, 0.23, 0.3, color === P.teal ? P.leaf : P.tileLight)
  for (let side of [-1, 1]) {
    for (let row = 0; row < 7; row++) {
      const d = depth * (1 - row / 7)
      b.box(x + side * (width / 2 - 0.18), eave + row * depth * 0.3 / 7 - 0.18, z, 0.22, depth * 0.3 / 7 + 0.01, d, P.wood)
    }
  }
}

function wall(b, x, z, width, depth, h) {
  b.box(x, 0.15, z, width + 0.35, 0.3, depth + 0.35, P.mortar)
  b.box(x, h / 2 + 0.3, z, width, h, depth, P.stone)
  b.box(x, 0.42, z + depth / 2 + 0.01, width, 0.2, 0.09, P.pale)
  const front = z + depth / 2
  for (const side of [-1, 1]) {
    b.box(x + side * (width / 2 - 0.13), h / 2 + 0.3, front + 0.04, 0.26, h + 0.12, 0.25, P.wood)
    for (let j = 0; j < 6; j++) b.box(x + side * (width / 2 - 0.1), 0.6 + j * 0.4, front + 0.075, j % 2 ? 0.52 : 0.32, 0.23, 0.24, P.pale)
  }
  b.box(x, h + 0.24, front + 0.06, width, 0.21, 0.19, P.wood)
}

function window(b, x, y, z, w = 1.1, h = 1.28, shutters = true) {
  b.box(x, y, z, w + 0.18, h + 0.18, 0.18, P.dark)
  b.box(x, y, z + 0.1, w, h, 0.05, P.glass, 0, 0, 0, true)
  b.box(x, y, z + 0.16, 0.08, h, 0.06, P.pale)
  b.box(x, y - 0.03, z + 0.16, w, 0.08, 0.06, P.pale)
  b.box(x, y - h / 2 - 0.13, z + 0.13, w + 0.32, 0.16, 0.35, P.pale)
  if (shutters) for (const side of [-1, 1]) {
    b.box(x + side * (w / 2 + 0.28), y, z + 0.09, 0.33, h + 0.04, 0.1, P.teal)
    for (let j = 0; j < 4; j++) b.box(x + side * (w / 2 + 0.28), y - h / 2 + 0.14 + j * 0.29, z + 0.15, 0.34, 0.055, 0.05, P.leaf)
  }
}

function books(b, x, y, z, width, seed = 0) {
  const colors = [P.red, P.teal, P.blue, P.gold, P.green, P.roof]
  const count = Math.floor(width / 0.19)
  for (let i = 0; i < count; i++) {
    const h = 0.32 + ((i * 7 + seed) % 5) * 0.045
    b.box(x - width / 2 + 0.13 + i * 0.19, y + h / 2, z, 0.15, h, 0.32, colors[(i + seed) % colors.length])
    b.box(x - width / 2 + 0.13 + i * 0.19, y + h * 0.72, z + 0.17, 0.11, 0.035, 0.015, P.paper)
  }
}

function lantern(b, x, y, z) {
  b.box(x, y, z, 0.38, 0.43, 0.34, P.glass, 0, 0, 0, true)
  b.box(x, y + 0.28, z, 0.53, 0.12, 0.48, P.ironDark)
  b.box(x, y - 0.26, z, 0.44, 0.09, 0.4, P.ironDark)
  for (const dx of [-0.17, 0.17]) b.box(x + dx, y, z + 0.18, 0.055, 0.48, 0.055, P.ironDark)
  b.box(x, y + 0.47, z, 0.06, 0.27, 0.06, P.dark)
}

function library(parent) {
  const b = builder(parent, 'library')
  const x = -20, z = -12
  wall(b, x, z, 6.3, 4.5, 2.9)
  roof(b, x, z, 7.2, 5.35, 3.42)
  // A central open-book dormer, framed in pale limestone.
  for (let j = 0; j < 5; j++) b.box(x, 3.48 + j * 0.26, z + 1.77, 2.25 - j * 0.32, 0.27, 1.1, P.pale)
  b.box(x, 3.78, z + 2.35, 1.66, 0.84, 0.16, P.teal)
  b.box(x, 3.78, z + 2.47, 0.1, 0.7, 0.04, P.paper)
  b.box(x, 3.78, z + 2.47, 1.5, 0.1, 0.04, P.paper)
  b.box(x, 2.87, -9.34, 1.54, 0.96, 0.15, P.dark)
  b.box(x, 2.87, -9.23, 1.38, 0.8, 0.05, P.teal)
  b.pixel([' ### ### ', '#### ####', '#### ####', '#### ####', '#### ####', ' ### ### ', '    #    '], x, 3.17, -9.17, 0.105, P.paper)
  b.box(x, 1.26, -9.69, 1.27, 1.96, 0.17, P.dark)
  for (let j = 0; j < 6; j++) b.box(x - 0.51 + j * 0.205, 1.23, -9.57, 0.19, 1.79, 0.1, j % 2 ? P.wood : P.bark)
  b.box(x + 0.37, 1.15, -9.49, 0.09, 0.12, 0.08, P.gold)
  b.box(x, 0.1, -9.42, 1.65, 0.2, 0.5, P.pale)
  window(b, x - 2.02, 1.86, -9.65)
  window(b, x + 2.02, 1.86, -9.65)
  lantern(b, x - 0.97, 2.58, -9.45)
  // A sheltered, open lending shelf on the left exterior wall.
  const sx = -23.34
  b.box(sx, 1.02, -10.4, 0.4, 1.85, 2.03, P.dark)
  for (let j = 0; j < 3; j++) {
    b.box(sx - 0.07, 0.38 + j * 0.58, -10.4, 0.6, 0.12, 2.08, P.wood)
    for (let k = 0; k < 7; k++) {
      const h = 0.34 + (k % 3) * 0.04
      b.box(sx - 0.25, 0.45 + j * 0.58 + h / 2, -11.25 + k * 0.27, 0.35, h, 0.2, [P.red, P.teal, P.gold, P.blue][(k + j) % 4])
    }
  }
  // Chimney-like book tower peeks over the roof: cream page edges and cloth spines.
  b.box(x - 2.3, 4.12, z - 0.8, 1.05, 1.23, 1.05, P.stone)
  for (let j = 0; j < 3; j++) {
    b.box(x - 2.3 + (j % 2) * 0.13, 4.78 + j * 0.22, z - 0.8, 1.18, 0.19, 0.9, [P.teal, P.red, P.blue][j])
    b.box(x - 2.28 + (j % 2) * 0.13, 4.78 + j * 0.22, z - 0.33, 0.98, 0.1, 0.03, P.paper)
  }
  // Window herbs and climbing ivy keep the stone from reading as a blank block.
  for (const side of [-1, 1]) {
    b.box(x + side * 2.02, 1.01, -9.43, 1.23, 0.23, 0.38, P.roof)
    for (let j = 0; j < 6; j++) {
      b.box(x + side * 2.02 - 0.5 + j * 0.2, 1.19 + j % 2 * 0.09, -9.42, 0.2, 0.25, 0.25, j % 2 ? P.leaf : P.green)
      if (j % 2) b.box(x + side * 2.02 - 0.5 + j * 0.2, 1.38, -9.39, 0.13, 0.13, 0.12, P.paper)
    }
  }
  for (let j = 0; j < 15; j++) b.box(-22.85 + Math.sin(j * 2) * 0.18, 0.42 + j * 0.17, -9.61, 0.19 + j % 3 * 0.06, 0.2, 0.11, j % 2 ? P.leaf : P.green)
  return b.build()
}

function workshop(parent) {
  const b = builder(parent, 'workshop')
  const x = 18, z = -12
  wall(b, x, z, 6.25, 4.4, 2.55)
  roof(b, x, z, 7.15, 5.3, 3.05)
  for (const dx of [-2.95, -0.65, 0.7, 2.95]) b.box(x + dx, 1.59, -9.72, 0.17, 2.55, 0.16, P.wood)
  b.box(x, 1.27, -9.69, 1.52, 1.95, 0.18, P.dark)
  b.box(x, 1.33, -9.55, 1.2, 1.54, 0.12, P.teal)
  b.box(x, 1.32, -9.44, 1.45, 0.15, 0.1, P.wood, 0, 0, Math.PI / 4)
  b.box(x, 1.32, -9.44, 1.45, 0.15, 0.1, P.wood, 0, 0, -Math.PI / 4)
  window(b, x - 1.85, 1.62, -9.69, 1.15, 1.08, false)
  // Open forge: ember bed, stone lintel and smoke-stack.
  b.box(x + 2.1, 1.26, -9.56, 1.18, 1.43, 0.34, P.ironDark)
  b.box(x + 2.1, 0.82, -9.3, 0.84, 0.56, 0.13, '#f39944', 0, 0, 0, true)
  b.box(x + 2.1, 1.23, -9.19, 1.35, 0.22, 0.33, P.mortar)
  b.box(x + 2.1, 1.95, -9.5, 1.55, 0.36, 0.64, P.pale)
  b.box(x + 2.1, 3.88, z - 0.17, 1.05, 2.55, 1.08, P.mortar)
  for (let row = 0; row < 9; row++) for (let j = 0; j < 2; j++) {
    b.box(x + 2.1 + (j - 0.5) * 0.51 + row % 2 * 0.06, 2.92 + row * 0.25, z + 0.4, 0.46, 0.21, 0.07, row % 3 ? P.roof : P.tile)
  }
  b.box(x + 2.1, 5.21, z - 0.17, 1.35, 0.3, 1.33, P.pale)
  b.box(x + 2.1, 5.39, z - 0.17, 0.75, 0.06, 0.77, P.ironDark)
  // A toothy gear is mounted above the entrance, visible at 2 CSS px per art pixel.
  b.box(x - 0.25, 3.14, -9.25, 1.53, 1.41, 0.16, P.dark)
  b.pixel(['   ###   ', ' # ### # ', '#########', '###   ###', '###   ###', '###   ###', '#########', ' # ### # ', '   ###   '], x - 0.25, 3.77, -9.13, 0.14, P.gold)
  // Tool rack, with an actual hammer and saw alongside the building.
  b.box(14.65, 1.02, -10.3, 0.19, 1.98, 1.44, P.wood)
  for (const zz of [-10.8, -9.8]) {
    b.box(14.47, 1.26, zz, 0.12, 0.85, 0.11, P.gold, 0, 0, -0.15)
    b.box(14.42, 1.67, zz, 0.26, 0.23, 0.6, P.iron)
  }
  // Compact bench in the side alcove (not across the entrance path).
  b.box(21.35, 0.85, -9.56, 1.3, 0.19, 0.68, P.wood)
  for (const dx of [-0.48, 0.48]) b.box(21.35 + dx, 0.43, -9.56, 0.16, 0.86, 0.48, P.dark)
  b.box(21.33, 1.15, -9.57, 0.41, 0.46, 0.32, P.ironDark)
  b.box(21.29, 1.38, -9.57, 0.87, 0.15, 0.35, P.iron)
  b.box(21.81, 1.38, -9.57, 0.26, 0.1, 0.25, P.iron)
  lantern(b, 16.75, 2.42, -9.4)
  return b.build()
}

function dojo(parent) {
  const b = builder(parent, 'dojo')
  // Back pavilion and its layered green roof frame an open, walkable training yard.
  const x = 18
  b.box(x, 0.12, 6.25, 7.35, 0.24, 4.65, P.mortar)
  b.box(x, 0.255, 6.25, 6.95, 0.025, 4.25, P.mat)
  for (let j = 0; j < 6; j++) b.box(x - 2.85 + j * 1.14, 0.274, 6.25, 0.035, 0.012, 4.16, P.green)
  b.box(x, 0.28, 6.25, 6.8, 0.013, 0.04, P.green)
  for (const dx of [-2.8, 2.8]) {
    b.box(x + dx, 1.73, 4.4, 0.29, 3.18, 0.29, P.wood)
    b.box(x + dx, 0.39, 4.4, 0.52, 0.5, 0.52, P.pale)
  }
  b.box(x, 1.75, 4.23, 5.58, 2.85, 0.22, P.dark)
  b.box(x, 1.76, 4.38, 5.21, 2.58, 0.07, P.paper)
  for (let j = 0; j < 8; j++) b.box(x - 2.48 + j * 0.71, 1.76, 4.44, 0.075, 2.58, 0.065, P.wood)
  for (let j = 0; j < 5; j++) b.box(x, 0.59 + j * 0.58, 4.44, 5.25, 0.075, 0.065, P.wood)
  roof(b, x, 4.3, 7.2, 2.12, 3.38, P.teal)
  for (const side of [-1, 1]) {
    b.box(x + side * 3.48, 3.49, 4.3, 0.5, 0.22, 2.18, P.teal, 0, 0, side * 0.25)
    b.box(x + side * 3.65, 3.61, 4.3, 0.34, 0.21, 2.07, P.teal, 0, 0, side * 0.3)
  }
  // The torii's low crossbar and lifted corners make the training yard unmistakable.
  for (const side of [-1, 1]) {
    b.box(x + side * 2.95, 1.75, 8.42, 0.38, 3.5, 0.42, P.red, 0, 0, -side * 0.035)
    b.box(x + side * 3.02, 0.32, 8.42, 0.61, 0.64, 0.68, P.ironDark)
  }
  b.box(x, 3.39, 8.42, 7.42, 0.35, 0.6, P.red)
  b.box(x, 3.67, 8.42, 7.63, 0.19, 0.77, P.ironDark)
  b.box(x, 2.75, 8.42, 6.56, 0.22, 0.38, P.red)
  for (const side of [-1, 1]) {
    b.box(x + side * 3.73, 3.73, 8.42, 0.46, 0.17, 0.77, P.ironDark, 0, 0, side * 0.28)
    b.box(x + side * 1.21, 3.11, 8.42, 0.18, 0.5, 0.31, P.red)
  }
  b.box(x, 3.0, 8.79, 0.84, 0.9, 0.13, P.gold)
  b.pixel([' ### ', '#####', '#####', ' ### ', ' ### '], x, 3.31, 8.88, 0.11, P.paper)
  // Training dummies sit either side, leaving the centre usable by pets.
  for (const side of [-1, 1]) {
    const dx = x + side * 2.33, dz = 6.6
    b.box(dx, 0.39, dz, 0.82, 0.22, 0.85, P.wood)
    b.box(dx, 1.22, dz, 0.36, 1.57, 0.36, P.wood)
    b.box(dx, 1.76, dz, 0.52, 0.56, 0.49, P.gold)
    b.box(dx, 1.16, dz, 1.18, 0.16, 0.19, P.wood, 0, 0, side * 0.13)
    b.box(dx, 1.42, dz + 0.23, 0.66, 0.22, 0.19, P.mat)
    b.box(dx, 0.99, dz + 0.25, 0.48, 0.2, 0.21, P.mat)
  }
  lantern(b, 14.52, 2.18, 8.3)
  lantern(b, 21.48, 2.18, 8.3)
  return b.build()
}

function stall(b, x, z, color) {
  for (const dx of [-1.12, 1.12]) for (const dz of [-0.64, 0.64]) b.box(x + dx, 1.08, z + dz, 0.13, 2.16, 0.13, P.wood)
  b.box(x, 0.84, z + 0.45, 2.4, 0.22, 0.81, P.wood)
  b.box(x, 0.46, z + 0.59, 2.17, 0.6, 0.12, P.tile)
  for (let j = 0; j < 8; j++) {
    b.box(x - 1.28 + j * 0.365, 2.19, z, 0.36, 0.11, 1.9, j % 2 ? P.paper : color, -0.11)
    b.box(x - 1.28 + j * 0.365, 1.99, z + 0.96, 0.36, 0.3 + j % 2 * 0.07, 0.07, j % 2 ? P.paper : color)
  }
  b.box(x, 2.34, z - 0.93, 2.92, 0.12, 0.14, P.wood)
  for (let j = 0; j < 3; j++) {
    b.box(x - 0.72 + j * 0.71, 1.05, z + 0.43, 0.63, 0.24, 0.6, P.dark)
    for (let k = 0; k < 4; k++) b.box(x - 0.91 + j * 0.71 + k % 2 * 0.27, 1.24 + k % 2 * 0.04, z + 0.29 + Math.floor(k / 2) * 0.26, 0.25, 0.22, 0.23, [P.gold, P.red, P.leaf][j])
  }
}

function campfire(parent) {
  const b = builder(parent, 'campfire-market')
  const x = -16, z = 7
  // Flat cobbles and an octagonal ring leave the front meeting spot clear.
  for (let j = 0; j < 12; j++) {
    const a = j / 12 * Math.PI * 2
    b.box(x + Math.sin(a) * 1.1, 0.16, z + Math.cos(a) * 1.1, 0.47, 0.32, 0.37, j % 3 ? P.mortar : P.pale, 0, a)
  }
  b.box(x, 0.1, z, 1.48, 0.19, 1.44, P.dark)
  for (const side of [-1, 1]) {
    b.box(x, 0.26, z + side * 0.29, 1.55, 0.31, 0.32, P.bark, 0, side * 0.4)
    b.box(x + side * 0.22, 0.45, z, 0.27, 0.27, 1.12, P.wood, 0, side * 0.32)
    // Side benches, with lighter cut ends.
    b.box(x + side * 2.08, 0.49, z + 0.12, 0.55, 0.6, 1.83, P.bark)
    b.box(x + side * 2.08, 0.5, z + 1.06, 0.5, 0.51, 0.06, P.tile)
    b.box(x + side * 2.08, 0.78, z + 0.12, 0.62, 0.15, 1.96, P.wood)
  }
  stall(b, -19.43, 4.72, P.teal)
  stall(b, -12.54, 4.72, P.roof)
  // A book and folded cloth hint that the market trades resources, not only fruit.
  books(b, -19.45, 1.16, 5.18, 1.72, 2)
  for (let j = 0; j < 3; j++) b.box(-12.35 + j * 0.06, 1.24 + j * 0.15, 5.1, 0.93, 0.13, 0.54, [P.blue, P.paper, P.red][j])
  // Bunting above the back of the square.
  for (const dx of [-4.6, 4.6]) b.box(x + dx, 1.83, 3.75, 0.15, 3.66, 0.15, P.wood)
  for (let j = 0; j < 21; j++) {
    const dx = -4.55 + j * 0.455
    const y = 3.24 + 0.38 * (Math.abs(dx) / 4.55) ** 2
    b.box(x + dx, y, 3.75, 0.48, 0.05, 0.05, P.dark)
    if (j % 2 === 0) {
      b.box(x + dx, y - 0.18, 3.76, 0.28, 0.3, 0.07, [P.red, P.gold, P.teal][j % 3])
      b.box(x + dx, y - 0.35, 3.76, 0.14, 0.11, 0.07, [P.red, P.gold, P.teal][j % 3])
    }
  }
  b.build()
  const flame = new THREE.Group()
  flame.name = 'pixel-campfire'
  flame.position.set(x, 0.43, z)
  parent.add(flame)
  const geo = new THREE.BoxGeometry(1, 1, 1)
  for (const [i, color] of ['#db6339', '#f7a348', '#ffe59c'].entries()) {
    const m = toonMaterial({ color, emissive: color })
    const cube = new THREE.Mesh(geo, m)
    cube.position.set((i - 1) * 0.1, 0.23 + i * 0.18, i * 0.06)
    cube.scale.set(0.76 - i * 0.2, 0.62 + i * 0.08, 0.63 - i * 0.18)
    flame.add(cube)
  }
  return flame
}

export function createLandmarks(root) {
  library(root)
  workshop(root)
  dojo(root)
  const flame = campfire(root)
  let disposed = false
  const update = (_dt, t = 0) => {
    if (disposed) return
    flame.children.forEach((cube, i) => {
      cube.scale.y = 0.62 + i * 0.08 + Math.round(Math.sin(t * 8 + i * 2) * 3) * 0.035
      cube.position.x = (i - 1) * 0.1 + Math.round(Math.sin(t * 4 + i) * 2) * 0.04
    })
  }
  update(0, 0)
  return { update, dispose() { disposed = true } }
}

// Keep the hand-built round-2 architecture, but place just one landmark in a
// chunk. Coordinates inside each model stay private to that model.
export function createChunkLandmark(parent, kind, { scale = .85 } = {}) {
  const root = new THREE.Group()
  root.name = `chunk-landmark-${kind}`
  root.scale.setScalar(scale)
  parent.add(root)
  let flame = null
  let chimney = null
  if (kind === 'memory') {
    root.position.set(20 * scale, 0, -3.5 + 12 * scale)
    library(root)
  } else if (kind === 'technique') {
    root.position.set(-18 * scale, 0, -3.3 - 6.25 * scale)
    dojo(root)
  } else if (kind === 'resource') {
    root.position.set(16 * scale, 0, -2.4 - 7 * scale)
    flame = campfire(root)
  } else {
    root.position.set(-18 * scale, 0, -3.5 + 12 * scale)
    workshop(root)
    chimney = { x: 2.1 * scale, y: 5.45 * scale, z: -3.5 - .17 * scale }
  }
  let disposed = false
  return {
    chimney,
    update(_dt, t = 0) {
      if (disposed || !flame) return
      flame.children.forEach((cube, i) => {
        cube.scale.y = .62 + i * .08 + Math.round(Math.sin(t * 8 + i * 2) * 3) * .035
        cube.position.x = (i - 1) * .1 + Math.round(Math.sin(t * 4 + i) * 2) * .04
      })
    },
    dispose() { disposed = true },
  }
}
