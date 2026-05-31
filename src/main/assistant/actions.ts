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
  AssistantReport,
  Conversation,
  MemoryHit,
  MemoryKind,
  Project
} from '@shared/types'
import { conversationRepo, profileRepo, projectRepo } from '../storage/db'
import { conversationEngine } from '../conversation/engine'
import { createProject } from './workspace'
import { getMemoryService, type RememberInput } from './memory'

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
    pmProfileId: pm.id,
    architectProfileId: architect.id,
    executorProfileId: executor.id,
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
