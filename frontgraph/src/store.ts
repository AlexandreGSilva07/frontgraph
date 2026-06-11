import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const LOCK_TIMEOUT_MS = 2000
const LOCK_STALE_MS = 5000

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function acquireLock(lockPath: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      mkdirSync(lockPath)
      return
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true })
          continue
        }
      } catch {
        continue // lock vanished between attempts — retry immediately
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Could not acquire coordination lock at ${lockPath} — another frontgraph process may be stuck. ` +
          'Delete the .lock directory if no other agent is running.',
        )
      }
      sleep(25)
    }
  }
}

/**
 * Read-modify-write a JSON store under an exclusive directory lock, so
 * concurrent agents (separate MCP server processes on the same project)
 * cannot interleave lease or work-order updates. Coordination state lives
 * in .frontgraph/ at the project root — it survives npm installs, and it
 * is local runtime state that SHOULD be gitignored.
 */
export function withStore<S, R>(
  storePath: string,
  empty: S,
  fn: (data: S) => { data: S; result: R },
): R {
  mkdirSync(dirname(storePath), { recursive: true })
  const lockPath = storePath + '.lock'
  acquireLock(lockPath)
  try {
    let data = empty
    if (existsSync(storePath)) {
      try {
        data = JSON.parse(readFileSync(storePath, 'utf-8')) as S
      } catch {
        data = empty // corrupt store resets — coordination state is rebuildable
      }
    }
    const { data: next, result } = fn(data)
    writeFileSync(storePath, JSON.stringify(next, null, 2))
    return result
  } finally {
    rmSync(lockPath, { recursive: true, force: true })
  }
}
