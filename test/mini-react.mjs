// Minimal React stand-in for exercising a Client bundle in Node: it renders a
// component tree by invoking function components with a hook dispatcher, keeps
// per-component state across renders, runs effects, and exposes the rendered
// host element tree so a test can trigger props (onClick, onChange, ...).
export function createMiniReact() {
  const stores = new Map()
  let pending = null

  function storeFor(type) {
    let store = stores.get(type)
    if (store === undefined) {
      store = { hooks: [], index: 0, dirty: false, effects: [], cleanups: [] }
      stores.set(type, store)
    }
    return store
  }

  function current() {
    if (pending === null) throw new Error('hook called outside a component render')
    return pending
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = []
      const push = (value) => {
        if (value === null || value === undefined || value === false || value === true) return
        if (Array.isArray(value)) {
          for (const item of value) push(item)
          return
        }
        flat.push(value)
      }
      for (const child of children) push(child)
      return { $$kind: 'element', type, props: props ?? {}, children: flat }
    },
    Fragment: 'Fragment',
    useState(initial) {
      const store = current()
      const slot = store.index++
      if (store.hooks[slot] === undefined) store.hooks[slot] = { value: initial }
      const cell = store.hooks[slot]
      const set = (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next
        if (value !== cell.value) {
          cell.value = value
          store.dirty = true
        }
      }
      return [cell.value, set]
    },
    useRef(initial) {
      const store = current()
      const slot = store.index++
      if (store.hooks[slot] === undefined) store.hooks[slot] = { value: { current: initial } }
      return store.hooks[slot].value
    },
    useCallback(fn) {
      current().index++
      return fn
    },
    useMemo(fn) {
      current().index++
      return fn()
    },
    useEffect(fn) {
      current().effects.push(fn)
    },
  }

  function buildTree(node, out) {
    if (node === null || node === undefined || node === false || node === true) return
    if (typeof node === 'string' || typeof node === 'number') {
      out.push({ $$kind: 'text', text: String(node) })
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) buildTree(child, out)
      return
    }
    if (typeof node.type === 'function') {
      const store = storeFor(node.type)
      const previous = pending
      pending = store
      store.index = 0
      store.effects = []
      let rendered
      try {
        rendered = node.type({ ...node.props, children: node.children })
      } finally {
        pending = previous
      }
      buildTree(rendered, out)
      return
    }
    const children = []
    for (const child of node.children) buildTree(child, children)
    out.push({
      $$kind: 'host',
      tag: typeof node.type === 'string' ? node.type : String(node.type),
      props: node.props,
      children,
    })
  }

  /** Render (flushing state updates), run effects, and return the host tree. */
  function render(element) {
    let tree = []
    let rounds = 0
    for (;;) {
      for (const store of stores.values()) store.dirty = false
      tree = []
      buildTree(element, tree)
      rounds++
      let dirty = false
      for (const store of stores.values()) if (store.dirty) dirty = true
      if (!dirty) break
      if (rounds > 20) throw new Error('render did not settle')
    }
    for (const store of stores.values()) {
      const effects = store.effects
      store.effects = []
      for (const effect of effects) {
        const cleanup = effect()
        if (typeof cleanup === 'function') store.cleanups.push(cleanup)
      }
    }
    return tree
  }

  /** Depth-first host elements matching a predicate. */
  function findAll(tree, predicate) {
    const out = []
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.$$kind === 'host' && predicate(node)) out.push(node)
        if (node.children !== undefined) walk(node.children)
      }
    }
    walk(Array.isArray(tree) ? tree : [tree])
    return out
  }

  /** All text in the rendered tree, whitespace-collapsed. */
  function textOf(tree) {
    const parts = []
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.$$kind === 'text') parts.push(node.text)
        else if (node.children !== undefined) walk(node.children)
      }
    }
    walk(Array.isArray(tree) ? tree : [tree])
    return parts.join('').replace(/\s+/g, ' ').trim()
  }

  function dispose() {
    for (const store of stores.values()) {
      for (const cleanup of store.cleanups.splice(0)) {
        try {
          cleanup()
        } catch {
          /* reported by the caller when it matters */
        }
      }
    }
    stores.clear()
  }

  return { React, render, findAll, textOf, dispose }
}
