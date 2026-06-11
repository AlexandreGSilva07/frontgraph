import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseProjectWithErrors } from '../src/parser'
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

describe('parseProjectWithErrors — TS/JS', () => {
  it('extracts a complete @graph block from a JSDoc comment', () => {
    const root = project({
      'src/logic/pricing.ts': tsFileWithGraph('src/logic/pricing', {
        category: 'logic',
        summary: 'Pricing engine',
        dependencies: ['src/types/orders'],
        exports: ['price', 'recalc'],
        doc: 'Docs/src/logic/pricing.md',
      }),
    })

    const { nodes, errors } = parseProjectWithErrors(root)

    expect(errors).toEqual([])
    expect(nodes).toHaveLength(1)
    const node = nodes[0]
    expect(node.id).toBe('src/logic/pricing')
    expect(node.category).toBe('logic')
    expect(node.summary).toBe('Pricing engine')
    expect(node.dependencies).toEqual(['src/types/orders'])
    // SPEC §6.2: derived exports are the effective truth for single-block TS files
    expect(node.exports).toEqual(['placeholder'])
    expect(node.declaredExports).toEqual(['price', 'recalc'])
    expect(node.declaredDependencies).toEqual(['src/types/orders'])
    expect(node.derivedDependencies).toEqual([])
    expect(node.doc).toBe('Docs/src/logic/pricing.md')
  })

  it('auto-derives TS dependencies from imports on every parse (SPEC §6.1)', () => {
    const root = project({
      'src/types/orders.ts': tsFileWithGraph('src/types/orders', { summary: 'Orders' }),
      'src/logic/calc.ts': [
        '/**',
        ' * @graph',
        ' * id: src/logic/calc',
        ' * category: logic',
        ' * summary: Calculator',
        ' * dependencies: []',
        ' * exports: []',
        ' */',
        '',
        "import { placeholder } from '../types/orders'",
        'export function total(): number { return placeholder }',
        '',
      ].join('\n'),
    })

    const { nodes, errors } = parseProjectWithErrors(root)

    expect(errors).toEqual([])
    const calc = nodes.find(n => n.id === 'src/logic/calc')!
    expect(calc.dependencies).toContain('src/types/orders')
    expect(calc.derivedDependencies).toEqual(['src/types/orders'])
    expect(calc.exports).toEqual(['total'])
  })

  it('extracts multiple anchored @graph blocks from a single file', () => {
    const root = project({
      'src/utils/math.ts': [
        tsFileWithGraph('src/utils/math#formatters', { category: 'utils', summary: 'Formatters' }),
        tsFileWithGraph('src/utils/math#rounding', {
          category: 'utils',
          summary: 'Rounding',
          dependencies: ['src/utils/math#formatters'],
        }),
      ].join('\n'),
    })

    const { nodes, errors } = parseProjectWithErrors(root)

    expect(errors).toEqual([])
    expect(nodes.map(n => n.id).sort()).toEqual([
      'src/utils/math#formatters',
      'src/utils/math#rounding',
    ])
  })

  it('reports an error and drops the node when id is missing', () => {
    const root = project({
      'src/a.ts': '/**\n * @graph\n * summary: No id here\n */\nexport const a = 1\n',
    })

    const { nodes, errors } = parseProjectWithErrors(root)

    expect(nodes).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('missing required field: id')
  })

  it('reports an error and drops the node when summary is missing', () => {
    const root = project({
      'src/a.ts': '/**\n * @graph\n * id: src/a\n */\nexport const a = 1\n',
    })

    const { nodes, errors } = parseProjectWithErrors(root)

    expect(nodes).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('missing required field: summary')
  })

  it('flags id/path mismatch but still returns the node', () => {
    const root = project({
      'src/a.ts': tsFileWithGraph('src/wrong-name', { summary: 'Mismatched id' }),
    })

    const { nodes, errors } = parseProjectWithErrors(root)

    expect(nodes).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('does not match file path')
  })

  it('ignores files without @graph blocks', () => {
    const root = project({
      'src/plain.ts': 'export const nothing = true\n',
      'src/annotated.ts': tsFileWithGraph('src/annotated', { summary: 'Annotated' }),
    })

    const { nodes } = parseProjectWithErrors(root)

    expect(nodes.map(n => n.id)).toEqual(['src/annotated'])
  })
})

describe('parseProjectWithErrors — Python', () => {
  it('extracts @graph from docstrings and auto-derives local import dependencies', () => {
    const root = project({
      'src/workers/client.py': [
        '"""',
        '@graph',
        'id: src/workers/client',
        'category: workers',
        'summary: Fetches pending work',
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
        'summary: Reconciles pending orders',
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

    const { nodes, errors } = parseProjectWithErrors(root)

    expect(errors).toEqual([])
    const reconcile = nodes.find(n => n.id === 'src/workers/reconcile')
    expect(reconcile).toBeDefined()
    // Auto-derived from the `from .client import ...` statement
    expect(reconcile!.dependencies).toContain('src/workers/client')
  })
})

describe('parseProjectWithErrors — cache liveness', () => {
  it('reflects file edits on the next parse (MD5 invalidation)', () => {
    const root = project({
      'src/a.ts': tsFileWithGraph('src/a', { summary: 'first version' }),
    })

    const first = parseProjectWithErrors(root)
    expect(first.nodes[0].summary).toBe('first version')

    writeFileSync(
      join(root, 'src', 'a.ts'),
      tsFileWithGraph('src/a', { summary: 'second version' }),
    )

    const second = parseProjectWithErrors(root)
    expect(second.nodes[0].summary).toBe('second version')
  })

  it('drops nodes for files removed between parses', () => {
    const root = project({
      'src/a.ts': tsFileWithGraph('src/a', { summary: 'A' }),
      'src/b.ts': tsFileWithGraph('src/b', { summary: 'B' }),
    })

    expect(parseProjectWithErrors(root).nodes).toHaveLength(2)

    rmSync(join(root, 'src', 'b.ts'))

    const after = parseProjectWithErrors(root)
    expect(after.nodes.map(n => n.id)).toEqual(['src/a'])
  })

  it('picks up files created between parses', () => {
    const root = project({
      'src/a.ts': tsFileWithGraph('src/a', { summary: 'A' }),
    })

    expect(parseProjectWithErrors(root).nodes).toHaveLength(1)

    writeFileSync(
      join(root, 'src', 'b.ts'),
      tsFileWithGraph('src/b', { summary: 'B' }),
    )

    const after = parseProjectWithErrors(root)
    expect(after.nodes.map(n => n.id).sort()).toEqual(['src/a', 'src/b'])
  })
})
