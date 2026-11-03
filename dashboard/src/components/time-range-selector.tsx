'use client'

interface TimeRangeSelectorProps {
  value: string
  onChange: (range: string) => void
  ranges?: string[]
}

const DEFAULT_RANGES = ['1h', '6h', '24h', '7d']

export function TimeRangeSelector({
  value,
  onChange,
  ranges = DEFAULT_RANGES,
}: TimeRangeSelectorProps) {
  return (
    <div role="group" aria-label="Time range" style={{ display: 'flex', gap: '0.25rem' }}>
      {ranges.map((range) => (
        <button
          key={range}
          onClick={() => onChange(range)}
          aria-pressed={value === range}
          style={{
            padding: '0.375rem 0.75rem',
            borderRadius: '0.375rem',
            border: '1px solid var(--gray-a5)',
            backgroundColor: value === range ? 'var(--accent-solid, #0072c3)' : 'transparent',
            color: value === range ? 'white' : 'var(--gray-11)',
            cursor: 'pointer',
            fontSize: '0.875rem',
            fontWeight: value === range ? 600 : 400,
          }}
        >
          {range}
        </button>
      ))}
    </div>
  )
}

const RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

export function rangeToSince(range: string): string {
  const ms = RANGE_MS[range] ?? RANGE_MS['1h']
  return new Date(Date.now() - ms).toISOString()
}
