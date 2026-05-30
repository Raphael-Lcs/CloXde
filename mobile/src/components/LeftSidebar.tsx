// Left rail of the Chat workspace — mirrors desktop's Sidebar.tsx layout:
//   • 项目 header
//   • Search box + status filter chips (mirrors desktop Sidebar filter)
//   • One row per project, expandable → conversation list
//   • Active project + active conv visually highlighted
//   • Footer: 设置 button, version label
//
// Reads projects + per-project conversations from the shared workspace store
// (loaded + WS-refreshed by ChatScreen), so this component is now a pure view.

import React, { useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator
} from 'react-native'
import type { Conversation, ConversationStatus } from '../types'
import { useWorkspace } from '../store/workspace'
import { colors, radius, spacing } from '../utils/theme'

interface Props {
  activeProjectId: string | null
  activeConversationId: string | null
  onSelectConversation: (
    projectId: string,
    conversationId: string,
    title?: string
  ) => void
  onNewConversation: (projectId: string) => void
  onOpenSettings: () => void
  versionLabel?: string
}

const STATUS_FILTERS: Array<[ConversationStatus | 'all', string]> = [
  ['all', '全部'],
  ['awaiting-user', '等待'],
  ['thinking', '进行中'],
  ['idle', '空闲']
]

export function LeftSidebar({
  activeProjectId,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onOpenSettings,
  versionLabel = ''
}: Props): React.ReactElement {
  const projects = useWorkspace((s) => s.projects)
  const convsByProject = useWorkspace((s) => s.convsByProject)
  const loading = useWorkspace((s) => s.loading)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<ConversationStatus | 'all'>('all')

  const q = query.trim().toLowerCase()
  const filterActive = q.length > 0 || statusFilter !== 'all'
  const filterConvs = (convs: Conversation[]): Conversation[] =>
    convs.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (q && !(c.title ?? c.id).toLowerCase().includes(q)) return false
      return true
    })
  const noMatches =
    filterActive &&
    projects.every((p) => filterConvs(convsByProject[p.id] ?? []).length === 0)

  const toggleProject = (id: string): void => {
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <View style={styles.root}>
      <View style={styles.headerSection}>
        <Text style={styles.headerTitle}>项目</Text>
      </View>

      <View style={styles.filter}>
        <TextInput
          style={styles.search}
          placeholder="搜索会话…"
          placeholderTextColor={colors.textFaint}
          value={query}
          onChangeText={setQuery}
        />
        <View style={styles.chips}>
          {STATUS_FILTERS.map(([value, label]) => (
            <TouchableOpacity
              key={value}
              style={[styles.chip, statusFilter === value && styles.chipActive]}
              onPress={() => setStatusFilter(value)}
              activeOpacity={0.7}
            >
              <Text style={[styles.chipText, statusFilter === value && styles.chipTextActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
        {loading && projects.length === 0 ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.lg }} />
        ) : projects.length === 0 ? (
          <Text style={styles.empty}>暂无项目</Text>
        ) : noMatches ? (
          <Text style={styles.empty}>无匹配会话</Text>
        ) : (
          projects.map((p) => {
            const isActive = p.id === activeProjectId
            const isCollapsed = filterActive ? false : collapsed.has(p.id) && !isActive
            const convs = filterConvs(convsByProject[p.id] ?? [])
            if (filterActive && convs.length === 0) return null
            return (
              <View key={p.id} style={styles.projectGroup}>
                <TouchableOpacity
                  style={[
                    styles.projectRow,
                    isActive && styles.projectRowActive
                  ]}
                  onPress={() => toggleProject(p.id)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.caret}>{isCollapsed ? '▸' : '▾'}</Text>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={[
                        styles.projectName,
                        isActive && styles.projectNameActive
                      ]}
                      numberOfLines={1}
                    >
                      {p.name}
                    </Text>
                    <Text style={styles.projectPath} numberOfLines={1}>{p.rootDir}</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.newConvBtn}
                    onPress={() => onNewConversation(p.id)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.newConvBtnText}>＋</Text>
                  </TouchableOpacity>
                </TouchableOpacity>
                {!isCollapsed && (
                  <View style={styles.convTree}>
                    {convs.length === 0 ? (
                      <Text style={styles.convEmpty}>暂无会话</Text>
                    ) : (
                      convs.map((c) => {
                        const isConvActive = c.id === activeConversationId
                        return (
                          <TouchableOpacity
                            key={c.id}
                            style={[
                              styles.convRow,
                              isConvActive && styles.convRowActive
                            ]}
                            onPress={() =>
                              onSelectConversation(p.id, c.id, c.title)
                            }
                            activeOpacity={0.7}
                          >
                            <View
                              style={[
                                styles.convDot,
                                {
                                  backgroundColor:
                                    c.status === 'thinking'
                                      ? colors.warn
                                      : c.status === 'awaiting-user'
                                        ? colors.accent
                                        : c.status === 'ended'
                                          ? colors.textFaint
                                          : colors.success
                                }
                              ]}
                            />
                            <Text
                              style={[
                                styles.convTitle,
                                isConvActive && styles.convTitleActive
                              ]}
                              numberOfLines={1}
                            >
                              {c.title || `会话 ${c.id.slice(0, 6)}`}
                            </Text>
                          </TouchableOpacity>
                        )
                      })
                    )}
                  </View>
                )}
              </View>
            )
          })
        )}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity onPress={onOpenSettings} style={styles.footerBtn}>
          <Text style={styles.footerBtnText}>⚙ 设置</Text>
        </TouchableOpacity>
        {versionLabel ? (
          <Text style={styles.versionLabel}>{versionLabel}</Text>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    width: 256,
    backgroundColor: colors.bgElevated,
    borderRightWidth: 1,
    borderRightColor: colors.borderSoft,
    flexDirection: 'column'
  },
  headerSection: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm
  },
  headerTitle: {
    color: colors.textFaint,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    fontWeight: '600'
  },
  filter: {
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
    gap: 6
  },
  search: {
    backgroundColor: colors.bgInput,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    color: colors.text,
    fontSize: 12,
    borderWidth: 1,
    borderColor: colors.borderSoft
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.borderSoft
  },
  chipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent
  },
  chipText: { color: colors.textMuted, fontSize: 10.5 },
  chipTextActive: { color: colors.bg, fontWeight: '600' },
  list: { paddingVertical: 2, paddingHorizontal: 4 },
  empty: {
    color: colors.textFaint,
    textAlign: 'center',
    paddingVertical: spacing.lg,
    fontSize: 11
  },
  projectGroup: { marginBottom: 1 },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm
  },
  projectRowActive: {
    backgroundColor: colors.bgInput
  },
  caret: { color: colors.textFaint, fontSize: 9, width: 10, textAlign: 'center' },
  newConvBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm
  },
  newConvBtnText: { color: colors.textMuted, fontSize: 17, lineHeight: 19 },
  projectName: {
    color: colors.text,
    fontSize: 12.5,
    fontWeight: '500',
    letterSpacing: 0.1
  },
  projectNameActive: { color: colors.accent },
  projectPath: {
    color: colors.textFaint,
    fontSize: 9.5,
    marginTop: 1,
    fontFamily: 'monospace'
  },
  convTree: {
    paddingLeft: 18,
    paddingRight: 4,
    paddingBottom: 4,
    paddingTop: 1
  },
  convEmpty: {
    color: colors.textFaint,
    fontSize: 10,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    fontStyle: 'italic'
  },
  convRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent'
  },
  convRowActive: {
    backgroundColor: colors.bgInput,
    borderLeftColor: colors.accent
  },
  convDot: { width: 5, height: 5, borderRadius: 3 },
  convTitle: { color: colors.textMuted, fontSize: 11, flex: 1 },
  convTitleActive: { color: colors.text, fontWeight: '500' },

  footer: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  footerBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm
  },
  footerBtnText: { color: colors.textMuted, fontSize: 11 },
  versionLabel: {
    marginLeft: 'auto',
    color: colors.textFaint,
    fontSize: 9
  }
})
