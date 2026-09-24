import type { RuleTester } from 'oxlint/plugins-dev'

/** Native Oxlint rules cover casts, any, postfix assertions and TS suppressions.
 * Declaration assertions are a separate AST form and need this additional rule. */
export const noDefiniteAssignment: Parameters<RuleTester['run']>[1] = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      forbidden:
        'Initialize this value or represent its absence explicitly; definite-assignment assertions are prohibited.',
    },
  },
  create(context) {
    return {
      'VariableDeclarator[definite=true], PropertyDefinition[definite=true], AccessorProperty[definite=true]'(
        node,
      ) {
        context.report({ node, messageId: 'forbidden' })
      },
    }
  },
}

export default {
  meta: { name: 'type-policy' },
  rules: { 'no-definite-assignment': noDefiniteAssignment },
}
