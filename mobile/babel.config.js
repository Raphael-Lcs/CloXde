module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Reanimated must be the LAST plugin in this list — it ships its own
    // worklet pre-processor that needs to see the original AST.
    'react-native-reanimated/plugin'
  ]
}
