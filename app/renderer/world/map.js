import * as THREE from 'three'
import { createPainter, seededRandom, tree, fence, lantern, flowers, bench, signpost } from './map-props.js'
import { createLandmarks } from './map-landmarks.js'
import { createMapAmbient } from './map-ambient.js'
import { isRoad, waterShape, groundHeight, createNavigation } from './map-paths.js'

/** A continuous 64 × 40 village. Each landmark's coordinate is its open meeting apron. */
export function createMap(scene, { seed = 1 } = {}) {
  const root = new THREE.Group()
  root.name = 'petpack-village'
  const random = seededRandom(seed)
  const p = createPainter(root)
  const bounds = { minX: -32, maxX: 32, minZ: -20, maxZ: 20 }
  const landmarks = {
    library: { x: -20, z: -8, kind: 'memory', label: 'Library' },
    workshop: { x: 18, z: -8, kind: 'skill', label: 'Workshop' },
    dojo: { x: 18, z: 10, kind: 'technique', label: 'Dojo' },
    campfire: { x: -16, z: 10, kind: 'resource', label: 'Campfire' },
  }
  const obstacles = []
  const reserve = (x, z, w, d) => obstacles.push({ x, z, w: w / 2, d: d / 2 })
  // Props remain outside these broad, continuous meeting aprons.
  const precinct = (x, z) => (x > -25 && x < -14.5 && z > -16 && z < -5.8) ||
    (x > 12.8 && x < 23.4 && z > -16 && z < -5.8) ||
    (x > 13.3 && x < 22.7 && z > 2 && z < 11.5) ||
    (x > -22 && x < -10 && z > 2 && z < 11.5)
  const inApron = (x, z) => z > -9.5 && z < -6.75 && ((x > -24.3 && x < -15.7) || (x > 13.7 && x < 22.3))
  const inSquare = (x, z) => x > -21.5 && x < -10.5 && z > 2.5 && z < 11.3
  const grassColors = ['#92a86b', '#96ab70', '#99ae72', '#8fa468', '#9bb074']
  const pathColors = ['#cbb383', '#d0b889', '#cbb384', '#d4bc8d', '#c6ad7d']
  const shoreColors = ['#9c9870', '#a6a079', '#8e9168']
  const waterColors = ['#448e8a', '#468f8a', '#498f89', '#448b87']
  const tile = .5
  for (let x = -31.75; x < 32; x += tile) {
    for (let z = -19.75; z < 20; z += tile) {
      const wet = waterShape(x, z)
      if (wet) {
        p.box(x, -.2, z, tile, .08, tile, waterColors[Math.floor(random() * waterColors.length)])
        continue
      }
      const bank = waterShape(x + .55, z) || waterShape(x - .55, z) || waterShape(x, z + .55) || waterShape(x, z - .55)
      const path = isRoad(x, z) || inApron(x, z) || inSquare(x, z)
      const palette = path ? pathColors : bank ? shoreColors : grassColors
      p.box(x, -.12, z, tile, .24, tile, palette[Math.floor(random() * palette.length)])
      if (path && random() < .16 && !(Math.abs(x) < 3.6 && Math.abs(z) < 1.3)) {
        p.box(x + (random() - .5) * .25, .008, z + (random() - .5) * .25, .13 + random() * .21, .014, .1 + random() * .11, random() > .4 ? '#e0cca1' : '#bda47a')
      }
      if (!path && bank && random() < .09) p.stone(x, .08, z, .3 + random() * .3, .19, .28, '#a4aa91', random() * 3)
    }
  }
  // A timber footbridge with an actual shallow ramp, reflected by ground().
  for (let i = 0; i < 28; i++) {
    const x = -3.375 + i * .25
    const y = groundHeight(x, 0)
    p.box(x, y - .075, 0, .235, .15, 2.15, i % 3 ? '#bda277' : '#cdb58c')
    p.box(x, y + .008, -.75, .06, .018, .07, '#7f7056')
    p.box(x, y + .008, .75, .06, .018, .07, '#7f7056')
  }
  for (const z of [-1.13, 1.13]) {
    for (let i = 0; i < 7; i++) {
      const x = -3 + i
      const y = groundHeight(x, 0)
      p.box(x, y + .39, z, .18, .9, .18, '#8b795b')
      p.box(x, y + .87, z, .25, .12, .25, '#d1bb8e')
    }
    for (let i = 0; i < 24; i++) {
      const x = -2.875 + i * .25
      p.box(x, groundHeight(x, 0) + .68, z, .27, .13, .12, '#a8926c')
    }
  }
  // Readable openings: planting frames the entrance without swallowing two-unit pets.
  for (const [x, z, w, d] of [[-24.7,-7.4,1.25,2],[-15.15,-7.4,1.2,2],[13,-7.6,1.25,2],[23.15,-7.6,1.25,2],[-19.8,12.7,3.8,.9],[-12.1,12.7,2.7,.9],[14,12.6,2.9,.9],[22,12.6,2.9,.9]]) {
    flowers(p, x, z, w, d, random, Math.round(w * d * 12))
    reserve(x, z, w + .3, d + .3)
  }
  for (const [x,z] of [[-26,-2],[-12,-2],[5,-2],[21,-2],[-18,11.9],[20,11.9],[-22.8,-6],[21.8,-6]]) {
    lantern(p,x,z); reserve(x+.15,z,.6,.6)
  }
  for (const [x,z,icon,dir] of [[-21.7,-2,'book',-1],[16.1,-2,'gear',1],[16,1.85,'fist',1],[-14,1.85,'flame',-1]]) {
    signpost(p,x,z,icon,dir); reserve(x,z,1.8,.35)
  }
  for (const [x,z,len,alongZ] of [[-29,-15,11,false],[-29,-15,12,true],[-29,3,12,true],[-29,15,9,false],[-23,15,8,false],[29,-15,11,true],[29,3,12,true],[13,15,15,false],[-13,-15,7,false]]) {
    fence(p,x,z,len,alongZ)
    reserve(x+(alongZ?0:len/2),z+(alongZ?len/2:0),alongZ?.4:len+.4,alongZ?len+.4:.4)
  }
  for (const [x,z] of [[-10,-10],[-24,2.1],[9.5,16.4],[25,-10.1],[-5,5.4]]) {
    bench(p,x,z); reserve(x,z,2.1,1)
  }
  const occupied = (x,z) => obstacles.some(o => Math.abs(x-o.x) < o.w+.18 && Math.abs(z-o.z) < o.d+.18)
  // Several tree species, with a loose orchard/forest rhythm and protected paths.
  const planted = []
  function plant(x,z,type,scale=1) {
    if (waterShape(x,z) || isRoad(x,z,1.05) || precinct(x,z) || occupied(x,z)) return false
    if (planted.some(t => Math.hypot(t.x-x,t.z-z) < 2.4)) return false
    tree(p,x,z,type,random,scale)
    planted.push({x,z})
    reserve(x,z,.7*scale,.7*scale)
    return true
  }
  for (const [x,z,type,scale] of [[-27,-12,0,1.2],[-26,-6,2,1],[-12,-12,0,1.2],[-6,-14,1,1.3],[5,-12,2,1.2],[11,-14,1,1.25],[26,-13,0,1.2],[-25,7,0,1.15],[-25,13,2,1.1],[-10,15,2,1],[12,15,0,1.1],[25,6,2,1],[-4,8,0,.85],[4,7,0,.9]]) plant(x,z,type,scale)
  for (let i=0;i<260 && planted.length<92;i++) plant(random()*60-30,random()*36-18,i%3,.75+random()*.43)
  // Reeds and lily pads make the pond distinct from the flowing stream.
  for (let i=0;i<34;i++) {
    const angle=i/34*Math.PI*2, x=6.5+Math.cos(angle)*3.9, z=12.5+Math.sin(angle)*2.9
    if (isRoad(x,z,.5)) continue
    for (let j=0;j<3;j++) {
      const dx=(random()-.5)*.3, dz=(random()-.5)*.3, h=.35+random()*.42
      p.box(x+dx,h/2,z+dz,.045,h,.045,'#718d59')
      if(j===0) p.box(x+dx,h,z+dz,.085,.2,.085,'#967e4e')
    }
  }
  for(const [x,z] of [[5.1,11.8],[7.1,13.7],[8,12.3],[5.7,14]]) {
    p.box(x,-.125,z,.5,.028,.35,'#6f9c67')
    p.box(x-.1,-.08,z,.17,.07,.15,'#ebc5bc')
    p.box(x-.1,-.035,z,.07,.035,.07,'#ead68f')
  }
  // Small orchard crates, mushrooms and weathered stones reward a camera glide.
  for (let i=0;i<130;i++) {
    const x=random()*61-30.5,z=random()*37-18.5
    if(waterShape(x,z)||isRoad(x,z,.55)||precinct(x,z)||occupied(x,z)) continue
    if(i%4===0) {
      p.box(x,.08,z,.07,.16,.07,'#ded0a4')
      p.box(x,.18,z,.24,.09,.21,'#c59474')
      p.box(x-.055,.23,z,.045,.02,.045,'#ecdcb3')
    } else p.stone(x,.065,z,.13+random()*.2,.13,.16+random()*.12,i%3?'#a7ab85':'#c0bd94',random()*3)
  }
  p.finish()
  const architecture = createLandmarks(root)
  // Reserve physical structures for off-path recovery. Landmark approaches stay open.
  reserve(-20,-11.5,8,6.4)
  reserve(18,-11.5,8.2,6.4)
  reserve(18,6.2,8.1,5.6)
  reserve(-16,6,10.8,5.9)
  const navigation = createNavigation(occupied)
  const air = createMapAmbient(root, {
    random, waterShape, chimney: {x:20.1,y:5.45,z:-12.17},
    clear: (x,z) => !waterShape(x,z) && !isRoad(x,z,.25) && !precinct(x,z) && !occupied(x,z),
  })
  scene.add(root)
  let disposed = false
  return {
    bounds, landmarks,
    ground: groundHeight,
    spots: navigation.spots,
    path: navigation.path,
    update(dt,t) {
      if(disposed) return
      architecture.update?.(dt,t)
      air.update(dt,t)
    },
    dispose() {
      if(disposed) return
      disposed=true
      air.dispose()
      architecture.dispose?.()
      root.removeFromParent()
      const geometries=new Set(),materials=new Set()
      root.traverse(object=>{
        if(object.geometry) geometries.add(object.geometry)
        if(object.material) for(const m of (Array.isArray(object.material)?object.material:[object.material])) materials.add(m)
        if(object.isInstancedMesh) object.dispose()
      })
      geometries.forEach(g=>g.dispose())
      materials.forEach(m=>m.dispose())
    },
  }
}
