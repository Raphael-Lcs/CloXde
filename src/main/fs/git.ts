// Git working-tree inspection for the "改动" (changes) panel.
//
// Two operations, both scoped to a project's rootDir and read-only:
//   • gitStatus  — list files changed since the last commit (porcelain)
//   • gitDiffFile — unified diff for one file (tracked → `git diff HEAD`,
//                   untracked → `git diff --no-index` against /dev/null)
//
// We shell out to the user's `git` rather than pulling in a libgit2 binding:
// the project root is the agents' real working directory and almost always a
// repo the user already manages with their own git. Everything degrades
// gracefully when git is missing or the root isn't a repository.

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { GitChange, GitStatus, IpcResult } from '@shared/types'
import { ensureUnder } from './inspector'

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function err(message: string): IpcResult<never> {
  return { ok: false, error: message }
}

// Cap diff payloads so a huge generated file (lockfiles, snapshots) can't ship
// a multi-megabyte string into the renderer.
const DIFF_MAX_BYTES = 512 * 1024

export interface GitRun {
  code: number
  stdout: string
  stderr: string
}

/** Run git in `cwd`. Resolves (never rejects) with the exit code so callers
 *  can treat the "differences found" exit-1 from `git diff` as success. A
 *  missing git binary (ENOENT) resolves with code 127 and the error text. */
export function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code === 'string') {
          // Spawn failure (e.g. git not on PATH) — code is a string like 'ENOENT'.
          resolve({ code: 127, stdout: '', stderr: (error as Error).message })
          return
        }
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : 0
        resolve({ code, stdout, stderr })
      }
    )
  })
}

async function isRepo(root: string): Promise<boolean> {
  const r = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  return r.code === 0 && r.stdout.trim() === 'true'
}

/** Map a 2-char porcelain XY code to our coarse status. We collapse the
 *  staged/unstaged distinction — the panel cares "what changed", not where in
 *  the index it sits. */
function classify(xy: string): GitChange['status'] {
  if (xy === '??') return 'untracked'
  if (xy.includes('R')) return 'renamed'
  if (xy.includes('D')) return 'deleted'
  if (xy.includes('A')) return 'added'
  return 'modified'
}

export async function gitStatus(root: string): Promise<IpcResult<GitStatus>> {
  if (!(await isRepo(root))) {
    return ok<GitStatus>({ isRepo: false, changes: [] })
  }
  // NUL-delimited porcelain so paths with spaces / odd chars survive intact.
  const r = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (r.code !== 0) return err(r.stderr.trim() || `git status exited ${r.code}`)

  const changes: GitChange[] = []
  // -z format: each record is "XY <path>\0"; a rename adds a second \0-record
  // for the original path immediately after. We walk tokens manually.
  const tokens = r.stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (!tok) continue
    const xy = tok.slice(0, 2)
    const path = tok.slice(3) // skip "XY "
    const status = classify(xy)
    if (status === 'renamed') {
      // The following token is the original path.
      const oldPath = tokens[i + 1] ?? undefined
      i++
      changes.push({ path, status, oldPath })
    } else {
      changes.push({ path, status })
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path))
  return ok<GitStatus>({ isRepo: true, changes })
}

function clampDiff(s: string): string {
  if (s.length <= DIFF_MAX_BYTES) return s
  return s.slice(0, DIFF_MAX_BYTES) + '\n…（diff 过大，已截断）'
}

export async function gitDiffFile(
  root: string,
  relPath: string
): Promise<IpcResult<string>> {
  const abs = join(root, relPath)
  if (!ensureUnder(root, abs)) return err('out of bounds')
  if (!(await isRepo(root))) return err('not a git repository')

  // Tracked file: diff against HEAD (committed state). Covers staged +
  // unstaged so the user sees the full delta the agents produced this session.
  const tracked = await runGit(root, ['diff', 'HEAD', '--', relPath])
  if (tracked.code === 0 || tracked.code === 1) {
    if (tracked.stdout.trim()) return ok(clampDiff(tracked.stdout))
  }

  // No HEAD diff → likely untracked (or brand-new). --no-index against
  // /dev/null renders it as an all-additions diff. git treats /dev/null
  // specially on every platform; exit 1 just means "differences found".
  const untracked = await runGit(root, ['diff', '--no-index', '--', '/dev/null', relPath])
  if (untracked.code === 0 || untracked.code === 1) {
    return ok(clampDiff(untracked.stdout))
  }
  // Deleted-and-staged or some other case → fall back to whatever HEAD diff
  // produced (may be empty), surfacing stderr only if both failed hard.
  if (tracked.stdout.trim()) return ok(clampDiff(tracked.stdout))
  return err(untracked.stderr.trim() || tracked.stderr.trim() || '无可显示的 diff')
}
