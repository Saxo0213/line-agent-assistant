import { describe, expect, it } from 'vitest';
import { ENGLISH_DESKTOP_COPY } from './desktop-copy.js';
import { JAPANESE_DESKTOP_COPY_PART9 } from './desktop-copy-ja-part9.js';

const expectedKeys = [
  'agentStatusRotationIntervalSeconds',
  'externalMonitorAuthorityChanged', 'externalMonitorCheckpointChanged', 'externalMonitorSourceChanged',
  'externalMonitorReaderStartupFailed', 'externalMonitorReaderFailed', 'externalMonitorDatabaseFailed', 'externalMonitorFailureUnknown',
  'permissionCurrentChat',
  'permissionCurrentChatDescription',
  'permissionAllChats',
  'permissionAllChatsDescription',
  'permissionFolderRead',
  'permissionFolderReadDescription',
  'permissionFolderWrite',
  'permissionFolderWriteDescription',
  'permissionLocalTools',
  'permissionLocalToolsDescription',
  'permissionProjectFolderRead', 'permissionProjectFolderReadDescription', 'permissionProjectFolderWrite', 'permissionProjectFolderWriteDescription',
  'unsendMessage', 'unsendConfirm', 'unsendTimeWindow', 'unsendOneHour', 'unsendSevenDays', 'unsendWindowSaved', 'unsendFailed',
  'historyReadFailed', 'chatResourceReadFailed', 'profileRefreshFailed', 'messageSendFailed', 'messageUnsendFailed',
  'messageReactionFailed', 'friendRelationCheckFailed', 'friendAddFailed', 'primaryAdminNotFriend', 'attachmentDownloadOperationFailed',
  'credentialRestoreFailed', 'lineSyncFailed',
  'mediaWasNotSentTryAgain', 'mediaSendingRequiresDirectOrGroupChat',
  'cmdHelpGroupGeneral', 'cmdHelpGroupAdmin', 'cmdHelpGroupAuth', 'cmdHelpGroupSetup', 'cmdHelpGroupAutoReply', 'cmdHelpAskLabel', 'cmdHelpAskPurpose', 'cmdHelpAskDescription', 'cmdHelpExactNote', 'cmdHelpEnableGroupPurpose', 'cmdHelpEnableGroupDescription', 'cmdHelpConfirmCodePurpose', 'cmdHelpConfirmCodeDescription', 'cmdHelpFreePurpose', 'cmdHelpFreeDescription', 'cmdHelpAdduserDirect', 'cmdHelpAdduserGroup', 'cmdHelpAdduserCode', 'cmdHelpPermissionsPurpose', 'cmdHelpPermissionsDescription', 'cmdHelpPairingLabel', 'cmdHelpPairingPurpose', 'cmdHelpPairingDescription', 'cmdHelpAutoReplyLabel', 'cmdHelpAutoReplyPurpose', 'cmdHelpAutoReplyDescription',
  'cmdHelpGroupProject', 'cmdHelpFolderBindPurpose', 'cmdHelpFolderBindDescription', 'cmdHelpFolderRwPurpose', 'cmdHelpFolderRwDescription', 'cmdHelpFolderListPurpose', 'cmdHelpFolderListDescription', 'cmdHelpFolderOffPurpose', 'cmdHelpFolderOffDescription', 'cmdHelpAgentSwitchPurpose', 'cmdHelpAgentSwitchDescription', 'cmdHelpAgentDefaultPurpose', 'cmdHelpAgentDefaultDescription',
  'personaTitle', 'personaIntro', 'personaDescriptionLabel', 'personaDescriptionPlaceholder', 'personaCount', 'personaLivelinessLabel', 'personaLivelinessQuiet', 'personaLivelinessNormal', 'personaLivelinessLively', 'personaLivelinessHelp', 'personaSave', 'personaSaved', 'personaSaveFailed', 'personaLoadFailed', 'cmdHelpPersonaSetPurpose', 'cmdHelpPersonaSetDescription', 'cmdHelpPersonaLivelinessPurpose', 'cmdHelpPersonaLivelinessDescription', 'cmdHelpPersonaShowPurpose', 'cmdHelpPersonaShowDescription', 'cmdHelpPersonaDefaultPurpose', 'cmdHelpPersonaDefaultDescription',
] as const;
const slots = (text: string): string[] => [...text.matchAll(/\{arg\d+\}/g)].map(([slot]) => slot).sort();

describe('Japanese desktop copy part 9', () => {
  it('contains the rotation interval label, permission keys, and unsend keys', () => {
    expect(Object.keys(JAPANESE_DESKTOP_COPY_PART9).sort()).toEqual([...expectedKeys].sort());
  });

  it('has meaningful Japanese values and preserves every interpolation placeholder', () => {
    for (const key of expectedKeys) {
      const translation = JAPANESE_DESKTOP_COPY_PART9[key];
      expect(translation, key).toBeTypeOf('string');
      expect(translation?.trim(), key).not.toBe('');
      expect(slots(translation!), key).toEqual(slots(ENGLISH_DESKTOP_COPY[key]));
    }
  });
});
