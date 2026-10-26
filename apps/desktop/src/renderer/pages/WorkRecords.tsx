import { generatedMessageText, useDesktopLocale, useDesktopText, useSystemLabel } from '../desktop-i18n.js';
import React, { useEffect, useState } from 'react';
import type { ConversationKey } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import type { SystemErrorCode } from '../../desktop-protocol.js';
import { lineServerErrorText } from '../line-server-error-copy.js';
import { diagnosticLabels, diagnosticRecovery } from '../diagnostic-copy.js';

type Tab = 'activity' | 'errors';
const WORK_RECORDS_TAB_KEY = 'line-agent:work-records-tab';
function readStoredTab(): Tab {
  try { const value = window.localStorage.getItem(WORK_RECORDS_TAB_KEY); return value === 'errors' ? 'errors' : 'activity'; } catch { return 'activity'; }
}
function storeTab(tab: Tab): void {
  try { window.localStorage.setItem(WORK_RECORDS_TAB_KEY, tab); } catch { /* Storage can be disabled; the tab still switches. */ }
}
const errorExplanationText: Partial<Record<SystemErrorCode, (text: ReturnType<typeof useDesktopText>) => string>> = {
  DATABASE_WRITE_FAILED: (text) => text('unableToWriteSystemRecordToDatabase'), FALLBACK_WRITE_FAILED: (text) => text('unableToWriteSystemRecordFallback'),
  WORKER_STOP_FAILED: (text) => text('unableToStopWorker'), WORKER_STOP_TIMEOUT: (text) => text('timedOutWaitingForWorkerToStop'), AGENT_AUTH_FAILED: (text) => text('agentAuthorizationActionFailed'),
  SECRET_CLEAR_FAILED: (text) => text('unableToClearLoginCredentials'), OPERATOR_ACTION_FAILED: (text) => text('userActionFailed'), STARTUP_FAILED: (text) => text('systemStartupFailed'),
  SHUTDOWN_FAILED: (text) => text('systemShutdownFailed'), WORKER_EXITED: (text) => text('workerExitedUnexpectedly'), AUTH_INVALIDATED: (text) => text('lineLoginIsNoLongerValid'),
  RECOVERY_FAILED: (text) => text('systemRecoveryFailed'), PROVIDER_STATUS_FAILED: (text) => text('unableToUpdateAgentServiceStatus'), ATTACHMENT_EXPIRED: (text) => text('attachmentExpired'),
  ATTACHMENT_DOWNLOAD_FAILED: (text) => text('unableToDownloadAttachment'), RELATION_LIST_RPC_FAILED: (text) => text('unableToReadLineFriends'),
  RELATION_LIST_SHAPE_INVALID: (text) => text('unableToParseLineFriendList'), RELATION_LIST_LIMIT: (text) => text('lineFriendListExceedsProcessingLimit'),
  RELATION_DETAIL_RPC_FAILED: (text) => text('unableToReadLineFriendProfile'), RELATION_DETAIL_SHAPE_INVALID: (text) => text('unableToParseLineFriendProfile'),
  RELATION_CANCELLED: (text) => text('friendVerificationCancelled'), RELATION_BINDING_REVOKED: (text) => text('authorizationRevokedDuringFriendVerification'),
  RELATION_RESPONSE_TIMEOUT: (text) => text('lineFriendVerificationTimedOut'), RELATION_WORKER_EXIT: (text) => text('workerExitedDuringFriendVerification'),
  RELATION_OUTCOME_UNKNOWN: (text) => text('unableToConfirmLineFriendQueryResult'), ENROLLMENT_BINDING_CHANGED: (text) => text('authorizationChangedWhileAddingUser'),
  SIDE_EFFECT_DENIED: (text) => text('lineWorkerRejectedExternalAction'), NOT_STARTED: (text) => text('lineActionCancelledBeforeSending'),
  TRANSPORT_OUTCOME_UNKNOWN: (text) => text('unableToConfirmLineActionResult'), ENROLLMENT_PRECHECK_FAILED: (text) => text('userAuthorizationPreflightFailed'),
  ENROLLMENT_GRANT_FAILED: (text) => text('unableToSaveFriendAllowlist'), ENROLLMENT_REPLY_FAILED: (text) => text('unableToNotifyFriendOfAuthorizationResult'),
  ENROLLMENT_REPLY_UNKNOWN: (text) => text('unableToConfirmFriendAuthorizationNotification'), INVALID_COMMAND: (text) => text('lineWorkerCommandFailed'),
  QUEUE_FULL: (text) => text('lineWorkerQueueFull'), CATALOG_REFRESH_FAILED: (text) => text('unableToUpdateLineContactsGroups'),
  WORKER_OPERATION_FAILED: (text) => text('lineWorkerActionFailed'), UNKNOWN_ERROR: (text) => text('unknownError'),
  HISTORY_READ_FAILED: (text) => text('historyReadFailed'), CHAT_RESOURCE_READ_FAILED: (text) => text('chatResourceReadFailed'),
  PROFILE_REFRESH_FAILED: (text) => text('profileRefreshFailed'), MESSAGE_SEND_FAILED: (text) => text('messageSendFailed'),
  MESSAGE_UNSEND_FAILED: (text) => text('messageUnsendFailed'), MESSAGE_REACTION_FAILED: (text) => text('messageReactionFailed'),
  FRIEND_RELATION_CHECK_FAILED: (text) => text('friendRelationCheckFailed'), FRIEND_ADD_FAILED: (text) => text('friendAddFailed'), PRIMARY_ADMIN_NOT_FRIEND: (text) => text('primaryAdminNotFriend'),
  ATTACHMENT_DOWNLOAD_OPERATION_FAILED: (text) => text('attachmentDownloadOperationFailed'),
  CREDENTIAL_RESTORE_FAILED: (text) => text('credentialRestoreFailed'), LINE_SYNC_FAILED: (text) => text('lineSyncFailed'),
};

export function WorkRecords({ api, onOpen, headingRef }: { api: DesktopApi; onOpen: (key: ConversationKey) => void; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const desktopText = useDesktopText();
  const systemLabel = useSystemLabel();
  const locale = useDesktopLocale();
  const [tab, setTab] = useState<Tab>(readStoredTab);
  const [refresh, setRefresh] = useState(0);
  const [activity, setActivity] = useState<Awaited<ReturnType<DesktopApi['listSystemActivity']>> | null>(null);
  const [activityError, setActivityError] = useState('');
  const [activityLoading, setActivityLoading] = useState(false);
  const [errors, setErrors] = useState<Awaited<ReturnType<DesktopApi['listSystemErrors']>> | null>(null);
  const [systemError, setSystemError] = useState('');
  const [errorsLoading, setErrorsLoading] = useState(false);

  useEffect(() => {
    let live = true;
    if (tab === 'activity') {
      setActivityLoading(true); setActivityError('');
      void api.listSystemActivity().then((result) => { if (live) setActivity(result); })
        .catch(() => { if (live) { setActivity(null); setActivityError(desktopText('recordsTemporarilyUnavailable')); } })
        .finally(() => { if (live) setActivityLoading(false); });
    } else {
      setErrorsLoading(true); setSystemError('');
      void api.listSystemErrors().then((result) => { if (live) setErrors(result); })
        .catch(() => { if (live) { setErrors(null); setSystemError(desktopText('recordsTemporarilyUnavailable')); } })
        .finally(() => { if (live) setErrorsLoading(false); });
    }
    return () => { live = false; };
  }, [api, tab, refresh]);

  const selectTab = (value: Tab) => {
    if (value === tab) setRefresh((current) => current + 1);
    else { setTab(value); storeTab(value); setRefresh((current) => current + 1); }
  };
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 'errors'
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? 'activity'
        : event.key === 'Home' ? 'activity' : event.key === 'End' ? 'errors' : null;
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    document.getElementById(next === 'activity' ? 'work-tab-activity' : 'work-tab-errors')?.focus();
  };
  const localTime = (value: string) => new Date(value).toLocaleString(locale);
  const localDate = (value: string) => new Date(value).toLocaleDateString(locale);
  const localClock = (value: string) => new Date(value).toLocaleTimeString(locale);

  return <div className="page work-records-page">
    <section className="panel work-records-card">
    <div className="settings-tabs work-record-tabs" role="tablist" aria-label={desktopText('workRecordCategories')} aria-orientation="horizontal" onKeyDown={onTabKeyDown}>
      <button type="button" role="tab" id="work-tab-activity" aria-controls="work-panel-activity" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'active' : ''} onClick={() => selectTab('activity')}>{desktopText('systemRecords')}</button>
      <button type="button" role="tab" id="work-tab-errors" aria-controls="work-panel-errors" aria-selected={tab === 'errors'} className={tab === 'errors' ? 'active' : ''} onClick={() => selectTab('errors')}>{desktopText('systemErrors')}</button>
    </div>
    {tab === 'activity' ? <section id="work-panel-activity" role="tabpanel" aria-labelledby="work-tab-activity">
      {activityLoading && <p role="status">{desktopText('loadingSystemRecords')}</p>}
      {activityError && <p role="alert" className="error-banner">{generatedMessageText(activityError)}</p>}
      {activity?.partial && <p className="monitor-note">{desktopText('someRecordsAreTemporarilyUnavailable')}</p>}
      <div className="work-record-list"><div className="work-record-column-header work-record-grid" aria-hidden="true"><span>{desktopText('time')}</span><span>{desktopText('records')}</span><span>{desktopText('action')}</span><span>{desktopText('status')}</span></div>{activity?.activity.map((row, index) => <article className="work-record-row work-record-grid" key={`${row.createdAt}:${row.kind}:${index}`}>
        <div className="work-record-row-meta"><time>{localTime(row.createdAt)}</time></div>
        <div className="work-record-row-content">
          <h2>{systemLabel(row.action)}</h2>
          {row.kind === 'attachment' && <p>{row.attachmentKind === 'image' ? desktopText('image') : row.attachmentKind === 'video' ? desktopText('video') : row.attachmentKind === 'audio' ? desktopText('voice') : desktopText('file730')}{row.status === '重試中' || row.status === '下載失敗' ? desktopText('retriedArg0Times', { arg0: row.retryCount }) : ''}</p>}
        </div>
        <div className="work-record-row-action">{row.kind === 'attachment' && <button type="button" onClick={() => onOpen(row.key)}>{desktopText('viewSourceMessage')}</button>}</div>
        <span className="badge">{systemLabel(row.kind === 'audit' ? row.phase : row.status)}</span>
      </article>)}</div>
    </section> : <section id="work-panel-errors" role="tabpanel" aria-labelledby="work-tab-errors">
      {errorsLoading && <p role="status">{desktopText('loadingSystemErrors')}</p>}
      {systemError && <p role="alert" className="error-banner">{generatedMessageText(systemError)}</p>}
      {errors?.partial && <p className="monitor-note">{desktopText('someRecordsAreTemporarilyUnavailable')}</p>}
      <div className="work-record-list"><div className="work-record-column-header work-record-grid work-record-error-header" aria-hidden="true"><span>{desktopText('time')}</span><span>{desktopText('records')}</span><span>{desktopText('action')}</span><span>{desktopText('status')}</span></div>{errors?.errors.map((row, index) => <article className="work-record-row work-record-grid work-record-error-row" key={`${row.createdAt}:${row.code}:${index}`}>
        <div className="work-record-row-meta"><time dateTime={row.createdAt}><span className="work-record-date">{localDate(row.createdAt)}</span><span className="work-record-clock">{localClock(row.createdAt)}</span></time></div>
        <div className="work-record-row-content"><h2>{systemLabel(row.action)}</h2><p>{lineServerErrorText(locale, row.code) ?? errorExplanationText[row.code]?.(desktopText) ?? desktopText('unknownError')}</p><code>{row.code}</code>
          {row.correlationId && <p className="work-record-reference">{diagnosticLabels[locale].reference}: <code>{row.correlationId}</code></p>}
        </div>
        <div className="work-record-row-action">{row.diagnostic ? <dl>
            <dt>{diagnosticLabels[locale].operation}</dt><dd><code>{row.diagnostic.ipcAction ?? (row.diagnostic.operation === 'ipc'
              ? row.diagnostic.ipcAction ?? ({ en: 'Action was not recorded', 'zh-TW': '未記錄操作', ja: '操作は記録されていません', ko: '작업이 기록되지 않음' }[locale])
              : row.diagnostic.operation)}</code></dd>
            <dt>{diagnosticLabels[locale].stage}</dt><dd><code>{row.diagnostic.stage}</code></dd>
            <dt>{diagnosticLabels[locale].reason}</dt><dd><code>{row.diagnostic.reason ?? row.diagnostic.category}</code>{row.diagnostic.statusCode !== undefined ? ` (${row.diagnostic.statusCode})` : ''}</dd>
            {row.diagnostic.failureKind && <><dt>{diagnosticLabels[locale].failureKind}</dt><dd><code>{row.diagnostic.failureKind}</code></dd></>}
            {row.diagnostic.upstreamStatus !== undefined && <><dt>{diagnosticLabels[locale].upstreamStatus}</dt><dd><code>{row.diagnostic.upstreamStatus}</code></dd></>}
            {row.diagnostic.upstreamCode !== undefined && <><dt>{diagnosticLabels[locale].upstreamCode}</dt><dd><code>{row.diagnostic.upstreamCode}</code></dd></>}
            <dt>{diagnosticLabels[locale].recovery}</dt><dd>{diagnosticRecovery(locale, row.diagnostic)}</dd>
          </dl> : <p>{diagnosticLabels[locale].legacy}</p>}</div><span className="badge">{desktopText('error')}</span>
      </article>)}</div>
    </section>}
    </section>
  </div>;
}
