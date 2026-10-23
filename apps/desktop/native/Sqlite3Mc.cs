using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Collections;
using System.Web.Script.Serialization;

internal sealed partial class Sqlite3Mc : IDisposable {
#if READER_OFFICIAL_SOURCE_TEST
  // The fixture build advances the same coalesced progress path more often.
  const int ScanProgressCadenceMs = 200;
#else
  const int ScanProgressCadenceMs = 500;
#endif
#if READER_OFFICIAL_SOURCE_TEST
  internal static Action<CancellationToken> TestBeforeOfficialQuery;
#endif
  const int OpenReadOnlyFlag = 1;
  const int OpenReadWrite = 2;
  const int OpenReadWriteCreate = 6;
  const int Row = 100;
  const int Done = 101;
  const int AuthorizerDeny = 1;
  const int AuthorizerSelect = 21;
  const int AuthorizerRead = 20;
  const int AuthorizerFunction = 31;
  const int MaxCellBytes = 8 * 1024 * 1024;
  const int MaxResultBytes = 16 * 1024 * 1024;
  const int MaxTailSourceRows = 50;
  const long MonitorMessageFrameBytes = 1024L * 1024;
  const long InitialImportMessageFrameBytes = 8L * 1024 * 1024;
  const int MaxRows = 2000;
  const int InitialImportWindowRows = 30000;
  const int InitialImportMaxCursorChars = 512;
  const long InitialImportWindowChunkReserveBytes = (InitialImportPageFrameBytes - 65536L) / 3L + 2000L * (128L + InitialImportMaxCursorChars + 20L) + 65536L;
  const long InitialImportPageFrameBytes = 8L * 1024 * 1024;
  const long InitialImportHeapLimitBytes = 128L * 1024 * 1024;
  const string DllSha256 = "5030decc6d914539e3b9b7e28aa4f6de1e7161dac6fd4b21eb02e6754d9b175e";
  internal static readonly string[] NativeMessageColumnNames = new string[] {
    "_from", "_to", "_toType", "_id", "_createdTime", "_deliveredTime", "_text", "_location", "_hasContent",
    "_contentType", "_contentMetadata", "_contentPreview", "_sessionId", "_chunks", "_relatedMessageId",
    "_messageRelationType", "_readCount", "_relatedMessageServiceCode", "_appExtensionType", "_reactions", "_type",
    "_status", "_chatId", "_reqSeqV2", "_reqSeq", "_contentInfo", "_eventInfo", "_rev", "_errorCode", "_urlPreview",
    "_hasUrlPreview", "_syncToken", "_fromType", "_attribute", "_flag", "_reactionStatus"
  };
  static readonly string[] NativeCatalogTableNames = new string[] {
    "_chat", "_chatOption", "_contact", "_profile", "_profileMappedId", "_groupChat", "_room", "_square",
    "_squareChat", "_squareMember", "_squareThread", "_squareBot", "_buddyDetail", "_buddyStatusBar",
    "_message_sticker", "_stickerProductNew", "_sticker_history", "_sticonProduct", "_sticon_mapping"
  };
  static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
  static readonly object EngineGate = new object();
  static IntPtr sharedModule;
  static string sharedModulePath;

  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int OpenV2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int CloseV2(IntPtr db);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int DbReadonly(IntPtr db, byte[] schema);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int McConfig(IntPtr db, byte[] name, int value);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int McConfigCipher(IntPtr db, byte[] cipher, byte[] name, int value);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int CipherIndex(byte[] cipher);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Key(IntPtr db, byte[] key, int length);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int BusyTimeout(IntPtr db, int milliseconds);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Limit(IntPtr db, int category, int value);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Prepare(IntPtr db, byte[] sql, int length, out IntPtr statement, out IntPtr tail);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int BindText(IntPtr statement, int index, byte[] value, int length, IntPtr destructor);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int BindInt64(IntPtr statement, int index, long value);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int BindNull(IntPtr statement, int index);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Reset(IntPtr statement);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Step(IntPtr statement);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Finalize(IntPtr statement);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int ColumnCount(IntPtr statement);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int ColumnType(IntPtr statement, int column);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate long ColumnInt64(IntPtr statement, int column);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate double ColumnDouble(IntPtr statement, int column);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr ColumnBytesPtr(IntPtr statement, int column);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int ColumnBytes(IntPtr statement, int column);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr ColumnName(IntPtr statement, int column);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int ErrorCode(IntPtr db);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int StatementStatus(IntPtr statement, int operation, int reset);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate long HardHeapLimit64(long limitBytes);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int SetAuthorizer(IntPtr db, AuthorizerCallback callback, IntPtr user);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int AuthorizerCallback(IntPtr user, int action, IntPtr arg1, IntPtr arg2, IntPtr database, IntPtr trigger);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int ProgressCallback(IntPtr user);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void ProgressHandler(IntPtr db, int opcodes, ProgressCallback callback, IntPtr user);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr Version();
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr BackupInit(IntPtr destination, byte[] destinationName, IntPtr source, byte[] sourceName);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int BackupStep(IntPtr backup, int pages);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int BackupRemaining(IntPtr backup);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int BackupPageCount(IntPtr backup);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int BackupFinish(IntPtr backup);

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string filename, IntPtr file, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Ansi, SetLastError=true)] static extern IntPtr GetProcAddress(IntPtr module, string name);
  readonly IntPtr module;
  readonly OpenV2 openV2;
  readonly CloseV2 closeV2;
  readonly DbReadonly dbReadonly;
  readonly McConfig mcConfig;
  readonly McConfigCipher mcConfigCipher;
  readonly CipherIndex cipherIndex;
  readonly Key key;
  readonly BusyTimeout busyTimeout;
  readonly Limit limit;
  readonly Prepare prepare;
  readonly BindText bindText;
  readonly BindInt64 bindInt64;
  readonly BindNull bindNull;
  readonly Reset reset;
  readonly Step step;
  readonly Finalize finalize;
  readonly ColumnCount columnCount;
  readonly ColumnType columnType;
  readonly ColumnInt64 columnInt64;
  readonly ColumnDouble columnDouble;
  readonly ColumnBytesPtr columnText;
  readonly ColumnBytesPtr columnBlob;
  readonly ColumnBytes columnBytes;
  readonly ColumnName columnName;
  readonly SetAuthorizer setAuthorizer;
  readonly ProgressHandler progressHandler;
  readonly Version sqliteVersion;
  readonly Version cipherVersion;
  readonly BackupInit backupInit;
  readonly BackupStep backupStep;
  readonly BackupRemaining backupRemaining;
  readonly BackupPageCount backupPageCount;
  readonly BackupFinish backupFinish;
  readonly ErrorCode extendedErrorCode;
  readonly StatementStatus statementStatus;
  readonly HardHeapLimit64 hardHeapLimit64;
  readonly bool readOnly;
  readonly bool diagnosticMode;
  readonly string databasePath;
  IntPtr db;
  AuthorizerCallback authorizer;
  AuthorizerCallback readAuthorizer;
  Dictionary<string, string[]> readAuthorizerTables;
  bool windowReadAuthorizerActive;
  bool allowCatalogPragma;
  string catalogPragmaTable;
  NativeCatalogPager catalogPager;
  ProgressCallback progressCallback;
  Action<string, long> scanProgress;
  string scanProgressPhase;
  long scanSteps, lastReportedScanSteps;
  long lastScanProgressTimestamp;
  Exception scanProgressError;
  CancellationToken scanCancellation;
  bool hasScanCancellation;
  string lastStage = "startup";
  int lastPrimaryCode;
  int lastExtendedCode;

  Sqlite3Mc(string databasePath, byte[] passphrase, bool isReadOnly, bool fixtureWriter, bool captureDiagnostics = false) {
    this.databasePath = Path.GetFullPath(databasePath);
    readOnly = isReadOnly;
    diagnosticMode = captureDiagnostics;
    module = AcquireModule();
    try {
      openV2 = Load<OpenV2>("sqlite3_open_v2");
      closeV2 = Load<CloseV2>("sqlite3_close_v2");
      dbReadonly = Load<DbReadonly>("sqlite3_db_readonly");
      mcConfig = Load<McConfig>("sqlite3mc_config");
      mcConfigCipher = Load<McConfigCipher>("sqlite3mc_config_cipher");
      cipherIndex = Load<CipherIndex>("sqlite3mc_cipher_index");
      key = Load<Key>("sqlite3_key");
      busyTimeout = Load<BusyTimeout>("sqlite3_busy_timeout");
      limit = Load<Limit>("sqlite3_limit");
      prepare = Load<Prepare>("sqlite3_prepare_v2");
      bindText = Load<BindText>("sqlite3_bind_text");
      bindInt64 = Load<BindInt64>("sqlite3_bind_int64");
      bindNull = Load<BindNull>("sqlite3_bind_null");
      reset = Load<Reset>("sqlite3_reset");
      step = Load<Step>("sqlite3_step");
      finalize = Load<Finalize>("sqlite3_finalize");
      columnCount = Load<ColumnCount>("sqlite3_column_count");
      columnType = Load<ColumnType>("sqlite3_column_type");
      columnInt64 = Load<ColumnInt64>("sqlite3_column_int64");
      columnDouble = Load<ColumnDouble>("sqlite3_column_double");
      columnText = Load<ColumnBytesPtr>("sqlite3_column_text");
      columnBlob = Load<ColumnBytesPtr>("sqlite3_column_blob");
      columnBytes = Load<ColumnBytes>("sqlite3_column_bytes");
      columnName = Load<ColumnName>("sqlite3_column_name");
      setAuthorizer = Load<SetAuthorizer>("sqlite3_set_authorizer");
      progressHandler = Load<ProgressHandler>("sqlite3_progress_handler");
      sqliteVersion = Load<Version>("sqlite3_libversion");
      cipherVersion = Load<Version>("sqlite3mc_version");
      backupInit = Load<BackupInit>("sqlite3_backup_init");
      backupStep = Load<BackupStep>("sqlite3_backup_step");
      backupRemaining = Load<BackupRemaining>("sqlite3_backup_remaining");
      backupPageCount = Load<BackupPageCount>("sqlite3_backup_pagecount");
      backupFinish = Load<BackupFinish>("sqlite3_backup_finish");
      extendedErrorCode = Load<ErrorCode>("sqlite3_extended_errcode");
      statementStatus = Load<StatementStatus>("sqlite3_stmt_status");
      hardHeapLimit64 = Load<HardHeapLimit64>("sqlite3_hard_heap_limit64");

      lastStage = "open";
      byte[] pathBytes = Utf8Z(Path.GetFullPath(databasePath));
      int openFlags = isReadOnly ? OpenReadOnlyFlag : (fixtureWriter ? OpenReadWriteCreate : OpenReadWrite);
      Check(openV2(pathBytes, out db, openFlags, IntPtr.Zero));
      Array.Clear(pathBytes, 0, pathBytes.Length);
      lastStage = "readonly_check";
      if (isReadOnly && dbReadonly(db, Utf8Z("main")) != 1) throw new InvalidOperationException("SOURCE_NOT_READONLY");
      ConfigureKey(passphrase);
      Check(busyTimeout(db, 1000));
      limit(db, 0, MaxCellBytes);
      RunPragma("PRAGMA trusted_schema=OFF");
      RunPragma("PRAGMA temp_store=MEMORY");
      if (isReadOnly) RunPragma("PRAGMA query_only=ON");
    } catch {
      Dispose();
      throw;
    }
  }

  internal static Sqlite3Mc OpenReadOnly(string path, byte[] key) { return new Sqlite3Mc(path, key, true, false); }
  internal static Sqlite3Mc OpenBackupDestination(string path, byte[] key) { return new Sqlite3Mc(path, key, false, false); }
  internal void BackupTo(string destinationPath, byte[] keyBytes, string expectedMid, CancellationToken cancellation,
      long maxDatabaseBytes, long maxWalBytes, long maxSnapshotBytes, Action<long, long> progress) {
    if (!readOnly || String.IsNullOrEmpty(destinationPath) || keyBytes == null || maxDatabaseBytes < 1 || maxWalBytes < 0 || maxSnapshotBytes < 1 || progress == null)
      throw new InvalidOperationException("snapshot_request_invalid");
    bool transaction = false;
#if SQLITE_FIXTURE_WRITER
    if (TestBeforeBackupDestinationOpen != null) { Action replacement = TestBeforeBackupDestinationOpen; TestBeforeBackupDestinationOpen = null; replacement(); }
#endif
    using (Sqlite3Mc destination = OpenBackupDestination(destinationPath, keyBytes)) {
      IntPtr handle = IntPtr.Zero;
      Exception failure = null;
      try {
        RunStatement("BEGIN"); transaction = true;
        if (!VerifyOfficialSchemaAndMid(expectedMid, cancellation)) throw new InvalidDataException("mid_or_schema_mismatch");
        long pageSize = ReadPageSize();
        cancellation.ThrowIfCancellationRequested();
        destination.RunStatement("PRAGMA journal_mode=OFF");
        destination.RunStatement("PRAGMA synchronous=OFF");
        handle = backupInit(destination.db, Utf8Z("main"), db, Utf8Z("main"));
        if (handle == IntPtr.Zero) throw new InvalidOperationException("snapshot_backup_init_failed");
        long lastProgressAt = BackupTimestamp();
        int lastCopiedPages = 0;
        while (true) {
          cancellation.ThrowIfCancellationRequested();
          CheckBackupSourceBounds(maxDatabaseBytes, maxWalBytes);
          int state = InvokeBackupStep(handle, 256);
          int pageCount = backupPageCount(handle), remaining = backupRemaining(handle);
          if (pageCount < 0 || remaining < 0 || remaining > pageCount) throw new InvalidOperationException("snapshot_backup_failed");
          long copiedPages = pageCount - remaining;
          long copiedBytes = checked(copiedPages * pageSize);
          long totalBytes = checked((long)pageCount * pageSize);
          if (totalBytes > maxSnapshotBytes) throw new InvalidOperationException("snapshot_size_limit");
          progress(copiedBytes, totalBytes);
#if SQLITE_FIXTURE_WRITER
          if (TestBackupAfterBatch != null) { Action mutation = TestBackupAfterBatch; TestBackupAfterBatch = null; mutation(); }
#endif
          if (copiedPages > lastCopiedPages) { lastCopiedPages = (int)copiedPages; lastProgressAt = BackupTimestamp(); }
          else if (BackupTimestamp() - lastProgressAt >= Stopwatch.Frequency * 120L) throw new InvalidOperationException("snapshot_backup_no_progress");
          if (state == Done) break;
          if (state != 0 && state != 5 && state != 6) throw new InvalidOperationException("snapshot_backup_failed");
          if (state == 5 || state == 6) cancellation.WaitHandle.WaitOne(25);
        }
      } catch (Exception error) { failure = error; throw; }
      finally {
        try {
          if (handle != IntPtr.Zero) {
            int finishState = backupFinish(handle); handle = IntPtr.Zero;
            if (finishState != 0 && failure == null && !cancellation.IsCancellationRequested) throw new InvalidOperationException("snapshot_backup_failed");
          }
          if (failure == null && !cancellation.IsCancellationRequested) destination.DisableJournalMode();
        } finally {
          if (transaction) RunStatement("ROLLBACK");
        }
      }
    }
  }
  void CheckBackupSourceBounds(long maxDatabaseBytes, long maxWalBytes) {
    try {
      FileInfo database = new FileInfo(databasePath), wal = new FileInfo(databasePath + "-wal");
      if (!database.Exists || database.Length > maxDatabaseBytes || (wal.Exists && wal.Length > maxWalBytes))
        throw new InvalidOperationException("snapshot_size_limit");
    } catch (InvalidOperationException) { throw; }
    catch { throw new InvalidOperationException("snapshot_source_unavailable"); }
  }
  long ReadPageSize() {
    List<object[]> rows = Query("PRAGMA page_size");
    if (rows.Count != 1 || rows[0].Length != 1 || !(rows[0][0] is long)) throw new InvalidOperationException("snapshot_backup_failed");
    long pageSize = (long)rows[0][0];
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) != 0) throw new InvalidOperationException("snapshot_backup_failed");
    return pageSize;
  }
  int InvokeBackupStep(IntPtr handle, int pages) {
#if SQLITE_FIXTURE_WRITER
    if (TestBackupStepOverride != null) return TestBackupStepOverride(handle, pages);
#endif
    return backupStep(handle, pages);
  }
  long BackupTimestamp() {
#if SQLITE_FIXTURE_WRITER
    if (TestBackupTimestamp != null) return TestBackupTimestamp();
#endif
    return Stopwatch.GetTimestamp();
  }
  void DisableJournalMode() {
    List<object[]> rows = Query("PRAGMA journal_mode=OFF");
    if (rows.Count != 1 || rows[0].Length != 1 || !(rows[0][0] is string) || !String.Equals((string)rows[0][0], "off", StringComparison.OrdinalIgnoreCase))
      throw new InvalidOperationException("snapshot_backup_failed");
  }
  internal string DiagnosticSummary { get { return Summary(); } }
  internal void SetDiagnosticStage(string stage) { lastStage = stage; }
  internal bool VerifySchemaReadable() {
    SetSchemaAuthorizer();
    try {
      List<object[]> rows = Query("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1");
      return rows.Count == 1 && rows[0].Length == 1 && rows[0][0] is string && ((string)rows[0][0]).Length > 0;
    } finally { ClearAuthorizer(); }
  }
  internal bool VerifyLineProfileMid(string expectedMid) {
    if (String.IsNullOrEmpty(expectedMid) || expectedMid.Length > 200 || expectedMid.IndexOf('\0') >= 0) return false;
    SetProfileAuthorizer();
    try {
      List<object[]> rows = Query("SELECT _mid FROM _profile LIMIT 3");
      return rows.Count == 1 && rows[0].Length == 1 && rows[0][0] is string && (string)rows[0][0] == expectedMid;
    } finally { ClearAuthorizer(); }
  }

  // The own MID of the account the database belongs to: exactly one _profile row.
  internal string ReadOwnMid() {
    SetProfileAuthorizer();
    try {
      List<object[]> rows = Query("SELECT _mid FROM _profile LIMIT 3");
      if (rows.Count != 1 || rows[0].Length != 1 || !(rows[0][0] is string)) return null;
      string mid = (string)rows[0][0];
      return mid.Length >= 1 && mid.Length <= 200 && mid.IndexOf('\0') < 0 ? mid : null;
    } finally { ClearAuthorizer(); }
  }

  // The own display name normally lives on the single _profile row. Older or
  // partial schemas may omit it, so fall back to the matching _contact row.
  internal string ReadOwnDisplayName(string ownMid) {
    string ignored;
    return ReadOwnIdentity(ownMid, out ignored);
  }
  internal string ReadOwnIdentity(string ownMid, out string picturePath) {
    picturePath = null;
    SetReadAuthorizer(new Dictionary<string, string[]> {
      { "_profile", new string[] { "_mid", "_displayName", "_picturePath" } },
      { "_contact", new string[] { "_mid", "_displayName" } }
    });
    try {
      try {
        List<object[]> profile = QueryLimited("SELECT _displayName, substr(_picturePath,1,2049) FROM _profile WHERE _mid = ? LIMIT 2", 8192, ownMid);
        if (profile.Count == 1 && profile[0].Length == 2) {
          picturePath = ValidOptionalText(profile[0][1], 2048);
          string name = ValidOptionalText(profile[0][0], 256);
          if (name != null) return name;
        }
      } catch (InvalidOperationException) {
        // An older schema may have the display name but no picture column.
        try {
          List<object[]> profile = QueryLimited("SELECT _displayName FROM _profile WHERE _mid = ? LIMIT 2", 4096, ownMid);
          if (profile.Count == 1 && profile[0].Length == 1) {
            string name = ValidOptionalText(profile[0][0], 256);
            if (name != null) return name;
          }
        } catch (InvalidOperationException) { /* Fall back to the matching _contact row below. */ }
      }
      return ReadOptionalCatalogText("SELECT _displayName FROM _contact WHERE _mid = ? LIMIT 2", ownMid);
    } catch (InvalidOperationException) {
      return null;
    } finally { ClearAuthorizer(); }
  }

  internal bool VerifyOfficialSchemaAndMid(string expectedMid, CancellationToken cancellation) {
    cancellation.ThrowIfCancellationRequested();
    progressCallback = delegate(IntPtr user) { return cancellation.IsCancellationRequested ? 1 : 0; };
    progressHandler(db, 1000, progressCallback, IntPtr.Zero);
    try {
#if READER_OFFICIAL_SOURCE_TEST
      if (TestBeforeOfficialQuery != null) TestBeforeOfficialQuery(cancellation);
#endif
      if (!VerifyLineProfileMid(expectedMid)) return false;
      cancellation.ThrowIfCancellationRequested();
      SetReadAuthorizer(new Dictionary<string, string[]> {
      { "_message", new string[] { "_id", "_from", "_toType", "_createdTime", "_chatId", "_text", "_contentType" } },
      { "_chat", new string[] { "_id", "_midType" } },
      { "_groupChat", new string[] { "_chatMid" } },
      { "_contact", new string[] { "_mid", "_displayName" } },
    });
      try {
        Query("SELECT _id, _from, _toType, _createdTime, _chatId, _text, _contentType FROM _message LIMIT 0");
        cancellation.ThrowIfCancellationRequested();
        Query("SELECT _id, _midType FROM _chat LIMIT 0");
        Query("SELECT _chatMid FROM _groupChat LIMIT 0");
        cancellation.ThrowIfCancellationRequested();
        Query("SELECT _mid, _displayName FROM _contact LIMIT 0");
        cancellation.ThrowIfCancellationRequested();
        return true;
      } finally { ClearAuthorizer(); }
    } finally { progressHandler(db, 0, null, IntPtr.Zero); progressCallback = null; }
  }

  internal void EnableCancellation(CancellationToken cancellation) {
    scanCancellation = cancellation; hasScanCancellation = true;
    progressCallback = delegate(IntPtr user) { return cancellation.IsCancellationRequested ? 1 : 0; };
    progressHandler(db, 1000, progressCallback, IntPtr.Zero);
  }

  internal void EnableScanProgress(CancellationToken cancellation, Action<string, long> report, int opcodeInterval = 1000) {
    if (report == null || opcodeInterval < 1 || opcodeInterval > 100000) throw new ArgumentOutOfRangeException("opcodeInterval");
    scanCancellation = cancellation; hasScanCancellation = true;
    scanProgress = report; scanProgressPhase = "count"; scanSteps = 0; lastReportedScanSteps = 0;
    lastScanProgressTimestamp = Stopwatch.GetTimestamp(); scanProgressError = null;
    progressCallback = delegate(IntPtr user) {
      if (cancellation.IsCancellationRequested) return 1;
      if (scanSteps > Int64.MaxValue - opcodeInterval) { scanProgressError = new InvalidOperationException("SOURCE_PROGRESS_OVERFLOW"); return 1; }
      scanSteps += opcodeInterval;
      long now = Stopwatch.GetTimestamp();
      if (now - lastScanProgressTimestamp >= Stopwatch.Frequency * ScanProgressCadenceMs / 1000) {
        ReportScanProgress(now);
        if (scanProgressError != null) return 1;
      }
      return 0;
    };
    progressHandler(db, opcodeInterval, progressCallback, IntPtr.Zero);
  }

  internal void SetScanProgressPhase(string phase) {
    if (phase != "count" && phase != "page_read") throw new ArgumentException("SOURCE_PROGRESS_PHASE_INVALID");
    scanProgressPhase = phase;
    FlushScanProgress();
  }

  void ThrowIfScanCancelled() {
    if (hasScanCancellation) scanCancellation.ThrowIfCancellationRequested();
    if (scanProgressError != null) throw scanProgressError;
  }

  void FlushScanProgress() { ReportScanProgress(Stopwatch.GetTimestamp()); }

  void ReportScanProgress(long now) {
    if (scanProgress == null || scanSteps <= lastReportedScanSteps) return;
    try { scanProgress(scanProgressPhase, scanSteps); lastReportedScanSteps = scanSteps; lastScanProgressTimestamp = now; }
    catch (Exception error) { scanProgressError = error; }
  }

#if SQLITE_FIXTURE_WRITER
  static int fixtureWindowStatementPreparations;
  internal static int FixtureWindowStatementPreparations { get { return fixtureWindowStatementPreparations; } }
  internal static void ResetFixtureWindowStatementPreparations() { fixtureWindowStatementPreparations = 0; }
  internal long FixtureHeapLimit { get { return hardHeapLimit64(-1); } }
  internal long FixtureScanSteps { get { return Interlocked.Read(ref scanSteps); } }
  internal void SetFixtureHeapLimitForTest(long value) { hardHeapLimit64(value); }

  internal static Action TestBeforeBackupDestinationOpen = null;
  internal static Func<IntPtr, int, int> TestBackupStepOverride = null;
  internal static Func<long> TestBackupTimestamp = null;
  internal static Action TestBackupAfterBatch = null;
  internal static Sqlite3Mc OpenFixtureWriter(string path, byte[] key) { return new Sqlite3Mc(path, key, false, true); }
  internal static Sqlite3Mc OpenFixtureProbe(string path, byte[] key) { return new Sqlite3Mc(path, key, true, false, true); }
  internal void BeginFixtureGrowth() {
    RunStatement("BEGIN IMMEDIATE");
    InsertFixtureGrowthMessage();
  }
  internal void CheckpointFixtureWal() { RunStatement("PRAGMA wal_checkpoint(TRUNCATE)"); }
  internal void CommitFixtureGrowth() { RunStatement("COMMIT"); }
  internal string ReadFixtureValue(long id) {
    List<object[]> rows = Query("SELECT value FROM fixture WHERE id = ? LIMIT 1", id);
    if (rows.Count != 1 || !(rows[0][0] is string)) throw new InvalidOperationException("FIXTURE_ROW_INVALID");
    return (string)rows[0][0];
  }
  internal void CreateFixtureWal() {
    RunStatement("PRAGMA journal_mode=WAL");
    RunStatement("CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    RunStatement("INSERT INTO fixture(id,value) VALUES(1,'fixture-row')");
    RunStatement("CREATE TABLE _profile (_mid TEXT NOT NULL, _displayName TEXT, _picturePath TEXT)");
    RunStatement("INSERT INTO _profile(_mid,_displayName,_picturePath) VALUES('fixture-own-mid','Fixture Profile Owner','/own-picture')");
    RunStatement("CREATE TABLE _chat (_id TEXT NOT NULL, _midType INTEGER, _name TEXT, _unreadCount INTEGER)");
    RunStatement("INSERT INTO _chat(_id,_midType,_name,_unreadCount) VALUES('fixture-chat',0,'Fixture Direct',3),('fixture-group',2,NULL,1200),('fixture-community-chat',4,NULL,0),('fixture-thread',7,NULL,0),('fixture-room',1,'Fixture Room',NULL),('fixture-unknown',9,NULL,0)");
    RunStatement("CREATE TABLE _groupChat (_chatMid TEXT, _chatName TEXT, _picturePath TEXT)");
    RunStatement("INSERT INTO _groupChat(_chatMid,_chatName,_picturePath) VALUES('fixture-group-catalog','Fixture Group','/group-picture')");
    RunStatement("CREATE TABLE _squareChat (_squareChatMid TEXT, _squareMid TEXT, _name TEXT, _chatImageObsHash TEXT)");
    RunStatement("INSERT INTO _squareChat(_squareChatMid,_squareMid,_name,_chatImageObsHash) VALUES('fixture-community-chat','fixture-square','Fixture Square Chat','communityobs-hash-value-123456789')");
    RunStatement("CREATE TABLE _squareThread (_threadMid TEXT, _chatMid TEXT, _squareMid TEXT)");
    RunStatement("INSERT INTO _squareThread(_threadMid,_chatMid,_squareMid) VALUES('fixture-thread','fixture-community-chat','fixture-square')");
    RunStatement("CREATE TABLE _squareMember (_squareMemberMid TEXT PRIMARY KEY, _squareMid TEXT NOT NULL, _displayName TEXT, _profileImageObsHash TEXT)");
    RunStatement("CREATE TABLE _contact (_mid TEXT NOT NULL, _displayName TEXT)");
    RunStatement("INSERT INTO _contact(_mid,_displayName) VALUES('fixture-contact','Fixture Contact'),('fixture-own-mid','Fixture Owner')");
    RunStatement("CREATE TABLE _chatOption (_chatMid TEXT, _optionValue BLOB)");
    RunStatement("CREATE TABLE _profileMappedId (_mid TEXT, _mappedId TEXT)");
    RunStatement("CREATE TABLE _room (_mid TEXT, _name TEXT)");
    RunStatement("CREATE TABLE _square (_squareMid TEXT PRIMARY KEY, _mid TEXT, _name TEXT, _profileImageObsHash TEXT)");
    RunStatement("CREATE TABLE _squareBot (_squareMid TEXT, _botMid TEXT)");
    RunStatement("CREATE TABLE _buddyDetail (_mid TEXT, _displayName TEXT)");
    RunStatement("CREATE TABLE _buddyStatusBar (_mid TEXT, _label TEXT)");
    RunStatement("CREATE TABLE _message_sticker (_messageId TEXT, _stickerId TEXT)");
    RunStatement("CREATE TABLE _stickerProductNew (_productId TEXT PRIMARY KEY, _name TEXT)");
    RunStatement("CREATE TABLE _sticker_history (_mid TEXT, _stickerId TEXT)");
    RunStatement("CREATE TABLE _sticonProduct (_productId TEXT, _name TEXT)");
    RunStatement("CREATE TABLE _sticon_mapping (_sticonId TEXT, _stickerId TEXT)");
    RunStatement("INSERT INTO _chatOption(_chatMid,_optionValue) VALUES('fixture-chat',X'410042')");
    RunStatement("INSERT INTO _profileMappedId(_mid,_mappedId) VALUES('fixture-own-mid','fixture-map')");
    RunStatement("INSERT INTO _room(_mid,_name) VALUES('fixture-room','Fixture Room')");
    RunStatement("INSERT INTO _square(_squareMid,_name) VALUES('fixture-square','Fixture Square')");
    RunStatement("INSERT INTO _squareBot(_squareMid,_botMid) VALUES('fixture-square','fixture-bot')");
    RunStatement("INSERT INTO _buddyDetail(_mid,_displayName) VALUES('fixture-buddy','Fixture Buddy')");
    RunStatement("INSERT INTO _buddyStatusBar(_mid,_label) VALUES('fixture-buddy','Available')");
    RunStatement("INSERT INTO _message_sticker(_messageId,_stickerId) VALUES('fixture-message','fixture-sticker')");
    RunStatement("INSERT INTO _stickerProductNew(_productId,_name) VALUES('fixture-product','Fixture Product')");
    RunStatement("INSERT INTO _sticker_history(_mid,_stickerId) VALUES('fixture-own-mid','fixture-sticker')");
    RunStatement("INSERT INTO _sticonProduct(_productId,_name) VALUES('fixture-sticon-product','Fixture Sticon')");
    RunStatement("INSERT INTO _sticon_mapping(_sticonId,_stickerId) VALUES('fixture-sticon','fixture-sticker')");
    RunStatement("CREATE TABLE _message (_from TEXT,_to TEXT,_toType INTEGER,_id TEXT NOT NULL,_createdTime INTEGER NOT NULL,_deliveredTime INTEGER,_text TEXT,_location BLOB,_hasContent INTEGER,_contentType INTEGER,_contentMetadata TEXT,_contentPreview BLOB,_sessionId TEXT,_chunks BLOB,_relatedMessageId TEXT,_messageRelationType INTEGER,_readCount INTEGER,_relatedMessageServiceCode INTEGER,_appExtensionType INTEGER,_reactions BLOB,_type INTEGER,_status INTEGER,_chatId TEXT NOT NULL,_reqSeqV2 INTEGER,_reqSeq INTEGER,_contentInfo BLOB,_eventInfo BLOB,_rev INTEGER,_errorCode INTEGER,_urlPreview BLOB,_hasUrlPreview INTEGER,_syncToken BLOB,_fromType INTEGER,_attribute BLOB,_flag INTEGER,_reactionStatus INTEGER)");
    InsertFixtureMessage("m-02", 1000, "second");
    InsertFixtureMessage("m-10", 1000, "latest by id 臺灣😀");
    InsertFixtureMessage("m-01", 1000, "first");
    InsertFixtureMessage("m-03", 999, "older");
  }
  internal void TouchFixtureWalWithoutChangingRows() {
    RunStatement("BEGIN IMMEDIATE");
    RunStatement("UPDATE fixture SET value='fixture-temporary' WHERE id=1");
    RunStatement("UPDATE fixture SET value='fixture-row' WHERE id=1");
    RunStatement("COMMIT");
  }
  internal void SetFixtureWalOnlyValue() {
    RunStatement("UPDATE fixture SET value='wal-only-value' WHERE id=1");
  }
  internal void CreateFixtureBackupPayload(int bytes) {
    if (bytes < 1 || bytes > 64 * 1024 * 1024) throw new InvalidOperationException("FIXTURE_PAYLOAD_SIZE_INVALID");
    RunStatement("CREATE TABLE backup_probe(value TEXT NOT NULL)");
    RunStatement("INSERT INTO backup_probe(value) VALUES('before')");
    RunStatement("CREATE TABLE backup_payload(value BLOB)");
    const int chunkBytes = 4 * 1024 * 1024;
    for (int written = 0; written < bytes; written += chunkBytes)
      RunStatement("INSERT INTO backup_payload(value) VALUES(zeroblob(" + Math.Min(chunkBytes, bytes - written).ToString(System.Globalization.CultureInfo.InvariantCulture) + "))");
  }
  internal void UpdateFixtureBackupMarker() {
    RunStatement("UPDATE backup_probe SET value='after'");
    InsertFixtureGrowthMessage();
  }
  internal string ReadFixtureBackupMarker() {
    List<object[]> rows = Query("SELECT value FROM backup_probe LIMIT 1");
    if (rows.Count != 1 || !(rows[0][0] is string)) throw new InvalidOperationException("FIXTURE_MARKER_INVALID");
    return (string)rows[0][0];
  }
  internal void SetFixtureProfileShape(string shape) {
    if (shape != "zero" && shape != "wrong" && shape != "duplicate" && shape != "mixed" && shape != "unique")
      throw new InvalidOperationException("FIXTURE_PROFILE_SHAPE_INVALID");
    RunStatement("BEGIN IMMEDIATE");
    try {
      RunStatement("DELETE FROM _profile");
      if (shape == "wrong") RunStatement("INSERT INTO _profile(_mid) VALUES('fixture-other-mid')");
      if (shape == "duplicate" || shape == "mixed" || shape == "unique")
        RunStatement("INSERT INTO _profile(_mid) VALUES('fixture-own-mid')");
      if (shape == "duplicate") RunStatement("INSERT INTO _profile(_mid) VALUES('fixture-own-mid')");
      if (shape == "mixed") RunStatement("INSERT INTO _profile(_mid) VALUES('fixture-other-mid')");
      RunStatement("COMMIT");
    } catch { RunStatement("ROLLBACK"); throw; }
  }
  internal void SetFixtureOwnDisplayName(string value) {
    RunStatement("UPDATE _profile SET _displayName='" + value.Replace("'", "''") + "' WHERE _mid='fixture-own-mid'");
  }
  internal void SetFixtureProfileWithoutDisplayName() {
    RunStatement("DROP TABLE _profile");
    RunStatement("CREATE TABLE _profile (_mid TEXT NOT NULL)");
    RunStatement("INSERT INTO _profile(_mid) VALUES('fixture-own-mid')");
  }
  internal void RemoveFixtureOwnContact() {
    RunStatement("DELETE FROM _contact WHERE _mid='fixture-own-mid'");
  }
  internal void RestoreFixtureOwnProfileAndContact() {
    RunStatement("DROP TABLE _profile");
    RunStatement("CREATE TABLE _profile (_mid TEXT NOT NULL, _displayName TEXT)");
    RunStatement("INSERT INTO _profile(_mid,_displayName) VALUES('fixture-own-mid','Fixture Profile Owner')");
    RunStatement("INSERT INTO _contact(_mid,_displayName) VALUES('fixture-own-mid','Fixture Owner')");
  }
#endif
  internal object[] ReadMessageSnapshotBounds() {
    SetReadAuthorizer(new Dictionary<string, string[]> { { "_message", new string[] { "_id", "_createdTime" } } });
    try {
      List<object[]> rows = Query("SELECT COUNT(*), COUNT(_id), COUNT(_createdTime), COUNT(DISTINCT _id), COALESCE(SUM(CASE WHEN typeof(_id)='text' THEN 1 ELSE 0 END),0), COALESCE(SUM(CASE WHEN typeof(_createdTime)='integer' THEN 1 ELSE 0 END),0) FROM _message");
      if (rows.Count != 1 || rows[0].Length != 6 || !(rows[0][0] is long) || !(rows[0][1] is long) || !(rows[0][2] is long) || !(rows[0][3] is long) || !(rows[0][4] is long) || !(rows[0][5] is long)) throw new InvalidOperationException("SOURCE_BOUNDS_INVALID");
      long count = (long)rows[0][0];
      if ((long)rows[0][1] != count || (long)rows[0][2] != count || (long)rows[0][3] != count || (long)rows[0][4] != count || (long)rows[0][5] != count) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
      if (count == 0) return new object[] { count, null, null };
      List<object[]> high = Query("SELECT _createdTime, _id FROM _message ORDER BY _createdTime COLLATE BINARY DESC, _id COLLATE BINARY DESC LIMIT 1");
      if (high.Count != 1 || !(high[0][0] is long) || !(high[0][1] is string)) throw new InvalidOperationException("SOURCE_BOUNDS_INVALID");
      return new object[] { count, ((long)high[0][0]).ToString(System.Globalization.CultureInfo.InvariantCulture), (string)high[0][1] };
    } finally { ClearAuthorizer(); }
  }
  internal string[] ReadMessageConversationKind(string chatId) {
    Dictionary<string, NativeConversationInfo> pageCache = new Dictionary<string, NativeConversationInfo>(StringComparer.Ordinal);
    NativeConversationInfo info = ReadNativeConversationInfo(chatId, null, pageCache);
    return new string[] { info.ChatType, info.NativeKind };
  }

  NativeConversationInfo ReadNativeConversationInfo(string chatId, long? messageToType,
      Dictionary<string, NativeConversationInfo> pageCache) {
    if (String.IsNullOrEmpty(chatId) || chatId.Length > 512 || chatId.IndexOf('\0') >= 0 || pageCache == null)
      throw new InvalidOperationException("SOURCE_CONVERSATION_INVALID");
    string cacheKey = chatId + "\0" + (messageToType.HasValue ? "to:" + messageToType.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : "catalog");
    NativeConversationInfo cached;
    if (pageCache.TryGetValue(cacheKey, out cached)) return cached;
    SetReadAuthorizer(new Dictionary<string, string[]> {
      { "_chat", new string[] { "_id", "_midType" } },
      { "_groupChat", new string[] { "_chatMid", "_chatName", "_picturePath" } },
      { "_contact", new string[] { "_mid", "_displayName", "_displayNameOverridden", "_targetProfileDetail", "_friendDetail" } },
      { "_squareChat", new string[] { "_squareChatMid", "_squareMid", "_name", "_chatImageObsHash" } },
      { "_square", new string[] { "_mid", "_squareMid", "_profileImageObsHash" } },
      { "_squareThread", new string[] { "_threadMid", "_chatMid", "_squareMid" } }
    });
    try {
      List<object[]> chats = QueryLimited("SELECT _midType FROM _chat WHERE _id = ? LIMIT 2", 4096, chatId);
      if (chats.Count > 1 || (chats.Count == 1 && chats[0].Length != 1) ||
          (chats.Count == 1 && chats[0][0] != null && !(chats[0][0] is long)))
        throw new InvalidOperationException("SOURCE_CONVERSATION_INVALID");
      long? midType = messageToType;
      if (!midType.HasValue && chats.Count == 1 && chats[0][0] is long) midType = (long)chats[0][0];
      string category = CategoryForNativeType(midType);
      NativeConversationInfo info = new NativeConversationInfo {
        ChatType = category, NativeKind = midType.HasValue ? "midType:" + midType.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : "unknown",
        MidType = midType, ReadonlyForSending = category == "community" || category == "thread" || !midType.HasValue ||
          (midType.Value != 0 && midType.Value != 1 && midType.Value != 2)
      };
      if (category == "direct") info.Title = ReadDirectContactTitle(chatId);
      else if (category == "group") {
        info.Title = ReadOptionalCatalogText("SELECT _chatName FROM _groupChat WHERE _chatMid = ? LIMIT 2", chatId);
        try { info.PicturePath = ReadOptionalPicturePath("SELECT substr(_picturePath,1,2049) FROM _groupChat WHERE _chatMid = ? LIMIT 2", chatId); } catch (InvalidOperationException) { }
      }
      else if (category == "community") {
        List<object[]> squareChats = QueryLimited("SELECT _squareMid, _name FROM _squareChat WHERE _squareChatMid = ? LIMIT 2", 8192, chatId);
        if (squareChats.Count == 1 && squareChats[0].Length == 2) {
          info.CommunityId = ValidOptionalText(squareChats[0][0], 256);
          info.Title = BoundedOptionalTitle(squareChats[0][1]);
          try {
            List<object[]> images = QueryLimited("SELECT substr(_chatImageObsHash,1,2049) FROM _squareChat WHERE _squareChatMid = ? LIMIT 2", 8192, chatId);
            if (images.Count == 1 && images[0].Length == 1) info.PicturePath = ValidOptionalText(images[0][0], 2048);
          } catch (InvalidOperationException) { }
          if (info.PicturePath == null && info.CommunityId != null) {
            try {
              List<object[]> images = QueryLimited("SELECT substr(_profileImageObsHash,1,2049) FROM _square WHERE _squareMid = ? LIMIT 2", 8192, info.CommunityId);
              if (images.Count == 1 && images[0].Length == 1) info.PicturePath = ValidOptionalText(images[0][0], 2048);
            } catch (InvalidOperationException) { }
          }
        }
      } else if (category == "thread") {
        List<object[]> threads = QueryLimited("SELECT _chatMid, _squareMid FROM _squareThread WHERE _threadMid = ? LIMIT 2", 8192, chatId);
        if (threads.Count == 1 && threads[0].Length == 2) {
          info.ParentChatId = ValidOptionalText(threads[0][0], 256);
          info.CommunityId = ValidOptionalText(threads[0][1], 256);
          if (info.ParentChatId != null) {
            string parentTitle = ReadOptionalCatalogText("SELECT _name FROM _squareChat WHERE _squareChatMid = ? LIMIT 2", info.ParentChatId);
            info.Title = parentTitle == null ? "Thread" : BoundTitle(parentTitle + " · thread");
          }
          if (info.ParentChatId != null) {
            try {
              List<object[]> images = QueryLimited("SELECT substr(_chatImageObsHash,1,2049) FROM _squareChat WHERE _squareChatMid = ? LIMIT 2", 8192, info.ParentChatId);
              if (images.Count == 1 && images[0].Length == 1) info.PicturePath = ValidOptionalText(images[0][0], 2048);
            } catch (InvalidOperationException) { }
          }
          if (info.PicturePath == null && info.CommunityId != null) {
            try {
              List<object[]> images = QueryLimited("SELECT substr(_profileImageObsHash,1,2049) FROM _square WHERE _squareMid = ? LIMIT 2", 8192, info.CommunityId);
              if (images.Count == 1 && images[0].Length == 1) info.PicturePath = ValidOptionalText(images[0][0], 2048);
            } catch (InvalidOperationException) { }
          }
        }
      }
      // The cache is local to a single bounded page/tail adaptation.
      if (pageCache.Count < 100) pageCache[cacheKey] = info;
      return info;
    } finally { ClearAuthorizer(); }
  }

  // Direct-chat title rule (single native definition): the locally set nickname wins, otherwise the LINE profile name.
  // Newer LINE builds leave _displayName/_displayNameOverridden NULL and keep the names in JSON text columns:
  // nickname = _friendDetail.user.overriddenName, profile name = _targetProfileDetail.profileName.
  // Every column beyond _displayName is optional, so an older schema degrades level by level (2 -> 1 -> 0).
  int? contactNameLevel;
  string ReadDirectContactTitle(string mid) {
    while (contactNameLevel != 0) {
      bool jsonColumns = contactNameLevel != 1;
      try {
        List<object[]> rows = QueryLimited(jsonColumns
          ? "SELECT substr(_displayName,1,300), substr(_displayNameOverridden,1,300), substr(_targetProfileDetail,1,8193), substr(_friendDetail,1,8193) FROM _contact WHERE _mid = ? LIMIT 2"
          : "SELECT substr(_displayName,1,300), substr(_displayNameOverridden,1,300) FROM _contact WHERE _mid = ? LIMIT 2", 128 * 1024, mid);
        contactNameLevel = jsonColumns ? 2 : 1;
        if (rows.Count != 1) return null;
        string profileName, nickname;
        ResolveContactNames(rows[0], 0, 1, jsonColumns ? 2 : -1, jsonColumns ? 3 : -1, out profileName, out nickname);
        return nickname ?? profileName;
      } catch (InvalidOperationException error) {
        if (!IsPrepareSchemaMiss(error)) throw;
        contactNameLevel = jsonColumns ? 1 : 0;
      }
    }
    return ReadOptionalCatalogText("SELECT _displayName FROM _contact WHERE _mid = ? LIMIT 2", mid);
  }

  // nickname: _friendDetail.user.overriddenName, else _displayNameOverridden;
  // profile name: _targetProfileDetail.profileName, else _displayName. Malformed or oversized JSON gives null, never throws.
  static void ResolveContactNames(object[] row, int displayNameAt, int overriddenAt, int profileDetailAt, int friendDetailAt,
      out string profileName, out string nickname) {
    profileName = (profileDetailAt >= 0 && profileDetailAt < row.Length ? ContactJsonText(row[profileDetailAt], "profileName", null) : null)
      ?? (displayNameAt < row.Length ? BoundedOptionalTitle(row[displayNameAt]) : null);
    nickname = (friendDetailAt >= 0 && friendDetailAt < row.Length ? ContactJsonText(row[friendDetailAt], "user", "overriddenName") : null)
      ?? (overriddenAt < row.Length ? BoundedOptionalTitle(row[overriddenAt]) : null);
  }

  static string ContactJsonText(object raw, string key, string childKey) {
    string json = raw as string;
    if (String.IsNullOrEmpty(json) || json.Length > 8192) return null;
    try {
      IDictionary top = new JavaScriptSerializer { MaxJsonLength = 16 * 1024, RecursionLimit = 8 }.DeserializeObject(json) as IDictionary;
      if (top == null || !top.Contains(key)) return null;
      object value = top[key];
      if (childKey != null) {
        IDictionary child = value as IDictionary;
        if (child == null || !child.Contains(childKey)) return null;
        value = child[childKey];
      }
      return BoundedOptionalTitle(value);
    } catch { return null; }
  }

  static string ContactJsonPicturePath(object raw) {
    string json = raw as string;
    if (String.IsNullOrEmpty(json) || json.Length > 8192) return null;
    try {
      IDictionary top = new JavaScriptSerializer { MaxJsonLength = 16 * 1024, RecursionLimit = 8 }.DeserializeObject(json) as IDictionary;
      return top == null ? null : ValidOptionalText(top["picturePath"], 2048);
    } catch { return null; }
  }

  bool IsPrepareSchemaMiss(InvalidOperationException error) {
    SqliteDiagnosticException diagnostic = error as SqliteDiagnosticException;
    if (diagnostic != null) return IsOptionalSquareMemberSchemaMiss(diagnostic.Summary);
    return error.Message == "DATABASE_READ_FAILED" && lastStage == "prepare" && lastPrimaryCode == 1;
  }

  string ReadOptionalCatalogText(string sql, string key) {
    List<object[]> rows = QueryLimited(sql, 4096, key);
    return rows.Count == 1 && rows[0].Length == 1 ? BoundedOptionalTitle(rows[0][0]) : null;
  }

  string ReadOptionalPicturePath(string sql, string key) {
    List<object[]> rows = QueryLimited(sql, 8192, key);
    return rows.Count == 1 && rows[0].Length == 1 ? ValidOptionalText(rows[0][0], 2048) : null;
  }

  static string BoundedOptionalTitle(object value) {
    if (!(value is string)) return null;
    string title = (string)value;
    if (title.Length == 0 || title.IndexOf('\0') >= 0) return null;
    return BoundTitle(title);
  }

  static string BoundTitle(string value) {
    if (value == null || value.Length <= 256) return value;
    int length = Char.IsHighSurrogate(value[255]) ? 255 : 256;
    return value.Substring(0, length);
  }

  static string ValidOptionalText(object value, int maxLength) {
    if (!(value is string)) return null;
    string text = (string)value;
    if (text.Length == 0 || text.Length > maxLength || text.IndexOf('\0') >= 0) return null;
    return text;
  }

  static string CategoryForNativeType(long? midType) {
    if (!midType.HasValue) return "room";
    switch (midType.Value) {
      case 0: return "direct";
      case 2: return "group";
      case 4: return "community";
      case 7: return "thread";
      case 1: return "room";
      default: return "room";
    }
  }

  string SerializeNativeMessageRow(NativeSourceRow row, Dictionary<string, NativeConversationInfo> pageCache,
      Dictionary<string, NativeSenderInfo> senderNameCache, out string createdTime, out string messageId) {
    createdTime = null; messageId = null;
    if (row == null || row.TableName != "_message")
      throw new InvalidOperationException("SOURCE_ROW_INVALID");
    string id = row.Text("_id"), senderId = row.Text("_from"), chatId = row.Text("_chatId"), text = row.Text("_text");
    long? toType = row.Int64("_toType"), created = row.Int64("_createdTime"), contentType = row.Int64("_contentType");
    if (String.IsNullOrEmpty(id) || id.Length > 512 || senderId == null || !created.HasValue || String.IsNullOrEmpty(chatId) || chatId.Length > 512)
      throw new InvalidOperationException("SOURCE_ROW_INVALID");
    NativeConversationInfo conversation = ReadNativeConversationInfo(chatId, toType, pageCache);
    string senderPicturePath = null;
    string senderName = conversation.ChatType == "community" || conversation.ChatType == "thread"
      ? ReadNativeSenderName(senderId, conversation, senderNameCache, out senderPicturePath) : null;
    int? nativeContentType = null;
    if (contentType.HasValue && contentType.Value >= Int32.MinValue && contentType.Value <= Int32.MaxValue) nativeContentType = (int)contentType.Value;
    createdTime = created.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    messageId = id;
    string metadata = "{\"midType\":" + (conversation.MidType.HasValue ? conversation.MidType.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : "null") +
      ",\"parentChatId\":" + JsonNullable(conversation.ParentChatId) + ",\"communityId\":" + JsonNullable(conversation.CommunityId) + "}";
    string mentionRanges = ParseNativeMentionRanges(row.OptionalJson("_contentMetadata"), text);
    string nativeStickerMetadata = contentType == 7 ? ParseNativeStickerMetadata(row.OptionalJson("_contentMetadata")) : null;
    string nativeAttachments = ParseNativeAttachmentDescriptors(contentType, row.OptionalAttachmentJson("_contentInfo"),
      row.OptionalAttachmentJson("_contentMetadata"), messageId);
    return "{\"observationId\":" + JsonQuote("official-line-db:" + messageId) + ",\"canonicalMessageId\":null," +
      "\"nativeConversationKind\":" + JsonQuote(conversation.NativeKind) + ",\"nativeConversationId\":" + JsonQuote(chatId) +
      ",\"nativeMessageId\":" + JsonQuote(messageId) + ",\"chatType\":" + JsonQuote(conversation.ChatType) +
      ",\"chatId\":" + JsonQuote(chatId) + ",\"senderId\":" + JsonQuote(senderId) + ",\"kind\":" + JsonQuote(ContentKind(contentType)) +
      (senderName == null ? "" : ",\"senderName\":" + JsonQuote(senderName)) +
      (senderPicturePath == null ? "" : ",\"senderPicturePath\":" + JsonQuote(senderPicturePath)) +
      ",\"createdTime\":" + JsonQuote(createdTime) + ",\"text\":" + JsonNullable(text) +
      (mentionRanges == null ? "" : ",\"mentionRanges\":" + mentionRanges) +
      ",\"readonlyForSending\":" + (conversation.ReadonlyForSending ? "true" : "false") +
      ",\"conversationTitle\":" + JsonNullable(conversation.Title) + ",\"nativeMetadata\":" + metadata +
      ",\"nativeContentType\":" + (nativeContentType.HasValue ? nativeContentType.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : "null") +
      (nativeStickerMetadata == null ? "" : ",\"nativeStickerMetadata\":" + nativeStickerMetadata) +
      (nativeAttachments == null ? "" : ",\"nativeAttachments\":" + nativeAttachments) +
      ",\"nativePayload\":" + row.PlainEnvelopeJson() + "}";
  }

  static string ParseNativeAttachmentDescriptors(long? contentType, object rawContentInfo, object rawContentMetadata, string messageId) {
    string kind;
    if (contentType == 1) kind = "image";
    else if (contentType == 2) kind = "video";
    else if (contentType == 3) kind = "audio";
    else if (contentType == 14) kind = "file";
    else return null;
    string name = null; long size = 0; bool hasSize = false;
    JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 64 * 1024, RecursionLimit = 8 };
    try {
      string json = rawContentInfo as string;
      if (!String.IsNullOrEmpty(json) && json.Length <= 64 * 1024) {
        IDictionary info = serializer.DeserializeObject(json) as IDictionary;
        if (info != null) {
          object candidateName = info["fileName"] ?? info["filename"];
          string candidate = candidateName as string;
          if (!String.IsNullOrEmpty(candidate) && candidate.Length <= 1024 && candidate.IndexOf('\0') < 0) name = candidate;
          object candidateSize = info["size"] ?? info["fileSize"];
          if (candidateSize is long) { size = (long)candidateSize; hasSize = size >= 0 && size <= 9007199254740991L; }
          else if (candidateSize is int) { size = (int)candidateSize; hasSize = size >= 0; }
          else if (candidateSize is string) {
            long parsed;
            if (Int64.TryParse((string)candidateSize, System.Globalization.NumberStyles.None,
              System.Globalization.CultureInfo.InvariantCulture, out parsed) && parsed >= 0 && parsed <= 9007199254740991L) {
              size = parsed; hasSize = true;
            }
          }
        }
      }
    } catch { }
    try {
      string json = rawContentMetadata as string;
      if (!String.IsNullOrEmpty(json) && json.Length <= 64 * 1024) {
        IDictionary metadata = serializer.DeserializeObject(json) as IDictionary;
        if (metadata != null) {
          if (name == null) {
            string candidate = metadata["FILE_NAME"] as string;
            if (!String.IsNullOrEmpty(candidate) && candidate.Length <= 1024 && candidate.IndexOf('\0') < 0) name = candidate;
          }
          if (!hasSize) {
            object candidateSize = metadata["FILE_SIZE"];
            long parsed;
            if (candidateSize is string && Int64.TryParse((string)candidateSize, System.Globalization.NumberStyles.None,
              System.Globalization.CultureInfo.InvariantCulture, out parsed) && parsed >= 0 && parsed <= 9007199254740991L) {
              size = parsed; hasSize = true;
            } else if (candidateSize is long) {
              parsed = (long)candidateSize;
              if (parsed >= 0 && parsed <= 9007199254740991L) { size = parsed; hasSize = true; }
            }
          }
        }
      }
    } catch { }
    return "[{\"id\":" + JsonQuote(messageId) + ",\"kind\":" + JsonQuote(kind) + ",\"name\":" + JsonNullable(name) +
      ",\"mimeType\":null,\"sizeBytes\":" + (hasSize ? size.ToString(System.Globalization.CultureInfo.InvariantCulture) : "null") +
      ",\"expiresAt\":null}]";
  }

  static string ParseNativeStickerMetadata(object rawMetadata) {
    if (!(rawMetadata is string) || String.IsNullOrEmpty((string)rawMetadata) || ((string)rawMetadata).Length > 16 * 1024) return null;
    try {
      JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024, RecursionLimit = 8 };
      IDictionary outer = serializer.DeserializeObject((string)rawMetadata) as IDictionary;
      if (outer == null) return null;
      IDictionary sticker;
      if (outer.Contains("STKID")) sticker = outer;
      else {
        string nested = outer["STK"] as string;
        if (String.IsNullOrEmpty(nested) || nested.Length > 16 * 1024) return null;
        sticker = serializer.DeserializeObject(nested) as IDictionary;
      }
      string id = sticker == null ? null : NativeStickerIdText(sticker["STKID"]);
      if (!IsNativeStickerNumericId(id)) return null;
      List<string> fields = new List<string> { "\"STKID\":" + JsonQuote(id) };
      string packageId = NativeStickerIdText(sticker["STKPKGID"]);
      if (IsNativeStickerNumericId(packageId)) fields.Add("\"STKPKGID\":" + JsonQuote(packageId));
      string version = NativeStickerIdText(sticker["STKVER"]);
      if (IsNativeStickerNumericId(version)) fields.Add("\"STKVER\":" + JsonQuote(version));
      string text = sticker["STKTXT"] as string;
      if (text != null) {
        StringBuilder safe = new StringBuilder(Math.Min(text.Length, 200));
        bool space = false;
        for (int i = 0; i < text.Length && safe.Length < 200; i++) {
          char c = text[i];
          if (Char.IsControl(c) || Char.IsWhiteSpace(c)) { space = safe.Length > 0; continue; }
          if (space) {
            if (safe.Length >= 200) break;
            safe.Append(' ');
          }
          space = false;
          if (safe.Length >= 200) break;
          safe.Append(c);
        }
        if (safe.Length > 0 && Char.IsHighSurrogate(safe[safe.Length - 1])) safe.Length--;
        fields.Add("\"STKTXT\":" + JsonQuote(safe.ToString().Trim()));
      }
      if (sticker["STKOPT"] as string == "A") fields.Add("\"STKOPT\":\"A\"");
      return "{" + String.Join(",", fields.ToArray()) + "}";
    } catch { return null; }
  }

  static string NativeStickerIdText(object value) {
    if (value is string) return (string)value;
    if (value is int) return ((int)value) < 0 ? null : ((int)value).ToString(System.Globalization.CultureInfo.InvariantCulture);
    if (value is long) return ((long)value) < 0 ? null : ((long)value).ToString(System.Globalization.CultureInfo.InvariantCulture);
    if (value is decimal) {
      decimal number = (decimal)value;
      if (number < 0 || decimal.Truncate(number) != number) return null;
      return number.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    return null;
  }

  static bool IsNativeStickerNumericId(string value) {
    if (String.IsNullOrEmpty(value) || value.Length > 20) return false;
    for (int i = 0; i < value.Length; i++) if (value[i] < '0' || value[i] > '9') return false;
    return true;
  }

  static string ParseNativeMentionRanges(object rawMetadata, string text) {
    if (!(rawMetadata is string) || text == null) return null;
    string raw = (string)rawMetadata;
    if (raw.Length == 0 || raw.Length > 16 * 1024) return null;
    try {
      JavaScriptSerializer serializer = new JavaScriptSerializer();
      serializer.MaxJsonLength = 16 * 1024;
      serializer.RecursionLimit = 8;
      IDictionary outer = serializer.DeserializeObject(raw) as IDictionary;
      string nested = outer == null ? null : outer["MENTION"] as string;
      if (nested == null || nested.Length == 0 || nested.Length > 16 * 1024) return null;
      IDictionary mention = serializer.DeserializeObject(nested) as IDictionary;
      IList entries = mention == null ? null : mention["MENTIONEES"] as IList;
      if (entries == null) return null;
      List<string> ranges = new List<string>(64);
      foreach (object item in entries) {
        IDictionary entry = item as IDictionary;
        if (entry == null) continue;
        int start, end;
        if (!TryMentionOffset(entry["S"], out start) || !TryMentionOffset(entry["E"], out end) || start < 0 || end <= start || end > text.Length) continue;
        object all = entry["A"];
        string userId = (all is string && (string)all == "1") || (all is bool && (bool)all) ? "@all" : entry["M"] as string;
        if (String.IsNullOrEmpty(userId) || userId.Length > 512 || userId.IndexOf('\0') >= 0) continue;
        if (ranges.Count == 64) break;
        ranges.Add("{\"start\":" + start.ToString(System.Globalization.CultureInfo.InvariantCulture) +
          ",\"end\":" + end.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"userId\":" + JsonQuote(userId) + "}");
      }
      return "[" + String.Join(",", ranges.ToArray()) + "]";
    } catch { return null; }
  }

  static bool TryMentionOffset(object value, out int result) {
    result = 0;
    if (value is int) { result = (int)value; return true; }
    string textValue = value as string;
    if (textValue != null) return Int32.TryParse(textValue, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out result);
    if (value is long) {
      long number = (long)value;
      if (number < 0 || number > Int32.MaxValue) return false;
      result = (int)number; return true;
    }
    return false;
  }

  string ReadNativeSenderName(string senderId, NativeConversationInfo conversation, Dictionary<string, NativeSenderInfo> pageCache, out string picturePath) {
    picturePath = null;
    if (String.IsNullOrEmpty(senderId) || senderId.Length > 512 || senderId.IndexOf('\0') >= 0 ||
        String.IsNullOrEmpty(conversation.CommunityId) || pageCache == null) return null;
    string cacheKey = conversation.CommunityId.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + conversation.CommunityId + senderId;
    NativeSenderInfo cached;
    if (pageCache.TryGetValue(cacheKey, out cached)) { picturePath = cached.PicturePath; return cached.Name; }
    SetReadAuthorizer(new Dictionary<string, string[]> {
      { "_squareMember", new string[] { "_squareMemberMid", "_squareMid", "_displayName", "_profileImageObsHash" } }
    });
    string name = null;
    try {
      List<object[]> rows = QueryLimited("SELECT _displayName, substr(_profileImageObsHash,1,2049) FROM _squareMember WHERE _squareMemberMid = ? AND _squareMid = ? LIMIT 2",
        8192, senderId, conversation.CommunityId);
      if (rows.Count == 1 && rows[0].Length == 2) { name = ValidOptionalText(rows[0][0], 256); picturePath = ValidOptionalText(rows[0][1], 2048); }
    } catch (SqliteDiagnosticException error) {
      if (!IsOptionalSquareMemberSchemaMiss(error.Summary)) throw;
      try {
        List<object[]> rows = QueryLimited("SELECT _displayName FROM _squareMember WHERE _squareMemberMid = ? AND _squareMid = ? LIMIT 2", 8192, senderId, conversation.CommunityId);
        if (rows.Count == 1 && rows[0].Length == 1) name = ValidOptionalText(rows[0][0], 256);
      } catch (InvalidOperationException) { }
    } catch (InvalidOperationException error) {
      if (error.Message == "RESULT_TOO_LARGE") {
        // An overlong optional catalog value must not fail message import.
      } else if (!(error.Message == "DATABASE_READ_FAILED" && lastStage == "prepare" && lastPrimaryCode == 1)) {
        throw;
      }
      // SQLITE_ERROR during this fixed SELECT means the optional table or column is absent.
      if (error.Message == "DATABASE_READ_FAILED" && lastStage == "prepare" && lastPrimaryCode == 1) {
        try {
          List<object[]> rows = QueryLimited("SELECT _displayName FROM _squareMember WHERE _squareMemberMid = ? AND _squareMid = ? LIMIT 2", 8192, senderId, conversation.CommunityId);
          if (rows.Count == 1 && rows[0].Length == 1) name = ValidOptionalText(rows[0][0], 256);
        } catch (InvalidOperationException) { }
      }
    } finally { ClearAuthorizer(); }
    if (pageCache.Count < 500) pageCache[cacheKey] = new NativeSenderInfo { Name = name, PicturePath = picturePath };
    return name;
  }

  static bool IsOptionalSquareMemberSchemaMiss(string summary) {
    return !String.IsNullOrEmpty(summary) && summary.StartsWith("prepare|1|1|", StringComparison.Ordinal);
  }

  static string JsonNullable(string value) { return value == null ? "null" : JsonQuote(value); }
  internal string[] ReadMessageKeysetPage(string afterCreatedTime, string afterId, int limitRows, out bool hasMore,
      out string lastCreatedTime, out string lastId, bool boundedRound = false, bool emptyBound = false,
      string upperCreatedTime = null, string upperId = null, bool initialImport = false) {
    lastCreatedTime = null; lastId = null;
    hasMore = false;
    if (limitRows < 1 || limitRows > (initialImport ? 500 : 100) || ((afterCreatedTime == null) != (afterId == null)) ||
        (boundedRound && (emptyBound ? (upperCreatedTime != null || upperId != null) : ((upperCreatedTime == null) != (upperId == null)))) ||
        (!boundedRound && (emptyBound || upperCreatedTime != null || upperId != null))) throw new InvalidOperationException("SOURCE_PAGE_INVALID");
    if (boundedRound && emptyBound) return new string[0];
    long timestamp = 0;
    if (afterCreatedTime != null && !Int64.TryParse(afterCreatedTime, System.Globalization.NumberStyles.AllowLeadingSign,
        System.Globalization.CultureInfo.InvariantCulture, out timestamp)) throw new InvalidOperationException("SOURCE_CURSOR_INVALID");
    long upperTimestamp = 0;
    if (boundedRound && (!Int64.TryParse(upperCreatedTime, System.Globalization.NumberStyles.AllowLeadingSign,
        System.Globalization.CultureInfo.InvariantCulture, out upperTimestamp) || String.IsNullOrEmpty(upperId))) throw new InvalidOperationException("SOURCE_CURSOR_INVALID");
    lastStage = "authorizer";
    SetScanProgressPhase("page_read");
    SetReadAuthorizer(new Dictionary<string, string[]> { { "_message", NativeMessageColumnNames } });
    try {
      string prefix = "SELECT * FROM _message WHERE _createdTime IS NOT NULL AND _id IS NOT NULL";
      string afterClause = afterCreatedTime == null ? "" : " AND (_createdTime > ? OR (_createdTime = ? AND _id COLLATE BINARY > ?))";
      string upperClause = boundedRound ? " AND (_createdTime < ? OR (_createdTime = ? AND _id COLLATE BINARY <= ?))" : "";
      string sql = prefix + afterClause + upperClause + " ORDER BY _createdTime ASC, _id COLLATE BINARY ASC LIMIT ?";
      object[] queryValues = boundedRound
        ? (afterCreatedTime == null ? new object[] { upperTimestamp, upperTimestamp, upperId, (long)(limitRows + 1) }
          : new object[] { timestamp, timestamp, afterId, upperTimestamp, upperTimestamp, upperId, (long)(limitRows + 1) })
        : (afterCreatedTime == null ? new object[] { (long)(limitRows + 1) }
          : new object[] { timestamp, timestamp, afterId, (long)(limitRows + 1) });
      return ReadNativeMessagePrefix(sql, limitRows, queryValues,
        initialImport ? InitialImportMessageFrameBytes : MonitorMessageFrameBytes,
        out hasMore, out lastCreatedTime, out lastId);
    } finally { ClearAuthorizer(); }
  }

  internal InitialImportWindow OpenInitialImportWindow(CancellationToken cancellation, long heapLimitBytes = InitialImportHeapLimitBytes) {
    return new InitialImportWindow(this, cancellation, heapLimitBytes);
  }

  internal sealed class InitialImportBufferedRow {
    internal readonly string Json;
    internal readonly string CreatedTime;
    internal readonly string Id;
    internal readonly int AccountedBytes;
    internal InitialImportBufferedRow(string json, string createdTime, string id) {
      Json = json; CreatedTime = createdTime; Id = id;
      AccountedBytes = checked(Encoding.UTF8.GetByteCount(json) + Encoding.UTF8.GetByteCount(createdTime) + Encoding.UTF8.GetByteCount(id) + 128);
    }
  }

  internal sealed class InitialImportPrefetcher : IDisposable {
    const int MaxBufferedWindows = 2;
    const int MaxWindowRows = 30000;
    const long MaxWindowAccountedBytes = 64L * 1024 * 1024;
    const int ProducerPageRows = 2000;
    const int JoinTimeoutMs = 5000;

    internal sealed class WindowBuffer {
      internal readonly List<InitialImportBufferedRow[]> Chunks = new List<InitialImportBufferedRow[]>();
      internal bool HasMore;
      internal Exception Error;
      internal long AccountedBytes;
      internal int RowCount;
      internal bool Ready;
    }

    readonly Sqlite3Mc owner;
    readonly CancellationTokenSource lifetime;
    readonly object gate = new object();
    readonly List<WindowBuffer> slots = new List<WindowBuffer>(MaxBufferedWindows);
    readonly Thread producer;
    string startTime, startId;
    bool started, finished, disposed;
    Exception producerError;
    string progressPhase;
    long progressSteps;
    bool progressPending;
#if SQLITE_FIXTURE_WRITER
    int fixtureBuildAttempts, fixtureBuiltWindows, fixtureSlotHighWater, fixtureMaximumWindowRows;
    string fixtureLastBuildError;
    long fixtureWindowByteBudget = MaxWindowAccountedBytes;
    internal static Func<int, Exception> FixtureBuildFailure = null;
    internal void SetFixtureWindowByteBudget(long value) { fixtureWindowByteBudget = value; }
    internal int FixtureBuildAttempts { get { lock (gate) return fixtureBuildAttempts; } }
    internal int FixtureBuiltWindows { get { lock (gate) return fixtureBuiltWindows; } }
    internal int FixtureSlotHighWater { get { lock (gate) return fixtureSlotHighWater; } }
    internal int FixtureMaximumWindowRows { get { lock (gate) return fixtureMaximumWindowRows; } }
    internal string FixtureLastBuildError { get { lock (gate) return fixtureLastBuildError; } }
    internal bool FixtureWaitForBuiltWindows(int count, int timeoutMs) {
      DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
      lock (gate) {
        while (fixtureBuiltWindows < count && !finished) {
          int remaining = (int)Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds);
          if (remaining == 0 || !Monitor.Wait(gate, remaining)) break;
        }
        return fixtureBuiltWindows >= count;
      }
    }
    internal bool FixtureWaitForBuildAttempts(int count, int timeoutMs) {
      DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
      lock (gate) {
        while (fixtureBuildAttempts < count && !finished) {
          int remaining = (int)Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds);
          if (remaining == 0 || !Monitor.Wait(gate, remaining)) break;
        }
        return fixtureBuildAttempts >= count;
      }
    }
#endif

    internal InitialImportPrefetcher(Sqlite3Mc owner, CancellationToken cancellation) {
      if (owner == null) throw new ArgumentNullException("owner");
      this.owner = owner; lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
      producer = new Thread(Produce) { IsBackground = true, Name = "js-initial-import-prefetch" };
    }

    internal CancellationToken CancellationToken { get { return lifetime.Token; } }

    internal void Start(string afterCreatedTime, string afterId) {
      lock (gate) {
        if (started || disposed || ((afterCreatedTime == null) != (afterId == null))) throw new InvalidOperationException("SOURCE_PREFETCH_INVALID");
        started = true; startTime = afterCreatedTime; startId = afterId; producer.Start();
      }
    }

    internal WindowBuffer AcquireWindow(Action drainProgress) {
      lock (gate) {
        if (!started || disposed) throw new InvalidOperationException("SOURCE_PREFETCH_INVALID");
        while (true) {
          lifetime.Token.ThrowIfCancellationRequested();
          if (slots.Count > 0 && slots[0].Ready) {
            if (slots[0].Error != null) throw slots[0].Error;
            return slots[0];
          }
          if (finished) {
            if (producerError != null) throw producerError;
            return null;
          }
          Monitor.Wait(gate, 50);
          if (drainProgress != null) { Monitor.Exit(gate); try { drainProgress(); } finally { Monitor.Enter(gate); } }
        }
      }
    }

    internal void ReleaseWindow(WindowBuffer window) {
      lock (gate) {
        if (window == null || slots.Count == 0 || !Object.ReferenceEquals(slots[0], window) || !window.Ready)
          throw new InvalidOperationException("SOURCE_PREFETCH_RELEASE_INVALID");
        slots.RemoveAt(0); Monitor.PulseAll(gate);
      }
    }

    internal void PublishProgress(string phase, long steps) {
      lock (gate) { progressPhase = phase; progressSteps = steps; progressPending = true; }
    }

    internal bool TryTakeProgress(out string phase, out long steps) {
      lock (gate) {
        phase = progressPhase; steps = progressSteps;
        bool pending = progressPending; progressPending = false; return pending;
      }
    }

    void Produce() {
      string cursorTime = startTime, cursorId = startId;
      try {
        using (InitialImportWindow window = owner.OpenInitialImportWindow(lifetime.Token)) {
          bool sourceDone = false;
          while (!sourceDone) {
            lifetime.Token.ThrowIfCancellationRequested();
            WindowBuffer buffer;
#if SQLITE_FIXTURE_WRITER
            int currentBuild = 0;
#endif
            lock (gate) {
              while (slots.Count >= MaxBufferedWindows) { lifetime.Token.ThrowIfCancellationRequested(); Monitor.Wait(gate, 50); }
              lifetime.Token.ThrowIfCancellationRequested();
              buffer = new WindowBuffer(); slots.Add(buffer);
#if SQLITE_FIXTURE_WRITER
              fixtureBuildAttempts++;
              currentBuild = fixtureBuildAttempts;
              fixtureSlotHighWater = Math.Max(fixtureSlotHighWater, slots.Count);
              Monitor.PulseAll(gate);
#endif
            }
            try {
#if SQLITE_FIXTURE_WRITER
              if (FixtureBuildFailure != null) {
                Exception injected = FixtureBuildFailure(currentBuild);
                if (injected != null) throw injected;
              }
#endif
              while (buffer.RowCount < MaxWindowRows) {
                lifetime.Token.ThrowIfCancellationRequested();
                if (buffer.RowCount > 0 && MaxWindowBytes - buffer.AccountedBytes < InitialImportWindowChunkReserveBytes) {
                  buffer.HasMore = true;
                  break;
                }
                bool pageHasMore;
                int remainingWindowRows = MaxWindowRows - buffer.RowCount;
                int requestedRows = Math.Min(ProducerPageRows, remainingWindowRows);
                InitialImportBufferedRow[] chunk = window.ReadBufferedPage(requestedRows, cursorTime, cursorId, out pageHasMore);
                if (chunk.Length == 0) { sourceDone = true; buffer.HasMore = false; break; }
                long chunkBytes = 0;
                for (int i = 0; i < chunk.Length; i++) chunkBytes = checked(chunkBytes + chunk[i].AccountedBytes);
                if (checked(buffer.AccountedBytes + chunkBytes) > MaxWindowBytes)
                  throw new InvalidOperationException("SOURCE_PREFETCH_BUDGET_EXCEEDED");
                buffer.Chunks.Add(chunk); buffer.AccountedBytes += chunkBytes; buffer.RowCount += chunk.Length;
#if SQLITE_FIXTURE_WRITER
                lock (gate) fixtureMaximumWindowRows = Math.Max(fixtureMaximumWindowRows, buffer.RowCount);
#endif
                InitialImportBufferedRow last = chunk[chunk.Length - 1]; cursorTime = last.CreatedTime; cursorId = last.Id;
                buffer.HasMore = pageHasMore;
                if (!pageHasMore) { sourceDone = true; break; }
              }
              if (buffer.RowCount == 0 && buffer.HasMore) throw new InvalidOperationException("SOURCE_PREFETCH_EMPTY_CONTINUATION");
              lock (gate) {
                buffer.Ready = true;
#if SQLITE_FIXTURE_WRITER
                fixtureBuiltWindows++;
#endif
                Monitor.PulseAll(gate);
              }
              if (!buffer.HasMore) sourceDone = true;
            } catch (Exception error) {
              lock (gate) { buffer.Error = error; buffer.Ready = true;
#if SQLITE_FIXTURE_WRITER
                fixtureLastBuildError = error.Message;
#endif
                Monitor.PulseAll(gate); }
              if (lifetime.IsCancellationRequested) return;
              return;
            }
          }
        }
      } catch (Exception error) {
        lock (gate) { producerError = error; }
      } finally {
        lock (gate) { finished = true; Monitor.PulseAll(gate); }
      }
    }

    long MaxWindowBytes {
      get {
#if SQLITE_FIXTURE_WRITER
        return fixtureWindowByteBudget;
#else
        return MaxWindowAccountedBytes;
#endif
      }
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.Cancel();
      lock (gate) Monitor.PulseAll(gate);
      if (started && !producer.Join(JoinTimeoutMs)) {
        Process.GetCurrentProcess().Kill();
        Thread.Sleep(Timeout.Infinite);
      }
      lock (gate) slots.Clear();
      lifetime.Dispose();
    }
  }

  internal sealed class InitialImportWindow : IDisposable {
    static readonly Dictionary<string, string[]> MessageColumns = new Dictionary<string, string[]> {
      { "_message", NativeMessageColumnNames }
    };
    readonly Sqlite3Mc owner;
    readonly CancellationToken cancellation;
    readonly long priorHeapLimit;
    readonly long effectiveHeapLimit;
    IntPtr statement;
    NativeSourceRow pendingRow;
    InitialImportBufferedRow pendingSerializedRow;
    int pendingBytes;
    string[] columnNames;
    int deliveredInWindow;
    string expectedCreatedTime, expectedId;
    bool readStarted, queryDone, disposed;

    internal InitialImportWindow(Sqlite3Mc owner, CancellationToken cancellation, long heapLimitBytes) {
      if (owner == null || owner.db == IntPtr.Zero || !owner.readOnly || heapLimitBytes < 1 || heapLimitBytes > InitialImportHeapLimitBytes)
        throw new InvalidOperationException("SOURCE_WINDOW_INVALID");
      this.owner = owner; this.cancellation = cancellation;
      priorHeapLimit = owner.hardHeapLimit64(-1);
      effectiveHeapLimit = priorHeapLimit > 0 && priorHeapLimit < heapLimitBytes ? priorHeapLimit : heapLimitBytes;
      long replaced = owner.hardHeapLimit64(effectiveHeapLimit);
      if (replaced != priorHeapLimit) {
        owner.hardHeapLimit64(priorHeapLimit);
        throw new InvalidOperationException("SOURCE_WINDOW_HEAP_LIMIT_FAILED");
      }
      owner.windowReadAuthorizerActive = true;
      owner.SetReadAuthorizer(MessageColumns);
    }

    internal string[] ReadPage(int limitRows, string afterCreatedTime, string afterId, out bool hasMore,
        out string lastCreatedTime, out string lastId) {
      InitialImportBufferedRow[] buffered = ReadBufferedPage(limitRows, afterCreatedTime, afterId, out hasMore);
      lastCreatedTime = buffered.Length == 0 ? null : buffered[buffered.Length - 1].CreatedTime;
      lastId = buffered.Length == 0 ? null : buffered[buffered.Length - 1].Id;
      string[] result = new string[buffered.Length];
      for (int i = 0; i < buffered.Length; i++) result[i] = buffered[i].Json;
      return result;
    }

    internal InitialImportBufferedRow[] ReadBufferedPage(int limitRows, string afterCreatedTime, string afterId, out bool hasMore) {
      hasMore = false;
      if (disposed || limitRows < 1 || limitRows > 2000 || ((afterCreatedTime == null) != (afterId == null)))
        throw new InvalidOperationException("SOURCE_PAGE_INVALID");
      long cursorTimestamp = 0;
      if (afterCreatedTime != null && (!Int64.TryParse(afterCreatedTime, System.Globalization.NumberStyles.AllowLeadingSign,
          System.Globalization.CultureInfo.InvariantCulture, out cursorTimestamp) || String.IsNullOrEmpty(afterId) || afterId.Length > 512))
        throw new InvalidOperationException("SOURCE_CURSOR_INVALID");
      if (readStarted && (afterCreatedTime != expectedCreatedTime || afterId != expectedId))
        throw new InvalidOperationException("SOURCE_CURSOR_INVALID");
      if (!readStarted || deliveredInWindow == InitialImportWindowRows) {
        FinalizeStatement(); ClearPendingRow(); pendingSerializedRow = null; deliveredInWindow = 0; queryDone = false;
        PrepareWindow(afterCreatedTime, afterId, cursorTimestamp);
      }
      readStarted = true;
      owner.lastStage = "page_read";
      owner.SetScanProgressPhase("page_read");
      ThrowProgressFailure();
      List<InitialImportBufferedRow> rows = new List<InitialImportBufferedRow>(limitRows);
      Dictionary<string, NativeConversationInfo> pageCache = new Dictionary<string, NativeConversationInfo>(StringComparer.Ordinal);
      Dictionary<string, NativeSenderInfo> senderNameCache = new Dictionary<string, NativeSenderInfo>(StringComparer.Ordinal);
      long emittedJsonBytes = 0;
      while (rows.Count < limitRows && deliveredInWindow < InitialImportWindowRows) {
        cancellation.ThrowIfCancellationRequested();
        InitialImportBufferedRow ready = pendingSerializedRow;
        pendingSerializedRow = null;
        if (ready == null) {
          NativeSourceRow row;
          int rowBytes;
          if (pendingRow != null) { row = pendingRow; pendingRow = null; pendingBytes = 0; }
          else if (!TryReadRow(out row, out rowBytes)) break;
          string createdTime, id;
          string json = owner.SerializeNativeMessageRow(row, pageCache, senderNameCache, out createdTime, out id);
          ready = new InitialImportBufferedRow(json, createdTime, id);
        }
        long candidateBytes = checked(emittedJsonBytes + Encoding.UTF8.GetByteCount(ready.Json));
        if (!FitsInitialImportPageBudget(candidateBytes, rows.Count + 1)) {
          if (rows.Count == 0) throw new InvalidOperationException("SOURCE_ROW_TOO_LARGE");
          pendingSerializedRow = ready;
          hasMore = true;
          break;
        }
        emittedJsonBytes = candidateBytes;
        rows.Add(ready);
        deliveredInWindow++;
      }
      if (!hasMore && pendingSerializedRow != null) hasMore = true;
      if (!hasMore && deliveredInWindow < InitialImportWindowRows && !queryDone && pendingRow == null) {
        cancellation.ThrowIfCancellationRequested();
        if (TryReadRow(out pendingRow, out pendingBytes)) hasMore = true;
      } else if (!hasMore && deliveredInWindow == InitialImportWindowRows) {
        if (pendingSerializedRow == null && pendingRow == null && !queryDone) {
          cancellation.ThrowIfCancellationRequested();
          TryReadRow(out pendingRow, out pendingBytes);
        }
        hasMore = pendingSerializedRow != null || pendingRow != null || !queryDone;
      }
      if (rows.Count == 0 && hasMore) throw new InvalidOperationException("SOURCE_PAGE_EMPTY_CONTINUATION");
      InitialImportBufferedRow[] result = rows.ToArray();
      expectedCreatedTime = result.Length == 0 ? afterCreatedTime : result[result.Length - 1].CreatedTime;
      expectedId = result.Length == 0 ? afterId : result[result.Length - 1].Id;
      owner.FlushScanProgress();
      ThrowProgressFailure();
      return result;
    }

    static bool FitsInitialImportPageBudget(long emittedJsonBytes, int rowCount) {
      return 3L * emittedJsonBytes + 128L * rowCount + 65536L <= InitialImportPageFrameBytes;
    }

#if SQLITE_FIXTURE_WRITER
    internal int FixtureReprepareCount { get { return statement == IntPtr.Zero ? 0 : owner.statementStatus(statement, 5, 0); } }
    internal int FixtureSortCount { get { return statement == IntPtr.Zero ? 0 : owner.statementStatus(statement, 2, 0); } }
    internal static bool FixtureInitialPageFits(InitialImportBufferedRow[] rows) {
      long bytes = 0;
      foreach (InitialImportBufferedRow row in rows) bytes = checked(bytes + Encoding.UTF8.GetByteCount(row.Json));
      return FitsInitialImportPageBudget(bytes, rows.Length);
    }
    internal static bool FixtureInitialPageFits(string[] rows) {
      long bytes = 0;
      foreach (string row in rows) bytes = checked(bytes + Encoding.UTF8.GetByteCount(row));
      return FitsInitialImportPageBudget(bytes, rows.Length);
    }
#endif

    void PrepareWindow(string afterCreatedTime, string afterId, long cursorTimestamp) {
      owner.lastStage = "authorizer";
      owner.SetReadAuthorizer(MessageColumns);
      string cursorClause = afterCreatedTime == null ? "" : " AND (_createdTime > ? OR (_createdTime = ? AND _id COLLATE BINARY > ?))";
      string sql = "SELECT * FROM _message WHERE _createdTime IS NOT NULL AND _id IS NOT NULL" +
        cursorClause + " ORDER BY _createdTime ASC, _id COLLATE BINARY ASC LIMIT 30001";
      statement = owner.PrepareStatement(sql);
#if SQLITE_FIXTURE_WRITER
      fixtureWindowStatementPreparations++;
#endif
      if (afterCreatedTime != null) {
        owner.lastStage = "bind";
        owner.Bind(statement, 1, cursorTimestamp); owner.Bind(statement, 2, cursorTimestamp); owner.Bind(statement, 3, afterId);
      }
      expectedCreatedTime = afterCreatedTime; expectedId = afterId;
    }

    bool TryReadRow(out NativeSourceRow row, out int rawBytes) {
      row = null; rawBytes = 0;
      if (queryDone) return false;
      owner.SetReadAuthorizer(MessageColumns);
      owner.lastStage = "step";
      int state = owner.step(statement);
      if (state == Done) { queryDone = true; FinalizeStatement(); return false; }
      if (state != Row) {
        if (owner.scanProgressError != null) throw owner.scanProgressError;
        cancellation.ThrowIfCancellationRequested();
        throw owner.Failure("DATABASE_READ_FAILED", state);
      }
      if (columnNames == null) columnNames = owner.ReadColumnNames(statement, NativeMessageColumnNames);
      int totalBytes = 0;
      row = owner.ReadNativeSourceRow(statement, "_message", columnNames, ref totalBytes, MaxResultBytes);
      rawBytes = totalBytes;
      return true;
    }

    void ThrowProgressFailure() {
      if (owner.scanProgressError != null) throw owner.scanProgressError;
      cancellation.ThrowIfCancellationRequested();
    }

    void FinalizeStatement() {
      if (statement != IntPtr.Zero) { owner.finalize(statement); statement = IntPtr.Zero; }
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      try { FinalizeStatement(); }
      finally {
        ClearPendingRow(); pendingSerializedRow = null;
        try { owner.windowReadAuthorizerActive = false; owner.ClearAuthorizer(); }
        finally { owner.hardHeapLimit64(priorHeapLimit); }
      }
    }

    void ClearPendingRow() {
      if (pendingRow == null) return;
      foreach (NativeSourceCell cell in pendingRow.Cells) if (cell != null) cell.Clear();
      pendingRow = null; pendingBytes = 0;
    }
  }
  internal bool ReadMessageHighWater(out string createdTime, out string id) {
    createdTime = null; id = null;
    SetReadAuthorizer(new Dictionary<string, string[]> { { "_message", new string[] { "_id", "_createdTime" } } });
    try {
      List<object[]> rows = QueryLimited("SELECT _createdTime, _id FROM _message WHERE _createdTime IS NOT NULL AND _id IS NOT NULL ORDER BY _createdTime DESC, _id COLLATE BINARY DESC LIMIT 1", 16 * 1024);
      if (rows.Count == 0) return false;
      if (rows.Count != 1 || rows[0].Length != 2 || !(rows[0][0] is long) || !(rows[0][1] is string) ||
          String.IsNullOrEmpty((string)rows[0][1]) || ((string)rows[0][1]).Length > 512)
        throw new InvalidOperationException("SOURCE_ROW_INVALID");
      createdTime = ((long)rows[0][0]).ToString(System.Globalization.CultureInfo.InvariantCulture); id = (string)rows[0][1];
      return true;
    } finally { ClearAuthorizer(); }
  }
  internal string[] ReadMessageTail(int limitRows, bool boundedRound, bool emptyBound, string upperCreatedTime, string upperId) {
    if (limitRows < 1 || limitRows > 50) throw new InvalidOperationException("SOURCE_TAIL_INVALID");
    if (!boundedRound || (emptyBound ? (upperCreatedTime != null || upperId != null) : (String.IsNullOrEmpty(upperCreatedTime) || String.IsNullOrEmpty(upperId))))
      throw new InvalidOperationException("SOURCE_TAIL_INVALID");
    if (emptyBound) return new string[0];
    long upperTimestamp;
    if (!Int64.TryParse(upperCreatedTime, System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out upperTimestamp))
      throw new InvalidOperationException("SOURCE_CURSOR_INVALID");
    SetReadAuthorizer(new Dictionary<string, string[]> { { "_message", NativeMessageColumnNames } });
    try {
      return ReadNativeMessageTailRows("SELECT * FROM _message WHERE _createdTime IS NOT NULL AND _id IS NOT NULL AND (_createdTime < ? OR (_createdTime = ? AND _id COLLATE BINARY <= ?)) ORDER BY _createdTime DESC, _id COLLATE BINARY DESC LIMIT ?",
        limitRows, upperTimestamp, upperTimestamp, upperId, (long)limitRows);
    } finally { ClearAuthorizer(); }
  }

  internal string[] ReadNativeCatalogPage(int pageNumber, string snapshotDigest, out bool hasMore, out string batchDigest) {
    hasMore = false; batchDigest = null;
    if (pageNumber < 1 || pageNumber > 10000 || String.IsNullOrEmpty(snapshotDigest) || snapshotDigest.Length != 64)
      throw new InvalidOperationException("SOURCE_CATALOG_PAGE_INVALID");
    if (catalogPager == null) catalogPager = new NativeCatalogPager(this, snapshotDigest);
    return catalogPager.ReadPage(pageNumber, out hasMore, out batchDigest);
  }

  internal void AckNativeCatalogPage(int pageNumber, string batchDigest) {
    if (catalogPager == null) throw new InvalidOperationException("SOURCE_CATALOG_ACK_INVALID");
    catalogPager.Ack(pageNumber, batchDigest);
  }

  // Directory pass: friend names (_contact) and every _chat's computed title. Keyset
  // paging keeps no open statement between pages, so a caller may close the source
  // connection between ACKs. One pager instance is one pass.
  internal sealed class NativeDirectoryPager {
    const int PageRows = 500;
    const int PagePayloadBytes = 640 * 1024;
    int phase, expectedPage = 1;
    string lastContactMid = "", lastChatId = "";
    string pendingDigest;

    internal string[] ReadPage(Sqlite3Mc reader, int pageNumber, out bool hasMore, out string digest) {
      hasMore = false; digest = null;
      reader.ThrowIfScanCancelled();
      if (pendingDigest != null || pageNumber != expectedPage || phase > 1) throw new InvalidOperationException("SOURCE_DIRECTORY_PAGE_INVALID");
      List<string> records = new List<string>(PageRows);
      int bytes = 0;
      Dictionary<string, NativeConversationInfo> cache = new Dictionary<string, NativeConversationInfo>(StringComparer.Ordinal);
      // Repeat while a window held only unusable rows, so a non-final page is never empty.
      do {
        bool full = false;
        if (phase == 0) {
          List<object[]> rows = reader.ReadDirectoryContactRows(lastContactMid, PageRows + 1);
          bool more = rows.Count > PageRows;
          int take = Math.Min(rows.Count, PageRows);
          for (int i = 0; i < take; i++) {
            object[] row = rows[i];
            string mid = row[0] as string;
            string record = mid == null || mid.Length > 512 || mid.IndexOf('\0') >= 0 ? null : SerializeDirectoryContact(mid, row);
            int rowBytes = record == null ? 0 : Encoding.UTF8.GetByteCount(record);
            if (record != null && records.Count > 0 && bytes + rowBytes > PagePayloadBytes) { more = true; break; }
            if (record != null) { records.Add(record); bytes += rowBytes; }
            lastContactMid = mid;
          }
          if (more) full = true; else phase = 1;
        }
        if (phase == 1 && !full && records.Count < PageRows) {
          int want = PageRows - records.Count;
          List<object[]> rows = reader.ReadDirectoryChatRows(lastChatId, want + 1);
          bool more = rows.Count > want;
          int take = Math.Min(rows.Count, want);
          for (int i = 0; i < take; i++) {
            object[] row = rows[i];
            string chatId = row[0] as string;
            string record = null;
            if (chatId != null && chatId.Length <= 512 && chatId.IndexOf('\0') < 0)
              record = reader.SerializeDirectoryConversation(chatId, row[1] is long ? (long?)(long)row[1] : null, cache);
            int rowBytes = record == null ? 0 : Encoding.UTF8.GetByteCount(record);
            if (record != null && records.Count > 0 && bytes + rowBytes > PagePayloadBytes) { more = true; break; }
            if (record != null) { records.Add(record); bytes += rowBytes; }
            lastChatId = chatId;
          }
          if (!more) phase = 2;
        }
      } while (records.Count == 0 && phase < 2);
      hasMore = phase < 2;
      digest = DigestCatalogRows(records);
      pendingDigest = digest;
      return records.ToArray();
    }

    internal void Ack(int pageNumber, string digest) {
      if (pendingDigest == null || pageNumber != expectedPage || !String.Equals(digest, pendingDigest, StringComparison.Ordinal))
        throw new InvalidOperationException("SOURCE_DIRECTORY_ACK_INVALID");
      pendingDigest = null; expectedPage++;
    }

    static string SerializeDirectoryContact(string mid, object[] row) {
      string displayName, nickname;
      ResolveContactNames(row, 1, 2, row.Length >= 7 ? 5 : -1, row.Length >= 7 ? 6 : -1, out displayName, out nickname);
      string picturePath = row.Length > 5 ? ContactJsonPicturePath(row[5]) : null;
      if (picturePath == null && row.Length > 7) picturePath = ValidOptionalText(row[7], 2048);
      long? type = row.Length > 3 && row[3] is long ? (long?)(long)row[3] : null;
      long? status = row.Length > 4 && row[4] is long ? (long?)(long)row[4] : null;
      if (type.HasValue && (type.Value < Int32.MinValue || type.Value > Int32.MaxValue)) type = null;
      if (status.HasValue && (status.Value < Int32.MinValue || status.Value > Int32.MaxValue)) status = null;
      return "{\"kind\":\"contact\",\"mid\":" + JsonQuote(mid) + ",\"displayName\":" + JsonNullable(displayName) +
        ",\"nickname\":" + JsonNullable(nickname) + ",\"picturePath\":" + JsonNullable(picturePath) + ",\"type\":" + (type.HasValue ? type.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : "null") +
        ",\"status\":" + (status.HasValue ? status.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : "null") + "}";
    }
  }

  NativeDirectoryPager directoryPager;
  int? contactDirectoryLevel;

  internal string[] ReadNativeDirectoryPage(int pageNumber, out bool hasMore, out string batchDigest) {
    hasMore = false; batchDigest = null;
    if (pageNumber < 1 || pageNumber > 10000) throw new InvalidOperationException("SOURCE_DIRECTORY_PAGE_INVALID");
    if (directoryPager == null) directoryPager = new NativeDirectoryPager();
    return directoryPager.ReadPage(this, pageNumber, out hasMore, out batchDigest);
  }

  internal void AckNativeDirectoryPage(int pageNumber, string batchDigest) {
    if (directoryPager == null) throw new InvalidOperationException("SOURCE_DIRECTORY_ACK_INVALID");
    directoryPager.Ack(pageNumber, batchDigest);
  }

  /// <summary>Keyset page of _contact rows ordered by _mid. Optional JSON name columns and picture columns degrade
  /// independently so schemas without any of them still complete the import.</summary>
  List<object[]> ReadDirectoryContactRows(string afterMid, int limit) {
  int level = contactDirectoryLevel ?? 4;
    for (;;) {
      SetReadAuthorizer(new Dictionary<string, string[]> {
        { "_contact", new string[] { "_mid", "_displayName", "_displayNameOverridden", "_type", "_status", "_targetProfileDetail", "_friendDetail", "_picturePath" } }
      });
      try {
        string tail = " FROM _contact WHERE typeof(_mid)='text' AND _mid COLLATE BINARY > ? ORDER BY _mid COLLATE BINARY LIMIT ?";
        string sql = level == 4
          ? "SELECT _mid, substr(_displayName,1,300), substr(_displayNameOverridden,1,300), _type, _status, substr(_targetProfileDetail,1,8193), substr(_friendDetail,1,8193), substr(_picturePath,1,2049)" + tail
          : level == 3
          ? "SELECT _mid, substr(_displayName,1,300), substr(_displayNameOverridden,1,300), _type, _status, substr(_targetProfileDetail,1,8193), substr(_friendDetail,1,8193)" + tail
          : level == 2
          ? "SELECT _mid, substr(_displayName,1,300), substr(_displayNameOverridden,1,300), _type, _status, NULL, NULL, substr(_picturePath,1,2049)" + tail
          : level == 1
          ? "SELECT _mid, substr(_displayName,1,300), substr(_displayNameOverridden,1,300), _type, _status" + tail
          : "SELECT _mid, substr(_displayName,1,300)" + tail;
        List<object[]> rows = QueryLimited(sql, 32 * 1024 * 1024, afterMid, (long)limit);
        contactDirectoryLevel = level;
        return rows;
      } catch (InvalidOperationException error) {
        if (level == 0 || !IsPrepareSchemaMiss(error)) throw;
        level--; contactDirectoryLevel = level;
      } finally { ClearAuthorizer(); }
    }
  }

  List<object[]> ReadDirectoryChatRows(string afterId, int limit) {
    SetReadAuthorizer(new Dictionary<string, string[]> { { "_chat", new string[] { "_id", "_midType" } } });
    try {
      return QueryLimited("SELECT _id, _midType FROM _chat WHERE typeof(_id)='text' AND _id COLLATE BINARY > ? ORDER BY _id COLLATE BINARY LIMIT ?",
        2 * 1024 * 1024, afterId, (long)limit);
    } finally { ClearAuthorizer(); }
  }

  internal const int MaxUnreadCountEntries = 2000;
  internal const long MaxUnreadCountValue = 1000000;

  /// <summary>Reads LINE's own per-chat unread counts (chats with a count above zero). supported=false (never a throw)
  /// when the column is missing, there are more than 2000 rows, or any row is outside the bounded shape.</summary>
  internal List<KeyValuePair<string, long>> ReadChatUnreadCounts(out bool supported) {
    supported = false;
    List<KeyValuePair<string, long>> result = new List<KeyValuePair<string, long>>();
    SetReadAuthorizer(new Dictionary<string, string[]> { { "_chat", new string[] { "_id", "_unreadCount" } } });
    try {
      List<object[]> rows;
      try {
        rows = QueryLimited("SELECT _id, _unreadCount FROM _chat WHERE typeof(_id)='text' AND _unreadCount > 0 ORDER BY _id COLLATE BINARY LIMIT 2001",
          4 * 1024 * 1024);
      } catch (InvalidOperationException error) {
        if (!IsPrepareSchemaMiss(error)) throw;
        return result;
      }
      if (rows.Count > MaxUnreadCountEntries) return new List<KeyValuePair<string, long>>();
      foreach (object[] row in rows) {
        string id = row.Length == 2 ? row[0] as string : null;
        if (id == null || id.Length == 0 || id.Length > 512 || !(row[1] is long)) return new List<KeyValuePair<string, long>>();
        long count = (long)row[1];
        if (count < 1 || count > MaxUnreadCountValue) return new List<KeyValuePair<string, long>>();
        result.Add(new KeyValuePair<string, long>(id, count));
      }
      supported = true;
      return result;
    } finally { ClearAuthorizer(); }
  }

  string SerializeDirectoryConversation(string chatId, long? midType, Dictionary<string, NativeConversationInfo> cache) {
    NativeConversationInfo info = ReadNativeConversationInfo(chatId, midType, cache);
    return "{\"kind\":\"conversation\",\"chatId\":" + JsonQuote(chatId) + ",\"chatType\":" + JsonQuote(info.ChatType) +
      ",\"title\":" + JsonNullable(info.Title) + ",\"picturePath\":" + JsonNullable(info.PicturePath) + ",\"nativeMetadata\":{\"midType\":" +
      (info.MidType.HasValue ? info.MidType.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : "null") +
      ",\"parentChatId\":" + JsonNullable(info.ParentChatId) + ",\"communityId\":" + JsonNullable(info.CommunityId) + "}}";
  }

  sealed class NativeCatalogPager {
    const int PageRows = 1000;
    const int PagePayloadBytes = 2 * 1024 * 1024;
    readonly Sqlite3Mc owner;
    readonly string snapshotDigest;
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue, RecursionLimit = 32 };
    int tableIndex, expectedPage = 1;
    IntPtr statement;
    string currentTable, pendingRecord, pendingDigest;
    string[] columns;
    int[] primaryKeyColumns;
    bool pendingHasMore, terminalNeeded, terminalSent, finished, disposed;

    internal NativeCatalogPager(Sqlite3Mc reader, string digest) { owner = reader; snapshotDigest = digest; }

    internal string[] ReadPage(int pageNumber, out bool hasMore, out string digest) {
      hasMore = false; digest = null;
      owner.ThrowIfScanCancelled();
      if (finished || pendingDigest != null || pageNumber != expectedPage) throw new InvalidOperationException("SOURCE_CATALOG_PAGE_INVALID");
      List<string> records = new List<string>(PageRows);
      int bytes = 0;
      bool emitTerminalPage = terminalNeeded;
      terminalNeeded = false;
      bool reachedEnd = false;
      while (!emitTerminalPage && records.Count < PageRows) {
        string record = pendingRecord;
        pendingRecord = null;
        if (record == null) record = ReadNextRecord();
        if (record == null) { if (records.Count > 0) reachedEnd = true; break; }
        int rowBytes = Encoding.UTF8.GetByteCount(record);
        if (checked(bytes + rowBytes) > PagePayloadBytes) {
          if (records.Count == 0) throw new InvalidOperationException("SOURCE_CATALOG_ROW_TOO_LARGE");
          pendingRecord = record; break;
        }
        records.Add(record); bytes += rowBytes;
      }
      if (!emitTerminalPage && records.Count == PageRows && pendingRecord == null) {
        pendingRecord = ReadNextRecord();
        if (pendingRecord == null) reachedEnd = true;
      }
      hasMore = pendingRecord != null || reachedEnd;
      if (reachedEnd) terminalNeeded = true;
      if (records.Count == 0 && !hasMore) {
        if (terminalSent) throw new InvalidOperationException("SOURCE_CATALOG_PAGE_INVALID");
        terminalSent = true;
        terminalNeeded = false;
      }
      digest = DigestCatalogRows(records);
      pendingDigest = digest; pendingHasMore = hasMore;
      return records.ToArray();
    }

    internal void Ack(int pageNumber, string digest) {
      if (pendingDigest == null || pageNumber != expectedPage || !String.Equals(digest, pendingDigest, StringComparison.Ordinal))
        throw new InvalidOperationException("SOURCE_CATALOG_ACK_INVALID");
      pendingDigest = null;
      expectedPage++;
      if (!pendingHasMore) { finished = true; FinalizeStatement(); }
    }

    internal void Dispose() {
      if (disposed) return;
      disposed = true;
      FinalizeStatement();
      pendingRecord = null; pendingDigest = null; columns = null; primaryKeyColumns = null;
    }

    string ReadNextRecord() {
      for (;;) {
        owner.ThrowIfScanCancelled();
        if (statement == IntPtr.Zero) {
          if (tableIndex >= NativeCatalogTableNames.Length) return null;
          currentTable = NativeCatalogTableNames[tableIndex];
          ReadTableDefinition(currentTable, out columns, out primaryKeyColumns);
          if (columns.Length == 0) { tableIndex++; continue; }
          Dictionary<string, string[]> allowed = new Dictionary<string, string[]>(StringComparer.Ordinal) { { currentTable, AddRowIdColumn(columns) } };
          owner.SetReadAuthorizer(allowed);
          statement = owner.PrepareStatement("SELECT rowid,* FROM \"" + currentTable + "\"");
          string[] selectColumns = owner.ReadColumnNames(statement, AddRowIdColumn(columns));
          if (selectColumns.Length != columns.Length + 1 || !String.Equals(selectColumns[0], "rowid", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
        }
        owner.lastStage = "step";
        int state = owner.step(statement);
        if (state == Done) { FinalizeStatement(); tableIndex++; columns = null; primaryKeyColumns = null; continue; }
        if (state != Row) {
          if (owner.scanProgressError != null) throw owner.scanProgressError;
          throw owner.Failure("DATABASE_READ_FAILED", state);
        }
        if (owner.columnType(statement, 0) != 1) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
        long rowId = owner.columnInt64(statement, 0);
        int totalBytes = 0;
        NativeSourceRow row = owner.ReadNativeSourceRow(statement, currentTable, columns, 1, ref totalBytes, MaxCellBytes * columns.Length);
        string key = BuildRecordKey(row, rowId);
        string payload = row.PlainEnvelopeJson();
        return "{\"tableName\":" + JsonQuote(currentTable) + ",\"recordKey\":" + JsonQuote(key) + ",\"nativePayload\":" + payload + "}";
      }
    }

    void ReadTableDefinition(string table, out string[] names, out int[] pkColumns) {
      owner.allowCatalogPragma = true; owner.catalogPragmaTable = table;
      owner.SetReadAuthorizer(new Dictionary<string, string[]>(StringComparer.Ordinal));
      List<string> found = new List<string>(32); List<KeyValuePair<int, int>> keys = new List<KeyValuePair<int, int>>();
      IntPtr pragma = IntPtr.Zero;
      try {
        pragma = owner.PrepareStatement("PRAGMA table_info(\"" + table + "\")");
        int state;
        while ((state = owner.step(pragma)) == Row) {
          if (found.Count >= 256) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
          int bytes = 0;
          object rawName = owner.Column(pragma, 1, ref bytes, 1024);
          object rawPk = owner.Column(pragma, 5, ref bytes, 1024);
          string name = rawName as string;
          if (String.IsNullOrEmpty(name) || name.Length > 128 || found.Contains(name)) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
          found.Add(name);
          if (!(rawPk is long) || (long)rawPk < 0 || (long)rawPk > 256) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
          if ((long)rawPk > 0) keys.Add(new KeyValuePair<int, int>((int)(long)rawPk, found.Count - 1));
        }
        if (state != Done) throw owner.Failure("DATABASE_READ_FAILED", state);
      } finally {
        if (pragma != IntPtr.Zero) owner.finalize(pragma);
        owner.allowCatalogPragma = false; owner.catalogPragmaTable = null; owner.ClearAuthorizer();
      }
      names = found.ToArray();
      keys.Sort(delegate(KeyValuePair<int, int> left, KeyValuePair<int, int> right) { return left.Key.CompareTo(right.Key); });
      pkColumns = new int[keys.Count];
      for (int i = 0; i < keys.Count; i++) {
        if (keys[i].Key != i + 1) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
        pkColumns[i] = keys[i].Value;
      }
    }

    string BuildRecordKey(NativeSourceRow row, long rowId) {
      if (primaryKeyColumns.Length == 0) return "rowid:" + snapshotDigest + ":" + rowId.ToString(System.Globalization.CultureInfo.InvariantCulture);
      List<object> values = new List<object>(primaryKeyColumns.Length);
      bool nullPrimaryKey = false;
      foreach (int index in primaryKeyColumns) {
        NativeSourceCell cell = row.Cells[index];
        if (cell.SqliteType == 5) { nullPrimaryKey = true; break; }
        values.Add(cell.SourceJsonValue());
      }
      if (nullPrimaryKey) return "rowid:" + snapshotDigest + ":" + rowId.ToString(System.Globalization.CultureInfo.InvariantCulture);
      string canonical = json.Serialize(values);
      return "pk:" + canonical;
    }

    void FinalizeStatement() {
      if (statement != IntPtr.Zero) { owner.finalize(statement); statement = IntPtr.Zero; }
    }
  }

  static string[] AddRowIdColumn(string[] columns) {
    string[] result = new string[columns.Length + 1];
    result[0] = "rowid"; Array.Copy(columns, 0, result, 1, columns.Length); return result;
  }

  static string DigestCatalogRows(List<string> rows) {
    using (MemoryStream stream = new MemoryStream())
    using (SHA256 sha = SHA256.Create()) {
      for (int i = 0; i < rows.Count; i++) {
        if (i > 0) stream.WriteByte((byte)'\n');
        byte[] bytes = Encoding.UTF8.GetBytes(rows[i]);
        try { stream.Write(bytes, 0, bytes.Length); }
        finally { Array.Clear(bytes, 0, bytes.Length); }
      }
      byte[] preimage = stream.ToArray();
      try { byte[] digest = sha.ComputeHash(preimage); try { return NativeSourceCell.Hex(digest); } finally { Array.Clear(digest, 0, digest.Length); } }
      finally { Array.Clear(preimage, 0, preimage.Length); }
    }
  }

  static string JsonQuote(string value) {
    StringBuilder result = new StringBuilder(value.Length + 2); result.Append('"');
    foreach (char ch in value) {
      if (ch == '"') result.Append("\\\""); else if (ch == '\\') result.Append("\\\\");
      else if (ch == '\b') result.Append("\\b"); else if (ch == '\f') result.Append("\\f"); else if (ch == '\n') result.Append("\\n");
      else if (ch == '\r') result.Append("\\r"); else if (ch == '\t') result.Append("\\t");
      else if (ch < 0x20) result.Append("\\u").Append(((int)ch).ToString("x4")); else result.Append(ch);
    }
    return result.Append('"').ToString();
  }
  static string ContentKind(object value) {
    if (!(value is long)) return "event";
    switch ((long)value) {
      case 0: return "text"; case 1: return "image"; case 2: return "video"; case 3: return "audio";
      case 7: return "sticker"; case 13: return "contact"; case 14: return "file"; default: return "event";
    }
  }
#if SQLITE_FIXTURE_WRITER
  internal void InsertFixtureWindowMessages(int count, string text = "window fixture") {
    if (count < 1 || count > 65000) throw new InvalidOperationException("FIXTURE_WINDOW_COUNT_INVALID");
    if (text == null || text.Length > 4096) throw new InvalidOperationException("FIXTURE_WINDOW_TEXT_INVALID");
    IntPtr statement = PrepareStatement("INSERT INTO _message(_id,_from,_toType,_createdTime,_text,_contentType,_contentMetadata,_contentInfo,_relatedMessageId,_type,_status,_rev,_chatId) VALUES(?,'fixture-sender',0,1000,?,0,NULL,NULL,NULL,0,0,1,'fixture-chat')");
    RunStatement("BEGIN IMMEDIATE");
    try {
      for (int i = 0; i < count; i++) {
        Bind(statement, 1, "window-" + i.ToString("D5", System.Globalization.CultureInfo.InvariantCulture));
        Bind(statement, 2, text);
        if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED");
        if (i + 1 < count && reset(statement) != 0) throw new InvalidOperationException("FIXTURE_WRITE_FAILED");
      }
      RunStatement("COMMIT");
    } catch { RunStatement("ROLLBACK"); throw; }
    finally { finalize(statement); }
  }
  internal void InsertFixtureMixedWindowMessages(int count, int densePrefixRows, string denseText) {
    if (count < 1 || count > 65000 || densePrefixRows < 1 || densePrefixRows >= count || denseText == null || denseText.Length > 4096)
      throw new InvalidOperationException("FIXTURE_WINDOW_COUNT_INVALID");
    IntPtr statement = PrepareStatement("INSERT INTO _message(_id,_from,_toType,_createdTime,_text,_contentType,_contentMetadata,_contentInfo,_relatedMessageId,_type,_status,_rev,_chatId) VALUES(?,'fixture-sender',0,1000,?,0,NULL,NULL,NULL,0,0,1,'fixture-chat')");
    RunStatement("BEGIN IMMEDIATE");
    try {
      for (int i = 0; i < count; i++) {
        Bind(statement, 1, "window-" + i.ToString("D5", System.Globalization.CultureInfo.InvariantCulture));
        Bind(statement, 2, i < densePrefixRows ? denseText : "window fixture");
        if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED");
        if (i + 1 < count && reset(statement) != 0) throw new InvalidOperationException("FIXTURE_WRITE_FAILED");
      }
      RunStatement("COMMIT");
    } catch { RunStatement("ROLLBACK"); throw; }
    finally { finalize(statement); }
  }
  internal void InsertFixtureOversizeMessage(int quoteCount) {
    if (quoteCount < 1 || quoteCount > 2 * 1024 * 1024) throw new InvalidOperationException("FIXTURE_WINDOW_COUNT_INVALID");
    IntPtr statement = PrepareStatement("INSERT INTO _message(_id,_from,_toType,_createdTime,_text,_contentType,_contentMetadata,_contentInfo,_relatedMessageId,_type,_status,_rev,_chatId) VALUES(?,'fixture-sender',0,1000,?,0,NULL,NULL,NULL,0,0,1,'fixture-chat')");
    try {
      Bind(statement, 1, "window-oversize"); Bind(statement, 2, new string('"', quoteCount));
      if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED");
    } finally { finalize(statement); }
  }
  internal void InsertFixtureLargeAggregateRows(string prefix, int count, int payloadBytes, long createdTime) {
    if (String.IsNullOrEmpty(prefix) || prefix.Length > 64 || count < 1 || count > 50 || payloadBytes < 1 || payloadBytes > 100000)
      throw new InvalidOperationException("FIXTURE_WINDOW_COUNT_INVALID");
    string metadata = "{\"note\":\"" + new string('m', payloadBytes) + "\"}";
    for (int i = 0; i < count; i++) {
      string id = prefix + i.ToString("D3", System.Globalization.CultureInfo.InvariantCulture);
      InsertFixtureTypedChatMessage(id, createdTime, "fixture-chat", 0, 0);
      IntPtr statement = PrepareStatement("UPDATE _message SET _contentMetadata=?,_contentPreview=zeroblob(?) WHERE _id=?");
      try {
        Bind(statement, 1, metadata); Bind(statement, 2, payloadBytes); Bind(statement, 3, id);
        if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED");
      } finally { finalize(statement); }
    }
  }
  internal void InsertFixtureSocialRows() {
    InsertFixtureLongCommunityCatalog();
    RunStatement("INSERT INTO _squareMember(_squareMemberMid,_squareMid,_displayName,_profileImageObsHash) VALUES('fixture-sender','fixture-square','Square Alias','senderobs-hash-fixture12345678')");
    InsertFixtureTypedChatMessage("m-direct", 1001, "fixture-chat", 2, 999);
    InsertFixtureTypedChatMessage("m-group", 1001, "fixture-group", null, 0);
    InsertFixtureTypedChatMessage("m-primary", 1001, "fixture-chat", null, 0);
    InsertFixtureTypedChatMessage("m-community", 1001, "fixture-community-chat", 4, 18);
    SetFixtureContentMetadata("m-community", "synthetic A\uD83D\uDE42 @x @all", "{\"MENTION\":\"{\\\"MENTIONEES\\\":[{\\\"S\\\":\\\"4\\\",\\\"E\\\":\\\"6\\\",\\\"M\\\":\\\"fixture-target\\\"},{\\\"S\\\":\\\"7\\\",\\\"E\\\":\\\"11\\\",\\\"A\\\":\\\"1\\\"}]}\"}");
    InsertFixtureTypedChatMessage("m-long-community", 1001, "fixture-long-community", 4, 22);
    SetFixtureContentMetadata("m-long-community", "oversized optional metadata", new string('x', 16 * 1024 + 1));
    InsertFixtureTypedChatMessage("m-thread", 1001, "fixture-thread", 7, 99);
    InsertFixtureTypedChatMessage("m-room", 1001, "fixture-room", 1, 0);
    SetFixtureContentMetadata("m-room", "malformed optional metadata", "{not-json");
    InsertFixtureTypedChatMessage("m-unknown", 1002, "fixture-unknown", 9, 42);
    InsertFixtureTypedChatMessage("m-content-contact", 1001, "fixture-chat", 0, 13);
    SetFixtureContentMetadata("m-content-contact", "contact fallback", "{\"mid\":\"u-fixture\",\"displayName\":\"Fixture Friend\"}");
    InsertFixtureTypedChatMessage("m-content-location", 1001, "fixture-chat", 0, 15);
    InsertFixtureTypedChatMessage("m-content-rich", 1001, "fixture-chat", 0, 17);
    SetFixtureContentMetadata("m-content-rich", "rich fallback", "{\"ALT_TEXT\":\"Rich card\",\"FLEX_JSON\":\"secret payload ignored\"}");
    InsertFixtureTypedChatMessage("m-content-flex", 1001, "fixture-chat", 0, 22);
    SetFixtureContentMetadata("m-content-flex", "flex fallback", "{\"ALT_TEXT\":\"Flex card\",\"FLEX_JSON\":\"secret payload ignored\"}");
    InsertFixtureTypedChatMessage("m-content-video", 1001, "fixture-chat", 0, 2);
    SetFixtureContentMetadata("m-content-video", "video", "{\"DURATION\":\"12345\"}");
    InsertFixtureTypedChatMessage("m-content-audio", 1001, "fixture-chat", 0, 3);
    SetFixtureContentMetadata("m-content-audio", "audio", "{\"DURATION\":\"bad\"}");
    foreach (long systemType in new long[] { 6, 9, 16 }) InsertFixtureTypedChatMessage("m-content-event-" + systemType.ToString(), 1001, "fixture-chat", 0, systemType);
    IntPtr relation = PrepareStatement("UPDATE _message SET _messageRelationType=3,_relatedMessageId='m-01' WHERE _id='m-content-video'");
    try { if (step(relation) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED"); } finally { finalize(relation); }
    InsertFixtureTypedChatMessage("m-sticker-direct", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-direct", "direct sticker", "{\"STKID\":\"10001\",\"STKPKGID\":\"20001\",\"STKVER\":\"3\",\"STKTXT\":\" hello\\n sticker \",\"STKOPT\":\"A\"}");
    InsertFixtureTypedChatMessage("m-sticker-nested", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-nested", "nested sticker", "{\"STK\":\"{\\\"STKID\\\":\\\"10002\\\",\\\"STKPKGID\\\":\\\"20002\\\",\\\"STKVER\\\":\\\"4\\\",\\\"STKOPT\\\":\\\"A\\\"}\"}");
    InsertFixtureTypedChatMessage("m-sticker-conflict", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-conflict", "conflicting sticker", "{\"STKID\":\"invalid\",\"STK\":\"{\\\"STKID\\\":\\\"99999\\\"}\"}");
    InsertFixtureTypedChatMessage("m-sticker-malformed", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-malformed", "malformed sticker", "{not-json");
    InsertFixtureTypedChatMessage("m-sticker-oversized", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-oversized", "oversized sticker", new string('x', 16 * 1024 + 1));
    InsertFixtureTypedChatMessage("m-sticker-boundary-direct", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-boundary-direct", "direct boundary sticker", "{\"STKID\":\"10004\",\"STKPKGID\":\"20004\",\"STKVER\":\"6\",\"STKTXT\":\"" + new string('a', 199) + " b\"}");
    InsertFixtureTypedChatMessage("m-sticker-boundary-nested", 1001, "fixture-chat", 0, 7);
    string nestedBoundarySticker = "{\"STKID\":\"10005\",\"STKPKGID\":\"20005\",\"STKVER\":\"7\",\"STKTXT\":\"" + new string('a', 198) + "\uD83D\uDE42b\"}";
    SetFixtureContentMetadata("m-sticker-boundary-nested", "nested boundary sticker", "{\"STK\":\"" + nestedBoundarySticker.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}");
    InsertFixtureTypedChatMessage("m-sticker-direct-max", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-direct-max", "direct maximum sticker", "{\"STKID\":\"10006\",\"STKPKGID\":\"20006\",\"STKVER\":\"8\",\"STKTXT\":\"" + new string('a', 200) + "\"}");
    InsertFixtureTypedChatMessage("m-sticker-nested-space-boundary", 1001, "fixture-chat", 0, 7);
    string nestedSpaceBoundarySticker = "{\"STKID\":\"10007\",\"STKPKGID\":\"20007\",\"STKVER\":\"9\",\"STKTXT\":\"" + new string('a', 199) + " b\"}";
    SetFixtureContentMetadata("m-sticker-nested-space-boundary", "nested spaced boundary sticker", "{\"STK\":\"" + nestedSpaceBoundarySticker.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}");
    InsertFixtureTypedChatMessage("m-sticker-numeric-direct", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-numeric-direct", "numeric direct sticker", "{\"STKPKGID\":20008,\"STKID\":10008,\"STKVER\":1,\"STKOPT\":\"A\"}");
    InsertFixtureTypedChatMessage("m-sticker-numeric-nested", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-numeric-nested", "numeric nested sticker", "{\"STK\":\"{\\\"STKID\\\":10009,\\\"STKPKGID\\\":20009,\\\"STKVER\\\":2}\"}");
    InsertFixtureTypedChatMessage("m-sticker-numeric-negative", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-numeric-negative", "negative numeric sticker", "{\"STKID\":-5,\"STKPKGID\":20010}");
    InsertFixtureTypedChatMessage("m-sticker-numeric-fractional", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-numeric-fractional", "fractional numeric sticker", "{\"STKID\":10011.5,\"STKPKGID\":20011}");
    InsertFixtureTypedChatMessage("m-sticker-invalid-optional", 1001, "fixture-chat", 0, 7);
    SetFixtureContentMetadata("m-sticker-invalid-optional", "invalid optional sticker fields", "{\"STKID\":\"10003\",\"STKPKGID\":\"20003x\",\"STKVER\":\"30003\"}");
  }
  /// <summary>Official-shaped directory tables: full _contact columns (nickname, type, status), many contacts and chats.</summary>
  internal void CreateFixtureDirectoryTables(int bulkContacts, int bulkChats) {
    RunStatement("PRAGMA journal_mode=WAL");
    RunStatement("CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    RunStatement("INSERT INTO fixture(id,value) VALUES(1,'fixture-row')");
    RunStatement("CREATE TABLE _contact (_mid TEXT, _createdTime INTEGER, _type INTEGER, _status INTEGER, _displayName TEXT, _displayNameOverridden TEXT, _statusMessage TEXT, _phone TEXT, _targetProfileDetail TEXT, _friendDetail TEXT, _picturePath TEXT)");
    RunStatement("CREATE TABLE _chat (_id TEXT NOT NULL, _midType INTEGER)");
    RunStatement("CREATE TABLE _groupChat (_chatMid TEXT, _chatName TEXT, _picturePath TEXT)");
    RunStatement("CREATE TABLE _squareChat (_squareChatMid TEXT, _squareMid TEXT, _name TEXT, _chatImageObsHash TEXT)");
    RunStatement("CREATE TABLE _squareThread (_threadMid TEXT, _chatMid TEXT, _squareMid TEXT)");
    RunStatement("INSERT INTO _contact(_mid,_type,_status,_displayName,_displayNameOverridden,_statusMessage,_phone) VALUES"
      + "('u-nick',0,1,'Real Name','張襄君','secret status','0900000000'),"
      + "('u-plain',0,1,'Plain Name',''," + "NULL,NULL),"
      + "('u-nameless',0,2,NULL,NULL,NULL,NULL),"
      + "('',0,1,'Empty Mid',NULL,NULL,NULL),"
      + "(NULL,0,1,'Null Mid',NULL,NULL,NULL),"
      + "('u-long',0,1,'" + new string('L', 300) + "','" + new string('N', 270) + "',NULL,NULL)");
    RunStatement("BEGIN IMMEDIATE");
    try {
      for (int i = 0; i < bulkContacts; i++)
        RunStatement("INSERT INTO _contact(_mid,_type,_status,_displayName) VALUES('bulk-" + i.ToString("D5", System.Globalization.CultureInfo.InvariantCulture) + "',0,1,'Bulk " + i.ToString(System.Globalization.CultureInfo.InvariantCulture) + "')");
      for (int i = 0; i < bulkChats; i++)
        RunStatement("INSERT INTO _chat(_id,_midType) VALUES('bulk-" + i.ToString("D5", System.Globalization.CultureInfo.InvariantCulture) + "',0)");
      RunStatement("COMMIT");
    } catch { RunStatement("ROLLBACK"); throw; }
    RunStatement("INSERT INTO _chat(_id,_midType) VALUES('u-nick',0),('u-plain',0),('u-nameless',0),('u-unknown',0),('g-1',2),('g-long-picture',2),('g-oversized-picture',2),('sq-chat',4),('th-1',7),('room-1',1),('odd-1',NULL)");
    RunStatement("UPDATE _contact SET _targetProfileDetail='{\"picturePath\":\"/fixture-picture\"}' WHERE _mid='u-nick'");
    RunStatement("INSERT INTO _groupChat(_chatMid,_chatName,_picturePath) VALUES('g-1','Group One','/group-fixture-picture')");
    RunStatement("INSERT INTO _groupChat(_chatMid,_chatName,_picturePath) VALUES('g-long-picture','Long Picture','/" + new string('p', 256) + "'),('g-oversized-picture','Oversized Picture','" + new string('x', 2049) + "')");
    RunStatement("INSERT INTO _squareChat(_squareChatMid,_squareMid,_name,_chatImageObsHash) VALUES('sq-chat','sq-1','Square Chat','squareobs-hash-fixture12345678')");
    RunStatement("INSERT INTO _squareThread(_threadMid,_chatMid,_squareMid) VALUES('th-1','sq-chat','sq-1')");
  }
  /// <summary>Newer-build _contact: names live in the _targetProfileDetail / _friendDetail JSON columns (legacy name columns may be NULL).</summary>
  internal void CreateFixtureJsonContactTables() {
    RunStatement("CREATE TABLE _contact (_mid TEXT, _type INTEGER, _status INTEGER, _displayName TEXT, _displayNameOverridden TEXT, _targetProfileDetail TEXT, _friendDetail TEXT)");
    RunStatement("CREATE TABLE _chat (_id TEXT NOT NULL, _midType INTEGER)");
    RunStatement("CREATE TABLE _groupChat (_chatMid TEXT, _chatName TEXT)");
    RunStatement("CREATE TABLE _squareChat (_squareChatMid TEXT, _squareMid TEXT, _name TEXT)");
    RunStatement("CREATE TABLE _squareThread (_threadMid TEXT, _chatMid TEXT, _squareMid TEXT)");
    RunStatement("INSERT INTO _contact(_mid,_type,_status,_displayName,_displayNameOverridden,_targetProfileDetail,_friendDetail) VALUES"
      + "('j-nick',0,1,NULL,NULL,'{\"profileName\":\"JSON Profile\",\"picturePath\":\"/p\"}','{\"user\":{\"overriddenName\":\"JSON Nick\",\"hidden\":false}}'),"
      + "('j-profile',0,1,NULL,NULL,'{\"profileName\":\"JSON Profile2\"}','{\"bot\":{\"hidden\":false}}'),"
      + "('j-bad',0,1,'Legacy Name','Legacy Nick','{not json','[1]'),"
      + "('j-legacy',0,1,'Old Name','Old Nick',NULL,NULL),"
      + "('j-nonstring',0,1,'Fallback Name',NULL,'{\"profileName\":5}','{\"user\":{\"overriddenName\":{}}}'),"
      + "('j-big',0,1,'Big Legacy',NULL,'{\"profileName\":\"Too Big\",\"pad\":\"" + new string('p', 8200) + "\"}',NULL),"
      + "('j-empty',0,1,NULL,NULL,'{\"profileName\":\"\"}','{\"user\":{\"overriddenName\":\"\"}}')");
    RunStatement("INSERT INTO _chat(_id,_midType) VALUES('j-nick',0),('j-profile',0),('j-bad',0),('j-legacy',0),('j-nonstring',0),('j-big',0),('j-empty',0)");
  }
  internal void UpdateFixtureContactNickname(string mid, string nickname) {
    IntPtr statement = PrepareStatement("UPDATE _contact SET _displayNameOverridden = ? WHERE _mid = ?");
    try { Bind(statement, 1, nickname); Bind(statement, 2, mid); if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED"); }
    finally { finalize(statement); }
  }
  void SetFixtureContentMetadata(string id, string text, string metadata) {
    IntPtr statement = PrepareStatement("UPDATE _message SET _text = ?, _contentMetadata = ? WHERE _id = ?");
    try { Bind(statement, 1, text); Bind(statement, 2, metadata); Bind(statement, 3, id); if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED"); }
    finally { finalize(statement); }
  }
  internal void InsertFixtureCommunityThreadMessages() {
    InsertFixtureTypedChatMessage("m-optional-community", 2001, "fixture-community-chat", 4, 18);
    InsertFixtureTypedChatMessage("m-optional-thread", 2002, "fixture-thread", 7, 99);
  }
  internal void SetFixtureSquareMemberMalformedName() {
    RunStatement("UPDATE _squareMember SET _displayName='" + new string('x', 257) + "' WHERE _squareMemberMid='fixture-sender'");
  }
  internal void DropFixtureSquareMemberCatalog() { RunStatement("DROP TABLE _squareMember"); }
  internal void InsertFixtureOtherCommunityMessage() {
    RunStatement("INSERT INTO _chat(_id,_midType,_name) VALUES('fixture-other-community',4,NULL)");
    RunStatement("INSERT INTO _squareChat(_squareChatMid,_squareMid,_name) VALUES('fixture-other-community','other-square','Other Square')");
    InsertFixtureTypedChatMessage("m-other-community", 1003, "fixture-other-community", 4, 18);
  }
  internal void InsertFixtureEmptySenderMessages() {
    InsertFixtureEmptySenderMessage("m-empty-sender-direct", 1003, "fixture-chat", 0, String.Empty);
    InsertFixtureEmptySenderMessage("m-empty-sender-community", 1003, "fixture-community-chat", 4, "archived body");
  }
  internal void InsertFixtureNullSenderMessage() {
    IntPtr statement = PrepareStatement("INSERT INTO _message(_id,_from,_toType,_createdTime,_text,_contentType,_contentMetadata,_contentInfo,_relatedMessageId,_type,_status,_rev,_chatId) VALUES(?,NULL,0,1004,'malformed',0,NULL,NULL,NULL,0,0,1,'fixture-chat')");
    try {
      Bind(statement, 1, "m-null-sender");
      if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED");
    } finally { finalize(statement); }
  }
  void InsertFixtureEmptySenderMessage(string id, long createdTime, string chatId, long toType, string text) {
    IntPtr statement = PrepareStatement("INSERT INTO _message(_id,_from,_toType,_createdTime,_text,_contentType,_contentMetadata,_contentInfo,_relatedMessageId,_type,_status,_rev,_chatId) VALUES(?,'',?,?,?,?,NULL,NULL,NULL,0,0,1,?)");
    try {
      Bind(statement, 1, id); Bind(statement, 2, toType); Bind(statement, 3, createdTime); Bind(statement, 4, text); Bind(statement, 5, 0L); Bind(statement, 6, chatId);
      if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED");
    } finally { finalize(statement); }
  }
  void InsertFixtureLongCommunityCatalog() {
    RunStatement("INSERT INTO _chat(_id,_midType,_name) VALUES('fixture-long-community',4,NULL)");
    IntPtr statement = PrepareStatement("INSERT INTO _squareChat(_squareChatMid,_squareMid,_name) VALUES('fixture-long-community','fixture-square',?)");
    try { Bind(statement, 1, new string('L', 300)); if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED"); }
    finally { finalize(statement); }
  }
  void InsertFixtureTypedChatMessage(string id, long createdTime, string chatId, object toType, long contentType) {
    IntPtr statement = PrepareStatement("INSERT INTO _message(_id,_from,_toType,_createdTime,_text,_contentType,_contentMetadata,_contentInfo,_relatedMessageId,_type,_status,_rev,_chatId) VALUES(?,'fixture-sender',?,?,?, ?,NULL,NULL,NULL,0,0,1,?)");
    try {
      Bind(statement, 1, id); Bind(statement, 2, toType); Bind(statement, 3, createdTime); Bind(statement, 4, "synthetic " + id);
      Bind(statement, 5, contentType); Bind(statement, 6, chatId);
      if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED");
    } finally { finalize(statement); }
  }
  internal void InsertFixtureGrowthMessage() { InsertFixtureMessage("m-11", 1000, "growth"); }
  internal void InsertFixtureNewerMessage() { InsertFixtureMessage("round-late", 1200, "after-round-bound"); }
  internal void DeleteFixtureMessage(string id) {
    if (String.IsNullOrEmpty(id) || id.Length > 100) throw new InvalidOperationException("FIXTURE_ID_INVALID");
    IntPtr statement = PrepareStatement("DELETE FROM _message WHERE _id = ?");
    try { Bind(statement, 1, id); if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED"); }
    finally { finalize(statement); }
  }
  internal void InsertFixtureGrowthMessages(int count) {
    for (int index = 1; index <= count; index++) InsertFixtureMessage("live-" + index.ToString("D3"), 1000 + index, "growth-" + index.ToString("D3"));
  }
  internal void ClearFixtureMessages() { RunStatement("DELETE FROM _message"); }
  internal void InsertFixtureHighTimestampMessage() { InsertFixtureMessage("m-big", 9007199254740993L, "int64"); }
  internal void AddFixtureDuplicateGroupMembership() { RunStatement("INSERT INTO _groupChat(_chatMid) VALUES('fixture-group')"); }
  internal void AddFixtureUnknownGroupMembership() { RunStatement("INSERT INTO _groupChat(_chatMid) VALUES('fixture-unknown')"); }
  internal void InsertFixtureDuplicateMessageId() { InsertFixtureChatMessage("m-01", 1000, "fixture-group"); }
  internal void InsertFixtureChatMessage(string id, long createdTime, string chatId) {
    if (chatId != "fixture-group" && chatId != "fixture-unknown") throw new InvalidOperationException("FIXTURE_CHAT_INVALID");
    IntPtr statement = PrepareStatement("INSERT INTO _message(_id,_from,_createdTime,_text,_contentType,_contentMetadata,_contentInfo,_relatedMessageId,_type,_status,_rev,_chatId) VALUES(?,'fixture-sender',?, 'chat row',NULL,NULL,NULL,NULL,0,0,1,?)");
    try { Bind(statement, 1, id); Bind(statement, 2, createdTime); Bind(statement, 3, chatId); if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED"); }
    finally { finalize(statement); }
  }
  void InsertFixtureMessage(string id, long createdTime, string text) {
    IntPtr statement = PrepareStatement("INSERT INTO _message(_id,_from,_createdTime,_text,_contentType,_contentMetadata,_contentInfo,_relatedMessageId,_type,_status,_rev,_chatId) VALUES(?,?,?,?,NULL,NULL,NULL,NULL,0,0,1,?)");
    try {
      Bind(statement, 1, id); Bind(statement, 2, "fixture-sender"); Bind(statement, 3, createdTime); Bind(statement, 4, text); Bind(statement, 5, "fixture-chat");
      if (step(statement) != Done) throw new InvalidOperationException("FIXTURE_WRITE_FAILED");
    } finally { finalize(statement); }
  }
  internal string[] ReadFixtureMessageOrder(int limitRows) {
    bool hasMore;
    return ReadFixtureMessagePage(1, limitRows, out hasMore);
  }
  internal string[] ReadFixtureMessagePage(int pageNumber, int limitRows, out bool hasMore) {
    if (limitRows < 1 || limitRows > 100) throw new InvalidOperationException("FIXTURE_LIMIT_INVALID");
    if (pageNumber < 1 || pageNumber > 500) throw new InvalidOperationException("FIXTURE_PAGE_INVALID");
    lastStage = "authorizer";
    SetReadAuthorizer(new Dictionary<string, string[]> { { "_message", new string[] { "_id", "_createdTime", "_text", "_contentType", "_chatId" } } });
    try {
      long offset = (long)(pageNumber - 1) * limitRows;
      List<object[]> rows = QueryLimited("SELECT _id, _createdTime, _text, _contentType, _chatId FROM _message WHERE _chatId = ? ORDER BY _createdTime DESC, _id DESC LIMIT ? OFFSET ?",
        128 * 1024, "fixture-chat", (long)(limitRows + 1), offset);
      hasMore = rows.Count > limitRows;
      int resultCount = Math.Min(rows.Count, limitRows);
      string[] result = new string[resultCount];
      for (int i = 0; i < resultCount; i++) {
        if (rows[i].Length != 5 || !(rows[i][0] is string) || !(rows[i][1] is long) || !(rows[i][2] is string) || rows[i][3] != null || (string)rows[i][4] != "fixture-chat") throw new InvalidOperationException("FIXTURE_ROW_INVALID");
        result[i] = (string)rows[i][0] + "|" + ((long)rows[i][1]).ToString() + "|" + (string)rows[i][2];
      }
      return result;
    } finally { ClearAuthorizer(); }
  }
  internal static string DigestFixturePage(int pageNumber, string[] rows) {
    using (MemoryStream payload = new MemoryStream())
    using (SHA256 hash = SHA256.Create()) {
      WriteInt32LittleEndian(payload, pageNumber);
      WriteInt32LittleEndian(payload, rows.Length);
      foreach (string row in rows) {
        byte[] bytes = Encoding.UTF8.GetBytes(row);
        WriteInt32LittleEndian(payload, bytes.Length);
        payload.Write(bytes, 0, bytes.Length);
        Array.Clear(bytes, 0, bytes.Length);
      }
      byte[] encoded = payload.ToArray();
      byte[] digest = hash.ComputeHash(encoded);
      Array.Clear(encoded, 0, encoded.Length);
      Array.Clear(payload.GetBuffer(), 0, (int)payload.Length);
      StringBuilder value = new StringBuilder();
      foreach (byte item in digest) value.Append(item.ToString("x2"));
      Array.Clear(digest, 0, digest.Length);
      return value.ToString();
    }
  }
  static void WriteInt32LittleEndian(Stream stream, int value) {
    stream.WriteByte((byte)value);
    stream.WriteByte((byte)(value >> 8));
    stream.WriteByte((byte)(value >> 16));
    stream.WriteByte((byte)(value >> 24));
  }
  internal void VerifyFixtureReadPolicy() {
    RunPragma("BEGIN");
    SetReadAuthorizer(new Dictionary<string, string[]> { { "fixture", new string[] { "id", "value" } } });
    List<object[]> rows = Query("SELECT value FROM fixture WHERE id = ? LIMIT 1", 1L);
    if (rows.Count != 1 || !((string)rows[0][0] == "fixture-row" || (string)rows[0][0] == "wal-only-value")) throw new InvalidOperationException("FIXTURE_READ_FAILED");
    try { RunStatement("DELETE FROM fixture WHERE id = 1"); throw new InvalidOperationException("READ_POLICY_FAILED_OPEN"); }
    catch (InvalidOperationException error) { if (error.Message == "READ_POLICY_FAILED_OPEN") throw; }
  }
#endif

  static void VerifyDll(string path) {
    FileInfo info = new FileInfo(path);
    if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 || info.Length != 2442576) throw new InvalidOperationException("ENGINE_DLL_UNAVAILABLE");
    using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
    using (SHA256 hash = SHA256.Create()) {
      byte[] digest = hash.ComputeHash(stream);
      StringBuilder text = new StringBuilder();
      foreach (byte value in digest) text.Append(value.ToString("x2"));
      if (text.ToString() != DllSha256) throw new InvalidOperationException("ENGINE_INTEGRITY_FAILED");
    }
  }

  static IntPtr AcquireModule() {
    string dllPath = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "sqlite3mc_x64.dll"));
    lock (EngineGate) {
      if (sharedModule != IntPtr.Zero) {
        if (!String.Equals(sharedModulePath, dllPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("ENGINE_INTEGRITY_FAILED");
        return sharedModule;
      }
      VerifyDll(dllPath);
      sharedModule = LoadLibraryEx(dllPath, IntPtr.Zero, 0x00000100);
      if (sharedModule == IntPtr.Zero) throw new InvalidOperationException("ENGINE_DLL_UNAVAILABLE");
      sharedModulePath = dllPath;
      return sharedModule;
    }
  }

  void ConfigureKey(byte[] passphrase) {
    if (passphrase == null || passphrase.Length < 1 || passphrase.Length > 1024) throw new InvalidOperationException("SESSION_KEY_UNAVAILABLE");
    lastStage = "cipher";
    int cipher = cipherIndex(Utf8Z("aes128cbc"));
    if (cipher <= 0 || mcConfig(db, Utf8Z("cipher"), cipher) != cipher) throw new InvalidOperationException("ENGINE_CIPHER_UNAVAILABLE");
      mcConfig(db, Utf8Z("mc_legacy_wal"), 0);
      mcConfigCipher(db, Utf8Z("aes128cbc"), Utf8Z("legacy"), 0);
    lastStage = "key";
    byte[] ownedKey = (byte[])passphrase.Clone();
    try { Check(key(db, ownedKey, ownedKey.Length)); }
    finally { Array.Clear(ownedKey, 0, ownedKey.Length); }
  }

  void RunPragma(string sql) { RunStatement(sql); }

  void RunStatement(string sql) {
    lastStage = sql.StartsWith("PRAGMA", StringComparison.Ordinal) ? "pragma" : "statement_prepare";
    IntPtr statement = PrepareStatement(sql);
    try {
      int state;
      do { lastStage = "statement_step"; state = step(statement); if (state != Row && state != Done) CaptureFailure(state); } while (state == Row);
      if (state != Done) throw Failure("DATABASE_READ_FAILED");
    } finally { finalize(statement); }
  }

  List<object[]> Query(string sql, params object[] values) {
    return QueryLimited(sql, MaxResultBytes, values);
  }

  List<object[]> QueryLimited(string sql, int maximumResultBytes, params object[] values) {
    lastStage = "prepare";
    IntPtr statement = PrepareStatement(sql);
    try {
      for (int i = 0; i < values.Length; i++) { lastStage = "bind"; Bind(statement, i + 1, values[i]); }
      List<object[]> rows = new List<object[]>();
      int totalBytes = 0;
      while (true) {
        lastStage = "step";
        int state = step(statement);
        if (state == Done) break;
        if (state != Row) {
          if (scanProgressError != null) throw scanProgressError;
          throw Failure("DATABASE_READ_FAILED", state);
        }
        int count = columnCount(statement);
        object[] row = new object[count];
        for (int column = 0; column < count; column++) { lastStage = "column_decode"; row[column] = Column(statement, column, ref totalBytes, maximumResultBytes); }
        rows.Add(row);
        if (rows.Count > MaxRows) throw new InvalidOperationException("RESULT_TOO_LARGE");
      }
      FlushScanProgress();
      if (scanProgressError != null) throw scanProgressError;
      return rows;
    } finally { finalize(statement); }
  }

  List<NativeSourceRow> QueryNativeMessageRows(string sql, int maximumResultBytes, params object[] values) {
    lastStage = "prepare";
    IntPtr statement = PrepareStatement(sql);
    try {
      for (int i = 0; i < values.Length; i++) { lastStage = "bind"; Bind(statement, i + 1, values[i]); }
      List<NativeSourceRow> rows = new List<NativeSourceRow>();
      int totalBytes = 0;
      string[] columns = ReadColumnNames(statement, NativeMessageColumnNames);
      while (true) {
        lastStage = "step";
        int state = step(statement);
        if (state == Done) break;
        if (state != Row) {
          if (scanProgressError != null) throw scanProgressError;
          throw Failure("DATABASE_READ_FAILED", state);
        }
        lastStage = "column_decode";
        rows.Add(ReadNativeSourceRow(statement, "_message", columns, ref totalBytes, maximumResultBytes));
        if (rows.Count > MaxRows) throw new InvalidOperationException("RESULT_TOO_LARGE");
      }
      FlushScanProgress();
      if (scanProgressError != null) throw scanProgressError;
      return rows;
    } finally { finalize(statement); }
  }

  string[] ReadNativeMessagePrefix(string sql, int limitRows, object[] values, long frameBytes, out bool hasMore,
      out string lastCreatedTime, out string lastId) {
    hasMore = false; lastCreatedTime = null; lastId = null;
    lastStage = "prepare";
    IntPtr statement = PrepareStatement(sql);
    try {
      for (int i = 0; i < values.Length; i++) { lastStage = "bind"; Bind(statement, i + 1, values[i]); }
      List<string> rows = new List<string>(limitRows);
      Dictionary<string, NativeConversationInfo> pageCache = new Dictionary<string, NativeConversationInfo>(StringComparer.Ordinal);
      Dictionary<string, NativeSenderInfo> senderNameCache = new Dictionary<string, NativeSenderInfo>(StringComparer.Ordinal);
      long emittedBytes = 0;
      string[] columns = ReadColumnNames(statement, NativeMessageColumnNames);
      while (rows.Count < limitRows) {
        ThrowIfScanCancelled();
        lastStage = "step";
        int state = step(statement);
        if (state == Done) break;
        if (state != Row) {
          if (scanProgressError != null) throw scanProgressError;
          throw Failure("DATABASE_READ_FAILED", state);
        }
        int rowBytes = 0;
        NativeSourceRow row = ReadNativeSourceRow(statement, "_message", columns, ref rowBytes, MaxResultBytes);
        string candidateTime, candidateId, json;
        try { json = SerializeNativeMessageRow(row, pageCache, senderNameCache, out candidateTime, out candidateId); }
        catch { row.Clear(); throw; }
        long candidateBytes = checked(emittedBytes + Encoding.UTF8.GetByteCount(json));
        if (!FitsNativeMessagePageBudget(candidateBytes, rows.Count + 1, frameBytes)) {
          if (rows.Count == 0) throw new InvalidOperationException("SOURCE_ROW_TOO_LARGE");
          hasMore = true;
          break;
        }
        rows.Add(json); emittedBytes = candidateBytes;
        lastCreatedTime = candidateTime; lastId = candidateId;
      }
      if (!hasMore && rows.Count == limitRows) {
        ThrowIfScanCancelled();
        lastStage = "lookahead";
        int state = step(statement);
        if (state == Row) hasMore = true;
        else if (state != Done) {
          if (scanProgressError != null) throw scanProgressError;
          throw Failure("DATABASE_READ_FAILED", state);
        }
      }
      FlushScanProgress();
      if (scanProgressError != null) throw scanProgressError;
      return rows.ToArray();
    } finally { finalize(statement); }
  }

  string[] ReadNativeMessageTailRows(string sql, int limitRows, params object[] values) {
    if (limitRows < 1 || limitRows > MaxTailSourceRows) throw new InvalidOperationException("SOURCE_TAIL_INVALID");
    lastStage = "prepare";
    IntPtr statement = PrepareStatement(sql);
    try {
      for (int i = 0; i < values.Length; i++) { lastStage = "bind"; Bind(statement, i + 1, values[i]); }
      List<string> newestFirst = new List<string>(limitRows);
      Dictionary<string, NativeConversationInfo> pageCache = new Dictionary<string, NativeConversationInfo>(StringComparer.Ordinal);
      Dictionary<string, NativeSenderInfo> senderNameCache = new Dictionary<string, NativeSenderInfo>(StringComparer.Ordinal);
      string[] columns = ReadColumnNames(statement, NativeMessageColumnNames);
      while (newestFirst.Count < limitRows) {
        ThrowIfScanCancelled();
        lastStage = "step";
        int state = step(statement);
        if (state == Done) break;
        if (state != Row) {
          if (scanProgressError != null) throw scanProgressError;
          throw Failure("DATABASE_READ_FAILED", state);
        }
        int rowBytes = 0;
        NativeSourceRow row = ReadNativeSourceRow(statement, "_message", columns, ref rowBytes, MaxResultBytes);
        string ignoredTime, ignoredId, json;
        try { json = SerializeNativeMessageRow(row, pageCache, senderNameCache, out ignoredTime, out ignoredId); }
        catch { row.Clear(); throw; }
        if (!FitsNativeMessagePageBudget(Encoding.UTF8.GetByteCount(json), 1, MonitorMessageFrameBytes))
          throw new InvalidOperationException("SOURCE_ROW_TOO_LARGE");
        newestFirst.Add(json);
      }
      FlushScanProgress();
      if (scanProgressError != null) throw scanProgressError;
      newestFirst.Reverse();
      return newestFirst.ToArray();
    } finally { finalize(statement); }
  }

  internal static bool FitsNativeMessagePageBudget(long emittedJsonBytes, int rowCount, long frameBytes = MonitorMessageFrameBytes) {
    return 3L * emittedJsonBytes + 128L * rowCount + 65536L <= frameBytes;
  }

  string[] ReadColumnNames(IntPtr statement, string[] expectedNames) {
    int count = columnCount(statement);
    if (count != expectedNames.Length) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
    string[] columns = new string[count];
    HashSet<string> expected = new HashSet<string>(expectedNames, StringComparer.Ordinal);
    for (int i = 0; i < count; i++) {
      IntPtr pointer = columnName(statement, i);
      if (pointer == IntPtr.Zero) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
      string name = Marshal.PtrToStringAnsi(pointer);
      if (name == null || !expected.Remove(name)) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
      columns[i] = name;
    }
    if (expected.Count != 0) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
    return columns;
  }

  NativeSourceRow ReadNativeSourceRow(IntPtr statement, string table, string[] columns, ref int totalBytes, int maximumResultBytes) {
    return ReadNativeSourceRow(statement, table, columns, 0, ref totalBytes, maximumResultBytes);
  }

  NativeSourceRow ReadNativeSourceRow(IntPtr statement, string table, string[] columns, int firstColumn, ref int totalBytes, int maximumResultBytes) {
    NativeSourceCell[] cells = new NativeSourceCell[columns.Length];
    int rowBytes = 0;
    try {
      for (int column = 0; column < cells.Length; column++) {
        int sourceColumn = checked(firstColumn + column);
        int type = columnType(statement, sourceColumn);
        long integer = type == 1 ? columnInt64(statement, sourceColumn) : 0;
        double real = type == 2 ? columnDouble(statement, sourceColumn) : 0;
        byte[] bytes = new byte[0];
        if (type == 3 || type == 4) {
          int length = columnBytes(statement, sourceColumn);
          if (length < 0 || length > MaxCellBytes) throw new InvalidOperationException("RESULT_TOO_LARGE");
          rowBytes = checked(rowBytes + length);
          if (rowBytes > maximumResultBytes || totalBytes > maximumResultBytes - rowBytes) throw new InvalidOperationException("RESULT_TOO_LARGE");
          IntPtr pointer = type == 3 ? columnText(statement, sourceColumn) : columnBlob(statement, sourceColumn);
          if (length > 0 && pointer == IntPtr.Zero) throw new InvalidOperationException("SOURCE_ROW_INVALID");
          bytes = new byte[length];
          if (length > 0) Marshal.Copy(pointer, bytes, 0, length);
        } else if (type != 1 && type != 2 && type != 5) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
        cells[column] = new NativeSourceCell(type, integer, real, bytes);
      }
      totalBytes = checked(totalBytes + rowBytes);
      return new NativeSourceRow(table, columns, cells);
    } catch {
      for (int i = 0; i < cells.Length; i++) if (cells[i] != null) cells[i].Clear();
      throw;
    }
  }

  object OptionalMetadataColumn(IntPtr statement, int index) {
    if (columnType(statement, index) != 3) return null;
    int length = columnBytes(statement, index);
    if (length < 0 || length > 16 * 1024) return null;
    IntPtr pointer = columnText(statement, index);
    if (length > 0 && pointer == IntPtr.Zero) return null;
    byte[] bytes = new byte[length];
    if (length > 0) Marshal.Copy(pointer, bytes, 0, length);
    try { return StrictUtf8.GetString(bytes); }
    catch { return null; }
    finally { Array.Clear(bytes, 0, bytes.Length); }
  }

  IntPtr PrepareStatement(string sql) {
    lastStage = "prepare";
    byte[] bytes = Utf8Z(sql);
    IntPtr statement, tail;
    int result = prepare(db, bytes, bytes.Length - 1, out statement, out tail);
    Array.Clear(bytes, 0, bytes.Length);
    Check(result);
    if (statement == IntPtr.Zero) throw new InvalidOperationException("DATABASE_READ_FAILED");
    return statement;
  }

  void Bind(IntPtr statement, int index, object value) {
    if (value == null) Check(bindNull(statement, index));
    else if (value is long) Check(bindInt64(statement, index, (long)value));
    else if (value is int) Check(bindInt64(statement, index, (int)value));
    else if (value is string) {
      byte[] text = Encoding.UTF8.GetBytes((string)value);
      Check(bindText(statement, index, text, text.Length, new IntPtr(-1)));
      Array.Clear(text, 0, text.Length);
    } else throw new InvalidOperationException("INVALID_BIND_VALUE");
  }

  object Column(IntPtr statement, int index, ref int totalBytes, int maximumResultBytes) {
    int type = columnType(statement, index);
    if (type == 1) return columnInt64(statement, index);
    if (type == 2) return columnDouble(statement, index);
    if (type == 5) return null;
    if (type != 3 && type != 4) throw new InvalidOperationException("DATABASE_READ_FAILED");
    int length = columnBytes(statement, index);
    if (length < 0 || length > MaxCellBytes || (totalBytes += length) > maximumResultBytes) throw new InvalidOperationException("RESULT_TOO_LARGE");
    IntPtr pointer = type == 3 ? columnText(statement, index) : columnBlob(statement, index);
    if (length > 0 && pointer == IntPtr.Zero) throw new InvalidOperationException("DATABASE_READ_FAILED");
    byte[] bytes = new byte[length];
    if (length > 0) Marshal.Copy(pointer, bytes, 0, length);
    if (type == 4) return bytes;
    try { return StrictUtf8.GetString(bytes); }
    catch { throw new InvalidOperationException("DATABASE_READ_FAILED"); }
    finally { Array.Clear(bytes, 0, bytes.Length); }
  }

  void SetReadAuthorizer(Dictionary<string, string[]> tables) {
    readAuthorizerTables = tables;
    if (readAuthorizer == null) readAuthorizer = delegate(IntPtr user, int action, IntPtr arg1, IntPtr arg2, IntPtr database, IntPtr trigger) {
      if (trigger != IntPtr.Zero) return AuthorizerDeny;
      if (action == 19) return allowCatalogPragma && (Text(database) == "" || Text(database) == "main") && Text(arg1) == "table_info" &&
        String.Equals(Text(arg2), catalogPragmaTable, StringComparison.Ordinal) ? 0 : AuthorizerDeny;
      if (action == AuthorizerSelect) return 0;
      if (action == AuthorizerFunction && (Text(arg2) == "instr" || Text(arg2) == "count" || Text(arg2) == "sum" || Text(arg2) == "typeof" || Text(arg2) == "substr" || Text(arg2) == "coalesce" || Text(arg2) == "case")) return 0;
      if (action == AuthorizerRead && Text(database) == "main") {
        string[] columns;
        Dictionary<string, string[]> allowed = readAuthorizerTables;
        string column = Text(arg2);
        return allowed != null && allowed.TryGetValue(Text(arg1), out columns) &&
          (Array.IndexOf(columns, column) >= 0 || (column != null && (String.Equals(column, "rowid", StringComparison.OrdinalIgnoreCase) || String.Equals(column, "_rowid_", StringComparison.OrdinalIgnoreCase)))) ? 0 : AuthorizerDeny;
      }
      return AuthorizerDeny;
    };
    if (authorizer != readAuthorizer) {
      authorizer = readAuthorizer;
      Check(setAuthorizer(db, authorizer, IntPtr.Zero));
    }
  }

  void SetSchemaAuthorizer() {
    authorizer = delegate(IntPtr user, int action, IntPtr arg1, IntPtr arg2, IntPtr database, IntPtr trigger) {
      if (trigger != IntPtr.Zero) return AuthorizerDeny;
      if (action == AuthorizerSelect) return 0;
      if (action == AuthorizerRead && Text(database) == "main" &&
          (Text(arg1) == "sqlite_master" || Text(arg1) == "sqlite_schema") &&
          (Text(arg2) == "name" || Text(arg2) == "type")) return 0;
      return AuthorizerDeny;
    };
    Check(setAuthorizer(db, authorizer, IntPtr.Zero));
  }

  void SetProfileAuthorizer() {
    authorizer = delegate(IntPtr user, int action, IntPtr arg1, IntPtr arg2, IntPtr database, IntPtr trigger) {
      if (trigger != IntPtr.Zero) return AuthorizerDeny;
      if (action == AuthorizerSelect) return 0;
      if (action == AuthorizerRead && Text(database) == "main" && Text(arg1) == "_profile" && Text(arg2) == "_mid") return 0;
      return AuthorizerDeny;
    };
    Check(setAuthorizer(db, authorizer, IntPtr.Zero));
  }

  void ClearAuthorizer() {
    if (windowReadAuthorizerActive && authorizer == readAuthorizer) {
      readAuthorizerTables = null;
      return;
    }
    Check(setAuthorizer(db, null, IntPtr.Zero));
    authorizer = null;
    readAuthorizerTables = null;
  }

  static string Text(IntPtr pointer) { return pointer == IntPtr.Zero ? "" : Marshal.PtrToStringAnsi(pointer); }
  static byte[] Utf8Z(string value) { byte[] bytes = Encoding.UTF8.GetBytes(value); Array.Resize(ref bytes, bytes.Length + 1); return bytes; }
  void Check(int result) { if (result != 0) throw Failure("DATABASE_READ_FAILED", result); }

  InvalidOperationException Failure(string fallback, int code = 0) {
    if (code == 0) code = db == IntPtr.Zero ? 0 : extendedErrorCode(db);
    CaptureFailure(code);
    return diagnosticMode ? new SqliteDiagnosticException(Summary()) : new InvalidOperationException(fallback);
  }

  string Summary() {
    string sqlite = sqliteVersion == null ? "unknown" : Text(sqliteVersion());
    string cipher = cipherVersion == null ? "unknown" : Text(cipherVersion());
    return lastStage + "|" + lastPrimaryCode.ToString() + "|" + lastExtendedCode.ToString() + "|sqlite=" + sqlite + "|cipher=" + cipher + "|readonly=1|open_flags=1|key_order=open,cipher,wal_settings,key";
  }

  void CaptureFailure(int code) {
    lastExtendedCode = db == IntPtr.Zero || extendedErrorCode == null ? code : extendedErrorCode(db);
    lastPrimaryCode = lastExtendedCode & 0xff;
  }

  T Load<T>(string name) where T : class {
    IntPtr address = GetProcAddress(module, name);
    if (address == IntPtr.Zero) throw new InvalidOperationException("ENGINE_DLL_UNAVAILABLE");
    return Marshal.GetDelegateForFunctionPointer(address, typeof(T)) as T;
  }

  public void Dispose() {
    if (catalogPager != null) { catalogPager.Dispose(); catalogPager = null; }
    if (db != IntPtr.Zero) { if (progressHandler != null) progressHandler(db, 0, null, IntPtr.Zero); if (closeV2 != null) closeV2(db); db = IntPtr.Zero; }
  }
}

internal sealed class SqliteDiagnosticException : InvalidOperationException {
  internal readonly string Summary;
  internal SqliteDiagnosticException(string summary) : base("SQLITE_FAILURE") { Summary = summary; }
}

internal sealed class NativeConversationInfo {
  internal string ChatType;
  internal string NativeKind;
  internal string Title;
  internal string PicturePath;
  internal long? MidType;
  internal string ParentChatId;
  internal string CommunityId;
  internal bool ReadonlyForSending;
}

internal sealed class NativeSenderInfo { internal string Name; internal string PicturePath; }
