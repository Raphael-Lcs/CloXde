// Settings — connection info + reset/unpair option.

import React from 'react'
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useConnection } from '../store/connection'
import { colors, fontSizes, radius, spacing } from '../utils/theme'
import type { RootStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Settings'>

export default function SettingsScreen(): React.ReactElement {
  const nav = useNavigation<Nav>()
  const conn = useConnection((s) => s.conn)
  const wsConnected = useConnection((s) => s.wsConnected)
  const clear = useConnection((s) => s.clear)

  function handleUnpair(): void {
    Alert.alert(
      '解除配对',
      '解除后需要重新输入 PIN 才能再次连接。这台设备会从桌面端的已配对列表中移除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '解除',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await clear()
            })()
          }
        }
      ]
    )
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => nav.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={styles.title}>设置</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Section title="桌面端连接">
          <Row label="服务地址">
            <Text style={styles.value}>{conn?.baseUrl ?? '未连接'}</Text>
          </Row>
          <Row label="设备名">
            <Text style={styles.value}>{conn?.label ?? '-'}</Text>
          </Row>
          <Row label="实时通道">
            <Text
              style={[
                styles.value,
                { color: wsConnected ? colors.success : colors.warn }
              ]}
            >
              {wsConnected ? '已连接' : '断开'}
            </Text>
          </Row>
        </Section>

        <Section title="账户">
          <TouchableOpacity onPress={handleUnpair} style={styles.dangerBtn}>
            <Text style={styles.dangerBtnText}>解除配对</Text>
          </TouchableOpacity>
        </Section>

        <Section title="关于">
          <Text style={styles.about}>
            CloXde Mobile · 局域网原生客户端{'\n'}
            连接桌面端的 ACP 协作环境，跟 PM / 架构师 / 执行者协作完成任务。
          </Text>
        </Section>
      </ScrollView>
    </SafeAreaView>
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
      <View style={styles.sectionBody}>{children}</View>
    </View>
  )
}

function Row({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.md
  },
  backBtn: { padding: spacing.sm },
  backText: { color: colors.accent, fontSize: fontSizes.md },
  title: { color: colors.text, fontSize: fontSizes.xl, fontWeight: '700' },
  body: { padding: spacing.lg, gap: spacing.lg },
  section: { gap: spacing.sm },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    textTransform: 'uppercase',
    letterSpacing: 1,
    paddingHorizontal: spacing.sm
  },
  sectionBody: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    padding: spacing.md
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm
  },
  rowLabel: { color: colors.textMuted, fontSize: fontSizes.sm },
  value: { color: colors.text, fontSize: fontSizes.sm, fontFamily: 'monospace' },
  dangerBtn: {
    paddingVertical: spacing.md,
    alignItems: 'center'
  },
  dangerBtnText: { color: colors.danger, fontSize: fontSizes.md },
  about: { color: colors.textMuted, fontSize: fontSizes.sm, lineHeight: 22 }
})
