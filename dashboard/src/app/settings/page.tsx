'use client'

import Link from 'next/link'

interface SettingsLink {
  href: string
  title: string
  description: string
  icon: string
}

const SETTINGS_LINKS: SettingsLink[] = [
  {
    href: '/settings/otel',
    title: 'OpenTelemetry',
    description:
      'Configure JSONL ingestion, retention, and content capture for OTel traces.',
    icon: '📡',
  },
  {
    href: '/autonomy',
    title: 'Autonomy Level',
    description:
      'Promote or demote the brain between Observer, Advisor, Assistant, and Autonomous.',
    icon: '🛡️',
  },
  {
    href: '/observers',
    title: 'Observers',
    description:
      'Enable or disable individual observer plug-ins (file, git, terminal, etc.).',
    icon: '👁️',
  },
  {
    href: '/scheduler',
    title: 'Scheduler',
    description:
      'Manage cron tasks, trigger runs on demand, and inspect execution history.',
    icon: '🕐',
  },
]

export default function SettingsPage() {
  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>
        Settings
      </h1>
      <p style={{ opacity: 0.7, marginBottom: '1.5rem', maxWidth: '640px' }}>
        Pick a settings area. Each card deep-links to the existing configuration
        surface in the dashboard.
      </p>

      <div
        role="list"
        aria-label="Settings areas"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '1rem',
        }}
      >
        {SETTINGS_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            role="listitem"
            style={{
              display: 'block',
              padding: '1rem',
              borderRadius: '0.5rem',
              border: '1px solid var(--gray-a5)',
              backgroundColor: 'var(--gray-a2)',
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span aria-hidden="true" style={{ fontSize: '1.25rem' }}>
                {link.icon}
              </span>
              <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                {link.title}
              </h2>
            </div>
            <p
              style={{
                margin: '0.5rem 0 0',
                fontSize: '0.85rem',
                opacity: 0.75,
                lineHeight: 1.4,
              }}
            >
              {link.description}
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}
