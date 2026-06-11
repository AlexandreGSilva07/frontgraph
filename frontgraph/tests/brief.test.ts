import { afterEach, describe, expect, it } from 'vitest'
import { estimateTokens, generateBrief } from '../src/brief'
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

/** A 10-node project: one foundation contract everything imports, layers above it. */
function fixtureProject(): string {
  const files: Record<string, string> = {
    'src/types/core.ts': tsFileWithGraph('src/types/core', {
      category: 'types',
      summary: 'Core domain contracts shared by every module',
      exports: ['placeholder'],
    }),
  }
  for (let i = 0; i < 8; i++) {
    files[`src/logic/mod${i}.ts`] = tsFileWithGraph(`src/logic/mod${i}`, {
      category: 'logic',
      summary: `Business rule module number ${i} with a reasonably descriptive summary line`,
      body: [
        "import { placeholder } from '../types/core'",
        `export const mod${i} = placeholder`,
      ].join('\n'),
    })
  }
  files['src/main.ts'] = tsFileWithGraph('src/main', {
    category: 'root',
    summary: 'Entry point wiring all business modules together',
    body: [
      "import { mod0 } from './logic/mod0'",
      'export const main = mod0',
    ].join('\n'),
  })
  return project(files)
}

describe('generateBrief', () => {
  it('stays at or under the token budget', () => {
    const root = fixtureProject()
    for (const budget of [300, 800, 2000, 8000]) {
      const brief = generateBrief(root, budget)
      expect(estimateTokens(brief)).toBeLessThanOrEqual(budget)
    }
  })

  it('includes identity, architecture and health sections with a generous budget', () => {
    const root = fixtureProject()
    const brief = generateBrief(root, 8000)

    expect(brief).toContain('# Architectural brief:')
    expect(brief).toContain('10 graph nodes')
    expect(brief).toContain('## Architecture')
    expect(brief).toContain('Dependency flow: types → logic → root')
    expect(brief).toContain('Foundation nodes (everything builds on these): src/types/core')
    expect(brief).toContain('## Health')
    expect(brief).toContain('## Key nodes')
    // Every node fits at 8000 tokens — no truncation notice
    expect(brief).toContain('src/main')
    expect(brief).not.toContain('raise budget_tokens')
  })

  it('ranks the most-depended-upon node first', () => {
    const root = fixtureProject()
    const brief = generateBrief(root, 8000)

    const keyNodesSection = brief.slice(brief.indexOf('## Key nodes'))
    const firstEntry = keyNodesSection.split('\n')[1]
    expect(firstEntry).toContain('src/types/core')
    expect(firstEntry).toContain('8 dependent(s)')
  })

  it('truncates explicitly when the budget cannot hold every node', () => {
    const root = fixtureProject()
    const brief = generateBrief(root, 400)

    expect(estimateTokens(brief)).toBeLessThanOrEqual(400)
    expect(brief).toMatch(/\(\d+ of 10 nodes shown — raise budget_tokens/)
    // The foundation contract always makes the cut
    expect(brief).toContain('src/types/core')
  })

  it('reports drift in the health section', () => {
    const root = project({
      'src/a.ts': tsFileWithGraph('src/a', {
        summary: 'A',
        exports: ['somethingElse'],
      }),
    })

    const brief = generateBrief(root, 4000)
    expect(brief).toMatch(/Drift: \d+ divergence/)

    const cleanRoot = project({
      'src/b.ts': tsFileWithGraph('src/b', { summary: 'B', exports: ['placeholder'] }),
    })
    expect(generateBrief(cleanRoot, 4000)).toContain('Drift: none')
  })

  it('is deterministic for the same project state', () => {
    const root = fixtureProject()
    expect(generateBrief(root, 2000)).toBe(generateBrief(root, 2000))
  })
})
