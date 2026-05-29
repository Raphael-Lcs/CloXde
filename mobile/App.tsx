// CloXde Mobile entrypoint.
//
// Wiring order:
//   1. GestureHandlerRootView at the very top — required by react-navigation
//      and any gesture-driven swipes inside screens.
//   2. SafeAreaProvider so screens can use SafeAreaView.
//   3. Hydrate the connection store from AsyncStorage before showing the UI;
//      this avoids the "Pair screen flash" when the app reopens.
//   4. Hand off to the navigator, which will route to either Pair (no
//      connection) or Projects (paired).

import 'react-native-gesture-handler'
import React, { useEffect } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar, View, ActivityIndicator } from 'react-native'
import RootNavigator from './src/navigation/RootNavigator'
import { useConnection } from './src/store/connection'
import { colors } from './src/utils/theme'

export default function App(): React.ReactElement {
  const hydrated = useConnection((s) => s.hydrated)
  const hydrate = useConnection((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <SafeAreaProvider>
        {hydrated ? (
          <RootNavigator />
        ) : (
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.bg
            }}
          >
            <ActivityIndicator color={colors.accent} />
          </View>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
