// Centralized IPC channel names. Both sides import from here to avoid typos.

export const IPC = {
  // App
  AppGetVersion: 'app:get-version',

  // Dialogs
  ProjectsPickDir: 'projects:pick-dir',
  PickDir: 'dialog:pick-dir',

  // Projects
  ProjectsList: 'projects:list',
  ProjectsListArchived: 'projects:list-archived',
  ProjectsCreate: 'projects:create',
  ProjectsOpen: 'projects:open',
  ProjectsArchive: 'projects:archive',
  ProjectsUnarchive: 'projects:unarchive',
  ProjectsDelete: 'projects:delete',

  // Agent profiles (per-project env / args / command overrides)
  ProfilesListByProject: 'profiles:list-by-project',
  ProfilesUpsert: 'profiles:upsert',

  // Conversations (A2A sessions)
  ConversationsListByProject: 'conversations:list-by-project',
  ConversationsListArchivedByProject: 'conversations:list-archived-by-project',
  ConversationsCreate: 'conversations:create',
  ConversationsPreviewInheritedSummary: 'conversations:preview-inherited-summary',
  ConversationsGet: 'conversations:get',
  ConversationsDelete: 'conversations:delete',
  ConversationsArchive: 'conversations:archive',
  ConversationsUnarchive: 'conversations:unarchive',
  ConversationsSendUserMessage: 'conversations:send-user-message',
  ConversationsCancel: 'conversations:cancel',
  ConversationsSetAutopilot: 'conversations:set-autopilot',
  ConversationsSetPrimarySide: 'conversations:set-primary-side',

  // Schedules (timed automation)
  SchedulesListByConversation: 'schedules:list-by-conversation',
  SchedulesCreate: 'schedules:create',
  SchedulesUpdate: 'schedules:update',
  SchedulesDelete: 'schedules:delete',

  // Assistant (the user-scoped layer above the team)
  AssistantSendMessage: 'assistant:send-message', // user → brain, returns AssistantTurn
  AssistantResetSession: 'assistant:reset-session', // /new — dispose the brain's ACP session so the next turn starts fresh
  AssistantCancel: 'assistant:cancel', // interrupt the in-flight brain turn
  AssistantListMemories: 'assistant:list-memories',
  AssistantAddMemory: 'assistant:add-memory', // manually store a memory (user-authored, pinned)
  AssistantPinMemory: 'assistant:pin-memory', // toggle a memory's pinned flag (pinned = never auto-pruned)
  AssistantForgetMemory: 'assistant:forget-memory', // delete a memory permanently
  AssistantListMessages: 'assistant:list-messages', // hydrate the panel's persisted chat thread
  AssistantMarkReportsRead: 'assistant:mark-reports-read', // clear the unread-report badge
  AssistantCountUnreadReports: 'assistant:count-unread-reports', // titlebar badge count
  AssistantReportEvent: 'assistant:report', // main → renderer, proactive AssistantReport
  AssistantActivityEvent: 'assistant:activity', // main → renderer, live turn progress (AssistantActivity)

  // Events (main → renderer)
  ConversationUpdatedEvent: 'conversation:updated', // ConversationView snapshot
  MessageAppendedEvent: 'conversation:message-appended', // { conversationId, message }
  MessagePatchedEvent: 'conversation:message-patched', // { conversationId, messageId, patch }
  PresenceActivityEvent: 'presence:activity', // PresenceActivity broadcast (cross-client awareness)

  // Filesystem inspector
  FsListDir: 'fs:list-dir',
  FsListFiles: 'fs:list-files',
  FsOpenPath: 'fs:open-path',
  FsChangedEvent: 'fs:changed', // { projectId } — throttled
  FsGitStatus: 'fs:git-status', // working-tree changes for the 改动 panel
  FsGitDiff: 'fs:git-diff', // unified diff for one file

  // LAN companion server (Android tablet)
  ServerGetStatus: 'server:get-status',
  ServerRotatePin: 'server:rotate-pin',
  ServerListDevices: 'server:list-devices',
  ServerRevokeDevice: 'server:revoke-device',
  ServerRevokeAllDevices: 'server:revoke-all-devices'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
