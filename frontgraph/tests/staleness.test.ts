import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseProjectWithErrors } from '../src/parser'
import { trackStaleness, CHURN_THRESHOLD } from '../src/staleness'
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

function scan(root: string) {
  const { nodes } = parseProjectWithErrors(root)
  return trackStaleness(root, nodes)
}

function rewriteBody(root: string, rel: string, body: string) {
  const full = join(root, ...rel.split('/'))
  const content = readFileSync(full, 'utf-8')
  const blockEnd = content.indexOf('*/') + 2
  writeFileSync(full, content.slice(0, blockEnd) + '\n\n' + body + '\n')
}

describe('trackStaleness', () => {
  it('reports nothing on first sight of a file', () => {
    const root = project({
      'src/a.ts': tsFileWithGraph('src/a', { summary: 'A' }),
    })

    expect(scan(root)).toEqual([])
  })

  it('flags a file whose body keeps churning while the block stays untouched', () => {
    const root = project({
      'src/a.ts': tsFileWithGraph('src/a', { summary: 'A' }),
    })

    scan(root) // baseline
    let suspects: ReturnType<typeof scan> = []
    for (let i = 1; i <= CHURN_THRESHOLD; i++) {
      rewriteBody(root, 'src/a.ts', `export const v${i} = ${i}`)
      suspects = scan(root)
    }

    expect(suspects).toHaveLength(1)
    expect(suspects[0].nodeIds).toEqual(['src/a'])
    expect(suspects[0].reason).toContain(`changed ${CHURN_THRESHOLD}x`)
  })

  it('resets the signal when the @graph block itself is edited', () => {
    const root = project({
      'src/a.ts': tsFileWithGraph('src/a', { summary: 'A' }),
    })

    scan(root)
    for (let i = 1; i <= CHURN_THRESHOLD; i++) {
      rewriteBody(root, 'src/a.ts', `export const v${i} = ${i}`)
      scan(root)
    }
    expect(scan(root)).toHaveLength(1)

    // Touch the block: rewrite the whole file with a fresh summary
    writeFileSync(
      join(root, 'src', 'a.ts'),
      tsFileWithGraph('src/a', { summary: 'A — refreshed after the refactor' }),
    )

    expect(scan(root)).toEqual([])
  })

  it('flags a body that grew massively in a single change', () => {
    const bigBody = Array.from({ length: 12 }, (_, i) => `export const a${i} = ${i}`).join('\n')
    const root = project({
      'src/a.ts': tsFileWithGraph('src/a', { summary: 'A', body: bigBody }),
    })

    scan(root) // baseline: ~16 body lines
    const doubled = Array.from({ length: 30 }, (_, i) => `export const b${i} = ${i}`).join('\n')
    rewriteBody(root, 'src/a.ts', doubled)

    const suspects = scan(root)
    expect(suspects).toHaveLength(1)
    expect(suspects[0].reason).toContain('lines since the block was last touched')
  })

  it('does not inflate churn across repeated scans with no changes', () => {
    const root = project({
      'src/a.ts': tsFileWithGraph('src/a', { summary: 'A' }),
    })

    scan(root)
    rewriteBody(root, 'src/a.ts', 'export const once = 1')
    for (let i = 0; i < CHURN_THRESHOLD + 2; i++) {
      expect(scan(root)).toEqual([])
    }
  })
})
