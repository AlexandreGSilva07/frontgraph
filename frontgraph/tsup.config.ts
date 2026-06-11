import { defineConfig } from 'tsup'

export default defineConfig([
  {
    // Executables — shebang so npm bin shims work
    entry: { cli: 'src/cli.ts', 'mcp-server': 'src/mcp-server.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    clean: true,
  },
  {
    // Library surface — mirrors the exports map
    entry: {
      parser: 'src/parser.ts',
      graph: 'src/graph.ts',
      derive: 'src/derive.ts',
      sync: 'src/sync.ts',
      brief: 'src/brief.ts',
      staleness: 'src/staleness.ts',
      leases: 'src/leases.ts',
      'work-orders': 'src/work-orders.ts',
      onboard: 'src/onboard.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node18',
    dts: true,
  },
])
