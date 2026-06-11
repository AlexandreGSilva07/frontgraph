# Onboarding Protocol v1.0

## Purpose

This document is the canonical onboarding protocol for the Graph Framework. It is designed to be read and executed by an AI agent (Claude Code, Codex, Cursor, etc.) — not by a human. The protocol standardizes how a project is initialized or retrofitted into the framework.

## When This Protocol Triggers

The AI agent MUST execute this protocol when:
- A new project is being created from scratch
- An existing project is being onboarded into the framework
- The user requests `onboard`, `init`, `setup`, or references this file

## Protocol Phases

The protocol runs in 5 phases. Each phase produces artifacts that subsequent phases may depend on. The AI MUST complete phase N before starting phase N+1.

---

### Phase 1 — Discovery

**Goal:** Understand the current state of the project.

**Actions:**
1. List the project root directory — identify existing source folders (`src/`, `lib/`, `app/`, etc.)
2. Identify the project type by scanning for signals:
   - `package.json` with `react` → React project
   - `package.json` with `next` → Next.js project
   - `pyproject.toml` → Python project
   - `go.mod` → Go project
   - `Cargo.toml` → Rust project
   - If none found → generic TypeScript project
3. Count existing source files (`*.ts`, `*.tsx`, `*.py`, `*.go`, `*.rs`)
4. Identify the entry point (`main.ts`, `index.ts`, `app.ts`, etc.)

**Output:** A mental model of what exists. The AI does not modify anything in this phase.

**Decision gate:** Is this a new (empty) project or an existing project with code?
- **New project** → go to Phase 2a
- **Existing project** → go to Phase 2b

---

### Phase 2a — Scaffold (New Project)

**Goal:** Create the canonical directory structure and configuration.

**Actions:**
1. Create the directory structure:

```
project/
  src/
    types/          ← contracts (CDD)
    logic/          ← business logic
    components/     ← UI components (React/Vue/etc.)
  Docs/
    specs/          ← specifications (SDD, if enabled)
    src/
      types/
      logic/
      components/
  graph.config.json
```

2. Create `graph.config.json` with defaults:
   - `cdd.enabled = true`, `tdd.enabled = false`, `sdd.enabled = false`
   - Architecture rules: `no_ui_in_logic_deps = true`, `contract_at_layer_zero = true`
3. Create placeholder `.gitkeep` in empty directories so they're tracked

**Output:** Directory tree exists, `graph.config.json` exists.

---

### Phase 2b — Retrofit (Existing Project)

**Goal:** Integrate the framework into an existing codebase without breaking anything.

**Actions:**
1. Create `Docs/` mirroring the existing source structure:
   - For each `src/a/b/file.ts`, create `Docs/src/a/b/file.md`
   - Each doc file gets a stub: `# file.ts\n\n## Overview\n\nTBD.\n`
2. Create `graph.config.json` — detect project type from signals (Phase 1) and set defaults
3. For each source file, auto-generate a best-effort `@graph` block:
   - **id**: relative path without extension
   - **category**: inferred from path (`types/` → contract, `components/` → ui, `logic/` or `services/` → logic, entry files → entry, test files → test)
   - **dependencies**: extracted from import statements
   - **exports**: extracted from export statements
   - **summary**: `TBD — auto-generated`
   - **doc**: `Docs/<path>.md`
4. Prepend the @graph block to each file, preserving existing content

**Output:** Every source file has a @graph block. Docs/ mirror exists. graph.config.json exists.

---

### Phase 3 — Configuration

**Goal:** Ensure `graph.config.json` reflects the project's methodology choices.

**Actions:**
1. If no `graph.config.json` exists, create from defaults (see Phase 2a step 2)
2. Validate the config parses as valid JSON
3. If user specified methodology preferences, apply them now:
   - `--with-tdd` → set `tdd.enabled = true`
   - `--with-sdd` → set `sdd.enabled = true`
   - `--with-all` → enable both TDD and SDD

**Output:** Valid `graph.config.json` reflecting the chosen methodologies.

---

### Phase 4 — Specification Stubs (if SDD enabled)

**Goal:** Create initial specification files.

**Actions:**
1. If `config.methodologies.sdd.enabled === false`, skip this phase
2. Scan source contracts (`src/types/*.ts` or equivalent)
3. For each contract file, create `Docs/specs/<feature>.spec.md` with:
   - Feature name
   - Requirements section (empty — to be filled by user/AI)
   - Acceptance criteria (empty — to be filled by user/AI)
4. If no contracts exist yet (new project), create a single `Docs/specs/INDEX.spec.md` as the root spec

**Output:** `Docs/specs/` populated with stub files.

---

### Phase 5 — Validation

**Goal:** Confirm the onboarding produced a valid framework state.

**Actions:**
1. Run `npx tsx ../frontgraph/src/cli.ts validate`
2. Fix any issues reported:
   - Missing doc paths → create the stub doc files
   - Dependency references to non-existent nodes → mark as external or remove
3. Run `npx tsx ../frontgraph/src/cli.ts summary` and present the result
4. If architecture violations exist, flag them for the user but do NOT auto-fix (architecture decisions need human judgment)

**Output:** Clean validation. Summary printed.

---

## Protocol Completion

When all phases complete successfully, the AI reports:

```
Onboarding complete.

Project: <type>
Nodes: <count>
Methodologies: <active list>
Layers: <count>

Next steps:
  - Fill in TBD docs in Docs/
  - Review auto-generated @graph blocks
  - Run 'gate <feature>' before implementing new features
```

## Commands Reference

The AI may use these CLI commands during onboarding:

```
npx tsx ../frontgraph/src/cli.ts scaffold <name>     Create stubs for a feature
npx tsx ../frontgraph/src/cli.ts validate            Check integrity
npx tsx ../frontgraph/src/cli.ts summary             Project overview
npx tsx ../frontgraph/src/cli.ts workflow <name>     Print workflow for a task
```

## Edge Cases

- **Monorepo**: If multiple `package.json` files exist, treat each package as a separate graph with its own `graph.config.json`
- **No source files**: Phases 2b and 4 produce empty directories with `.gitkeep` only
- **Mixed languages**: If project uses both TS and Python, create separate `graph.config.json` per language ecosystem
- **Existing @graph blocks**: Phase 2b must NOT overwrite existing @graph blocks — skip files that already have them
- **Git safety**: Phase 2b modifies existing source files. The AI SHOULD suggest committing before onboarding
