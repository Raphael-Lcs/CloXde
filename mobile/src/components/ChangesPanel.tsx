// Right-rail "改动" drawer — mirrors desktop's ChangesPanel.tsx.
//
// Shows the project repo's working-tree diff (in a 3-agent run this is
// effectively "what the executor changed", since the agents' cwd IS the
// project root). Tap a file to expand its unified diff. Live-refreshes on
// the same fs:changed WS broadcast the file explorer uses.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native'
import { fs as fsApi } from '../api/client'
import type { GitChange, GitStatus, Project } from '../types'
import { useWsEvents } from '../hooks/useWsEvents'
import { colors, fontSizes, radius, spacing } from '../utils/theme'

interface Props {
  project: Project
  onClose: () => void
}

const STATUS_META: Record<GitChange['status'], { label: string; color: string }> = {
  modified: { label: 'M', color: colors.accentWarm },
  added: { label: 'A', color: colors.success },
  deleted: { label: 'D', color: colors.danger },
  renamed: { label: 'R', color: colors.accent },
  untracked: { label: 'U', color: colors.textMuted }
}

export function ChangesPanel({ project, onClose }: Props): React.ReactElement {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [openPath, setOpenPath] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    const res = await fsApi.gitStatus(project.id)
    setLoading(false)
    if (!res.ok) {
      setError(res.error)
      setStatus(null)
      return
    }
    setError(null)
    setStatus(res.data)
  }, [project.id])

  useEffect(() => {
    setOpenPath(null)
    void refresh()
  }, [project.id, refresh])

  useWsEvents((e) => {
    if (e.type === 'fs:changed' && e.payload.projectId === project.id) void refresh()
  })

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title}>改动</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {status?.isRepo
              ? `${status.changes.length} 个文件已改动`
              : status
                ? '非 git 仓库'
                : project.rootDir}
          </Text>
        </View>
        <TouchableOpacity onPress={() => void refresh()} style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>↻</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>×</Text>
        </TouchableOpacity>
      </View>
      <ScrollView style={styles.list}>
        {loading && !status ? <Text style={styles.hint}>加载中…</Text> : null}
        {error ? <Text style={styles.error}>读取失败：{error}</Text> : null}
        {status && !status.isRepo ? (
          <Text style={styles.hint}>该项目根目录不是 git 仓库，无法显示改动。</Text>
        ) : null}
        {status?.isRepo && status.changes.length === 0 ? (
          <Text style={styles.hint}>工作区干净，没有未提交的改动。</Text>
        ) : null}
        {status?.isRepo
          ? status.changes.map((c) => (
              <ChangeRow
                key={c.path}
                projectId={project.id}
                change={c}
                open={openPath === c.path}
                onToggle={() => setOpenPath((p) => (p === c.path ? null : c.path))}
              />
            ))
          : null}
      </ScrollView>
    </View>
  )
}

function ChangeRow({
  projectId,
  change,
  open,
  onToggle
}: {
  projectId: string
  change: GitChange
  open: boolean
  onToggle: () => void
}): React.ReactElement {
  const [diff, setDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || diff !== null || loading) return
    setLoading(true)
    void fsApi
      .gitDiff(projectId, change.path)
      .then((res) => {
        if (res.ok) setDiff(res.data)
        else setError(res.error)
      })
      .finally(() => setLoading(false))
  }, [open, diff, loading, projectId, change.path])

  useEffect(() => {
    if (!open) {
      setDiff(null)
      setError(null)
    }
  }, [open])

  const meta = STATUS_META[change.status]
  const name = change.path.split('/').pop() ?? change.path
  const dir = change.path.slice(0, change.path.length - name.length)

  return (
    <View style={styles.changeRow}>
      <TouchableOpacity style={styles.changeHead} onPress={onToggle} activeOpacity={0.6}>
        <Text style={styles.caret}>{open ? '▾' : '▸'}</Text>
        <View style={[styles.badge, { borderColor: meta.color }]}>
          <Text style={[styles.badgeText, { color: meta.color }]}>{meta.label}</Text>
        </View>
        <Text style={styles.changeName} numberOfLines={1}>
          {name}
        </Text>
        {dir ? (
          <Text style={styles.changeDir} numberOfLines={1}>
            {dir}
          </Text>
        ) : null}
      </TouchableOpacity>
      {open ? (
        <View style={styles.diffWrap}>
          {loading ? <Text style={styles.hint}>加载 diff…</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {diff !== null && diff.trim() === '' ? (
            <Text style={styles.hint}>（无文本 diff）</Text>
          ) : null}
          {diff && diff.trim() !== '' ? <DiffView text={diff} /> : null}
        </View>
      ) : null}
    </View>
  )
}

function DiffView({ text }: { text: string }): React.ReactElement {
  const lines = useMemo(() => text.split('\n'), [text])
  return (
    <ScrollView horizontal style={styles.diffScroll}>
      <View>
        {lines.map((line, i) => {
          let color = colors.textMuted
          let bg = 'transparent'
          if (line.startsWith('@@')) color = colors.accent
          else if (line.startsWith('+++') || line.startsWith('---')) color = colors.textFaint
          else if (line.startsWith('diff ') || line.startsWith('index ')) color = colors.textFaint
          else if (line.startsWith('+')) {
            color = colors.success
            bg = 'rgba(74, 222, 128, 0.08)'
          } else if (line.startsWith('-')) {
            color = colors.danger
            bg = 'rgba(255, 107, 107, 0.08)'
          }
          return (
            <Text key={i} style={[styles.diffLine, { color, backgroundColor: bg }]}>
              {line || ' '}
            </Text>
          )
        })}
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  root: {
    width: 380,
    backgroundColor: colors.bgElevated,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSoft,
    flexDirection: 'column'
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft
  },
  title: { color: colors.text, fontSize: fontSizes.sm, fontWeight: '600' },
  subtitle: { color: colors.textFaint, fontSize: 10, marginTop: 2 },
  iconBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  iconBtnText: { color: colors.textMuted, fontSize: fontSizes.lg },
  list: { flex: 1 },
  hint: { color: colors.textFaint, fontSize: 11, padding: spacing.md },
  error: { color: colors.danger, fontSize: 11, padding: spacing.md },
  changeRow: { borderBottomWidth: 1, borderBottomColor: colors.borderSoft },
  changeHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 7
  },
  caret: { color: colors.textFaint, fontSize: 10, width: 12, textAlign: 'center' },
  badge: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1
  },
  badgeText: { fontSize: 10, fontWeight: '700' },
  changeName: { color: colors.text, fontSize: 12, flexShrink: 1 },
  changeDir: { color: colors.textFaint, fontSize: 10, flexShrink: 1 },
  diffWrap: {
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    maxHeight: 360
  },
  diffScroll: { paddingVertical: 4 },
  diffLine: {
    fontFamily: 'monospace',
    fontSize: 10.5,
    lineHeight: 15,
    paddingHorizontal: spacing.sm
  }
})
