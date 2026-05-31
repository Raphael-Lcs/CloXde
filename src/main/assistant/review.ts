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
import { getMemoryService } from './memory'
import type { Message, Project } from '@shared/types'

type AnyBusyFn = () => boolean
type ThinkFn = (signal: Signal) => Promise<unknown>
type TurnCountFn = () => number

const REVIEW_INTERVAL_MS = 5 * 60 * 1000
const MESSAGES_PER_CONV = 6
/** How often the decay pass runs. Memory is otherwise append-only, so without
 *  this it grows unbounded — stale, low-confidence, unpinned memories never
 *  leave. Daily is plenty: pruning is cheap and the staleness window is 30d. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
/** How often the self-distillation (reflection) pass runs. It wakes the brain to
 *  mine its own recent conversation for durable facts/preferences and store them
 *  via <<REMEMBER>>. It costs a full model turn, so it is deliberately rare AND
 *  only fires when the brain actually had new turns since the last reflection. */
const REFLECT_INTERVAL_MS = 6 * 60 * 60 * 1000

/** The signal text for a reflection pass. The brain already holds its recent
 *  exchanges in-session, so we just ask it to distill them — silently. No prose
 *  reply is surfaced for a 'reflection' turn (runPass discards the result), so we
 *  tell it not to chat: just emit <<REMEMBER>> lines (or nothing). */
const REFLECTION_PROMPT = `这是一次后台自我整理（用户看不到你这轮的话，不用回复客套话）。回顾你最近与用户的交流，把其中**值得长期记住**的内容提炼成记忆：用户的偏好/习惯、关于用户或项目的稳定事实、做事的方式约定等。每条用一个 <<REMEMBER>>{"kind":"...","content":"一句话"}<</REMEMBER>> 记下，一句一条、去重、只记真正有长期价值的，别记流水账或临时任务细节。没有值得记的就什么都不做。`

let timer: ReturnType<typeof setInterval> | null = null
let running = false
let lastPrunedAt = 0
/** When the last reflection pass ran, and the brain's turn count at that time.
 *  Together they gate reflection: at most once per interval, and only if the
 *  brain has had new turns since (otherwise there's nothing new to distill). */
let lastReflectedAt = 0
let lastReflectedTurns = 0
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
      `# 项目「${project.name}」(状态 ${conv.status}, 会话ID ${conv.id})\n${lines || '  （无文本消息）'}`
    )
  }
  if (sections.length === 0 || newestTs <= lastReviewedTs) return null
  return { text: sections.join('\n\n'), newestTs }
}

/** Run the memory decay pass at most once per PRUNE_INTERVAL_MS. Pure DB work
 *  (no model), so it's exempt from the quiet-window gate. */
function maybePrune(): void {
  const now = Date.now()
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return
  lastPrunedAt = now
  try {
    const dropped = getMemoryService().prune()
    if (dropped > 0) console.log(`[assistant-review] pruned ${dropped} stale memories`)
  } catch (e) {
    console.error('[assistant-review] prune failed:', (e as Error).message)
  }
}

/** Run the self-distillation pass at most once per REFLECT_INTERVAL_MS, and only
 *  when the brain has had new turns since the last reflection (otherwise there's
 *  nothing new to mine and we'd burn a model turn for nothing). Returns true if
 *  it reflected this pass, so the caller can skip the team review and not
 *  double-spend the brain in one tick. Assumes the quiet-window + brain-free
 *  gates already passed (it runs the model). */
async function maybeReflect(think: ThinkFn, turnCount: TurnCountFn): Promise<boolean> {
  const now = Date.now()
  if (now - lastReflectedAt < REFLECT_INTERVAL_MS) return false
  const turns = turnCount()
  if (turns <= lastReflectedTurns) return false // no new conversation to distill
  lastReflectedAt = now
  lastReflectedTurns = turns
  try {
    await think({ kind: 'reflection', text: REFLECTION_PROMPT })
  } catch (e) {
    console.error('[assistant-review] reflection failed:', (e as Error).message)
  }
  return true
}

async function runPass(
  anyBusy: AnyBusyFn,
  think: ThinkFn,
  brainBusy: AnyBusyFn,
  turnCount: TurnCountFn
): Promise<void> {
  maybePrune() // cheap, model-free — run regardless of the quiet-window gate
  if (running) return // a slow brain pass must not overlap the next tick
  if (anyBusy()) return // quiet-window gate: never run the brain while a team works
  if (brainBusy()) return // …or while the user is mid-conversation with it
  running = true
  try {
    // Reflection and team-review both spend a brain turn; run at most one per
    // tick. Reflection has its own (much longer) interval gate, so most ticks
    // fall through to review.
    if (await maybeReflect(think, turnCount)) return
    const snapshot = gatherSnapshot()
    if (!snapshot) return
    await think({
      kind: 'review',
      text: `以下是你派出的团队的最新进展，请验收并决定下一步：\n- 想推动某个**已存在**的团队继续干（补充要求、纠偏、回答它的问题），用 <<CONTINUE>>{"conversationId":"上面给的会话ID","message":"要对团队说的话"}<</CONTINUE>>。\n- 只有需要**全新**项目时才 <<DISPATCH>>。\n- 有值得告知用户的就 <<REPORT>>。\n\n${snapshot.text}`
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
  brainBusy?: AnyBusyFn
  turnCount?: TurnCountFn
  intervalMs?: number
}): void {
  if (timer) return
  const anyBusy = opts?.anyBusy ?? (() => conversationEngine.anyBusy())
  const think = opts?.think ?? ((s: Signal) => getAssistantBrain().think(s))
  const brainBusy = opts?.brainBusy ?? (() => getAssistantBrain().isBusy())
  const turnCount = opts?.turnCount ?? (() => getAssistantBrain().turnCount())
  // Seed lastReviewedTs to "now" so the first pass reviews only NEW activity,
  // not the entire backlog from before the app started.
  lastReviewedTs = Date.now()
  // Seed the reflection gate so the first distillation waits a full interval and
  // only counts turns that happen from now on.
  lastReflectedAt = Date.now()
  lastReflectedTurns = turnCount()
  timer = setInterval(
    () => void runPass(anyBusy, think, brainBusy, turnCount),
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
  lastPrunedAt = 0
  lastReflectedAt = 0
  lastReflectedTurns = 0
}
