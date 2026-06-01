// Path-C task state machine — pure transition functions.
//
// The engine consults this module to decide:
//   • which role should be the OWNER of the next turn
//   • which TAGS that role is allowed to produce
//   • which ACP tools that role can call (read-only vs. full)
//
// Keeping it pure (no DB, no engine state) means we can unit-test the
// transition table in isolation and reason about the harness behavior
// without simulating an entire ACP conversation.

import type { Role, Task, TaskStatus } from '@shared/types'

/** Tags an agent may produce in its end-of-turn output. CloXde extracts
 *  them and drives the next transition. */
export type TaskAction =
  | 'PLAN'      // architect emits a plan (still in 'planning')
  | 'DELEGATE' // architect hands off to executor → 'executing'
  | 'REPORT'   // executor finishes a sub-step → 'review'
  | 'DONE'     // architect declares the task complete → 'done'
  | 'FAIL'     // anyone gives up → 'failed'
  | 'HANDOFF'  // PM kicks a new task → starts 'planning'

/** Tool category buckets we care about for gating. We don't enumerate
 *  every Claude/Codex tool — just split into "read-ish" (safe to inspect)
 *  and "write-ish" (mutates the world). */
export type ToolCategory = 'read' | 'write' | 'execute' | 'other'

/** Heuristic classification of an ACP tool kind string. Claude / Codex
 *  use slightly different naming conventions, so we match by substring. */
export function classifyTool(kind: string | undefined): ToolCategory {
  const k = (kind ?? '').toLowerCase()
  if (
    k === 'read' ||
    k === 'search' ||
    k === 'fetch' ||
    k === 'think' ||
    k.includes('grep') ||
    k.includes('glob') ||
    k.includes('list')
  ) {
    return 'read'
  }
  if (k === 'edit' || k.includes('write') || k.includes('patch') || k.includes('apply')) {
    return 'write'
  }
  if (k === 'execute' || k.includes('shell') || k.includes('bash') || k.includes('terminal')) {
    return 'execute'
  }
  return 'other'
}

/** Whether `role` is allowed to call a tool of `category` while the task
 *  is in `status`. The engine's PermissionPolicy consults this to decide
 *  whether to allow / deny a tool call request. */
export function isToolAllowed(
  status: TaskStatus,
  role: Role,
  category: ToolCategory
): boolean {
  // PM 可以只读调研（Read/Grep/Glob 等），但不碰写/执行——保持「不动手改仓库」
  // 这条边界。给 PM 只读能力是为了让「查一下某段代码」这类快反应问题就地解决，
  // 不必为了纯调研也走完整 architect→executor 长链。
  if (role === 'pm') return category === 'read' || category === 'other'

  switch (status) {
    case 'briefing':
      // Team is asleep — both architect and executor should not act.
      return false
    case 'planning':
      // Architect analyzes only. Executor must wait for DELEGATE.
      if (role === 'architect') return category === 'read' || category === 'other'
      return false
    case 'executing':
      // Executor has full tool access; architect waits.
      if (role === 'executor') return true
      return false
    case 'review':
      // Architect reviews — read-only again. Executor waits.
      if (role === 'architect') return category === 'read' || category === 'other'
      return false
    case 'done':
    case 'failed':
      // Task closed; nobody should be acting.
      return false
  }
}

/** Tags the current owner is allowed to emit in this status. Anything else
 *  in the agent's output is ignored by the state-machine driver. */
export function allowedTags(status: TaskStatus, role: Role): TaskAction[] {
  if (role === 'pm') {
    // PM can always start a new task. (Free-form chat needs no tag.)
    return ['HANDOFF', 'FAIL']
  }
  switch (status) {
    case 'briefing':
      return []
    case 'planning':
      return role === 'architect' ? ['PLAN', 'DELEGATE', 'FAIL'] : []
    case 'executing':
      return role === 'executor' ? ['REPORT', 'FAIL'] : []
    case 'review':
      return role === 'architect' ? ['DELEGATE', 'DONE', 'FAIL'] : []
    case 'done':
    case 'failed':
      return []
  }
}

/** Human-readable description of the forbidden side of the contract.
 *  Used in deny reasons returned to the agent so it learns what to do. */
export function describeForbidden(status: TaskStatus, role: Role): string {
  if (role === 'pm') return '产品经理可以只读调研（Read/Grep/Glob），但不写文件、不跑命令。要落地改动请发 <<HANDOFF>> 交给工程团队。'
  switch (status) {
    case 'briefing':
      return '当前阶段是 briefing（PM 还在跟用户对齐需求），团队尚未被唤起。'
    case 'planning':
      if (role === 'architect') {
        return '当前阶段是 planning，架构师只能 Read/Grep 等只读操作。要落地请发 <<DELEGATE>>。'
      }
      return '当前阶段是 planning，执行者还没被派单。等架构师 <<DELEGATE>>。'
    case 'executing':
      if (role === 'architect') return '当前阶段是 executing，执行者在干活，请等 <<REPORT>>。'
      return '执行者全权，理论上不会被拦截。如果看到这条，请汇报为 bug。'
    case 'review':
      if (role === 'architect') return '当前阶段是 review，请审查执行者的报告，发 <<DELEGATE>> 继续或 <<DONE>> 收工。'
      return '当前阶段是 review，等架构师判定。'
    case 'done':
      return '任务已 done，等 PM 跟用户收尾。'
    case 'failed':
      return '任务已 failed，等 PM 跟用户解释。'
  }
}

// --- Transition rules ------------------------------------------------------

// Loop limits to prevent infinite cycles. When exceeded, the transition
// returns a special warning that the engine can surface to the agent.
const MAX_PLAN_ITERATIONS = 3
const MAX_REVIEW_CYCLES = 5

interface Transition {
  nextStatus: TaskStatus
  nextOwner: Role
  warning?: string
  incrementPlanIterations?: boolean
  incrementReviewCycles?: boolean
  resetPlanIterations?: boolean
  resetReviewCycles?: boolean
}

/** Pure transition — given a task's current state and an action, produces
 *  the next state. Returns null when the action isn't valid in the
 *  current (status, owner) — caller should treat as "agent went off-script". */
export function transition(task: Task, action: TaskAction): Transition | null {
  // FAIL is universal — anyone can bail out.
  if (action === 'FAIL') {
    return { nextStatus: 'failed', nextOwner: 'pm' }
  }
  // HANDOFF is the PM's way of (re)starting work — universal, like FAIL.
  // The user can pivot at any point, including after a task reached done or
  // failed, so PM must be able to reseat the architect with a fresh brief
  // from any state. The engine cancels in-flight team work before honoring
  // the handoff (see engine.ts).
  if (action === 'HANDOFF') {
    return { nextStatus: 'planning', nextOwner: 'architect' }
  }

  switch (task.status) {
    case 'briefing':
      // Out of briefing only via HANDOFF (handled above).
      return null
    case 'planning':
      if (task.owner !== 'architect') return null
      if (action === 'PLAN') {
        const nextIterations = task.planIterations + 1
        if (nextIterations > MAX_PLAN_ITERATIONS) {
          return {
            nextStatus: 'planning',
            nextOwner: 'architect',
            incrementPlanIterations: true,
            warning: `已连续 ${nextIterations} 轮 PLAN，可能陷入规划死循环。请发 <<DELEGATE>> 开始执行，或 <<FAIL>> 放弃。`
          }
        }
        return {
          nextStatus: 'planning',
          nextOwner: 'architect',
          incrementPlanIterations: true
        }
      }
      if (action === 'DELEGATE') {
        return {
          nextStatus: 'executing',
          nextOwner: 'executor',
          resetPlanIterations: true
        }
      }
      return null
    case 'executing':
      if (task.owner !== 'executor') return null
      if (action === 'REPORT') {
        return {
          nextStatus: 'review',
          nextOwner: 'architect',
          incrementReviewCycles: true
        }
      }
      return null
    case 'review':
      if (task.owner !== 'architect') return null
      if (action === 'DELEGATE') {
        const nextCycles = task.reviewCycles + 1
        if (nextCycles > MAX_REVIEW_CYCLES) {
          return {
            nextStatus: 'review',
            nextOwner: 'architect',
            warning: `已完成 ${nextCycles} 轮 review→executing 循环，可能陷入无限迭代。请发 <<DONE>> 收工，或 <<FAIL>> 放弃。`
          }
        }
        return {
          nextStatus: 'executing',
          nextOwner: 'executor'
        }
      }
      if (action === 'DONE') {
        return {
          nextStatus: 'done',
          nextOwner: 'pm',
          resetReviewCycles: true
        }
      }
      return null
    case 'done':
    case 'failed':
      return null
  }
}

// --- Tag parser ------------------------------------------------------------

// 闭合标签是可选的：实测 LLM 常常只发开标签 `<<DELEGATE>>` 就接正文，忘了补
// `<</DELEGATE>>`。早期严格要求闭合会让整条动作匹配失败，于是架构师明明派活了，
// 引擎却当成「没发标签」连续两轮空转后暂停（用户报告的 bug）。
// 因此正文取到下一个标签（开或闭）之前、或文本结尾为止。闭合标签存在时因惰性量词
// 优先匹配，正文边界仍然精确。
function tagPattern(tag: string): RegExp {
  return new RegExp(`<<${tag}>>([\\s\\S]*?)(?:<<\\/${tag}>>|(?=<<\\/?[A-Za-z])|$)`, 'i')
}

const TAG_PATTERNS: Record<TaskAction, RegExp> = {
  PLAN: tagPattern('PLAN'),
  DELEGATE: tagPattern('DELEGATE'),
  REPORT: tagPattern('REPORT'),
  DONE: tagPattern('DONE'),
  FAIL: tagPattern('FAIL'),
  HANDOFF: tagPattern('HANDOFF')
}

export interface ExtractedAction {
  action: TaskAction
  body: string
}

/** Find the LAST allowed action-tag in `text`. "Last" matters because
 *  agents sometimes describe what they're about to do (using the tag name
 *  in prose) before actually emitting it. */
export function extractAction(
  text: string,
  allowed: TaskAction[]
): ExtractedAction | null {
  let best: { action: TaskAction; body: string; index: number } | null = null
  for (const a of allowed) {
    const m = TAG_PATTERNS[a].exec(text)
    if (!m) continue
    if (best === null || m.index > best.index) {
      best = { action: a, body: (m[1] ?? '').trim(), index: m.index }
    }
  }
  return best ? { action: best.action, body: best.body } : null
}

/**
 * Parse a `<<PLAN>>` body into a list of structured steps. We accept any of
 *   `- foo`, `* foo`, `• foo`, `1. foo`, `1) foo`
 * as a bullet line; everything else (free-form text between bullets) becomes
 * the *previous* step's continuation. If no bullets are detected at all, the
 * whole body is returned as a single step.
 *
 * All steps start `pending`. We don't try to infer completion from the body;
 * the architect can update via another <<PLAN>>.
 */
export function parsePlanSteps(body: string): { description: string; status: 'pending' }[] {
  const lines = body.split(/\r?\n/)
  const bullets: string[] = []
  const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/
  let current: string | null = null
  for (const raw of lines) {
    const m = BULLET_RE.exec(raw)
    if (m) {
      if (current !== null) bullets.push(current.trim())
      current = m[1]
    } else if (current !== null && raw.trim()) {
      // Continuation of the previous bullet (wrap or sub-line).
      current += ' ' + raw.trim()
    }
    // Lines before the first bullet are dropped — they're usually just a
    // "Here's the plan:" preamble.
  }
  if (current !== null) bullets.push(current.trim())
  if (bullets.length === 0) {
    const flat = body.trim()
    if (!flat) return []
    return [{ description: flat, status: 'pending' }]
  }
  return bullets.filter((b) => b.length > 0).map((b) => ({ description: b, status: 'pending' }))
}

/** Format the task-state preamble we prepend to every turn's user-side
 *  payload so the agent knows where it is and what it can do. */
export function formatTaskPreamble(task: Task, role: Role): string {
  const allowed = allowedTags(task.status, role)
  const forbidden = describeForbidden(task.status, role)
  return [
    '[CLOXDE-TASK]',
    `id: ${task.id}`,
    `status: ${task.status}`,
    `你的角色: ${role}`,
    `允许的输出动作: ${allowed.length ? allowed.map((t) => `<<${t}>>`).join(', ') : '（无 — 这是兜底注入，正常你不应被唤起）'}`,
    `禁止: ${forbidden}`,
    '',
    '[brief]',
    task.brief || '（未设置）'
  ].join('\n')
}
