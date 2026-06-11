import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import {
  buildGraph, depthOrder, detectCycles, inferArchitecture,
} from './graph'
import {
  loadConfig, normalizeConfig, parseProjectWithErrors, discoverSourceRoots,
  observeMethodologies, type GraphNode,
} from './parser'
import { detectDrift } from './derive'
import { trackStaleness } from './staleness'
import { listLeases } from './leases'
import { listWorkOrders } from './work-orders'

export const DEFAULT_BRIEF_BUDGET = 2000
const MIN_BRIEF_BUDGET = 200
// Tokens held back from the node section so the truncation notice always fits.
const FOOTER_RESERVE = 50

/** chars/4 — the standard rough estimate. Briefs stay at or under budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function projectName(rootDir: string): string {
  const pkgPath = resolve(rootDir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: unknown }
      if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name
    } catch {
      // fall through to directory name
    }
  }
  return basename(resolve(rootDir))
}

/**
 * Token-budgeted architectural digest for an agent arriving cold (SPEC's
 * "context transfer" goal). Priority order: identity, architecture, health,
 * then the most-connected nodes until the budget runs out. Truncation is
 * always explicit — a brief that silently omits nodes reads as complete.
 */
export function generateBrief(rootDir: string, budgetTokens: number = DEFAULT_BRIEF_BUDGET): string {
  const budget = Math.max(MIN_BRIEF_BUDGET, Math.floor(budgetTokens))

  const config = loadConfig(rootDir)
  const normalized = normalizeConfig(config)
  const sourceRoots = normalized.project.sourceRoots.length > 0
    ? normalized.project.sourceRoots
    : discoverSourceRoots(rootDir)
  const observed = observeMethodologies(rootDir, sourceRoots)
  const { nodes, errors: parseErrors } = parseProjectWithErrors(rootDir)
  const graph = buildGraph(nodes)
  const layers = depthOrder(graph)
  const cycles = detectCycles(graph)
  const architecture = inferArchitecture(graph, layers)
  const drift = detectDrift(nodes)
  const staleness = trackStaleness(rootDir, nodes)
  const staleFiles = new Set(staleness.map(s => s.filePath))

  const lines: string[] = []
  let spent = 0
  const push = (line: string, reserve = 0): boolean => {
    const cost = estimateTokens(line + '\n')
    if (spent + cost > budget - reserve) return false
    lines.push(line)
    spent += cost
    return true
  }

  // ── Identity ──
  push(`# Architectural brief: ${projectName(rootDir)}`)
  push(`${nodes.length} graph nodes across source root(s): ${sourceRoots.join(', ') || '(none discovered)'}`)

  const methodologies: string[] = []
  if (observed.cdd.observed) methodologies.push(`CDD (contracts in ${observed.cdd.contractsPath})`)
  if (observed.tdd.observed) methodologies.push(`TDD (${observed.tdd.framework ?? 'tests'} in ${observed.tdd.testsPath})`)
  if (observed.sdd.observed) methodologies.push(`SDD (specs in ${observed.sdd.specsPath})`)
  if (methodologies.length > 0) push(`Methodologies observed: ${methodologies.join('; ')}`)

  const categoryCounts = new Map<string, number>()
  for (const node of nodes) {
    categoryCounts.set(node.category, (categoryCounts.get(node.category) ?? 0) + 1)
  }
  if (categoryCounts.size > 0) {
    const cats = [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([cat, n]) => `${cat}(${n})`)
      .join(', ')
    push(`Categories: ${cats}`)
  }

  // ── Architecture ──
  push('')
  push('## Architecture')
  if (architecture.naturalFlow.length > 1) {
    push(`Dependency flow: ${architecture.naturalFlow.join(' → ')}`)
  }
  if (layers.length > 0) {
    const layerLine = layers
      .map((layer, i) => {
        const cats = [...new Set(layer.map(id => graph.nodes.get(id)?.category ?? 'unknown'))].sort()
        return `L${i}: ${layer.length} [${cats.join(', ')}]`
      })
      .join('  ')
    push(`Layers (foundation → entry): ${layerLine}`)
  }
  if (layers[0] && layers[0].length > 0) {
    push(`Foundation nodes (everything builds on these): ${layers[0].join(', ')}`)
  }

  // ── Health ──
  push('')
  push('## Health')
  push(drift.length === 0
    ? 'Drift: none — @graph blocks match the code'
    : `Drift: ${drift.length} divergence(s) between blocks and code — run graph_sync / 'frontgraph sync' to repair`)
  if (cycles.length > 0) push(`Circular dependencies: ${cycles.length} — ${cycles.map(c => c.path.join(' → ')).join('; ')}`)
  if (parseErrors.length > 0) push(`Parse errors: ${parseErrors.length} @graph block(s) invalid — run graph_validate`)
  if (staleness.length > 0) {
    push(`Summary staleness suspects: ${staleness.length} — code moved since these blocks were written:`)
    for (const suspect of staleness.slice(0, 5)) {
      push(`  ? ${suspect.nodeIds.join(', ')}: ${suspect.reason}`)
    }
    if (staleness.length > 5) push(`  (and ${staleness.length - 5} more — see graph_validate)`)
  }

  // Coordination state: who is working where, what work is queued
  const leases = listLeases(rootDir)
  if (leases.length > 0) {
    push(`Active leases: ${leases.length} — these nodes are claimed by other agents:`)
    for (const lease of leases.slice(0, 5)) {
      const shownIds = lease.nodeIds.slice(0, 4).join(', ') + (lease.nodeIds.length > 4 ? ', …' : '')
      push(`  ⛔ '${lease.holder}' holds ${lease.nodeIds.length} node(s) (${shownIds}) — ${lease.intent}`)
    }
    if (leases.length > 5) push(`  (and ${leases.length - 5} more — see graph_leases)`)
  }
  const openOrders = listWorkOrders(rootDir).filter(o => o.status !== 'done')
  if (openOrders.length > 0) {
    const ready = openOrders.filter(o => o.ready).length
    push(`Open work orders: ${openOrders.length} (${ready} ready to start) — see graph_work_orders`)
  }

  // ── Key nodes, ranked by connectivity ──
  push('')
  push(`## Key nodes (by connectivity, ${nodes.length} total)`)

  const ranked = [...nodes].sort((a, b) => {
    const score = (n: GraphNode) =>
      (graph.reverseDeps.get(n.id)?.size ?? 0) * 3 + n.dependencies.length
    return score(b) - score(a) || a.id.localeCompare(b.id)
  })

  let shown = 0
  for (const node of ranked) {
    const dependents = graph.reverseDeps.get(node.id)?.size ?? 0
    const cat = node.category !== 'unknown' ? ` [${node.category}]` : ''
    const staleMark = staleFiles.has(node.filePath.replace(/\\/g, '/')) ? ' ⚠ summary may be stale' : ''
    const head = `- ${node.id}${cat} — ${dependents} dependent(s), ${node.dependencies.length} dep(s)${staleMark}`
    const body = `  ${node.summary}`
    const cost = estimateTokens(head + '\n' + body + '\n')
    if (spent + cost > budget - FOOTER_RESERVE) break
    lines.push(head, body)
    spent += cost
    shown += 1
  }

  if (shown < nodes.length) {
    push(`(${shown} of ${nodes.length} nodes shown — raise budget_tokens for more, or use graph_search / graph_deps for specifics)`)
  }

  push('')
  push('Next: graph_search to locate code, graph_dependents before editing, graph_validate after.')

  return lines.join('\n')
}
