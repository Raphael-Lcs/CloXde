// The assistant's *structured* action surface — the directives the brain emits
// as tag blocks (parsed in brain.ts) turn into calls here.
//
// NOTE (revised 2026-05-31): this is NOT the brain's whole reach. The brain is a
// full tool-capable ACP agent — it reads/writes files and runs commands with its
// own hands (see brain.ts → allowAllPermission + readWriteFs). The functions
// below are the *team-aware* levers layered on top of that:
//   • createProject  — scaffold a project in its own workspace
//   • briefTeam      — open a team conversation and hand it a brief (where a
//                      substantial build/feature/fix is carried out by the team)
//   • dispatchProject — the common case: create + brief in one call
//   • remember / recall — read & write its own long-term memory
//   • reportToUser   — surface a proactive message to the user (via the bus)
//   • emitActivity   — stream live turn progress to the UI
//
// The division of labor is judgment, not capability: small/查证/一次性 work the
// brain does directly with its tools; substantial work it DISPATCHes to a team.

import { EventEmitter } from 'node:events'
import type {
  AgentKind,
  AssistantActivity,
  AssistantMemory,
  AssistantReminder,
  AssistantReport,
  Conversation,
  MemoryHit,
  MemoryKind,
  Project
} from '@shared/types'
import { conversationRepo, profileRepo, projectRepo, assistantReminderRepo } from '../storage/db'
import { conversationEngine } from '../conversation/engine'
import { createProject } from './workspace'
import { getMemoryService, type RememberInput } from './memory'
import {
  dispatchSelfImprovement as dispatchSelfImprovementCore,
  promoteSelfImprovement,
  restartIntoNewCode,
  type SelfImprovementInput,
  type SelfImprovementHandle
} from './selfmod'

export interface BriefTeamInput {
  projectId: string
  /** The kickoff brief, sent to the team's PM as the first user message. */
  brief: string
  title?: string
  architectKind?: AgentKind
  executorKind?: AgentKind
  pmKind?: AgentKind
}

export interface DispatchInput {
  name: string
  brief: string
  title?: string
  architectKind?: AgentKind
  executorKind?: AgentKind
  pmKind?: AgentKind
}

/** The assistant's outbound channel to the user. The IPC/UI layer subscribes to
 *  'report'; until that surface exists, reports are still emitted (and logged)
 *  so nothing is silently lost. */
export const assistantBus = new EventEmitter()

/** Open a team conversation in an existing project and hand it the brief as the
 *  kickoff message. Defaults to a full PM + architect + executor team in
 *  autopilot — the same shape the UI creates. Returns the conversation. */
export async function briefTeam(input: BriefTeamInput): Promise<Conversation> {
  const project = projectRepo.get(input.projectId)
  if (!project) throw new Error(`project not found: ${input.projectId}`)
  profileRepo.ensureDefaults(project.id)

  const architectKind = input.architectKind ?? project.defaultArchitect
  const executorKind = input.executorKind ?? project.defaultExecutor
  const pmKind = input.pmKind ?? 'claude'

  const architect = profileRepo.findByKind(project.id, architectKind)
  const executor = profileRepo.findByKind(project.id, executorKind)
  const pm = profileRepo.findByKind(project.id, pmKind)
  if (!architect || !executor) throw new Error('agent profile missing')
  if (!pm) throw new Error('PM profile missing')

  const conv = conversationRepo.create({
    projectId: project.id,
    title: input.title ?? project.name,
    pmKind,
    architectKind,
    executorKind,
    primarySide: 'architect',
    autopilot: true
  })

  await conversationEngine.sendUserMessage(conv.id, input.brief)
  return conv
}

/** The common case: scaffold a project in the workspace and immediately brief a
 *  team into it. Returns both the project and the team conversation. */
export async function dispatchProject(
  input: DispatchInput
): Promise<{ project: Project; conversation: Conversation }> {
  const project = createProject({ name: input.name })
  const conversation = await briefTeam({
    projectId: project.id,
    brief: input.brief,
    title: input.title ?? input.name,
    architectKind: input.architectKind,
    executorKind: input.executorKind,
    pmKind: input.pmKind
  })
  // Notify UI that a new project was created so it can refresh its project list
  assistantBus.emit('project-created', { projectId: project.id })
  return { project, conversation }
}

/** Send a follow-up message into an EXISTING team conversation, so the assistant
 *  can nudge / re-brief / answer a team it already dispatched instead of always
 *  spinning up a brand-new project. Resolves the target by conversationId, or
 *  falls back to the most recent conversation of a project. Returns the
 *  conversation's name + id for the turn summary. */
export async function continueTeam(input: {
  conversationId?: string
  projectId?: string
  message: string
}): Promise<{ name: string; projectId: string; conversationId: string }> {
  let conv: Conversation | null = null
  if (input.conversationId) {
    conv = conversationRepo.get(input.conversationId)
  }
  if (!conv && input.projectId) {
    // listByProject is created_at DESC. Prefer the most recent team that isn't
    // already ended — continuing a finished team would silently revive it,
    // which is rarely what the brain means. Fall back to the newest of any
    // status only if every team has ended.
    const convs = conversationRepo.listByProject(input.projectId)
    conv = convs.find((c) => c.status !== 'ended') ?? convs[0] ?? null
  }
  if (!conv) throw new Error('target team conversation not found')
  // Queue behind any in-flight team turn (preempt: false) instead of cutting it
  // off — the assistant nudging a team must not interrupt work the team is
  // actively doing; the message lands once the current cascade settles.
  await conversationEngine.sendUserMessage(conv.id, input.message, undefined, undefined, {
    preempt: false
  })
  // Increment the assistant nudge counter after sending CONTINUE. This tracks how
  // many times the assistant has tried to unstick this team. Reset happens in the
  // engine when the team unsticks (status != awaiting-user) or when the user
  // manually intervenes (sendUserMessage with preempt=true).
  if (conv.status === 'awaiting-user') {
    const newCount = conv.assistantNudgeCount + 1
    conversationRepo.patch(conv.id, {
      assistantNudgeCount: newCount
    })
    console.log(
      `[assistant] CONTINUE sent to ${conv.id.slice(0, 8)}, nudge count: ${conv.assistantNudgeCount} → ${newCount}`
    )
  }
  const project = projectRepo.get(conv.projectId)
  return {
    name: project?.name ?? conv.title ?? '未命名团队',
    projectId: conv.projectId,
    conversationId: conv.id
  }
}

/** Write a memory. Thin passthrough to the memory service so the assistant's
 *  action vocabulary is in one place. */
export function remember(input: RememberInput): Promise<AssistantMemory> {
  return getMemoryService().remember(input)
}

/** Semantic recall. */
export function recall(
  query: string,
  opts?: { k?: number; kind?: MemoryKind }
): Promise<MemoryHit[]> {
  return getMemoryService().recall(query, opts)
}

/** Retract a memory the brain has decided is now false or superseded. Thin
 *  passthrough so the brain's action vocabulary stays in one place. */
export function forget(id: string): void {
  getMemoryService().forget(id)
}

/** Rewrite an existing memory's content in place, re-embedding it. The brain uses
 *  this to improve a skill it just reused (a better way than the stored steps)
 *  WITHOUT piling up a near-duplicate the dedup heuristic won't fold. */
export function updateMemory(id: string, content: string): Promise<void> {
  return getMemoryService().update(id, { content })
}

/** Set a self-reminder: a future wake-up that fires a 'cron' signal back into the
 *  brain carrying `note`. One-shot when `cron` is absent; recurring when set. The
 *  review loop scans due reminders and fires them during a quiet window. */
export function scheduleReminder(input: {
  fireAt: number
  note: string
  cron?: string
}): AssistantReminder {
  return assistantReminderRepo.create(input)
}

/** Surface a message to the user. Emits on the assistant bus and logs so the
 *  report survives even before a UI subscribes. */
export function reportToUser(report: Omit<AssistantReport, 'ts'>): void {
  const full: AssistantReport = { ts: Date.now(), ...report }
  console.log('[assistant] report:', full.message)
  assistantBus.emit('report', full)
}

/** Emit live turn progress (thinking / using a tool / blocked / done) so the UI
 *  can show the brain is actually working instead of a dead spinner. The 'ts'
 *  is stamped here; callers pass just phase + optional text. */
export function emitActivity(activity: Omit<AssistantActivity, 'ts'>): void {
  assistantBus.emit('activity', { ts: Date.now(), ...activity } as AssistantActivity)
}

// =============================================================================
//                          SELF-MODIFICATION (M2)
// =============================================================================

/** Dispatch a self-improvement run: create an isolated worktree + branch, brief
 *  a team into it. The brain calls this when the user asks it to improve CloXde
 *  itself. Returns the handle the brain uses to later promote (or discard) the
 *  run once the team settles. Only available in dev (isSelfModAvailable). */
export async function dispatchSelfImprovement(
  input: SelfImprovementInput
): Promise<SelfImprovementHandle> {
  return dispatchSelfImprovementCore(input)
}

/** Run gates + promote a self-improvement run. The brain calls this after the
 *  team it dispatched has settled (status awaiting-user or ended). If all gates
 *  pass, the branch merges back and the app restarts onto the new code. On any
 *  failure the worktree may be preserved for retry (depending on options). The
 *  brain surfaces the verdict to the user and, on rejection, can re-brief the
 *  team with the gate failure detail. */
export async function promoteSelfImprovementRun(
  handle: SelfImprovementHandle,
  opts?: { discardOnFailure?: boolean }
): Promise<{ promoted: boolean; reason?: string; discarded?: boolean }> {
  emitActivity({ phase: 'tool', text: '正在运行闸门序列（install/typecheck/test/build/smoke）…' })
  const result = await promoteSelfImprovement(handle, {
    onProgress: (gate, phase) => {
      if (phase === 'start') emitActivity({ phase: 'tool', text: `闸门: ${gate}` })
    },
    discardOnFailure: opts?.discardOnFailure
  })
  if (result.promoted) {
    emitActivity({ phase: 'tool', text: '所有闸门通过，已合并新代码，即将重启…' })
    // Give the UI a moment to render the success message before we hard-exit.
    setTimeout(() => restartIntoNewCode(), 1500)
    return { promoted: true }
  }
  return { promoted: false, reason: result.reason, discarded: result.discarded }
}
