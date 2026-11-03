'use client'

interface HorizontalBarProps {
  label: string
  value: number
  max: number
}

export function HorizontalBar({ label, value, max }: HorizontalBarProps) {
  const percent = max > 0 ? (value / max) * 100 : 0
  return (
    <div
      role="img"
      aria-label={`${label}: ${value.toLocaleString()}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        marginBottom: '0.5rem',
      }}
    >
      <span style={{ minWidth: '140px', fontSize: '0.875rem' }}>{label}</span>
      <div
        style={{
          flex: 1,
          backgroundColor: 'var(--gray-a3)',
          borderRadius: '0.25rem',
          height: '1rem',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            backgroundColor: 'var(--accent-9)',
            borderRadius: '0.25rem',
            transition: 'width 0.3s',
          }}
        />
      </div>
      <span style={{ minWidth: '80px', textAlign: 'right', fontSize: '0.875rem' }}>
        {value.toLocaleString()}
      </span>
    </div>
  )
}
