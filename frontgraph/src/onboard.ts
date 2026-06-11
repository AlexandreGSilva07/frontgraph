import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, dirname, basename, isAbsolute, normalize as normalizeFsPath } from 'node:path'
import { buildGraph, getDependents } from './graph'
import { loadConfig, normalizeConfig, discoverSourceRoots, discoverCategories, observeMethodologies, parseProjectWithErrors, invalidateCache, type ObservedMethodologies } from './parser'
import { deriveTsFacts } from './derive'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py']

function hasSourceExtension(fileName: string): boolean {
  return SOURCE_EXTENSIONS.some(ext => fileName.endsWith(ext))
}

function stripSourceExtension(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx|py)$/, '')
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

// ── Observed project report ──

export interface ObservationReport {
  sourceRoots: string[]
  discoveredCategories: Map<string, string[]>
  observedMethodologies: ObservedMethodologies
  filesNeedingAnnotation: string[]
  filesAlreadyAnnotated: string[]
  totalFiles: number
}

export function observeProject(rootDir: string): ObservationReport {
  const config = loadConfig(rootDir)
  const normalized = normalizeConfig(config)

  const sourceRoots = normalized.project.sourceRoots.length > 0
    ? normalized.project.sourceRoots
    : discoverSourceRoots(rootDir)

  const discoveredCategories = discoverCategories(rootDir, sourceRoots)
  const observed = observeMethodologies(rootDir, sourceRoots)

  const filesNeedingAnnotation: string[] = []
  const filesAlreadyAnnotated: string[] = []
  let totalFiles = 0

  for (const srcRoot of sourceRoots) {
    const srcDir = resolve(rootDir, srcRoot)
    if (!existsSync(srcDir)) continue

    function walkSource(dir: string): string[] {
      const files: string[] = []
      if (!existsSync(dir)) return files
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue
        const stat = statSync(full)
        if (stat.isDirectory()) {
          files.push(...walkSource(full))
        } else if (entry.endsWith('.d.ts')) {
          // skip
        } else if (hasSourceExtension(entry)) {
          files.push(full)
        }
      }
      return files
    }

    for (const fullPath of walkSource(srcDir)) {
      totalFiles++
      const relPath = relative(rootDir, fullPath)
      try {
        if (/@graph/.test(readFileSync(fullPath, 'utf-8'))) {
          filesAlreadyAnnotated.push(relPath)
        } else {
          filesNeedingAnnotation.push(relPath)
        }
      } catch {
        // skip unreadable
      }
    }
  }

  return {
    sourceRoots,
    discoveredCategories,
    observedMethodologies: observed,
    filesNeedingAnnotation,
    filesAlreadyAnnotated,
    totalFiles,
  }
}

// ── Scaffold (minimal) ──

export function scaffoldProject(rootDir: string): string[] {
  const created: string[] = []

  // Create src/ if it doesn't exist
  const srcDir = resolve(rootDir, 'src')
  if (!existsSync(srcDir)) {
    mkdirSync(srcDir, { recursive: true })
    created.push('src/')
  }

  // Create graph.config.json if not exists (new format, minimal)
  const configPath = resolve(rootDir, 'graph.config.json')
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({
      categories_meta: {},
      methodologies_meta: {},
      architectureRules: { no_circular_deps: true },
    }, null, 2))
    created.push('graph.config.json')
  }

  return created
}

// ── Category inference from directory ──

function inferCategory(filePath: string, sourceRoots: string[]): string {
  // Normalize slashes
  const normalized = filePath.replace(/\\/g, '/')

  // Find which source root this file belongs to
  for (const srcRoot of sourceRoots) {
    const prefix = srcRoot + '/'
    if (normalized.startsWith(prefix)) {
      const relativePath = normalized.slice(prefix.length)
      const slashIdx = relativePath.indexOf('/')
      if (slashIdx > 0) {
        // File is in a subdirectory → category = subdirectory name
        return relativePath.slice(0, slashIdx)
      }
      // File is directly in the source root → category = 'root'
      break
    }
  }

  return 'root'
}

function generateGraphBlock(id: string, category: string, deps: string[], exports_: string[], doc: string): string {
  const depsStr = deps.length > 0 ? `[${deps.join(', ')}]` : '[]'
  const exportsStr = exports_.length > 0 ? `[${exports_.join(', ')}]` : '[]'
  return [
    '/**',
    ' * @graph',
    ` * id: ${id}`,
    ` * category: ${category}`,
    ' * summary: TBD — auto-generated during onboarding',
    ` * dependencies: ${depsStr}`,
    ` * exports: ${exportsStr}`,
    ` * doc: ${doc}`,
    ' */',
  ].join('\n')
}

// ── Retrofit (annotate existing project) ──

export function retrofitProject(
  rootDir: string,
  sourceRoots?: string[],
): { annotated: string[]; docsCreated: string[]; skipped: string[] } {
  const annotated: string[] = []
  const docsCreated: string[] = []
  const skipped: string[] = []

  const roots = sourceRoots ?? discoverSourceRoots(rootDir)

  function walkSource(dir: string): string[] {
    const files: string[] = []
    if (!existsSync(dir)) return files
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue
      const stat = statSync(full)
      if (stat.isDirectory()) {
        files.push(...walkSource(full))
      } else if (entry.endsWith('.d.ts')) {
        // skip
      } else if (hasSourceExtension(entry)) {
        files.push(full)
      }
    }
    return files
  }

  const sourceFiles: string[] = []
  for (const srcRoot of roots) {
    sourceFiles.push(...walkSource(resolve(rootDir, srcRoot)))
  }

  for (const fullPath of sourceFiles) {
    const relPath = relative(rootDir, fullPath)
    const content = readFileSync(fullPath, 'utf-8')

    // Skip if already has @graph
    if (/@graph/.test(content)) {
      skipped.push(relPath)
      continue
    }

    const id = stripSourceExtension(normalizePath(relPath))
    const category = inferCategory(relPath, roots)
    const isPython = relPath.endsWith('.py')
    const facts = isPython
      ? { dependencies: [] as string[], exports: [] as string[] }
      : deriveTsFacts(content, relPath, rootDir)
    const deps = facts.dependencies
    const exports_ = facts.exports
    const doc = `Docs/${id}.md`

    const graphBlock = generateGraphBlock(id, category, deps, exports_, doc)

    // Prepend @graph block
    const newContent = graphBlock + '\n\n' + content
    writeFileSync(fullPath, newContent)
    annotated.push(relPath)

    // Create doc stub
    const docPath = resolve(rootDir, doc)
    if (!existsSync(docPath)) {
      mkdirSync(dirname(docPath), { recursive: true })
      writeFileSync(docPath, `# ${basename(relPath)} — ${category}\n\n## Overview\n\nTBD — auto-generated during onboarding.\n`)
      docsCreated.push(doc)
    }
  }

  return { annotated, docsCreated, skipped }
}

// ── Move graph file ──

export interface MoveGraphResult {
  source: string
  destination: string
  movedNodes: Array<{ from: string; to: string }>
  updatedFiles: string[]
  movedDocs: string[]
}

export function moveGraphNode(
  rootDir: string,
  source: string,
  destination: string,
): MoveGraphResult {
  invalidateCache(rootDir)

  const sourcePath = resolveSourceFile(rootDir, source)
  if (!sourcePath) {
    throw new Error(`Source file not found: ${source}`)
  }

  const sourceRel = normalizePath(relative(rootDir, sourcePath))
  const destinationRel = resolveDestinationRel(rootDir, destination, sourceRel)
  if (sourceRel === destinationRel) {
    throw new Error('Source and destination resolve to the same file')
  }

  const destinationPath = resolve(rootDir, destinationRel)
  if (existsSync(destinationPath)) {
    throw new Error(`Destination already exists: ${destinationRel}`)
  }

  const { nodes, errors } = parseProjectWithErrors(rootDir)
  if (errors.length > 0) {
    throw new Error(`Cannot move while graph has parse warnings: ${errors.map(e => `${e.filePath}: ${e.message}`).join('; ')}`)
  }

  const sourceNodes = nodes.filter(n => normalizePath(n.filePath) === sourceRel)
  if (sourceNodes.length === 0) {
    throw new Error(`No @graph block found in ${sourceRel}`)
  }

  const oldBaseId = stripSourceExtension(sourceRel)
  const newBaseId = stripSourceExtension(destinationRel)
  const nodeReplacements = new Map<string, string>()

  for (const node of sourceNodes) {
    const normalizedId = normalizePath(node.id)
    const nextId = normalizedId === oldBaseId
      ? newBaseId
      : normalizedId.startsWith(`${oldBaseId}#`)
        ? `${newBaseId}${normalizedId.slice(oldBaseId.length)}`
        : normalizedId.replace(oldBaseId, newBaseId)
    nodeReplacements.set(node.id, nextId)
  }

  const graph = buildGraph(nodes)
  const dependentFiles = new Set<string>()
  for (const oldId of nodeReplacements.keys()) {
    for (const dependent of getDependents(graph, oldId)) {
      dependentFiles.add(normalizePath(dependent.filePath))
    }
  }

  const updatedFiles: string[] = []
  for (const relFile of dependentFiles) {
    if (relFile === sourceRel) continue
    const fullPath = resolve(rootDir, relFile)
    const before = readFileSync(fullPath, 'utf-8')
    let after = replaceDependencyIds(before, nodeReplacements)
    after = replaceModuleSpecifiersForMove(after, relFile, sourceRel, destinationRel)
    if (after !== before) {
      writeFileSync(fullPath, after)
      updatedFiles.push(relFile)
    }
  }

  const docReplacements = buildDocReplacements(sourceNodes, nodeReplacements)
  const sourceBefore = readFileSync(sourcePath, 'utf-8')
  let sourceAfter = replaceMetadataValues(sourceBefore, 'id', nodeReplacements)
  sourceAfter = replaceMetadataValues(sourceAfter, 'doc', docReplacements)
  sourceAfter = replaceDependencyIds(sourceAfter, nodeReplacements)
  sourceAfter = rewriteMovedFileRelativeSpecifiers(sourceAfter, sourceRel, destinationRel)
  writeFileSync(sourcePath, sourceAfter)

  mkdirSync(dirname(destinationPath), { recursive: true })
  renameSync(sourcePath, destinationPath)

  const movedDocs = moveDocFiles(rootDir, docReplacements)

  invalidateCache(rootDir)

  return {
    source: sourceRel,
    destination: destinationRel,
    movedNodes: [...nodeReplacements.entries()].map(([from, to]) => ({ from, to })),
    updatedFiles,
    movedDocs,
  }
}

function resolveSourceFile(rootDir: string, source: string): string | null {
  const candidates: string[] = []
  const direct = isAbsolute(source) ? source : resolve(rootDir, source)
  candidates.push(direct)

  if (!hasSourceExtension(source)) {
    for (const ext of SOURCE_EXTENSIONS) {
      candidates.push(`${direct}${ext}`)
    }
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate
      }
    } catch {
      // skip unreadable candidates
    }
  }

  return null
}

function resolveDestinationRel(rootDir: string, destination: string, sourceRel: string): string {
  const sourceFileName = basename(sourceRel)
  const sourceExt = sourceFileName.match(/\.(ts|tsx|js|jsx|py)$/)?.[0] ?? ''
  const destinationPath = isAbsolute(destination) ? destination : resolve(rootDir, destination)
  const looksLikeDirectory =
    /[\\/]$/.test(destination) ||
    (existsSync(destinationPath) && statSync(destinationPath).isDirectory())

  let destinationRel = normalizePath(relative(rootDir, destinationPath))
  if (looksLikeDirectory) {
    destinationRel = normalizePath(join(destinationRel, sourceFileName))
  } else if (!hasSourceExtension(destinationRel)) {
    destinationRel += sourceExt
  }

  if (destinationRel === '..' || destinationRel.startsWith('../')) {
    throw new Error('Destination must stay inside the project root')
  }

  return destinationRel
}

function buildDocReplacements(
  nodes: Array<{ id: string; doc: string }>,
  nodeReplacements: Map<string, string>,
): Map<string, string> {
  const docReplacements = new Map<string, string>()

  for (const node of nodes) {
    const newId = nodeReplacements.get(node.id)
    if (!newId || !node.doc || !node.doc.includes(node.id)) continue
    docReplacements.set(node.doc, node.doc.replace(node.id, newId))
  }

  return docReplacements
}

function moveDocFiles(rootDir: string, docReplacements: Map<string, string>): string[] {
  const movedDocs: string[] = []

  for (const [oldDoc, newDoc] of docReplacements) {
    if (oldDoc === newDoc) continue

    const oldPath = resolve(rootDir, oldDoc)
    const newPath = resolve(rootDir, newDoc)
    if (!existsSync(oldPath) || existsSync(newPath)) continue

    mkdirSync(dirname(newPath), { recursive: true })
    renameSync(oldPath, newPath)
    movedDocs.push(`${oldDoc} -> ${newDoc}`)
  }

  return movedDocs
}

const GRAPH_CONTAINER_RE = /\/\*\*[\s\S]*?\*\/|"""[\s\S]*?"""|'''[\s\S]*?'''/g

function updateGraphContainers(content: string, updater: (block: string) => string): string {
  return content.replace(GRAPH_CONTAINER_RE, block => {
    if (!/@graph\b/.test(block)) return block
    return updater(block)
  })
}

function replaceMetadataValues(
  content: string,
  field: string,
  replacements: Map<string, string>,
): string {
  return updateGraphContainers(content, block => {
    let updated = block
    for (const [from, to] of replacements) {
      updated = updated.replace(
        new RegExp(`(^\\s*(?:\\*\\s*)?${field}:\\s*)${escapeRegExp(from)}\\s*$`, 'gm'),
        `$1${to}`,
      )
    }
    return updated
  })
}

function replaceDependencyIds(content: string, replacements: Map<string, string>): string {
  return updateGraphContainers(content, block =>
    block.replace(/(dependencies:\s*\[)([\s\S]*?)(\])/g, (_match, prefix: string, body: string, suffix: string) =>
      `${prefix}${replaceDependencyList(body, replacements)}${suffix}`),
  )
}

function replaceDependencyList(body: string, replacements: Map<string, string>): string {
  return body
    .split(',')
    .map(item => {
      const trimmed = item.trim()
      if (!trimmed) return item

      const unquoted = trimmed.replace(/^['"]|['"]$/g, '')
      const replacement = replacements.get(unquoted)
      if (!replacement) return item

      const leading = item.match(/^\s*/)?.[0] ?? ''
      const trailing = item.match(/\s*$/)?.[0] ?? ''
      const quote = trimmed.startsWith('"') ? '"' : trimmed.startsWith("'") ? "'" : ''
      const value = quote ? `${quote}${replacement}${quote}` : replacement
      return `${leading}${value}${trailing}`
    })
    .join(',')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const MODULE_SPECIFIER_RE = /((?:from|import|require)\s*(?:\(\s*)?)(['"])([^'"]+)\2/g

function replaceModuleSpecifiersForMove(
  content: string,
  fromFileRel: string,
  oldSourceRel: string,
  newSourceRel: string,
): string {
  const oldBase = stripSourceExtension(oldSourceRel)

  return content.replace(MODULE_SPECIFIER_RE, (match, prefix: string, quote: string, specifier: string) => {
    const targetRel = resolveLocalSpecifier(fromFileRel, specifier)
    if (!targetRel || stripSourceExtension(targetRel) !== oldBase) return match

    const nextSpecifier = makeModuleSpecifier(fromFileRel, newSourceRel, specifier)
    return `${prefix}${quote}${nextSpecifier}${quote}`
  })
}

function rewriteMovedFileRelativeSpecifiers(
  content: string,
  oldFileRel: string,
  newFileRel: string,
): string {
  return content.replace(MODULE_SPECIFIER_RE, (match, prefix: string, quote: string, specifier: string) => {
    if (!specifier.startsWith('.')) return match

    const targetRel = resolveLocalSpecifier(oldFileRel, specifier)
    if (!targetRel) return match

    const nextSpecifier = makeModuleSpecifier(newFileRel, targetRel, specifier)
    return `${prefix}${quote}${nextSpecifier}${quote}`
  })
}

function resolveLocalSpecifier(fromFileRel: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) {
    return normalizePath(`src/${specifier.slice(2)}`)
  }
  if (!specifier.startsWith('.')) return null

  return normalizePath(normalizeFsPath(join(dirname(fromFileRel), specifier)))
}

function makeModuleSpecifier(fromFileRel: string, targetRel: string, originalSpecifier: string): string {
  const includeExtension = hasSourceExtension(originalSpecifier)

  if (originalSpecifier.startsWith('@/') && targetRel.startsWith('src/')) {
    const aliasTarget = targetRel.slice('src/'.length)
    return `@/${includeExtension ? aliasTarget : stripSourceExtension(aliasTarget)}`
  }

  const targetForSpecifier = includeExtension ? targetRel : stripSourceExtension(targetRel)
  let next = normalizePath(relative(dirname(fromFileRel), targetForSpecifier))
  if (!next.startsWith('.')) next = `./${next}`
  return next
}

// ── Spec stubs (SDD-aware) ──

export function createSpecStubs(rootDir: string): string[] {
  const observed = observeMethodologies(rootDir, discoverSourceRoots(rootDir))

  if (!observed.sdd.observed && !observed.cdd.observed) return []

  const specsDir = resolve(rootDir, observed.sdd.specsPath ?? 'Docs/specs')
  mkdirSync(specsDir, { recursive: true })

  const created: string[] = []

  // Check for existing contracts
  if (observed.cdd.observed && observed.cdd.contractsPath) {
    const contractsDir = resolve(rootDir, observed.cdd.contractsPath)
    if (existsSync(contractsDir)) {
      const typeFiles = readdirSync(contractsDir).filter(f => hasSourceExtension(f) && f !== '.gitkeep')
      for (const file of typeFiles) {
        const featureName = stripSourceExtension(file)
        const specPath = join(specsDir, `${featureName}.spec.md`)
        if (!existsSync(specPath)) {
          writeFileSync(specPath, [
            `# ${featureName} — Specification`,
            '',
            '## Overview',
            '',
            'TBD — auto-generated during onboarding.',
            '',
            '## Requirements',
            '',
            '- ',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] ',
            '',
          ].join('\n'))
          created.push(relative(rootDir, specPath))
        }
      }
    }
  }

  // Always create INDEX spec
  const indexPath = join(specsDir, 'INDEX.spec.md')
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, [
      '# Project Specification Index',
      '',
      '## Project Overview',
      '',
      'TBD.',
      '',
      '## Architecture',
      '',
      'TBD.',
      '',
      '## Feature Specs',
      '',
      ...(created.length > 0 ? created.map(c => `- [${basename(c)}](${basename(c)})`) : ['- (none yet)']),
      '',
    ].join('\n'))
    created.push(relative(rootDir, indexPath))
  }

  return created
}
