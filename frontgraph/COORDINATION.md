# Frontgraph Coordination Protocol (draft)

**Status: non-normative.** This document describes the multi-agent coordination
layer implemented by the reference engine. It is a candidate for inclusion in
FRONTGRAPH-SPEC v2 once it has survived real multi-agent usage; FRONTGRAPH-SPEC
v1.0 is intentionally untouched by it (see SPEC §10 — Versioning).

## 1. Problem

A live graph makes a codebase legible to one agent. With several concurrent
agents, legibility is not enough: two agents editing overlapping subgraphs
produce conflicting changes, and a breaking contract change executed in the
wrong order produces a broken intermediate state. The graph already knows the
two facts needed to prevent both: **which nodes overlap** (claims) and **which
order adaptation must happen in** (the reverse-dependency DAG).

## 2. State

Coordination state lives in `.frontgraph/` at the project root:

| File | Contents |
|------|----------|
| `leases.json` | Active claims (pruned of expired entries on every access) |
| `work-orders.json` | All plans and their orders, including completed ones |

Properties:

- **Local runtime state** — add `.frontgraph/` to `.gitignore`. It is rebuildable
  and meaningful only on the machine where the agents run.
- **Lock-protected** — every read-modify-write happens under an exclusive
  directory lock (`<store>.lock`, stale after 5s, acquisition timeout 2s), so
  concurrent MCP server processes cannot interleave updates.
- **Survives npm installs** — unlike the parse cache, which lives in
  `node_modules/.cache`.

## 3. Leases

A **lease** is exclusive *intent* over a set of node ids.

```
Lease {
  id          L<n>
  holder      agent name
  intent      one line: what the holder is doing
  scope       'nodes' | 'impact'
  nodeIds     the claimed set (explicit, fully expanded)
  createdAt / expiresAt   ISO timestamps
}
```

Semantics:

- **Claim** (`graph_claim` / `frontgraph claim`): rejected iff any *active*
  lease held by a *different* holder intersects the requested set. The
  rejection lists every conflicting lease with holder, intent, overlap, and
  expiry — enough for the rejected agent to decide: wait, negotiate, or claim
  a disjoint set.
- **Scope `impact`**: the claimed set is expanded to the nodes plus all
  transitive dependents. This is the correct scope for contract changes —
  "I am changing this type, nothing downstream is safe to touch."
- **Self-overlap is allowed**: a holder refining or widening their own claim
  must not deadlock against themselves.
- **TTL** (default 30 min): leases expire on their own and are pruned on every
  store access. A crashed agent cannot block the graph forever. Renewing =
  claiming again (self-overlap makes this safe).
- **Release** (`graph_release`): drop all of a holder's leases or one by id,
  as soon as the work is done and validated.
- **Advisory, not mandatory**: the engine cannot stop a process from editing
  files. Leases are a contract between cooperating agents; `graph_brief` and
  `graph_leases` make claims visible so a well-behaved agent checks before
  touching.

## 4. Work orders (contract-diff plans)

`graph_plan(id, change)` converts a planned change to one node into a
**work-order DAG** over its transitive dependents:

- `WO` for the target itself — unblocked, do this first
- One `WO` per affected dependent, with `blockedBy` = the orders of everything
  it imports from the affected set (direct dependents wait for the target;
  diamond joins wait for *all* their adapted siblings)

Execution contract (`work_order_update`):

```
pending → in_progress → done
```

- An order **cannot leave `pending`** while any blocker is not `done`. The
  rejection lists the unfinished blockers. The DAG is the safety contract,
  not a suggestion.
- `ready` (computed on listing) = pending with all blockers done — the
  frontier a swarm of agents can pick work from in parallel.
- Recommended loop per agent: pick a `ready` order → `graph_claim` its node →
  `in_progress` → edit → validate/sync → `done` → release → repeat.

Known limit: a dependency cycle inside the affected set produces mutually
blocked orders. Cycles are already a `validate` diagnostic — fix them before
planning across them.

## 5. Visibility

Coordination state surfaces where agents already look:

- `graph_brief` — Health section lists active leases (holder, node count,
  intent) and open work orders with the ready count
- `graph_leases` / `frontgraph leases` — full lease listing
- `graph_work_orders` / `frontgraph orders` — order status and readiness

## 6. Limitations (v0)

- **Single machine**: stores are local files; no network coordination.
- **Holder honesty**: holders are self-declared names; there is no
  authentication. Any agent can release any holder's lease. Acceptable while
  agents are cooperating processes launched by the same operator.
- **No lease renewal API**: re-claim before expiry instead.
- **Plans don't auto-invalidate**: if the graph changes after `graph_plan`,
  the DAG reflects the topology at planning time. Re-plan after structural
  edits.

These are the boundaries to push before any of this is proposed for SPEC v2.
