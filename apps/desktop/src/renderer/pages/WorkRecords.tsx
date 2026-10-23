import { generatedMessageText, useDesktopLocale, useDesktopText, useSystemLabel } from '../desktop-i18n.js';
import React, { useEffect, useState } from 'react';
import type { ConversationKey } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import type { SystemErrorCode } from '../../desktop-protocol.js';

type Tab = 'activity' | 'errors';
const errorExplanationText: Record<SystemErrorCode, (text: ReturnType<typeof useDesktopText>) => string> = {
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
};

export function WorkRecords({ api, onOpen, headingRef }: { api: DesktopApi; onOpen: (key: ConversationKey) => void; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const desktopText = useDesktopText();
  const systemLabel = useSystemLabel();
  const locale = useDesktopLocale();
  const [tab, setTab] = useState<Tab>('activity');
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
    else { setTab(value); setRefresh((current) => current + 1); }
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
      <div className="work-record-list"><div className="work-record-column-header work-record-grid" aria-hidden="true"><span>{desktopText('time')}</span><span>{desktopText('records')}</span><span>{desktopText('action')}</span><span>{desktopText('status')}</span></div>{errors?.errors.map((row, index) => <article className="work-record-row work-record-grid" key={`${row.createdAt}:${row.code}:${index}`}>
        <div className="work-record-row-meta"><time>{localTime(row.createdAt)}</time></div>
        <div className="work-record-row-content"><h2>{systemLabel(row.action)}</h2><p>{errorExplanationText[row.code](desktopText)}</p><code>{row.code}</code></div>
        <div className="work-record-row-action"></div><span className="badge">{desktopText('error')}</span>
      </article>)}</div>
    </section>}
    </section>
  </div>;
}
