import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { moveGraphNode, retrofitProject } from '../src/onboard'
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

describe('retrofitProject', () => {
  it('prepends a @graph block with inferred category, deps and exports', () => {
    const root = project({
      'src/types/orders.ts': 'export interface Order { id: string }\n',
      'src/logic/calc.ts': [
        "import type { Order } from '../types/orders'",
        '',
        'export function total(o: Order): number {',
        '  return 1',
        '}',
        '',
      ].join('\n'),
    })

    const { annotated, docsCreated, skipped } = retrofitProject(root)

    expect(skipped).toEqual([])
    expect(annotated).toHaveLength(2)

    const calc = readFileSync(join(root, 'src', 'logic', 'calc.ts'), 'utf-8')
    expect(calc.startsWith('/**')).toBe(true)
    expect(calc).toContain('@graph')
    expect(calc).toContain('id: src/logic/calc')
    expect(calc).toContain('category: logic')
    expect(calc).toContain('src/types/orders')
    expect(calc).toContain('total')
    // Original content preserved below the block
    expect(calc).toContain('export function total')

    expect(docsCreated).toContain('Docs/src/logic/calc.md')
    expect(existsSync(join(root, 'Docs', 'src', 'logic', 'calc.md'))).toBe(true)
  })

  it('never overwrites files that already have a @graph block', () => {
    const annotatedContent = tsFileWithGraph('src/a', { summary: 'Hand-written' })
    const root = project({ 'src/a.ts': annotatedContent })

    const { annotated, skipped } = retrofitProject(root)

    expect(annotated).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toBe(annotatedContent)
  })
})

describe('moveGraphNode', () => {
  function moveFixture(): string {
    return project({
      'src/types/orders.ts': tsFileWithGraph('src/types/orders', {
        category: 'types',
        summary: 'Order contracts',
        exports: ['Order'],
        doc: 'Docs/src/types/orders.md',
        body: 'export interface Order { id: string }',
      }),
      'src/logic/pricing.ts': tsFileWithGraph('src/logic/pricing', {
        category: 'logic',
        summary: 'Pricing engine',
        dependencies: ['src/types/orders'],
        exports: ['price'],
        doc: 'Docs/src/logic/pricing.md',
        body: [
          "import type { Order } from '../types/orders'",
          'export function price(o: Order): number { return 1 }',
        ].join('\n'),
      }),
      'Docs/src/types/orders.md': '# orders\n',
      'Docs/src/logic/pricing.md': '# pricing\n',
    })
  }

  it('moves the file, rewrites its @graph id and doc path, and relocates the doc', () => {
    const root = moveFixture()

    const result = moveGraphNode(root, 'src/types/orders.ts', 'src/contracts/orders.ts')

    expect(result.movedNodes).toEqual([
      { from: 'src/types/orders', to: 'src/contracts/orders' },
    ])
    expect(existsSync(join(root, 'src', 'types', 'orders.ts'))).toBe(false)

    const moved = readFileSync(join(root, 'src', 'contracts', 'orders.ts'), 'utf-8')
    expect(moved).toContain('id: src/contracts/orders')
    expect(moved).toContain('doc: Docs/src/contracts/orders.md')

    expect(existsSync(join(root, 'Docs', 'src', 'contracts', 'orders.md'))).toBe(true)
    expect(existsSync(join(root, 'Docs', 'src', 'types', 'orders.md'))).toBe(false)
  })

  it('updates dependent @graph dependencies and import specifiers', () => {
    const root = moveFixture()

    const result = moveGraphNode(root, 'src/types/orders.ts', 'src/contracts/orders.ts')

    expect(result.updatedFiles).toContain('src/logic/pricing.ts')
    const pricing = readFileSync(join(root, 'src', 'logic', 'pricing.ts'), 'utf-8')
    expect(pricing).toContain('dependencies: [src/contracts/orders]')
    expect(pricing).toContain("from '../contracts/orders'")
    expect(pricing).not.toContain('src/types/orders')
  })

  it('refuses to move when the destination already exists', () => {
    const root = moveFixture()

    expect(() =>
      moveGraphNode(root, 'src/types/orders.ts', 'src/logic/pricing.ts'),
    ).toThrow(/already exists/)
  })

  it('refuses to move a file that has no @graph block', () => {
    const root = project({
      'src/plain.ts': 'export const nothing = true\n',
    })

    expect(() =>
      moveGraphNode(root, 'src/plain.ts', 'src/elsewhere.ts'),
    ).toThrow(/No @graph block/)
  })
})
