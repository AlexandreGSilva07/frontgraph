import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const PY_DOCSTRING_RE = /("""[\s\S]*?"""|'''[\s\S]*?''')/g

export function extractPythonGraphBlocks(content: string): string[] {
  const blocks: string[] = []

  for (const match of content.matchAll(PY_DOCSTRING_RE)) {
    const raw = match[1]
    const inner = raw.slice(3, -3)
    if (/@graph\b/.test(inner)) {
      blocks.push(inner)
    }
  }

  return blocks
}

export function extractPythonDependencies(
  content: string,
  filePath: string,
  rootDir: string,
  sourceRoots: string[],
): string[] {
  const deps = new Set<string>()
  const lines = content.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const importMatch = trimmed.match(/^import\s+(.+)$/)
    if (importMatch) {
      for (const entry of importMatch[1].split(',')) {
        const moduleName = entry.trim().replace(/\s+as\s+\w+$/, '')
        const dep = resolvePythonModule(moduleName, filePath, rootDir, sourceRoots)
        if (dep) deps.add(dep)
      }
      continue
    }

    const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)$/)
    if (fromMatch) {
      const moduleName = fromMatch[1]
      const dep = resolvePythonModule(moduleName, filePath, rootDir, sourceRoots)
      if (dep) deps.add(dep)
    }
  }

  return [...deps]
}

function resolvePythonModule(
  moduleName: string,
  filePath: string,
  rootDir: string,
  sourceRoots: string[],
): string | null {
  const normalizedFile = filePath.replace(/\\/g, '/')
  const modulePath = moduleName.replace(/\./g, '/')

  if (moduleName.startsWith('.')) {
    const leadingDots = moduleName.match(/^\.+/)?.[0].length ?? 0
    const rest = moduleName.slice(leadingDots).replace(/\./g, '/')
    let baseDir = dirname(normalizedFile)
    for (let i = 1; i < leadingDots; i++) {
      baseDir = dirname(baseDir)
    }
    const relativePath = rest ? `${baseDir}/${rest}` : baseDir
    return resolveCandidate(relativePath, rootDir)
  }

  for (const sourceRoot of sourceRoots) {
    const normalizedRoot = sourceRoot.replace(/\\/g, '/')
    const candidates = modulePath.startsWith(`${normalizedRoot}/`) || modulePath === normalizedRoot
      ? [modulePath]
      : [`${normalizedRoot}/${modulePath}`]

    for (const candidate of candidates) {
      const resolved = resolveCandidate(candidate, rootDir)
      if (resolved) return resolved
    }
  }

  return null
}

function resolveCandidate(candidate: string, rootDir: string): string | null {
  const normalized = candidate.replace(/\\/g, '/').replace(/\/$/, '')
  const fileCandidate = `${normalized}.py`
  if (existsSync(resolve(rootDir, fileCandidate))) {
    return normalized
  }

  const packageCandidate = `${normalized}/__init__.py`
  if (existsSync(resolve(rootDir, packageCandidate))) {
    return `${normalized}/__init__`
  }

  return null
}
