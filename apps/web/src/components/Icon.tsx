import type { ReactElement } from 'react';

/**
 * The icon set. Line icons at 1.75 stroke, sized to the current font so they
 * sit on the text baseline inside buttons.
 */

const PATHS: Record<string, ReactElement> = {
  'chevron-left': <path d="M13 4 7 10l6 6" />,
  'chevron-right': <path d="M7 4l6 6-6 6" />,
  plus: <path d="M10 4v12M4 10h12" />,
  check: <path d="M4 10.5 8 14.5 16 5.5" />,
  close: <path d="M5 5l10 10M15 5 5 15" />,
  trash: <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />,
  sparkle: <path d="M10 3l1.8 4.2L16 9l-4.2 1.8L10 15l-1.8-4.2L4 9l4.2-1.8z" />,
  sync: (
    <>
      <path d="M16 10a6 6 0 1 1-1.8-4.3" />
      <path d="M16 3v3.5h-3.5" />
    </>
  ),
  alert: <path d="M10 3.5 17 16H3zM10 8v3.5M10 13.6v.1" />,
  calendar: (
    <>
      <rect x="3" y="4.5" width="14" height="12" rx="2" />
      <path d="M3 8.5h14M7 3v3M13 3v3" />
    </>
  ),
  pin: <path d="M8 3h4l-.5 4 2.5 2.5H5.5L8 7z M10 9.5V17" />,
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4.2l2.6 1.6" />
    </>
  ),
  flag: <path d="M5 17V3.8h9l-2 3 2 3H5" />,
  send: <path d="M3.5 10 17 3.5 12 17l-2.6-5.2z" />,
  sliders: <path d="M4 6h12M4 14h12M8 3.5v5M13 11.5v5" />,
  chip: (
    <>
      <rect x="6" y="6" width="8" height="8" rx="1.5" />
      <path d="M8 3v3M12 3v3M8 14v3M12 14v3M3 8h3M3 12h3M14 8h3M14 12h3" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7" />
    </>
  ),
  'panel-left': (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M8 4v12" />
    </>
  ),
  'panel-right': (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M12 4v12" />
    </>
  ),
  expand: (
    <>
      <path d="M8 3H3v5M12 3h5v5M8 17H3v-5M12 17h5v-5" />
    </>
  ),
  collapse: (
    <>
      <path d="M3 8h5V3M17 8h-5V3M3 12h5v5M17 12h-5v5" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="8.5" width="11" height="8" rx="2" />
      <path d="M7 8.5V6.5a3 3 0 0 1 6 0v2" />
    </>
  ),
  users: (
    <>
      <circle cx="8" cy="7" r="2.6" />
      <path d="M3.5 16.5c0-2.5 2-4.2 4.5-4.2s4.5 1.7 4.5 4.2" />
      <path d="M13.5 5.2a2.6 2.6 0 0 1 0 5M14.5 12.6c1.3.6 2 1.9 2 3.9" />
    </>
  ),
  'map-pin': (
    <>
      <path d="M10 17s5.5-5 5.5-9a5.5 5.5 0 1 0-11 0c0 4 5.5 9 5.5 9z" />
      <circle cx="10" cy="8" r="2" />
    </>
  ),
  link: (
    <>
      <path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1 1" />
      <path d="M11.5 8.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1" />
    </>
  ),
  text: <path d="M4 5.5h12M4 10h12M4 14.5h7" />,
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const path = PATHS[name];
  if (!path) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none' }}
    >
      {path}
    </svg>
  );
}
