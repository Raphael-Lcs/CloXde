// Dark theme tuned for CloXde — palette mirrors the desktop app's CSS
// variables (src/renderer/src/styles.css :root) hex-for-hex so the tablet
// and desktop read as one product. Generous spacing for a tablet-first layout.

export const colors = {
  bg: '#19191c', // --bg (main / titlebar)
  bgElevated: '#1f1f23', // --bg-elev (sidebar / composer / headers)
  bgInput: '#2a2a30', // --bg-elev-2 (hover / active / input)
  border: '#2d2d33', // --border
  borderSoft: '#232328', // --border-soft
  text: '#ececef', // --fg
  textMuted: '#8a8a91', // --fg-dim
  textFaint: '#5e5e66', // --fg-muted
  accent: '#7aa2ff', // --accent
  accentSoft: '#7aa2ff22',
  accentWarm: '#f4b063', // --accent-warm (awaiting / paused / PM)
  accentCool: '#8be7c5', // --accent-cool (code / executor)
  accentHermes: '#b18cf5', // --accent-hermes
  success: '#4ade80', // --ok
  warn: '#f4b063', // desktop reuses --accent-warm for awaiting/paused/streaming
  danger: '#ff6b6b', // --danger
  // Role tints — match desktop exactly: PM = warm, architect = accent (blue),
  // executor = cool (mint). Keep in sync with desktop ConversationStream.
  pm: '#f4b063',
  architect: '#7aa2ff',
  executor: '#8be7c5'
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
}

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20
}

export const fontSizes = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 24
}
