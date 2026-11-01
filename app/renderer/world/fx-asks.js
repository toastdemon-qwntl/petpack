// All timing follows fx.update, so adjacent panes share the same conversation.
const COLORS = { skill: '#ffcd78', memory: '#9be5d5', technique: '#d8d1fb', resource: '#ffc88a' }
const ANSWER_AT = 1.35, GIFT_AT = 2.60, FLIGHT = .72

/** Reserve both pets' message queues; independent conversations can run together. */
export function createAsks(bubbles, gifts, pets) {
  const active = new Set()
  function finish(ask, result) {
    active.delete(ask)
    bubbles.release(ask.token, result)
    if (!result && ask.flight) gifts.cancel(ask.flight)
    ask.resolve(result)
  }
  return {
    ask(fromId, toId, { question = 'Can you lend a hand?', answer = 'Here, try this.', kind, label = '' } = {}) {
      const asker = pets.get(fromId), answerer = pets.get(toId)
      if (!asker || !answerer || fromId === toId) return Promise.resolve(false)
      const token = bubbles.reserve([asker.ui, answerer.ui])
      return new Promise(resolve => active.add({ fromId, toId, token, resolve, age: 0,
        question: String(question).slice(0, 96), answer: String(answer).slice(0, 96),
        kind: COLORS[kind] ? kind : null, label: String(label).slice(0, 64), flight: null }))
    },
    detach(id) {
      for (const ask of active) if (ask.fromId === id || ask.toId === id) finish(ask, false)
    },
    update(dt) {
      for (const ask of active) {
        const asker = pets.get(ask.fromId), answerer = pets.get(ask.toId)
        if (!asker || !answerer || ask.token.cancelled) { finish(ask, false); continue }
        if (!ask.token.ready) continue
        ask.age += dt
        bubbles.present(ask.token, asker.ui, ask.age < ANSWER_AT ? { text: ask.question } : { status: 'idle' })
        bubbles.present(ask.token, answerer.ui, ask.age >= ANSWER_AT ? { text: ask.answer }
          : { status: ask.age >= .55 ? 'working' : 'idle' })
        if (!ask.kind && ask.age >= GIFT_AT) { finish(ask, true); continue }
        if (ask.kind && ask.age >= GIFT_AT && !ask.flight) {
          // The answer names the useful thing; keep the dot itself unlabelled and readable.
          ask.flight = gifts.start(ask.toId, ask.fromId, { color: COLORS[ask.kind], duration: FLIGHT })
        }
        if (ask.flight?.arrived) finish(ask, true)
        else if (ask.flight?.cancelled) finish(ask, false)
      }
    },
    dispose() { for (const ask of active) finish(ask, false) },
  }
}
