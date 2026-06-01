const ASSISTANT_SOUND_KEY = 'cloxde.assistant.sound'

let audioContext: AudioContext | null = null
let lastPlayedAt = 0

export function isAssistantSoundEnabled(): boolean {
  try {
    const value = localStorage.getItem(ASSISTANT_SOUND_KEY)
    return value !== '0' && value !== 'false'
  } catch {
    return true
  }
}

export function setAssistantSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(ASSISTANT_SOUND_KEY, on ? '1' : '0')
  } catch {
    /* storage disabled/full; setting is best-effort */
  }
}

export function playAssistantChime(): void {
  try {
    const playedAt = Date.now()
    if (playedAt - lastPlayedAt < 400) return
    lastPlayedAt = playedAt

    const AudioContextCtor =
      window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return

    if (!audioContext) audioContext = new AudioContextCtor()
    const ctx = audioContext
    if (ctx.state === 'suspended') void ctx.resume()

    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(440, now)
    gain.gain.setValueAtTime(0.15, now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.12)
  } catch {
    /* audio is optional and must never affect assistant flow */
  }
}
