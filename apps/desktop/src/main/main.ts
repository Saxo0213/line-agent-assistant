import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, screen, session, shell, Tray, utilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createIpcAdapter, createReadAdapter } from './ipc.js';
import { createDisconnectedFacade } from './service-facade.js';
import type { DesktopServiceFacade } from './service-facade.js';
import { createConnectedFacade, type OfficialSnapshotImporter } from './connected-facade.js';
import { createUtilityWorkerGateway, MAX_UTILITY_WORKERS } from './utility-worker-gateway.js';
import { createDesktopLifecycle, parseDesktopCommand, routeSecondInstance, shutdownServices, type DesktopLifecycleFailure } from './desktop-lifecycle.js';
import { createElectronPreviewPresenter } from './electron-preview-presenter.js';
import { createDomainEventPublisher } from './domain-event-publisher.js';
import { APP_USER_MODEL_ID, resolveDefaultAppIcon } from './app-icon.js';
import { createFileTypeIconResolver } from './file-type-icon.js';
import { createMainWindowOptions } from './main-window-options.js';
import { createWindowGeometryPersistence, readWindowGeometry } from './window-geometry.js';
import { isAllowedNavigation, rendererContentSecurityPolicy } from './security.js';
import { agentBridgeEnabled, isPackagedHeadlessSmoke, registerMainWindowReadyDisplay } from './startup-mode.js';
import { resolveDatabaseMigrations, resolveJobHost, resolveSkillsDirectory, resolveWorkerEntry } from './resources.js';
import { BootstrapSettings, bootstrapFromEnvironment } from './services/bootstrap-settings.js';
import { SecretStore } from './services/secret-store.js';
import { createOperationalAuditRuntime } from './services/operational-audit-runtime.js';
import { createOperationalAudit, type OperationalAudit } from './services/operational-audit.js';
import { OperationalAuditFallback } from './services/operational-audit-fallback.js';
import { diagnosticFailure, type SafeDiagnostic } from '@line-agent/contracts';
import { DatabaseSetupService } from './services/database-setup.js';
import { createAttachmentRootChange } from './services/attachment-root-change.js';
import { WorkspaceAuthority } from './services/workspace-authority.js';
import { createSetupAdapter, createSetupCutover, type EmbeddedSetupPort } from './setup-ipc.js';
import { createFirstRunSetupSession, decideFirstRunSetup, isFirstRunSetupMode } from './first-run-setup.js';
import { SETUP_PROGRESS_CHANNEL } from '../setup-protocol.js';
import { EmbeddedPostgresProvisioner } from './services/embedded-postgres/provisioner.js';
import { EmbeddedPostgresServer } from './services/embedded-postgres/server.js';
import { persistMovedEmbeddedPort } from './services/embedded-postgres/port-move.js';
import { createNodeProvisionerDeps, createServerDeps, createSidReader, resolveCurrentEmbeddedRoot } from './services/embedded-postgres/node-deps.js';
import { embeddedPaths } from './services/embedded-postgres/pin.js';
import { runProcess } from './services/embedded-postgres/process.js';
import { changeEmbeddedPassword, connectWithPasswordRecovery, passwordFromDatabaseUrl, resetAdminPasswordViaLocalSocket, setRolePassword } from './services/embedded-postgres/password.js';
import { AgentCliBridge, NodeProcessRunner } from '@line-agent/agent-bridge';
import { AgentRepository, MessageRepository, SettingsRepository, createPool, migrate } from '@line-agent/database';
import { StartupCleanup } from './startup-cleanup.js';
import { createJsOfficialSnapshotImporter } from './services/js-external-reader/runtime-importer.js';
import { OfficialBuildTrustService } from './services/official-build-trust.js';
import { mainExternalSourceProbeAdmission } from './services/external-source-probe-admission.js';
import { parseLineMediaUrl } from '@line-agent/contracts';
import { createLocaleSettings, getEffectiveLocale, setEffectiveLocaleReader } from './locale-settings.js';
import { nativeDesktopText } from '../desktop-system-copy.js';
import { createLocaleIpcAdapter } from './locale-ipc.js';
import { createFileUpdateCheckStore, createUpdateCheckService, type UpdateCheckService } from './services/update-check-service.js';
import { loadAppUpdater } from './services/app-updater.js';
import { createUpdateCheckIpcAdapter } from './update-check-ipc.js';
import { UPDATE_CHECK_CHANNEL, UPDATE_CHECK_STATE_CHANNEL } from '../update-check-protocol.js';

if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

const privilegedScheme = {
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    bypassCSP: false,
    allowServiceWorkers: false,
    allowExtensions: false,
  },
};
protocol.registerSchemesAsPrivileged([{ scheme: 'line-preview', ...privilegedScheme }, { scheme: 'line-media', ...privilegedScheme }]);

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rendererFile = path.join(appDir, 'renderer', 'index.html');
const preloadFile = path.join(appDir, 'preload.cjs');
const appIconFile = resolveDefaultAppIcon(appDir);
const rendererUrl = process.env.VITE_DEV_SERVER_URL && !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : pathToFileURL(rendererFile).href;
const headlessPackagedSmoke = isPackagedHeadlessSmoke(app.isPackaged, process.env);
const runtimeInventoryMode = process.env.LINEJS_RUNTIME_INVENTORY_MODE === '1';
if (runtimeInventoryMode && process.env.LOCALAPPDATA) app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'runtime-inventory-userdata'));
const csp = rendererContentSecurityPolicy(app.isPackaged, rendererUrl);

const workerEntry = resolveWorkerEntry(app.isPackaged, appDir, process.resourcesPath);
const migrationDirectory = resolveDatabaseMigrations(app.isPackaged, appDir, process.resourcesPath);
const jobHostFile = resolveJobHost(app.isPackaged, appDir, process.resourcesPath);
let service: DesktopServiceFacade = createDisconnectedFacade();
let connectedService: DesktopServiceFacade | undefined;
let operationalAudit: OperationalAudit | undefined;
let earlyAudit: OperationalAudit | undefined;
function reportRuntimeFailure(diagnostic: SafeDiagnostic, identity?: import('@line-agent/contracts').DiagnosticIdentity): void {
  if (operationalAudit) { operationalAudit.failure(diagnostic, identity); return; }
  if (!earlyAudit) {
    const fallback = new OperationalAuditFallback(path.join(new BootstrapSettings().root, 'logs', 'operational'));
    earlyAudit = createOperationalAudit({ append: (event) => fallback.append(event), appendFallback: (event) => fallback.append(event),
      logSinkState: (state, errorCode, droppedCount) => console.warn(JSON.stringify({ event: 'early_audit_sink', state, errorCode, droppedCount })) });
  }
  earlyAudit.failure(diagnostic, identity);
}
async function persistLifecycleFailure(failure: DesktopLifecycleFailure): Promise<void> {
  const diagnostic: SafeDiagnostic = failure === 'shutdown_timeout'
    ? { operation: 'shutdown', stage: 'shutdown', category: 'timeout', recovery: 'retry' }
    : { operation: 'shutdown', stage: 'shutdown', category: 'unknown', recovery: 'retry' };
  reportRuntimeFailure(diagnostic);
  await (operationalAudit ?? earlyAudit)?.flush();
}
let lineMediaProtocolRegistered = false;
const setupCutover = createSetupCutover({
  isConnected: () => connectedService !== undefined,
  fence: () => { service = createDisconnectedFacade('Database configuration in progress. Restart after saving setup.'); },
  shutdown: async () => { await connectedService!.shutdown(); connectedService = undefined; },
});

// One owner of the app-managed PostgreSQL postmaster (null for external databases).
let embeddedServer: EmbeddedPostgresServer | undefined;
const embeddedLog = (_message: string) => reportRuntimeFailure(diagnosticFailure('database', 'execute'));
/** Stops the embedded server after services have shut down; bounded at 45 s by the server itself. */
async function stopEmbeddedServer(): Promise<void> {
  const server = embeddedServer;
  if (!server) return;
  await server.stop();
  embeddedServer = undefined;
}

let window: BrowserWindow | null = null;
let localeSettings: ReturnType<typeof createLocaleSettings> | undefined;
let updateCheck: UpdateCheckService | undefined;
async function initializeLocaleSettings(): Promise<void> {
  localeSettings = createLocaleSettings({ filePath: path.join(app.getPath('userData'), 'app-settings.json'), preferredLanguages: app.getPreferredSystemLanguages() });
  setEffectiveLocaleReader(() => localeSettings?.snapshot().effectiveLocale ?? 'en');
  await localeSettings.load();
}
let windowGeometryPersistence: ReturnType<typeof createWindowGeometryPersistence> | undefined;
let tray: Tray | null = null;
const lifecycle = createDesktopLifecycle({ starting: true,
  hide: () => window?.hide(),
  closeServices: () => shutdownServices([
    () => (connectedService ?? service).shutdown(),
    stopEmbeddedServer,
  ]),
  relaunch: () => app.relaunch({ execPath: process.execPath, args: process.argv.slice(1).filter((argument) => argument !== '--quit' && argument !== '--restart') }),
  reportEvent: (event, command) => console.info(`[desktop-lifecycle] ${event.replaceAll('-', '_')} command=${command}`),
  reportFailure: persistLifecycleFailure,
  // Services have already drained. Do not route this through app.quit(): Electron's
  // window close/unload path can be vetoed or kept alive by a renderer. The
  // relauncher waits for this process to exit before starting the replacement.
  exit: () => { windowGeometryPersistence?.flush(); tray?.destroy(); fileTypeIcons.disable(); app.exit(0); },
});
const fileTypeIcons = createFileTypeIconResolver({ platform: process.platform, tempDirectory: app.getPath('temp'),
  getFileIcon: (filePath, options) => app.getFileIcon(filePath, options) });
app.once('will-quit', () => fileTypeIcons.disable());

async function initializeServices(): Promise<void> {
  const bootstrapSettings = new BootstrapSettings();
  let bootstrap = await bootstrapSettings.load();
  if (!bootstrap) { bootstrap = bootstrapFromEnvironment(process.env); if (bootstrap) await bootstrapSettings.save(bootstrap); }
  if (!bootstrap) return;
  const attachmentRoot = bootstrap.attachmentRoot;
  const startupCleanup = new StartupCleanup();
  try {
  if (bootstrap.embedded && !embeddedServer) {
    // Start the app-managed server before the first pool connects.
    const paths = embeddedPaths(await resolveCurrentEmbeddedRoot(), bootstrap.embedded.version);
    const server = new EmbeddedPostgresServer({ binDirectory: paths.bin, dataDirectory: paths.data, logFile: paths.log, port: bootstrap.embedded.port },
      createServerDeps(process.env, embeddedLog));
    await server.start({ fallbackPorts: true });
    embeddedServer = server;
    startupCleanup.add(() => stopEmbeddedServer());
    // A stored port held by another process moves the server to a free one; persist it before the pool connects.
    bootstrap = await persistMovedEmbeddedPort(bootstrap, server, (next) => bootstrapSettings.save(next), (message) => console.info(`[embedded-postgres] ${message}`));
  }
  let databaseUrl = bootstrap.databaseUrl;
  let embeddedConfiguration = bootstrap.embedded;
  const pool = embeddedConfiguration ? await connectWithPasswordRecovery({
    connect: async () => {
      const candidate = createPool(databaseUrl);
      try { await candidate.query('SELECT 1'); return candidate; }
      catch (error) { await candidate.end().catch(() => undefined); throw error; }
    },
    // Once per start: a crash between ALTER ROLE and the bootstrap save leaves bootstrap.json as the authority.
    recover: async () => {
      embeddedLog('pg_password_recovery');
      await stopEmbeddedServer();
      const recoveryConfiguration = embeddedConfiguration!;
      const paths = embeddedPaths(await resolveCurrentEmbeddedRoot(), recoveryConfiguration.version);
      // The effective port: the one the server actually started on and persisted.
      await resetAdminPasswordViaLocalSocket({ run: runProcess, fs: fsPromises, binDirectory: paths.bin, dataDirectory: paths.data, logFile: paths.log,
        port: recoveryConfiguration.port, env: process.env, password: passwordFromDatabaseUrl(databaseUrl),
        scratchParent: process.env.ProgramData ?? process.env.PROGRAMDATA ?? '', sid: await createSidReader(process.env)(), randomBytes });
      const server = new EmbeddedPostgresServer({ binDirectory: paths.bin, dataDirectory: paths.data, logFile: paths.log, port: recoveryConfiguration.port },
        createServerDeps(process.env, embeddedLog));
      await server.start({ fallbackPorts: true });
      embeddedServer = server;
      bootstrap = await persistMovedEmbeddedPort(bootstrap!, server, (next) => bootstrapSettings.save(next), (message) => console.info(`[embedded-postgres] ${message}`));
      databaseUrl = bootstrap.databaseUrl;
      embeddedConfiguration = bootstrap.embedded;
    },
  }) : createPool(databaseUrl);
  startupCleanup.add(() => pool.end());
  await migrate(pool, migrationDirectory);
  const audit = createOperationalAuditRuntime(pool, path.join(bootstrapSettings.root, 'logs', 'operational'));
  await earlyAudit?.flush();
  operationalAudit = audit;
  startupCleanup.add(() => audit.flush());
  const settings = new SettingsRepository(pool);
  const environmentWorkspace = process.env.LINE_AGENT_WORKSPACE;
  const defaultWorkspace = environmentWorkspace && path.isAbsolute(environmentWorkspace) ? environmentWorkspace : app.getPath('documents');
  const workspaceAuthority = await WorkspaceAuthority.load(settings, defaultWorkspace);
  const agents = new AgentRepository(pool);
  const messages = new MessageRepository(pool);
  const secretStore = new SecretStore(bootstrapSettings.root);
  let officialSnapshotImporter: OfficialSnapshotImporter | undefined;
  // One persisted trust document (app_settings.official_line_build_trust); no timer or watcher.
  const officialBuildTrust = new OfficialBuildTrustService({
    read: async () => {
      try { return await settings.getOfficialBuildTrust(); }
      catch (error) { audit.failure(diagnosticFailure('native_reader', 'read', error)); throw error; }
    },
    write: async (state) => {
      try { await settings.setOfficialBuildTrust(state); }
      catch (error) { audit.failure(diagnosticFailure('native_reader', 'persist', error)); throw error; }
    },
  });
  try {
    officialSnapshotImporter = await createJsOfficialSnapshotImporter({ packaged: app.isPackaged,
      appPath: app.getAppPath(), resourcesPath: process.resourcesPath, localAppData: process.env.LOCALAPPDATA,
      admission: mainExternalSourceProbeAdmission, buildTrust: officialBuildTrust });
  } catch (error) {
    reportRuntimeFailure(diagnosticFailure('native_reader', 'bootstrap', error));
  }
  const bridge = new AgentCliBridge({ enabled: agentBridgeEnabled(process.env), resolveWorkspaceRoots: async () => [await workspaceAuthority.current()], runner: new NodeProcessRunner({ hostFile: jobHostFile }),
    validateResumeSession: (request) => agents.validateResumeSession(request) });
  startupCleanup.add(() => bridge.shutdown());
  const workers = createUtilityWorkerGateway({
    onDiagnostic: (diagnostic, accountId) => audit.failure(diagnostic, { ...(accountId ? { accountId } : {}) }),
    onIngestLatency: (report) => audit.observed(report.kind === 'main' ? 'line_ingest_slow_main' : 'line_ingest_slow_upstream',
      { initiator: 'worker', accountId: report.accountId, workerInstanceId: report.workerInstanceId, latency: report.latency }),
    spawn(binding) {
      const child = utilityProcess.fork(workerEntry, [], {
        env: { SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
          PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA,
          LINE_WORKER_ATTACHMENT_ROOT: attachmentRoot }, serviceName: `line-worker-${binding.accountId}`,
      });
      return child;
    },
    durableCursor: (accountId, signal) => messages.getLiveCursor(accountId, signal),
  });
  startupCleanup.add(() => workers.shutdown());
  const previewPresenter = createElectronPreviewPresenter({
    reportError: (error) => audit.failure(diagnosticFailure('attachment', 'publish', error)),
    createSession: (partition) => session.fromPartition(partition, { cache: false }),
    createWindow: (options) => new BrowserWindow(options),
  });
  const publish = createDomainEventPublisher((channel, event) => window?.webContents.send(channel, event));
  const connected = await createConnectedFacade({ pool, workers, agent: bridge, workspaceAuthority, attachmentRoot: bootstrap.attachmentRoot,
    chatResourceDiagnosticsDirectory: app.getPath('userData'),
    locale: getEffectiveLocale(),
    mcpLocalClientAppPath: app.getAppPath(), mcpLocalClientPackaged: app.isPackaged,
    previewCacheRoot: path.join(app.getPath('userData'), 'cache', 'line-image-previews'),
    mediaCacheRoot: path.join(app.getPath('userData'), 'avatar-cache'),
    openAttachmentPath: (file) => shell.openPath(file), openFolderPath: (folder) => shell.openPath(folder), secretStore, audit, previewPresenter,
    closePoolOnShutdown: true, runMigrations: false, contentReprojection: true, officialBuildTrust,
    skillsDirectory: resolveSkillsDirectory(app.isPackaged, appDir, process.resourcesPath),
    ...(officialSnapshotImporter ? { officialSnapshotImporter } : {}),
    ...(officialSnapshotImporter && process.env.LOCALAPPDATA
      ? { externalImportProgressPath: path.join(process.env.LOCALAPPDATA, 'LINEJS', 'js-external-imports', 'first-import-progress.json') } : {}),
    ...(officialSnapshotImporter
      ? { externalMonitorDiagnosticPath: path.join(app.getPath('userData'), 'external-monitor-failure.json') } : {}),
    publish,
    beforeMcpListen: async () => {
      if (!lineMediaProtocolRegistered) {
        await session.defaultSession.protocol.handle('line-media', async (request) => {
          try {
            const target = parseLineMediaUrl(request.url);
            if (!target) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
            return await (connectedService ?? service).handleLineMedia?.(target, request.signal)
              ?? new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
          } catch {
            return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
          }
        });
        lineMediaProtocolRegistered = true;
      }
    } });
  service = connected;
  connectedService = connected;
  startupCleanup.commit();
  } catch (error) {
    reportRuntimeFailure(diagnosticFailure('startup', 'bootstrap', error));
    await startupCleanup.unwind(error);
    throw error;
  }
}

function installSecurity() {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url !== rendererUrl) { callback({ responseHeaders: details.responseHeaders ?? {} }); return; }
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, target) => { if (!isAllowedNavigation(target, rendererUrl)) event.preventDefault(); });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

async function createWindow(setupOnly = false) {
  const windowOptions = createMainWindowOptions(appIconFile, preloadFile);
  const geometryFile = path.join(app.getPath('userData'), 'main-window-geometry.json');
  const workAreas = () => screen.getAllDisplays().map((display) => display.workArea);
  const savedGeometry = setupOnly ? undefined : readWindowGeometry({ filePath: geometryFile,
    defaultBounds: { x: 0, y: 0, width: windowOptions.width!, height: windowOptions.height! },
    minWidth: windowOptions.minWidth!, minHeight: windowOptions.minHeight!, workAreas: workAreas() });
  const restoredOptions = savedGeometry?.restored ? {
    x: savedGeometry.bounds.x, y: savedGeometry.bounds.y,
    width: savedGeometry.bounds.width, height: savedGeometry.bounds.height,
  } : {};
  window = new BrowserWindow(setupOnly
    ? { ...windowOptions, width: 520, height: 360, minWidth: 520, minHeight: 360, resizable: false, maximizable: false }
    : { ...windowOptions, ...restoredOptions });
  if (!setupOnly && savedGeometry) {
    windowGeometryPersistence?.dispose();
    windowGeometryPersistence = createWindowGeometryPersistence({
      window,
      filePath: geometryFile,
      initial: { bounds: window.getNormalBounds(), maximized: window.isMaximized(), restored: true },
      workAreas,
    });
  }
  const view = window.webContents;
  const request = createIpcAdapter({ webContentsId: view.id, rendererUrl, resolveService: () => service,
    onDiagnostic: reportRuntimeFailure,
    resolveFileTypeIcon: (extension) => fileTypeIcons.resolve(extension),
    openExternalUrl: (url) => shell.openExternal(url) });
  const read = createReadAdapter({ webContentsId: view.id, rendererUrl, resolveService: () => service, onDiagnostic: reportRuntimeFailure });
  const bootstrapSettings = new BootstrapSettings();
  const defaultDataRoot = path.join(bootstrapSettings.root, 'data');
  const setup = new DatabaseSetupService({ createPool,
    migrate: async (pool, directory) => migrate(pool as ReturnType<typeof createPool>, directory),
    save: (configuration) => bootstrapSettings.save(configuration),
    load: () => bootstrapSettings.load(), ensureDirectory: (directory) => mkdir(directory, { recursive: true }), migrationDirectory,
    defaultAttachmentRoot: path.join(defaultDataRoot, 'attachments'), defaultAgentWorkspace: path.join(defaultDataRoot, 'agent-workspace') });
  const attachmentRootChange = createAttachmentRootChange({ settings: bootstrapSettings, getAgentWorkspace: async () => (await setup.status()).agentWorkspace,
    getAdditionalProtectedPaths: async (configuration) => configuration.embedded
      ? [embeddedPaths(await resolveCurrentEmbeddedRoot(), configuration.embedded.version).data] : [],
    runCutover: (work) => setupCutover.save(work),
    pick: async () => {
      const result = await dialog.showOpenDialog(window!, { title: nativeDesktopText(getEffectiveLocale(), 'newAttachmentFolder'), properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    open: async (directory) => { const error = await shell.openPath(directory); if (error) throw new Error('無法開啟附件資料夾。'); },
  });
  let provisionAbort: AbortController | undefined;
  const provisioner = new EmbeddedPostgresProvisioner(createNodeProvisionerDeps({ log: embeddedLog,
    ensureDatabase: async (adminUrl, name) => {
      const pool = createPool(adminUrl);
      try {
        const found = await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
        if (found.rows.length === 0) await pool.query(`CREATE DATABASE "${name}"`);
      } finally { await pool.end(); }
    },
    saveBootstrap: (configuration) => bootstrapSettings.save({ ...configuration, attachmentRoot: path.join(defaultDataRoot, 'attachments') }),
    registerServer: (server) => { embeddedServer = server; } }));
  const embedded: EmbeddedSetupPort = {
    async start() {
      if (provisionAbort || embeddedServer) throw new Error('Embedded PostgreSQL is already provisioned or running');
      const controller = new AbortController();
      provisionAbort = controller;
      try {
        await provisioner.provision({ signal: controller.signal,
          onProgress: (event) => { if (!view.isDestroyed()) view.send(SETUP_PROGRESS_CHANNEL, event); } });
      } finally { provisionAbort = undefined; }
    },
    cancel() { provisionAbort?.abort(); },
    changePassword: (password) => changeEmbeddedPassword({ load: () => bootstrapSettings.load(), save: (configuration) => bootstrapSettings.save(configuration),
      setRolePassword: (url, verifier) => setRolePassword((poolUrl) => createPool(poolUrl), url, verifier), log: embeddedLog }, password),
    async connectionInfo() {
      const configuration = await bootstrapSettings.load();
      if (!configuration?.embedded) throw new Error('Embedded PostgreSQL is not configured');
      const url = new URL(configuration.databaseUrl);
      return { version: configuration.embedded.version, host: url.hostname, port: Number(url.port), username: decodeURIComponent(url.username),
        database: decodeURIComponent(url.pathname.slice(1)), url: configuration.databaseUrl, password: decodeURIComponent(url.password) };
    },
  };
  // Installer-time mode: no services exist, so success only needs the embedded server stopped before exit 0.
  const setupSession = setupOnly ? createFirstRunSetupSession({ cancelProvision: () => embedded.cancel(),
    stopServices: () => stopEmbeddedServer(), exit: (code) => app.exit(code) }) : undefined;
  const setupRequest = createSetupAdapter({ webContentsId: view.id, rendererUrl, setup, embedded, attachmentRootChange,
    onDiagnostic: reportRuntimeFailure,
    runSetupSave: setupCutover.save,
    chooseAttachmentRoot: async () => {
      const result = await dialog.showOpenDialog(window!, { title: nativeDesktopText(getEffectiveLocale(), 'attachmentFolder'), properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    chooseAgentWorkspace: async () => {
      const result = await dialog.showOpenDialog(window!, { title: nativeDesktopText(getEffectiveLocale(), 'agentWorkspace'), properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    restartApplication: () => setupSession ? setupSession.succeeded() : lifecycle.request('restart'),
  });
  const localeRequest = createLocaleIpcAdapter({ webContentsId: view.id, rendererUrl, settings: localeSettings! });
  ipcMain.removeHandler('line-agent:locale');
  ipcMain.handle('line-agent:locale', async (event, payload: unknown) => {
    return localeRequest({ senderId: event.sender.id, url: event.senderFrame?.url ?? '' }, payload);
  });
  updateCheck ??= createUpdateCheckService({ currentVersion: app.getVersion(), fetch: (url, init) => net.fetch(url, init),
    canAutoInstall: app.isPackaged, getUpdater: loadAppUpdater, prepareInstall: () => lifecycle.prepareExit(),
    store: createFileUpdateCheckStore(path.join(app.getPath('userData'), 'update-check.json')),
    openExternal: (url) => shell.openExternal(url),
    onChange: (state) => { if (window && !window.isDestroyed()) window.webContents.send(UPDATE_CHECK_STATE_CHANNEL, state); } });
  const updateCheckRequest = createUpdateCheckIpcAdapter({ webContentsId: view.id, rendererUrl, service: updateCheck });
  ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
  ipcMain.handle(UPDATE_CHECK_CHANNEL, (event, payload: unknown) => updateCheckRequest({ senderId: event.sender.id, url: event.senderFrame?.url ?? '' }, payload));
  if (!setupOnly) void updateCheck.start().catch(() => undefined);
  ipcMain.removeHandler('line-agent:request'); ipcMain.removeHandler('line-agent:read'); ipcMain.removeHandler('line-agent:setup');
  ipcMain.handle('line-agent:request', (event, payload: unknown) => request({ senderId: event.sender.id, url: event.senderFrame?.url ?? '' }, payload));
  ipcMain.handle('line-agent:read', (event, payload: unknown) => read({ senderId: event.sender.id, url: event.senderFrame?.url ?? '' }, payload));
  ipcMain.handle('line-agent:setup', (event, payload: unknown) => setupRequest({ senderId: event.sender.id, url: event.senderFrame?.url ?? '' }, payload));
  registerMainWindowReadyDisplay(window, {
    headless: headlessPackagedSmoke,
    runtimeInventory: runtimeInventoryMode,
    maximized: !setupOnly && savedGeometry?.maximized === true,
  });
  if (setupSession) window.on('close', () => { void setupSession.windowClosed().catch(() => undefined); });
  else window.on('close', (event) => { windowGeometryPersistence?.flush(); if (!lifecycle.onClose()) event.preventDefault(); });
  if (rendererUrl.startsWith('file:')) await window.loadFile(rendererFile);
  else await window.loadURL(rendererUrl);
}

async function runRuntimeInventorySession(): Promise<void> {
  const channels = [...((ipcMain as unknown as { _invokeHandlers?: Map<string, unknown> })._invokeHandlers?.keys() ?? [])];
  const resourceSnapshot = () => ({ capturedAt: new Date().toISOString(), appListenerCount: app.eventNames().reduce((sum, name) => sum + app.listenerCount(name), 0),
    ipcListenerCount: ipcMain.eventNames().reduce((sum, name) => sum + ipcMain.listenerCount(name), 0),
    activeResources: process.getActiveResourcesInfo(), rssBytes: process.memoryUsage().rss });
  const whitelistPattern = /friend[-_ ]?whitelist|friendWhitelist|whitelistDispatcher/i;
  const whitelistListenerCount = [...app.eventNames(), ...ipcMain.eventNames()].filter((name) => whitelistPattern.test(String(name)))
    .reduce((sum, name) => sum + app.listenerCount(name) + ipcMain.listenerCount(name as string), 0);
  console.log(JSON.stringify({ marker: 'LINEJS_RUNTIME_INVENTORY_READY', pid: process.pid, featureEnabled: false, serviceName: service.constructor.name,
    ipcInvokeChannels: channels, whitelistInvokeChannels: channels.filter((name) => whitelistPattern.test(name)), whitelistListenerCount,
    whitelistTimerCount: process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length,
    ...resourceSnapshot() }));
  const idleStartedAt = Date.now();
  await delay(Math.max(0, Number(process.env.LINEJS_RUNTIME_INVENTORY_IDLE_SOAK_MS) || 0) + 500);
  console.log(JSON.stringify({ marker: 'LINEJS_RUNTIME_INVENTORY_IDLE_END', idleSoakElapsedMs: Date.now() - idleStartedAt, ...resourceSnapshot() }));
  const signalPath = process.env.LINEJS_RUNTIME_INVENTORY_SIGNAL_DIR;
  async function waitForSignal(name: string) {
    if (!signalPath) throw new Error('Runtime inventory signal directory was not configured');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { await access(path.join(signalPath, name)); return; }
      catch { await delay(25); }
    }
    throw new Error(`Runtime inventory observer did not acknowledge ${name}`);
  }

  let child: ReturnType<typeof utilityProcess.fork> | undefined;
  const spawnedProcesses: Promise<void>[] = [];
  const spawnedProcessPids: number[] = [];
  let statusEvents = 0;
  const workers = createUtilityWorkerGateway({
    spawn: () => {
      child = utilityProcess.fork(path.join(appDir, 'runtime-inventory-worker.mjs'), [], { serviceName: 'runtime-inventory-fixture', stdio: 'inherit' });
      spawnedProcesses.push(new Promise((resolve) => child!.once('spawn', () => resolve())));
      child.once('spawn', () => { if (child?.pid) spawnedProcessPids.push(child.pid); });
      return child;
    },
    pollIntervalMs: 60_000,
    responseTimeoutMs: 5_000,
    stopTimeoutMs: 5_000,
  });
  workers.onEvent(async (_workerInstanceId, event) => {
    if (event.type === 'status' && event.message?.startsWith('inventory-')) statusEvents += 1;
  });
  const admissionBindings = Array.from({ length: MAX_UTILITY_WORKERS }, (_, index) => ({ accountId: `runtime-cap-${index}`,
    workerInstanceId: `runtime-cap-worker-${index}`, controlEpoch: 1, mode: 'MONITOR_ONLY' as const }));
  await Promise.all(admissionBindings.map((binding) => workers.start(binding.accountId, binding)));
  await Promise.all(spawnedProcesses);
  const admissionAtCap = workers.inventory?.() ?? null;
  console.log(JSON.stringify({ marker: 'LINEJS_RUNTIME_INVENTORY_CAP_READY', workerPids: [...spawnedProcessPids], inventory: admissionAtCap }));
  await waitForSignal('cap-continue');
  let fifthWorkerRejected = false;
  try { await workers.start('runtime-cap-overflow', { accountId: 'runtime-cap-overflow', workerInstanceId: 'runtime-cap-overflow-worker',
    controlEpoch: 1, mode: 'MONITOR_ONLY' }); }
  catch (error) { fifthWorkerRejected = error instanceof Error && /global worker limit/i.test(error.message); }
  await workers.shutdown();
  const admissionAfterShutdown = workers.inventory?.() ?? null;
  const workerAdmission = { configuredCap: MAX_UTILITY_WORKERS, acceptedAtCap: admissionAtCap?.activeWorkers ?? null,
    fifthWorkerRejected, activeWhenRejected: admissionAtCap?.activeWorkers ?? null, afterShutdown: admissionAfterShutdown };
  const binding = { accountId: 'runtime-inventory', workerInstanceId: `runtime-${Date.now()}`, controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  try {
    await workers.start(binding.accountId, binding);
    await spawnedProcesses.at(-1);
    const workloadWorkerPid = spawnedProcessPids.at(-1) ?? null;
    console.log(JSON.stringify({ marker: 'LINEJS_RUNTIME_INVENTORY_WORKER_READY', workerPid: workloadWorkerPid,
      inventory: workers.inventory?.() ?? null }));
    await waitForSignal('burst-continue');
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Utility-worker runtime inventory exceeded 30-second deadline; statusEvents=${statusEvents}; inventory=${JSON.stringify(workers.inventory?.())}`)), 30_000);
      child!.postMessage({ type: 'runtimeInventoryBurst', count: 10_000 });
      poll = setInterval(() => { if (statusEvents >= 10_000) { if (poll) clearInterval(poll); resolve(); } }, 10);
    });
    const during = workers.inventory?.() ?? null;
    await workers.shutdown();
    console.log(JSON.stringify({ marker: 'LINEJS_RUNTIME_INVENTORY_BURST', statusEvents, idleSoakElapsedMs: Date.now() - idleStartedAt,
      workerAdmission, during, afterShutdown: workers.inventory?.() ?? null,
      workloadWorkerPid,
      ...resourceSnapshot() }));
  } finally {
    if (timeout) clearTimeout(timeout);
    if (poll) clearInterval(poll);
    await workers.shutdown();
  }
}

function updateTrayMenu() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: nativeDesktopText(getEffectiveLocale(), 'showConsole'), click: () => { window?.show(); window?.focus(); } },
    { label: nativeDesktopText(getEffectiveLocale(), 'quit'), click: () => void lifecycle.quit() },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(appIconFile);
  if (icon.isEmpty()) throw new Error(`Application icon could not be loaded: ${appIconFile}`);
  tray = new Tray(icon);
  tray.setToolTip('LINE Agent Assistant');
  updateTrayMenu();
  tray.on('double-click', () => window?.show());
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

const firstRunSetupOnly = isFirstRunSetupMode(process.argv);
const initialCommand = parseDesktopCommand(process.argv.slice(1));

if (!hasSingleInstanceLock) {
  if (firstRunSetupOnly) app.exit(0);
  else app.quit();
} else if (initialCommand === 'quit') {
  // A command launched without another primary instance has nothing to drain.
  app.exit(0);
} else if (firstRunSetupOnly) {
  // Installer-time mode: only the setup window and the embedded provisioner; no services, tray or inventory.
  app.on('window-all-closed', () => { /* exit is owned by the setup session */ });
  app.whenReady().then(async () => {
    await initializeLocaleSettings();
    const decision = await decideFirstRunSetup({ hasLock: hasSingleInstanceLock, bootstrapExists: async () => (await new BootstrapSettings().load()) !== null });
    if (decision === 'exit') { app.exit(0); return; }
    installSecurity();
    await createWindow(true);
  }).catch(async (error: unknown) => { reportRuntimeFailure(diagnosticFailure('startup', 'bootstrap', error)); await earlyAudit?.flush(); app.exit(1); });
} else {
  app.on('second-instance', (_event, commandLine) => {
    console.info('[desktop-lifecycle] second_instance_received');
    routeSecondInstance(commandLine.slice(1), (command) => lifecycle.request(command), () => {
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }, (classification, command) => console.info(`[desktop-lifecycle] second_instance_${classification}${command ? ` command=${command}` : ''}`));
  });

  app.whenReady().then(async () => {
    await initializeLocaleSettings();
    installSecurity();
    try { await initializeServices(); }
    catch (error) { reportRuntimeFailure(diagnosticFailure('startup', 'bootstrap', error)); service = createDisconnectedFacade('System startup failed. Check configuration and System Errors.'); }
    await createWindow();
    if (runtimeInventoryMode) {
      await runRuntimeInventorySession();
      await service.shutdown();
      window?.destroy();
      await delay(500);
      console.log(JSON.stringify({ marker: 'LINEJS_RUNTIME_INVENTORY_SHUTDOWN', capturedAt: new Date().toISOString(), activeResources: process.getActiveResourcesInfo(),
        appListenerCount: app.eventNames().reduce((sum, name) => sum + app.listenerCount(name), 0),
        ipcListenerCount: ipcMain.eventNames().reduce((sum, name) => sum + ipcMain.listenerCount(name), 0), rssBytes: process.memoryUsage().rss }));
      app.exit(0);
      return;
    }
    if (!headlessPackagedSmoke) createTray();
    lifecycle.markRunning();
  }).catch(async (error: unknown) => {
    reportRuntimeFailure(diagnosticFailure('startup', 'bootstrap', error));
    try { await earlyAudit?.flush(); }
    finally { lifecycle.request('quit'); lifecycle.markRunning(); }
  });
  app.on('window-all-closed', () => { /* keep tray resident */ });
  app.on('activate', () => { if (headlessPackagedSmoke) return; if (window) window.show(); else void createWindow(); });
  app.on('before-quit', (event) => { windowGeometryPersistence?.flush(); if (lifecycle && !lifecycle.onBeforeQuit()) event.preventDefault(); });
}
