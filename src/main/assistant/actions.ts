// The assistant's action surface — the ONLY things it is allowed to *do*.
//
// This module is where the project's hard boundary lives: the assistant
// discovers, decides, and delegates, but never writes code itself. Concretely
// its levers are:
//   • createProject  — scaffold a project in its own workspace
//   • briefTeam      — open a team conversation and hand it a brief (all coding
//                      happens here, inside the team)
//   • dispatchProject — the common case: create + brief in one call
//   • remember / recall — read & write its own long-term memory
//   • reportToUser   — surface something to the user (via the assistant bus)
//
// There is deliberately no "edit file" / "run command" action. The assistant's
// hands-on filesystem reach stops at creating a project directory; everything
// else is delegated to the team it dispatches.

import { EventEmitter } from 'node:events'
import type {
  AgentKind,
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
