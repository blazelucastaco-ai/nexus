import type { JSX } from 'react';

// Thin-line SVG icons — sized 20x20, strokeWidth 1.5, round caps.
// Inherit currentColor so they pick up the sidebar's active-state tint.

const baseProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export function IconDashboard(): JSX.Element {
  return (
    <svg {...baseProps}>
      <title>Dashboard</title>
      <rect x="3" y="3" width="6.5" height="6.5" rx="1" />
      <rect x="10.5" y="3" width="6.5" height="4" rx="1" />
      <rect x="10.5" y="8" width="6.5" height="9" rx="1" />
      <rect x="3" y="10.5" width="6.5" height="6.5" rx="1" />
    </svg>
  );
}

export function IconConfig(): JSX.Element {
  return (
    <svg {...baseProps}>
      <title>Configure</title>
      <line x1="3" y1="6" x2="8" y2="6" />
      <line x1="12" y1="6" x2="17" y2="6" />
      <circle cx="10" cy="6" r="1.6" fill="currentColor" />
      <line x1="3" y1="14" x2="6" y2="14" />
      <line x1="10" y1="14" x2="17" y2="14" />
      <circle cx="8" cy="14" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function IconLogs(): JSX.Element {
  return (
    <svg {...baseProps}>
      <title>Logs</title>
      <line x1="4" y1="5" x2="16" y2="5" />
      <line x1="4" y1="10" x2="13" y2="10" />
      <line x1="4" y1="15" x2="11" y2="15" />
    </svg>
  );
}

export function IconChrome(): JSX.Element {
  return (
    <svg {...baseProps}>
      <title>Chrome</title>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="2.5" />
      <line x1="10" y1="7.5" x2="17" y2="7.5" />
      <line x1="8" y1="11.3" x2="4.5" y2="16.8" />
      <line x1="12" y1="11.3" x2="15.5" y2="16.8" />
    </svg>
  );
}

export function IconUpdate(): JSX.Element {
  return (
    <svg {...baseProps}>
      <title>Updates</title>
      <circle cx="10" cy="10" r="7" />
      <polyline points="7,10 10,7 13,10" />
      <line x1="10" y1="7" x2="10" y2="14" />
    </svg>
  );
}

export function IconMemory(): JSX.Element {
  return (
    <svg {...baseProps}>
      <title>Memory</title>
      <path d="M10 2.5L11.8 7.1L16.5 7.6L12.9 10.7L14 15.3L10 12.8L6 15.3L7.1 10.7L3.5 7.6L8.2 7.1Z" />
    </svg>
  );
}

export function IconAbout(): JSX.Element {
  return (
    <svg {...baseProps}>
      <title>About</title>
      <circle cx="10" cy="10" r="7.5" />
      <line x1="10" y1="9" x2="10" y2="14" />
      <circle cx="10" cy="6" r="0.8" fill="currentColor" />
    </svg>
  );
}

export function IconChat(): JSX.Element {
  return (
    <svg {...baseProps}>
      <title>Chat</title>
      <path d="M3 5h14v8h-7l-4 3v-3H3Z" />
      <line x1="6" y1="8.5" x2="12" y2="8.5" />
      <line x1="6" y1="11" x2="10" y2="11" />
    </svg>
  );
}

export function IconNexusLogo(): JSX.Element {
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true" focusable="false">
      <title>NEXUS logo</title>
      <circle cx="22" cy="22" r="20" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="22" cy="22" r="6" fill="currentColor" />
      <line x1="22" y1="2" x2="22" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="22" y1="34" x2="22" y2="42" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2" y1="22" x2="10" y2="22" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="34" y1="22" x2="42" y2="22" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconEmptyMemory(): JSX.Element {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" fill="none" aria-hidden="true" focusable="false">
      <title>Empty memory</title>
      <circle cx="48" cy="48" r="42" stroke="currentColor" strokeWidth="1" strokeDasharray="3 4" opacity="0.3" />
      <path d="M48 20L54 36L70 38L58 50L62 66L48 58L34 66L38 50L26 38L42 36Z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" opacity="0.6" />
    </svg>
  );
}

export function IconExternal(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ display: 'inline-block', verticalAlign: '-1px', marginLeft: 4 }}>
      <title>External link</title>
      <path d="M3 3H7" />
      <path d="M9 3V7" />
      <path d="M9 3L5 7" />
      <path d="M3 3V9H9" />
    </svg>
  );
}
