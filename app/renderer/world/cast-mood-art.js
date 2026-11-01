import * as THREE from 'three'

// Original, palette-limited pixel stamps. One texture per design, per attachment.
const ink = '#4d626b', cream = '#fff0c9', gold = '#eac16b'
const painters = {
  z(ctx) { pixels(ctx, ['11111','...1.','..1..','.1...','11111'], { 1: '#adc0d9' }) },
  star(ctx) { pixels(ctx, ['..1..','..1..','11111','..1..','..1..'], { 1: cream }) },
  drop(ctx) { pixels(ctx, ['1','1','2'], { 1: '#8db7cd', 2: '#cae3e9' }) },
  yawn(ctx) { pixels(ctx, ['.111.','12.21','1...1','12.21','.111.'], { 1: ink, 2: '#dfbfa3' }) },
  cloud(ctx) {
    pixels(ctx, [
      '......aaaaaa............','....aabbbbbb aa.........'.replaceAll(' ', ''),
      '...abcccccccbbaaa.......','..abccccccccccbbba......',
      '..abccccccccccccbbaa....','.abcccccccccccccccbbba..',
      'abcccccccccccccccccccbba','abbbbbbbbbbbbbbbbbbbbba',
      '.aaaaaaaaaaaaaaaaaaaaa.',
    ], { a: '#778f9f', b: '#a9bcc4', c: '#d1dcda' })
  },
  puddle(ctx) {
    for (let y = 0; y < 12; y++) for (let x = 0; x < 24; x++) {
      const d = ((x - 11.5) / 11.5) ** 2 + ((y - 5.5) / 5.5) ** 2
      if (d < 1) { ctx.fillStyle = d > .7 ? '#8cbbc1' : '#669aaa'; ctx.fillRect(x, y, 1, 1) }
    }
    ctx.fillStyle = '#c4dddc'; ctx.fillRect(5, 3, 5, 1); ctx.fillRect(15, 7, 4, 1)
  },
  rainbow(ctx) {
    const colors = ['#dd8d83','#e8b46c','#efcf7b','#93bb8a','#85b7c9','#a39abe']
    for (let y = 0; y < 22; y++) for (let x = 0; x < 40; x++) {
      const radius = Math.hypot(x - 19.5, (21 - y) * 1.04)
      const band = Math.floor((19.5 - radius) / 1.15)
      if (band >= 0 && band < colors.length) { ctx.fillStyle = colors[band]; ctx.fillRect(x, y, 1, 1) }
    }
    ctx.fillStyle = cream; ctx.fillRect(0, 20, 6, 2); ctx.fillRect(34, 20, 6, 2)
  },
  hat1(ctx) { pixels(ctx, ['.........','..aa..aa.','.abbacbba','..abbcba.','....cc...','....cc...','....cc...','...ddd...'], { a: '#477768', b: '#89b57b', c: '#699869', d: '#b5c584' }, 3, 6) },
  hat2(ctx) { pixels(ctx, ['....aaaa....','..aabbbbaa..','.abbbbbbbba.','.abbccccbba.','abbbbbbbbbaa','addddddddddda','..eeeeeeee..'], { a: ink, b: '#96b7ba', c: '#c1d3c8', d: '#d9b279', e: '#6c888e' }, 1, 7) },
  hat3(ctx) { pixels(ctx, ['......aa......','....aabba a...'.replaceAll(' ', ''),'..aabbbbbbaa..','aabbbbbbbbbbaa','..aabbbbcaaa..','....aaaac..d..','....abbbc..d..','....aaaaa..d..','...........dd.'], { a: '#4b616c', b: '#778699', c: gold, d: gold }, 1, 5) },
  hat4(ctx) { pixels(ctx, ['......aa.......','.....abba......','....abcca......','....abcba......','...abbbbba.....','...abcbbbba....','..abbccbbba....','..abbbbbbbba...','.abbbcbbbbbba..','.abbcccbbbbba..','abbbbbbbbbbbbba','..aaaaaaaaaaa..'], { a: '#58657f', b: '#9297bd', c: cream }, 0, 2) },
  hat5(ctx) { pixels(ctx, ['.a....a....a.','.ba..aba..ab.','.bbaabbbaabb.','.bbbbbbbbbbb.','..bcbbdbbcbb.','..bbbbbbbbbb.','..aaaaaaaaaa.','...eeeeeeee..'], { a: '#9e7f49', b: '#efcc79', c: cream, d: '#9dbca5', e: '#c79c54' }, 2, 7) },
  balloon(ctx) {
    for (let y = 2; y < 32; y++) for (let x = 2; x < 34; x++) {
      const width = y < 17 ? Math.sqrt(Math.max(0, 1 - ((y - 16) / 15) ** 2)) * 15 : 15 - (y - 17) * .64
      if (Math.abs(x - 17.5) > width) continue
      const edge = Math.abs(x - 17.5) > width - 1.2
      ctx.fillStyle = edge ? '#9b775e' : (Math.floor((x - 3) / 6) % 2 ? '#e7b87e' : '#a7bcb0')
      ctx.fillRect(x, y, 1, 1)
    }
    ctx.fillStyle = cream; ctx.fillRect(9, 8, 2, 7); ctx.fillRect(11, 6, 3, 2)
    ctx.fillStyle = '#927a60'; ctx.fillRect(11, 30, 1, 10); ctx.fillRect(24, 30, 1, 10)
    ctx.fillStyle = '#c29868'; ctx.fillRect(10, 39, 16, 7)
    ctx.fillStyle = '#e8bc81'; ctx.fillRect(9, 38, 18, 2); ctx.fillRect(12, 41, 12, 1)
    ctx.fillStyle = '#997855'; ctx.fillRect(11, 45, 14, 1); ctx.fillRect(14, 40, 1, 5); ctx.fillRect(20, 40, 1, 5)
  },
}
const dimensions = { z: [5,5], star: [5,5], drop: [1,3], yawn: [5,5], cloud: [24,10], puddle: [24,12], rainbow: [40,22], balloon: [36,48] }
function pixels(ctx, rows, palette, dx = 0, dy = 0) {
  rows.forEach((row, y) => [...row].forEach((pixel, x) => {
    if (palette[pixel]) { ctx.fillStyle = palette[pixel]; ctx.fillRect(x + dx, y + dy, 1, 1) }
  }))
}

export function createMoodArt() {
  const textures = new Map(), materials = new Set(), meshes = new Set()
  function texture(key) {
    if (textures.has(key)) return textures.get(key)
    const [w,h] = dimensions[key] || [16,16]
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h
    painters[key](canvas.getContext('2d'))
    const map = new THREE.CanvasTexture(canvas)
    map.colorSpace = THREE.SRGBColorSpace
    map.minFilter = map.magFilter = THREE.NearestFilter; map.generateMipmaps = false
    textures.set(key, map)
    return map
  }
  function sprite(key, width, { base = false } = {}) {
    const map = texture(key)
    const material = new THREE.SpriteMaterial({ map, transparent: true, alphaTest: .05, depthWrite: false, toneMapped: false })
    const object = new THREE.Sprite(material)
    object.name = `Mood ${key}`
    object.scale.set(width, width * map.image.height / map.image.width, 1)
    if (base) object.center.y = 0
    object.userData.noOutline = object.userData.noPick = true
    material.userData.pixelSprite = true
    // Match the cast's anchor grid inside the stage's overscan render target.
    const resolution = { value: new THREE.Vector2(1, 1) }, size = new THREE.Vector2()
    material.onBeforeCompile = shader => {
      shader.uniforms.moodResolution = resolution
      shader.vertexShader = 'uniform vec2 moodResolution;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('mvPosition.xy += rotatedPosition;', `
        vec2 ndc = (projectionMatrix * mvPosition).xy;
        vec2 snapped = (floor((ndc * .5 + .5) * moodResolution + .5) / moodResolution - .5) * 2.;
        mvPosition.xy += (snapped - ndc) / vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
        mvPosition.xy += rotatedPosition;`)
    }
    material.customProgramCacheKey = () => 'petpack-mood-pixel-v1'
    object.onBeforeRender = renderer => {
      const target = renderer.getRenderTarget()
      if (target) resolution.value.set(target.width, target.height)
      else resolution.value.copy(renderer.getDrawingBufferSize(size))
    }
    materials.add(material)
    return object
  }
  function puddle() {
    const material = new THREE.MeshBasicMaterial({ map: texture('puddle'), transparent: true, opacity: .55, depthWrite: false, toneMapped: false, alphaTest: .05 })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.65, .84), material)
    mesh.rotation.x = -Math.PI / 2
    mesh.userData.noOutline = mesh.userData.noPick = true
    materials.add(material); meshes.add(mesh)
    return mesh
  }
  function release(root) {
    root.traverse(object => {
      if (materials.delete(object.material)) object.material.dispose()
      if (meshes.delete(object)) object.geometry.dispose()
    })
    root.removeFromParent()
  }
  return { sprite, puddle, release, dispose() {
    meshes.forEach(mesh => mesh.geometry.dispose()); meshes.clear()
    materials.forEach(material => material.dispose()); materials.clear()
    textures.forEach(map => map.dispose()); textures.clear()
  } }
}
