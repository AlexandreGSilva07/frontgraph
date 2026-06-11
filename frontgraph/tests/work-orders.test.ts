import { afterEach, describe, expect, it } from 'vitest'
import type { GraphNode } from '../src/parser'
import { listWorkOrders, planWorkOrders, updateWorkOrder } from '../src/work-orders'
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

// Diamond on top of the contract:
//   contract ← pricing ← form
//   contract ← validation ← form   (form depends on BOTH siblings)
//   form ← main
const NODES: GraphNode[] = [
  node('src/types/orders'),
  node('src/logic/pricing', ['src/types/orders']),
  node('src/logic/validation', ['src/types/orders']),
  node('src/ui/form', ['src/logic/pricing', 'src/logic/validation']),
  node('src/main', ['src/ui/form']),
  node('src/unrelated'),
]

describe('planWorkOrders', () => {
  it('creates one order per affected node, wired bottom-up through the diamond', () => {
    const root = tempRoot()
    const plan = planWorkOrders(root, NODES, 'src/types/orders', 'rename Money to Currency')!

    expect(plan.planId).toBe('P1')
    expect(plan.orders.map(o => o.nodeId)).toEqual([
      'src/types/orders', 'src/logic/pricing', 'src/logic/validation', 'src/ui/form', 'src/main',
    ])

    const byNode = new Map(plan.orders.map(o => [o.nodeId, o]))
    expect(byNode.get('src/types/orders')!.blockedBy).toEqual([])
    expect(byNode.get('src/logic/pricing')!.blockedBy).toEqual([byNode.get('src/types/orders')!.id])
    // The diamond join waits for BOTH siblings
    expect(byNode.get('src/ui/form')!.blockedBy.sort()).toEqual([
      byNode.get('src/logic/pricing')!.id, byNode.get('src/logic/validation')!.id,
    ].sort())
    expect(byNode.get('src/main')!.blockedBy).toEqual([byNode.get('src/ui/form')!.id])
  })

  it('leaves unaffected nodes out of the plan', () => {
    const root = tempRoot()
    const plan = planWorkOrders(root, NODES, 'src/types/orders', 'change')!
    expect(plan.orders.some(o => o.nodeId === 'src/unrelated')).toBe(false)
  })

  it('plans a single order for a leaf node', () => {
    const root = tempRoot()
    const plan = planWorkOrders(root, NODES, 'src/main', 'tweak entry point')!
    expect(plan.orders).toHaveLength(1)
    expect(plan.orders[0].blockedBy).toEqual([])
  })

  it('returns null for unknown nodes', () => {
    const root = tempRoot()
    expect(planWorkOrders(root, NODES, 'src/ghost', 'change')).toBeNull()
  })
})

describe('updateWorkOrder — DAG gating', () => {
  it('refuses to start an order whose blockers are not done', () => {
    const root = tempRoot()
    const plan = planWorkOrders(root, NODES, 'src/types/orders', 'change')!
    const pricing = plan.orders.find(o => o.nodeId === 'src/logic/pricing')!

    const outcome = updateWorkOrder(root, pricing.id, 'in_progress')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.blockedBy!.map(o => o.nodeId)).toEqual(['src/types/orders'])
    }
  })

  it('unblocks dependents as upstream orders complete', () => {
    const root = tempRoot()
    const plan = planWorkOrders(root, NODES, 'src/types/orders', 'change')!
    const byNode = new Map(plan.orders.map(o => [o.nodeId, o]))

    expect(updateWorkOrder(root, byNode.get('src/types/orders')!.id, 'done').ok).toBe(true)
    expect(updateWorkOrder(root, byNode.get('src/logic/pricing')!.id, 'in_progress').ok).toBe(true)
    expect(updateWorkOrder(root, byNode.get('src/logic/pricing')!.id, 'done').ok).toBe(true)

    // form still waits on validation
    expect(updateWorkOrder(root, byNode.get('src/ui/form')!.id, 'in_progress').ok).toBe(false)
    expect(updateWorkOrder(root, byNode.get('src/logic/validation')!.id, 'done').ok).toBe(true)
    expect(updateWorkOrder(root, byNode.get('src/ui/form')!.id, 'in_progress').ok).toBe(true)
  })

  it('reports unknown order ids', () => {
    const root = tempRoot()
    const outcome = updateWorkOrder(root, 'WO99', 'done')
    expect(outcome.ok).toBe(false)
  })
})

describe('listWorkOrders', () => {
  it('computes readiness and filters by plan', () => {
    const root = tempRoot()
    const p1 = planWorkOrders(root, NODES, 'src/types/orders', 'first change')!
    const p2 = planWorkOrders(root, NODES, 'src/main', 'second change')!

    const all = listWorkOrders(root)
    expect(all).toHaveLength(p1.orders.length + p2.orders.length)

    const onlyP2 = listWorkOrders(root, p2.planId)
    expect(onlyP2).toHaveLength(1)
    expect(onlyP2[0].ready).toBe(true)

    const rootOrder = listWorkOrders(root, p1.planId).find(o => o.nodeId === 'src/types/orders')!
    const pricingOrder = listWorkOrders(root, p1.planId).find(o => o.nodeId === 'src/logic/pricing')!
    expect(rootOrder.ready).toBe(true)
    expect(pricingOrder.ready).toBe(false)

    updateWorkOrder(root, rootOrder.id, 'done')
    const after = listWorkOrders(root, p1.planId).find(o => o.nodeId === 'src/logic/pricing')!
    expect(after.ready).toBe(true)
  })
})
