import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { extractPythonDependencies, extractPythonGraphBlocks } from './parser-py'
import { deriveTsFacts } from './derive'

export interface GraphNode {
  id: string
  category: string
  summary: string
  /** Effective dependencies: declared ∪ derived (SPEC §6.1) */
  dependencies: string[]
  /** Effective exports: derived when derivable, declared otherwise (SPEC §6.2) */
  exports: string[]
  doc: string
  spec?: string
  filePath: string
  declaredDependencies?: string[]
  declaredExports?: string[]
  derivedDependencies?: string[]
  derivedExports?: string[]
}

export interface GraphConfig {
  methodologies: Record<string, {
    enabled: boolean
    description: string
    contractsPath?: string
    testsPath?: string
    specsPath?: string
    rules?: Record<string, boolean>
  }>
  categories: Record<string, { description: string; color: string }>
  architectureRules: Record<string, boolean>
}

export interface ParseError {
  filePath: string
  message: string
}

export interface ParseResult {
  nodes: GraphNode[]
  errors: ParseError[]
}

export interface ObservedMethodologies {
  cdd: { observed: boolean; evidence: string[]; contractsPath: string | null }
  tdd: { observed: boolean; evidence: string[]; testsPath: string | null; framework: string | null }
  sdd: { observed: boolean; evidence: string[]; specsPath: string | null }
}

export interface NormalizedConfig {
  project: { sourceRoots: string[] }
  categories_meta: Record<string, { description: string; color: string }>
  methodologies_meta: Record<string, { contractsPath?: string; testsPath?: string; specsPath?: string; framework?: string }>
  architectureRules: Record<string, unknown>
  _legacy: boolean
}

// ── Source root discovery ──

const SOURCE_CANDIDATES = ['src', 'lib', 'app', 'source']
const CONTRACT_DIR_NAMES = ['types', 'interfaces', 'contracts', 'schemas', 'models', 'dto']
const TEST_FILE_PATTERNS = [
  '.test.ts',
  '.spec.ts',
  '.test.tsx',
  '.spec.tsx',
  '.test.js',
  '.spec.js',
  '.test.jsx',
  '.spec.jsx',
  '.test.py',
  '.spec.py',
]
const TEST_DIR_NAMES = ['__tests__', 'tests', 'spec', 'test']
const SPEC_FILE_PATTERN = '.spec.md'
const SPEC_DIR_CANDIDATES = ['Docs/specs', 'specs', 'docs/specs', 'specifications']
const TS_JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']
const SOURCE_EXTENSIONS = [...TS_JS_EXTENSIONS, '.py']

function hasSourceExtension(fileName: string, extensions = SOURCE_EXTENSIONS): boolean {
  return extensions.some(ext => fileName.endsWith(ext))
}

function stripSourceExtension(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx|py)$/, '')
}

export function discoverSourceRoots(rootDir: string): string[] {
  const found: string[] = []

  // Check common source directories
  for (const candidate of SOURCE_CANDIDATES) {
    const full = resolve(rootDir, candidate)
    if (existsSync(full) && statSync(full).isDirectory()) {
      found.push(candidate)
    }
  }

  // Try reading tsconfig.json for rootDir/include
  if (found.length === 0) {
    const tsconfigPath = resolve(rootDir, 'tsconfig.json')
    if (existsSync(tsconfigPath)) {
      try {
        const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf-8'))
        if (tsconfig.include && Array.isArray(tsconfig.include)) {
          for (const pattern of tsconfig.include) {
            const clean = pattern.replace(/\/\*$/, '').replace(/\/\*\*\/\*$/, '')
            if (clean && existsSync(resolve(rootDir, clean))) {
              found.push(clean)
            }
          }
        }
      } catch { /* ignore invalid tsconfig */ }
    }
  }

  // Fallback
  if (found.length === 0 && existsSync(resolve(rootDir, 'src'))) {
    found.push('src')
  }

  return found
}

// ── Category discovery from directory structure ──

export function discoverCategories(rootDir: string, sourceRoots: string[]): Map<string, string[]> {
  const categories = new Map<string, string[]>()

  for (const srcRoot of sourceRoots) {
    const srcDir = resolve(rootDir, srcRoot)
    if (!existsSync(srcDir)) continue

    for (const entry of readdirSync(srcDir)) {
      const full = join(srcDir, entry)
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue

      let stat: ReturnType<typeof statSync>
      try { stat = statSync(full) } catch { continue }

      if (stat.isDirectory()) {
        const catFiles = walkDir(full, SOURCE_EXTENSIONS)
          .map(f => relative(rootDir, f))
          .sort()
        if (catFiles.length > 0) {
          categories.set(entry, catFiles)
        }
      } else if (hasSourceExtension(entry) && !entry.endsWith('.d.ts')) {
        const list = categories.get('root') ?? []
        list.push(relative(rootDir, full))
        categories.set('root', list)
      }
    }
  }

  return categories
}

// ── Methodology observation from disk ──

export function observeMethodologies(
  rootDir: string,
  sourceRoots: string[],
): ObservedMethodologies {
  const evidence = {
    cdd: { observed: false, evidence: [] as string[], contractsPath: null as string | null },
    tdd: { observed: false, evidence: [] as string[], testsPath: null as string | null, framework: null as string | null },
    sdd: { observed: false, evidence: [] as string[], specsPath: null as string | null },
  }

  // ── CDD: contract directories ──
  for (const srcRoot of sourceRoots) {
    const srcDir = resolve(rootDir, srcRoot)
    if (!existsSync(srcDir)) continue

    for (const dirName of CONTRACT_DIR_NAMES) {
      const full = join(srcDir, dirName)
      if (!existsSync(full)) continue
      try {
        const entries = readdirSync(full).filter(e =>
          hasSourceExtension(e) && !e.endsWith('.d.ts') && !e.startsWith('.'),
        )
        if (entries.length > 0) {
          evidence.cdd.observed = true
          evidence.cdd.evidence.push(...entries.map(e => `${srcRoot}/${dirName}/${e}`))
          if (!evidence.cdd.contractsPath) {
            evidence.cdd.contractsPath = `${srcRoot}/${dirName}`
          }
        }
      } catch { /* skip */ }
    }
  }

  // ── TDD: test files ──
  for (const srcRoot of sourceRoots) {
    const srcDir = resolve(rootDir, srcRoot)
    if (!existsSync(srcDir)) continue

    // Check for dedicated test directories
    for (const testDirName of TEST_DIR_NAMES) {
      const testDir = join(srcDir, testDirName)
      if (existsSync(testDir)) {
        try {
          const testFiles = walkDir(testDir, SOURCE_EXTENSIONS)
            .filter(f => TEST_FILE_PATTERNS.some(p => f.endsWith(p)))
          if (testFiles.length > 0) {
            evidence.tdd.observed = true
            evidence.tdd.evidence.push(
              ...testFiles.map(f => relative(rootDir, f)),
            )
            if (!evidence.tdd.testsPath) {
              evidence.tdd.testsPath = relative(rootDir, testDir)
            }
          }
        } catch { /* skip */ }
      }
    }

    // Check for test files anywhere in source
    try {
      const allFiles = walkDir(srcDir, SOURCE_EXTENSIONS)
      for (const f of allFiles) {
        if (TEST_FILE_PATTERNS.some(p => f.endsWith(p))) {
          const rel = relative(rootDir, f)
          if (!evidence.tdd.evidence.includes(rel)) {
            evidence.tdd.evidence.push(rel)
          }
          evidence.tdd.observed = true
          if (!evidence.tdd.testsPath) {
            // Infer testsPath from the first test file's directory
            evidence.tdd.testsPath = dirname(rel)
          }
        }
      }
    } catch { /* skip */ }

    // Detect test framework from package.json
    try {
      const pkgPath = resolve(rootDir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        const deps = { ...pkg.devDependencies, ...pkg.dependencies }
        if (deps.vitest) evidence.tdd.framework = 'vitest'
        else if (deps.jest) evidence.tdd.framework = 'jest'
        else if (deps.mocha) evidence.tdd.framework = 'mocha'
      }
    } catch { /* skip */ }
  }

  // ── SDD: spec files ──
  for (const specDirCandidate of SPEC_DIR_CANDIDATES) {
    const full = resolve(rootDir, specDirCandidate)
    if (!existsSync(full)) continue
    try {
      const specFiles = walkDir(full, ['.md'])
        .filter(f => f.endsWith(SPEC_FILE_PATTERN))
      if (specFiles.length > 0) {
        evidence.sdd.observed = true
        evidence.sdd.evidence.push(
          ...specFiles.map(f => relative(rootDir, f)),
        )
        if (!evidence.sdd.specsPath) {
          evidence.sdd.specsPath = specDirCandidate
        }
      }
    } catch { /* skip */ }
  }

  // Also check for .spec.md anywhere in Docs/
  const docsDir = resolve(rootDir, 'Docs')
  if (existsSync(docsDir) && !evidence.sdd.observed) {
    try {
      const mdFiles = walkDir(docsDir, ['.md'])
        .filter(f => f.endsWith('.spec.md'))
      if (mdFiles.length > 0) {
        evidence.sdd.observed = true
        evidence.sdd.evidence.push(...mdFiles.map(f => relative(rootDir, f)))
        evidence.sdd.specsPath = 'Docs'
      }
    } catch { /* skip */ }
  }

  return evidence
}

export function loadConfig(rootDir: string): GraphConfig {
  try {
    const raw = readFileSync(resolve(rootDir, 'graph.config.json'), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { methodologies: {}, categories: {}, architectureRules: {} }
  }
}

// ── Config normalization (backwards compat) ──

export function normalizeConfig(raw: GraphConfig): NormalizedConfig {
  const normalized: NormalizedConfig = {
    project: { sourceRoots: [] },
    categories_meta: {},
    methodologies_meta: {},
    architectureRules: { ...raw.architectureRules },
    _legacy: false,
  }

  // Migrate old "categories" to "categories_meta"
  if (raw.categories && Object.keys(raw.categories).length > 0) {
    normalized.categories_meta = { ...raw.categories }
    normalized._legacy = true
  }

  // Migrate old "methodologies" to "methodologies_meta"
  if (raw.methodologies && Object.keys(raw.methodologies).length > 0) {
    for (const [key, m] of Object.entries(raw.methodologies)) {
      const entry: { contractsPath?: string; testsPath?: string; specsPath?: string; framework?: string } = {}
      if (m.contractsPath) entry.contractsPath = m.contractsPath
      if (m.testsPath) entry.testsPath = m.testsPath
      if (m.specsPath) entry.specsPath = m.specsPath
      if (Object.keys(entry).length > 0) {
        normalized.methodologies_meta[key] = entry
      }
    }
    if (Object.keys(normalized.methodologies_meta).length > 0) {
      normalized._legacy = true
    }
  }

  // Merge any top-level "categories_meta" or "methodologies_meta" if already in new format
  const rawAny = raw as unknown as Record<string, unknown>
  if (rawAny.categories_meta && typeof rawAny.categories_meta === 'object') {
    normalized.categories_meta = { ...normalized.categories_meta, ...rawAny.categories_meta as Record<string, { description: string; color: string }> }
    normalized._legacy = false
  }
  if (rawAny.methodologies_meta && typeof rawAny.methodologies_meta === 'object') {
    normalized.methodologies_meta = { ...normalized.methodologies_meta, ...rawAny.methodologies_meta as Record<string, { contractsPath?: string; testsPath?: string; specsPath?: string }> }
    normalized._legacy = false
  }
  if (rawAny.project && typeof rawAny.project === 'object') {
    const p = rawAny.project as Record<string, unknown>
    if (Array.isArray(p.sourceRoots)) {
      normalized.project.sourceRoots = p.sourceRoots as string[]
    }
    normalized._legacy = false
  }

  return normalized
}

// ── Cache helpers ──
function cachePath(rootDir: string): string {
  // v2: nodes carry declared/derived fields — path bump invalidates pre-spec caches
  return resolve(rootDir, 'node_modules', '.cache', 'frontgraph', 'nodes-v2.json')
}

function fileHash(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8')
  return createHash('md5').update(content).digest('hex')
}

function readCache(rootDir: string): { files: Record<string, string>; nodes: GraphNode[] } | null {
  const cp = cachePath(rootDir)
  if (!existsSync(cp)) return null
  try {
    return JSON.parse(readFileSync(cp, 'utf-8'))
  } catch {
    return null
  }
}

function writeCache(rootDir: string, files: Record<string, string>, nodes: GraphNode[]): void {
  const cp = cachePath(rootDir)
  mkdirSync(dirname(cp), { recursive: true })
  writeFileSync(cp, JSON.stringify({ files, nodes }, null, 2))
}

// ── @graph block extraction ──

/** Match JSDoc blocks. @graph filtering happens after star-stripping. */
const JS_DOC_BLOCK_RE = /\/\*\*([\s\S]*?)\*\//g

/** Known categories loaded from config — set via setKnownCategories before parsing */
let knownCategories: Set<string> = new Set()

export function setKnownCategories(cats: string[]): void {
  knownCategories = new Set(cats)
}

function extractJsGraphBlocks(content: string): string[] {
  const blocks: string[] = []

  for (const match of content.matchAll(JS_DOC_BLOCK_RE)) {
    const block = stripJsDocStars(match[1])
    if (/@graph\b/.test(block)) {
      blocks.push(block)
    }
  }

  return blocks
}

function stripJsDocStars(rawBlock: string): string {
  return rawBlock
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
}

function extractField(block: string, field: string): string | undefined {
  const match = block.match(new RegExp(`^\\s*${field}:\\s*(.+)$`, 'm'))
  return match?.[1]?.trim()
}

function extractListField(block: string, field: string): string[] {
  const match = block.match(new RegExp(`${field}:\\s*\\[([\\s\\S]*?)\\]`, 'm'))
  if (!match) return []

  return match[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

function extractGraphBlock(
  block: string,
  filePath: string,
  errors: ParseError[],
  autoDependencies: string[] = [],
  autoExports: string[] | null = null,
): GraphNode | null {
  // Extract fields with multiline-aware regex
  const id = extractField(block, 'id')

  const rawCategory = extractField(block, 'category') ?? 'unknown'
  const category = rawCategory

  const rawSummary = extractField(block, 'summary')
  const summary = rawSummary

  const declaredDeps = extractListField(block, 'dependencies')
  const deps = [...new Set([...declaredDeps, ...autoDependencies])]

  const declaredExports = extractListField(block, 'exports')
  // Derived exports are the truth when derivable (SPEC §6.2)
  const exports_ = autoExports ?? declaredExports

  const doc = extractField(block, 'doc')
  const spec = extractField(block, 'spec')

  // Validate required fields
  if (!id) {
    errors.push({ filePath, message: '@graph block missing required field: id' })
    return null
  }
  if (!summary) {
    errors.push({ filePath, message: `@graph block missing required field: summary (id: ${id})` })
    return null
  }

  // Categories may be semantic (for example "ui" or "contract") rather than
  // matching directory names, so category discovery is informational only.

  // Validate id matches file path convention (normalize slashes for cross-platform)
  const expectedId = stripSourceExtension(filePath.replace(/\\/g, '/'))
  const normalizedId = id.replace(/\\/g, '/')
  const baseId = normalizedId.split('#')[0]
  if (baseId !== expectedId) {
    errors.push({
      filePath,
      message: `@graph id "${id}" does not match file path "${expectedId}"`,
    })
  }

  return {
    id,
    category,
    summary,
    dependencies: deps,
    exports: exports_,
    doc: doc ?? '',
    spec,
    filePath,
    declaredDependencies: declaredDeps,
    declaredExports,
    derivedDependencies: autoDependencies,
    derivedExports: autoExports ?? undefined,
  }
}

function extractGraphBlocks(
  content: string,
  filePath: string,
  rootDir: string,
  sourceRoots: string[],
  errors: ParseError[],
): GraphNode[] {
  const isPython = filePath.endsWith('.py')
  const blocks = isPython
    ? extractPythonGraphBlocks(content)
    : extractJsGraphBlocks(content)
  if (blocks.length === 0) return []

  let autoDependencies: string[]
  let autoExports: string[] | null = null
  if (isPython) {
    autoDependencies = extractPythonDependencies(content, filePath, rootDir, sourceRoots)
  } else {
    const facts = deriveTsFacts(content, filePath, rootDir)
    autoDependencies = facts.dependencies
    // Export derivation is file-granular: only meaningful for single-block files (SPEC §5.3)
    if (blocks.length === 1) autoExports = facts.exports
  }
  const nodes: GraphNode[] = []

  for (const block of blocks) {
    const node = extractGraphBlock(block, filePath, errors, autoDependencies, autoExports)
    if (node) nodes.push(node)
  }

  return nodes
}

// ── File system walker ──
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '__pycache__', '.claude'])

function walkDir(dir: string, extensions: string[]): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue

    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(full)
    } catch {
      continue // skip unreadable files
    }

    if (stat.isDirectory()) {
      files.push(...walkDir(full, extensions))
    } else if (entry.endsWith('.d.ts')) {
      // skip declaration files
    } else if (extensions.some(ext => entry.endsWith(ext))) {
      files.push(full)
    }
  }
  return files
}

// ── Main parse function with caching ──
export function parseProject(rootDir: string): GraphNode[] {
  return parseProjectWithErrors(rootDir).nodes
}

export function parseProjectWithErrors(rootDir: string): ParseResult {
  const config = loadConfig(rootDir)
  const normalized = normalizeConfig(config)

  // Discover source roots and categories
  const sourceRoots = normalized.project.sourceRoots.length > 0
    ? normalized.project.sourceRoots
    : discoverSourceRoots(rootDir)

  const discoveredCategories = discoverCategories(rootDir, sourceRoots)
  setKnownCategories([...discoveredCategories.keys()])

  // Walk all source roots
  let files: string[] = []
  for (const srcRoot of sourceRoots) {
    const srcDir = resolve(rootDir, srcRoot)
    if (existsSync(srcDir)) {
      files.push(...walkDir(srcDir, SOURCE_EXTENSIONS))
    }
  }
  files = files.sort()

  if (files.length === 0) return { nodes: [], errors: [] }

  // Check cache
  const cache = readCache(rootDir)
  if (cache) {
    let cacheValid = true
    const fileHashes: Record<string, string> = {}

    for (const file of files) {
      const rel = relative(rootDir, file)
      const hash = fileHash(file)
      fileHashes[rel] = hash
      if (cache.files[rel] !== hash) {
        cacheValid = false
        // Don't break — collect all hashes for cache update
      }
    }

    // Also check for removed files
    for (const cachedFile of Object.keys(cache.files)) {
      if (!fileHashes[cachedFile]) {
        cacheValid = false
        break
      }
    }

    if (cacheValid) return { nodes: cache.nodes, errors: [] }

    // Partial cache: only re-parse changed files
    const cachedNodes = new Map<string, GraphNode[]>()
    for (const n of cache.nodes) {
      const fileNodes = cachedNodes.get(n.filePath) ?? []
      fileNodes.push(n)
      cachedNodes.set(n.filePath, fileNodes)
    }

    const nodes: GraphNode[] = []
    const errors: ParseError[] = []

    for (const file of files) {
      const rel = relative(rootDir, file)
      if (cache.files[rel] === fileHashes[rel]) {
        nodes.push(...(cachedNodes.get(rel) ?? []))
        continue
      }
      const content = readFileSync(file, 'utf-8')
      nodes.push(...extractGraphBlocks(content, rel, rootDir, sourceRoots, errors))
    }

    writeCache(rootDir, fileHashes, nodes)
    return { nodes, errors }
  }

  // Full parse
  const nodes: GraphNode[] = []
  const errors: ParseError[] = []
  const fileHashes: Record<string, string> = {}

  for (const file of files) {
    const rel = relative(rootDir, file)
    fileHashes[rel] = fileHash(file)
    const content = readFileSync(file, 'utf-8')
    nodes.push(...extractGraphBlocks(content, rel, rootDir, sourceRoots, errors))
  }

  writeCache(rootDir, fileHashes, nodes)
  return { nodes, errors }
}

/** Invalidate the cache (e.g., after scaffold/retrofit) */
export function invalidateCache(rootDir: string): void {
  const cp = cachePath(rootDir)
  if (existsSync(cp)) {
    try {
      rmSync(cp)
    } catch {
      // ok
    }
  }
}
