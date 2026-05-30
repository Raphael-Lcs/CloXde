module.exports = {
  root: true,
  extends: '@react-native',
  // The whole CloXde codebase (desktop + mobile) is written no-semicolon,
  // single-quote, with one-line `if (x) return` guards. The stock
  // @react-native preset assumes the opposite, so align the stylistic rules
  // with the house style instead of churning ~1.5k lines to satisfy defaults.
  rules: {
    semi: ['error', 'never'],
    'comma-dangle': 'off',
    curly: 'off',
    // Fire-and-forget promises (`void doThing()`) are a deliberate house
    // pattern shared with the desktop engine; inline layout primitives like
    // `{flex: 1}` are idiomatic RN and not worth hoisting into StyleSheet.
    'no-void': 'off',
    'react-native/no-inline-styles': 'off',
  },
}
