// Bottom-sheet to create a new conversation from the tablet — replaces the
// "请到桌面端创建" dead-end. Lets the user pick PM kind and optionally
// enter a title. Parent picker + summary preview are deliberately left for
// a later iteration (small screen, multi-step picker is awkward).

import React, { useState } from 'react'
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  ActivityIndicator,
  StyleSheet,
  Platform,
  KeyboardAvoidingView
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { AgentKind, ConversationView } from '../types'
import { conversations as convApi } from '../api/client'
import { colors, fontSizes, radius, spacing } from '../utils/theme'

interface Props {
  projectId: string
  open: boolean
  onClose: () => void
  onCreated: (view: ConversationView) => void
}

const PM_LABELS: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes'
}

const PM_NOTES: Record<AgentKind, string> = {
  claude: '推荐：稳定、协议遵守好',
  codex: '替补：跟 Claude 类似',
  hermes: '本机管家：需要权限 UI（暂时建议别选）'
}

export function NewConversationSheet({
  projectId,
  open,
  onClose,
  onCreated
}: Props): React.ReactElement {
  const [title, setTitle] = useState('')
  const [pmKind, setPmKind] = useState<AgentKind>('claude')
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  // Reset state on each fresh open.
  React.useEffect(() => {
    if (!open) return
    setTitle('')
    setPmKind('claude')
    setBusy(false)
    setErrorMsg('')
  }, [open])

  async function handleCreate(): Promise<void> {
    setBusy(true)
    setErrorMsg('')
    const r = await convApi.create({
      projectId,
      title: title.trim() || undefined,
      pmKind,
      withPm: true
    })
    setBusy(false)
    if (!r.ok) {
      setErrorMsg(r.error)
      return
    }
    onCreated(r.data)
  }

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
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={styles.sheetWrap}
            >
              <SafeAreaView edges={['bottom']} style={styles.sheet}>
                <View style={styles.handle} />
                <View style={styles.head}>
                  <Text style={styles.title}>新建协作会话</Text>
                  <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                    <Text style={styles.closeText}>×</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.body}>
                  <Section title="PM 角色">
                    <View style={styles.pmRow}>
                      {(['claude', 'codex', 'hermes'] as AgentKind[]).map((k) => (
                        <TouchableOpacity
                          key={k}
                          style={[
                            styles.pmChip,
                            pmKind === k && styles.pmChipActive
                          ]}
                          onPress={() => setPmKind(k)}
                        >
                          <Text
                            style={[
                              styles.pmChipText,
                              pmKind === k && styles.pmChipTextActive
                            ]}
                          >
                            {PM_LABELS[k]}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    <Text style={styles.hint}>{PM_NOTES[pmKind]}</Text>
                  </Section>

                  <Section title="标题（可选）">
                    <TextInput
                      value={title}
                      onChangeText={setTitle}
                      placeholder="不填会自动用 ID 占位"
                      placeholderTextColor={colors.textFaint}
                      style={styles.input}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </Section>

                  {errorMsg ? (
                    <Text style={styles.errorMsg}>{errorMsg}</Text>
                  ) : null}

                  <View style={styles.actions}>
                    <TouchableOpacity
                      onPress={onClose}
                      style={[styles.btn, styles.btnGhost]}
                      disabled={busy}
                    >
                      <Text style={styles.btnGhostText}>取消</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => void handleCreate()}
                      style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
                      disabled={busy}
                    >
                      {busy ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <Text style={styles.btnPrimaryText}>创建</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              </SafeAreaView>
            </KeyboardAvoidingView>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end'
  },
  sheetWrap: { flexShrink: 1 },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl
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
  title: { color: colors.text, fontSize: fontSizes.lg, fontWeight: '600', flex: 1 },
  closeBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  closeText: { color: colors.textMuted, fontSize: 26, lineHeight: 28 },
  body: { padding: spacing.lg, gap: spacing.lg },
  section: { gap: spacing.sm },
  sectionTitle: {
    color: colors.textFaint,
    fontSize: fontSizes.xs,
    textTransform: 'uppercase',
    letterSpacing: 1
  },
  pmRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  pmChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg
  },
  pmChipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft
  },
  pmChipText: { color: colors.textMuted, fontSize: fontSizes.sm, fontWeight: '500' },
  pmChipTextActive: { color: colors.text },
  hint: { color: colors.textFaint, fontSize: fontSizes.xs },
  input: {
    backgroundColor: colors.bgInput,
    color: colors.text,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: fontSizes.md,
    borderWidth: 1,
    borderColor: colors.border
  },
  errorMsg: { color: colors.danger, fontSize: fontSizes.sm },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-end',
    marginTop: spacing.sm
  },
  btn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    minWidth: 96,
    alignItems: 'center'
  },
  btnGhost: { backgroundColor: 'transparent' },
  btnGhostText: { color: colors.textMuted, fontSize: fontSizes.md },
  btnPrimary: { backgroundColor: colors.accent },
  btnPrimaryText: { color: '#fff', fontSize: fontSizes.md, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 }
})
