// Self-modification (Milestone 2): the assistant treats "improve CloXde itself"
// as a project. Unlike a normal dispatch — which scaffolds an empty folder in
// the workspace — a self-improvement run targets CloXde's OWN source. To keep
// the running app's working tree untouched while a team edits code, we hand the
// team an isolated git WORKTREE on a dedicated branch:
//
//   repoRoot (current branch, the running app)  ──worktree add──▶  worktreeDir
//                                                                   (selfmod/<slug> branch)
//
// The team works entirely inside worktreeDir. Nothing it does touches the files
// the live app is running from. Only after every gate passes (typecheck/test/
// build/smoke — see gates.ts) does the branch merge back into the running
// branch and the app restart onto the new code. A failed run just discards the
// worktree; the live tree never saw it.
//
// Everything here is gated by isSelfModAvailable(): a packaged build has no .git
// to branch from, so self-mod is a dev-only capability for now.

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { runGit } from '../fs/git'
import { getRepoRoot, isSelfModAvailable, getCloxdeDir } from '../paths'
import { projectRepo, profileRepo } from '../storage/db'
import { briefTeam } from './actions'
import { recordSelfMod } from './selfmod-audit'
import { runGates, allGatesPassed, firstFailure, type GateResult, type GateRunOptions } from './gates'
import type { AgentKind, Conversation, Project } from '@shared/types'

export interface SelfImprovementInput {
  /** Short human-readable name for the run (basis for branch + project name). */
  name: string
  /** The brief handed to the team — what to change in CloXde and why. */
  brief: string
  title?: string
  architectKind?: AgentKind
  executorKind?: AgentKind
  pmKind?: AgentKind
}

export interface SelfImprovementHandle {
  project: Project
  conversation: Conversation
  branch: string
  worktreeDir: string
  baseCommit: string
}

export class SelfModUnavailableError extends Error {
  constructor() {
    super('自我修改当前不可用：需要从 git 源码树运行（非打包态）。')
    this.name = 'SelfModUnavailableError'
  }
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'selfmod'
}

/** Directory under ~/.cloxde where self-mod worktrees live. Kept OUT of the
 *  normal workspace so they don't mingle with user projects and so the
 *  owned-project review heuristic doesn't pick them up. */
function worktreesRoot(): string {
  return join(getCloxdeDir(), 'selfmod-worktrees')
}

/** Resolve the current HEAD commit + branch of the live repo. The branch is
 *  the one the app is running on and the one a successful run merges back into. */
async function currentHead(repoRoot: string): Promise<{ commit: string; branch: string }> {
  const commit = await runGit(repoRoot, ['rev-parse', 'HEAD'])
  const branch = await runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (commit.code !== 0) {
    throw new Error(`无法读取当前 commit：${commit.stderr.trim() || commit.code}`)
  }
  return { commit: commit.stdout.trim(), branch: branch.stdout.trim() || 'HEAD' }
}

/** Allocate a unique worktree dir + branch name for `base` slug, appending
 *  a counter if the bare name collides with an existing worktree/branch. */
async function allocate(
  repoRoot: string,
  base: string
): Promise<{ branch: string; dir: string }> {
  for (let n = 0; n < 100; n++) {
    const suffix = n === 0 ? base : `${base}-${n}`
    const branch = `selfmod/${suffix}`
    const dir = join(worktreesRoot(), suffix)
    const dirFree = !existsSync(dir)
    const branchProbe = await runGit(repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`
    ])
    const branchFree = branchProbe.code !== 0 // non-zero = branch doesn't exist
    if (dirFree && branchFree) return { branch, dir }
  }
  throw new Error('无法为自改运行分配唯一的 worktree/分支名')
}

/**
 * Set up an isolated self-improvement run and dispatch a team into it.
 *
 * Steps:
 *   1. Guard: self-mod must be available (dev / real git tree).
 *   2. Snapshot the live HEAD (base commit + branch to merge back into).
 *   3. `git worktree add -b selfmod/<slug> <dir> <baseCommit>` — a fresh
 *      checkout on a new branch, physically separate from the running tree.
 *   4. Register a project whose rootDir IS the worktree, seed agent profiles.
 *   5. Brief a team into it with the improvement brief.
 *   6. Audit: record the dispatch.
 *
 * Returns the handle (project/conversation/branch/dir/baseCommit). Gate-running
 * and promotion are separate steps the caller drives once the team settles.
 */
export async function dispatchSelfImprovement(
  input: SelfImprovementInput
): Promise<SelfImprovementHandle> {
  if (!isSelfModAvailable()) throw new SelfModUnavailableError()
  const repoRoot = getRepoRoot()!

  const { commit: baseCommit, branch: baseBranch } = await currentHead(repoRoot)
  const { branch, dir } = await allocate(repoRoot, slug(input.name))

  // Create the worktree on a new branch rooted at the live HEAD. --quiet keeps
  // the output terse; failures surface via exit code + stderr.
  const add = await runGit(repoRoot, ['worktree', 'add', '-b', branch, dir, baseCommit])
  if (add.code !== 0) {
    throw new Error(`创建 worktree 失败：${add.stderr.trim() || add.stdout.trim() || add.code}`)
  }

  let project: Project
  try {
    project = projectRepo.upsertByRoot({ name: `自改 · ${input.name}`, rootDir: dir })
    profileRepo.ensureDefaults(project.id)
  } catch (e) {
    // Roll back the worktree if project registration blows up, so a half-set-up
    // run doesn't leave a dangling worktree behind.
    await discardWorktree(repoRoot, dir, branch)
    throw e
  }

  const conversation = await briefTeam({
    projectId: project.id,
    brief: input.brief,
    title: input.title ?? input.name,
    architectKind: input.architectKind,
    executorKind: input.executorKind,
    pmKind: input.pmKind
  })

  recordSelfMod({
    phase: 'dispatched',
    runId: project.id,
    brief: input.brief,
    branch,
    baseCommit,
    detail: `base 分支=${baseBranch}, worktree=${dir}`
  })

  return { project, conversation, branch, worktreeDir: dir, baseCommit }
}

/** Tear down a worktree + its branch. Best-effort and idempotent: used both to
 *  roll back a half-set-up run and to discard a rejected one. --force lets us
 *  remove a worktree with uncommitted scratch; branch -D drops the unmerged
 *  branch. Errors are swallowed (the dir/branch may already be gone). */
async function discardWorktree(repoRoot: string, dir: string, branch: string): Promise<void> {
  await runGit(repoRoot, ['worktree', 'remove', '--force', dir])
  await runGit(repoRoot, ['branch', '-D', branch])
  // Prune any stale worktree admin entries (e.g. if the dir was deleted by hand).
  await runGit(repoRoot, ['worktree', 'prune'])
}

export interface PromotionResult {
  promoted: boolean
  gateResults: GateResult[]
  /** The merge commit / new HEAD on the base branch, when promoted. */
  resultCommit?: string
  /** Why a run was rejected (failing gate, no changes, merge conflict). */
  reason?: string
  /** True when a restart is needed to run the newly-merged code. */
  needsRestart: boolean
}

/**
 * Run the gate sequence against a self-improvement worktree and, if every gate
 * passes, merge the branch back into the running branch. On any failure the
 * worktree is discarded and nothing touches the live tree.
 *
 * Merge policy is fast-forward-only: the branch was cut from the live HEAD, so
 * a clean ff just advances the running branch onto the new commits — no merge
 * commit, no possibility of a conflict. If the base advanced underneath us
 * (ff impossible), we REJECT rather than attempt a risky 3-way merge of CloXde
 * into itself; the assistant can re-dispatch from the new base.
 *
 * Returns a PromotionResult; `needsRestart` is true only when promoted (the
 * caller then asks the watchdog to restart onto the new code — see step 7).
 */
export async function promoteSelfImprovement(
  handle: SelfImprovementHandle,
  gateOpts?: Partial<GateRunOptions>
): Promise<PromotionResult> {
  if (!isSelfModAvailable()) throw new SelfModUnavailableError()
  const repoRoot = getRepoRoot()!
  const { project, branch, worktreeDir, baseCommit } = handle

  // The team works in a worktree but must COMMIT for there to be anything to
  // merge. If the branch has no commits beyond base, there's nothing to promote.
  const ahead = await runGit(repoRoot, ['rev-list', '--count', `${baseCommit}..${branch}`])
  if (ahead.code === 0 && ahead.stdout.trim() === '0') {
    await discardWorktree(repoRoot, worktreeDir, branch)
    recordSelfMod({
      phase: 'rejected',
      runId: project.id,
      branch,
      baseCommit,
      detail: '团队未在分支上提交任何改动，无可晋升内容'
    })
    return {
      promoted: false,
      gateResults: [],
      needsRestart: false,
      reason: '团队未提交任何改动'
    }
  }

  // Run gates inside the worktree.
  const gateResults = await runGates({
    cwd: worktreeDir,
    ...gateOpts,
    onProgress: (gate, phase) => {
      gateOpts?.onProgress?.(gate, phase)
      if (phase !== 'start') {
        recordSelfMod({
          phase: 'gate',
          runId: project.id,
          branch,
          baseCommit,
          gate,
          passed: phase === 'pass'
        })
      }
    }
  })

  if (!allGatesPassed(gateResults)) {
    const fail = firstFailure(gateResults)
    await discardWorktree(repoRoot, worktreeDir, branch)
    recordSelfMod({
      phase: 'rejected',
      runId: project.id,
      branch,
      baseCommit,
      gate: fail?.gate,
      passed: false,
      detail: fail?.detail
    })
    return {
      promoted: false,
      gateResults,
      needsRestart: false,
      reason: `闸门未通过：${fail?.gate ?? '未知'}`
    }
  }

  // All gates green → fast-forward the running branch onto the self-mod branch.
  const merge = await runGit(repoRoot, ['merge', '--ff-only', branch])
  if (merge.code !== 0) {
    // base moved underneath us; refuse the 3-way merge. Keep the worktree so the
    // assistant can rebase + re-promote rather than losing the validated work.
    recordSelfMod({
      phase: 'rejected',
      runId: project.id,
      branch,
      baseCommit,
      detail: `快进合并失败（base 已前移），需 rebase：${merge.stderr.trim() || merge.stdout.trim()}`
    })
    return {
      promoted: false,
      gateResults,
      needsRestart: false,
      reason: '快进合并失败：主分支已前移，需要先 rebase'
    }
  }

  const head = await runGit(repoRoot, ['rev-parse', 'HEAD'])
  const resultCommit = head.stdout.trim()

  // Merged into the running branch → the worktree/branch are now redundant.
  await discardWorktree(repoRoot, worktreeDir, branch)

  recordSelfMod({
    phase: 'promoted',
    runId: project.id,
    branch,
    baseCommit,
    resultCommit,
    passed: true,
    detail: `已快进合并回主分支；新 HEAD=${resultCommit}`
  })

  return { promoted: true, gateResults, resultCommit, needsRestart: true }
}

/**
 * Request a restart onto newly-promoted code. The watchdog launcher recognizes
 * exit code 42 as "self-mod promotion succeeded; restart immediately". This is
 * a HARD exit (app.exit, not app.quit) so it bypasses the before-quit cleanup
 * and doesn't wait for async teardown — the new code is already on disk and
 * the watchdog will boot it in <2s. Only call this after a successful promotion.
 */
export function restartIntoNewCode(): void {
  const { app } = require('electron') as typeof import('electron')
  console.log('[selfmod] restarting into promoted code (exit 42)')
  app.exit(42)
}
