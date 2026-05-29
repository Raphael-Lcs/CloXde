// Root navigator. We split the world into two stacks:
//   • When `conn === null`: only the Pair screen is reachable.
//   • When `conn !== null`: the user can browse Projects → Conversations →
//      Chat, with Settings reachable from anywhere.
//
// Switching between the two is done by remounting the navigator, which
// keeps the navigation logic flat instead of nesting auth.

import React from 'react'
import { NavigationContainer, DarkTheme } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import PairScreen from '../screens/PairScreen'
import ProjectListScreen from '../screens/ProjectListScreen'
import ConversationListScreen from '../screens/ConversationListScreen'
import ChatScreen from '../screens/ChatScreen'
import SettingsScreen from '../screens/SettingsScreen'
import type { RootStackParamList } from './types'
import { useConnection } from '../store/connection'
import { colors } from '../utils/theme'

const Stack = createNativeStackNavigator<RootStackParamList>()

export default function RootNavigator(): React.ReactElement {
  const conn = useConnection((s) => s.conn)

  return (
    <NavigationContainer
      theme={{
        ...DarkTheme,
        colors: {
          ...DarkTheme.colors,
          background: colors.bg,
          card: colors.bg,
          text: colors.text,
          primary: colors.accent,
          border: colors.border
        }
      }}
    >
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg }
        }}
      >
        {conn ? (
          <>
            <Stack.Screen name="Projects" component={ProjectListScreen} />
            <Stack.Screen name="Conversations" component={ConversationListScreen} />
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
          </>
        ) : (
          <Stack.Screen name="Pair" component={PairScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  )
}
