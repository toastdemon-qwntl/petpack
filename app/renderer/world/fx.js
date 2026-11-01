// STUB (conductor). Owner: fx lane. Replace freely, keep the interface in BRIEF-WORLD.md.
export function createFx({ overlay }) {
  const pets = new Map()
  return {
    attach(id, info) {
      pets.set(id, info)
    },
    detach(id) {
      pets.delete(id)
    },
    setSkills() {},
    setStatus() {},
    say() {},
    gift() {
      return new Promise((resolve) => setTimeout(resolve, 1500))
    },
    update() {},
    resize() {},
    dispose() {
      pets.clear()
      overlay.replaceChildren()
    },
  }
}
