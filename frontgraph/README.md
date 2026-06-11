# Frontgraph

> **A living dependency graph embedded in your source code.**
> **Versioned architectural context for AI agents — semantic intent declared by humans, mechanical truth derived continuously from code.**

Reference engine for **[FRONTGRAPH-SPEC v1](./SPEC.md)**. Annotate source files with `@graph` blocks; the engine derives the mechanical truth (dependencies, exports) from the AST on every parse, detects **drift** when blocks and code diverge, briefs agents within a token budget, and coordinates concurrent agents with **leases** and **work-order DAGs** ([protocol](./COORDINATION.md)).

```bash
npx frontgraph summary        # the graph, layered
npx frontgraph validate       # references, cycles, drift, staleness
npx frontgraph sync           # rewrite blocks with the derived truth
npx frontgraph brief --tokens 2000   # architectural brief for an agent
```

As an MCP server for Claude Code / Cursor / any MCP client (19 tools):

```json
{
  "mcpServers": {
    "frontgraph": {
      "type": "stdio",
      "command": "npx",
      "args": ["frontgraph-mcp", "/path/to/your/project"]
    }
  }
}
```

## The core idea

**Derive the mechanical. Declare only the semantic.**

```typescript
/**
 * @graph
 * id: src/logic/pricing
 * category: logic
 * summary: Pricing engine pipeline — applies rules in priority order
 * dependencies: [src/types/orders]   ← projection; derived truth wins
 * exports: [pricingPipeline]         ← projection; derived truth wins
 */
import type { Cart } from '../types/orders'
export function pricingPipeline(cart: Cart) { /* ... */ }
```

Static context files rot — and stale context actively hurts agents. Frontgraph blocks can't lie: declared lists are a readable projection, the AST is the truth, divergence is a first-class diagnostic (`validate`), and repair is one command (`sync`).

Full documentation: [project README](https://github.com/AlexandreGSilva07/frontgraph#readme) · [FRONTGRAPH-SPEC v1](./SPEC.md) · [Coordination protocol](./COORDINATION.md)

## License

MIT
