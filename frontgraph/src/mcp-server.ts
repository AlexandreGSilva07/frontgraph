import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  buildGraph, depthOrder, getDependents, getDeps, search, validateReferences,
  detectCycles, inferArchitecture, analyzeLayers,
  type Graph, type CycleInfo, type InferredArchitecture,
} from './graph'
import {
  loadConfig, normalizeConfig, parseProjectWithErrors, discoverSourceRoots,
  discoverCategories, observeMethodologies,
  type GraphNode, type NormalizedConfig, type ObservedMethodologies, type ParseError,
} from './parser'
import { detectDrift } from './derive'
import { syncGraphBlocks } from './sync'
import { generateBrief, DEFAULT_BRIEF_BUDGET } from './brief'
import { trackStaleness } from './staleness'
import { acquireLease, releaseLease, listLeases, DEFAULT_LEASE_TTL_SECONDS } from './leases'
import { planWorkOrders, updateWorkOrder, listWorkOrders } from './work-orders'

// Project root: explicit argv (set in .mcp.json) wins; fall back to the cwd the
// host launched us with. Never resolve relative to this file — the package may
// live anywhere (node_modules, another folder) while serving any project.
const ROOT = resolve(process.argv[2] ?? process.env.FRONTGRAPH_ROOT ?? process.cwd())

// ── Live project state ──
// The graph is recomputed on EVERY tool call so agents always see the current
// state of the codebase, including files they just edited mid-session. The
// parser's MD5 content cache makes this cheap: unchanged files are never
// re-read beyond hashing, so a warm reload is O(files) hashing, not O(files)
// parsing.

interface ProjectState {
  normalized: NormalizedConfig
  sourceRoots: string[]
  discoveredCategories: Map<string, string[]>
  observed: ObservedMethodologies
  nodes: GraphNode[]
  parseErrors: ParseError[]
  graph: Graph
  layers: string[][]
  cycles: CycleInfo[]
  architecture: InferredArchitecture
}

function loadState(): ProjectState {
  const config = loadConfig(ROOT)
  const normalized = normalizeConfig(config)

  const sourceRoots = normalized.project.sourceRoots.length > 0
    ? normalized.project.sourceRoots
    : discoverSourceRoots(ROOT)
  const discoveredCategories = discoverCategories(ROOT, sourceRoots)
  const observed = observeMethodologies(ROOT, sourceRoots)

  const { nodes, errors: parseErrors } = parseProjectWithErrors(ROOT)
  const graph = buildGraph(nodes)
  const layers = depthOrder(graph)
  const cycles = detectCycles(graph)
  const architecture = inferArchitecture(graph, layers)

  return { normalized, sourceRoots, discoveredCategories, observed, nodes, parseErrors, graph, layers, cycles, architecture }
}

function fmtObserved(s: ProjectState): string {
  const parts: string[] = []
  if (s.observed.cdd.observed) parts.push(`CDD (${s.observed.cdd.contractsPath})`)
  if (s.observed.tdd.observed) parts.push(`TDD (${s.observed.tdd.testsPath}${s.observed.tdd.framework ? ', ' + s.observed.tdd.framework : ''})`)
  if (s.observed.sdd.observed) parts.push(`SDD (${s.observed.sdd.specsPath})`)
  return parts.length > 0 ? parts.join(', ') : 'none observed'
}

function formatNode(s: ProjectState, n: GraphNode): string {
  const cat = n.category !== 'unknown' ? ` [${n.category}]` : ''
  let out = `${n.id}${cat}\n  ${n.summary}`
  if (n.doc) out += `\n  doc: ${n.doc}`
  if (n.spec) out += `\n  spec: ${n.spec}`
  if (n.dependencies.length > 0) out += `\n  deps: ${n.dependencies.join(', ')}`
  if (n.exports.length > 0) out += `\n  exports: ${n.exports.join(', ')}`
  return out
}

function hasUserArchitectureRules(s: ProjectState): boolean {
  const rules = s.normalized.architectureRules
  if (!rules || Object.keys(rules).length === 0) return false
  return Object.entries(rules).some(([k, v]) =>
    k !== 'no_circular_deps' || v === true)
}

function stripSourceExtension(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx|py)$/, '')
}

type ToolResult = { content: Array<{ type: 'text'; text: string }> }

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] }
}

/** Wrap a handler: load fresh state, catch errors uniformly. */
function withState<A extends unknown[]>(
  handler: (s: ProjectState, ...args: A) => string,
): (...args: A) => Promise<ToolResult> {
  return async (...args: A) => {
    try {
      const s = loadState()
      return text(handler(s, ...args))
    } catch (err) {
      return text(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// ── MCP Server ──
const server = new McpServer({
  name: 'frontgraph',
  version: '0.1.0',
})

// ── graph_observe ──
server.registerTool(
  'graph_observe',
  {
    description: 'Full observation report: discovered source roots, categories, methodologies, and inferred architecture. Shows what the framework sees in your project. Always reflects the current state of the files on disk.',
  },
  withState((s) => {
    const lines = ['=== Project Observation ===', '']

    lines.push(`Source roots: ${s.sourceRoots.join(', ')}`)
    lines.push('')

    lines.push(`Discovered categories (${s.discoveredCategories.size}):`)
    for (const [cat, files] of s.discoveredCategories) {
      const meta = s.normalized.categories_meta[cat]
      const desc = meta ? ` — ${meta.description}` : ''
      lines.push(`  ${cat}: ${files.length} file(s)${desc}`)
    }
    lines.push('')

    lines.push('Observed methodologies:')
    lines.push(`  CDD: ${s.observed.cdd.observed ? `YES (${s.observed.cdd.contractsPath}, ${s.observed.cdd.evidence.length} files)` : 'not observed'}`)
    if (s.observed.cdd.observed) {
      s.observed.cdd.evidence.slice(0, 10).forEach(f => lines.push(`    - ${f}`))
    }
    lines.push(`  TDD: ${s.observed.tdd.observed ? `YES (${s.observed.tdd.testsPath}, ${s.observed.tdd.evidence.length} files${s.observed.tdd.framework ? ', ' + s.observed.tdd.framework : ''})` : 'not observed'}`)
    if (s.observed.tdd.observed) {
      s.observed.tdd.evidence.slice(0, 10).forEach(f => lines.push(`    - ${f}`))
    }
    lines.push(`  SDD: ${s.observed.sdd.observed ? `YES (${s.observed.sdd.specsPath}, ${s.observed.sdd.evidence.length} files)` : 'not observed'}`)
    if (s.observed.sdd.observed) {
      s.observed.sdd.evidence.slice(0, 10).forEach(f => lines.push(`    - ${f}`))
    }
    lines.push('')

    lines.push(`Graph nodes: ${s.nodes.length}`)
    lines.push(`Parse warnings: ${s.parseErrors.length}`)
    lines.push(`Layers: ${s.layers.length}`)
    lines.push('')

    lines.push('Inferred architecture:')
    s.architecture.observedPatterns.forEach(p => lines.push(`  ${p}`))

    if (s.normalized._legacy) {
      lines.push('', 'Note: graph.config.json uses legacy format. Run "onboard --configure" to migrate.')
    }

    return lines.join('\n')
  }),
)

// ── graph_summary ──
server.registerTool(
  'graph_summary',
  {
    description: 'Get a complete project overview: discovered categories, observed methodologies, dependency layers, and inferred architecture. Always reflects the current state of the files on disk.',
  },
  withState((s) => {
    const lines = [
      '=== Project Summary ===',
      '',
      `Source roots: ${s.sourceRoots.join(', ')}`,
      `Active methodologies: ${fmtObserved(s)}`,
      `Total nodes: ${s.nodes.length}`,
      '',
      `Discovered categories (${s.discoveredCategories.size}):`,
    ]

    for (const [cat, files] of s.discoveredCategories) {
      lines.push(`  ${cat}: ${files.map(f => f.replace(/\\/g, '/')).join(', ')}`)
    }

    lines.push('', `Dependency layers (${s.layers.length}):`)
    s.layers.forEach((layer, i) => lines.push(`  Layer ${i}: ${layer.join(', ')}`))

    lines.push('', 'Architecture rules:')
    for (const [k, v] of Object.entries(s.normalized.architectureRules)) {
      lines.push(`  ${k}: ${v ? 'enabled' : 'disabled'}`)
    }
    if (Object.keys(s.normalized.architectureRules).length === 0) {
      lines.push('  (no user-defined rules)')
    }

    if (s.architecture.observedPatterns.length > 0) {
      lines.push('', 'Inferred architecture:')
      s.architecture.observedPatterns.forEach(p => lines.push(`  ${p}`))
    }

    if (s.cycles.length > 0) {
      lines.push('', 'Circular dependencies:')
      s.cycles.forEach(c => lines.push(`  ${c.path.join(' → ')}`))
    }

    if (s.parseErrors.length > 0) {
      lines.push('', `Parse warnings: ${s.parseErrors.length}`)
      s.parseErrors.slice(0, 10).forEach(e => lines.push(`  ! ${e.filePath}: ${e.message}`))
    }

    if (s.normalized._legacy) {
      lines.push('', 'Note: legacy config format. Run onboard --configure to migrate.')
    }

    return lines.join('\n')
  }),
)

// ── graph_deps ──
server.registerTool(
  'graph_deps',
  {
    description: 'Get the direct dependencies of a node. Shows what this file imports and depends on.',
    inputSchema: { id: z.string().describe('The node ID (e.g. src/logic/pricing)') },
  },
  withState((s, { id }: { id: string }) => {
    if (!s.graph.nodes.has(id)) {
      const similar = search(s.graph, id).slice(0, 5)
      const hint = similar.length > 0
        ? `\n\nDid you mean one of these?\n${similar.map(n => `  - ${n.id}`).join('\n')}`
        : ''
      return `Node "${id}" not found in graph.${hint}`
    }

    const deps = getDeps(s.graph, id)
    if (deps.length === 0) {
      return `"${id}" has no internal dependencies.`
    }
    return `Dependencies of ${id}:\n\n` + deps.map(n => formatNode(s, n)).join('\n\n')
  }),
)

// ── graph_dependents ──
server.registerTool(
  'graph_dependents',
  {
    description: 'Get all nodes that depend on a given node. Shows the impact of changing this file.',
    inputSchema: { id: z.string().describe('The node ID (e.g. src/types/orders)') },
  },
  withState((s, { id }: { id: string }) => {
    if (!s.graph.nodes.has(id)) {
      const similar = search(s.graph, id).slice(0, 5)
      const hint = similar.length > 0
        ? `\n\nDid you mean one of these?\n${similar.map(n => `  - ${n.id}`).join('\n')}`
        : ''
      return `Node "${id}" not found in graph.${hint}`
    }

    const deps = getDependents(s.graph, id)
    if (deps.length === 0) {
      return `Nothing depends on "${id}". Safe to change.`
    }
    return `Nodes depending on ${id} (${deps.length}):\n\n` + deps.map(n => formatNode(s, n)).join('\n\n')
  }),
)

// ── graph_impact ──
server.registerTool(
  'graph_impact',
  {
    description: 'Recursively compute the full impact chain: if you change this node, everything that could be affected, directly and transitively.',
    inputSchema: { id: z.string().describe('The node ID to analyze impact for') },
  },
  withState((s, { id }: { id: string }) => {
    if (!s.graph.nodes.has(id)) {
      return `Node "${id}" not found in graph.`
    }

    const allAffected = new Set<string>()
    const queue = [id]

    while (queue.length > 0) {
      const current = queue.shift()!
      const deps = getDependents(s.graph, current)
      for (const d of deps) {
        if (!allAffected.has(d.id)) {
          allAffected.add(d.id)
          queue.push(d.id)
        }
      }
    }

    if (allAffected.size === 0) {
      return `No impact: nothing depends on "${id}".`
    }

    const affectedByLayer = new Map<number, string[]>()
    for (const nid of allAffected) {
      let layerIdx = -1
      for (let i = 0; i < s.layers.length; i++) {
        if (s.layers[i].includes(nid)) { layerIdx = i; break }
      }
      const list = affectedByLayer.get(layerIdx) ?? []
      list.push(nid)
      affectedByLayer.set(layerIdx, list)
    }

    const sortedLayers = [...affectedByLayer.entries()].sort(([a], [b]) => a - b)

    return `Impact analysis for: ${id}\n` +
      `Affected nodes: ${allAffected.size}\n\n` +
      sortedLayers.map(([layer, nids]) =>
        `Layer ${layer}:\n` +
        nids.map(nid => {
          const n = s.graph.nodes.get(nid)!
          return `  ${nid} [${n.category}] (${n.filePath}) — ${n.summary}`
        }).join('\n')
      ).join('\n\n')
  }),
)

// ── graph_search ──
server.registerTool(
  'graph_search',
  {
    description: 'Search for nodes matching a keyword in their id, summary, or exports. Returns scored results.',
    inputSchema: { query: z.string().describe('Keyword or phrase to search for') },
  },
  withState((s, { query }: { query: string }) => {
    const results = search(s.graph, query)
    if (results.length === 0) {
      return `No matches for "${query}".`
    }
    return `Search results for "${query}" (${results.length}):\n\n` +
      results.map(n => {
        let out = formatNode(s, n)
        const deps = getDependents(s.graph, n.id)
        if (deps.length > 0) out += `\n  also affects: ${deps.map(d => d.id).join(', ')}`
        return out
      }).join('\n\n')
  }),
)

// ── workflow_generate ──
server.registerTool(
  'workflow_generate',
  {
    description: 'Generate the implementation workflow for a task, based on observed methodologies. Adapts to what actually exists in the project.',
    inputSchema: { task: z.string().describe('Name of the feature/task to plan') },
  },
  withState((s, { task }: { task: string }) => {
    const slug = task.toLowerCase().replace(/\s+/g, '-')
    const steps: string[] = []
    let n = 1

    if (s.observed.sdd.observed) {
      const path = `${s.observed.sdd.specsPath ?? 'Docs/specs'}/${slug}.spec.md`
      steps.push(`${n}. Write specification (SDD — observed)\n   → ${path}`)
      n++
    }

    if (s.observed.cdd.observed) {
      const path = `${s.observed.cdd.contractsPath ?? 'src/types'}/${slug}.ts`
      steps.push(`${n}. Define contract — types/interfaces (CDD — observed)\n   → ${path}`)
      n++
    }

    if (s.observed.tdd.observed) {
      const path = `${s.observed.tdd.testsPath ?? 'src/__tests__'}/${slug}.test.ts`
      steps.push(`${n}. Write tests (TDD — observed)\n   → ${path}`)
      n++
    }

    const logicCat = s.discoveredCategories.has('logic') ? 'logic'
      : s.discoveredCategories.has('services') ? 'services'
      : [...s.discoveredCategories.keys()][0] ?? 'src'
    const implPath = s.discoveredCategories.has(logicCat)
      ? `${s.sourceRoots[0]}/${logicCat}/${slug}.ts`
      : `src/${slug}.ts`
    steps.push(`${n}. Implement logic\n   → ${implPath}`)
    n++
    steps.push(`${n}. Write AI documentation\n   → Docs/${stripSourceExtension(implPath)}.md`)
    n++
    steps.push(`${n}. Add @graph blocks to all new files`)

    const stateLines: string[] = []
    for (const step of steps) {
      const pathMatch = step.match(/→\s+(.+)/)
      if (!pathMatch) continue
      const exists = existsSync(resolve(ROOT, pathMatch[1]))
      stateLines.push(`  ${exists ? '✓' : '✗'} ${pathMatch[1]} ${exists ? '(exists)' : '(needs creation)'}`)
    }

    return `Workflow: "${task}"\n` +
      `Methodologies observed: ${fmtObserved(s)}\n\n` +
      `Steps:\n${steps.join('\n')}\n\n` +
      `Current state:\n${stateLines.join('\n')}`
  }),
)

// ── gate_check ──
server.registerTool(
  'gate_check',
  {
    description: 'Pre-implementation gate check. Verifies that required artifacts (spec, contract, test) exist before implementing a feature. Uses observed methodology paths.',
    inputSchema: { feature: z.string().describe('Name of the feature to check') },
  },
  withState((s, { feature }: { feature: string }) => {
    const slug = feature.toLowerCase().replace(/\s+/g, '-')
    const checks: string[] = []
    let blocked = false

    if (s.observed.sdd.observed) {
      const path = `${s.observed.sdd.specsPath ?? 'Docs/specs'}/${slug}.spec.md`
      const exists = existsSync(resolve(ROOT, path))
      checks.push(`  ${exists ? '✓' : '✗'} SDD: ${path} ← ${exists ? 'found' : 'BLOCKED'}`)
      if (!exists) blocked = true
    }

    if (s.observed.cdd.observed) {
      const path = `${s.observed.cdd.contractsPath ?? 'src/types'}/${slug}.ts`
      const exists = existsSync(resolve(ROOT, path))
      checks.push(`  ${exists ? '✓' : '✗'} CDD: ${path} ← ${exists ? 'found' : 'BLOCKED'}`)
      if (!exists) blocked = true
    }

    if (s.observed.tdd.observed) {
      const path = `${s.observed.tdd.testsPath ?? 'src/__tests__'}/${slug}.test.ts`
      const exists = existsSync(resolve(ROOT, path))
      checks.push(`  ${exists ? '✓' : '✗'} TDD: ${path} ← ${exists ? 'found' : 'BLOCKED'}`)
      if (!exists) blocked = true
    }

    return `Gate check: "${feature}"\n\n` +
      (checks.length === 0
        ? '  No methodologies observed. Gate is always open.'
        : checks.join('\n')) +
      `\n\nResult: ${blocked ? 'BLOCKED — create missing artifacts first' : 'READY — all gates passed'}`
  }),
)

// ── graph_validate ──
server.registerTool(
  'graph_validate',
  {
    description: 'Validate the entire graph: checks for broken references, missing docs, parse errors, circular dependencies, drift between declared @graph blocks and the truth derived from code, semantic staleness suspects (summaries the code outgrew), and user-defined architecture rule violations. Always re-parses, so it reflects edits made during this session.',
  },
  withState((s) => {
    const issues = validateReferences(s.graph, (relPath) => existsSync(resolve(ROOT, relPath)))
    const drift = detectDrift(s.nodes)
    const strictDrift = s.normalized.architectureRules.strict_drift === true

    // Architecture rules — only enforce if user-defined
    if (hasUserArchitectureRules(s)) {
      for (const n of s.nodes) {
        if (s.normalized.architectureRules.no_ui_in_logic_deps && n.category === 'logic') {
          const uiDeps = n.dependencies.filter(d => s.graph.nodes.get(d)?.category === 'ui')
          for (const d of uiDeps) {
            issues.push(`${n.id}: logic depends on ui '${d}' (arch rule: no_ui_in_logic_deps)`)
          }
        }
        if (s.normalized.architectureRules.contract_at_layer_zero && n.category === 'contract') {
          const internalDeps = n.dependencies.filter(d => s.graph.nodes.has(d))
          for (const d of internalDeps) {
            issues.push(`${n.id}: contract depends on '${d}' (arch rule: contract_at_layer_zero)`)
          }
        }
        if (s.normalized.architectureRules.enforce_doc_for_all_nodes && !n.doc) {
          issues.push(`${n.id}: missing documentation (arch rule: enforce_doc_for_all_nodes)`)
        }
      }
    }

    const hasCyclesIssue = s.normalized.architectureRules.no_circular_deps !== false && s.cycles.length > 0

    const lines = ['=== Graph Validation ===', '']

    // Parse
    if (s.parseErrors.length > 0) {
      lines.push(`Parse warnings (${s.parseErrors.length}):`)
      s.parseErrors.forEach(e => lines.push(`  ! ${e.filePath}: ${e.message}`))
      lines.push('')
    } else {
      lines.push('Parse: OK')
      lines.push('')
    }

    // References
    const refIssues = issues.filter(i => i.includes('not found in graph'))
    const docIssues = issues.filter(i => i.includes('doc path'))
    const archIssues = issues.filter(i => i.includes('arch rule'))

    lines.push(`Reference checks: ${refIssues.length === 0 ? 'OK' : refIssues.length + ' issue(s)'}`)
    refIssues.forEach(i => lines.push(`  ✗ ${i}`))
    lines.push('')

    lines.push(`Documentation checks: ${docIssues.length === 0 ? 'OK' : docIssues.length + ' issue(s)'}`)
    docIssues.forEach(i => lines.push(`  ✗ ${i}`))
    lines.push('')

    if (hasUserArchitectureRules(s)) {
      lines.push(`Architecture rules (user-defined): ${archIssues.length === 0 ? 'OK' : archIssues.length + ' violation(s)'}`)
      archIssues.forEach(i => lines.push(`  ✗ ${i}`))
    } else {
      lines.push('Architecture rules: no user-defined rules — nothing to enforce')
    }
    lines.push('')

    // Cycles
    if (hasCyclesIssue) {
      lines.push(`Circular dependencies (arch rule violation): ${s.cycles.length} cycle(s)`)
      s.cycles.forEach(c => lines.push(`  ✗ ${c.path.join(' → ')}`))
    } else if (s.cycles.length > 0) {
      lines.push(`Circular dependencies: ${s.cycles.length} cycle(s) (rule disabled)`)
      s.cycles.forEach(c => lines.push(`  ⚠ ${c.path.join(' → ')}`))
    } else {
      lines.push('Circular dependencies: none')
    }
    lines.push('')

    // Drift (SPEC §7)
    if (drift.length > 0) {
      lines.push(`Drift between declared blocks and derived truth (${drift.length})${strictDrift ? ' — strict_drift enabled, failing' : ''}:`)
      drift.forEach(d => lines.push(`  ${strictDrift ? '✗' : '⚠'} ${d.nodeId}: ${d.detail} [${d.kind}]`))
      lines.push('  → use the graph_sync tool to rewrite blocks with the derived truth')
    } else {
      lines.push('Drift: none — declared blocks match the code')
    }
    lines.push('')

    // Semantic staleness — informational, never counts toward the total
    const staleness = trackStaleness(ROOT, s.nodes)
    if (staleness.length > 0) {
      lines.push(`Summary staleness suspects (${staleness.length}) — informational:`)
      staleness.forEach(st => lines.push(`  ? ${st.nodeIds.join(', ')}: ${st.reason}`))
      lines.push('  → the code moved since these blocks were written; review the summaries')
      lines.push('')
    }

    const totalIssues = issues.length + s.parseErrors.length +
      (hasCyclesIssue ? s.cycles.length : 0) + (strictDrift ? drift.length : 0)
    lines.push(`Total: ${totalIssues === 0 ? 'All checks passed' : totalIssues + ' issue(s) found'}`)

    return lines.join('\n')
  }),
)

// ── graph_sync ──
server.registerTool(
  'graph_sync',
  {
    description: 'Rewrite the declared dependencies/exports of file-level @graph blocks to match the truth derived from the code (imports and exports). Fixes any drift reported by graph_validate. Anchored files and semantic fields (summary, category, doc) are never touched.',
  },
  withState(() => {
    const result = syncGraphBlocks(ROOT)
    const lines = ['=== Graph Sync ===', '']

    if (result.updated.length > 0) {
      lines.push(`Updated (${result.updated.length}):`)
      result.updated.forEach(f => lines.push(`  ~ ${f}`))
    } else {
      lines.push('No blocks needed updating — declared and derived truth agree.')
    }

    if (result.skippedAnchored.length > 0) {
      lines.push('', `Skipped anchored files (${result.skippedAnchored.length}):`)
      result.skippedAnchored.forEach(f => lines.push(`  - ${f}`))
    }

    lines.push('', `${result.unchanged.length} file(s) already in sync.`)
    return lines.join('\n')
  }),
)

// ── graph_brief ──
server.registerTool(
  'graph_brief',
  {
    description: 'Token-budgeted architectural briefing for an agent arriving cold at this repository: identity, dependency flow, health (drift, cycles, stale summaries), and the most-connected nodes with their summaries. Call this FIRST when starting work on an unfamiliar codebase, then drill down with graph_search / graph_deps.',
    inputSchema: {
      budget_tokens: z.number().int().min(200).max(32000).optional()
        .describe(`Approximate token budget for the brief (default ${DEFAULT_BRIEF_BUDGET})`),
    },
  },
  withState((_s, { budget_tokens }: { budget_tokens?: number }) =>
    generateBrief(ROOT, budget_tokens ?? DEFAULT_BRIEF_BUDGET)),
)

// ── graph_claim ──
server.registerTool(
  'graph_claim',
  {
    description: 'Claim exclusive intent over graph nodes before editing them, so concurrent agents do not collide. Use scope "impact" when changing a contract — it claims the nodes plus everything that depends on them. Returns the lease, or the conflicting leases if another agent already holds any of the nodes. Leases expire automatically (TTL), so a crashed agent cannot block the graph forever. Always release when done.',
    inputSchema: {
      node_ids: z.array(z.string()).min(1).describe('Node ids to claim (e.g. ["src/types/orders"])'),
      holder: z.string().min(1).describe('Your agent name — used to identify and release your leases'),
      intent: z.string().min(1).describe('One line: what you are about to do with these nodes'),
      ttl_seconds: z.number().int().min(10).max(86400).optional()
        .describe(`Lease lifetime in seconds (default ${DEFAULT_LEASE_TTL_SECONDS})`),
      scope: z.enum(['nodes', 'impact']).optional()
        .describe('"nodes" = exactly these ids; "impact" = these ids plus all transitive dependents'),
    },
  },
  withState((s, args: { node_ids: string[]; holder: string; intent: string; ttl_seconds?: number; scope?: 'nodes' | 'impact' }) => {
    const unknown = args.node_ids.filter(id => !s.graph.nodes.has(id))
    if (unknown.length > 0) {
      return `Unknown node id(s): ${unknown.join(', ')} — use graph_search to find the right ids.`
    }
    const outcome = acquireLease(ROOT, s.nodes, {
      holder: args.holder,
      nodeIds: args.node_ids,
      intent: args.intent,
      ttlSeconds: args.ttl_seconds,
      scope: args.scope,
    })
    if (outcome.ok) {
      const l = outcome.lease
      return [
        `Lease ${l.id} GRANTED to '${l.holder}' until ${l.expiresAt} (scope: ${l.scope})`,
        `Claimed nodes (${l.nodeIds.length}):`,
        ...l.nodeIds.map(id => `  ⛔ ${id}`),
        '',
        `Release with graph_release when done (holder: '${l.holder}').`,
      ].join('\n')
    }
    return [
      `Claim REJECTED — ${outcome.conflicts.length} active lease(s) overlap your request:`,
      ...outcome.conflicts.map(c =>
        `  ✗ ${c.leaseId} held by '${c.holder}' — overlap: ${c.overlapping.join(', ')} — intent: ${c.intent} — expires ${c.expiresAt}`),
      '',
      'Wait for expiry, coordinate with the holder, or claim a disjoint set of nodes.',
    ].join('\n')
  }),
)

// ── graph_release ──
server.registerTool(
  'graph_release',
  {
    description: 'Release leases you acquired with graph_claim — all of them, or one specific lease id. Call this when your edits are done and validated.',
    inputSchema: {
      holder: z.string().min(1).describe('The agent name used when claiming'),
      lease_id: z.string().optional().describe('Release only this lease (default: all of the holder\'s leases)'),
    },
  },
  withState((_s, { holder, lease_id }: { holder: string; lease_id?: string }) => {
    const released = releaseLease(ROOT, { holder, leaseId: lease_id })
    if (released.length === 0) {
      return `No active leases held by '${holder}'${lease_id ? ` with id ${lease_id}` : ''}.`
    }
    return `Released ${released.length} lease(s):\n` +
      released.map(l => `  ✓ ${l.id} — ${l.nodeIds.length} node(s) freed`).join('\n')
  }),
)

// ── graph_leases ──
server.registerTool(
  'graph_leases',
  {
    description: 'List all active leases: who is working where, with what intent, until when. Check this before claiming or editing shared areas of the graph.',
  },
  withState(() => {
    const leases = listLeases(ROOT)
    if (leases.length === 0) return 'No active leases — the whole graph is unclaimed.'
    return [
      `Active leases (${leases.length}):`,
      '',
      ...leases.flatMap(l => [
        `${l.id} — '${l.holder}' (scope: ${l.scope}), expires ${l.expiresAt}`,
        `  intent: ${l.intent}`,
        `  nodes: ${l.nodeIds.join(', ')}`,
      ]),
    ].join('\n')
  }),
)

// ── graph_plan ──
server.registerTool(
  'graph_plan',
  {
    description: 'Generate a work-order DAG for a contract change: one order for the change itself plus one per transitively affected dependent, wired bottom-up — an order only unblocks when everything it imports from the affected set is adapted. This is how a swarm of agents divides a breaking change safely.',
    inputSchema: {
      id: z.string().describe('The node whose contract is changing (e.g. src/types/orders)'),
      change: z.string().min(1).describe('One line describing the change (e.g. "rename Money to Currency")'),
    },
  },
  withState((s, { id, change }: { id: string; change: string }) => {
    const plan = planWorkOrders(ROOT, s.nodes, id, change)
    if (!plan) return `Node "${id}" not found in graph.`
    return [
      `Plan ${plan.planId} — ${plan.orders.length} work order(s) for: ${change}`,
      '',
      ...plan.orders.map(o => {
        const gate = o.blockedBy.length > 0 ? `blocked by ${o.blockedBy.join(', ')}` : 'READY'
        return `${o.id} → ${o.nodeId} [${gate}]\n  ${o.action}`
      }),
      '',
      'Claim each node with graph_claim before working its order; advance with work_order_update.',
    ].join('\n')
  }),
)

// ── graph_work_orders ──
server.registerTool(
  'graph_work_orders',
  {
    description: 'List work orders with their status and readiness (ready = pending with all blockers done). Optionally filter by plan id.',
    inputSchema: {
      plan_id: z.string().optional().describe('Only orders from this plan (e.g. P1)'),
    },
  },
  withState((_s, { plan_id }: { plan_id?: string }) => {
    const orders = listWorkOrders(ROOT, plan_id)
    if (orders.length === 0) {
      return `No work orders${plan_id ? ` in plan ${plan_id}` : ''}. Create a plan with graph_plan.`
    }
    return [
      `Work orders${plan_id ? ` — plan ${plan_id}` : ''} (${orders.length}):`,
      '',
      ...orders.map(o => {
        const state = o.status === 'pending' && o.ready ? 'READY' : o.status
        const gate = o.blockedBy.length > 0 ? ` (after ${o.blockedBy.join(', ')})` : ''
        return `${o.status === 'done' ? '✓' : o.ready ? '▶' : '·'} ${o.id} [${o.planId}] ${o.nodeId} — ${state}${gate}`
      }),
    ].join('\n')
  }),
)

// ── work_order_update ──
server.registerTool(
  'work_order_update',
  {
    description: 'Advance a work order: in_progress when you start, done when finished and validated. Gated by the DAG — you cannot start an order whose upstream orders are not done; the tool tells you what is missing.',
    inputSchema: {
      order_id: z.string().describe('The work order id (e.g. WO3)'),
      status: z.enum(['pending', 'in_progress', 'done']).describe('New status'),
    },
  },
  withState((_s, { order_id, status }: { order_id: string; status: 'pending' | 'in_progress' | 'done' }) => {
    const outcome = updateWorkOrder(ROOT, order_id, status)
    if (outcome.ok) {
      return `${order_id} → ${outcome.order.status} (${outcome.order.nodeId})`
    }
    return [
      `✗ ${outcome.reason}`,
      ...(outcome.blockedBy ?? []).map(o => `  blocked by ${o.id} (${o.nodeId}) — ${o.status}`),
    ].join('\n')
  }),
)

// ── graph_architecture ──
server.registerTool(
  'graph_architecture',
  {
    description: 'Show inferred architecture: layer composition, category dependency matrix, natural dependency flow, observed patterns, and user-defined rules if any.',
  },
  withState((s) => {
    const lines = ['=== Inferred Architecture ===', '']

    lines.push('Observed patterns:')
    s.architecture.observedPatterns.forEach(p => lines.push(`  ${p}`))

    const layerCats = analyzeLayers(s.graph, s.layers)
    lines.push('', 'Layer composition:')
    for (const [layer, cats] of layerCats) {
      lines.push(`  Layer ${layer}: ${cats.join(', ')}`)
    }

    lines.push('', 'Category dependency matrix:')
    for (const [fromCat, targets] of Object.entries(s.architecture.categoryDependencyMatrix)) {
      const entries = Object.entries(targets).sort(([, a], [, b]) => b - a)
      if (entries.length === 0) {
        lines.push(`  ${fromCat} → (none)`)
      } else {
        lines.push(`  ${fromCat} → ${entries.map(([cat, n]) => `${cat}:${n}`).join('  ')}`)
      }
    }

    if (s.architecture.naturalFlow.length > 1) {
      lines.push('', `Natural dependency flow: ${s.architecture.naturalFlow.join(' → ')}`)
    }

    // Categories detail
    lines.push('', 'Categories:')
    for (const [name] of s.discoveredCategories) {
      const meta = s.normalized.categories_meta[name]
      const count = s.nodes.filter(n => n.category === name).length
      lines.push(`  ${name}: ${meta ? meta.description : 'auto-discovered'} (${count} nodes)`)
    }

    // Methodologies
    lines.push('', 'Observed methodologies:')
    lines.push(`  CDD: ${s.observed.cdd.observed ? `YES (${s.observed.cdd.contractsPath})` : 'not observed'}`)
    lines.push(`  TDD: ${s.observed.tdd.observed ? `YES (${s.observed.tdd.testsPath}${s.observed.tdd.framework ? ', ' + s.observed.tdd.framework : ''})` : 'not observed'}`)
    lines.push(`  SDD: ${s.observed.sdd.observed ? `YES (${s.observed.sdd.specsPath})` : 'not observed'}`)

    // User-defined rules
    if (Object.keys(s.normalized.architectureRules).length > 0) {
      lines.push('', 'User-defined architecture rules:')
      for (const [k, v] of Object.entries(s.normalized.architectureRules)) {
        lines.push(`  ${k}: ${v}`)
      }
    } else {
      lines.push('', 'No user-defined architecture rules.')
    }

    // Violations against user rules
    if (hasUserArchitectureRules(s)) {
      lines.push('', 'Current violations:')
      let violations = 0
      for (const n of s.nodes) {
        if (s.normalized.architectureRules.no_ui_in_logic_deps && n.category === 'logic') {
          const uiDeps = n.dependencies.filter(d => s.graph.nodes.get(d)?.category === 'ui')
          for (const d of uiDeps) {
            lines.push(`  ✗ ${n.id} → ${d} (logic depends on ui)`)
            violations++
          }
        }
        if (s.normalized.architectureRules.contract_at_layer_zero && n.category === 'contract') {
          const internalDeps = n.dependencies.filter(d => s.graph.nodes.has(d))
          for (const d of internalDeps) {
            lines.push(`  ✗ ${n.id} → ${d} (contract has internal dep)`)
            violations++
          }
        }
        if (s.normalized.architectureRules.enforce_doc_for_all_nodes && !n.doc) {
          lines.push(`  ✗ ${n.id} (missing documentation)`)
          violations++
        }
      }
      if (violations === 0) lines.push('  (none)')
    }

    return lines.join('\n')
  }),
)

// ── graph_config ──
server.registerTool(
  'graph_config',
  {
    description: 'Show the current graph.config.json contents alongside discovered observations.',
  },
  withState((s) => {
    const lines = ['=== Graph Configuration ===', '']

    lines.push('Discovered (from disk):')
    lines.push(`  Project root: ${ROOT}`)
    lines.push(`  Source roots: ${s.sourceRoots.join(', ')}`)
    lines.push(`  Categories: ${[...s.discoveredCategories.keys()].join(', ')}`)
    lines.push(`  Methodologies: ${fmtObserved(s)}`)
    lines.push('')

    lines.push('Configured (from graph.config.json):')
    if (Object.keys(s.normalized.categories_meta).length > 0) {
      lines.push('  Categories metadata:')
      for (const [name, meta] of Object.entries(s.normalized.categories_meta)) {
        lines.push(`    ${name}: ${meta.description} (${meta.color})`)
      }
    } else {
      lines.push('  Categories metadata: (none — using auto-discovered)')
    }

    if (Object.keys(s.normalized.methodologies_meta).length > 0) {
      lines.push('  Methodologies overrides:')
      for (const [name, m] of Object.entries(s.normalized.methodologies_meta)) {
        const parts: string[] = []
        if (m.contractsPath) parts.push(`contractsPath: ${m.contractsPath}`)
        if (m.testsPath) parts.push(`testsPath: ${m.testsPath}`)
        if (m.specsPath) parts.push(`specsPath: ${m.specsPath}`)
        if (m.framework) parts.push(`framework: ${m.framework}`)
        lines.push(`    ${name}: ${parts.join(', ')}`)
      }
    } else {
      lines.push('  Methodologies overrides: (none)')
    }

    lines.push('  Architecture rules:')
    if (Object.keys(s.normalized.architectureRules).length > 0) {
      for (const [k, v] of Object.entries(s.normalized.architectureRules)) {
        lines.push(`    ${k}: ${v}`)
      }
    } else {
      lines.push('    (none)')
    }

    if (s.normalized._legacy) {
      lines.push('', 'Note: Legacy config format. Run onboard --configure to migrate.')
    } else {
      lines.push('', 'Format: current (observation-driven)')
    }

    return lines.join('\n')
  }),
)

// ── Bootstrap ──
const transport = new StdioServerTransport()
await server.connect(transport)
