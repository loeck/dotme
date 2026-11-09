/**
 * Verifies that vercel.json's Content-Security-Policy allows exactly the inline scripts and
 * styles of the built pages, by SHA-256 hash. Run after a build:
 *
 *   node scripts/csp.ts [dist directory]      (or CSP_DIST=<dir>)
 *   node scripts/csp.ts [dist directory] --write   rewrites the hashes in vercel.json
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { headersFor, readHeaderRules } from './vercel-headers.ts'

const PAGES = ['index.html', '404.html']
/** Data blocks such as JSON-LD are never executed, so CSP does not apply to them. */
const DATA_BLOCK = /\btype\s*=\s*["']?application\/(?:ld\+)?json/i

const args = process.argv.slice(2)
const write = args.includes('--write')
const directory = resolve(
  args.find((arg) => !arg.startsWith('--')) ?? process.env.CSP_DIST ?? 'dist',
)
const root = resolve(import.meta.dirname, '..')

const hash = (content: string) =>
  `'sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}'`

function inlineHashes(html: string) {
  const scripts = new Set<string>()
  const styles = new Set<string>()
  for (const [, attributes = '', content = ''] of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
  ))
    if (!/\bsrc\s*=/i.test(attributes) && !DATA_BLOCK.test(attributes)) scripts.add(hash(content))
  for (const [, content = ''] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    styles.add(hash(content))
  if (/\sstyle\s*=/i.test(html.replaceAll(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')))
    throw new Error('Inline style attributes need a CSP exception; use classes instead')
  if (/\son[a-z]+\s*=/i.test(html.replaceAll(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')))
    throw new Error('Inline event handler attributes are blocked by the CSP')
  return { scripts, styles }
}

function directive(policy: string, name: string) {
  const entry = policy
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([key]) => key === name)
  if (!entry) throw new Error(`The CSP has no ${name} directive`)
  return entry.slice(1)
}

const required = { scripts: new Set<string>(), styles: new Set<string>() }
for (const page of PAGES) {
  // eslint-disable-next-line no-await-in-loop -- two small files
  const { scripts, styles } = inlineHashes(await readFile(resolve(directory, page), 'utf8'))
  for (const value of scripts) required.scripts.add(value)
  for (const value of styles) required.styles.add(value)
}

const rules = await readHeaderRules(root)
const policies = new Set(
  ['/', '/index.html', '/404.html', '/missing'].map(
    (path) => headersFor(rules, path).get('content-security-policy') ?? '',
  ),
)
if (policies.size !== 1 || policies.has(''))
  throw new Error('vercel.json must send one Content-Security-Policy for every page')
const [policy = ''] = policies

const problems: string[] = []
for (const [name, expected] of [
  ['script-src', required.scripts],
  ['style-src', required.styles],
] as const) {
  const present = new Set(directive(policy, name).filter((source) => source.startsWith("'sha")))
  for (const value of expected)
    if (!present.has(value)) problems.push(`${name} is missing ${value}`)
  for (const value of present)
    if (!expected.has(value)) problems.push(`${name} allows a stale ${value}`)
}

/** The directive `name` with its hashes replaced by `hashes`, other sources kept. */
const replaceHashes = (text: string, name: string, hashes: Set<string>) =>
  text.replace(new RegExp(`${name}([^;"]*)`), (_match, sources: string) => {
    const kept = sources
      .trim()
      .split(/\s+/)
      .filter((source) => source && !source.startsWith("'sha"))
    const [self = "'self'", ...rest] = kept
    return [name, self, ...hashes, ...rest].join(' ')
  })

if (problems.length && write) {
  const file = resolve(root, 'vercel.json')
  let text = await readFile(file, 'utf8')
  text = replaceHashes(text, 'script-src', required.scripts)
  text = replaceHashes(text, 'style-src', required.styles)
  await writeFile(file, text)
  console.log(`Updated vercel.json CSP hashes:\n${problems.join('\n')}`)
} else if (problems.length) {
  console.error(
    `vercel.json's Content-Security-Policy does not match ${directory}:\n${problems.join('\n')}\n` +
      'Rebuild, then run `node scripts/csp.ts --write` to update the hashes.',
  )
  process.exitCode = 1
} else {
  console.log(
    `CSP matches ${directory}: ${required.scripts.size} inline script(s), ${required.styles.size} inline style(s)`,
  )
}
