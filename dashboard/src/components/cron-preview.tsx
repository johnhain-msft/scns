'use client'

interface CronPreviewProps {
  expression: string
}

function parseCron(expression: string): string | null {
  const parts = expression.trim().split(/\s+/)

  // 6-field cron (seconds minutes hours day month weekday)
  if (parts.length === 6) {
    const [seconds, minutes, hours, day, month, weekday] = parts

    // Every N seconds: */N * * * * *
    if (seconds.startsWith('*/') && minutes === '*' && hours === '*' && day === '*' && month === '*' && weekday === '*') {
      const n = parseInt(seconds.slice(2), 10)
      if (!isNaN(n)) return n === 1 ? 'Every second' : `Every ${n} seconds`
    }

    // 6-field where seconds=0 — treat like 5-field
    if (seconds === '0') {
      return parseFiveField(minutes, hours, day, month, weekday)
    }

    return null
  }

  // 5-field cron (minutes hours day month weekday)
  if (parts.length === 5) {
    const [minutes, hours, day, month, weekday] = parts
    return parseFiveField(minutes, hours, day, month, weekday)
  }

  return null
}

function parseFiveField(
  minutes: string,
  hours: string,
  day: string,
  month: string,
  weekday: string,
): string | null {
  // Every minute: * * * * *
  if (minutes === '*' && hours === '*' && day === '*' && month === '*' && weekday === '*') {
    return 'Every minute'
  }

  // Every N minutes: */N * * * *
  if (minutes.startsWith('*/') && hours === '*' && day === '*' && month === '*' && weekday === '*') {
    const n = parseInt(minutes.slice(2), 10)
    if (!isNaN(n)) return n === 1 ? 'Every minute' : `Every ${n} minutes`
  }

  // Daily at specific time: M H * * *
  if (/^\d+$/.test(minutes) && /^\d+$/.test(hours) && day === '*' && month === '*' && weekday === '*') {
    const h = parseInt(hours, 10)
    const m = parseInt(minutes, 10)
    const period = h >= 12 ? 'PM' : 'AM'
    const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h
    const displayMin = m.toString().padStart(2, '0')
    return `Daily at ${displayHour}:${displayMin} ${period}`
  }

  // Every N hours: 0 */N * * *
  if (minutes === '0' && hours.startsWith('*/') && day === '*' && month === '*' && weekday === '*') {
    const n = parseInt(hours.slice(2), 10)
    if (!isNaN(n)) return n === 1 ? 'Every hour' : `Every ${n} hours`
  }

  return null
}

export function CronPreview({ expression }: CronPreviewProps) {
  const humanReadable = parseCron(expression)

  return (
    <span className="cron-preview">
      <code style={{ fontSize: '0.8rem', opacity: 0.7 }}>{expression}</code>
      {humanReadable && (
        <>
          {' '}
          <span style={{ fontSize: '0.8rem' }}>{humanReadable}</span>
        </>
      )}
    </span>
  )
}
