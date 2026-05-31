// The assistant's proactive review loop. Unlike the team scheduler (which
// injects timed prompts into a specific conversation), this wakes the ASSISTANT
// to do acceptance-review (验收) of the teams it dispatched and decide next
// steps.
//
// Two hard rules, both from the 2026-05-31 design correction:
//   1. It is periodic, NOT per-turn-end. We do not fire the brain on every team
//      round — that's a probabilistic trigger the user rejected as unreasonable.
//   2. It only fires during a QUIET WINDOW (no team mid-turn). The brain is a
//      heavy local Claude Code / ONNX process; running it while a team works
//      would drag machine performance even though it wouldn't block the team.
//
// To avoid burning tokens on no-ops, a pass that finds no team activity newer
// than the last review simply skips thinking.

import { join } from 'node:path'
import { projectRepo, conversationRepo, messageRepo } from '../storage/db'
import { conversationEngine } from '../conversation/engine'
import { getWorkspaceDir } from '../paths'
import { getAssistantBrain, type Signal } from './brain'
import type { Message, Project } from '@shared/types'

type AnyBusyFn = () => boolean
type ThinkFn = (signal: Signal) => Promise<unknown>

const REVIEW_INTERVAL_MS = 5 * 60 * 1000
const MESSAGES_PER_CONV = 6

let timer: ReturnType<typeof setInterval> | null = null
let running = false
/** Newest team-message ts the brain has already reviewed. A pass that sees
 *  nothing newer skips, so a long-idle machine doesn't re-think the same state. */
let lastReviewedTs = 0

/** Projects the assistant itself scaffolded — those under its workspace. The
 *  assistant only reviews its own teams, not projects the user opened by hand. */
function ownedProjects(): Project[] {
  const root = join(getWorkspaceDir())
  return projectRepo.list().filter((p) => p.rootDir.startsWith(root))
}

function renderMessageText(m: Message): string {
  const text = m.blocks
    .map((b) => (b.type === 'text' ? b.text : b.type === 'plan' ? '[plan]' : ''))
    .join('')
    .trim()
  return text
}

/** Build a compact snapshot of recent team activity across owned projects, and
 *  the newest message ts seen. Returns null when there's nothing to review. */
function gatherSnapshot(): { text: string; newestTs: number } | null {
  const sections: string[] = []
  let newestTs = 0
  for (const project of ownedProjects()) {
    const convs = conversationRepo.listByProject(project.id)
    if (convs.length === 0) continue
    const conv = convs[0] // listByProject is created_at DESC → most recent first
    const msgs = messageRepo.listRecentByConversation(conv.id, MESSAGES_PER_CONV)
    if (msgs.length === 0) continue
    const convNewest = msgs[msgs.length - 1].ts
    if (convNewest > newestTs) newestTs = convNewest
    const lines = msgs
      .map((m) => {
        const t = renderMessageText(m)
        return t ? `  [${m.side}] ${t.slice(0, 500)}` : ''
      })
      .filter(Boolean)
      .join('\n')
    sections.push(
      `# 项目「${project.name}」(状态 ${conv.status})\n${lines || '  （无文本消息）'}`
    )
  }
  if (sections.length === 0 || newestTs <= lastReviewedTs) return null
  return { text: sections.join('\n\n'), newestTs }
}

async function runPass(anyBusy: AnyBusyFn, think: ThinkFn): Promise<void> {
  if (running) return // a slow brain pass must not overlap the next tick
  if (anyBusy()) return // quiet-window gate: never run the brain while a team works
  const snapshot = gatherSnapshot()
  if (!snapshot) return
  running = true
  try {
    await think({
      kind: 'review',
      text: `以下是你派出的团队的最新进展，请验收并决定下一步（如需继续推进就 <<DISPATCH>>，有值得告知用户的就 <<REPORT>>）：\n\n${snapshot.text}`
    })
    lastReviewedTs = snapshot.newestTs
  } catch (e) {
    console.error('[assistant-review] pass failed:', (e as Error).message)
  } finally {
    running = false
  }
}

/** Start the periodic review loop. Dependencies are injectable for tests;
 *  defaults wire the live engine + brain. */
export function startAssistantReview(opts?: {
  anyBusy?: AnyBusyFn
  think?: ThinkFn
  intervalMs?: number
}): void {
  if (timer) return
  const anyBusy = opts?.anyBusy ?? (() => conversationEngine.anyBusy())
  const think = opts?.think ?? ((s: Signal) => getAssistantBrain().think(s))
  // Seed lastReviewedTs to "now" so the first pass reviews only NEW activity,
  // not the entire backlog from before the app started.
  lastReviewedTs = Date.now()
  timer = setInterval(
    () => void runPass(anyBusy, think),
    opts?.intervalMs ?? REVIEW_INTERVAL_MS
  )
  if (typeof timer.unref === 'function') timer.unref()
}

export function stopAssistantReview(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  running = false
  lastReviewedTs = 0
}
