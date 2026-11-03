/**
 * Constrain a number to the inclusive range [min, max].
 *
 * Assumes `min <= max`.
 *
 * @returns `min` when `value < min`, `max` when `value > max`, otherwise `value`.
 */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}
