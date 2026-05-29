// Right-rail team activity — architect + executor messages from a 3-agent
// conversation. The PM↔user log stays clean in the center; this panel is
// where you peek at what the engineering team is doing in real time.

import React, { useEffect, useMemo, useRef } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity
} from 'react-native'
import type { ConversationView, Message } from '../types'
import { MessageBubble } from './MessageBubble'
import { colors, fontSizes, spacing } from '../utils/theme'

interface Props {
  view: ConversationView
  onClose: () => void
}

export function TeamPanel({ view, onClose }: Props): React.ReactElement {
  const scrollerRef = useRef<ScrollView | null>(null)

  const teamMessages = useMemo<Message[]>(
    () =>
      view.messages.filter(
        (m) =>
          m.role !== 'system' &&
          (m.side === 'architect' || m.side === 'executor') &&
          !(m.role === 'user' && m.forwardedFromMessageId)
      ),
    [view.messages]
  )

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const t = setTimeout(
      () => scrollerRef.current?.scrollToEnd({ animated: true }),
      80
    )
    return () => clearTimeout(t)
  }, [teamMessages.length])

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title}>工作组活动</Text>
          <View style={styles.subRow}>
            <Text style={[styles.subLabel, { color: colors.architect }]}>架构师</Text>
            <Text style={styles.subSep}>↔</Text>
            <Text style={[styles.subLabel, { color: colors.executor }]}>执行者</Text>
          </View>
        </View>
        <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
          <Text style={styles.closeText}>×</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollerRef}
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
      >
        {teamMessages.length === 0 ? (
          <Text style={styles.empty}>工作组暂无活动</Text>
        ) : (
          teamMessages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    width: 420,
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
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2
  },
  subLabel: { fontSize: 11, fontWeight: '500' },
  subSep: { color: colors.textFaint, fontSize: 11 },
  closeBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center'
  },
  closeText: { color: colors.textMuted, fontSize: fontSizes.lg },
  body: { flex: 1 },
  bodyContent: { paddingVertical: spacing.md, paddingBottom: spacing.xxl },
  empty: {
    color: colors.textFaint,
    textAlign: 'center',
    fontSize: fontSizes.sm,
    paddingVertical: spacing.xxl
  }
})
