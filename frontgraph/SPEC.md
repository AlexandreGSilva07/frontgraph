# FRONTGRAPH-SPEC v1.0

Status: Draft
Version: 1.0.0

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

## 1. Abstract

Frontgraph embeds the dependency graph of a codebase directly in its source
files. Each source file carries a `@graph` metadata block describing the node
it contributes to the project graph. The graph is therefore version-controlled,
diffable, mergeable, and always co-located with the code it describes.

The central design rule of this specification:

> **Derive the mechanical, declare only the semantic.**

Facts a machine can extract from code (dependencies, exports) are *derived* by
the engine on every parse and are never trusted from human/agent declarations.
Facts only a mind can produce (summary, category, documentation links) are
*declared* in the block. Declared copies of derivable facts are permitted for
human and LLM readability, but the engine treats them as a *projection* of the
derived truth — divergence between the two is **drift**, a first-class
diagnostic.

## 2. Terminology

- **Node** — one unit in the project graph. Usually one source file; a file
  MAY contain multiple *anchored* nodes (§5.3).
- **Block** — the `@graph` metadata comment that declares a node.
- **Declared truth** — field values written in the block.
- **Derived truth** — field values the engine computes from the code itself.
- **Drift** — disagreement between declared and derived truth (§7).
- **Engine** — any conforming implementation that parses blocks and serves the
  graph (CLI, MCP server, CI action, editor plugin).

## 3. Block grammar

A block is a comment containing the marker `@graph` followed by `field: value`
lines. After container stripping (§4), the grammar is:

```
block        = "@graph" NEWLINE 1*(field-line)
field-line   = field-name ":" SP value NEWLINE
field-name   = "id" | "category" | "summary" | "dependencies"
             | "exports" | "doc" | "spec"
value        = scalar / list
list         = "[" [item *("," SP item)] "]"
```

List items MAY be bare or quoted with `'` or `"`. Unknown field names MUST be
ignored (forward compatibility).

## 4. Language bindings

| Language | Container | Stripping rule |
|---|---|---|
| TypeScript / JavaScript (`.ts .tsx .js .jsx`) | JSDoc `/** ... */` | leading `*` and one space removed per line |
| Python (`.py`) | docstring `""" ... """` or `''' ... '''` | none |

A conforming engine MUST scan every source file under the project's source
roots, skipping `node_modules`, `dist`, `.git`, `__pycache__`, hidden entries,
and `.d.ts` files.

## 5. Fields

| Field | Status | Truth | Meaning |
|---|---|---|---|
| `id` | REQUIRED | declared, validated | Graph identity of the node |
| `summary` | REQUIRED | declared | One-line human/LLM description |
| `category` | RECOMMENDED | declared | Semantic layer (e.g. `contract`, `logic`, `ui`) |
| `dependencies` | OPTIONAL | **derived** (§6) | Internal nodes this node uses |
| `exports` | OPTIONAL | **derived** (§6) | Public symbols of the node |
| `doc` | OPTIONAL | declared, resolved | Project-relative path to the node's doc file |
| `spec` | OPTIONAL | declared, resolved | Project-relative path to the node's spec file |

A block missing `id` or `summary` MUST be reported as a parse error and the
node dropped. All other problems are warnings: the node stays in the graph.

### 5.1 Identity

`id` MUST be the project-relative path of the file, POSIX separators, source
extension stripped (`src/logic/pricing.ts` → `src/logic/pricing`). An `id`
that does not match its file path MUST be flagged (the node is kept, so the
graph survives refactors in progress).

### 5.2 Categories

Categories are semantic, not structural. Engines MUST NOT require categories
to match directory names. Engines SHOULD auto-discover candidate categories
from first-level directories under each source root.

### 5.3 Anchored nodes

A file MAY contain multiple blocks whose ids share the file id plus an
anchor: `src/utils/math#formatters`. Anchors partition a file *semantically*;
mechanical derivation works at *file* granularity. Therefore, for anchored
nodes:

- derived dependencies attach to every anchored node of the file;
- `exports` remains purely declared;
- drift detection (§7) is skipped.

## 6. Derivation

### 6.1 Dependencies (all languages — MUST)

On every parse the engine MUST derive each file's internal dependencies from
its import statements and merge them (set union) with the declared list. The
graph's effective edge set is `declared ∪ derived`.

Resolution rules:

1. Only specifiers that resolve to a source file inside the project become
   dependencies. Bare package names, asset imports (`.css`, `.json`, images),
   and unresolvable paths MUST be dropped.
2. TS/JS: relative specifiers (`./x`, `../y`), the `@/` alias (→ `src/`),
   static `import`, `export ... from`, dynamic `import()`, and `require()`
   all count. Extension-less, explicit-extension, and `index` resolution MUST
   be supported.
3. Python: `import a.b` and `from .rel import x` resolve against source
   roots; package imports resolve to `pkg/__init__`.
4. The resulting dependency id is the resolved file's node id (§5.1).

### 6.2 Exports (TS/JS — MUST; Python — MAY in v1)

For TS/JS files containing a single block, the engine MUST derive the export
list from the AST and use it as the node's effective `exports`:

- `export const|let|var|function|class|interface|type|enum <name>` → `name`
- `export { a, b as c }` (with or without `from`) → exported names
- `export default function|class <name>` → `name (default)`
- anonymous `export default` / `export =` → `default`
- `export * from` re-exports are not enumerated in v1.

Python export derivation is OPTIONAL in v1; declared `exports` remains the
effective value.

## 7. Drift

Drift is computed per file-level node (anchored nodes are exempt):

| Kind | Condition |
|---|---|
| `undeclared-dependency` | derived dep absent from the declared list |
| `stale-dependency` | declared dep that is an existing graph node but never imported by the code |
| `undeclared-export` | derived export absent from the declared list |
| `stale-export` | declared export the code no longer exports |

A declared anchored dependency (`file#anchor`) is satisfied by a derived
dependency on its base file id.

Drift MUST be reported by `validate` as warnings. It MUST NOT fail validation
unless the project sets the architecture rule `"strict_drift": true`, in which
case any drift is an error.

Engines SHOULD provide a `sync` operation that rewrites the declared
`dependencies` and `exports` of file-level blocks to the derived truth,
keeping the in-file projection readable and current. `sync` MUST NOT touch
anchored files and MUST NOT alter `summary`, `category`, `doc`, or `spec`.

Rationale for keeping the declared projection at all: the block is read in
place by humans and LLMs without an engine. The projection is documentation;
the engine is the authority; `sync` is the bridge.

## 8. Graph semantics

- Edges point from dependent to dependency.
- Engines MUST detect cycles and MUST compute a layered depth order (nodes
  with no internal deps at layer 0).
- Engines MUST validate: dependency references resolve to graph nodes or are
  recognizably external; `doc`/`spec` paths exist on disk.
- Engines MUST re-derive the graph from current file contents on every query
  ("live graph"); content-hash caching MAY make this cheap but MUST be
  invisible in behavior.

## 9. Conformance levels

- **L1 — Reader**: parses blocks, builds the graph, validates references.
- **L2 — Deriver**: L1 + dependency/export derivation and drift reporting
  (§6, §7).
- **L3 — Live engine**: L2 + always-current graph served over a protocol
  (e.g. MCP) with per-call re-derivation.

The reference implementation in this package targets L3.

## 10. Versioning

This document uses semantic versioning. Additive fields and new drift kinds
are minor versions. Changes to id resolution or derivation rules are major
versions. Engines SHOULD report the spec version they implement.
