// Right-rail file tree — mirrors desktop's FileExplorer.tsx in a panel layout.
//
// Single-column tree, lazy-load directories, fs-watch driven refresh via WS.
// Tapping a folder expands/collapses; tapping a file opens an in-app preview
// sheet (FilePreviewSheet). We deliberately do NOT call shell.openPath any
// more — the desktop server is shared, and yanking a window onto someone
// else's screen because the tablet user tapped a file is a UX disaster.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView
} from 'react-native'
import { fs as fsApi } from '../api/client'
import type { DirEntry, Project } from '../types'
import { useWsEvents } from '../hooks/useWsEvents'
import { colors, fontSizes, spacing } from '../utils/theme'
import { FilePreviewSheet } from './FilePreviewSheet'

interface Props {
  project: Project
  onClose: () => void
}

interface NodeState {
  entries: DirEntry[]
  expanded: boolean
  loaded: boolean
  loading: boolean
  error?: string
}

export function FileExplorerPanel({ project, onClose }: Props): React.ReactElement {
  const [nodes, setNodes] = useState<Record<string, NodeState>>({
    '': { entries: [], expanded: true, loaded: false, loading: false }
  })
  const [tick, setTick] = useState(0)
  /** Path of the file currently shown in the preview sheet, or null when
   *  the sheet is hidden. Sheet renders only when this is non-null. */
  const [previewPath, setPreviewPath] = useState<string | null>(null)

  const loadPath = useCallback(
    async (relPath: string): Promise<void> => {
      setNodes((s) => ({
        ...s,
        [relPath]: {
          ...(s[relPath] ?? { entries: [], expanded: true, loaded: false, loading: false }),
          loading: true
        }
      }))
      const res = await fsApi.listDir(project.id, relPath)
      setNodes((s) => {
        const prev = s[relPath] ?? {
          entries: [],
          expanded: true,
          loaded: false,
          loading: false
        }
        if (!res.ok) {
          return {
            ...s,
            [relPath]: { ...prev, loading: false, loaded: true, error: res.error }
          }
        }
        return {
          ...s,
          [relPath]: {
            entries: res.data,
            expanded: prev.expanded,
            loaded: true,
            loading: false
          }
        }
      })
    },
    [project.id]
  )

  // Initial load whenever project changes.
  useEffect(() => {
    setNodes({ '': { entries: [], expanded: true, loaded: false, loading: false } })
    void loadPath('')
  }, [project.id, loadPath])

  // Listen for fs:changed to refresh all loaded nodes.
  useWsEvents((e) => {
    if (e.type === 'fs:changed' && e.payload.projectId === project.id) {
      setTick((t) => t + 1)
    }
  })

  useEffect(() => {
    if (tick === 0) return
    setNodes((curr) => {
      for (const [path, st] of Object.entries(curr)) {
        if (st.loaded || st.expanded) void loadPath(path)
      }
      return curr
    })
  }, [tick, loadPath])

  const toggle = useCallback(
    (path: string): void => {
      setNodes((s) => {
        const prev = s[path] ?? {
          entries: [],
          expanded: false,
          loaded: false,
          loading: false
        }
        return { ...s, [path]: { ...prev, expanded: !prev.expanded } }
      })
      const st = nodes[path]
      if (!st || (!st.loaded && !st.loading)) void loadPath(path)
    },
    [nodes, loadPath]
  )

  const openFile = useCallback((path: string): void => {
    setPreviewPath(path)
  }, [])

  const rootState = nodes['']

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title}>项目文件</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{project.rootDir}</Text>
        </View>
        <TouchableOpacity onPress={() => void loadPath('')} style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>↻</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
          <Text style={styles.iconBtnText}>×</Text>
        </TouchableOpacity>
      </View>
      <ScrollView style={styles.tree}>
        {!rootState?.loaded && rootState?.loading ? (
          <Text style={styles.hint}>加载中…</Text>
        ) : null}
        {rootState?.error ? (
          <Text style={styles.error}>读取失败：{rootState.error}</Text>
        ) : null}
        {rootState?.loaded && rootState.entries.length === 0 ? (
          <Text style={styles.hint}>（空目录）</Text>
        ) : null}
        {rootState?.loaded ? (
          <TreeChildren
            entries={rootState.entries}
            nodes={nodes}
            depth={0}
            onToggle={toggle}
            onOpenFile={openFile}
          />
        ) : null}
      </ScrollView>
      <FilePreviewSheet
        projectId={project.id}
        path={previewPath}
        open={previewPath !== null}
        onClose={() => setPreviewPath(null)}
      />
    </View>
  )
}

function TreeChildren({
  entries,
  nodes,
  depth,
  onToggle,
  onOpenFile
}: {
  entries: DirEntry[]
  nodes: Record<string, NodeState>
  depth: number
  onToggle: (p: string) => void
  onOpenFile: (p: string) => void
}): React.ReactElement {
  return (
    <View>
      {entries.map((e) => (
        <TreeNode
          key={e.path}
          entry={e}
          nodes={nodes}
          depth={depth}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      ))}
    </View>
  )
}

function TreeNode({
  entry,
  nodes,
  depth,
  onToggle,
  onOpenFile
}: {
  entry: DirEntry
  nodes: Record<string, NodeState>
  depth: number
  onToggle: (p: string) => void
  onOpenFile: (p: string) => void
}): React.ReactElement {
  const childState = nodes[entry.path]
  const isDir = entry.kind === 'directory'
  const expanded = !!childState?.expanded

  const sizeText = useMemo(() => {
    if (entry.kind !== 'file' || entry.size === undefined) return ''
    const s = entry.size
    if (s < 1024) return `${s} B`
    if (s < 1024 * 1024) return `${(s / 1024).toFixed(1)} KB`
    return `${(s / 1024 / 1024).toFixed(1)} MB`
  }, [entry])

  return (
    <View>
      <TouchableOpacity
        style={[styles.row, { paddingLeft: 8 + depth * 14 }]}
        onPress={() => (isDir ? onToggle(entry.path) : onOpenFile(entry.path))}
        activeOpacity={0.6}
      >
        <Text style={styles.icon}>{isDir ? (expanded ? '▾' : '▸') : '·'}</Text>
        <Text
          style={[styles.name, isDir ? styles.nameDir : styles.nameFile]}
          numberOfLines={1}
        >
          {entry.name}
        </Text>
        {!isDir ? <Text style={styles.size}>{sizeText}</Text> : null}
      </TouchableOpacity>
      {isDir && expanded && childState?.loaded ? (
        <TreeChildren
          entries={childState.entries}
          nodes={nodes}
          depth={depth + 1}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      ) : null}
      {isDir && expanded && childState?.loading && !childState?.loaded ? (
        <Text style={[styles.hint, { paddingLeft: 8 + (depth + 1) * 14 }]}>
          加载中…
        </Text>
      ) : null}
    </View>
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
  subtitle: {
    color: colors.textFaint,
    fontSize: 10,
    marginTop: 2,
    fontFamily: 'monospace'
  },
  iconBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconBtnText: { color: colors.textMuted, fontSize: fontSizes.lg },
  tree: { flex: 1 },
  hint: { color: colors.textFaint, fontSize: 11, padding: spacing.md },
  error: { color: colors.danger, fontSize: 11, padding: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4
  },
  icon: { color: colors.textFaint, fontSize: 11, width: 12 },
  name: { flex: 1, fontSize: 12 },
  nameDir: { color: colors.accent },
  nameFile: { color: colors.text },
  size: { color: colors.textFaint, fontSize: 10, marginLeft: spacing.sm }
})
