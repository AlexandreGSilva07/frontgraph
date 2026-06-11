import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { GraphNode } from './parser'
import { GRAPH_CONTAINER_RE } from './sync'

export interface StalenessSuspect {
  filePath: string
  nodeIds: string[]
  reason: string
}

interface LedgerEntry {
  blockHash: string
  baselineBodyHash: string
  baselineLines: number
  lastBodyHash: string
  churn: number
}

type Ledger = Record<string, LedgerEntry>

export const CHURN_THRESHOLD = 3
export const GROWTH_THRESHOLD = 0.5
const MIN_BASELINE_LINES = 10

function ledgerPath(rootDir: string): string {
  return resolve(rootDir, 'node_modules', '.cache', 'frontgraph', 'staleness-v1.json')
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

function splitFile(content: string): { blockText: string; bodyText: string } {
  const blocks: string[] = []
  const bodyText = content.replace(GRAPH_CONTAINER_RE, container => {
    if (/@graph\b/.test(container)) {
      blocks.push(container)
      return ''
    }
    return container
  })
  return { blockText: blocks.join('\n'), bodyText }
}

/**
 * Semantic staleness: a summary written for one version of a file slowly stops
 * describing it, and no AST can detect that. Heuristic signal instead — if the
 * body keeps changing while the @graph block stays untouched, the block is
 * suspect. Informational only; MUST NOT fail builds.
 *
 * Churn counts observed transitions between calls, so the signal sharpens with
 * use (every validate/brief is an observation). The ledger lives in
 * node_modules/.cache and is best-effort: losing it only resets the heuristic.
 */
export function trackStaleness(rootDir: string, nodes: GraphNode[]): StalenessSuspect[] {
  const files = new Map<string, string[]>()
  for (const node of nodes) {
    const posix = node.filePath.replace(/\\/g, '/')
    const list = files.get(posix) ?? []
    list.push(node.id)
    files.set(posix, list)
  }

  const lp = ledgerPath(rootDir)
  let ledger: Ledger = {}
  if (existsSync(lp)) {
    try {
      ledger = JSON.parse(readFileSync(lp, 'utf-8')) as Ledger
    } catch {
      ledger = {}
    }
  }

  const suspects: StalenessSuspect[] = []
  const nextLedger: Ledger = {}

  for (const [filePath, nodeIds] of files) {
    const fullPath = resolve(rootDir, filePath)
    if (!existsSync(fullPath)) continue
    const { blockText, bodyText } = splitFile(readFileSync(fullPath, 'utf-8'))
    const blockHash = md5(blockText)
    const bodyHash = md5(bodyText)
    const bodyLines = bodyText.split('\n').length

    const prev = ledger[filePath]
    let entry: LedgerEntry
    if (!prev || prev.blockHash !== blockHash) {
      // First sighting, or the block was edited: current body becomes the baseline.
      entry = { blockHash, baselineBodyHash: bodyHash, baselineLines: bodyLines, lastBodyHash: bodyHash, churn: 0 }
    } else {
      entry = { ...prev }
      if (bodyHash !== prev.lastBodyHash) {
        entry.churn += 1
        entry.lastBodyHash = bodyHash
      }
    }
    nextLedger[filePath] = entry

    const reasons: string[] = []
    if (entry.churn >= CHURN_THRESHOLD) {
      reasons.push(`body changed ${entry.churn}x since the @graph block was last touched`)
    }
    if (entry.baselineLines >= MIN_BASELINE_LINES && bodyHash !== entry.baselineBodyHash) {
      const delta = Math.abs(bodyLines - entry.baselineLines) / entry.baselineLines
      if (delta >= GROWTH_THRESHOLD) {
        reasons.push(`body went from ${entry.baselineLines} to ${bodyLines} lines since the block was last touched`)
      }
    }
    if (reasons.length > 0) {
      suspects.push({ filePath, nodeIds: [...nodeIds].sort(), reason: reasons.join('; ') })
    }
  }

  try {
    mkdirSync(dirname(lp), { recursive: true })
    writeFileSync(lp, JSON.stringify(nextLedger))
  } catch {
    // Best-effort persistence — never break a parse over the ledger.
  }

  return suspects.sort((a, b) => a.filePath.localeCompare(b.filePath))
}
