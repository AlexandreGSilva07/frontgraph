import { afterEach, describe, expect, it } from 'vitest'
import { acquireLease, expandImpact, listLeases, releaseLease } from '../src/leases'
import type { GraphNode } from '../src/parser'
import { cleanupProject, makeProject } from './helpers'

const roots: string[] = []

function tempRoot(): string {
  const root = makeProject({})
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) cleanupProject(roots.pop()!)
})

function node(id: string, dependencies: string[] = []): GraphNode {
  return {
    id,
    category: 'logic',
    summary: `Summary for ${id}`,
    dependencies,
    exports: [],
    doc: '',
    filePath: `${id}.ts`,
  }
}

// contract ← logic ← ui ← entry
const NODES: GraphNode[] = [
  node('src/types/orders'),
  node('src/logic/pricing', ['src/types/orders']),
  node('src/ui/form', ['src/logic/pricing']),
  node('src/main', ['src/ui/form']),
]

describe('acquireLease', () => {
  it('grants a lease on unclaimed nodes', () => {
    const root = tempRoot()
    const outcome = acquireLease(root, NODES, {
      holder: 'alice', nodeIds: ['src/logic/pricing'], intent: 'refactor pricing rules',
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.lease.id).toBe('L1')
      expect(outcome.lease.nodeIds).toEqual(['src/logic/pricing'])
      expect(Date.parse(outcome.lease.expiresAt)).toBeGreaterThan(Date.now())
    }
  })

  it('rejects an overlapping claim by another holder, with overlap details', () => {
    const root = tempRoot()
    acquireLease(root, NODES, { holder: 'alice', nodeIds: ['src/logic/pricing'], intent: 'refactor' })

    const outcome = acquireLease(root, NODES, {
      holder: 'bob', nodeIds: ['src/logic/pricing', 'src/main'], intent: 'rename exports',
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.conflicts).toHaveLength(1)
      expect(outcome.conflicts[0].holder).toBe('alice')
      expect(outcome.conflicts[0].overlapping).toEqual(['src/logic/pricing'])
    }
  })

  it('lets the same holder overlap their own leases', () => {
    const root = tempRoot()
    acquireLease(root, NODES, { holder: 'alice', nodeIds: ['src/logic/pricing'], intent: 'first' })
    const second = acquireLease(root, NODES, {
      holder: 'alice', nodeIds: ['src/logic/pricing', 'src/ui/form'], intent: 'widening my claim',
    })

    expect(second.ok).toBe(true)
  })

  it('grants disjoint claims to different holders', () => {
    const root = tempRoot()
    acquireLease(root, NODES, { holder: 'alice', nodeIds: ['src/types/orders'], intent: 'a' })
    const outcome = acquireLease(root, NODES, { holder: 'bob', nodeIds: ['src/main'], intent: 'b' })

    expect(outcome.ok).toBe(true)
    expect(listLeases(root)).toHaveLength(2)
  })

  it('impact scope claims the node plus all transitive dependents', () => {
    const root = tempRoot()
    const outcome = acquireLease(root, NODES, {
      holder: 'alice', nodeIds: ['src/types/orders'], intent: 'breaking contract change', scope: 'impact',
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.lease.nodeIds).toEqual([
        'src/logic/pricing', 'src/main', 'src/types/orders', 'src/ui/form',
      ])
    }

    // Now nothing in the chain can be claimed by anyone else
    const blocked = acquireLease(root, NODES, { holder: 'bob', nodeIds: ['src/main'], intent: 'x' })
    expect(blocked.ok).toBe(false)
  })

  it('expired leases dissolve on their own (TTL)', () => {
    const root = tempRoot()
    const outcome = acquireLease(root, NODES, {
      holder: 'crashed-agent', nodeIds: ['src/main'], intent: 'never finished', ttlSeconds: 0,
    })
    expect(outcome.ok).toBe(true)

    expect(listLeases(root)).toEqual([])
    const retry = acquireLease(root, NODES, { holder: 'bob', nodeIds: ['src/main'], intent: 'takeover' })
    expect(retry.ok).toBe(true)
  })
})

describe('releaseLease', () => {
  it('frees the nodes for other holders', () => {
    const root = tempRoot()
    acquireLease(root, NODES, { holder: 'alice', nodeIds: ['src/logic/pricing'], intent: 'work' })

    const released = releaseLease(root, { holder: 'alice' })
    expect(released).toHaveLength(1)

    const outcome = acquireLease(root, NODES, { holder: 'bob', nodeIds: ['src/logic/pricing'], intent: 'next' })
    expect(outcome.ok).toBe(true)
  })

  it('releases a single lease by id, keeping the others', () => {
    const root = tempRoot()
    acquireLease(root, NODES, { holder: 'alice', nodeIds: ['src/logic/pricing'], intent: 'a' })
    acquireLease(root, NODES, { holder: 'alice', nodeIds: ['src/main'], intent: 'b' })

    const released = releaseLease(root, { holder: 'alice', leaseId: 'L1' })
    expect(released.map(l => l.id)).toEqual(['L1'])
    expect(listLeases(root).map(l => l.id)).toEqual(['L2'])
  })
})

describe('expandImpact', () => {
  it('returns the node alone when nothing depends on it', () => {
    expect(expandImpact(NODES, ['src/main'])).toEqual(['src/main'])
  })
})
