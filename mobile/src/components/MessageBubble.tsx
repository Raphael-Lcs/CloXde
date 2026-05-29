// Message renderer — mirrors desktop's ConversationStream:
//
//   • User                 → right-aligned PILL (small bubble for incoming)
//   • Assistant (pm/arch/exec) → AssistantFlow:
//       meta row [side dot · author · badges · caret]
//       expandable body (blocks rendered with a soft left tint, NO bubble)
//   • System               → ambient single-line note (icon + text, dim)
//   • Forwarded user (routing) → compact "↳ A → B 指令" collapsed marker
//
// Default expand policy matches desktop:
//   - PM "awaiting" (PM speaking to user, no HANDOFF) → auto-expanded
//   - Everything else → collapsed; tap meta row to expand

import React, { memo, useMemo, useState } from 'react'
import { View, Text, StyleSheet, Image, TouchableOpacity } from 'react-native'
import Markdown from 'react-native-markdown-display'
import type { Message, MessageBlock, MessageSide } from '../types'
import { colors, fontSizes, radius, spacing } from '../utils/theme'

interface Props {
  message: Message
}

function MessageBubbleInner({ message }: Props): React.ReactElement | null {
  // System messages — ambient single-line, never a bubble.
  if (message.role === 'system') {
    return <SystemNote message={message} />
  }

  // User messages — keep the pill on the right. Forwarded (routing) ones
  // collapse into a compact marker like desktop.
  if (message.role === 'user') {
    if (message.forwardedFromMessageId) {
      return <RoutingMarker message={message} />
    }
    return <UserPill message={message} />
  }

  // Assistant — flow layout (no bubble), expandable meta row + body.
  return <AssistantFlow message={message} />
}

// --- User pill --------------------------------------------------------------

function UserPill({ message }: { message: Message }): React.ReactElement {
  const text = textOf(message)
  const images = message.blocks.filter(
    (b): b is Extract<MessageBlock, { type: 'image' }> => b.type === 'image'
  )
  return (
    <View style={[styles.row, styles.rowRight]}>
      <View style={styles.userPill}>
        {text ? <Markdown style={mdStyles}>{text}</Markdown> : null}
        {images.length > 0 ? (
          <View style={styles.imageRow}>
            {images.map((b, i) => (
              <Image
                key={i}
                source={{ uri: `data:${b.mimeType};base64,${b.data}` }}
                style={styles.image}
                resizeMode="cover"
              />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  )
}

// --- Routing marker (forwarded user msgs between sides) ---------------------

function RoutingMarker({ message }: { message: Message }): React.ReactElement {
  const receiver = message.side === 'architect' ? 'architect' : 'executor'
  const sender = receiver === 'architect' ? 'executor' : 'architect'
  const sLabel = sender === 'architect' ? '架构师' : '执行者'
  const rLabel = receiver === 'architect' ? '架构师' : '执行者'
  const kind = receiver === 'executor' ? '指令' : '回报'
  const [open, setOpen] = useState(false)

  return (
    <View style={[styles.row, styles.rowLeft]}>
      <View style={[styles.routing, open && styles.routingOpen]}>
        <TouchableOpacity
          style={styles.routingHead}
          onPress={() => setOpen((v) => !v)}
          activeOpacity={0.7}
        >
          <Text style={styles.routingArrow}>↳</Text>
          <Text style={[styles.routingSide, { color: sideTint(sender) }]}>{sLabel}</Text>
          <Text style={styles.routingTo}>→</Text>
          <Text style={[styles.routingSide, { color: sideTint(receiver) }]}>{rLabel}</Text>
          <Text style={styles.routingKind}>{kind}</Text>
          <Text style={styles.routingCaret}>{open ? '▾' : '▸'}</Text>
        </TouchableOpacity>
        {open ? (
          <View style={styles.routingBody}>
            {message.blocks.map((b, i) => (
              <BlockView key={i} block={b} />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  )
}

// --- Assistant flow ---------------------------------------------------------

type UserFacingMode = 'awaiting' | 'dispatched' | 'done' | null
function userFacingMode(m: Message): UserFacingMode {
  if (m.role !== 'assistant') return null
  if (m.stopReason !== 'end_turn') return null
  const text = textOf(m)
  if (m.side === 'pm') {
    // PM speaks to the user. Whether it dispatched or not, its prose is a
    // 小结 to read — only the badge differs.
    if (/<<HANDOFF>>/i.test(text)) return 'dispatched'
    return 'awaiting'
  }
  if (m.side === 'architect') {
    if (/<<DONE>>/i.test(text)) return 'done'
    if (/<<DELEGATE>>/i.test(text)) return null
    return 'awaiting'
  }
  return null
}

// Internal CloXde协议 tags — plumbing, not prose. Strip from PM text so the
// user reads a clean 小结 instead of `<<HANDOFF>>…` markers.
const PROTOCOL_TAG_RE =
  /<<(HANDOFF|DELEGATE|REPORT|PLAN|FAIL)>>[\s\S]*?<<\/\1>>|<<DONE>>/gi
function stripProtocolTags(text: string): string {
  return text.replace(PROTOCOL_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

function AssistantFlow({ message }: { message: Message }): React.ReactElement {
  const side =
    message.side === 'pm' ? 'pm'
    : message.side === 'architect' ? 'architect'
    : 'executor'
  const streaming = !message.stopReason
  const mode = userFacingMode(message)
  // Any user-facing PM message auto-expands; everything else default-collapsed.
  const userFacing = mode === 'awaiting' || mode === 'dispatched'
  const [expanded, setExpanded] = useState<boolean>(() => userFacing)
  // PM prose carries internal协议 tags — strip them from preview + body.
  const strip = side === 'pm'

  const author = side === 'pm' ? '产品经理' : side === 'architect' ? '架构师' : '执行者'
  const tint = sideTint(side)
  const status = statusLabel(message.stopReason)
  const preview = useMemo(() => previewOf(message.blocks, strip), [message.blocks, strip])
  const blockCount = message.blocks.length

  // When stripping a PM turn leaves no prose (it only emitted a HANDOFF
  // brief), show a friendly placeholder so the body isn't blank.
  const showDispatchNote =
    strip &&
    !message.blocks.some((b) => b.type === 'text' && stripProtocolTags(b.text).length > 0) &&
    !message.blocks.some((b) => b.type !== 'text' && b.type !== 'thought')

  return (
    <View style={[styles.row, styles.rowLeft]}>
      <View style={[styles.flow, { borderLeftColor: tint + '4D' }]}>
        {/* Meta row */}
        <TouchableOpacity
          style={styles.flowMeta}
          onPress={() => setExpanded((v) => !v)}
          activeOpacity={0.7}
        >
          <View style={[styles.sideDot, { backgroundColor: tint }]} />
          <Text style={[styles.author, { color: tint }]}>{author}</Text>
          {mode === 'awaiting' ? (
            <View style={[styles.modeBadge, styles.modeBadgeAwaiting]}>
              <Text style={styles.modeBadgeText}>等你回复</Text>
            </View>
          ) : null}
          {mode === 'dispatched' ? (
            <View style={[styles.modeBadge, styles.modeBadgeDispatched]}>
              <Text style={styles.modeBadgeTextDispatched}>已派给团队 →</Text>
            </View>
          ) : null}
          {mode === 'done' ? (
            <View style={[styles.modeBadge, styles.modeBadgeDone]}>
              <Text style={styles.modeBadgeTextDone}>已完成 ✓</Text>
            </View>
          ) : null}
          {streaming ? (
            <Text style={styles.metaStatusStreaming}>· 思考中</Text>
          ) : !mode && status ? (
            <Text style={styles.metaStatus}>· {status}</Text>
          ) : null}
          {!expanded ? (
            <Text style={styles.metaPreview} numberOfLines={1}>
              {preview}
              {blockCount > 1 ? ` · ${blockCount} 块` : ''}
            </Text>
          ) : null}
          <Text style={styles.metaCaret}>{expanded ? '▾' : '▸'}</Text>
        </TouchableOpacity>

        {/* Body */}
        {expanded ? (
          <View style={styles.flowBody}>
            {message.blocks.length === 0 && streaming ? (
              <Text style={styles.typingDots}>···</Text>
            ) : null}
            {message.blocks.map((b, i) => (
              <BlockView key={i} block={b} strip={strip} />
            ))}
            {showDispatchNote ? (
              <Text style={styles.dispatchNote}>
                已把任务交给团队，进度见「工作组」。
              </Text>
            ) : null}
            {message.stopReason && message.stopReason !== 'end_turn' ? (
              <Text style={styles.stopReason}>停止原因: {message.stopReason}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  )
}

// --- System ambient note ----------------------------------------------------

function SystemNote({ message }: { message: Message }): React.ReactElement {
  const text = textOf(message).trim()
  const kind = classifySystem(text)
  return (
    <View style={[styles.row, styles.rowCenter]}>
      <View style={styles.sysNote}>
        <Text style={[styles.sysIcon, sysIconColor(kind)]}>
          {SYS_ICON[kind]}
        </Text>
        <Text style={styles.sysText} numberOfLines={3}>{text}</Text>
      </View>
    </View>
  )
}

type SysKind = 'done' | 'info' | 'warning' | 'error' | 'note'
const SYS_ICON: Record<SysKind, string> = {
  done: '✓', info: '↻', warning: '⚠', error: '✕', note: '·'
}
function classifySystem(t: string): SysKind {
  if (/<<DONE>>|任务完成|宣告.*完成|已完成/.test(t)) return 'done'
  if (/上下文.*恢复|context.*restored/i.test(t)) return 'info'
  if (/上限|暂停|cancelled|已取消|超时/.test(t)) return 'warning'
  if (/退出|失败|错误|error|exit code/i.test(t)) return 'error'
  return 'note'
}
function sysIconColor(k: SysKind): { color: string } {
  switch (k) {
    case 'done': return { color: colors.success }
    case 'info': return { color: colors.accent }
    case 'warning': return { color: colors.warn }
    case 'error': return { color: colors.danger }
    default: return { color: colors.textFaint }
  }
}

// --- Block renderers --------------------------------------------------------

function BlockView({ block, strip = false }: { block: MessageBlock; strip?: boolean }): React.ReactElement | null {
  switch (block.type) {
    case 'text': {
      const text = strip ? stripProtocolTags(block.text) : block.text
      if (!text.trim()) return null
      return (
        <View style={styles.blockText}>
          <Markdown style={mdStyles}>{text}</Markdown>
        </View>
      )
    }
    case 'thought':
      return <ThoughtBlock text={block.text} />
    case 'tool_call':
      return (
        <View style={styles.toolCall}>
          <View style={styles.toolHead}>
            <Text style={styles.toolKind}>{block.kind}</Text>
            <Text
              style={[
                styles.toolTitle,
                styles.toolTitleFlex
              ]}
              numberOfLines={2}
            >
              {block.title}
            </Text>
            <Text style={[styles.toolStatus, toolStatusColor(block.status)]}>
              {labelForToolStatus(block.status)}
            </Text>
          </View>
          {block.locations && block.locations.length > 0 ? (
            <Text style={styles.toolLocations} numberOfLines={2}>
              {block.locations.join(' · ')}
            </Text>
          ) : null}
          {block.output ? (
            <Text style={styles.toolOutput} numberOfLines={6}>{block.output}</Text>
          ) : null}
        </View>
      )
    case 'plan':
      return (
        <View style={styles.plan}>
          <Text style={styles.planHeading}>执行计划</Text>
          {block.entries.map((entry, idx) => (
            <View key={idx} style={styles.planRow}>
              <Text style={styles.planMark}>{markForPlanStatus(entry.status)}</Text>
              <Text style={styles.planText}>
                {entry.content}{' '}
                <Text style={styles.planMeta}>· {entry.priority}</Text>
              </Text>
            </View>
          ))}
        </View>
      )
    case 'permission_request':
      return (
        <View style={styles.perm}>
          <Text style={styles.permTitle}>需要权限：{block.title}</Text>
          {block.chosenOptionId ? (
            <Text style={styles.permResolved}>
              已选择：{block.options.find((o) => o.id === block.chosenOptionId)?.label}
            </Text>
          ) : (
            <Text style={styles.permPending}>请到桌面端 CloXde 处理。</Text>
          )}
        </View>
      )
    case 'image':
      return (
        <Image
          source={{ uri: `data:${block.mimeType};base64,${block.data}` }}
          style={styles.imageStandalone}
          resizeMode="contain"
        />
      )
    default:
      return null
  }
}

function ThoughtBlock({ text }: { text: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <View style={styles.thought}>
      <TouchableOpacity onPress={() => setOpen((v) => !v)} activeOpacity={0.7}>
        <Text style={styles.thoughtLabel}>
          思考过程 {open ? '▾' : '▸'}
        </Text>
      </TouchableOpacity>
      {open ? <Text style={styles.thoughtText}>{text}</Text> : null}
    </View>
  )
}

// --- Helpers ----------------------------------------------------------------

function textOf(m: Message): string {
  return m.blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

function previewOf(blocks: MessageBlock[], strip = false): string {
  for (const b of blocks) {
    if (b.type === 'text') {
      const source = strip ? stripProtocolTags(b.text) : b.text
      const t = source.split(/\n/).map((s) => s.trim()).find((s) => s.length > 0)
      if (t) return t.length > 80 ? t.slice(0, 80) + '…' : t
    } else if (b.type === 'tool_call') {
      return `工具：${b.title}`
    } else if (b.type === 'plan') {
      return `计划（${b.entries.length} 条）`
    } else if (b.type === 'thought') {
      return '思考过程…'
    }
  }
  return strip ? '已把任务交给团队' : '（无内容）'
}

function statusLabel(stopReason: Message['stopReason']): string | null {
  if (!stopReason) return null
  switch (stopReason) {
    case 'end_turn': return null
    case 'cancelled': return '已打断'
    case 'max_tokens': return 'token 上限'
    case 'refusal': return '拒绝'
    case 'max_turn_requests': return '轮次上限'
    default: return stopReason
  }
}

function sideTint(side: MessageSide | 'pm' | 'architect' | 'executor'): string {
  if (side === 'pm') return colors.pm
  if (side === 'architect') return colors.architect
  if (side === 'executor') return colors.executor
  if (side === 'user') return colors.accent
  return colors.textFaint
}

function labelForToolStatus(s: string): string {
  switch (s) {
    case 'pending': return '待执行'
    case 'in_progress': return '执行中'
    case 'completed': return '完成'
    case 'failed': return '失败'
    default: return s
  }
}
function toolStatusColor(s: string): { color: string } {
  switch (s) {
    case 'completed': return { color: colors.success }
    case 'failed': return { color: colors.danger }
    case 'in_progress': return { color: colors.warn }
    default: return { color: colors.textMuted }
  }
}
function markForPlanStatus(s: string): string {
  switch (s) {
    case 'completed': return '✓'
    case 'in_progress': return '▶'
    case 'skipped': return '−'
    case 'pending':
    default: return '○'
  }
}

// --- Styles -----------------------------------------------------------------

const styles = StyleSheet.create({
  row: { paddingHorizontal: spacing.md, paddingVertical: 6, flexDirection: 'row' },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  rowCenter: { justifyContent: 'center' },

  // User pill — small bubble, right-aligned.
  userPill: {
    maxWidth: '80%',
    backgroundColor: 'rgba(122, 162, 255, 0.13)',
    borderWidth: 1,
    borderColor: 'rgba(122, 162, 255, 0.30)',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 8
  },
  imageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  image: { width: 180, height: 180, borderRadius: 6 },

  // Assistant flow — NO outer bubble, just a left tint stripe.
  flow: {
    width: '100%',
    paddingLeft: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent'
  },
  flowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2
  },
  sideDot: { width: 6, height: 6, borderRadius: 3 },
  author: { fontSize: 11.5, fontWeight: '600', letterSpacing: 0.2 },
  modeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 1
  },
  modeBadgeAwaiting: {
    backgroundColor: 'rgba(244, 176, 99, 0.18)',
    borderColor: 'rgba(244, 176, 99, 0.55)'
  },
  modeBadgeDone: {
    backgroundColor: 'rgba(74, 222, 128, 0.13)',
    borderColor: 'rgba(74, 222, 128, 0.50)'
  },
  modeBadgeDispatched: {
    backgroundColor: 'rgba(122, 162, 255, 0.16)',
    borderColor: 'rgba(122, 162, 255, 0.50)'
  },
  modeBadgeText: { color: colors.warn, fontSize: 10, fontWeight: '600' },
  modeBadgeTextDone: { color: colors.success, fontSize: 10, fontWeight: '600' },
  modeBadgeTextDispatched: { color: colors.accent, fontSize: 10, fontWeight: '600' },
  metaStatus: { color: colors.textMuted, fontSize: 10.5 },
  metaStatusStreaming: { color: colors.warn, fontSize: 10.5 },
  metaPreview: {
    flex: 1,
    color: colors.text,
    fontSize: 11.5
  },
  metaCaret: { color: colors.textFaint, fontSize: 10, marginLeft: 'auto' },
  flowBody: { paddingTop: 4, paddingBottom: 6 },

  blockText: {},

  thought: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginVertical: 3
  },
  thoughtLabel: { color: colors.textFaint, fontSize: 10.5 },
  thoughtText: { color: colors.textMuted, fontSize: 11.5, marginTop: 4, fontStyle: 'italic' },

  toolCall: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginVertical: 3,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSoft
  },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolKind: {
    color: colors.textFaint,
    fontSize: 9.5,
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    backgroundColor: colors.bgElevated,
    borderRadius: 999
  },
  toolStatus: { fontSize: 10 },
  toolTitle: { color: colors.text, fontSize: 12, lineHeight: 15 },
  toolTitleFlex: { flex: 1 },
  toolLocations: {
    color: colors.textFaint,
    fontSize: 10,
    fontFamily: 'monospace',
    marginTop: 3
  },
  toolOutput: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
    marginTop: 4,
    backgroundColor: colors.bgElevated,
    padding: 5,
    borderRadius: 4
  },

  plan: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
    padding: 8,
    marginVertical: 4
  },
  planHeading: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4
  },
  planRow: { flexDirection: 'row', gap: 6, marginTop: 2 },
  planMark: { color: colors.textMuted, width: 12, fontSize: 11, textAlign: 'center' },
  planText: { color: colors.text, flex: 1, fontSize: 12, lineHeight: 16 },
  planMeta: { color: colors.textFaint, fontSize: 10 },

  perm: {
    borderWidth: 1,
    borderColor: colors.warn,
    borderRadius: radius.sm,
    padding: 6,
    marginVertical: 3,
    backgroundColor: 'rgba(244, 176, 99, 0.08)'
  },
  permTitle: { color: colors.warn, fontWeight: '600', fontSize: 11.5 },
  permPending: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  permResolved: { color: colors.success, fontSize: 10, marginTop: 2 },

  imageStandalone: {
    width: '100%',
    height: 220,
    borderRadius: radius.sm,
    marginTop: 4,
    backgroundColor: colors.bgInput
  },

  // Routing marker — compact collapsed line.
  routing: { alignSelf: 'flex-start' },
  routingOpen: {},
  routingHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: 999
  },
  routingArrow: { color: colors.textFaint, fontSize: 12 },
  routingSide: { fontSize: 11 },
  routingTo: { color: colors.textFaint, fontSize: 11 },
  routingKind: {
    color: colors.textMuted,
    fontSize: 9.5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    backgroundColor: colors.bgElevated,
    borderRadius: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  routingCaret: { color: colors.textFaint, fontSize: 9 },
  routingBody: {
    marginTop: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.sm
  },

  // System ambient note.
  sysNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
    paddingHorizontal: 8,
    maxWidth: '90%'
  },
  sysIcon: { fontSize: 11, width: 11, textAlign: 'center' },
  sysText: { color: colors.textFaint, fontSize: 11, flexShrink: 1 },

  stopReason: {
    color: colors.warn,
    fontSize: 10,
    marginTop: 4,
    fontStyle: 'italic'
  },
  dispatchNote: {
    color: colors.textFaint,
    fontSize: 11.5,
    fontStyle: 'italic',
    marginTop: 2
  },
  typingDots: { color: colors.textFaint, fontSize: 16, letterSpacing: 2 }
})

const mdStyles = StyleSheet.create({
  body: { color: colors.text, fontSize: 13, lineHeight: 19 },
  paragraph: { marginTop: 0, marginBottom: 6, color: colors.text },
  heading1: { color: colors.text, fontSize: 17, fontWeight: '600' },
  heading2: { color: colors.text, fontSize: 15, fontWeight: '600' },
  heading3: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
  link: { color: colors.accent },
  code_inline: {
    color: colors.accentCool,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    fontFamily: 'monospace',
    paddingHorizontal: 3,
    borderRadius: 4,
    fontSize: 12
  },
  fence: {
    color: colors.text,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    fontFamily: 'monospace',
    padding: 10,
    borderRadius: radius.sm,
    fontSize: 12
  },
  code_block: {
    color: colors.text,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    fontFamily: 'monospace',
    padding: 10,
    borderRadius: radius.sm,
    fontSize: 12
  },
  list_item: { color: colors.text, fontSize: 13 },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  blockquote: {
    backgroundColor: colors.bgInput,
    borderLeftWidth: 3,
    borderLeftColor: colors.borderSoft,
    paddingLeft: 8,
    paddingVertical: 4
  }
})

export const MessageBubble = memo(MessageBubbleInner)
