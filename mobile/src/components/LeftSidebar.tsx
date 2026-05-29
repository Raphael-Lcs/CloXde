// Left rail of the Chat workspace — mirrors desktop's Sidebar.tsx layout:
//   • 项目 header + 新建项目 button (placeholder — wired in Phase 2)
//   • One row per project, expandable → conversation list
//   • Active project + active conv visually highlighted
//   • Footer: 设置 button, version label
//
// Loads all projects + per-project active conversations on mount and
// listens to WS for live updates so it stays in sync while the user works.
// Tapping a conversation calls onSelectConversation which routes the
// current ChatScreen to that conv (without growing the back stack).

import React, { useCallback, useEffect, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator
} from 'react-native'
import {
  projects as projectsApi,
  conversations as convsApi
} from '../api/client'
import type { Conversation, Project } from '../types'
import { useWsEvents } from '../hooks/useWsEvents'
import { colors, fontSizes, radius, spacing } from '../utils/theme'

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

export function LeftSidebar({
  activeProjectId,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onOpenSettings,
  versionLabel = ''
}: Props): React.ReactElement {
  const [projects, setProjects] = useState<Project[]>([])
  const [convsByProject, setConvsByProject] = useState<Record<string, Conversation[]>>({})
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const loadProjects = useCallback(async () => {
    const r = await projectsApi.list()
    if (r.ok) setProjects(r.data)
  }, [])

  const loadConvsForProject = useCallback(async (pid: string) => {
    const r = await convsApi.listByProject(pid)
    if (r.ok) {
      setConvsByProject((curr) => ({
        ...curr,
        [pid]: [...r.data].sort((a, b) => b.createdAt - a.createdAt)
      }))
    }
  }, [])

  // Initial load.
  useEffect(() => {
    void (async () => {
      setLoading(true)
      await loadProjects()
      setLoading(false)
    })()
  }, [loadProjects])

  // When projects list changes, ensure we have convs loaded for each.
  useEffect(() => {
    for (const p of projects) {
      if (!convsByProject[p.id]) void loadConvsForProject(p.id)
    }
  }, [projects, convsByProject, loadConvsForProject])

  // Auto-expand the project containing the active conv.
  useEffect(() => {
    if (!activeProjectId) return
    setCollapsed((c) => {
      const next = new Set(c)
      next.delete(activeProjectId)
      return next
    })
  }, [activeProjectId])

  // Live refresh: any conv:updated event → refetch that project's convs.
  useWsEvents((e) => {
    if (e.type === 'conversation:updated') {
      void loadConvsForProject(e.payload.projectId)
    }
  })

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

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
        {loading ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.lg }} />
        ) : projects.length === 0 ? (
          <Text style={styles.empty}>暂无项目</Text>
        ) : (
          projects.map((p) => {
            const isActive = p.id === activeProjectId
            const isCollapsed = collapsed.has(p.id) && !isActive
            const convs = convsByProject[p.id] ?? []
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
