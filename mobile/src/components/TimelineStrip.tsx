// Horizontal A2A pipeline strip for the mobile chat header. Each card is
// one finalized/in-flight turn (architect or executor in 3-agent mode,
// user+architect+executor in 2-agent). Tap a card → scrolls the
// underlying FlatList to that message.
//
// Direct port of the desktop Timeline.tsx logic (buildSteps, summariseActivity)
// — kept in sync so the pad and desktop tell the same story.

import React, { useEffect, useMemo, useRef } from 'react'
import {
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet
} from 'react-native'
import type {
  ConversationView,
  Message,
  MessageBlock,
  Role
} from '../types'
import { colors, fontSizes, radius, spacing } from '../utils/theme'

type StepKind = 'user' | 'pm' | 'architect' | 'executor'
type StepStatus = 'running' | 'done' | 'failed' | 'cancelled'

interface Step {
  id: string
  kind: StepKind
  status: StepStatus
  title: string
  activity: string
  startedAt: number
}

interface Props {
  view: ConversationView
  /** When true, hide PM and user cards (3-agent mode — team strip only). */
  threeAgent: boolean
  onStepPress?: (messageId: string) => void
}

export function TimelineStrip({
  view,
  threeAgent,
  onStepPress
}: Props): React.ReactElement | null {
  const steps = useMemo(() => {
    const all = buildSteps(view)
    if (threeAgent) return all.filter((s) => s.kind === 'architect' || s.kind === 'executor')
    return all
  }, [view, threeAgent])

  const trackRef = useRef<ScrollView | null>(null)

  // Auto-scroll to end whenever new steps appear, so the latest turn is
  // always visible (matches desktop behaviour).
  useEffect(() => {
    const t = setTimeout(() => {
      trackRef.current?.scrollToEnd({ animated: true })
    }, 80)
    return () => clearTimeout(t)
  }, [steps.length, steps[steps.length - 1]?.status])

  // Empty state — show a "工作组待命" placeholder rather than collapsing the
  // whole strip; otherwise the chat header looks broken when a fresh conv
  // has no team activity yet.
  if (steps.length === 0) {
    return (
      <View style={styles.wrap}>
        <View style={styles.track}>
          <Text style={styles.emptyText}>
            {threeAgent
              ? '工作组待命中 · 等 PM 派单'
              : '暂无进度'}
          </Text>
        </View>
      </View>
    )
  }

  return (
    <View style={styles.wrap}>
      <ScrollView
        ref={trackRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.track}
      >
        {steps.map((s, i) => (
          <React.Fragment key={s.id}>
            <StepCard step={s} onPress={() => onStepPress?.(s.id)} />
            {i < steps.length - 1 ? (
              <StepArrow
                active={
                  s.status === 'done' && steps[i + 1].status === 'running'
                }
              />
            ) : null}
          </React.Fragment>
        ))}
      </ScrollView>
    </View>
  )
}

function StepCard({
  step,
  onPress
}: {
  step: Step
  onPress: () => void
}): React.ReactElement {
  const tint = KIND_TINT[step.kind]
  return (
    <TouchableOpacity
      style={[
        styles.card,
        { borderColor: status_border(step.status) }
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[styles.cardStrip, { backgroundColor: tint }]} />
      <View style={styles.cardHead}>
        <View style={[styles.cardDot, { backgroundColor: tint }]} />
        <Text style={styles.cardTitle}>{step.title}</Text>
        <Text style={[styles.cardStatus, statusColor(step.status)]}>
          {statusGlyph(step.status)}
        </Text>
      </View>
      <Text style={styles.cardActivity} numberOfLines={2}>
        {step.activity}
      </Text>
    </TouchableOpacity>
  )
}

function StepArrow({ active }: { active: boolean }): React.ReactElement {
  return (
    <View style={styles.arrowWrap}>
      <Text style={[styles.arrowText, active && { color: colors.accent }]}>→</Text>
    </View>
  )
}

// --- Step extraction (mirrors desktop's buildSteps) -----------------------

function buildSteps(conv: ConversationView): Step[] {
  const out: Step[] = []
  for (let i = 0; i < conv.messages.length; i++) {
    const m = conv.messages[i]
    if (m.role === 'system') continue
    // Skip routing-plumbing user messages.
    if (m.role === 'user' && m.forwardedFromMessageId) continue

    if (m.role === 'user') {
      const text =
        textOf(m).split(/\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? ''
      out.push({
        id: m.id,
        kind: 'user',
        status: 'done',
        title: '用户',
        activity: text.length > 30 ? text.slice(0, 30) + '…' : text || '空消息',
        startedAt: m.ts
      })
      continue
    }

    const status: StepStatus = !m.stopReason
      ? 'running'
      : m.stopReason === 'end_turn'
        ? 'done'
        : m.stopReason === 'cancelled'
          ? 'cancelled'
          : 'failed'

    const kind: StepKind =
      m.side === 'pm' ? 'pm'
      : m.side === 'architect' ? 'architect'
      : 'executor'

    out.push({
      id: m.id,
      kind,
      status,
      title: kind === 'pm' ? 'PM' : kind === 'architect' ? '架构师' : '执行者',
      activity: summariseActivity(m, status),
      startedAt: m.ts
    })
  }
  return out
}

function textOf(m: Message): string {
  return m.blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

function summariseActivity(m: Message, status: StepStatus): string {
  const blocks = m.blocks
  if (status === 'running') {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b.type === 'tool_call') {
        const verb =
          b.status === 'pending' ? '准备调用' :
          b.status === 'in_progress' ? '执行' :
          b.status === 'failed' ? '失败' : '完成'
        return `${verb}: ${b.title}`
      }
      if (b.type === 'plan') return `更新计划 (${b.entries.length})`
      if (b.type === 'permission_request') return '等待权限'
      if (b.type === 'thought') return '思考中…'
    }
    return '准备中…'
  }
  const text = textOf(m)
  if (/<<DONE>>/i.test(text)) return '宣告完成'
  if (/<<HANDOFF>>/i.test(text)) return '派给团队'
  if (/<<DELEGATE>>/i.test(text)) return '派给执行者'
  if (/<<REPORT>>/i.test(text)) return '汇报完成'
  if (/<<PLAN>>/i.test(text)) return '更新计划'
  if (/<<FAIL>>/i.test(text)) return '失败'
  const toolCount = blocks.filter((b) => b.type === 'tool_call').length
  if (toolCount > 0) return `${toolCount} 次工具`
  if (status === 'cancelled') return '已打断'
  if (status === 'failed') return '失败'
  return '回复'
}

// --- Visual constants -----------------------------------------------------

const KIND_TINT: Record<StepKind, string> = {
  user: colors.accentHermes,
  pm: colors.pm,
  architect: colors.architect,
  executor: colors.executor
}

function statusGlyph(s: StepStatus): string {
  switch (s) {
    case 'running':
      return '●'
    case 'done':
      return '✓'
    case 'failed':
      return '✕'
    case 'cancelled':
      return '⊘'
  }
}
function statusColor(s: StepStatus): { color: string } {
  switch (s) {
    case 'running':
      return { color: colors.warn }
    case 'done':
      return { color: colors.success }
    case 'failed':
      return { color: colors.danger }
    case 'cancelled':
      return { color: colors.textFaint }
  }
}
function status_border(s: StepStatus): string {
  switch (s) {
    case 'running':
      return colors.warn
    case 'failed':
      return 'rgba(255, 107, 107, 0.45)'
    case 'cancelled':
      return 'rgba(244, 176, 99, 0.45)'
    default:
      return colors.borderSoft
  }
}

const styles = StyleSheet.create({
  wrap: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
    backgroundColor: colors.bg
  },
  track: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    alignItems: 'center',
    gap: 0
  },
  emptyText: {
    color: colors.textFaint,
    fontSize: 10,
    paddingVertical: spacing.sm
  },
  card: {
    width: 140,
    height: 64,
    borderRadius: 7,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 5,
    overflow: 'hidden',
    justifyContent: 'space-between'
  },
  cardStrip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  cardDot: { width: 5, height: 5, borderRadius: 3 },
  cardTitle: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '600',
    flex: 1,
    letterSpacing: 0.2
  },
  cardStatus: { fontSize: 10, marginLeft: 'auto' },
  cardActivity: {
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 13
  },
  arrowWrap: {
    width: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  arrowText: { color: colors.textFaint, fontSize: 12 }
})
