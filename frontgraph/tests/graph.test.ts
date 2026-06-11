import { describe, expect, it } from 'vitest'
import type { GraphNode } from '../src/parser'
import {
  buildGraph, depthOrder, detectCycles, getDependents, getDeps,
  inferArchitecture, search, validateReferences,
} from '../src/graph'

function node(id: string, deps: string[] = [], extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    category: 'logic',
    summary: `Summary for ${id}`,
    dependencies: deps,
    exports: [],
    doc: '',
    filePath: `${id}.ts`,
    ...extra,
  }
}

describe('buildGraph', () => {
  it('indexes nodes and builds reverse dependencies', () => {
    const graph = buildGraph([
      node('src/types/orders'),
      node('src/logic/pricing', ['src/types/orders']),
      node('src/ui/form', ['src/logic/pricing', 'src/types/orders']),
    ])

    expect(graph.nodes.size).toBe(3)
    expect([...graph.reverseDeps.get('src/types/orders')!].sort()).toEqual([
      'src/logic/pricing',
      'src/ui/form',
    ])
    expect([...graph.reverseDeps.get('src/ui/form')!]).toEqual([])
  })

  it('ignores dependencies on unknown (external) nodes', () => {
    const graph = buildGraph([node('src/a', ['react', 'src/missing'])])
    expect(graph.reverseDeps.has('react')).toBe(false)
  })
})

describe('getDeps / getDependents', () => {
  const graph = buildGraph([
    node('src/types/orders'),
    node('src/logic/pricing', ['src/types/orders']),
  ])

  it('returns direct dependencies as nodes', () => {
    expect(getDeps(graph, 'src/logic/pricing').map(n => n.id)).toEqual(['src/types/orders'])
    expect(getDeps(graph, 'src/types/orders')).toEqual([])
  })

  it('returns direct dependents as nodes', () => {
    expect(getDependents(graph, 'src/types/orders').map(n => n.id)).toEqual(['src/logic/pricing'])
    expect(getDependents(graph, 'src/logic/pricing')).toEqual([])
  })

  it('returns empty for unknown ids', () => {
    expect(getDeps(graph, 'nope')).toEqual([])
    expect(getDependents(graph, 'nope')).toEqual([])
  })
})

describe('depthOrder', () => {
  it('layers a linear chain bottom-up', () => {
    const graph = buildGraph([
      node('a'),
      node('b', ['a']),
      node('c', ['b']),
    ])

    expect(depthOrder(graph)).toEqual([['a'], ['b'], ['c']])
  })

  it('puts independent roots in layer 0 and fan-in nodes after their deps', () => {
    const graph = buildGraph([
      node('a'),
      node('b'),
      node('c', ['a', 'b']),
    ])

    const layers = depthOrder(graph)
    expect(layers[0].sort()).toEqual(['a', 'b'])
    expect(layers[1]).toEqual(['c'])
  })

  it('still includes every node when the graph is one big cycle', () => {
    const graph = buildGraph([
      node('a', ['b']),
      node('b', ['a']),
    ])

    const layers = depthOrder(graph)
    const all = layers.flat().sort()
    expect(all).toEqual(['a', 'b'])
  })
})

describe('detectCycles', () => {
  it('returns no cycles for a DAG', () => {
    const graph = buildGraph([
      node('a'),
      node('b', ['a']),
      node('c', ['a', 'b']),
    ])
    expect(detectCycles(graph)).toEqual([])
  })

  it('detects a two-node cycle with its path', () => {
    const graph = buildGraph([
      node('a', ['b']),
      node('b', ['a']),
    ])

    const cycles = detectCycles(graph)
    expect(cycles.length).toBeGreaterThanOrEqual(1)
    const path = cycles[0].path
    expect(path[0]).toBe(path[path.length - 1])
    expect(path).toContain('a')
    expect(path).toContain('b')
  })
})

describe('search', () => {
  const graph = buildGraph([
    node('src/logic/pricing', [], { summary: 'Pricing engine pipeline', exports: ['recalcCart'] }),
    node('src/types/orders', [], { category: 'types', summary: 'Order domain contracts' }),
    node('src/ui/form', [], { category: 'ui', summary: 'Checkout form with pricing preview' }),
  ])

  it('ranks exact id matches first', () => {
    const results = search(graph, 'src/logic/pricing')
    expect(results[0].id).toBe('src/logic/pricing')
  })

  it('finds nodes by summary keyword', () => {
    const ids = search(graph, 'pricing').map(n => n.id)
    expect(ids).toContain('src/logic/pricing')
    expect(ids).toContain('src/ui/form')
  })

  it('finds nodes by export name', () => {
    const results = search(graph, 'recalcCart')
    expect(results[0].id).toBe('src/logic/pricing')
  })

  it('returns empty for no matches', () => {
    expect(search(graph, 'zzz-not-here')).toEqual([])
  })
})

describe('validateReferences', () => {
  it('flags internal dependencies that are missing from the graph', () => {
    const graph = buildGraph([
      node('src/a', ['src/missing']),
    ])

    const issues = validateReferences(graph, () => true)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain("dependency 'src/missing' not found")
  })

  it('does not flag bare packages, relative paths, css, or foreign roots', () => {
    const graph = buildGraph([
      node('src/a', ['react', './local-thing', 'styles/app.css', 'other-root/module']),
    ])

    expect(validateReferences(graph, () => true)).toEqual([])
  })

  it('flags doc paths that do not resolve on disk', () => {
    const graph = buildGraph([
      node('src/a', [], { doc: 'Docs/src/a.md' }),
    ])

    const issues = validateReferences(graph, () => false)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain("doc path 'Docs/src/a.md' not found")
  })
})

describe('inferArchitecture', () => {
  it('derives natural flow from average layer depth per category', () => {
    const nodes = [
      node('src/types/orders', [], { category: 'contract' }),
      node('src/logic/pricing', ['src/types/orders'], { category: 'logic' }),
      node('src/ui/form', ['src/logic/pricing'], { category: 'ui' }),
    ]
    const graph = buildGraph(nodes)
    const layers = depthOrder(graph)

    const arch = inferArchitecture(graph, layers)

    expect(arch.layerZeroCategories).toEqual(['contract'])
    expect(arch.naturalFlow).toEqual(['contract', 'logic', 'ui'])
    expect(arch.categoryDependencyMatrix.logic.contract).toBe(1)
    expect(arch.categoryDependencyMatrix.ui.logic).toBe(1)
  })
})
