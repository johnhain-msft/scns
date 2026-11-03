'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_ITEMS = [
  { href: '/', label: 'Overview', icon: '🏠' },
  { href: '/orchestrator', label: 'Orchestrator', icon: '🎼' },
  { href: '/sessions', label: 'Sessions', icon: '🖥️' },
  { href: '/teams', label: 'Teams', icon: '👥' },
  { href: '/tasks', label: 'Tasks', icon: '✅' },
  { href: '/suggestions', label: 'Suggestions', icon: '💡' },
  { href: '/scheduler', label: 'Scheduler', icon: '🕐' },
  { href: '/memory', label: 'Memory', icon: '🧠' },
  { href: '/dream', label: 'Dream', icon: '🌙' },
  { href: '/observers', label: 'Observers', icon: '👁️' },
  { href: '/autonomy', label: 'Autonomy', icon: '🛡️' },
  { href: '/cost', label: 'Cost', icon: '💲' },
  { href: '/traces', label: 'Traces', icon: '📈' },
  { href: '/metrics', label: 'Metrics', icon: '📊' },
  { href: '/settings/otel', label: 'OTel Settings', icon: '⚙️' },
] as const

export function Sidebar() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Main navigation"
      style={{
        width: '240px',
        minHeight: '100vh',
        borderRight: '1px solid var(--gray-a5)',
        padding: '1rem 0',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
        backgroundColor: 'var(--color-panel)',
      }}
    >
      <div
        style={{
          padding: '0.5rem 1rem 1rem',
          fontSize: '1.25rem',
          fontWeight: 700,
          letterSpacing: '0.05em',
        }}
      >
        <span>SCNS</span>
        <span
          style={{
            display: 'block',
            fontSize: '0.7rem',
            fontWeight: 400,
            opacity: 0.6,
            letterSpacing: 'normal',
          }}
        >
          Dashboard
        </span>
      </div>

      {NAV_ITEMS.map(({ href, label, icon }) => {
        const isActive = pathname === href

        return (
          <Link
            key={href}
            href={href}
            aria-current={isActive ? 'page' : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.5rem 1rem',
              textDecoration: 'none',
              color: isActive ? 'var(--accent-11)' : 'var(--gray-11)',
              backgroundColor: isActive ? 'var(--accent-a3)' : 'transparent',
              borderRadius: '0.375rem',
              margin: '0 0.5rem',
              fontSize: '0.875rem',
              fontWeight: isActive ? 600 : 400,
              transition: 'background-color 0.15s, color 0.15s',
            }}
          >
            <span aria-hidden="true">{icon}</span>
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
