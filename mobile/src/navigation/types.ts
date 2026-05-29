// Centralised navigator types so screens get autocompletion when calling
// `nav.navigate(...)`.

export type RootStackParamList = {
  Pair: undefined
  Projects: undefined
  Conversations: { projectId: string; projectName: string }
  Chat: { conversationId: string; title?: string }
  Settings: undefined
}
