import { resolve } from 'node:path'
import { buildGraph } from './graph'
import type { GraphNode } from './parser'
import { withStore } from './store'

export interface Lease {
  id: string
  holder: string
  intent: string
  scope: 'nodes' | 'impact'
  nodeIds: string[]
  createdAt: string
  expiresAt: string
}

export interface LeaseConflict {
  leaseId: string
  holder: string
  intent: string
  overlapping: string[]
  expiresAt: string
}

export type ClaimOutcome =
  | { ok: true; lease: Lease }
  | { ok: false; conflicts: LeaseConflict[] }

interface LeaseStore {
  nextId: number
  leases: Lease[]
}

export const DEFAULT_LEASE_TTL_SECONDS = 1800

const EMPTY: LeaseStore = { nextId: 1, leases: [] }

function storePath(rootDir: string): string {
  return resolve(rootDir, '.frontgraph', 'leases.json')
}

function pruneExpired(leases: Lease[], now: number): Lease[] {
  return leases.filter(l => Date.parse(l.expiresAt) > now)
}

/** A claim with impact scope covers the nodes AND everything that depends on them. */
export function expandImpact(nodes: GraphNode[], ids: string[]): string[] {
  const graph = buildGraph(nodes)
  const claimed = new Set(ids)
  const queue = [...ids]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const dependent of graph.reverseDeps.get(current) ?? []) {
      if (!claimed.has(dependent)) {
        claimed.add(dependent)
        queue.push(dependent)
      }
    }
  }
  return [...claimed].sort()
}

/**
 * Claim exclusive intent over a set of nodes. Conflict = any active lease by
 * another holder whose claimed set intersects the requested set; the same
 * holder may overlap their own leases (refining a claim must not self-block).
 * Expired leases are pruned on every store access, so a crashed agent's claim
 * dissolves on its own — that is the reason leases have TTLs at all.
 */
export function acquireLease(
  rootDir: string,
  nodes: GraphNode[],
  opts: {
    holder: string
    nodeIds: string[]
    intent: string
    ttlSeconds?: number
    scope?: 'nodes' | 'impact'
  },
): ClaimOutcome {
  const scope = opts.scope ?? 'nodes'
  const claimedIds = scope === 'impact'
    ? expandImpact(nodes, opts.nodeIds)
    : [...new Set(opts.nodeIds)].sort()
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS

  return withStore<LeaseStore, ClaimOutcome>(storePath(rootDir), EMPTY, store => {
    const now = Date.now()
    const active = pruneExpired(store.leases, now)
    const requested = new Set(claimedIds)

    const conflicts: LeaseConflict[] = []
    for (const lease of active) {
      if (lease.holder === opts.holder) continue
      const overlapping = lease.nodeIds.filter(id => requested.has(id))
      if (overlapping.length > 0) {
        conflicts.push({
          leaseId: lease.id,
          holder: lease.holder,
          intent: lease.intent,
          overlapping,
          expiresAt: lease.expiresAt,
        })
      }
    }

    if (conflicts.length > 0) {
      return { data: { ...store, leases: active }, result: { ok: false as const, conflicts } }
    }

    const lease: Lease = {
      id: `L${store.nextId}`,
      holder: opts.holder,
      intent: opts.intent,
      scope,
      nodeIds: claimedIds,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    }
    return {
      data: { nextId: store.nextId + 1, leases: [...active, lease] },
      result: { ok: true as const, lease },
    }
  })
}

/** Release all of a holder's leases, or one specific lease. Returns what was released. */
export function releaseLease(
  rootDir: string,
  opts: { holder: string; leaseId?: string },
): Lease[] {
  return withStore(storePath(rootDir), EMPTY, store => {
    const active = pruneExpired(store.leases, Date.now())
    const released = active.filter(
      l => l.holder === opts.holder && (!opts.leaseId || l.id === opts.leaseId),
    )
    const remaining = active.filter(l => !released.includes(l))
    return { data: { ...store, leases: remaining }, result: released }
  })
}

/** Active (non-expired) leases. Prunes expired entries as a side effect. */
export function listLeases(rootDir: string): Lease[] {
  return withStore(storePath(rootDir), EMPTY, store => {
    const active = pruneExpired(store.leases, Date.now())
    return { data: { ...store, leases: active }, result: active }
  })
}
