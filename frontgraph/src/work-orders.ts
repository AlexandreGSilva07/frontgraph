import { resolve } from 'node:path'
import { buildGraph } from './graph'
import type { GraphNode } from './parser'
import { withStore } from './store'

export type WorkOrderStatus = 'pending' | 'in_progress' | 'done'

export interface WorkOrder {
  id: string
  planId: string
  nodeId: string
  action: string
  status: WorkOrderStatus
  blockedBy: string[]
  createdAt: string
  updatedAt: string
}

export interface PlanResult {
  planId: string
  orders: WorkOrder[]
}

export type UpdateOutcome =
  | { ok: true; order: WorkOrder }
  | { ok: false; reason: string; blockedBy?: WorkOrder[] }

interface WorkOrderStore {
  nextPlanId: number
  nextOrderId: number
  orders: WorkOrder[]
}

const EMPTY: WorkOrderStore = { nextPlanId: 1, nextOrderId: 1, orders: [] }

function storePath(rootDir: string): string {
  return resolve(rootDir, '.frontgraph', 'work-orders.json')
}

/**
 * Contract-diff planning: a change to one node ripples to its transitive
 * dependents. Emit one work order per affected node, DAG-ordered bottom-up —
 * an order unblocks only when everything it imports from the affected set has
 * already been adapted. Returns null when the target is not a graph node.
 *
 * Known limit: a dependency cycle inside the affected set produces mutually
 * blocked orders. Cycles are already a validate diagnostic — fix those first.
 */
export function planWorkOrders(
  rootDir: string,
  nodes: GraphNode[],
  targetId: string,
  change: string,
): PlanResult | null {
  const graph = buildGraph(nodes)
  if (!graph.nodes.has(targetId)) return null

  // Transitive dependents in BFS order from the target (deterministic: sorted per level)
  const affected: string[] = []
  const seen = new Set([targetId])
  const queue = [targetId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const dependent of [...(graph.reverseDeps.get(current) ?? [])].sort()) {
      if (!seen.has(dependent)) {
        seen.add(dependent)
        affected.push(dependent)
        queue.push(dependent)
      }
    }
  }

  return withStore(storePath(rootDir), EMPTY, store => {
    const now = new Date().toISOString()
    const planId = `P${store.nextPlanId}`
    let nextOrderId = store.nextOrderId

    // Assign ids to every order first, then wire blockedBy from the full map —
    // a node may depend on an affected sibling discovered later in the BFS.
    const orderIdByNode = new Map<string, string>()
    for (const nodeId of [targetId, ...affected]) {
      orderIdByNode.set(nodeId, `WO${nextOrderId++}`)
    }

    const orders: WorkOrder[] = [{
      id: orderIdByNode.get(targetId)!,
      planId,
      nodeId: targetId,
      action: `Apply the change: ${change}`,
      status: 'pending',
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
    }]

    for (const nodeId of affected) {
      const node = graph.nodes.get(nodeId)!
      const blockedBy = node.dependencies
        .filter(dep => orderIdByNode.has(dep))
        .map(dep => orderIdByNode.get(dep)!)
        .sort()
      orders.push({
        id: orderIdByNode.get(nodeId)!,
        planId,
        nodeId,
        action: `Adapt '${nodeId}' to the upstream change in '${targetId}': ${change}`,
        status: 'pending',
        blockedBy,
        createdAt: now,
        updatedAt: now,
      })
    }

    return {
      data: {
        nextPlanId: store.nextPlanId + 1,
        nextOrderId,
        orders: [...store.orders, ...orders],
      },
      result: { planId, orders },
    }
  })
}

/**
 * Move an order through pending → in_progress → done. Gated: an order cannot
 * leave pending while any of its blockers is not done — the DAG is the safety
 * contract, not a suggestion.
 */
export function updateWorkOrder(
  rootDir: string,
  orderId: string,
  status: WorkOrderStatus,
): UpdateOutcome {
  return withStore<WorkOrderStore, UpdateOutcome>(storePath(rootDir), EMPTY, store => {
    const order = store.orders.find(o => o.id === orderId)
    if (!order) {
      return { data: store, result: { ok: false as const, reason: `Work order '${orderId}' not found` } }
    }

    if (status !== 'pending') {
      const byId = new Map(store.orders.map(o => [o.id, o]))
      const unfinished = order.blockedBy
        .map(id => byId.get(id))
        .filter((o): o is WorkOrder => o !== undefined && o.status !== 'done')
      if (unfinished.length > 0) {
        return {
          data: store,
          result: {
            ok: false as const,
            reason: `'${orderId}' is blocked — upstream order(s) not done yet`,
            blockedBy: unfinished,
          },
        }
      }
    }

    const updated: WorkOrder = { ...order, status, updatedAt: new Date().toISOString() }
    return {
      data: { ...store, orders: store.orders.map(o => (o.id === orderId ? updated : o)) },
      result: { ok: true as const, order: updated },
    }
  })
}

/** All orders (optionally one plan), each with a computed `ready` flag. */
export function listWorkOrders(
  rootDir: string,
  planId?: string,
): Array<WorkOrder & { ready: boolean }> {
  return withStore(storePath(rootDir), EMPTY, store => {
    const byId = new Map(store.orders.map(o => [o.id, o]))
    const filtered = planId ? store.orders.filter(o => o.planId === planId) : store.orders
    const result = filtered.map(o => ({
      ...o,
      ready: o.status === 'pending' && o.blockedBy.every(id => byId.get(id)?.status === 'done'),
    }))
    return { data: store, result }
  })
}
