import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { invalidateCache, parseProjectWithErrors, type GraphNode } from './parser'

export interface SyncResult {
  updated: string[]
  unchanged: string[]
  skippedAnchored: string[]
}

export const GRAPH_CONTAINER_RE = /\/\*\*[\s\S]*?\*\/|"""[\s\S]*?"""|'''[\s\S]*?'''/g

function setListField(block: string, field: string, values: string[]): string {
  return block.replace(
    new RegExp(`(${field}:\\s*\\[)[\\s\\S]*?(\\])`),
    `$1${values.join(', ')}$2`,
  )
}

/**
 * Rewrite the declared dependencies/exports of file-level @graph blocks to the
 * derived truth (SPEC §7). Anchored files are never touched; summary, category,
 * doc and spec are never altered.
 */
export function syncGraphBlocks(rootDir: string): SyncResult {
  invalidateCache(rootDir)
  const { nodes } = parseProjectWithErrors(rootDir)

  const byFile = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    const list = byFile.get(node.filePath) ?? []
    list.push(node)
    byFile.set(node.filePath, list)
  }

  const result: SyncResult = { updated: [], unchanged: [], skippedAnchored: [] }

  for (const [filePath, fileNodes] of byFile) {
    const posixPath = filePath.replace(/\\/g, '/')
    if (fileNodes.length > 1 || fileNodes.some(n => n.id.includes('#'))) {
      result.skippedAnchored.push(posixPath)
      continue
    }

    const node = fileNodes[0]
    if (!node.derivedDependencies && !node.derivedExports) {
      result.unchanged.push(posixPath)
      continue
    }

    const fullPath = resolve(rootDir, filePath)
    const before = readFileSync(fullPath, 'utf-8')
    const after = before.replace(GRAPH_CONTAINER_RE, container => {
      if (!/@graph\b/.test(container)) return container
      let updated = container
      if (node.derivedDependencies) {
        updated = setListField(updated, 'dependencies', [...node.derivedDependencies].sort())
      }
      if (node.derivedExports) {
        updated = setListField(updated, 'exports', node.derivedExports)
      }
      return updated
    })

    if (after !== before) {
      writeFileSync(fullPath, after)
      result.updated.push(posixPath)
    } else {
      result.unchanged.push(posixPath)
    }
  }

  invalidateCache(rootDir)
  return result
}
