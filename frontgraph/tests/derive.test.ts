import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveTsFacts, detectDrift, resolveTsSpecifier } from '../src/derive'
import type { GraphNode } from '../src/parser'
import { cleanupProject, makeProject } from './helpers'

const roots: string[] = []

function project(files: Record<string, string>): string {
  const root = makeProject(files)
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) cleanupProject(roots.pop()!)
})

function factsFor(root: string, relPath: string) {
  const content = readFileSync(join(root, ...relPath.split('/')), 'utf-8')
  return deriveTsFacts(content, relPath, root)
}

describe('deriveTsFacts — dependencies', () => {
  it('resolves relative imports to internal node ids', () => {
    const root = project({
      'src/types/orders.ts': 'export interface Order {}',
      'src/logic/calc.ts': [
        "import type { Order } from '../types/orders'",
        'export function total(o: Order): number { return 1 }',
      ].join('\n'),
    })

    const facts = factsFor(root, 'src/logic/calc.ts')
    expect(facts.dependencies).toEqual(['src/types/orders'])
    expect(facts.exports).toEqual(['total'])
  })

  it('drops bare packages, asset imports, and unresolvable paths', () => {
    const root = project({
      'src/a.ts': [
        "import React from 'react'",
        "import './app.css'",
        "import { gone } from './missing'",
        'export const a = 1',
      ].join('\n'),
    })

    expect(factsFor(root, 'src/a.ts').dependencies).toEqual([])
  })

  it('resolves the @/ alias against src/', () => {
    const root = project({
      'src/utils/fmt.ts': 'export const fmt = (s: string) => s',
      'src/ui/view.ts': "import { fmt } from '@/utils/fmt'\nexport const view = fmt('x')",
    })

    expect(factsFor(root, 'src/ui/view.ts').dependencies).toEqual(['src/utils/fmt'])
  })

  it('resolves directory imports to index files', () => {
    const root = project({
      'src/widgets/index.ts': 'export const w = 1',
      'src/a.ts': "import { w } from './widgets'\nexport const a = w",
    })

    expect(factsFor(root, 'src/a.ts').dependencies).toEqual(['src/widgets/index'])
  })

  it('resolves NodeNext-style .js specifiers to .ts files', () => {
    const root = project({
      'src/orders.ts': 'export const o = 1',
      'src/a.ts': "import { o } from './orders.js'\nexport const a = o",
    })

    expect(factsFor(root, 'src/a.ts').dependencies).toEqual(['src/orders'])
  })

  it('captures export-from, dynamic import() and require()', () => {
    const root = project({
      'src/helper.ts': 'export const helper = 1',
      'src/dyn.ts': 'export const d = 1',
      'src/req.ts': 'export const r = 1',
      'src/a.ts': [
        "export { helper } from './helper'",
        "const m = import('./dyn')",
        "const r = require('./req')",
      ].join('\n'),
    })

    const facts = factsFor(root, 'src/a.ts')
    expect(facts.dependencies).toEqual(['src/dyn', 'src/helper', 'src/req'])
    expect(facts.exports).toEqual(['helper'])
  })
})

describe('deriveTsFacts — exports', () => {
  it('derives every export declaration form', () => {
    const root = project({
      'src/all.ts': [
        'export const a = 1',
        'export let b = 2',
        'export function fn() {}',
        'export class Klass {}',
        'export interface IFace {}',
        'export type Alias = string',
        'export enum E { X }',
        'export default function main() {}',
        'const x = 1',
        'export { x as y }',
        'export const { p, q } = { p: 1, q: 2 }',
      ].join('\n'),
    })

    const facts = factsFor(root, 'src/all.ts')
    expect(facts.exports).toEqual(
      expect.arrayContaining(['a', 'b', 'fn', 'Klass', 'IFace', 'Alias', 'E', 'main (default)', 'y', 'p', 'q']),
    )
    expect(facts.exports).toHaveLength(11)
  })

  it('reports anonymous default exports as "default"', () => {
    const root = project({ 'src/a.ts': 'export default 42' })
    expect(factsFor(root, 'src/a.ts').exports).toEqual(['default'])
  })
})

describe('resolveTsSpecifier', () => {
  it('returns null for escapes above the project root', () => {
    const root = project({ 'src/a.ts': 'export const a = 1' })
    expect(resolveTsSpecifier('../../outside', 'src/a.ts', root)).toBeNull()
  })
})

describe('detectDrift', () => {
  function node(id: string, extra: Partial<GraphNode> = {}): GraphNode {
    return {
      id,
      category: 'logic',
      summary: `Summary for ${id}`,
      dependencies: [],
      exports: [],
      doc: '',
      filePath: `${id}.ts`,
      ...extra,
    }
  }

  it('flags derived dependencies missing from the declared list', () => {
    const issues = detectDrift([
      node('src/a', { declaredDependencies: [], derivedDependencies: ['src/b'] }),
      node('src/b'),
    ])

    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('undeclared-dependency')
    expect(issues[0].detail).toContain('src/b')
  })

  it('flags declared dependencies on internal nodes the code never imports', () => {
    const issues = detectDrift([
      node('src/a', { declaredDependencies: ['src/b'], derivedDependencies: [] }),
      node('src/b'),
    ])

    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('stale-dependency')
  })

  it('does not flag declared dependencies that are not graph nodes (externals)', () => {
    const issues = detectDrift([
      node('src/a', { declaredDependencies: ['react', 'src/gone'], derivedDependencies: [] }),
    ])

    expect(issues).toEqual([])
  })

  it('treats an anchored declaration as satisfied by a derived dep on its base file', () => {
    const issues = detectDrift([
      node('src/a', {
        declaredDependencies: ['src/utils/math#formatters'],
        derivedDependencies: ['src/utils/math'],
      }),
      node('src/utils/math#formatters', { filePath: 'src/utils/math.ts' }),
    ])

    expect(issues).toEqual([])
  })

  it('flags export drift in both directions', () => {
    const issues = detectDrift([
      node('src/a', { declaredExports: ['a', 'c'], derivedExports: ['a', 'b'] }),
    ])

    expect(issues.map(i => i.kind).sort()).toEqual(['stale-export', 'undeclared-export'])
  })

  it('skips anchored nodes entirely', () => {
    const issues = detectDrift([
      node('src/x#y', {
        filePath: 'src/x.ts',
        declaredDependencies: [],
        derivedDependencies: ['src/b'],
        declaredExports: ['old'],
        derivedExports: ['new'],
      }),
      node('src/b'),
    ])

    expect(issues).toEqual([])
  })

  it('reports nothing for nodes without derived facts', () => {
    const issues = detectDrift([node('src/a', { declaredDependencies: ['src/b'] }), node('src/b')])
    expect(issues).toEqual([])
  })
})
