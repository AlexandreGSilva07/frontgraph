import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { buildGraph, depthOrder, getDependents, getDeps, search, validateReferences, detectCycles, inferArchitecture, analyzeLayers } from './graph'
import { loadConfig, normalizeConfig, parseProjectWithErrors, invalidateCache, discoverSourceRoots, discoverCategories, observeMethodologies, type GraphNode, type ObservedMethodologies, type NormalizedConfig } from './parser'
import { scaffoldProject, retrofitProject, createSpecStubs, moveGraphNode } from './onboard'
import { detectDrift } from './derive'
import { syncGraphBlocks } from './sync'
import { generateBrief, DEFAULT_BRIEF_BUDGET } from './brief'
import { trackStaleness } from './staleness'
import { acquireLease, releaseLease, listLeases, DEFAULT_LEASE_TTL_SECONDS } from './leases'
import { planWorkOrders, updateWorkOrder, listWorkOrders } from './work-orders'

// The CLI operates on the project it is invoked from, not on the package's own
// directory. FRONTGRAPH_ROOT overrides for tooling that runs from elsewhere.
const ROOT = resolve(process.env.FRONTGRAPH_ROOT ?? process.cwd())
const config = loadConfig(ROOT)
const normalized = normalizeConfig(config)
const { nodes, errors: parseErrors } = parseProjectWithErrors(ROOT)
const graph = buildGraph(nodes)
const cycles = detectCycles(graph)
const layers = depthOrder(graph)
const architecture = inferArchitecture(graph, layers)
const drift = detectDrift(nodes)

const sourceRoots = normalized.project.sourceRoots.length > 0
  ? normalized.project.sourceRoots
  : discoverSourceRoots(ROOT)
const discoveredCategories = discoverCategories(ROOT, sourceRoots)
const observed: ObservedMethodologies = observeMethodologies(ROOT, sourceRoots)

const command = process.argv[2]
const arg = process.argv[3]
const arg2 = process.argv[4]
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py']

function hasSourceExtension(fileName: string): boolean {
  return SOURCE_EXTENSIONS.some(ext => fileName.endsWith(ext))
}

function stripSourceExtension(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx|py)$/, '')
}

function fmtObserved(): string {
  const parts: string[] = []
  if (observed.cdd.observed) parts.push(`CDD (${observed.cdd.evidence.length} files in ${observed.cdd.contractsPath})`)
  if (observed.tdd.observed) parts.push(`TDD (${observed.tdd.evidence.length} tests${observed.tdd.framework ? ', ' + observed.tdd.framework : ''})`)
  if (observed.sdd.observed) parts.push(`SDD (${observed.sdd.evidence.length} specs)`)
  return parts.length > 0 ? parts.join(', ') : 'none observed'
}

function printNode(n: GraphNode, showCategory = true) {
  const cat = showCategory && n.category !== 'unknown'
    ? ` [${n.category}]`
    : ''
  console.log(`  ${n.id}${cat}`)
  console.log(`    ${n.summary}`)
  if (n.doc) console.log(`    doc: ${n.doc}`)
  if (n.spec) console.log(`    spec: ${n.spec}`)
}

// ── graph ──
function cmdGraph() {
  if (arg === '--tree') {
    function printTree(id: string, indent: string, visited: Set<string>) {
      if (visited.has(id)) { console.log(`${indent}  (cycle)`); return }
      visited.add(id)
      const deps = getDeps(graph, id)
      for (let i = 0; i < deps.length; i++) {
        const prefix = indent + (i === deps.length - 1 ? '  └── ' : '  ├── ')
        console.log(`${indent}${prefix}${deps[i].id} [${deps[i].category}]`)
        printTree(deps[i].id, indent + (i === deps.length - 1 ? '  ' : '  │  '), new Set(visited))
      }
    }
    const roots = layers[0]
    for (const root of roots) {
      console.log(`${root} [${graph.nodes.get(root)!.category}]`)
      printTree(root, '', new Set())
    }
  } else {
    console.log('\nDependency layers:\n')
    layers.forEach((layer, i) => {
      const labels = layer.map(id => {
        const n = graph.nodes.get(id)!
        return `${n.id} [${n.category}]`
      })
      console.log(`Layer ${i}: ${labels.join(', ')}`)
    })
  }

  if (cycles.length > 0) {
    console.log(`\nCircular dependencies (${cycles.length}):`)
    cycles.forEach(c => console.log(`  ${c.path.join(' → ')}`))
  }
}

// ── deps / dependents ──
function cmdDeps() {
  if (!arg) { console.log('Usage: deps <node-id>'); return }
  console.log(`\nDependencies of ${arg}:\n`)
  const deps = getDeps(graph, arg)
  if (deps.length === 0) console.log('  (none)')
  else deps.forEach(n => printNode(n))
}

function cmdDependents() {
  if (!arg) { console.log('Usage: dependents <node-id>'); return }
  console.log(`\nNodes that depend on ${arg}:\n`)
  const deps = getDependents(graph, arg)
  if (deps.length === 0) console.log('  (none)')
  else deps.forEach(n => printNode(n))
}

// ── summary ──
function cmdSummary() {
  console.log('\n=== Project Graph Summary ===\n')

  // Source roots
  console.log(`Source roots: ${sourceRoots.join(', ')}`)

  // Discovered categories
  console.log(`\nDiscovered categories (${discoveredCategories.size}):`)
  for (const [cat, files] of discoveredCategories) {
    const meta = normalized.categories_meta[cat]
    const desc = meta ? ` — ${meta.description}` : ''
    console.log(`  ${cat}: ${files.length} file(s)${desc}`)
  }

  // Observed methodologies
  console.log(`\nObserved methodologies: ${fmtObserved()}`)

  // Node count
  console.log(`\nTotal nodes: ${nodes.length}`)

  // Layers
  console.log(`\nDependency layers (${layers.length}):`)
  layers.forEach((layer, i) => {
    console.log(`  Layer ${i}: ${layer.join(', ')}`)
  })

  // Inferred architecture
  console.log('\nInferred architecture:')
  architecture.observedPatterns.forEach(p => console.log(`  ${p}`))

  // Gaps
  const missingDocs = nodes.filter(n => !n.doc)
  if (missingDocs.length > 0) {
    console.log(`\nMissing docs: ${missingDocs.length} node(s)`)
    missingDocs.forEach(n => console.log(`  ${n.id}`))
  }

  // Parse warnings
  if (parseErrors.length > 0) {
    console.log(`\nParse warnings: ${parseErrors.length}`)
    parseErrors.forEach(e => console.log(`  ! ${e.filePath}: ${e.message}`))
  }

  if (drift.length > 0) {
    console.log(`\nDrift: ${drift.length} divergence(s) between @graph blocks and code (run 'validate' for details, 'sync' to fix)`)
  }

  if (cycles.length > 0) {
    console.log(`\nCircular dependencies: ${cycles.length}`)
    cycles.forEach(c => console.log(`  ${c.path.join(' → ')}`))
  }

  if (normalized._legacy) {
    console.log('\nNote: graph.config.json uses legacy format. Run "onboard --configure" to migrate.')
  }
}

// ── validate ──
function cmdValidate() {
  console.log('\nValidating @graph blocks...\n')
  const issues = validateReferences(graph, (relPath) => existsSync(resolve(ROOT, relPath)))

  // Architecture rules — only enforce if user-defined rules exist
  const hasUserRules = normalized.architectureRules &&
    Object.keys(normalized.architectureRules).some(k =>
      k !== 'no_circular_deps' || (normalized.architectureRules[k] === true))

  if (hasUserRules) {
    for (const n of nodes) {
      if (normalized.architectureRules.no_ui_in_logic_deps && n.category === 'logic') {
        const uiDeps = n.dependencies.filter(d => graph.nodes.get(d)?.category === 'ui')
        for (const d of uiDeps) issues.push(`${n.id}: logic depends on ui '${d}' (arch rule: no_ui_in_logic_deps)`)
      }
      if (normalized.architectureRules.contract_at_layer_zero && n.category === 'contract') {
        const internalDeps = n.dependencies.filter(d => graph.nodes.has(d))
        for (const d of internalDeps) issues.push(`${n.id}: contract depends on '${d}' (arch rule: contract_at_layer_zero)`)
      }
      if (normalized.architectureRules.enforce_doc_for_all_nodes && !n.doc) {
        issues.push(`${n.id}: missing documentation`)
      }
    }
  }

  const hasCyclesIssue = normalized.architectureRules.no_circular_deps !== false && cycles.length > 0
  const strictDrift = normalized.architectureRules.strict_drift === true
  const driftFails = strictDrift && drift.length > 0

  if (issues.length === 0 && !hasCyclesIssue && parseErrors.length === 0 && !driftFails) {
    console.log('All checks passed')
    console.log(`  ${nodes.length} nodes parsed across ${sourceRoots.length} source root(s)`)
    console.log(`  All dependency references resolve`)
    console.log(`  All doc paths exist on disk`)
    console.log(`  No circular dependencies`)
    if (!hasUserRules) console.log('  No user-defined architecture rules — nothing to enforce')
  } else {
    if (parseErrors.length > 0) {
      console.log(`\nParse warnings (${parseErrors.length}):`)
      parseErrors.forEach(e => console.log(`  ! ${e.filePath}: ${e.message}`))
    }
    if (issues.length > 0) {
      console.log(`\n${issues.length} issue(s) found:`)
      issues.forEach(i => console.log(`  ${i}`))
    }
    if (hasCyclesIssue) {
      console.log(`\nCircular dependencies (${cycles.length}):`)
      cycles.forEach(c => console.log(`  ${c.path.join(' → ')}`))
    }
    if (driftFails) {
      console.log(`\nDrift (strict_drift enabled — failing): ${drift.length} issue(s)`)
    }
    process.exitCode = 1
  }

  if (drift.length > 0) {
    console.log(`\nDrift between declared blocks and derived truth (${drift.length}):`)
    drift.forEach(d => console.log(`  ${strictDrift ? '✗' : '⚠'} ${d.nodeId}: ${d.detail} [${d.kind}]`))
    console.log(`\n  Run 'frontgraph sync' to rewrite blocks with the derived truth.`)
  }

  const staleness = trackStaleness(ROOT, nodes)
  if (staleness.length > 0) {
    console.log(`\nSummary staleness suspects (${staleness.length}) — informational, never fails the build:`)
    staleness.forEach(s => console.log(`  ? ${s.nodeIds.join(', ')}: ${s.reason}`))
    console.log(`\n  The code moved since these blocks were written — review the summaries.`)
  }
}

// ── brief ──
function cmdBrief() {
  let budget = DEFAULT_BRIEF_BUDGET
  if (arg === '--tokens' && arg2) {
    const parsed = Number.parseInt(arg2, 10)
    if (Number.isNaN(parsed) || parsed <= 0) {
      console.log('Usage: brief [--tokens N]')
      return
    }
    budget = parsed
  } else if (arg && arg !== '--tokens') {
    console.log('Usage: brief [--tokens N]')
    return
  }
  console.log(generateBrief(ROOT, budget))
}

// ── claim / release / leases (multi-agent coordination) ──
function cmdClaim() {
  const rest = process.argv.slice(3)
  const nodeIds: string[] = []
  let holder = ''
  let intent = ''
  let ttl: number | undefined
  let impact = false
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token === '--impact') impact = true
    else if (token === '--holder') holder = rest[++i] ?? ''
    else if (token === '--intent') intent = rest[++i] ?? ''
    else if (token === '--ttl') ttl = Number.parseInt(rest[++i] ?? '', 10)
    else nodeIds.push(token)
  }
  if (nodeIds.length === 0 || !holder) {
    console.log('Usage: claim <node-id...> --holder <name> [--intent <text>] [--ttl <seconds>] [--impact]')
    return
  }
  const unknown = nodeIds.filter(id => !graph.nodes.has(id))
  if (unknown.length > 0) {
    console.log(`Unknown node id(s): ${unknown.join(', ')}`)
    process.exitCode = 1
    return
  }

  const outcome = acquireLease(ROOT, nodes, {
    holder,
    nodeIds,
    intent: intent || '(no intent given)',
    ttlSeconds: Number.isNaN(ttl!) ? undefined : ttl,
    scope: impact ? 'impact' : 'nodes',
  })

  if (outcome.ok) {
    console.log(`\nLease ${outcome.lease.id} granted to '${holder}' until ${outcome.lease.expiresAt}`)
    console.log(`  scope: ${outcome.lease.scope} — ${outcome.lease.nodeIds.length} node(s) claimed:`)
    outcome.lease.nodeIds.forEach(id => console.log(`  ⛔ ${id}`))
  } else {
    console.log(`\nClaim REJECTED — conflicts with ${outcome.conflicts.length} active lease(s):`)
    outcome.conflicts.forEach(c =>
      console.log(`  ✗ ${c.leaseId} held by '${c.holder}' (${c.intent}) — overlap: ${c.overlapping.join(', ')} — expires ${c.expiresAt}`))
    process.exitCode = 1
  }
}

function cmdRelease() {
  if (!arg) { console.log('Usage: release <holder> [lease-id]'); return }
  const released = releaseLease(ROOT, { holder: arg, leaseId: arg2 })
  if (released.length === 0) {
    console.log(`No active leases held by '${arg}'${arg2 ? ` with id ${arg2}` : ''}.`)
  } else {
    console.log(`Released ${released.length} lease(s):`)
    released.forEach(l => console.log(`  ✓ ${l.id} — ${l.nodeIds.length} node(s) freed`))
  }
}

function cmdLeases() {
  const leases = listLeases(ROOT)
  if (leases.length === 0) {
    console.log('\nNo active leases — the whole graph is unclaimed.\n')
    return
  }
  console.log(`\nActive leases (${leases.length}):\n`)
  leases.forEach(l => {
    console.log(`  ${l.id} — '${l.holder}' (${l.scope}), expires ${l.expiresAt}`)
    console.log(`    intent: ${l.intent}`)
    console.log(`    nodes: ${l.nodeIds.join(', ')}`)
  })
}

// ── plan / orders (contract-diff work orders) ──
function cmdPlan() {
  const change = process.argv.slice(4).join(' ')
  if (!arg || !change) { console.log('Usage: plan <node-id> <description of the change>'); return }
  const plan = planWorkOrders(ROOT, nodes, arg, change)
  if (!plan) {
    console.log(`Node "${arg}" not found in graph.`)
    process.exitCode = 1
    return
  }
  console.log(`\nPlan ${plan.planId} — ${plan.orders.length} work order(s) for: ${change}\n`)
  plan.orders.forEach(o => {
    const blockers = o.blockedBy.length > 0 ? ` (blocked by ${o.blockedBy.join(', ')})` : ' (READY)'
    console.log(`  ${o.id} → ${o.nodeId}${blockers}`)
    console.log(`    ${o.action}`)
  })
  console.log(`\nWork bottom-up: start with READY orders, mark each done before its dependents start.`)
}

function cmdOrders() {
  if (arg === 'start' || arg === 'done') {
    if (!arg2) { console.log(`Usage: orders ${arg} <order-id>`); return }
    const outcome = updateWorkOrder(ROOT, arg2, arg === 'start' ? 'in_progress' : 'done')
    if (outcome.ok) {
      console.log(`${arg2} → ${outcome.order.status}`)
    } else {
      console.log(`✗ ${outcome.reason}`)
      outcome.blockedBy?.forEach(o => console.log(`  blocked by ${o.id} (${o.nodeId}) — ${o.status}`))
      process.exitCode = 1
    }
    return
  }

  const orders = listWorkOrders(ROOT, arg)
  if (orders.length === 0) {
    console.log(`\nNo work orders${arg ? ` in plan ${arg}` : ''}. Create one with: plan <node-id> <change>\n`)
    return
  }
  console.log(`\nWork orders${arg ? ` — plan ${arg}` : ''} (${orders.length}):\n`)
  orders.forEach(o => {
    const mark = o.status === 'done' ? '✓' : o.status === 'in_progress' ? '~' : o.ready ? '▶' : '·'
    const state = o.status === 'pending' && o.ready ? 'READY' : o.status
    console.log(`  ${mark} ${o.id} [${o.planId}] ${o.nodeId} — ${state}${o.blockedBy.length > 0 ? ` (after ${o.blockedBy.join(', ')})` : ''}`)
  })
  console.log(`\n  orders start <id> | orders done <id>`)
}

// ── context ──
function cmdContext() {
  if (!arg) { console.log('Usage: context <query>'); return }
  console.log(`\nSearching for: "${arg}"\n`)
  const results = search(graph, arg)
  if (results.length === 0) {
    console.log('  No matches')
  } else {
    results.forEach(n => {
      printNode(n)
      const deps = getDependents(graph, n.id)
      if (deps.length > 0) console.log(`    also affects: ${deps.map(d => d.id).join(', ')}`)
      console.log()
    })
  }
}

// ── cycles ──
function cmdCycles() {
  if (cycles.length === 0) {
    console.log('\nNo circular dependencies detected.\n')
    return
  }
  console.log(`\nCircular dependencies (${cycles.length}):\n`)
  cycles.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.path.join(' → ')}`)
  })
}

// ── workflow (methodology-adaptive) ──
function cmdWorkflow() {
  if (!arg) { console.log('Usage: workflow <task-name>'); return }

  const taskSlug = arg.toLowerCase().replace(/\s+/g, '-')
  console.log(`\n=== Workflow: "${arg}" ===\n`)
  console.log(`Observed methodologies: ${fmtObserved()}\n`)

  const steps: { num: number; label: string; path: string; method: string; required: boolean }[] = []

  if (observed.sdd.observed) {
    const specsPath = observed.sdd.specsPath ?? 'Docs/specs'
    steps.push({ num: steps.length + 1, label: 'Write specification', path: `${specsPath}/${taskSlug}.spec.md`, method: 'SDD (observed)', required: true })
  }

  if (observed.cdd.observed) {
    const contractsPath = observed.cdd.contractsPath ?? 'src/types'
    steps.push({ num: steps.length + 1, label: 'Define contract (types/interfaces)', path: `${contractsPath}/${taskSlug}.ts`, method: 'CDD (observed)', required: true })
  }

  if (observed.tdd.observed) {
    const testsPath = observed.tdd.testsPath ?? 'src/__tests__'
    steps.push({ num: steps.length + 1, label: 'Write tests', path: `${testsPath}/${taskSlug}.test.ts`, method: 'TDD (observed)', required: true })
  }

  // Always: implementation
  const logicCat = discoveredCategories.has('logic') ? 'logic'
    : discoveredCategories.has('services') ? 'services'
    : [...discoveredCategories.keys()][0] ?? 'src'
  const implPath = discoveredCategories.has(logicCat) ? `${sourceRoots[0]}/${logicCat}/${taskSlug}.ts` : `src/${taskSlug}.ts`
  steps.push({ num: steps.length + 1, label: 'Implement logic', path: implPath, method: '(always)', required: true })

  steps.push({ num: steps.length + 1, label: 'Write AI documentation', path: `Docs/${stripSourceExtension(implPath)}.md`, method: '(always)', required: true })
  steps.push({ num: steps.length + 1, label: 'Add @graph blocks to new files', path: '(all new files)', method: '(always)', required: true })

  for (const step of steps) {
    const flag = step.method === '(always)' ? '' : ` (${step.method})`
    console.log(`  ${step.num}. ${step.label}${flag}`)
    console.log(`     → ${step.path}`)
  }

  console.log('\nCurrent state:')
  for (const step of steps) {
    if (step.path === '(all new files)') continue
    const fullPath = resolve(ROOT, step.path)
    const exists = existsSync(fullPath)
    const icon = exists ? 'found' : 'MISSING'
    console.log(`  ${icon === 'found' ? '✓' : '✗'} ${step.path} ${icon === 'found' ? '(exists)' : '(needs creation)'}`)
  }
}

// ── gate (pre-implementation check) ──
function cmdGate() {
  if (!arg) { console.log('Usage: gate <feature-name>'); return }

  const taskSlug = arg.toLowerCase().replace(/\s+/g, '-')
  console.log(`\n=== Gate Check: "${arg}" ===\n`)

  type GateCheck = { label: string; path: string; method: string; exists: boolean; required: boolean }
  const checks: GateCheck[] = []

  if (observed.sdd.observed) {
    const specsPath = observed.sdd.specsPath ?? 'Docs/specs'
    const path = `${specsPath}/${taskSlug}.spec.md`
    checks.push({ label: 'Specification', path, method: 'SDD', exists: existsSync(resolve(ROOT, path)), required: true })
  }

  if (observed.cdd.observed) {
    const contractsPath = observed.cdd.contractsPath ?? 'src/types'
    const path = `${contractsPath}/${taskSlug}.ts`
    checks.push({ label: 'Contract', path, method: 'CDD', exists: existsSync(resolve(ROOT, path)), required: true })
  }

  if (observed.tdd.observed) {
    const testsPath = observed.tdd.testsPath ?? 'src/__tests__'
    const path = `${testsPath}/${taskSlug}.test.ts`
    checks.push({ label: 'Tests', path, method: 'TDD', exists: existsSync(resolve(ROOT, path)), required: true })
  }

  if (checks.length === 0) {
    console.log('  No methodologies observed. Gate is always open.')
    console.log('  Run: frontgraph scaffold ' + arg)
    return
  }

  let blocked = false
  for (const check of checks) {
    const status = check.exists ? 'found' : (check.required ? 'BLOCKED' : 'missing (optional)')
    const icon = check.exists ? '✓' : (check.required ? '✗' : '○')
    console.log(`  ${icon} ${check.method}: ${check.path} ← ${status}`)
    if (!check.exists && check.required) blocked = true
  }

  console.log(`\nResult: ${blocked ? 'BLOCKED — create missing artifacts first' : 'READY — all gates passed'}`)
}

// ── architecture ──
function cmdArchitecture() {
  console.log('\n=== Inferred Architecture ===\n')

  console.log('Observed patterns:')
  architecture.observedPatterns.forEach(p => console.log(`  ${p}`))

  // Layer analysis
  const layerCats = analyzeLayers(graph, layers)
  console.log('\nLayer composition:')
  for (const [layer, cats] of layerCats) {
    console.log(`  Layer ${layer}: ${cats.join(', ')}`)
  }

  // Dependency matrix
  console.log('\nCategory dependency matrix:')
  for (const [fromCat, targets] of Object.entries(architecture.categoryDependencyMatrix)) {
    const entries = Object.entries(targets).sort(([, a], [, b]) => b - a)
    if (entries.length === 0) {
      console.log(`  ${fromCat} → (none)`)
    } else {
      console.log(`  ${fromCat} → ${entries.map(([cat, n]) => `${cat}:${n}`).join('  ')}`)
    }
  }

  // Natural flow
  if (architecture.naturalFlow.length > 1) {
    console.log(`\nNatural dependency flow: ${architecture.naturalFlow.join(' → ')}`)
  }

  // User-defined rules (if any)
  if (Object.keys(normalized.architectureRules).length > 0) {
    console.log('\nUser-defined architecture rules:')
    for (const [rule, value] of Object.entries(normalized.architectureRules)) {
      console.log(`  ${rule}: ${value}`)
    }

    // Check violations against user rules
    console.log('\nRule violations:')
    let violations = 0
    for (const n of nodes) {
      if (normalized.architectureRules.no_ui_in_logic_deps && n.category === 'logic') {
        const uiDeps = n.dependencies.filter(d => graph.nodes.get(d)?.category === 'ui')
        for (const d of uiDeps) {
          console.log(`  ✗ ${n.id} → ${d} (logic depends on ui)`)
          violations++
        }
      }
      if (normalized.architectureRules.contract_at_layer_zero && n.category === 'contract') {
        const internalDeps = n.dependencies.filter(d => graph.nodes.has(d))
        for (const d of internalDeps) {
          console.log(`  ✗ ${n.id} → ${d} (contract has internal dep)`)
          violations++
        }
      }
      if (normalized.architectureRules.enforce_doc_for_all_nodes && !n.doc) {
        console.log(`  ✗ ${n.id}: missing documentation`)
        violations++
      }
    }
    if (violations === 0) console.log('  (none)')
  } else {
    console.log('\nNo user-defined architecture rules configured.')
  }
}

// ── coverage (TDD observed) ──
function cmdCoverage() {
  if (!observed.tdd.observed) {
    console.log('\nTDD not observed in this project.\n')
    return
  }
  console.log(`\n=== Test Coverage (${observed.tdd.framework ?? 'unknown framework'}) ===\n`)

  const testNodes = nodes.filter(n => n.category === 'test')
  const coveredIds = new Set<string>()
  for (const t of testNodes) {
    for (const dep of t.dependencies) {
      coveredIds.add(dep)
    }
  }

  const codeNodes = nodes.filter(n => !['entry', 'test', 'spec'].includes(n.category) || n.exports.length > 0)
  for (const n of codeNodes) {
    const covered = coveredIds.has(n.id)
    const icon = covered ? '✓' : '✗'
    console.log(`  ${icon} ${n.id} [${n.category}]`)
  }

  const total = codeNodes.filter(n => n.category !== 'contract').length
  const covered = codeNodes.filter(n => coveredIds.has(n.id) && n.category !== 'contract').length
  console.log(`\n  ${covered}/${total} code nodes covered by tests`)

  if (observed.tdd.evidence.length > 0) {
    console.log(`\nTest files found: ${observed.tdd.evidence.length}`)
    observed.tdd.evidence.forEach(f => console.log(`  ${f}`))
  }
}

// ── scaffold (methodology-adaptive) ──
function cmdScaffold() {
  if (!arg) { console.log('Usage: scaffold <name> [--category logic]'); return }

  const categoryArg = process.argv.includes('--category') ? process.argv[process.argv.indexOf('--category') + 1] : 'logic'
  const name = arg
  const slug = name.toLowerCase().replace(/\s+/g, '-')

  console.log(`\nScaffolding: "${name}" (category: ${categoryArg})\n`)
  console.log(`Observed methodologies: ${fmtObserved()}\n`)

  const created: string[] = []

  // SDD: spec
  if (observed.sdd.observed) {
    const specsPath = observed.sdd.specsPath ?? 'Docs/specs'
    const dir = resolve(ROOT, specsPath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${slug}.spec.md`),
      `# ${name} — Specification\n\n## Overview\n\nTBD.\n\n## Requirements\n\n- \n\n## Acceptance Criteria\n\n- [ ] \n`)
    created.push(`${specsPath}/${slug}.spec.md`)
  }

  // CDD: contract
  if (observed.cdd.observed) {
    const contractsPath = observed.cdd.contractsPath ?? 'src/types'
    const dir = resolve(ROOT, contractsPath)
    mkdirSync(dir, { recursive: true })
    const id = `${contractsPath}/${slug}`
    writeFileSync(join(dir, `${slug}.ts`), [
      '/**',
      ' * @graph',
      ` * id: ${id}`,
      ` * category: ${basename(contractsPath)}`,
      ` * summary: Contract types for ${name}`,
      ' * dependencies: []',
      ' * exports: []',
      ` * doc: Docs/${id}.md`,
      ' */',
      '',
      `// Contract types for ${name}`,
      `export interface ${name}Input {}`,
      `export interface ${name}Output {}`,
      '',
    ].join('\n'))
    created.push(id + '.ts')
  }

  // TDD: test
  if (observed.tdd.observed) {
    const testsPath = observed.tdd.testsPath ?? 'src/__tests__'
    const dir = resolve(ROOT, testsPath)
    mkdirSync(dir, { recursive: true })

    const logicCat = discoveredCategories.has('logic') ? 'logic'
      : discoveredCategories.has('services') ? 'services'
      : [...discoveredCategories.keys()][0] ?? 'src'
    const logicId = `${sourceRoots[0]}/${logicCat}/${slug}`
    const contractsPath = observed.cdd.contractsPath ?? 'src/types'
    const contractId = `${contractsPath}/${slug}`
    const testId = `${testsPath}/${slug}.test`

    writeFileSync(join(dir, `${slug}.test.ts`), [
      '/**',
      ' * @graph',
      ` * id: ${testId}`,
      ' * category: test',
      ` * summary: Tests for ${name}`,
      ` * dependencies: [${logicId}${observed.cdd.observed ? `, ${contractId}` : ''}]`,
      ' * exports: []',
      ` * doc: Docs/${testId}.md`,
      ' */',
      '',
      `import { describe, it, expect } from '${observed.tdd.framework === 'jest' ? '@jest/globals' : 'vitest'}'`,
      '',
      `describe('${name}', () => {`,
      `  it('should work', () => {`,
      `    expect(true).toBe(true)`,
      `  })`,
      `})`,
      '',
    ].join('\n'))
    created.push(testId + '.ts')
  }

  // Always: implementation stub
  const logicCat = categoryArg === 'logic' && discoveredCategories.has('logic') ? 'logic'
    : discoveredCategories.has(categoryArg) ? categoryArg
    : [...discoveredCategories.keys()][0] ?? 'src'
  const logicDir = discoveredCategories.has(logicCat)
    ? resolve(ROOT, sourceRoots[0], logicCat)
    : resolve(ROOT, 'src')
  mkdirSync(logicDir, { recursive: true })
  const logicId = discoveredCategories.has(logicCat)
    ? `${sourceRoots[0]}/${logicCat}/${slug}`
    : `src/${slug}`

  const deps: string[] = []
  if (observed.cdd.observed) {
    const contractsPath = observed.cdd.contractsPath ?? 'src/types'
    deps.push(`${contractsPath}/${slug}`)
  }

  writeFileSync(join(logicDir, `${slug}.ts`), [
    '/**',
    ' * @graph',
    ` * id: ${logicId}`,
    ` * category: ${logicCat}`,
    ` * summary: Implementation of ${name}`,
    ` * dependencies: [${deps.join(', ')}]`,
    ' * exports: []',
    ` * doc: Docs/${logicId}.md`,
    ' */',
    '',
    `// ${name}`,
    'export function placeholder() {',
    '  // TODO: implement',
    '}',
    '',
  ].join('\n'))
  created.push(logicId + '.ts')

  // Always: doc stub
  const docDir = resolve(ROOT, `Docs/${logicId}`)
  mkdirSync(dirname(docDir), { recursive: true })
  writeFileSync(docDir, `# ${slug}.ts — ${name}\n\n## Overview\n\nTBD.\n`)
  created.push(`Docs/${logicId}.md`)

  invalidateCache(ROOT)

  console.log('Created:')
  created.forEach(c => console.log(`  + ${c}`))
  console.log(`\nNext: fill in the stubs, then run 'validate'`)
}

// ── observe ──
function cmdObserve() {
  console.log('\n=== Project Observation ===\n')

  console.log(`Source roots: ${sourceRoots.join(', ')}`)

  console.log(`\nDiscovered categories (${discoveredCategories.size}):`)
  for (const [cat, files] of discoveredCategories) {
    const meta = normalized.categories_meta[cat]
    console.log(`  ${cat}: ${files.length} file(s)${meta ? ` — ${meta.description}` : ''}`)
    if (arg === '--verbose') {
      files.forEach(f => console.log(`    ${f}`))
    }
  }

  console.log('\nObserved methodologies:')
  console.log(`  CDD: ${observed.cdd.observed ? `YES (${observed.cdd.contractsPath}, ${observed.cdd.evidence.length} files)` : 'not observed'}`)
  if (observed.cdd.observed && arg === '--verbose') {
    observed.cdd.evidence.forEach(f => console.log(`    ${f}`))
  }
  console.log(`  TDD: ${observed.tdd.observed ? `YES (${observed.tdd.testsPath}, ${observed.tdd.evidence.length} files${observed.tdd.framework ? ', ' + observed.tdd.framework : ''})` : 'not observed'}`)
  if (observed.tdd.observed && arg === '--verbose') {
    observed.tdd.evidence.forEach(f => console.log(`    ${f}`))
  }
  console.log(`  SDD: ${observed.sdd.observed ? `YES (${observed.sdd.specsPath}, ${observed.sdd.evidence.length} files)` : 'not observed'}`)
  if (observed.sdd.observed && arg === '--verbose') {
    observed.sdd.evidence.forEach(f => console.log(`    ${f}`))
  }

  console.log(`\n@graph annotation: ${nodes.length} node(s) parsed, ${parseErrors.length} warning(s)`)
  if (normalized._legacy) {
    console.log('\nLegacy config detected. Run "onboard --configure" to migrate to new format.')
  }
}

// ── onboard ──
function cmdOnboard() {
  const mode = arg ?? 'auto'
  console.log('\n=== Onboarding Protocol ===\n')

  // Phase 1: Discovery (always run)
  const srcFiles = (function walkSources(): string[] {
    const files: string[] = []
    for (const srcRoot of sourceRoots) {
      const full = resolve(ROOT, srcRoot)
      if (!existsSync(full)) continue
      function walk(d: string): string[] {
        const out: string[] = []
        if (!existsSync(d)) return out
        for (const e of readdirSync(d)) {
          const f = join(d, e)
          if (e.startsWith('.') || e === 'node_modules' || e === 'dist') continue
          const s = statSync(f)
          if (s.isDirectory()) out.push(...walk(f))
          else if (e.endsWith('.d.ts')) { /* skip */ }
          else if (hasSourceExtension(e)) out.push(f)
        }
        return out
      }
      files.push(...walk(full))
    }
    return files
  })()

  const isNew = srcFiles.length === 0
  const needsRetrofit = srcFiles.some(f => {
    try { return !/@graph/.test(readFileSync(f, 'utf-8')) }
    catch { return false }
  })

  console.log('Phase 1 — Observation:')
  console.log(`  Source roots: ${sourceRoots.join(', ')}`)
  console.log(`  Source files found: ${srcFiles.length}`)
  console.log(`  Categories: ${[...discoveredCategories.keys()].join(', ') || '(none)'}`)
  console.log(`  Methodologies: ${fmtObserved()}`)
  console.log(`  Project state: ${isNew ? 'NEW' : needsRetrofit ? 'EXISTING (needs annotation)' : 'ANNOTATED'}`)

  if (mode === '--observe') {
    console.log()
    return
  }

  if (mode === 'auto') {
    if (isNew) {
      console.log('\nPhase 2 — Init:')
      // Create only src/ if it doesn't exist
      for (const srcRoot of sourceRoots) {
        const full = resolve(ROOT, srcRoot)
        if (!existsSync(full)) {
          mkdirSync(full, { recursive: true })
          console.log(`  + ${srcRoot}/`)
        }
      }
      // Create minimal structure based on observed methodologies
      if (observed.cdd.observed && observed.cdd.contractsPath) {
        const full = resolve(ROOT, observed.cdd.contractsPath)
        if (!existsSync(full)) {
          mkdirSync(full, { recursive: true })
          console.log(`  + ${observed.cdd.contractsPath}/`)
        }
      }
      console.log('  (scaffold with: frontgraph scaffold <name>)')
    }

    if (!isNew && needsRetrofit) {
      console.log('\nPhase 2 — Annotation:')
      const { annotated, docsCreated, skipped } = retrofitProject(ROOT)
      console.log(`  Annotated: ${annotated.length} file(s)`)
      annotated.forEach(f => console.log(`    + @graph: ${f}`))
      console.log(`  Docs created: ${docsCreated.length} file(s)`)
      docsCreated.forEach(d => console.log(`    + ${d}`))
      if (skipped.length > 0) console.log(`  Skipped (already annotated): ${skipped.length} file(s)`)
    }

    console.log('\nPhase 3 — Spec stubs:')
    const specs = createSpecStubs(ROOT)
    if (specs.length === 0) console.log('  SDD not observed — skipped')
    else specs.forEach(s => console.log(`  + ${s}`))

    // Invalidate cache
    invalidateCache(ROOT)

    console.log('\nPhase 4 — Validation:')
    const { nodes: finalNodes, errors: finalErrors } = parseProjectWithErrors(ROOT)
    const finalGraph = buildGraph(finalNodes)
    const issues = validateReferences(finalGraph, (relPath) => existsSync(resolve(ROOT, relPath)))
    if (issues.length === 0 && finalErrors.length === 0) console.log('  All valid')
    else {
      finalErrors.forEach(e => console.log(`  ! ${e.filePath}: ${e.message}`))
      issues.forEach(i => console.log(`  ! ${i}`))
    }

    console.log('\n=== Onboarding Complete ===')
    console.log(`  Nodes: ${finalNodes.length}`)
    console.log(`  Categories: ${[...discoverCategories(ROOT, sourceRoots).keys()].join(', ')}`)
    console.log(`  Methodologies observed: ${fmtObserved()}`)
    console.log(`\n  Next: review auto-generated @graph blocks and fill in TBD docs`)
  } else if (mode === '--new') {
    const created = scaffoldProject(ROOT)
    invalidateCache(ROOT)
    created.forEach(c => console.log(`  + ${c}`))
  } else if (mode === '--retrofit') {
    const { annotated, docsCreated } = retrofitProject(ROOT)
    invalidateCache(ROOT)
    console.log(`Annotated: ${annotated.length}, Docs: ${docsCreated.length}`)
  } else if (mode === '--specs') {
    const specs = createSpecStubs(ROOT)
    specs.forEach(s => console.log(`  + ${s}`))
  } else if (mode === '--configure') {
    // Generate new-format config
    console.log('Generating graph.config.json in new format...')
    const newConfig: Record<string, unknown> = {
      categories_meta: {},
      methodologies_meta: {},
      architectureRules: normalized.architectureRules ?? { no_circular_deps: true },
    }

    for (const [cat] of discoveredCategories) {
      const existing = normalized.categories_meta[cat]
      ;(newConfig.categories_meta as Record<string, unknown>)[cat] = existing ?? {
        description: `${cat} files`,
        color: '#8b949e',
      }
    }

    if (observed.cdd.observed && observed.cdd.contractsPath) {
      ;(newConfig.methodologies_meta as Record<string, unknown>).cdd = { contractsPath: observed.cdd.contractsPath }
    }
    if (observed.tdd.observed && observed.tdd.testsPath) {
      ;(newConfig.methodologies_meta as Record<string, unknown>).tdd = {
        testsPath: observed.tdd.testsPath,
        ...(observed.tdd.framework ? { framework: observed.tdd.framework } : {}),
      }
    }
    if (observed.sdd.observed && observed.sdd.specsPath) {
      ;(newConfig.methodologies_meta as Record<string, unknown>).sdd = { specsPath: observed.sdd.specsPath }
    }

    const configPath = resolve(ROOT, 'graph.config.json')
    writeFileSync(configPath, JSON.stringify(newConfig, null, 2))
    console.log(`  + graph.config.json (new format)`)
    console.log(`  Categories: ${Object.keys(newConfig.categories_meta as Record<string, unknown>).join(', ')}`)
    console.log(`  Methodologies: ${Object.keys(newConfig.methodologies_meta as Record<string, unknown>).join(', ') || 'none'}`)
    invalidateCache(ROOT)
  }
}

// ── sync ──
function cmdSync() {
  console.log('\nSyncing @graph blocks with derived truth...\n')
  const result = syncGraphBlocks(ROOT)

  if (result.updated.length > 0) {
    console.log(`Updated (${result.updated.length}):`)
    result.updated.forEach(f => console.log(`  ~ ${f}`))
  } else {
    console.log('No blocks needed updating — declared and derived truth agree.')
  }

  if (result.skippedAnchored.length > 0) {
    console.log(`\nSkipped anchored files (${result.skippedAnchored.length}) — exports stay declared per anchor:`)
    result.skippedAnchored.forEach(f => console.log(`  - ${f}`))
  }

  console.log(`\n${result.unchanged.length} file(s) already in sync.`)
}

// ── move ──
function cmdMove() {
  if (!arg || !arg2) {
    console.log('Usage: move <source> <destination>')
    return
  }

  try {
    const result = moveGraphNode(ROOT, arg, arg2)
    console.log('\nMoved graph file:\n')
    console.log(`  ${result.source} -> ${result.destination}`)
    console.log('\nNode IDs:')
    result.movedNodes.forEach(n => console.log(`  ${n.from} -> ${n.to}`))

    if (result.updatedFiles.length > 0) {
      console.log('\nUpdated dependents:')
      result.updatedFiles.forEach(f => console.log(`  ${f}`))
    } else {
      console.log('\nUpdated dependents: none')
    }

    if (result.movedDocs.length > 0) {
      console.log('\nMoved docs:')
      result.movedDocs.forEach(f => console.log(`  ${f}`))
    }
  } catch (err) {
    console.error(`Move failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

// ── Router ──
switch (command) {
  case 'graph': cmdGraph(); break
  case 'deps': cmdDeps(); break
  case 'dependents': cmdDependents(); break
  case 'summary': cmdSummary(); break
  case 'validate': cmdValidate(); break
  case 'context': cmdContext(); break
  case 'cycles': cmdCycles(); break
  case 'observe': cmdObserve(); break
  case 'workflow': cmdWorkflow(); break
  case 'gate': cmdGate(); break
  case 'architecture': cmdArchitecture(); break
  case 'coverage': cmdCoverage(); break
  case 'scaffold': cmdScaffold(); break
  case 'sync': cmdSync(); break
  case 'brief': cmdBrief(); break
  case 'claim': cmdClaim(); break
  case 'release': cmdRelease(); break
  case 'leases': cmdLeases(); break
  case 'plan': cmdPlan(); break
  case 'orders': cmdOrders(); break
  case 'move': cmdMove(); break
  case 'onboard': cmdOnboard(); break
  default:
    console.log(`
Usage: frontgraph <command> [arg]
(runs against the current working directory; set FRONTGRAPH_ROOT to override)

Graph:
  graph              Show dependency layers
  graph --tree       Show full dependency tree
  deps <id>          What does <id> depend on?
  dependents <id>    What depends on <id>?
  summary            Full project overview (discovered + observed + inferred)
  context <query>    Find relevant files for a task
  cycles             Detect circular dependencies
  observe [--verbose]  Scan project and report what is observed
  brief [--tokens N] Token-budgeted architectural brief for agents (default ${DEFAULT_BRIEF_BUDGET})

Integrity:
  validate           Check @graph blocks + references + drift (+ user rules if defined)
  sync               Rewrite block dependencies/exports with the derived truth
  architecture       Show inferred architecture patterns + coupling matrix

Methodology (adapts to observed methodologies):
  workflow <name>    Print implementation steps based on observed methodologies
  gate <name>        Pre-implementation check — are required artifacts ready?
  coverage           Show test coverage (only if TDD observed)
  scaffold <name>    Generate contract + impl + test + doc stubs (adaptive)
  move <src> <dst>   Move a graph file and update dependent @graph references

Coordination (multi-agent):
  claim <id...> --holder <name> [--intent <text>] [--ttl <s>] [--impact]
                     Claim exclusive intent over nodes (impact = + all dependents)
  release <holder> [lease-id]   Release leases
  leases             List active leases
  plan <id> <change>  Generate a bottom-up work-order DAG for a contract change
  orders [plan|start <id>|done <id>]  List or advance work orders (gated by the DAG)

Setup:
  onboard [--observe|--new|--retrofit|--specs|--configure]
`)
}
