import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type HeaderRule = Readonly<{
  source: string
  pattern: RegExp
  headers: readonly (readonly [string, string])[]
}>

/** Vercel `source` patterns as used in vercel.json: literal paths with raw `(...)` regex groups. */
export function sourcePattern(source: string) {
  let pattern = ''
  let depth = 0
  for (const char of source) {
    if (char === '(') depth++
    pattern += depth > 0 ? char : char.replace(/[.*+?^${}|[\]\\/]/g, '\\$&')
    if (char === ')') depth--
  }
  return new RegExp(`^${pattern}$`)
}

function parseHeader(source: string, header: unknown): readonly [string, string] {
  if (
    !header ||
    typeof header !== 'object' ||
    !('key' in header) ||
    typeof header.key !== 'string' ||
    !('value' in header) ||
    typeof header.value !== 'string'
  )
    throw new Error(`Invalid header in vercel.json rule ${source}`)
  return [header.key, header.value]
}

export function parseHeaderRules(config: unknown): HeaderRule[] {
  if (
    !config ||
    typeof config !== 'object' ||
    !('headers' in config) ||
    !Array.isArray(config.headers)
  )
    throw new Error('vercel.json has no headers list')
  return config.headers.map((rule: unknown) => {
    if (
      !rule ||
      typeof rule !== 'object' ||
      !('source' in rule) ||
      typeof rule.source !== 'string' ||
      !('headers' in rule) ||
      !Array.isArray(rule.headers)
    )
      throw new Error('Invalid vercel.json header rule')
    const { source } = rule
    return {
      source,
      pattern: sourcePattern(source),
      headers: rule.headers.map((header: unknown) => parseHeader(source, header)),
    }
  })
}

export async function readHeaderRules(root: string) {
  const config: unknown = JSON.parse(await readFile(resolve(root, 'vercel.json'), 'utf8'))
  return parseHeaderRules(config)
}

/** The headers Vercel sends for a path: every matching rule applies, later rules win per key. */
export function headersFor(rules: readonly HeaderRule[], path: string) {
  const headers = new Map<string, string>()
  for (const rule of rules)
    if (rule.pattern.test(path))
      for (const [key, value] of rule.headers) headers.set(key.toLowerCase(), value)
  return headers
}
