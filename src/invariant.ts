/** Enforce a required value at boundaries where absence indicates invalid state. */
export function required<T>(value: T | null | undefined, message = 'Required value is missing'): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}
