import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

/** Create a throwaway project directory from a map of relative path → content. */
export function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'frontgraph-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

export function cleanupProject(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

export function tsFileWithGraph(id: string, opts: {
  category?: string
  summary?: string
  dependencies?: string[]
  exports?: string[]
  doc?: string
  body?: string
} = {}): string {
  const deps = opts.dependencies ?? []
  const exps = opts.exports ?? []
  return [
    '/**',
    ' * @graph',
    ` * id: ${id}`,
    ` * category: ${opts.category ?? 'logic'}`,
    ` * summary: ${opts.summary ?? `Summary for ${id}`}`,
    ` * dependencies: [${deps.join(', ')}]`,
    ` * exports: [${exps.join(', ')}]`,
    ...(opts.doc ? [` * doc: ${opts.doc}`] : []),
    ' */',
    '',
    opts.body ?? 'export const placeholder = 1',
    '',
  ].join('\n')
}
