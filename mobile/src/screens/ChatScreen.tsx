// Chat workspace — three-column tablet layout, mirrors desktop App.tsx:
//
//   [ LeftSidebar (projects + convs, 320px) | Chat surface | right rail ]
//
// Center is the actual conversation (header / status / Timeline / messages
// / composer). Right rail toggles between FileExplorerPanel and TeamPanel,
// activated by the 📁 / 👥 buttons in the chat header.
//
// Conversation switching from the sidebar uses nav.setParams so the screen
// stays mounted (useConversation refetches on new id) — no stack growth.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ScrollView,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  Switch,
  Modal,
  Pressable,
  useWindowDimensions
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useConversation } from '../hooks/useConversation'
import { useConnection } from '../store/connection'
import { usePresenceBanner, formatRelativeTs } from '../hooks/usePresenceBanner'
import { MessageBubble } from '../components/MessageBubble'
import { TaskInspectorSheet } from '../components/TaskInspectorSheet'
import { InheritanceSummaryCard } from '../components/InheritanceSummaryCard'
import { TimelineStrip } from '../components/TimelineStrip'
import { LeftSidebar } from '../components/LeftSidebar'
import { NewConversationSheet } from '../components/NewConversationSheet'
import { FileExplorerPanel } from '../components/FileExplorerPanel'
import { TeamPanel } from '../components/TeamPanel'
import { ChangesPanel } from '../components/ChangesPanel'
import { JumpToConversationSheet } from '../components/JumpToConversationSheet'
import { projects as projectsApi, fs as fsApi } from '../api/client'
import { useWorkspace, selectWaiting } from '../store/workspace'
import { useWsEvents } from '../hooks/useWsEvents'
import { colors, fontSizes, radius, spacing } from '../utils/theme'
import { basenameOf, detectMention, dirnameOf, scoreFiles } from '../utils/mention'
import type { RootStackParamList } from '../navigation/types'
import type { Message, MessageBlock, Project } from '../types'

type RightPanel = 'files' | 'team' | 'changes'

interface AttentionToast {
  id: string
  projectId: string
  convId: string
  title: string
}

type Nav = NativeStackNavigationProp<RootStackParamList, 'Chat'>
type Route = RouteProp<RootStackParamList, 'Chat'>

const NOISE_PATTERNS: RegExp[] = [
  /adapter stderr/i,
  /Handled error during turn/i,
  /Reconnecting\.{3}\s*\d+\/\d+/,
  /stream disconnected/i,
  /windows sandbox:\s*spawn/i,
  /codex_core::tools::router/i,
  /codex_acp::thread/i,
  /ResponseStreamDisconnected/i
]

function messageText(m: Message): string {
  return m.blocks
    .filter(
      (b: MessageBlock): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text'
    )
    .map((b) => b.text)
    .join('\n')
}
function isAdapterNoise(m: Message): boolean {
  if (m.role !== 'system') return false
  return NOISE_PATTERNS.some((re) => re.test(messageText(m)))
}
function isInheritanceSummary(m: Message): boolean {
  if (m.role !== 'system') return false
  return /CloXde 继承上下文/.test(messageText(m))
}

/** Map a presence activity kind to a short Chinese verb for the banner. */
function presenceLabel(kind: string): string {
  switch (kind) {
    case 'send-message': return '（刚发了消息）'
    case 'cancel': return '（刚停止了一轮）'
    case 'autopilot': return '（切换了自动接力）'
    case 'primary-side': return '（切换了主侧）'
    case 'archive': return '（归档了会话）'
    case 'unarchive': return '（取消归档）'
    case 'delete': return '（删除了会话）'
    default: return ''
  }
}

export default function ChatScreen(): React.ReactElement {
  const nav = useNavigation<Nav>()
  const route = useRoute<Route>()
  const { conversationId } = route.params
  const { width } = useWindowDimensions()
  // Tablet vs phone breakpoint — below this, hide the persistent left
  // sidebar (the user can still navigate via stack-back).
  const SHOW_SIDEBAR = width >= 900

  const { view, loading, error, hasMore, loadingEarlier, loadEarlier, send, cancel, setAutopilot } =
    useConversation(conversationId)

  // Cross-client awareness — banner appears when the desktop (or another
  // tablet) just touched the same conversation, so the user knows they're
  // not alone before typing into someone else's session.
  const selfLabel = useConnection((s) => s.conn?.label ?? 'tablet')
  const presence = usePresenceBanner({ conversationId, selfLabel })

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [taskOpen, setTaskOpen] = useState(false)
  const [rightPanels, setRightPanels] = useState<Set<RightPanel>>(new Set())
  const [showSystem, setShowSystem] = useState(true)
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  // Cross-project workspace store (projects + conversations) — drives the
  // LeftSidebar, the attention badge, and the jump-to-conversation modal.
  const loadAll = useWorkspace((s) => s.loadAll)
  const reloadProject = useWorkspace((s) => s.reloadProject)
  const waiting = useWorkspace(selectWaiting)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [attentionOpen, setAttentionOpen] = useState(false)
  const [toasts, setToasts] = useState<AttentionToast[]>([])
  // Last-seen status per conversation — to detect transitions INTO
  // awaiting-user (the moment that warrants a toast).
  const prevStatusRef = useRef<Record<string, string>>({})
  // Project id for which the "新建协作会话" sheet is open (from the sidebar).
  const [newConvProjectId, setNewConvProjectId] = useState<string | null>(null)
  // --- @file autocomplete state ---
  // Caret offset in the draft (-1 when a range is selected). We track it so we
  // can find the in-progress @token. `pendingSel` transiently controls the
  // TextInput selection right after we insert a path (so we don't fight the
  // CJK IME by keeping selection controlled all the time).
  const [caret, setCaret] = useState(0)
  const [pendingSel, setPendingSel] = useState<{ start: number; end: number } | null>(null)
  const [mentionClosed, setMentionClosed] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const filesFetchedRef = useRef(false)
  const listRef = useRef<FlatList>(null)
  // Pin-to-bottom guard. Without it, the FlatList's onContentSizeChange
  // fires whenever the chat column re-flows (e.g. right panel toggling
  // open shrinks the available width) and we'd scrollToEnd → re-flow →
  // scrollToEnd → ... visible flicker. We only auto-scroll when the user
  // is already at the bottom (within 80px tolerance).
  const isPinnedRef = useRef(true)
  // Previous content height — only react to growth (new messages), not to
  // width-change-induced re-layout.
  const lastContentHeightRef = useRef(0)

  // Load the active project for the FileExplorerPanel header + path.
  useEffect(() => {
    if (!view?.projectId) return
    void projectsApi.list().then((r) => {
      if (!r.ok) return
      setActiveProject(r.data.find((p) => p.id === view.projectId) ?? null)
    })
  }, [view?.projectId])

  // Own the shared workspace store: load all projects + conversations once on
  // mount so the sidebar, attention badge, and jump modal have data. Seed
  // prevStatusRef from the loaded state so we only toast on genuine
  // transitions INTO awaiting-user, not for sessions already waiting on mount.
  useEffect(() => {
    void loadAll().then(() => {
      const { convsByProject } = useWorkspace.getState()
      for (const convs of Object.values(convsByProject)) {
        for (const c of convs) prevStatusRef.current[c.id] = c.status
      }
    })
  }, [loadAll])

  // Single WS subscription that keeps the workspace store fresh AND drives the
  // cross-project attention loop: when any conversation (other than the one
  // we're viewing) transitions INTO awaiting-user, surface a toast.
  useWsEvents((e) => {
    if (e.type !== 'conversation:updated') return
    const c = e.payload
    void reloadProject(c.projectId)
    const prev = prevStatusRef.current[c.id]
    prevStatusRef.current[c.id] = c.status
    if (
      c.status === 'awaiting-user' &&
      prev !== 'awaiting-user' &&
      c.id !== conversationId &&
      !c.archivedAt
    ) {
      const title = c.title || `会话 ${c.id.slice(0, 6)}`
      setToasts((t) => [
        ...t.filter((x) => x.convId !== c.id),
        { id: `${c.id}-${Date.now()}`, projectId: c.projectId, convId: c.id, title }
      ])
    }
  })

  // Auto-dismiss the oldest toast after 6s.
  useEffect(() => {
    if (toasts.length === 0) return undefined
    const t = setTimeout(() => setToasts((cur) => cur.slice(1)), 6_000)
    return () => clearTimeout(t)
  }, [toasts])

  const toggleRightPanel = useCallback((p: RightPanel): void => {
    setRightPanels((s) => {
      const next = new Set(s)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }, [])

  const closeRightPanel = useCallback((p: RightPanel): void => {
    setRightPanels((s) => {
      const next = new Set(s)
      next.delete(p)
      return next
    })
  }, [])

  const jumpToConversation = useCallback(
    (_projectId: string, convId: string, title?: string): void => {
      if (convId !== conversationId) nav.setParams({ conversationId: convId, title })
      setAttentionOpen(false)
      setToasts((t) => t.filter((x) => x.convId !== convId))
    },
    [conversationId, nav]
  )

  // Filter visible messages + extract inheritance summary.
  const { inheritanceSummary, visibleMessages, systemMessageCount } = useMemo(() => {
    if (!view) {
      return {
        inheritanceSummary: null as string | null,
        visibleMessages: [] as Message[],
        systemMessageCount: 0
      }
    }
    const threeAgent = !!view.pmProfileId
    let summary: string | null = null
    let sysCount = 0
    const out: Message[] = []
    for (const m of view.messages) {
      if (isInheritanceSummary(m)) {
        summary = messageText(m)
        continue
      }
      if (isAdapterNoise(m)) continue
      if (m.role === 'system') {
        sysCount += 1
        if (!showSystem) continue
      }
      if (threeAgent) {
        if (m.side === 'architect' || m.side === 'executor') continue
        if (m.role === 'user' && m.forwardedFromMessageId) continue
      }
      out.push(m)
    }
    return { inheritanceSummary: summary, visibleMessages: out, systemMessageCount: sysCount }
  }, [view, showSystem])

  useEffect(() => {
    // Only react to a NEW message landing — not to every visibleMessages
    // recomputation triggered by panel-toggle re-renders. Length is the
    // monotonic signal; if it grew, fire a scroll.
    if (visibleMessages.length && isPinnedRef.current) {
      const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50)
      return () => clearTimeout(t)
    }
    return undefined
  }, [visibleMessages.length])

  const handleSend = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    setSending(true)
    const r = await send(text)
    setSending(false)
    if (!r.ok) {
      Alert.alert('发送失败', r.error)
      return
    }
    setDraft('')
  }, [draft, send])

  // --- @file autocomplete -------------------------------------------------
  // Reset the cached file list when the conversation's project changes.
  useEffect(() => {
    filesFetchedRef.current = false
    setFiles([])
  }, [view?.projectId])

  const mention = useMemo(() => {
    if (mentionClosed || caret < 0) return null
    return detectMention(draft, caret)
  }, [draft, caret, mentionClosed])

  // Lazily fetch the project file list the first time an @menu opens.
  useEffect(() => {
    if (!mention || filesFetchedRef.current || !view?.projectId) return
    filesFetchedRef.current = true
    void fsApi.listFiles(view.projectId).then((r) => {
      if (r.ok) setFiles(r.data)
    })
  }, [mention, view?.projectId])

  const mentionSuggestions = useMemo(() => {
    if (!mention) return []
    return scoreFiles(files, mention.query).slice(0, 30)
  }, [mention, files])

  const acceptMention = useCallback(
    (path: string) => {
      if (!mention) return
      const before = draft.slice(0, mention.start)
      const after = draft.slice(caret)
      const insert = `@${path} `
      const newCaret = before.length + insert.length
      setDraft(before + insert + after)
      setCaret(newCaret)
      setPendingSel({ start: newCaret, end: newCaret })
    },
    [mention, draft, caret]
  )

  const handleStepPress = useCallback(
    (messageId: string) => {
      const idx = visibleMessages.findIndex((m) => m.id === messageId)
      if (idx >= 0) {
        listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 })
      }
    },
    [visibleMessages]
  )

  // Sidebar → swap conversation in place (replace, not push).
  const handleSidebarSelect = useCallback(
    (_projectId: string, convId: string, title?: string) => {
      if (convId === conversationId) return
      nav.setParams({ conversationId: convId, title })
    },
    [conversationId, nav]
  )

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </SafeAreaView>
    )
  }
  if (error) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.error}>{error}</Text>
        <TouchableOpacity onPress={() => nav.goBack()}>
          <Text style={styles.errorBack}>返回</Text>
        </TouchableOpacity>
      </SafeAreaView>
    )
  }
  if (!view) return <SafeAreaView style={styles.center} />

  const busy = view.busySide || view.status === 'thinking'
  const threeAgent = !!view.pmProfileId

  // Center column — chat surface (the original "single column" UI).
  const centerColumn = (
    <View style={styles.centerCol}>
      {/* Header (titlebar-ish) */}
      <View style={styles.header}>
        {!SHOW_SIDEBAR ? (
          <TouchableOpacity onPress={() => nav.goBack()} style={styles.backBtn}>
            <Text style={styles.backText}>‹ 返回</Text>
          </TouchableOpacity>
        ) : null}
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {view.title || '未命名对话'}
          </Text>
          <View style={styles.agentRow}>
            {threeAgent && view.pm ? (
              <>
                <View
                  style={[
                    styles.agentChip,
                    { borderColor: colors.pm, backgroundColor: tintBg(colors.pm) }
                  ]}
                >
                  <View
                    style={[
                      styles.agentDot,
                      { backgroundColor: colors.pm },
                      view.busySide === 'pm' && styles.agentDotBusy
                    ]}
                  />
                  <Text style={[styles.agentChipText, { color: colors.pm }]}>
                    产品经理 · {view.pm.kind}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[
                    styles.teamHint,
                    (view.busySide === 'architect' || view.busySide === 'executor') &&
                      styles.teamHintBusy,
                    rightPanels.has('team') && styles.teamHintActive
                  ]}
                  onPress={() => toggleRightPanel('team')}
                  activeOpacity={0.7}
                >
                  <View style={[styles.agentDot, { backgroundColor: colors.architect }]} />
                  <View style={[styles.agentDot, { backgroundColor: colors.executor }]} />
                  <Text style={styles.teamHintText}>
                    工作组 · {view.architect.kind} / {view.executor.kind}
                  </Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <View
                  style={[
                    styles.agentChip,
                    { borderColor: colors.architect, backgroundColor: tintBg(colors.architect) }
                  ]}
                >
                  <View style={[styles.agentDot, { backgroundColor: colors.architect }]} />
                  <Text style={[styles.agentChipText, { color: colors.architect }]}>
                    架构师 · {view.architect.kind}
                  </Text>
                </View>
                <Text style={styles.agentSep}>↔</Text>
                <View
                  style={[
                    styles.agentChip,
                    { borderColor: colors.executor, backgroundColor: tintBg(colors.executor) }
                  ]}
                >
                  <View style={[styles.agentDot, { backgroundColor: colors.executor }]} />
                  <Text style={[styles.agentChipText, { color: colors.executor }]}>
                    执行者 · {view.executor.kind}
                  </Text>
                </View>
              </>
            )}
          </View>
        </View>
        {/* Right-rail toggle + global action buttons */}
        <TouchableOpacity
          style={styles.titlebarBtn}
          onPress={() => setJumpOpen(true)}
          accessibilityLabel="跳转会话"
        >
          <Text style={styles.titlebarBtnText}>🔍</Text>
        </TouchableOpacity>
        <View>
          <TouchableOpacity
            style={[styles.titlebarBtn, attentionOpen && styles.titlebarBtnActive]}
            onPress={() => setAttentionOpen((v) => !v)}
            accessibilityLabel="待处理会话"
          >
            <Text style={styles.titlebarBtnText}>🔔</Text>
          </TouchableOpacity>
          {waiting.length > 0 ? (
            <View style={styles.bellBadge}>
              <Text style={styles.bellBadgeText}>{waiting.length}</Text>
            </View>
          ) : null}
        </View>
        <TouchableOpacity
          style={[styles.titlebarBtn, rightPanels.has('changes') && styles.titlebarBtnActive]}
          onPress={() => toggleRightPanel('changes')}
        >
          <Text style={styles.titlebarBtnText}>📝</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.titlebarBtn, rightPanels.has('files') && styles.titlebarBtnActive]}
          onPress={() => toggleRightPanel('files')}
        >
          <Text style={styles.titlebarBtnText}>📁</Text>
        </TouchableOpacity>
        {busy ? (
          <TouchableOpacity onPress={() => void cancel()} style={styles.cancelBtn}>
            <Text style={styles.cancelBtnText}>停止</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Status bar */}
      <View style={styles.statusBar}>
        <View style={styles.statusLeft}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: statusDotColor(view.status) }
            ]}
          />
          <Text style={styles.statusText}>
            {labelForConvStatus(view.status)}
            {view.busySide ? ` · ${labelForRole(view.busySide)} 思考中` : ''}
          </Text>
          {view.autoTurnsUsed > 0 ? (
            <View style={styles.autoTurns}>
              <Text style={styles.statusMeta}>
                接力 {view.autoTurnsUsed}/{view.maxAutoTurns}
              </Text>
              <View style={styles.autoTurnsTrack}>
                <View
                  style={[
                    styles.autoTurnsFill,
                    {
                      width: `${Math.min(
                        100,
                        view.maxAutoTurns > 0
                          ? (view.autoTurnsUsed / view.maxAutoTurns) * 100
                          : 0
                      )}%`,
                      backgroundColor:
                        view.autoTurnsUsed >= view.maxAutoTurns ? colors.warn : colors.accent
                    }
                  ]}
                />
              </View>
            </View>
          ) : null}
        </View>
        <View style={styles.statusRight}>
          {systemMessageCount > 0 ? (
            <TouchableOpacity
              onPress={() => setShowSystem((v) => !v)}
              style={[styles.sysToggle, showSystem && styles.sysToggleActive]}
            >
              <Text style={[styles.sysToggleText, showSystem && styles.sysToggleTextActive]}>
                🛠 {showSystem ? '隐藏' : '显示'}系统 {systemMessageCount}
              </Text>
            </TouchableOpacity>
          ) : null}
          <Text style={styles.statusText}>自动接力</Text>
          <Switch
            value={view.autopilot}
            onValueChange={(v) => void setAutopilot(v)}
            trackColor={{ false: colors.border, true: colors.accent }}
            thumbColor="#fff"
          />
        </View>
      </View>

      {/* Task badge */}
      {view.activeTask ? (
        <TouchableOpacity
          style={styles.taskBadge}
          onPress={() => setTaskOpen(true)}
          activeOpacity={0.7}
        >
          <View
            style={[
              styles.taskBadgeOwnerDot,
              { backgroundColor: ownerTint(view.activeTask.owner) }
            ]}
          />
          <Text style={styles.taskBadgeStatus}>
            {labelForTaskStatus(view.activeTask.status)}
          </Text>
          <Text style={styles.taskBadgeBrief} numberOfLines={2}>
            {view.activeTask.brief || '（无 brief）'}
          </Text>
          <Text style={styles.taskBadgeChevron}>›</Text>
        </TouchableOpacity>
      ) : null}

      <TimelineStrip view={view} threeAgent={threeAgent} onStepPress={handleStepPress} />

      {presence ? (
        <View style={styles.presenceBanner}>
          <View style={styles.presenceDot} />
          <Text style={styles.presenceText} numberOfLines={1}>
            {presence.client.kind === 'desktop' ? '桌面端' : presence.client.label}
            {' · '}
            {formatRelativeTs(presence.ts)}
            {' 在使用'}
            {presenceLabel(presence.kind)}
          </Text>
        </View>
      ) : null}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <FlatList
          ref={listRef}
          data={visibleMessages}
          keyExtractor={(m) => m.id}
          ListHeaderComponent={
            <>
              {hasMore ? (
                <TouchableOpacity
                  style={styles.loadEarlierBtn}
                  onPress={() => void loadEarlier()}
                  disabled={loadingEarlier}
                  activeOpacity={0.7}
                >
                  {loadingEarlier ? (
                    <ActivityIndicator color={colors.textMuted} size="small" />
                  ) : (
                    <Text style={styles.loadEarlierText}>↑ 加载更早</Text>
                  )}
                </TouchableOpacity>
              ) : null}
              {inheritanceSummary ? <InheritanceSummaryCard text={inheritanceSummary} /> : null}
            </>
          }
          ListEmptyComponent={
            inheritanceSummary ? null : (
              <Text style={styles.empty}>
                {threeAgent ? '跟 PM 聊几句开始任务吧。' : '从这里开始对话。'}
              </Text>
            )
          }
          renderItem={({ item }) => <MessageBubble message={item} />}
          contentContainerStyle={styles.listContent}
          // Pin-to-bottom: only auto-scroll when the user is already near
          // the bottom. Compare scroll position against content height to
          // decide. Without this, the right-panel toggle re-flows the list
          // (width change → height change) and we'd loop.
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
            const distFromBottom =
              contentSize.height - contentOffset.y - layoutMeasurement.height
            isPinnedRef.current = distFromBottom < 80
          }}
          scrollEventThrottle={64}
          onContentSizeChange={(_w, h) => {
            // Only scroll when height actually grew (new message arrived)
            // AND the user was pinned. Width-only changes (panel toggle)
            // produce no height delta → no scroll → no flicker loop.
            const grew = h > lastContentHeightRef.current
            lastContentHeightRef.current = h
            if (grew && isPinnedRef.current) {
              listRef.current?.scrollToEnd({ animated: false })
            }
          }}
          onScrollToIndexFailed={() => {
            setTimeout(() => {
              if (isPinnedRef.current) listRef.current?.scrollToEnd({ animated: true })
            }, 100)
          }}
        />

        <View style={styles.composerWrap}>
          {mentionSuggestions.length > 0 ? (
            <View style={styles.mentionMenu}>
              <View style={styles.mentionHeader}>
                <Text style={styles.mentionHeaderText}>引用文件 · 点选插入路径</Text>
                <TouchableOpacity
                  onPress={() => setMentionClosed(true)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.mentionClose}>×</Text>
                </TouchableOpacity>
              </View>
              <ScrollView
                style={styles.mentionList}
                keyboardShouldPersistTaps="always"
                nestedScrollEnabled
              >
                {mentionSuggestions.map((path) => (
                  <TouchableOpacity
                    key={path}
                    style={styles.mentionItem}
                    onPress={() => acceptMention(path)}
                    activeOpacity={0.6}
                  >
                    <Text style={styles.mentionBase} numberOfLines={1}>
                      {basenameOf(path)}
                    </Text>
                    <Text style={styles.mentionDir} numberOfLines={1}>
                      {dirnameOf(path)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          ) : null}
          <View style={styles.composer}>
            <TextInput
              value={draft}
              onChangeText={(t) => {
                setDraft(t)
                setMentionClosed(false)
              }}
              selection={pendingSel ?? undefined}
              onSelectionChange={(e) => {
                const s = e.nativeEvent.selection
                setCaret(s.start === s.end ? s.start : -1)
                if (pendingSel) setPendingSel(null)
              }}
              placeholder={
                threeAgent ? '跟 PM 说点什么…' : `跟${labelForRole(view.primarySide)}说点什么…`
              }
              placeholderTextColor={colors.textFaint}
              style={styles.composerInput}
              multiline
              editable={!sending}
            />
            <TouchableOpacity
              style={[styles.sendBtn, !draft.trim() && styles.sendBtnDisabled]}
              onPress={() => void handleSend()}
              disabled={!draft.trim() || sending}
            >
              {sending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.sendBtnText}>发送</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  )

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.workspace}>
        {SHOW_SIDEBAR ? (
          <LeftSidebar
            activeProjectId={view.projectId}
            activeConversationId={view.id}
            onSelectConversation={handleSidebarSelect}
            onNewConversation={(pid) => setNewConvProjectId(pid)}
            onOpenSettings={() => nav.navigate('Settings')}
          />
        ) : null}
        {centerColumn}
        {rightPanels.has('files') && activeProject ? (
          <FileExplorerPanel project={activeProject} onClose={() => closeRightPanel('files')} />
        ) : null}
        {rightPanels.has('changes') && activeProject ? (
          <ChangesPanel project={activeProject} onClose={() => closeRightPanel('changes')} />
        ) : null}
        {rightPanels.has('team') ? (
          <TeamPanel view={view} onClose={() => closeRightPanel('team')} />
        ) : null}
      </View>

      <TaskInspectorSheet
        task={view.activeTask ?? null}
        open={taskOpen}
        onClose={() => setTaskOpen(false)}
      />

      {newConvProjectId ? (
        <NewConversationSheet
          projectId={newConvProjectId}
          open={newConvProjectId !== null}
          onClose={() => setNewConvProjectId(null)}
          onCreated={(created) => {
            setNewConvProjectId(null)
            if (created.id !== conversationId) {
              nav.setParams({ conversationId: created.id, title: created.title })
            }
          }}
        />
      ) : null}

      <JumpToConversationSheet
        open={jumpOpen}
        onClose={() => setJumpOpen(false)}
        onSelect={jumpToConversation}
      />

      {/* Attention popover — cross-project conversations awaiting the user. */}
      <Modal
        visible={attentionOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAttentionOpen(false)}
      >
        <Pressable style={styles.attentionBackdrop} onPress={() => setAttentionOpen(false)}>
          <Pressable style={styles.attentionSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.attentionTitle}>待你处理 · {waiting.length}</Text>
            {waiting.length === 0 ? (
              <Text style={styles.attentionEmpty}>没有等待中的会话</Text>
            ) : (
              <ScrollView style={{ maxHeight: 360 }}>
                {waiting.map((w) => (
                  <TouchableOpacity
                    key={w.conv.id}
                    style={styles.attentionRow}
                    onPress={() => jumpToConversation(w.projectId, w.conv.id, w.conv.title)}
                    activeOpacity={0.6}
                  >
                    <View style={styles.attentionDot} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.attentionConvTitle} numberOfLines={1}>
                        {w.conv.title || `会话 ${w.conv.id.slice(0, 6)}`}
                      </Text>
                      <Text style={styles.attentionProject} numberOfLines={1}>
                        {w.projectName}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Attention toasts — transient, tap to jump. */}
      {toasts.length > 0 ? (
        <View style={styles.toastStack} pointerEvents="box-none">
          {toasts.map((t) => (
            <TouchableOpacity
              key={t.id}
              style={styles.toast}
              activeOpacity={0.8}
              onPress={() => jumpToConversation(t.projectId, t.convId, t.title)}
            >
              <View style={styles.toastDot} />
              <Text style={styles.toastText} numberOfLines={1}>
                {t.title} · 等你输入
              </Text>
              <TouchableOpacity
                onPress={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.toastClose}>×</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </SafeAreaView>
  )
}

function labelForConvStatus(s: string): string {
  switch (s) {
    case 'idle': return '空闲'
    case 'thinking': return '思考中'
    case 'awaiting-user': return '等你输入'
    case 'paused': return '已暂停'
    case 'ended': return '已结束'
    default: return s
  }
}
/** Status dot tint — mirrors desktop's .dot.* mapping in styles.css:
 *  idle=dim, thinking=accent(blue), awaiting/paused=warm, ended=ok(green). */
function statusDotColor(s: string): string {
  switch (s) {
    case 'thinking': return colors.accent
    case 'awaiting-user':
    case 'paused': return colors.warn
    case 'ended': return colors.success
    default: return colors.textMuted
  }
}
function labelForRole(r: string): string {
  switch (r) {
    case 'pm': return 'PM'
    case 'architect': return '架构师'
    case 'executor': return '执行者'
    default: return r
  }
}
function labelForTaskStatus(s: string): string {
  switch (s) {
    case 'briefing': return '需求收集'
    case 'planning': return '规划中'
    case 'executing': return '执行中'
    case 'review': return '审查中'
    case 'done': return '已完成'
    case 'failed': return '失败'
    default: return s
  }
}
function ownerTint(role: string): string {
  if (role === 'pm') return colors.pm
  if (role === 'architect') return colors.architect
  if (role === 'executor') return colors.executor
  return colors.textFaint
}
function tintBg(hex: string): string {
  return hex + '1f'
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  workspace: { flex: 1, flexDirection: 'row' },
  centerCol: { flex: 1, flexDirection: 'column', minWidth: 0 },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  error: { color: colors.danger, paddingHorizontal: spacing.xl, marginBottom: spacing.md },
  errorBack: { color: colors.accent, fontSize: fontSizes.md },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft
  },
  backBtn: { padding: spacing.sm },
  backText: { color: colors.accent, fontSize: fontSizes.sm },
  headerTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
    flexWrap: 'wrap'
  },
  agentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1
  },
  agentChipText: { fontSize: 11, fontWeight: '500' },
  agentDot: { width: 5, height: 5, borderRadius: 3, opacity: 0.7 },
  agentDotBusy: { opacity: 1 },
  agentSep: { color: colors.textFaint, fontSize: 12 },
  teamHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.bgElevated
  },
  teamHintBusy: { borderColor: colors.accent },
  teamHintActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  teamHintText: { color: colors.textMuted, fontSize: 11, marginLeft: 3 },

  titlebarBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'transparent'
  },
  titlebarBtnActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft
  },
  titlebarBtnText: { fontSize: 16 },
  bellBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: colors.warn,
    alignItems: 'center',
    justifyContent: 'center'
  },
  bellBadgeText: { color: colors.bg, fontSize: 9, fontWeight: '700' },

  cancelBtn: {
    backgroundColor: colors.danger,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5
  },
  cancelBtnText: { color: '#fff', fontWeight: '600', fontSize: 11 },

  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    backgroundColor: colors.bgElevated
  },
  statusLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { color: colors.textMuted, fontSize: 11 },
  statusMeta: { color: colors.textFaint, fontSize: 11 },
  autoTurns: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  autoTurnsTrack: {
    width: 56,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    overflow: 'hidden'
  },
  autoTurnsFill: { height: 4, borderRadius: 2 },
  sysToggle: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderSoft
  },
  sysToggleActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  sysToggleText: { color: colors.textMuted, fontSize: 10 },
  sysToggleTextActive: { color: colors.accent },

  taskBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    gap: spacing.sm
  },
  taskBadgeOwnerDot: { width: 7, height: 7, borderRadius: 4 },
  taskBadgeStatus: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: colors.bg,
    borderRadius: radius.sm
  },
  taskBadgeBrief: { color: colors.text, fontSize: 12, flex: 1 },
  taskBadgeChevron: { color: colors.textFaint, fontSize: 14 },

  // Cross-client awareness banner — appears under TimelineStrip when the
  // desktop (or another tablet) just operated this same conversation. Soft
  // amber so it reads as advisory, not as a hard block.
  presenceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
    backgroundColor: 'rgba(244, 176, 99, 0.10)',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderTopColor: 'rgba(244, 176, 99, 0.35)',
    borderBottomColor: 'rgba(244, 176, 99, 0.35)'
  },
  presenceDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.warn
  },
  presenceText: {
    color: colors.warn,
    fontSize: 11.5,
    flexShrink: 1
  },

  listContent: {
    // Center the chat stream and constrain reading width — mirrors desktop's
    // .conv-stream-inner { max-width: 820px; margin: 0 auto }. Without this
    // the messages span the full chat column on a 3000px tablet, which the
    // user (rightly) calls "撑满 / 顶天立地".
    alignSelf: 'center',
    maxWidth: 800,
    width: '100%',
    paddingTop: 40,
    paddingBottom: 40,
    paddingHorizontal: spacing.lg,
    flexGrow: 1
  },
  empty: {
    color: colors.textFaint,
    textAlign: 'center',
    padding: spacing.xxl,
    fontSize: 12
  },
  loadEarlierBtn: {
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.bgElevated,
    marginBottom: spacing.md
  },
  loadEarlierText: {
    color: colors.textMuted,
    fontSize: 11
  },

  composerWrap: {
    // Same centered-column treatment for the composer so the input doesn't
    // stretch across the whole tablet. Surrounding background stays the
    // chat bg color (composer itself has its own borders/bg).
    alignSelf: 'center',
    width: '100%',
    maxWidth: 800,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    backgroundColor: colors.bg
  },
  composerInput: {
    flex: 1,
    backgroundColor: colors.bgInput,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 13,
    maxHeight: 140,
    minHeight: 40,
    borderWidth: 1,
    borderColor: colors.border
  },
  sendBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },

  // @file autocomplete menu — floats just above the composer input.
  mentionMenu: {
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    maxHeight: 220
  },
  mentionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft
  },
  mentionHeaderText: { color: colors.textMuted, fontSize: 11 },
  mentionClose: { color: colors.textFaint, fontSize: 18, paddingHorizontal: 4 },
  mentionList: { maxHeight: 180 },
  mentionItem: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft
  },
  mentionBase: { color: colors.text, fontSize: 13 },
  mentionDir: { color: colors.textFaint, fontSize: 11, flexShrink: 1 },

  // Attention popover (bell) — cross-project awaiting-user list.
  attentionBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'flex-end',
    paddingTop: 56,
    paddingRight: spacing.md
  },
  attentionSheet: {
    width: 320,
    maxHeight: '70%',
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm
  },
  attentionTitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: spacing.sm,
    paddingVertical: 6
  },
  attentionEmpty: {
    color: colors.textFaint,
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: spacing.lg
  },
  attentionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    borderRadius: radius.sm
  },
  attentionDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  attentionConvTitle: { color: colors.text, fontSize: 13 },
  attentionProject: { color: colors.textFaint, fontSize: 10, marginTop: 1 },

  // Toast stack — bottom-center, transient awaiting-user nudges.
  toastStack: {
    position: 'absolute',
    bottom: spacing.lg,
    alignSelf: 'center',
    gap: spacing.sm,
    width: '100%',
    maxWidth: 480,
    paddingHorizontal: spacing.lg
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.warn,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  toastDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.warn },
  toastText: { color: colors.text, fontSize: 12, flex: 1 },
  toastClose: { color: colors.textFaint, fontSize: 16, paddingHorizontal: 4 }
})
