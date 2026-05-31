// Append-only audit trail for the assistant's self-modification runs. Every
// attempt to edit CloXde's own source — from the moment a self-improvement
// project is dispatched through gate results to the final outcome — leaves a
// record here. This is deliberately a plain JSONL file under ~/.cloxde (NOT the
// sqlite db): it must survive a botched self-edit that corrupts the schema, and
// it's the first thing to read when diagnosing "what did the assistant do to
// itself". Append-only + flat file = hard to lose, easy to tail.

import { join } from 'node:path'
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { getCloxdeDir, ensureCloxdeDir } from '../paths'

export type SelfModPhase =
  | 'dispatched' // a self-improvement project was created + team sent in
  | 'gate' // one gate finished (typecheck/test/build/smoke)
  | 'promoted' // gates passed, branch merged back, restart pending
  | 'rejected' // a gate failed; worktree/branch discarded
  | 'rolled-back' // watchdog reverted a promoted commit after a crash loop

export interface SelfModAuditEntry {
  ts: string // ISO timestamp
  phase: SelfModPhase
  /** Stable id grouping all entries for one self-mod run (the project id). */
  runId: string
  /** Free-form brief the assistant gave for this run. */
  brief?: string
  /** The dedicated branch the team works on (never main). */
  branch?: string
  /** The base commit the run started from (for rollback). */
  baseCommit?: string
  /** Which gate this entry reports on, when phase === 'gate'. */
  gate?: string
  /** Whether the reported gate passed. */
  passed?: boolean
  /** Captured gate output / failure reason (truncated to keep the log sane). */
  detail?: string
  /** The commit produced by a promoted run. */
  resultCommit?: string
}

function auditPath(): string {
  return join(getCloxdeDir(), 'selfmod-audit.jsonl')
}

const MAX_DETAIL = 4000

/** Append one entry. Best-effort: a failed audit write must never abort the
 *  self-mod flow itself, but we log to stderr so it's not silent. The detail
 *  field is truncated so a gate dumping megabytes of output can't bloat the
 *  file unboundedly. */
export function recordSelfMod(entry: Omit<SelfModAuditEntry, 'ts'>): void {
  try {
    ensureCloxdeDir()
    const full: SelfModAuditEntry = {
      ts: new Date().toISOString(),
      ...entry,
      ...(entry.detail && entry.detail.length > MAX_DETAIL
        ? { detail: entry.detail.slice(0, MAX_DETAIL) + '…[truncated]' }
        : {})
    }
    appendFileSync(auditPath(), JSON.stringify(full) + '\n', 'utf-8')
  } catch (e) {
    console.error('[selfmod-audit] failed to write entry:', e)
  }
}

/** Read the full audit history (oldest first). Skips malformed lines rather
 *  than throwing — a partially-written final line shouldn't poison reads. */
export function readSelfModAudit(): SelfModAuditEntry[] {
  try {
    const path = auditPath()
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SelfModAuditEntry]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
