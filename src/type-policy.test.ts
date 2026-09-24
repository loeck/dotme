import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'

import { noDefiniteAssignment } from '../scripts/type-policy'

RuleTester.describe = describe
RuleTester.it = it
new RuleTester().run('type-policy/no-definite-assignment', noDefiniteAssignment, {
  valid: [
    { code: 'let initialized = 0', filename: 'source.ts' },
    { code: 'let pending: number | undefined', filename: 'source.ts' },
    { code: 'class State { value: number | undefined }', filename: 'source.ts' },
    { code: 'const values = [1, 2] as const', filename: 'source.ts' },
  ],
  invalid: [
    { code: 'let pending!: number', filename: 'source.ts', errors: [{ messageId: 'forbidden' }] },
    {
      code: 'class State { value!: number }',
      filename: 'source.ts',
      errors: [{ messageId: 'forbidden' }],
    },
    {
      code: 'class State { private value!: number }',
      filename: 'source.ts',
      errors: [{ messageId: 'forbidden' }],
    },
  ],
})
