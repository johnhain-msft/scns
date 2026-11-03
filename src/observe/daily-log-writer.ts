import type { Observation } from './types.js'

/** Interface for writing daily log entries (dependency injection) */
export interface LogWriter {
  appendDailyLog(entry: string, date?: Date): void
}

/** Format an observation into a markdown daily log entry */
export function formatObservation(observation: Observation): string {
  const { type, content, tags } = observation
  const lines: string[] = []

  if (content.length > 0) {
    lines.push(`**[${type}]** ${content}`)
  } else {
    lines.push(`**[${type}]**`)
  }

  if (tags.length > 0) {
    lines.push(`Tags: ${tags.join(', ')}`)
  }

  return lines.join('\n')
}

/** Create a daily log writer that formats observations and delegates to a LogWriter */
export function createDailyLogWriter(
  writer: LogWriter,
  onObservation?: (obs: Observation) => void,
) {
  return {
    /** Format and write a single observation */
    write(observation: Observation): void {
      const formatted = formatObservation(observation)
      const date = new Date(observation.timestamp)
      if (Number.isNaN(date.getTime())) return // skip observations with invalid timestamps
      writer.appendDailyLog(formatted, date)
      onObservation?.(observation)
    },

    /** Format and write multiple observations (batched) */
    writeBatch(observations: readonly Observation[]): void {
      for (const observation of observations) {
        const formatted = formatObservation(observation)
        const date = new Date(observation.timestamp)
        if (Number.isNaN(date.getTime())) continue // skip invalid timestamps
        writer.appendDailyLog(formatted, date)
        onObservation?.(observation)
      }
    },
  }
}
