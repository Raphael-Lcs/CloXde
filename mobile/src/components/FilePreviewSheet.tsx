// In-app file preview — replaces the previous "tap file → desktop opens it"
// behaviour, which was a UX disaster on a multi-user setup (the user's tap
// would yank a window open on whoever was sitting in front of the desktop).
//
// Behaviour:
//   • Text files → render in a monospace ScrollView, with a header strip
//     showing path + size + truncation note.
//   • Image files → render via base64 data URI.
//   • Binary / oversized files → friendly "无法预览" with size + an option
//     to ask the desktop to open it (long-press style escalation).
//
// We deliberately don't add the "open on desktop" option by default — the
// whole point is to keep the tablet self-contained. Users who need that
// can rely on the file path which is shown in the header.

import React, { useEffect, useState } from 'react'
import {
  Modal,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  Image,
  ActivityIndicator
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { fs as fsApi } from '../api/client'
import type { FilePreview } from '../types'
import { colors, fontSizes, radius, spacing } from '../utils/theme'

interface Props {
  projectId: string | null
  /** Path relative to project root, or null when the sheet is hidden. */
  path: string | null
  open: boolean
  onClose: () => void
}

export function FilePreviewSheet({
  projectId,
  path,
  open,
  onClose
}: Props): React.ReactElement | null {
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [error, setError] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(false)

  useEffect(() => {
    if (!open || !projectId || !path) {
      setPreview(null)
      setError('')
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    setPreview(null)
    void fsApi.readPreview(projectId, path).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setPreview(res.data)
    })
    return () => {
      cancelled = true
    }
  }, [open, projectId, path])

  if (!open) return null

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback onPress={() => undefined}>
            <SafeAreaView edges={['bottom']} style={styles.sheet}>
              <View style={styles.handle} />
              <View style={styles.head}>
                <View style={styles.headInfo}>
                  <Text style={styles.title} numberOfLines={1}>
                    {path ?? '文件'}
                  </Text>
                  {preview ? (
                    <Text style={styles.sub}>
                      {humanBytes(preview.size)}
                      {preview.truncated && preview.truncatedAt
                        ? `  ·  仅前 ${humanBytes(preview.truncatedAt)}`
                        : ''}
                    </Text>
                  ) : null}
                </View>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Text style={styles.closeText}>×</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.body}>
                {loading ? (
                  <View style={styles.center}>
                    <ActivityIndicator color={colors.accent} />
                  </View>
                ) : error ? (
                  <Text style={styles.errorText}>读取失败：{error}</Text>
                ) : preview?.kind === 'text' && preview.text !== undefined ? (
                  <ScrollView
                    style={styles.codeScroller}
                    contentContainerStyle={styles.codeContent}
                  >
                    <Text style={styles.code} selectable>
                      {preview.text}
                      {preview.truncated ? '\n\n— 已截断 —' : ''}
                    </Text>
                  </ScrollView>
                ) : preview?.kind === 'image' && preview.image ? (
                  <ScrollView
                    style={styles.imageScroller}
                    contentContainerStyle={styles.imageContent}
                    maximumZoomScale={4}
                    minimumZoomScale={1}
                  >
                    <Image
                      source={{
                        uri: `data:${preview.image.mimeType};base64,${preview.image.data}`
                      }}
                      style={styles.image}
                      resizeMode="contain"
                    />
                  </ScrollView>
                ) : preview?.kind === 'binary' ? (
                  <View style={styles.center}>
                    <Text style={styles.binaryText}>二进制文件，无法在平板预览。</Text>
                    <Text style={styles.binarySub}>{humanBytes(preview.size)}</Text>
                  </View>
                ) : null}
              </View>
            </SafeAreaView>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  )
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
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
  headInfo: { flex: 1, gap: 2 },
  title: {
    color: colors.text,
    fontSize: fontSizes.md,
    fontFamily: 'monospace'
  },
  sub: { color: colors.textFaint, fontSize: 11 },
  closeBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center'
  },
  closeText: { color: colors.textMuted, fontSize: 26, lineHeight: 28 },
  body: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: 6
  },
  errorText: { color: colors.danger, padding: spacing.lg, fontSize: 12 },
  codeScroller: { flex: 1 },
  codeContent: { padding: spacing.md },
  code: {
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 17
  },
  imageScroller: { flex: 1 },
  imageContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  binaryText: { color: colors.text, fontSize: fontSizes.sm },
  binarySub: { color: colors.textFaint, fontSize: 11 }
})
