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
import { projectRepo, conversationRepo, messageRepo, assistantMessageRepo } from '../storage/db'
import { conversationEngine, type InstabilityEvent } from '../conversation/engine'
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
/** Retention cap for the assistant's persisted chat thread. It's a single
 *  ever-growing log (not bounded by conversation lifecycle), so the daily prune
 *  also trims it back to the most recent N rows. Generous — the brain only
 *  hydrates the last ~60, and the panel lists 500. */
const MESSAGE_RETENTION = 2000
/** How often the self-distillation (reflection) pass runs. It wakes the brain to
 *  mine its own recent conversation for durable facts/preferences and store them
 *  via <<REMEMBER>>. It costs a full model turn, so it is deliberately rare AND
 *  only fires when the brain actually had new turns since the last reflection. */
const REFLECT_INTERVAL_MS = 6 * 60 * 60 * 1000
export const REFLECT_INTERVAL_MS_FOR_TEST = REFLECT_INTERVAL_MS

/** The signal text for a reflection pass. The brain already holds its recent
 *  exchanges in-session, so we just ask it to distill them — silently. No prose
 *  reply is surfaced for a 'reflection' turn (runPass discards the result), so we
 *  tell it not to chat: just emit <<REMEMBER>> lines (or nothing). */
const REFLECTION_PROMPT = `这是一次后台自我整理（用户看不到你这轮的话，不用回复客套话）。回顾你最近与用户的交流，把其中**值得长期记住**的内容提炼成记忆，每条用一个 <<REMEMBER>>{"kind":"...","content":"一句话"}<</REMEMBER>> 记下：
- 事实/偏好类：用户的偏好习惯、关于用户或项目的稳定事实、做事方式约定（kind 用 preference/fact/project/person/pattern）。
- 技能类（kind:"skill"）：如果这轮交流里你自己趟通了某个流程、找到了某件事在这台机器/这个项目里的正确做法、或踩坑后总结出可复用的步骤，就沉淀成一条技能——写清在什么情况下、按什么步骤、要注意什么，让下次照着就能做。（团队做成的活会在验收时单独提炼，这里只管你自己的对话。）
一句一条、去重、只记真正有长期价值的，别记流水账或临时任务细节。没有值得记的就什么都不做。`

/** How many already-stored memories to show the brain during reflection, so it
 *  doesn't re-emit things it already knows. Capped so the dedup context stays a
 *  hint, not a context-window hog. Pinned + freshest first (memoryRepo.list
 *  ordering), which is exactly what's most likely to be restated. */
const REFLECTION_DEDUP_CONTEXT = 40

/** Build the reflection signal text, optionally prefixed with the memories the
 *  brain has already stored. The embedding-layer upsert already folds exact
 *  near-duplicates, but that still costs a model-emitted <<REMEMBER>> and a
 *  re-embed; surfacing what's known lets the brain skip restating it at the
 *  source, so reflection turns stay lean. */
function buildReflectionPrompt(existing: { kind: string; content: string }[]): string {
  if (existing.length === 0) return REFLECTION_PROMPT
  const lines = existing.map((m) => `  - (${m.kind}) ${m.content}`).join('\n')
  return `${REFLECTION_PROMPT}\n\n你**已经记住**了下面这些，别再重复记录（除非有实质性更新或纠正）：\n${lines}`
}

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
 *  the newest message ts seen. `stuck` is true when at least one owned team is
 *  waiting for intervention — under autopilot, status 'awaiting-user' means the
 *  engine halted (protocol slip / crash / blocked) rather than finished, since a
 *  completed autopilot run settles to 'ended'. That's a capability-gap the brain
 *  should prioritize. Returns null when there's nothing to review. */
function gatherSnapshot(): { text: string; newestTs: number; stuck: boolean } | null {
  const sections: string[] = []
  let newestTs = 0
  let stuck = false
  for (const project of ownedProjects()) {
    const convs = conversationRepo.listByProject(project.id)
    if (convs.length === 0) continue
    const conv = convs[0] // listByProject is created_at DESC → most recent first
    const msgs = messageRepo.listRecentByConversation(conv.id, MESSAGES_PER_CONV)
    if (msgs.length === 0) continue
    const convNewest = msgs[msgs.length - 1].ts
    if (convNewest > newestTs) newestTs = convNewest
    const needsAttention = conv.autopilot && conv.status === 'awaiting-user'
    if (needsAttention) stuck = true
    const lines = msgs
      .map((m) => {
        const t = renderMessageText(m)
        return t ? `  [${m.side}] ${t.slice(0, 500)}` : ''
      })
      .filter(Boolean)
      .join('\n')
    const flag = needsAttention ? ' ⚠️卡住·待你决策' : ''
    sections.push(
      `# 项目「${project.name}」(状态 ${conv.status}, 会话ID ${conv.id})${flag}\n${lines || '  （无文本消息）'}`
    )
  }
  if (sections.length === 0 || newestTs <= lastReviewedTs) return null
  return { text: sections.join('\n\n'), newestTs, stuck }
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
  try {
    const trimmed = assistantMessageRepo.trimToLast(MESSAGE_RETENTION)
    if (trimmed > 0) console.log(`[assistant-review] trimmed ${trimmed} old assistant messages`)
  } catch (e) {
    console.error('[assistant-review] message trim failed:', (e as Error).message)
  }
}

/** Pure decision for the reflection gate, extracted so it can be unit-tested
 *  without the DB/model. Reflect only when BOTH hold: at least `intervalMs` has
 *  elapsed since the last reflection, AND the user has had new turns since then
 *  (currentTurns > lastReflectedTurns). The turn-delta guard is what stops a
 *  reflection turn from re-triggering itself: reflection/review turns don't bump
 *  the user turn count, so an idle machine never reflects twice in a row. */
export function shouldReflect(
  now: number,
  lastAt: number,
  lastTurns: number,
  currentTurns: number,
  intervalMs: number
): boolean {
  if (now - lastAt < intervalMs) return false
  return currentTurns > lastTurns
}

/** How many already-stored adapter crashes (without an exhausted give-up) it
 *  takes to escalate to the brain. A single recovered hiccup is normal under
 *  "全自动"; a burst means the底座 is genuinely flaky and worth a look. */
const INSTABILITY_BURST = 3

/** Pure decision: is this batch of drained adapter-instability events worth
 *  waking the brain over? Yes if any retry was *exhausted* (a turn actually
 *  failed over), or if there's a burst of crashes even though retries recovered.
 *  Extracted so it can be unit-tested without the engine/model. */
export function shouldReportInstability(events: InstabilityEvent[]): boolean {
  if (events.length === 0) return false
  if (events.some((e) => e.exhausted)) return true
  return events.length >= INSTABILITY_BURST
}

/** Render drained instability events into a brain signal, grouped by team so the
 *  brain gets one block per affected conversation (with its ID for <<CONTINUE>>). */
function describeInstability(events: InstabilityEvent[]): string {
  const byConv = new Map<string, InstabilityEvent[]>()
  for (const e of events) {
    const arr = byConv.get(e.conversationId) ?? []
    arr.push(e)
    byConv.set(e.conversationId, arr)
  }
  const sections: string[] = []
  for (const [convId, evs] of byConv) {
    const conv = conversationRepo.get(convId)
    const project = conv ? projectRepo.get(conv.projectId) : null
    const name = project?.name ?? conv?.title ?? '未知项目'
    const status = conv?.status ?? '未知'
    const gaveUp = evs.some((e) => e.exhausted)
    const last = evs[evs.length - 1]
    sections.push(
      `# 团队「${name}」(会话ID ${convId}, 当前状态 ${status})\n  适配器崩溃 ${evs.length} 次${gaveUp ? '，自动重试已用尽、该回合失败' : '（已自动重试恢复）'}；最近一次：${last.detail}`
    )
  }
  return sections.join('\n\n')
}

/** Drain adapter-instability events and, if they cross the escalation bar, wake
 *  the brain with an 'instability' signal so it can nudge the team back on track
 *  or tell the user the底座 is shaky. Returns true if it spent a brain turn.
 *  Highest priority of the brain-spending passes — a crashing底座 trumps routine
 *  review or background reflection. */
async function maybeReportInstability(think: ThinkFn): Promise<boolean> {
  const events = conversationEngine.drainInstabilityEvents()
  if (!shouldReportInstability(events)) return false
  const intro =
    '注意：下面这些团队的底层适配器进程反复崩溃/断连（不是它们自己卡住，而是运行底座在抖）。请判断是暂时性抖动还是真崩了：能 <<CONTINUE>> 接回正轨就接，救不动就 <<REPORT>> 如实告诉用户哪个团队不稳。'
  try {
    await think({ kind: 'instability', text: `${intro}\n\n${describeInstability(events)}` })
  } catch (e) {
    console.error('[assistant-review] instability report failed:', (e as Error).message)
  }
  return true
}

/** Run the self-distillation pass at most once per REFLECT_INTERVAL_MS, and only
 *  when the brain has had new turns since the last reflection (otherwise there's
 *  nothing new to mine and we'd burn a model turn for nothing). Returns true if
 *  it reflected this pass, so the caller can skip the team review and not
 *  double-spend the brain in one tick. Assumes the quiet-window + brain-free
 *  gates already passed (it runs the model). */
async function maybeReflect(think: ThinkFn, turnCount: TurnCountFn): Promise<boolean> {
  const now = Date.now()
  const turns = turnCount()
  if (!shouldReflect(now, lastReflectedAt, lastReflectedTurns, turns, REFLECT_INTERVAL_MS)) {
    return false
  }
  lastReflectedAt = now
  lastReflectedTurns = turns
  try {
    // Show the brain what it already knows so it doesn't re-emit duplicates.
    let prompt = REFLECTION_PROMPT
    try {
      const known = getMemoryService().list({ limit: REFLECTION_DEDUP_CONTEXT })
      prompt = buildReflectionPrompt(known.map((m) => ({ kind: m.kind, content: m.content })))
    } catch (e) {
      console.error('[assistant-review] memory list for reflection failed:', (e as Error).message)
    }
    await think({ kind: 'reflection', text: prompt })
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
    // tick. Instability (a crashing底座) is the most urgent, then reflection has
    // its own (much longer) interval gate, so most ticks fall through to review.
    if (await maybeReportInstability(think)) return
    if (await maybeReflect(think, turnCount)) return
    const snapshot = gatherSnapshot()
    if (!snapshot) return
    // A stuck team (halted under autopilot) is a capability-gap the brain should
    // treat as "needs a decision now", not a routine progress check — classify
    // the signal so the prompt can bias toward CONTINUE / intervention.
    const intro = snapshot.stuck
      ? '注意：下面带 ⚠️ 的团队已经卡住、在等你决策（自动模式下停在 awaiting-user 通常意味着引擎遇到协议违例/崩溃/受阻而非正常完成）。请优先处理它们。'
      : '以下是你派出的团队的最新进展，请验收并决定下一步：'
    await think({
      kind: snapshot.stuck ? 'capability-gap' : 'review',
      text: `${intro}\n- 想推动某个**已存在**的团队继续干（补充要求、纠偏、回答它的问题），用 <<CONTINUE>>{"conversationId":"上面给的会话ID","message":"要对团队说的话"}<</CONTINUE>>。\n- 只有需要**全新**项目时才 <<DISPATCH>>。\n- 如果某个团队把一件不显然的活做成了（趟通了流程、找到了正确做法），把"怎么做成的"提炼成一条可复用技能：<<REMEMBER>>{"kind":"skill","content":"在什么情况下、按什么步骤、注意什么"}<</REMEMBER>>，让下次少走弯路。\n- 有值得告知用户的就 <<REPORT>>。\n\n${snapshot.text}`
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
