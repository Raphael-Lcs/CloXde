/**
 * CloXde brandmark.
 *
 * Two overlapping circles, Venn-style. Blue = architect (Claude),
 * green = executor (Codex). Their overlap is the A2A handoff — where the
 * two agents meet in conversation. Geometric, calm, instantly readable at
 * 18px and still recognisable at 256px.
 */
export function Logo({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="CloXde"
    >
      <rect width="32" height="32" rx="7" fill="#19191c" />
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="6.5"
        fill="none"
        stroke="#34343c"
        strokeWidth="1"
      />
      {/* The overlap reads as teal because both circles are translucent — no
          dedicated "intersection" shape needed. */}
      <circle cx="12.5" cy="16" r="7.5" fill="#7aa2ff" fillOpacity="0.78" />
      <circle cx="19.5" cy="16" r="7.5" fill="#8be7c5" fillOpacity="0.78" />
    </svg>
  )
}
