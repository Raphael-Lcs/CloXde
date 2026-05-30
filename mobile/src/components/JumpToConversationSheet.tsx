// Jump-to-conversation modal — the tablet equivalent of desktop's Ctrl-K
// command palette. The pad has no keyboard shortcut, so it's opened from a
// header button. Searches across ALL projects' conversations (from the shared
// workspace store) and jumps in place on select.

import React, { useMemo, useState } from 'react'
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Pressable
} from 'react-native'
import { useWorkspace } from '../store/workspace'
import type { ConversationStatus } from '../types'
import { colors, radius, spacing } from '../utils/theme'

interface Props {
  open: boolean
  onClose: () => void
  onSelect: (projectId: string, conversationId: string, title?: string) => void
}

function statusDot(s: ConversationStatus): string {
  switch (s) {
    case 'thinking': return colors.warn
    case 'awaiting-user': return colors.accent
    case 'ended': return colors.textFaint
    default: return colors.success
  }
}

export function JumpToConversationSheet({ open, onClose, onSelect }: Props): React.ReactElement {
  const projects = useWorkspace((s) => s.projects)
  const convsByProject = useWorkspace((s) => s.convsByProject)
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const results = useMemo(() => {
    const out: Array<{ projectId: string; projectName: string; convId: string; title: string; status: ConversationStatus }> = []
    for (const p of projects) {
      for (const c of convsByProject[p.id] ?? []) {
        if (c.archivedAt) continue
        const title = c.title || `会话 ${c.id.slice(0, 6)}`
        if (q && !title.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) continue
        out.push({ projectId: p.id, projectName: p.name, convId: c.id, title, status: c.status })
      }
    }
    return out.slice(0, 50)
  }, [projects, convsByProject, q])

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <TextInput
            style={styles.search}
            placeholder="跳转到会话…"
            placeholderTextColor={colors.textFaint}
            value={query}
            onChangeText={setQuery}
            autoFocus
          />
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {results.length === 0 ? (
              <Text style={styles.empty}>无匹配会话</Text>
            ) : (
              results.map((r) => (
                <TouchableOpacity
                  key={r.convId}
                  style={styles.row}
                  onPress={() => {
                    onSelect(r.projectId, r.convId, r.title)
                    onClose()
                  }}
                  activeOpacity={0.6}
                >
                  <View style={[styles.dot, { backgroundColor: statusDot(r.status) }]} />
                  <Text style={styles.rowTitle} numberOfLines={1}>{r.title}</Text>
                  <Text style={styles.rowProject} numberOfLines={1}>{r.projectName}</Text>
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    paddingTop: 120
  },
  sheet: {
    width: '90%',
    maxWidth: 560,
    maxHeight: '70%',
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden'
  },
  search: {
    backgroundColor: colors.bgInput,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft
  },
  list: { maxHeight: 420 },
  empty: { color: colors.textFaint, textAlign: 'center', padding: spacing.xl, fontSize: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  rowTitle: { color: colors.text, fontSize: 13, flex: 1 },
  rowProject: { color: colors.textFaint, fontSize: 11, marginLeft: 'auto' }
})
