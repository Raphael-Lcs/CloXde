// Renders the special "CloXde 继承上下文" system message as a distinct
// expandable card at the top of the chat — not as a normal message bubble.
// Mirrors desktop's behaviour where inheritance summary always shows
// regardless of the "hide system" toggle.

import React, { useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { colors, fontSizes, radius, spacing } from '../utils/theme'

interface Props {
  text: string
}

export function InheritanceSummaryCard({ text }: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  return (
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.head}
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.6}
      >
        <Text style={styles.icon}>↳</Text>
        <Text style={styles.title}>继承上下文</Text>
        <Text style={styles.caret}>{expanded ? '▾' : '▸'}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.body}>
          <Markdown style={mdStyles}>{text}</Markdown>
        </View>
      ) : (
        <Text style={styles.preview} numberOfLines={2}>
          {stripMarkdown(text)}
        </Text>
      )}
    </View>
  )
}

function stripMarkdown(s: string): string {
  return s
    .replace(/^>?\s*\*\*CloXde 继承上下文\*\*.*?\n/i, '')
    .replace(/\*\*/g, '')
    .replace(/#+\s+/g, '')
    .replace(/[`>]/g, '')
    .trim()
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderStyle: 'dashed'
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  icon: { color: colors.textMuted, fontSize: fontSizes.md },
  title: { flex: 1, color: colors.textMuted, fontSize: fontSizes.sm, fontWeight: '600' },
  caret: { color: colors.textFaint, fontSize: fontSizes.sm },
  preview: {
    color: colors.textFaint,
    fontSize: fontSizes.xs,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    lineHeight: 16
  },
  body: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md
  }
})

const mdStyles = StyleSheet.create({
  body: { color: colors.textMuted, fontSize: fontSizes.sm, lineHeight: 20 },
  paragraph: { marginTop: 0, marginBottom: spacing.xs, color: colors.textMuted },
  heading2: { color: colors.text, fontSize: fontSizes.md, fontWeight: '700' },
  heading3: { color: colors.text, fontSize: fontSizes.sm, fontWeight: '600' },
  bullet_list: { marginVertical: spacing.xs },
  list_item: { color: colors.textMuted },
  blockquote: {
    backgroundColor: 'transparent',
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSoft,
    paddingLeft: spacing.sm
  }
})
