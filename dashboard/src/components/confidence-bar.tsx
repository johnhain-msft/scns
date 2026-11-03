'use client'

interface ConfidenceBarProps {
  value: number
}

export function ConfidenceBar({ value }: ConfidenceBarProps) {
  const percent = Math.round(value * 100)

  return (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Confidence: ${percent}%`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        width: '100%',
      }}
    >
      <div
        style={{
          flex: 1,
          height: '8px',
          borderRadius: '4px',
          backgroundColor: 'var(--gray-a4, #333)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            borderRadius: '4px',
            backgroundColor:
              percent >= 80
                ? 'var(--green-9, #30a46c)'
                : percent >= 50
                  ? 'var(--yellow-9, #f5d90a)'
                  : 'var(--red-9, #e5484d)',
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span style={{ fontSize: '0.8rem', minWidth: '3ch', textAlign: 'right' }}>
        {percent}%
      </span>
    </div>
  )
}
