// Project list — entry screen after pairing. Shows recent projects so the
// user can drill into conversations. Pull-to-refresh re-fetches.

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
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { projects } from '../api/client'
import type { Project } from '../types'
import { colors, fontSizes, radius, spacing } from '../utils/theme'
import type { RootStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Projects'>

// Hoisted so FlatList doesn't see a brand-new component type every render.
const Separator = (): React.ReactElement => <View style={styles.sep} />

export default function ProjectListScreen(): React.ReactElement {
  const nav = useNavigation<Nav>()
  const [list, setList] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>('')

  const load = useCallback(async () => {
    const r = await projects.list()
    if (r.ok) {
      setError('')
      // Sort by lastOpenedAt desc so the most recently used project floats up.
      setList([...r.data].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt))
    } else {
      setError(r.error)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      await load()
      setLoading(false)
    })()
  }, [load])

  async function onRefresh(): Promise<void> {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  async function openProject(p: Project): Promise<void> {
    await projects.open(p.id)
    nav.navigate('Conversations', { projectId: p.id, projectName: p.name })
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
        <Text style={styles.title}>项目</Text>
        <TouchableOpacity
          onPress={() => nav.navigate('Settings')}
          style={styles.settingsBtn}
        >
          <Text style={styles.settingsBtnText}>设置</Text>
        </TouchableOpacity>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={list}
        keyExtractor={(p) => p.id}
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
          <Text style={styles.empty}>
            没有项目。请到桌面端用「打开文件夹」创建一个项目。
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.item} onPress={() => openProject(item)}>
            <Text style={styles.itemName} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.itemPath} numberOfLines={1}>
              {item.rootDir}
            </Text>
            <Text style={styles.itemMeta}>
              {formatRelative(item.lastOpenedAt)} · {item.defaultArchitect} →{' '}
              {item.defaultExecutor}
            </Text>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  )
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
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm
  },
  title: { color: colors.text, fontSize: fontSizes.xxl, fontWeight: '700' },
  settingsBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated
  },
  settingsBtnText: { color: colors.textMuted, fontSize: fontSizes.sm },
  error: {
    color: colors.danger,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm
  },
  listContent: { padding: spacing.lg, gap: spacing.sm },
  sep: { height: spacing.sm },
  item: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft
  },
  itemName: { color: colors.text, fontSize: fontSizes.lg, fontWeight: '600' },
  itemPath: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    marginTop: spacing.xs,
    fontFamily: 'monospace'
  },
  itemMeta: {
    color: colors.textFaint,
    fontSize: fontSizes.xs,
    marginTop: spacing.sm
  },
  empty: {
    color: colors.textMuted,
    textAlign: 'center',
    padding: spacing.xxl,
    lineHeight: 22
  }
})
