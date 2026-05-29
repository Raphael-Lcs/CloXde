// Pair screen — first thing the user sees if no connection is stored.
// We support two flows:
//   1. Manual entry: user types host:port + 6-digit PIN.
//   2. QR scan (future): the desktop shows a QR encoding cloxde://pair?host=...&pin=...
//
// On success we persist the token in AsyncStorage and hand off to the main
// stack.

import React, { useState } from 'react'
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { pair, ping } from '../api/client'
import { useConnection } from '../store/connection'
import { colors, fontSizes, radius, spacing } from '../utils/theme'

export default function PairScreen(): React.ReactElement {
  const setConn = useConnection((s) => s.setConn)

  const [host, setHost] = useState('192.168.')
  const [port, setPort] = useState('7878')
  const [pin, setPin] = useState('')
  const [label, setLabel] = useState('小米平板')
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string>('')

  async function handlePair(): Promise<void> {
    if (!host.trim() || !port.trim()) {
      Alert.alert('请输入桌面端 IP 和端口')
      return
    }
    if (pin.length < 4) {
      Alert.alert('请输入桌面端显示的配对 PIN')
      return
    }
    const baseUrl = `http://${host.trim()}:${port.trim()}`
    setBusy(true)
    setStatusMsg('正在测试连接…')
    const probe = await ping(baseUrl)
    if (!probe.ok) {
      setBusy(false)
      setStatusMsg('')
      Alert.alert('连不上桌面端', probe.error)
      return
    }
    setStatusMsg('正在配对…')
    const pres = await pair(baseUrl, pin.trim(), label.trim() || 'tablet')
    if (!pres.ok) {
      setBusy(false)
      setStatusMsg('')
      Alert.alert('配对失败', pres.error)
      return
    }
    setStatusMsg('已配对 ✔')
    await setConn({
      baseUrl,
      token: pres.data.token,
      label: pres.data.label,
      lastSeenAt: Date.now()
    })
    setBusy(false)
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>连接 CloXde 桌面端</Text>
          <Text style={styles.subtitle}>
            打开桌面端 → 设置 → 平板互联，能看到本机 IP 和 6 位 PIN。把它们填到下面：
          </Text>

          <FormField label="桌面端 IP">
            <TextInput
              value={host}
              onChangeText={setHost}
              placeholder="例如 192.168.1.10"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              style={styles.input}
            />
          </FormField>

          <FormField label="端口">
            <TextInput
              value={port}
              onChangeText={setPort}
              placeholder="7878"
              placeholderTextColor={colors.textFaint}
              keyboardType="number-pad"
              style={styles.input}
            />
          </FormField>

          <FormField label="配对 PIN（6 位数字）">
            <TextInput
              value={pin}
              onChangeText={setPin}
              placeholder="123456"
              placeholderTextColor={colors.textFaint}
              keyboardType="number-pad"
              maxLength={6}
              style={[styles.input, styles.pinInput]}
            />
          </FormField>

          <FormField label="设备名（在桌面端识别用）">
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="小米平板"
              placeholderTextColor={colors.textFaint}
              style={styles.input}
            />
          </FormField>

          <TouchableOpacity
            style={[styles.btn, busy && styles.btnDisabled]}
            onPress={handlePair}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <Text style={styles.btnText}>配对并连接</Text>
            )}
          </TouchableOpacity>

          {statusMsg ? <Text style={styles.statusMsg}>{statusMsg}</Text> : null}

          <Text style={styles.hint}>
            提示：平板和电脑必须在同一个 WiFi 下；防火墙需放行该端口。
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

function FormField({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.xl, gap: spacing.md },
  title: {
    fontSize: fontSizes.xxl,
    color: colors.text,
    fontWeight: '700',
    marginTop: spacing.lg
  },
  subtitle: {
    fontSize: fontSizes.sm,
    color: colors.textMuted,
    marginBottom: spacing.lg,
    lineHeight: 20
  },
  field: { gap: spacing.xs },
  fieldLabel: { color: colors.textMuted, fontSize: fontSizes.sm },
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
  pinInput: {
    fontSize: fontSizes.xl,
    letterSpacing: 8,
    textAlign: 'center'
  },
  btn: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.lg
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: fontSizes.md, fontWeight: '600' },
  statusMsg: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    textAlign: 'center',
    marginTop: spacing.sm
  },
  hint: {
    color: colors.textFaint,
    fontSize: fontSizes.xs,
    marginTop: spacing.xl,
    lineHeight: 16
  }
})
