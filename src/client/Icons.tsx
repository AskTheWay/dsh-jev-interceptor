import type { CSSProperties } from 'react'

const paths = {
  bolt: 'm13 2-8 12h6l-1 8 9-12h-6l1-8Z',
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  log: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  sliders: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M9 3l-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3Z',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6.1 7a7 7 0 0 1 11.6-2L20 8 M4 16l2.3 3A7 7 0 0 0 18 17',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  chevron: 'm9 5 7 7-7 7',
  search: 'M21 21l-5-5 M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z',
  download: 'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',
  shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Z m-4 9 3 3 5-6',
  clock: 'M12 8v4l3 2 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  check: 'm5 12 4 4L19 6',
  pause: 'M9 4v16 M15 4v16',
  power: 'M12 2v10 M6 5a9 9 0 1 0 12 0',
  activity: 'M2 12h4l3-8 6 16 3-8h4',
  info: 'M12 11v6 M12 7h.01 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
} as const

export type IconName = keyof typeof paths

export function Icon({
  name,
  size = 16,
  style,
}: {
  name: IconName
  size?: number
  style?: CSSProperties
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: 'none', ...style }}
    >
      <path d={paths[name]} />
    </svg>
  )
}
