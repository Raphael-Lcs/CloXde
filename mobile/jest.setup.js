// Jest setup for CloXde Mobile.
/* eslint-env jest, node */
//
// React Native's native modules aren't present in the jest (node) environment,
// so anything that calls TurboModuleRegistry.getEnforcing at import time blows
// up. We register the community-provided mocks here so component tests can
// render the real tree instead of fighting "module not found" invariants.

import 'react-native-gesture-handler/jestSetup'

// Reanimated ships an official jest mock; it also silences the worklet init.
jest.mock('react-native-reanimated', () =>
  require('react-native-reanimated/mock')
)

// AsyncStorage mock so the connection store can hydrate in tests.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
