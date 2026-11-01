// An original, procedural little companion. Blank cells deliberately stay blank.
export const TEST_ATLAS_FRAMES = Object.freeze([8, 8, 8, 6, 8, 6, 8, 8, 6])

let atlasPromise

export async function makeTestAtlas() {
  if (!atlasPromise) {
    atlasPromise = Promise.resolve().then(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1536
      canvas.height = 1872
      const ctx = canvas.getContext('2d')
      for (let row = 0; row < 9; row++) {
        for (let frame = 0; frame < TEST_ATLAS_FRAMES[row]; frame++) {
          ctx.save()
          ctx.translate(frame * 192, row * 208)
          ctx.beginPath()
          ctx.rect(0, 0, 192, 208)
          ctx.clip()
          drawPet(ctx, row, frame, TEST_ATLAS_FRAMES[row])
          ctx.restore()
        }
      }
      return canvas.toDataURL('image/png')
    }).catch(error => {
      atlasPromise = undefined
      throw error
    })
  }
  return atlasPromise
}

function ellipse(ctx, x, y, rx, ry, fill, rotation = 0) {
  ctx.beginPath()
  ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
}

function plush(ctx, x, y, radius, light = '#fff9ed', dark = '#e9b49b') {
  const gradient = ctx.createRadialGradient(x - radius * .3, y - radius * .4, radius * .1, x, y, radius)
  gradient.addColorStop(0, light)
  gradient.addColorStop(.65, '#f8deca')
  gradient.addColorStop(1, dark)
  return gradient
}

function paw(ctx, x, y, angle = 0, length = 22) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ellipse(ctx, 0, 0, 13, length, plush(ctx, -2, -4, length * 1.25))
  ellipse(ctx, -2.5, -length * .34, 5.4, 8, '#fff4e5', -.15)
  ctx.restore()
}

function ear(ctx, x, y, angle, drooped) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(-15, 5)
  ctx.bezierCurveTo(-23, -19, -18, -42, -7, -44)
  ctx.bezierCurveTo(4, -44, 18, -17, 15, 5)
  ctx.closePath()
  ctx.fillStyle = plush(ctx, -7, -20, 30)
  ctx.fill()
  ellipse(ctx, -3.5, -22, 7, 16, drooped ? '#efc5b4' : '#f1b7a9', -.15)
  ellipse(ctx, -6, -27, 3, 7, '#f7d0be', -.15)
  ctx.restore()
}

function drawPet(ctx, row, frame, count) {
  const phase = frame / count * Math.PI * 2
  const running = row === 1 || row === 2 || row === 7
  const jumping = row === 4
  const failed = row === 5
  const waiting = row === 6
  const review = row === 8
  const wave = row === 3
  const bounce = running ? Math.abs(Math.sin(phase)) * 8 : jumping ? Math.sin(frame / (count - 1) * Math.PI) * 16 : Math.sin(phase) * 1.7
  const stride = Math.sin(phase) * (running ? 13 : 0)
  const lean = review ? -.105 + Math.sin(phase) * .018 : running ? .07 : failed ? -.045 : Math.sin(phase) * .012
  const scaleY = failed ? .91 : jumping ? 1 + Math.sin(phase) * .025 : 1 + Math.sin(phase) * .012

  ctx.translate(96, 190 - bounce)
  if (row === 2) ctx.scale(-1, 1)
  ctx.rotate(lean)
  ctx.scale(1 + (1 - scaleY) * .4, scaleY)
  ctx.translate(-96, -190)

  // A small curled tail catches light behind the body.
  ctx.save()
  ctx.translate(55, 156)
  ctx.rotate(-.12 + Math.sin(phase) * .15)
  ellipse(ctx, -6, -7, 18, 27, plush(ctx, -10, -13, 32), -.62)
  ellipse(ctx, -13, -17, 10, 16, '#fff4e5', -.52)
  ctx.restore()

  // Feet share a stable baseline at rest; the run cycle alternates their reach.
  paw(ctx, 75 + stride * .48, 179 - Math.max(0, -stride) * .42, -.78 + stride * .022, 18)
  paw(ctx, 116 - stride * .48, 179 - Math.max(0, stride) * .42, .78 + stride * .022, 18)
  ellipse(ctx, 96, 146, 37, 39, plush(ctx, 89, 135, 49))
  ellipse(ctx, 96, 151, 25, 26, '#fff3e1')

  // Arms: a clear silhouette makes the tiny wave and jump readable.
  const leftArm = running ? -.25 - Math.sin(phase) * .48 : jumping ? .68 : -.16
  paw(ctx, 62, jumping ? 124 : 145, leftArm, 23)
  if (wave) {
    paw(ctx, 154, 103 + Math.sin(phase) * 3, -.55 + Math.sin(phase) * .32, 23)
    ellipse(ctx, 157 + Math.sin(phase) * 4, 94, 5, 6.5, '#ebbbac')
  } else if (review) {
    paw(ctx, 118, 129, -.75, 19)
  } else {
    paw(ctx, 130, jumping ? 124 : 145, running ? .25 + Math.sin(phase) * .48 : jumping ? -.68 : waiting ? -.3 + Math.sin(phase) * .15 : .16, 23)
  }

  // Mint scarf and its little trailing end are drawn before the oversized head.
  ctx.save()
  ctx.translate(116, 134)
  ctx.rotate(running ? -.4 + Math.sin(phase) * .18 : -.12)
  ctx.beginPath()
  ctx.moveTo(-3, 0)
  ctx.quadraticCurveTo(21, 4, 20, 32)
  ctx.quadraticCurveTo(8, 38, 2, 29)
  ctx.quadraticCurveTo(5, 12, -5, 8)
  ctx.closePath()
  const scarfTail = ctx.createLinearGradient(0, 0, 20, 34)
  scarfTail.addColorStop(0, '#43bca9')
  scarfTail.addColorStop(1, '#78d4bb')
  ctx.fillStyle = scarfTail
  ctx.fill()
  ctx.restore()
  ellipse(ctx, 97, 133, 34, 10, '#58bdab')
  ellipse(ctx, 93, 130, 29, 6.5, '#a2e5ca')

  const headY = failed ? 101 : 94 + (waiting ? Math.sin(phase) * 1.4 : 0)
  ctx.save()
  ctx.translate(96, headY)
  ctx.rotate(review ? -.085 : failed ? .08 : running ? -.04 : 0)
  ctx.translate(-96, -headY)
  ear(ctx, 62, headY - 29, failed ? -.73 : -.24 + Math.sin(phase) * .035, failed)
  ear(ctx, 130, headY - 29, failed ? .7 : .3 - Math.sin(phase) * .035, failed)

  const face = plush(ctx, 88, headY - 6, 61, '#fffbee', '#e8b398')
  ellipse(ctx, 96, headY, 53, 44, face)
  ellipse(ctx, 88, headY - 14, 34, 24, '#fff6e6')
  // Cream muzzle, peach cheeks and a tiny dark nose.
  ellipse(ctx, 96, headY + 17, 24, 15, '#fff8e9')
  ellipse(ctx, 64, headY + 12, 9.5, 5, '#f2b6a6', .08)
  ellipse(ctx, 129, headY + 12, 9.5, 5, '#f2b6a6', -.08)

  const gaze = running ? 5 : waiting ? Math.sin(phase) * 3 : review ? -3 : 0
  const blink = row === 0 && frame === count - 2
  const happy = jumping || wave
  for (const side of [-1, 1]) {
    const x = 96 + side * 22 + gaze
    const y = headY + 3 + (failed ? 4 : 0)
    if (blink || (happy && frame > count / 2)) {
      ctx.beginPath()
      ctx.moveTo(x - 5, y + (happy ? 2 : 0))
      ctx.quadraticCurveTo(x, y - (happy ? 6 : 1), x + 5, y + (happy ? 2 : 0))
      ctx.strokeStyle = '#473e3e'
      ctx.lineWidth = 3.5
      ctx.lineCap = 'round'
      ctx.stroke()
    } else {
      ellipse(ctx, x, y, 5.2, failed ? 5.7 : 7, '#473e3e', side * -.04)
      ellipse(ctx, x - 1.7, y - 2.8, 1.7, 2.1, '#fffdf7')
    }
    if (failed || review) {
      ctx.beginPath()
      ctx.moveTo(x - 5, y - 11 - side * 2)
      ctx.quadraticCurveTo(x, y - 13, x + 5, y - 11 + side * 2)
      ctx.strokeStyle = '#a88370'
      ctx.lineWidth = 2.3
      ctx.lineCap = 'round'
      ctx.stroke()
    }
  }
  ellipse(ctx, 96 + gaze * .3, headY + 16, 4.4, 3.3, '#8b635a')
  ctx.beginPath()
  ctx.moveTo(91, headY + 23)
  ctx.quadraticCurveTo(96, headY + (failed ? 18 : 28), 101, headY + 23)
  ctx.strokeStyle = '#8b635a'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.stroke()
  ctx.restore()

  // A simple embroidered dot on the scarf is visible even at overlay scale.
  ellipse(ctx, 118, 140, 4, 4, '#edfff0')
  ellipse(ctx, 117.4, 138.9, 1.2, 1.2, '#ffffff')
}
