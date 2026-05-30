// Conversation list — drilldown from a project. Listens to WS for live updates
// (status changes, new conversations) so it doesn't go stale while the user
// is browsing.

import React, { useCallback, useEffect, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { conversations } from '../api/client'
import type { Conversation } from '../types'
import { colors, fontSizes, radius, spacing } from '../utils/theme'
import { useWsEvents } from '../hooks/useWsEvents'
import { NewConversationSheet } from '../components/NewConversationSheet'
import type { RootStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Conversations'>
type Route = RouteProp<RootStackParamList, 'Conversations'>

// Hoisted so FlatList doesn't see a brand-new component type every render
// (which would tear down + rebuild the separators each pass).
const Separator = (): React.ReactElement => <View style={styles.sep} />

export default function ConversationListScreen(): React.ReactElement {
  const nav = useNavigation<Nav>()
  const route = useRoute<Route>()
  const { projectId, projectName } = route.params

  const [list, setList] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>('')
  const [createOpen, setCreateOpen] = useState(false)

  const load = useCallback(async () => {
    const r = await conversations.listByProject(projectId)
    if (r.ok) {
      setError('')
      setList([...r.data].sort((a, b) => b.createdAt - a.createdAt))
    } else {
      setError(r.error)
    }
  }, [projectId])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      await load()
      setLoading(false)
    })()
  }, [load])

  // Live updates: when any conversation is updated and it belongs to this
  // project, splice it into our list (or refetch). Cheap to refetch since
  // the response is small.
  useWsEvents((e) => {
    if (e.type === 'conversation:updated' && e.payload.projectId === projectId) {
      void load()
    }
  })

  async function onRefresh(): Promise<void> {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  function openConversation(c: Conversation): void {
    nav.navigate('Chat', { conversationId: c.id, title: c.title })
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center} edges={['top']}>
        <ActivityIndicator color={colors.accent} />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => nav.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {projectName}
        </Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={list}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.empty}>
              还没有协作会话。点右下角 + 开第一个。
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const statusColor =
            item.status === 'thinking'
              ? colors.warn
              : item.status === 'awaiting-user'
                ? colors.accent
                : item.status === 'ended'
                  ? colors.textFaint
                  : colors.success
          return (
            <TouchableOpacity
              style={styles.item}
              onPress={() => openConversation(item)}
            >
              <View style={styles.itemHead}>
                <View
                  style={[styles.dot, { backgroundColor: statusColor }]}
                />
                <Text style={styles.itemTitle} numberOfLines={1}>
                  {item.title || '未命名对话'}
                </Text>
              </View>
              <Text style={styles.itemMeta}>
                {item.pmProfileId ? '3-Agent (PM)' : '2-Agent'} ·{' '}
                {labelForStatus(item.status)} ·{' '}
                {formatRelative(item.createdAt)}
              </Text>
            </TouchableOpacity>
          )
        }}
      />

      {/* Floating "+" — opens the create-conversation sheet. */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setCreateOpen(true)}
        activeOpacity={0.85}
      >
        <Text style={styles.fabPlus}>+</Text>
      </TouchableOpacity>

      <NewConversationSheet
        projectId={projectId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(view) => {
          setCreateOpen(false)
          void load()
          nav.navigate('Chat', { conversationId: view.id, title: view.title })
        }}
      />
    </SafeAreaView>
  )
}

function labelForStatus(s: Conversation['status']): string {
  switch (s) {
    case 'idle':
      return '空闲'
    case 'thinking':
      return '思考中'
    case 'awaiting-user':
      return '等你输入'
    case 'paused':
      return '已暂停'
    case 'ended':
      return '已结束'
  }
}

function formatRelative(ts: number): string {
  const d = (Date.now() - ts) / 1000
  if (d < 60) return '刚刚'
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天前`
  const date = new Date(ts)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.md
  },
  backBtn: { paddingVertical: spacing.sm, paddingRight: spacing.sm },
  backText: { color: colors.accent, fontSize: fontSizes.md },
  title: { color: colors.text, fontSize: fontSizes.xl, fontWeight: '700', flex: 1 },
  error: {
    color: colors.danger,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm
  },
  listContent: { padding: spacing.lg },
  sep: { height: spacing.sm },
  item: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft
  },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  itemTitle: { color: colors.text, fontSize: fontSizes.md, fontWeight: '600', flex: 1 },
  itemMeta: { color: colors.textFaint, fontSize: fontSizes.xs, marginTop: spacing.sm },
  emptyWrap: { paddingTop: spacing.xxl },
  empty: { color: colors.textMuted, textAlign: 'center', padding: spacing.xxl, lineHeight: 22 },
  fab: {
    position: 'absolute',
    right: spacing.xl,
    bottom: spacing.xl,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 }
  },
  fabPlus: { color: '#fff', fontSize: 32, lineHeight: 36, fontWeight: '300' }
})
