import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncGraphBlocks } from '../src/sync'
import { cleanupProject, makeProject, tsFileWithGraph } from './helpers'

const roots: string[] = []

function project(files: Record<string, string>): string {
  const root = makeProject(files)
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) cleanupProject(roots.pop()!)
})

describe('syncGraphBlocks', () => {
  it('rewrites stale dependencies and exports with the derived truth', () => {
    const root = project({
      'src/b.ts': tsFileWithGraph('src/b', { summary: 'B', exports: ['placeholder'] }),
      'src/a.ts': tsFileWithGraph('src/a', {
        summary: 'A',
        dependencies: ['src/stale'],
        exports: ['old'],
        body: [
          "import { placeholder } from './b'",
          'export const fresh = placeholder',
        ].join('\n'),
      }),
    })

    const result = syncGraphBlocks(root)

    expect(result.updated).toEqual(['src/a.ts'])
    const a = readFileSync(join(root, 'src', 'a.ts'), 'utf-8')
    expect(a).toContain('dependencies: [src/b]')
    expect(a).toContain('exports: [fresh]')
    expect(a).not.toContain('src/stale')
    expect(a).not.toContain('exports: [old]')
    // Semantic fields untouched
    expect(a).toContain('summary: A')
  })

  it('leaves files alone when declared and derived truth already agree', () => {
    const root = project({
      'src/b.ts': tsFileWithGraph('src/b', { summary: 'B', exports: ['placeholder'] }),
    })

    const result = syncGraphBlocks(root)

    expect(result.updated).toEqual([])
    expect(result.unchanged).toEqual(['src/b.ts'])
  })

  it('never touches anchored files', () => {
    const anchored = [
      tsFileWithGraph('src/utils/math#formatters', { summary: 'Formatters', exports: ['fmt'] }),
      tsFileWithGraph('src/utils/math#rounding', { summary: 'Rounding', exports: ['round'] }),
    ].join('\n')
    const root = project({ 'src/utils/math.ts': anchored })

    const result = syncGraphBlocks(root)

    expect(result.skippedAnchored).toEqual(['src/utils/math.ts'])
    expect(readFileSync(join(root, 'src', 'utils', 'math.ts'), 'utf-8')).toBe(anchored)
  })

  it('syncs derived Python dependencies but leaves Python exports declared', () => {
    const root = project({
      'src/workers/client.py': [
        '"""',
        '@graph',
        'id: src/workers/client',
        'category: workers',
        'summary: Client',
        'dependencies: []',
        'exports: [fetch_pending]',
        '"""',
        '',
        'def fetch_pending():',
        '    return []',
        '',
      ].join('\n'),
      'src/workers/reconcile.py': [
        '"""',
        '@graph',
        'id: src/workers/reconcile',
        'category: workers',
        'summary: Reconciler',
        'dependencies: []',
        'exports: [run]',
        '"""',
        '',
        'from .client import fetch_pending',
        '',
        'def run():',
        '    return fetch_pending()',
        '',
      ].join('\n'),
    })

    const result = syncGraphBlocks(root)

    expect(result.updated).toEqual(['src/workers/reconcile.py'])
    const reconcile = readFileSync(join(root, 'src', 'workers', 'reconcile.py'), 'utf-8')
    expect(reconcile).toContain('dependencies: [src/workers/client]')
    expect(reconcile).toContain('exports: [run]')
  })
})
