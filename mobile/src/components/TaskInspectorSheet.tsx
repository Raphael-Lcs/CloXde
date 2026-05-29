// Bottom-sheet modal showing the full active task: brief, plan (as a
// checklist), executor's latest report, failure reason, owner. Mobile
// equivalent of the desktop TaskInspector popover — opens when the user
// taps the in-chat task badge.

import React from 'react'
import {
  Modal,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { Task, TaskStatus, Role } from '../types'
import { colors, fontSizes, radius, spacing } from '../utils/theme'

interface Props {
  task: Task | null
  open: boolean
  onClose: () => void
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  briefing: 'PM 收集需求',
  planning: '架构师分析',
  executing: '执行者动手',
  review: '架构师审查',
  done: '已完成',
  failed: '失败'
}

const OWNER_LABELS: Record<Role, string> = {
  pm: '产品经理',
  architect: '架构师',
  executor: '执行者'
}

const OWNER_TINT: Record<Role, string> = {
  pm: colors.pm,
  architect: colors.architect,
  executor: colors.executor
}

export function TaskInspectorSheet({ task, open, onClose }: Props): React.ReactElement | null {
  if (!task) return null
  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback onPress={() => undefined}>
            <SafeAreaView edges={['bottom']} style={styles.sheet}>
              <View style={styles.handle} />
              <View style={styles.head}>
                <View style={[styles.dot, { backgroundColor: OWNER_TINT[task.owner] }]} />
                <Text style={styles.title}>{STATUS_LABELS[task.status]}</Text>
                <Text style={styles.id}>#{task.id.slice(0, 8)}</Text>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Text style={styles.closeText}>×</Text>
                </TouchableOpacity>
              </View>

              <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
                <Section title="负责人">
                  <View style={[styles.ownerTag, { borderColor: OWNER_TINT[task.owner] }]}>
                    <Text style={[styles.ownerTagText, { color: OWNER_TINT[task.owner] }]}>
                      {OWNER_LABELS[task.owner]}
                    </Text>
                  </View>
                </Section>

                <Section title="Brief">
                  {task.brief.trim() ? (
                    <Text style={styles.briefText}>{task.brief}</Text>
                  ) : (
                    <Text style={styles.muted}>（未设置）</Text>
                  )}
                </Section>

                {task.plan && task.plan.length > 0 && (
                  <Section title={`计划（${task.plan.length} 条）`}>
                    {task.plan.map((step, i) => (
                      <View key={i} style={styles.planRow}>
                        <Text style={[styles.planMark, statusColor(step.status)]}>
                          {markForPlanStatus(step.status)}
                        </Text>
                        <Text
                          style={[
                            styles.planText,
                            step.status === 'completed' && styles.planTextDone,
                            step.status === 'skipped' && styles.planTextSkipped
                          ]}
                        >
                          {step.description}
                        </Text>
                      </View>
                    ))}
                  </Section>
                )}

                {task.result ? (
                  <Section title="执行者最新报告">
                    <View style={styles.resultBox}>
                      <Text style={styles.resultText}>{task.result}</Text>
                    </View>
                  </Section>
                ) : null}

                {task.failureReason ? (
                  <Section title="失败原因" tone="danger">
                    <Text style={[styles.briefText, { color: colors.danger }]}>
                      {task.failureReason}
                    </Text>
                  </Section>
                ) : null}

                <Section title="时间">
                  <Text style={styles.metaText}>
                    创建：{fmt(task.createdAt)} · 更新：{fmt(task.updatedAt)}
                  </Text>
                </Section>
              </ScrollView>
            </SafeAreaView>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  )
}

function Section({
  title,
  tone,
  children
}: {
  title: string
  tone?: 'danger'
  children: React.ReactNode
}): React.ReactElement {
  return (
    <View style={styles.section}>
      <Text
        style={[
          styles.sectionTitle,
          tone === 'danger' && { color: colors.danger }
        ]}
      >
        {title}
      </Text>
      <View>{children}</View>
    </View>
  )
}

function markForPlanStatus(s: string): string {
  switch (s) {
    case 'completed':
      return '✓'
    case 'in_progress':
      return '▶'
    case 'skipped':
      return '−'
    case 'pending':
    default:
      return '○'
  }
}
function statusColor(s: string): { color: string } {
  switch (s) {
    case 'completed':
      return { color: colors.success }
    case 'in_progress':
      return { color: colors.accent }
    case 'skipped':
      return { color: colors.textFaint }
    default:
      return { color: colors.textMuted }
  }
}

function fmt(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end'
  },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: '85%'
  },
  handle: {
    width: 44,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xs
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  title: { color: colors.text, fontSize: fontSizes.md, fontWeight: '600' },
  id: {
    marginLeft: 'auto',
    color: colors.textFaint,
    fontSize: fontSizes.xs,
    fontFamily: 'monospace'
  },
  closeBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md
  },
  closeText: { color: colors.textMuted, fontSize: 26, lineHeight: 28 },
  body: { flexShrink: 1 },
  bodyContent: { padding: spacing.lg, gap: spacing.lg },
  section: { gap: spacing.sm },
  sectionTitle: {
    color: colors.textFaint,
    fontSize: fontSizes.xs,
    textTransform: 'uppercase',
    letterSpacing: 1
  },
  ownerTag: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderWidth: 1,
    borderRadius: 999,
    backgroundColor: colors.bg
  },
  ownerTagText: { fontSize: fontSizes.sm, fontWeight: '600' },
  briefText: {
    color: colors.text,
    fontSize: fontSizes.md,
    lineHeight: 22
  },
  muted: { color: colors.textFaint, fontSize: fontSizes.sm, fontStyle: 'italic' },
  planRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.sm,
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    marginBottom: spacing.xs
  },
  planMark: {
    width: 16,
    textAlign: 'center',
    fontFamily: 'monospace',
    fontSize: fontSizes.md
  },
  planText: { flex: 1, color: colors.text, fontSize: fontSizes.sm, lineHeight: 20 },
  planTextDone: { color: colors.textMuted },
  planTextSkipped: {
    color: colors.textFaint,
    textDecorationLine: 'line-through'
  },
  resultBox: {
    backgroundColor: colors.bg,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md
  },
  resultText: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    lineHeight: 20
  },
  metaText: { color: colors.textFaint, fontSize: fontSizes.xs }
})
