/** Fixed request discriminants only; never request payloads or renderer labels. */
export const IPC_ACTION_CODES = [
  'getSnapshot', 'reportRendererFailure', 'searchAgentJobs', 'lineAddAccountQr', 'lineLoginQr', 'lineReplaceAgentQr', 'lineLogout',
  'refreshLineAvatar', 'lineSetAutoLogin', 'lineBeginAdminPairing', 'lineStart', 'externalImportStart',
  'externalImportStop', 'previewExternalAdminBinding', 'startExternalMonitorAsAdmin', 'officialLineApproveSigner',
  'lineSyncHistory', 'submitAgentRoomPrompt', 'stopAgentRoomJob', 'retryAgentRoomJob', 'getAgentRoomJobEvents',
  'listMessages', 'listAttachments', 'listChatNotes', 'getChatNote', 'listChatAlbums', 'listChatAlbumPhotos',
  'downloadChatAlbumPhoto', 'openChatAlbum', 'openReadableChatAlbumFolder', 'cancelChatResourceRequest',
  'sendText', 'replyText', 'sendManualMedia', 'unsendMessage', 'getManualUnsendWindow', 'setManualUnsendWindow',
  'stopJob', 'retryJob', 'newSession', 'getJobEvents', 'searchMessages', 'openExternalUrl', 'openAttachment',
  'downloadAttachment', 'revealAttachment', 'resolveFileTypeIcon', 'subscribeEvents', 'setConversationAgent',
  'switchControl', 'setDefaultAgent', 'setWorkspace', 'getConversationSettings', 'setConversationSettings',
  'getAutoResponderSettings', 'setAutoResponderSettings', 'agentLogin', 'agentLogout', 'agentRefreshStatus',
  'mcpGetStatus', 'mcpLocalClientStatus', 'mcpLocalClientConnect', 'mcpLocalClientDisconnect', 'mcpListTokens',
  'mcpIssueToken', 'mcpRevokeToken', 'mcpCallInternalTool', 'getAgentPermissions', 'getAgentPermissionDefaults',
  'setAgentPermissionDefault', 'revokeAgentWhitelistUser', 'setAgentPermission', 'getAgentExecutionPolicy',
  'setAgentExecutionPolicy', 'listAgentToolAllowlist', 'removeAgentToolAllowlistEntry', 'clearAgentToolAllowlist',
  'decideAgentApproval', 'listPendingAgentApprovals', 'setAgentFolderLink', 'createChatFolder', 'openChatFolder',
] as const;
