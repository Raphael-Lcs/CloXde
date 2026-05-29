// Bottom-sheet that surfaces the team's internal work (architect + executor
// messages). Main chat stream hides those in 3-agent mode for a clean
// PM↔user log; this sheet is the "peek" entry point — equivalent to the
// desktop TeamPanel right-drawer.

import React, { useMemo, useRef, useEffect } from 'react'
import {
  Modal,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { ConversationView, Message } from '../types'
import { MessageBubble } from './MessageBubble'
import { colors, fontSizes, radius, spacing } from '../utils/theme'

interface Props {
  view: ConversationView | null
  open: boolean
  onClose: () => void
}

export function TeamPeekSheet({ view, open, onClose }: Props): React.ReactElement | null {
  const scrollerRef = useRef<ScrollView | null>(null)

  const teamMessages = useMemo<Message[]>(() => {
    if (!view) return []
    return view.messages.filter(
      (m) =>
        m.role !== 'system' &&
        (m.side === 'architect' || m.side === 'executor') &&
        // Hide internal routing markers — only real assistant turns.
        !(m.role === 'user' && m.forwardedFromMessageId)
    )
  }, [view])

  // Pin-to-bottom on open / new messages.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => scrollerRef.current?.scrollToEnd({ animated: false }), 80)
    return () => clearTimeout(t)
  }, [open, teamMessages.length])

  if (!view) return null

  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback onPress={() => undefined}>
            <SafeAreaView edges={['bottom']} style={styles.sheet}>
              <View style={styles.handle} />
              <View style={styles.head}>
                <View style={styles.headTitleRow}>
                  <Text style={styles.title}>工作组活动</Text>
                  <View style={styles.headSub}>
                    <Text style={[styles.headSubLabel, { color: colors.architect }]}>架构师</Text>
                    <Text style={styles.headSubSep}>↔</Text>
                    <Text style={[styles.headSubLabel, { color: colors.executor }]}>执行者</Text>
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
            </SafeAreaView>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end'
  },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    height: '85%'
  },
  handle: {
    width: 44,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xs
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft
  },
  headTitleRow: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: fontSizes.lg, fontWeight: '600' },
  headSub: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headSubLabel: { fontSize: fontSizes.xs, fontWeight: '500' },
  headSubSep: { color: colors.textFaint, fontSize: fontSizes.xs },
  closeBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  closeText: { color: colors.textMuted, fontSize: 26, lineHeight: 28 },
  body: { flex: 1 },
  bodyContent: { paddingVertical: spacing.md, paddingBottom: spacing.xxl },
  empty: {
    color: colors.textFaint,
    textAlign: 'center',
    fontSize: fontSizes.sm,
    paddingVertical: spacing.xxl
  }
})
