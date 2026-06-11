import type { GraphNode } from './parser'

export interface Graph {
  nodes: Map<string, GraphNode>
  /** node id → set of node ids that depend on it */
  reverseDeps: Map<string, Set<string>>
}

export interface CycleInfo {
  path: string[]
}

export function buildGraph(nodes: GraphNode[]): Graph {
  const nodeMap = new Map<string, GraphNode>()
  const reverseDeps = new Map<string, Set<string>>()

  for (const node of nodes) {
    nodeMap.set(node.id, node)
    if (!reverseDeps.has(node.id)) reverseDeps.set(node.id, new Set())
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (nodeMap.has(dep)) {
        reverseDeps.get(dep)?.add(node.id)
      }
    }
  }

  return { nodes: nodeMap, reverseDeps }
}

/** Get direct dependencies of a node */
export function getDeps(graph: Graph, id: string): GraphNode[] {
  const node = graph.nodes.get(id)
  if (!node) return []
  return node.dependencies
    .map(d => graph.nodes.get(d))
    .filter((n): n is GraphNode => n != null)
}

/** Get all nodes that depend on a given node */
export function getDependents(graph: Graph, id: string): GraphNode[] {
  const depIds = graph.reverseDeps.get(id)
  if (!depIds) return []
  return [...depIds]
    .map(d => graph.nodes.get(d))
    .filter((n): n is GraphNode => n != null)
}

// ── Cycle detection (DFS-based) ──

/** Detect circular dependencies in the graph. Returns each cycle found. */
export function detectCycles(graph: Graph): CycleInfo[] {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()

  for (const id of graph.nodes.keys()) {
    color.set(id, WHITE)
  }

  const cycles: CycleInfo[] = []

  function dfs(current: string, stack: string[]): void {
    color.set(current, GRAY)
    stack.push(current)

    for (const dep of getDeps(graph, current)) {
      if (color.get(dep.id) === GRAY) {
        // Found a cycle — extract the cycle portion from the stack
        const cycleStart = stack.indexOf(dep.id)
        cycles.push({ path: [...stack.slice(cycleStart), dep.id] })
      } else if (color.get(dep.id) === WHITE) {
        dfs(dep.id, stack)
      }
    }

    stack.pop()
    color.set(current, BLACK)
  }

  for (const id of graph.nodes.keys()) {
    if (color.get(id) === WHITE) {
      dfs(id, [])
    }
  }

  return cycles
}

// ── Depth ordering (BFS with cycle awareness) ──

/** BFS from root to produce a depth-ordered layout. Cycles are broken arbitrarily. */
export function depthOrder(graph: Graph): string[][] {
  // Compute in-degree (number of internal dependencies each node has)
  const inDegree = new Map<string, number>()
  for (const id of graph.nodes.keys()) {
    const deps = getDeps(graph, id)
    inDegree.set(id, deps.length)
  }

  // Layer 0: nodes with no internal dependencies
  const layers: string[][] = []
  const visited = new Set<string>()

  let current = [...graph.nodes.keys()].filter(
    id => (inDegree.get(id) ?? 0) === 0
  )

  // If all nodes have dependencies (cycle-only graph), pick first node
  if (current.length === 0 && graph.nodes.size > 0) {
    const first = graph.nodes.keys().next().value as string
    current = [first]
  }

  while (current.length > 0 && visited.size < graph.nodes.size) {
    layers.push([...current])
    for (const id of current) visited.add(id)

    const nextSet = new Set<string>()
    for (const id of current) {
      const deps = graph.reverseDeps.get(id)
      if (deps) {
        for (const depId of deps) {
          if (!visited.has(depId)) {
            // Check if all of depId's own deps are already visited
            const depDeps = graph.nodes.get(depId)?.dependencies ?? []
            const allDepsVisited = depDeps.every(
              d => !graph.nodes.has(d) || d === depId || visited.has(d)
            )
            if (allDepsVisited) {
              nextSet.add(depId)
            }
          }
        }
      }
    }
    current = [...nextSet]
  }

  // Add any remaining unvisited nodes (shouldn't happen with valid graphs)
  const remaining = [...graph.nodes.keys()].filter(id => !visited.has(id))
  if (remaining.length > 0) {
    layers.push(remaining)
  }

  return layers
}

// ── Search with improved scoring ──

/** Search for nodes matching keywords in id, summary, category, or exports */
export function search(graph: Graph, query: string): GraphNode[] {
  const q = query.toLowerCase()
  const tokens = q.split(/\s+/).filter(t => t.length > 0)
  const results: { node: GraphNode; score: number }[] = []

  for (const node of graph.nodes.values()) {
    let score = 0

    // Exact id match
    if (node.id.toLowerCase() === q) score += 50
    // Id contains query
    else if (node.id.toLowerCase().includes(q)) score += 15

    // Category exact match
    if (node.category.toLowerCase() === q) score += 10
    else if (node.category.toLowerCase().includes(q)) score += 3

    // Summary contains query
    if (node.summary.toLowerCase().includes(q)) score += 8

    // Individual token matching (handles multi-word queries)
    for (const token of tokens) {
      if (node.id.toLowerCase().includes(token)) score += 5
      if (node.summary.toLowerCase().includes(token)) score += 3
      if (node.category.toLowerCase().includes(token)) score += 2
      for (const exp of node.exports) {
        if (exp.toLowerCase().includes(token)) score += 2
      }
    }

    // Export exact match (bonus)
    for (const exp of node.exports) {
      if (exp.toLowerCase() === q) score += 12
      else if (exp.toLowerCase().includes(q)) score += 4
    }

    if (score > 0) results.push({ node, score })
  }

  results.sort((a, b) => b.score - a.score)
  return results.map(r => r.node)
}

// ── Architecture inference ──

export interface InferredArchitecture {
  layerZeroCategories: string[]
  naturalFlow: string[]
  categoryDependencyMatrix: Record<string, Record<string, number>>
  observedPatterns: string[]
}

/** Compute how categories depend on each other */
export function computeCategoryDependencyMatrix(graph: Graph): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {}

  for (const node of graph.nodes.values()) {
    const fromCat = node.category
    if (!matrix[fromCat]) matrix[fromCat] = {}

    for (const depId of node.dependencies) {
      const depNode = graph.nodes.get(depId)
      if (!depNode) continue
      const toCat = depNode.category
      if (toCat === fromCat) continue // skip self-references

      matrix[fromCat][toCat] = (matrix[fromCat][toCat] ?? 0) + 1
    }
  }

  return matrix
}

/** Analyze layers to extract which categories appear at each depth */
export function analyzeLayers(graph: Graph, layers: string[][]): Map<number, string[]> {
  const result = new Map<number, string[]>()

  for (let i = 0; i < layers.length; i++) {
    const cats = new Set<string>()
    for (const id of layers[i]) {
      const node = graph.nodes.get(id)
      if (node) cats.add(node.category)
    }
    result.set(i, [...cats].sort())
  }

  return result
}

/** Infer architecture from graph topology */
export function inferArchitecture(graph: Graph, layers: string[][]): InferredArchitecture {
  // Layer zero categories
  const l0Cats = new Set<string>()
  for (const id of (layers[0] ?? [])) {
    const node = graph.nodes.get(id)
    if (node) l0Cats.add(node.category)
  }

  // Natural flow: category ordering by average layer depth
  const catDepth = new Map<string, { total: number; count: number }>()
  for (let i = 0; i < layers.length; i++) {
    for (const id of layers[i]) {
      const node = graph.nodes.get(id)
      if (!node) continue
      const entry = catDepth.get(node.category) ?? { total: 0, count: 0 }
      entry.total += i
      entry.count += 1
      catDepth.set(node.category, entry)
    }
  }

  const naturalFlow = [...catDepth.entries()]
    .sort(([, a], [, b]) => (a.total / a.count) - (b.total / b.count))
    .map(([cat]) => cat)

  // Category dependency matrix
  const matrix = computeCategoryDependencyMatrix(graph)

  // Observations
  const patterns: string[] = []

  // Foundation layer observation
  if (l0Cats.size > 0) {
    patterns.push(`Foundation layer (Layer 0): ${[...l0Cats].sort().join(', ')}`)
  }

  // Natural flow
  if (naturalFlow.length > 1) {
    patterns.push(`Dependency flow: ${naturalFlow.join(' → ')}`)
  }

  // Categories that depend on nothing within the project
  const noInternalDeps: string[] = []
  for (const node of graph.nodes.values()) {
    const internalDeps = node.dependencies.filter(d => graph.nodes.has(d))
    if (internalDeps.length === 0 && node.dependencies.length === 0) {
      noInternalDeps.push(node.id)
    }
  }
  if (noInternalDeps.length > 0) {
    patterns.push(`${noInternalDeps.length} node(s) have zero dependencies: ${noInternalDeps.join(', ')}`)
  }

  // Leaf nodes (nothing depends on them)
  const leafNodes: string[] = []
  for (const node of graph.nodes.values()) {
    const deps = graph.reverseDeps.get(node.id)
    if (!deps || deps.size === 0) {
      leafNodes.push(node.id)
    }
  }
  if (leafNodes.length > 0 && leafNodes.length < graph.nodes.size) {
    patterns.push(`${leafNodes.length} leaf node(s) (nothing depends on them): ${leafNodes.join(', ')}`)
  }

  // Coupling observations
  for (const [fromCat, targets] of Object.entries(matrix)) {
    const entries = Object.entries(targets).sort(([, a], [, b]) => b - a)
    if (entries.length > 0) {
      const top = entries.slice(0, 3).map(([cat, n]) => `${cat}(${n})`).join(', ')
      patterns.push(`${fromCat} → ${top}`)
    }
  }

  return {
    layerZeroCategories: [...l0Cats].sort(),
    naturalFlow,
    categoryDependencyMatrix: matrix,
    observedPatterns: patterns,
  }
}

// ── Split validation ──

/** Validate references only: broken deps, missing docs */
export function validateReferences(
  graph: Graph,
  resolveDocPath: (rel: string) => boolean,
): string[] {
  const issues: string[] = []
  const internalRoots = new Set(
    [...graph.nodes.keys()]
      .map(id => id.split('#')[0].split('/')[0])
      .filter(Boolean),
  )

  for (const node of graph.nodes.values()) {
    for (const dep of node.dependencies) {
      const root = dep.split('#')[0].split('/')[0]
      const isBarePackage = !dep.startsWith('.') && !dep.includes('/')
      const isExternal =
        dep.startsWith('.') ||
        dep.endsWith('.css') ||
        isBarePackage ||
        (dep.includes('/') && !internalRoots.has(root))

      if (!graph.nodes.has(dep) && !isExternal) {
        issues.push(`${node.id}: dependency '${dep}' not found in graph`)
      }
    }

    if (node.doc && !resolveDocPath(node.doc)) {
      issues.push(`${node.id}: doc path '${node.doc}' not found on disk`)
    }
  }

  return issues
}

/** Validate graph integrity: check deps and docs paths exist */
export function validateGraph(
  graph: Graph,
  resolveDocPath: (rel: string) => boolean,
): string[] {
  return validateReferences(graph, resolveDocPath)
}
