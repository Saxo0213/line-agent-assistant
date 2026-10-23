using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Bounded read-only performance probe for the retained fixed encrypted copy.
// It emits schema, query-plan and timing aggregates only.
internal static class NativePerformanceProbeHarness {
  const int VmStepStatus = 4;
  const int SortStatus = 2;
  const int ReprepareStatus = 5;
  static readonly Dictionary<string, long> PreparedByFamily = new Dictionary<string, long>(StringComparer.Ordinal);
  static Delegate originalPrepare, originalFinalize, originalStep;
  static Delegate originalColumnBytes;
  static Delegate sqliteStmtStatus;
  static long prepareCalls, vmSteps, stepCalls, finalizedMessageSorts, finalizedMessageReprepares, totalMessageColumnBytes;
  static readonly HashSet<IntPtr> messageStatements = new HashSet<IntPtr>();
  static long currentMessageBytes, maxMessageBytes;

  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int StmtStatus(IntPtr statement, int operation, int reset);
  delegate int ColumnBytes(IntPtr statement, int index);
  [DllImport("kernel32.dll", CharSet=CharSet.Ansi, SetLastError=true)] static extern IntPtr GetProcAddress(IntPtr module, string name);

  static int Main() {
    byte[] key = null;
    string stage = "input";
    try {
      string copy = Environment.GetEnvironmentVariable("NATIVE_AUDIT_COPY");
      ValidateCopy(copy);
      stage = "inventory";
      string lineRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LINE");
      OfficialSourceInventoryResult source = OfficialSourceInventory.Inspect(lineRoot,
        OfficialSourceInventory.SupportedBuildVersion, OfficialSourceInventory.SupportedBuildBytes,
        OfficialSourceInventory.SupportedBuildSha256, new WindowsOfficialSourceInventoryEnvironment());
      key = OfficialSourceKeyProbe.Find(source, new WindowsOfficialSourceInventoryEnvironment(),
        DateTime.UtcNow.AddMinutes(3), CancellationToken.None, null);
      source = null; // The probe has closed its source handles before offline copy analysis begins.

      stage = "copy_open";
      using (Sqlite3Mc reader = (Sqlite3Mc)Activator.CreateInstance(typeof(Sqlite3Mc),
        BindingFlags.Instance | BindingFlags.NonPublic, null,
        new object[] { Path.Combine(copy, "snapshot.edb"), key, true, false, true }, CultureInfo.InvariantCulture)) {
        stage = "schema";
        reader.VerifySchemaReadable();
        MethodInfo setAuth = typeof(Sqlite3Mc).GetMethod("SetReadAuthorizer", BindingFlags.Instance | BindingFlags.NonPublic);
        MethodInfo clearAuth = typeof(Sqlite3Mc).GetMethod("ClearAuthorizer", BindingFlags.Instance | BindingFlags.NonPublic);
        MethodInfo query = typeof(Sqlite3Mc).GetMethod("QueryLimited", BindingFlags.Instance | BindingFlags.NonPublic);
        if (setAuth == null || clearAuth == null || query == null) throw new MissingMethodException("probe_sqlite_api_unavailable");
        setAuth.Invoke(reader, new object[] { new Dictionary<string, string[]> {
          { "_message", new string[] { "_id", "_from", "_toType", "_createdTime", "_chatId", "_text", "_contentType" } },
          { "sqlite_master", new string[] { "type", "name", "tbl_name", "sql" } }
        } });
        try {
          List<object[]> indexes = InvokeQuery(query, reader,
            "SELECT type,name,sql FROM sqlite_master WHERE tbl_name='_message' AND type='index' ORDER BY name", 16 * 1024);
          Console.WriteLine("INDEX_COUNT|count=" + indexes.Count.ToString(CultureInfo.InvariantCulture));
          foreach (object[] index in indexes) {
            string name = index.Length > 1 && index[1] is string ? (string)index[1] : "unavailable";
            string definition = index.Length > 2 && index[2] is string ? (string)index[2] : "unavailable";
            Console.WriteLine("INDEX|name=" + SafeSchema(name) + "|definition=" + SafeSchema(definition));
          }
        } finally { clearAuth.Invoke(reader, null); }

        stage = "query_plan";
        PrintPlan(reader, setAuth, clearAuth, query, "initial",
          "SELECT _id,_from,_toType,_createdTime,_chatId,_text,_contentType FROM _message WHERE _createdTime IS NOT NULL AND _id IS NOT NULL ORDER BY _createdTime ASC,_id COLLATE BINARY ASC LIMIT ?",
          new object[] { 101L });
        PrintPlan(reader, setAuth, clearAuth, query, "keyset",
          "SELECT _id,_from,_toType,_createdTime,_chatId,_text,_contentType FROM _message WHERE _createdTime IS NOT NULL AND _id IS NOT NULL AND (_createdTime > ? OR (_createdTime = ? AND _id COLLATE BINARY > ?)) ORDER BY _createdTime ASC,_id COLLATE BINARY ASC LIMIT ?",
          new object[] { 1790000000000L, 1790000000000L, "probe", 101L });

        InstallCounters(reader);
        stage = "initial_import_prefetch_comparison";
        RunPrefetchComparison(reader);

      }
      return 0;
    } catch (Exception error) {
      Exception root = Unwrap(error);
      SqliteDiagnosticException diagnostic = root as SqliteDiagnosticException;
      Console.WriteLine("PROBE|FAIL|stage=" + stage + "|type=" + root.GetType().Name + "|symbol=" + SafeSymbol(root) +
        "|diagnostic=" + (diagnostic == null ? "none" : SafeDiagnostic(diagnostic.Summary)));
      return 1;
    } finally { if (key != null) Array.Clear(key, 0, key.Length); }
  }

  static void ValidateCopy(string copy) {
    string full = Path.GetFullPath(copy ?? "");
    string root = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    if (String.IsNullOrEmpty(copy) || !full.StartsWith(root, StringComparison.OrdinalIgnoreCase) ||
        !Path.GetFileName(full).StartsWith("linejs-native-audit-", StringComparison.Ordinal) ||
        (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("probe_copy_invalid");
    FileInfo db = new FileInfo(Path.Combine(full, "snapshot.edb"));
    FileInfo owner = new FileInfo(Path.Combine(full, "snapshot.owner"));
    if (!db.Exists || !owner.Exists || db.Length != 3924303872L || owner.Length != 16L) throw new InvalidDataException("probe_copy_invalid");
  }

  static List<object[]> InvokeQuery(MethodInfo method, Sqlite3Mc reader, string sql, int maxBytes, params object[] values) {
    return (List<object[]>)method.Invoke(reader, new object[] { sql, maxBytes, values });
  }

  static void PrintPlan(Sqlite3Mc reader, MethodInfo setAuth, MethodInfo clearAuth, MethodInfo query,
      string label, string sql, object[] values) {
    setAuth.Invoke(reader, new object[] { new Dictionary<string, string[]> {
      { "_message", new string[] { "_id", "_from", "_toType", "_createdTime", "_chatId", "_text", "_contentType" } }
    } });
    try {
      List<object[]> plan = InvokeQuery(query, reader, "EXPLAIN QUERY PLAN " + sql, 16 * 1024, values);
      foreach (object[] row in plan) {
        string detail = row.Length > 3 && row[3] is string ? (string)row[3] : "unavailable";
        Console.WriteLine("PLAN|kind=" + label + "|detail=" + SafeSchema(detail));
      }
    } finally { clearAuth.Invoke(reader, null); }
  }

  static void InstallCounters(Sqlite3Mc reader) {
    const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
    Type type = typeof(Sqlite3Mc);
    FieldInfo prepareField = type.GetField("prepare", flags);
    FieldInfo finalizeField = type.GetField("finalize", flags);
    FieldInfo stepField = type.GetField("step", flags);
    FieldInfo columnBytesField = type.GetField("columnBytes", flags);
    FieldInfo moduleField = type.GetField("module", flags);
    if (prepareField == null || finalizeField == null || stepField == null || moduleField == null) return;
    originalPrepare = prepareField.GetValue(reader) as Delegate;
    originalFinalize = finalizeField.GetValue(reader) as Delegate;
    originalStep = stepField.GetValue(reader) as Delegate;
    originalColumnBytes = columnBytesField == null ? null : columnBytesField.GetValue(reader) as Delegate;
    IntPtr module = (IntPtr)moduleField.GetValue(reader);
    IntPtr status = GetProcAddress(module, "sqlite3_stmt_status");
    if (status != IntPtr.Zero) sqliteStmtStatus = Marshal.GetDelegateForFunctionPointer(status, typeof(StmtStatus));
    try {
      prepareField.SetValue(reader, Delegate.CreateDelegate(prepareField.FieldType,
        typeof(NativePerformanceProbeHarness).GetMethod("CountPrepare", BindingFlags.Static | BindingFlags.NonPublic)));
      stepField.SetValue(reader, Delegate.CreateDelegate(stepField.FieldType,
        typeof(NativePerformanceProbeHarness).GetMethod("CountStep", BindingFlags.Static | BindingFlags.NonPublic)));
      if (columnBytesField != null) columnBytesField.SetValue(reader, Delegate.CreateDelegate(columnBytesField.FieldType,
        typeof(NativePerformanceProbeHarness).GetMethod("CountColumnBytes", BindingFlags.Static | BindingFlags.NonPublic)));
      if (sqliteStmtStatus != null) finalizeField.SetValue(reader, Delegate.CreateDelegate(finalizeField.FieldType,
        typeof(NativePerformanceProbeHarness).GetMethod("CountFinalize", BindingFlags.Static | BindingFlags.NonPublic)));
    } catch { prepareCalls = -1; vmSteps = -1; stepCalls = -1; }
  }

  static int CountPrepare(IntPtr db, byte[] sql, int length, out IntPtr statement, out IntPtr tail) {
    Interlocked.Increment(ref prepareCalls);
    string family = "other";
    try {
      string text = Encoding.UTF8.GetString(sql, 0, Math.Max(0, Math.Min(length, sql.Length)));
      if (text.IndexOf("FROM _message", StringComparison.OrdinalIgnoreCase) >= 0) family = "message";
      else if (text.IndexOf("FROM _chat", StringComparison.OrdinalIgnoreCase) >= 0) family = "chat";
      else if (text.IndexOf("FROM _contact", StringComparison.OrdinalIgnoreCase) >= 0) family = "contact";
      else if (text.IndexOf("FROM _groupChat", StringComparison.OrdinalIgnoreCase) >= 0) family = "group";
      else if (text.IndexOf("FROM _squareChat", StringComparison.OrdinalIgnoreCase) >= 0) family = "square_chat";
      else if (text.IndexOf("FROM _squareThread", StringComparison.OrdinalIgnoreCase) >= 0) family = "square_thread";
      lock (PreparedByFamily) PreparedByFamily[family] = PreparedByFamily.ContainsKey(family) ? PreparedByFamily[family] + 1 : 1;
    } catch {}
    object[] args = new object[] { db, sql, length, IntPtr.Zero, IntPtr.Zero };
    int result = (int)originalPrepare.DynamicInvoke(args);
    statement = (IntPtr)args[3]; tail = (IntPtr)args[4];
    if (family == "message" && statement != IntPtr.Zero) {
      lock (messageStatements) { messageStatements.Add(statement); currentMessageBytes = 0; }
    }
    return result;
  }

  static int CountColumnBytes(IntPtr statement, int index) {
    int length = (int)originalColumnBytes.DynamicInvoke(statement, index);
    lock (messageStatements) if (messageStatements.Contains(statement) && length > 0) {
      currentMessageBytes += length; Interlocked.Add(ref totalMessageColumnBytes, length);
    }
    return length;
  }

  static int CountStep(IntPtr statement) {
    Interlocked.Increment(ref stepCalls);
    return (int)originalStep.DynamicInvoke(statement);
  }

  static int CountFinalize(IntPtr statement) {
    if (sqliteStmtStatus != null) {
      Interlocked.Add(ref vmSteps, (int)sqliteStmtStatus.DynamicInvoke(statement, VmStepStatus, 0));
      lock (messageStatements) {
        if (messageStatements.Contains(statement)) {
          Interlocked.Add(ref finalizedMessageSorts, (int)sqliteStmtStatus.DynamicInvoke(statement, SortStatus, 0));
          Interlocked.Add(ref finalizedMessageReprepares, (int)sqliteStmtStatus.DynamicInvoke(statement, ReprepareStatus, 0));
        }
      }
    }
    lock (messageStatements) {
      if (messageStatements.Remove(statement)) {
        maxMessageBytes = Math.Max(maxMessageBytes, currentMessageBytes);
        currentMessageBytes = 0;
      }
    }
    return (int)originalFinalize.DynamicInvoke(statement);
  }

  static void RunInitialImportWindowSample(Sqlite3Mc reader) {
    const BindingFlags flags = BindingFlags.Instance | BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
    MethodInfo open = typeof(Sqlite3Mc).GetMethod("OpenInitialImportWindow", flags);
    if (open == null) throw new MissingMethodException("probe_window_api_unavailable");
    ParameterInfo[] openParameters = open.GetParameters();
    object[] openArgs = openParameters.Length == 2
      ? new object[] { CancellationToken.None, 128L * 1024L * 1024L }
      : new object[] { CancellationToken.None };
    object owner = open.Invoke(open.IsStatic ? null : (object)reader, openArgs);
    if (owner == null) throw new InvalidDataException("probe_window_owner_missing");
    MethodInfo readPage = owner.GetType().GetMethod("ReadPage", flags);
    if (readPage == null) throw new MissingMethodException("probe_window_page_api_unavailable");
    Stopwatch total = Stopwatch.StartNew();
    Process process = Process.GetCurrentProcess();
    process.Refresh();
    long workingBefore = process.WorkingSet64, peakWorkingBefore = process.PeakWorkingSet64;
    long privateBefore = process.PrivateMemorySize64, peakPagedBefore = process.PeakPagedMemorySize64;
    long managedBefore = GC.GetTotalMemory(true);
    long rowsRead = 0, maxRawPage = 0, maxFrameBytes = 0;
    TimeSpan firstPage = TimeSpan.Zero, firstRefill = TimeSpan.Zero, secondRefill = TimeSpan.Zero;
    TimeSpan continuedAfterFirstRefill = TimeSpan.Zero;
    int pages = 0;
    string afterTime = null, afterId = null;
    try {
      while (rowsRead < 62000) {
        currentMessageBytes = 0; maxMessageBytes = 0;
        object[] pageArgs = new object[] { 2000, afterTime, afterId, false, null, null };
        Stopwatch pageClock = Stopwatch.StartNew();
        string[] rows = (string[])readPage.Invoke(owner, pageArgs);
        pageClock.Stop();
        if (rows == null || rows.Length == 0 || rows.Length > 2000) throw new InvalidDataException("probe_window_page_invalid");
        bool hasMore = (bool)pageArgs[3];
        string lastTime = pageArgs[4] as string, lastId = pageArgs[5] as string;
        if (lastTime == null || lastId == null) throw new InvalidDataException("probe_window_cursor_missing");
        long rawPageBytes = Math.Max(currentMessageBytes, maxMessageBytes);
        maxRawPage = Math.Max(maxRawPage, rawPageBytes);
        int frameBytes = CandidatePageFrameBytes(rows, pages + 1, lastTime, lastId, hasMore);
        maxFrameBytes = Math.Max(maxFrameBytes, frameBytes);
        pages++;
        rowsRead += rows.Length;
        if (pages == 1) firstPage = pageClock.Elapsed;
        else if (pages == 16) firstRefill = pageClock.Elapsed;
        else if (pages == 31) secondRefill = pageClock.Elapsed;
        else if (pages > 16 && pages < 31) continuedAfterFirstRefill += pageClock.Elapsed;
        afterTime = lastTime; afterId = lastId;
        if (!hasMore && rowsRead < 62000) throw new InvalidDataException("probe_window_ended_early");
      }
      total.Stop();
      process.Refresh();
      long workingAfter = process.WorkingSet64, peakWorkingAfter = process.PeakWorkingSet64;
      long privateAfter = process.PrivateMemorySize64, peakPagedAfter = process.PeakPagedMemorySize64;
      long managedAfter = GC.GetTotalMemory(true);
      Console.WriteLine("WINDOW_SAMPLE|rows=" + rowsRead.ToString(CultureInfo.InvariantCulture) +
        "|pages=" + pages.ToString(CultureInfo.InvariantCulture) +
        "|first_page_ms=" + Ms(firstPage) +
        "|refill1_page_ms=" + Ms(firstRefill) +
        "|after_refill1_pages_ms=" + Ms(continuedAfterFirstRefill) +
        "|refill2_page_ms=" + Ms(secondRefill) +
        "|total_ms=" + Ms(total.Elapsed) +
        "|max_raw_page_bytes=" + maxRawPage.ToString(CultureInfo.InvariantCulture) +
        "|max_candidate_page_body_bytes=" + maxFrameBytes.ToString(CultureInfo.InvariantCulture) +
        "|candidate_frame_limit_bytes=8388608" +
        "|message_select_prepares=" + CountFamily("message") +
        "|message_stmt_sorts=" + MessageStatementStatus(SortStatus) +
        "|message_stmt_reprepares=" + MessageStatementStatus(ReprepareStatus) +
        "|total_prepares=" + Interlocked.Read(ref prepareCalls).ToString(CultureInfo.InvariantCulture) +
        "|vm_steps=" + (sqliteStmtStatus == null ? "unavailable" : Interlocked.Read(ref vmSteps).ToString(CultureInfo.InvariantCulture)) +
        "|step_calls=" + Interlocked.Read(ref stepCalls).ToString(CultureInfo.InvariantCulture) +
        "|working_before_mib=" + MiB(workingBefore) + "|working_after_mib=" + MiB(workingAfter) +
        "|peak_working_before_mib=" + MiB(peakWorkingBefore) + "|peak_working_after_mib=" + MiB(peakWorkingAfter) +
        "|private_before_mib=" + MiB(privateBefore) + "|private_after_mib=" + MiB(privateAfter) +
        "|peak_paged_before_mib=" + MiB(peakPagedBefore) + "|peak_paged_after_mib=" + MiB(peakPagedAfter) +
        "|managed_before_mib=" + MiB(managedBefore) + "|managed_after_mib=" + MiB(managedAfter) +
        "|query_family_counts=" + FamilySummary());
    } finally {
      IDisposable disposable = owner as IDisposable;
      if (disposable != null) disposable.Dispose();
    }
  }

  const int SyntheticRows = 62000;
  const int SyntheticPageRows = 2000;
  const int SyntheticConsumerDelayMs = 250;

  static void RunPrefetchComparison(Sqlite3Mc reader) {
    RunPrefetchSyntheticSample(reader);
  }

  static void ResetCounters() {
    lock (PreparedByFamily) PreparedByFamily.Clear();
    lock (messageStatements) messageStatements.Clear();
    Interlocked.Exchange(ref prepareCalls, 0); Interlocked.Exchange(ref vmSteps, 0); Interlocked.Exchange(ref stepCalls, 0);
    Interlocked.Exchange(ref finalizedMessageSorts, 0); Interlocked.Exchange(ref finalizedMessageReprepares, 0);
    Interlocked.Exchange(ref totalMessageColumnBytes, 0);
    currentMessageBytes = 0; maxMessageBytes = 0;
  }

  static void RunSequentialSyntheticSample(Sqlite3Mc reader) {
    ResetCounters();
    Process process = Process.GetCurrentProcess(); process.Refresh();
    long workingBefore = process.WorkingSet64, privateBefore = process.PrivateMemorySize64;
    long managedBefore = GC.GetTotalMemory(true);
    long heapLimitBefore = CurrentHeapLimit(reader);
    long rowsRead = 0, maxFrameBytes = 0, consumerDelay = 0;
    TimeSpan firstPage = TimeSpan.Zero, refill1 = TimeSpan.Zero, refill2 = TimeSpan.Zero, middlePages = TimeSpan.Zero;
    int pages = 0; string afterTime = null, afterId = null; long priorTime = Int64.MinValue; string priorId = null;
    Stopwatch total = Stopwatch.StartNew();
    Sqlite3Mc.InitialImportWindow window = reader.OpenInitialImportWindow(CancellationToken.None, 128L * 1024L * 1024L);
    try {
      while (rowsRead < SyntheticRows) {
        currentMessageBytes = 0; maxMessageBytes = 0;
        Stopwatch pageClock = Stopwatch.StartNew();
        bool hasMore;
        Sqlite3Mc.InitialImportBufferedRow[] rows = window.ReadBufferedPage(SyntheticPageRows, afterTime, afterId, out hasMore);
        if (rows == null || rows.Length == 0 || rows.Length > SyntheticPageRows) throw new InvalidDataException("probe_sequential_page_invalid");
        VerifyBufferedOrder(rows, ref priorTime, ref priorId);
        int frameBytes = BufferedPageFrameBytes(rows, pages + 1, hasMore);
        maxFrameBytes = Math.Max(maxFrameBytes, frameBytes);
        afterTime = rows[rows.Length - 1].CreatedTime; afterId = rows[rows.Length - 1].Id;
        rowsRead += rows.Length; pages++; pageClock.Stop();
        if (pages == 1) firstPage = pageClock.Elapsed;
        else if (pages == 16) refill1 = pageClock.Elapsed;
        else if (pages == 31) refill2 = pageClock.Elapsed;
        else if (pages > 16 && pages < 31) middlePages += pageClock.Elapsed;
        if (!hasMore && rowsRead < SyntheticRows) throw new InvalidDataException("probe_sequential_ended_early");
        Thread.Sleep(SyntheticConsumerDelayMs); consumerDelay += SyntheticConsumerDelayMs;
      }
    } finally { window.Dispose(); total.Stop(); }
    process.Refresh();
    Console.WriteLine("SYNTHETIC_SAMPLE|mode=sequential|rows=" + rowsRead.ToString(CultureInfo.InvariantCulture) +
      "|pages=" + pages.ToString(CultureInfo.InvariantCulture) + "|delay_ms_per_page=" + SyntheticConsumerDelayMs.ToString(CultureInfo.InvariantCulture) +
      "|consumer_delay_ms=" + consumerDelay.ToString(CultureInfo.InvariantCulture) + "|first_page_ms=" + Ms(firstPage) +
      "|refill1_page_ms=" + Ms(refill1) + "|pages17_30_ms=" + Ms(middlePages) + "|refill2_page_ms=" + Ms(refill2) +
      "|total_ms=" + Ms(total.Elapsed) + "|source_message_column_bytes=" + Interlocked.Read(ref totalMessageColumnBytes).ToString(CultureInfo.InvariantCulture) +
      "|max_actual_emit_body_bytes=" + maxFrameBytes.ToString(CultureInfo.InvariantCulture) +
      "|message_select_prepares=" + CountFamily("message") + "|message_stmt_sorts=" + MessageStatementStatus(SortStatus) +
      "|message_stmt_reprepares=" + MessageStatementStatus(ReprepareStatus) + "|all_prepares=" + Interlocked.Read(ref prepareCalls).ToString(CultureInfo.InvariantCulture) +
      "|vm_steps=" + Interlocked.Read(ref vmSteps).ToString(CultureInfo.InvariantCulture) + "|step_calls=" + Interlocked.Read(ref stepCalls).ToString(CultureInfo.InvariantCulture) +
      "|working_before_mib=" + MiB(workingBefore) + "|working_after_mib=" + MiB(process.WorkingSet64) +
      "|peak_working_after_mib=" + MiB(process.PeakWorkingSet64) + "|private_before_mib=" + MiB(privateBefore) +
      "|private_after_mib=" + MiB(process.PrivateMemorySize64) + "|managed_before_mib=" + MiB(managedBefore) + "|managed_after_mib=" + MiB(GC.GetTotalMemory(true)) +
      "|sqlite_heap_limit_before=" + heapLimitBefore.ToString(CultureInfo.InvariantCulture) + "|sqlite_heap_limit_after=" + CurrentHeapLimit(reader).ToString(CultureInfo.InvariantCulture));
  }

  static void RunPrefetchSyntheticSample(Sqlite3Mc reader) {
    ResetCounters();
    Process process = Process.GetCurrentProcess(); process.Refresh();
    long workingBefore = process.WorkingSet64, privateBefore = process.PrivateMemorySize64;
    long managedBefore = GC.GetTotalMemory(true);
    long heapLimitBefore = CurrentHeapLimit(reader);
    long rowsRead = 0, maxFrameBytes = 0, consumerDelay = 0;
    TimeSpan firstPage = TimeSpan.Zero, refill1 = TimeSpan.Zero, refill2 = TimeSpan.Zero, middlePages = TimeSpan.Zero;
    double firstWindowReadyMs = 0, secondWindowAcquireMs = 0, thirdWindowAcquireMs = 0;
    int pages = 0, slotHighWater = 0, maxResidentRows = 0, windowsAcquired = 1;
    long maxResidentBytes = 0;
    long priorTime = Int64.MinValue; string priorId = null;
    Stopwatch total = Stopwatch.StartNew();
    using (Sqlite3Mc.InitialImportPrefetcher prefetch = new Sqlite3Mc.InitialImportPrefetcher(reader, CancellationToken.None)) {
      prefetch.Start(null, null);
      Stopwatch acquire = Stopwatch.StartNew();
      Sqlite3Mc.InitialImportPrefetcher.WindowBuffer window = prefetch.AcquireWindow(null);
      acquire.Stop(); firstWindowReadyMs = acquire.Elapsed.TotalMilliseconds;
      if (window == null || !window.Ready) throw new InvalidDataException("probe_prefetch_first_window_missing");
      while (window != null && rowsRead < SyntheticRows) {
        for (int chunkIndex = 0; chunkIndex < window.Chunks.Count && rowsRead < SyntheticRows; chunkIndex++) {
          Sqlite3Mc.InitialImportBufferedRow[] rows = window.Chunks[chunkIndex];
          if (rows == null || rows.Length == 0 || rows.Length > SyntheticPageRows || rowsRead + rows.Length > SyntheticRows)
            throw new InvalidDataException("probe_prefetch_chunk_invalid");
          Stopwatch pageClock = Stopwatch.StartNew();
          VerifyBufferedOrder(rows, ref priorTime, ref priorId);
          string[] serialized = new string[rows.Length];
          for (int i = 0; i < rows.Length; i++) serialized[i] = rows[i].Json;
          int frameBytes = CandidatePageFrameBytes(serialized, pages + 1, rows[rows.Length - 1].CreatedTime, rows[rows.Length - 1].Id, true);
          maxFrameBytes = Math.Max(maxFrameBytes, frameBytes);
          rowsRead += rows.Length; pages++; pageClock.Stop();
          if (pages == 1) firstPage = pageClock.Elapsed;
          else if (pages == 16) refill1 = pageClock.Elapsed;
          else if (pages == 31) refill2 = pageClock.Elapsed;
          else if (pages > 16 && pages < 31) middlePages += pageClock.Elapsed;
          Thread.Sleep(SyntheticConsumerDelayMs); consumerDelay += SyntheticConsumerDelayMs;
          CaptureSlotUsage(prefetch, ref slotHighWater, ref maxResidentRows, ref maxResidentBytes);
        }
        if (rowsRead >= SyntheticRows) break;
        bool hasMore = window.HasMore;
        prefetch.ReleaseWindow(window);
        if (!hasMore) break;
        acquire.Restart();
        window = prefetch.AcquireWindow(null);
        acquire.Stop();
        windowsAcquired++;
        if (windowsAcquired == 2) secondWindowAcquireMs = acquire.Elapsed.TotalMilliseconds;
        else if (windowsAcquired == 3) thirdWindowAcquireMs = acquire.Elapsed.TotalMilliseconds;
        CaptureSlotUsage(prefetch, ref slotHighWater, ref maxResidentRows, ref maxResidentBytes);
      }
    }
    total.Stop();
    process.Refresh();
    Console.WriteLine("SYNTHETIC_SAMPLE|mode=prefetch|rows=" + rowsRead.ToString(CultureInfo.InvariantCulture) +
      "|pages=" + pages.ToString(CultureInfo.InvariantCulture) + "|delay_ms_per_page=" + SyntheticConsumerDelayMs.ToString(CultureInfo.InvariantCulture) +
      "|consumer_delay_ms=" + consumerDelay.ToString(CultureInfo.InvariantCulture) + "|first_window_ready_ms=" + firstWindowReadyMs.ToString("F1", CultureInfo.InvariantCulture) +
      "|window2_acquire_ms=" + secondWindowAcquireMs.ToString("F1", CultureInfo.InvariantCulture) + "|window3_acquire_ms=" + thirdWindowAcquireMs.ToString("F1", CultureInfo.InvariantCulture) +
      "|first_page_ms=" + Ms(firstPage) + "|refill1_page_ms=" + Ms(refill1) + "|pages17_30_ms=" + Ms(middlePages) + "|refill2_page_ms=" + Ms(refill2) +
      "|total_ms=" + Ms(total.Elapsed) + "|source_message_column_bytes=" + Interlocked.Read(ref totalMessageColumnBytes).ToString(CultureInfo.InvariantCulture) +
      "|max_actual_emit_body_bytes=" + maxFrameBytes.ToString(CultureInfo.InvariantCulture) +
      "|message_select_prepares=" + CountFamily("message") + "|message_stmt_sorts=" + MessageStatementStatus(SortStatus) +
      "|message_stmt_reprepares=" + MessageStatementStatus(ReprepareStatus) + "|all_prepares=" + Interlocked.Read(ref prepareCalls).ToString(CultureInfo.InvariantCulture) +
      "|vm_steps=" + Interlocked.Read(ref vmSteps).ToString(CultureInfo.InvariantCulture) + "|step_calls=" + Interlocked.Read(ref stepCalls).ToString(CultureInfo.InvariantCulture) +
      "|slot_high_water=" + slotHighWater.ToString(CultureInfo.InvariantCulture) + "|max_resident_accounted_rows=" + maxResidentRows.ToString(CultureInfo.InvariantCulture) +
      "|max_resident_accounted_bytes=" + maxResidentBytes.ToString(CultureInfo.InvariantCulture) + "|window_budget_bytes=67108864" +
      "|working_before_mib=" + MiB(workingBefore) + "|working_after_mib=" + MiB(process.WorkingSet64) +
      "|peak_working_after_mib=" + MiB(process.PeakWorkingSet64) + "|private_before_mib=" + MiB(privateBefore) +
      "|private_after_mib=" + MiB(process.PrivateMemorySize64) + "|managed_before_mib=" + MiB(managedBefore) + "|managed_after_mib=" + MiB(GC.GetTotalMemory(true)) +
      "|sqlite_heap_limit_before=" + heapLimitBefore.ToString(CultureInfo.InvariantCulture) + "|sqlite_heap_limit_after=" + CurrentHeapLimit(reader).ToString(CultureInfo.InvariantCulture) + "|clean_shutdown=true");
  }

  static void VerifyBufferedOrder(Sqlite3Mc.InitialImportBufferedRow[] rows, ref long priorTime, ref string priorId) {
    for (int i = 0; i < rows.Length; i++) {
      long created;
      if (!Int64.TryParse(rows[i].CreatedTime, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out created))
        throw new InvalidDataException("probe_cursor_time_invalid");
      if (priorId != null && (created < priorTime || (created == priorTime && String.CompareOrdinal(rows[i].Id, priorId) <= 0)))
        throw new InvalidDataException("probe_cursor_order_invalid");
      priorTime = created; priorId = rows[i].Id;
    }
  }

  static long CurrentHeapLimit(Sqlite3Mc reader) {
    FieldInfo field = typeof(Sqlite3Mc).GetField("hardHeapLimit64", BindingFlags.Instance | BindingFlags.NonPublic);
    Delegate getter = field == null ? null : field.GetValue(reader) as Delegate;
    return getter == null ? -1 : (long)getter.DynamicInvoke(-1L);
  }

  static int BufferedPageFrameBytes(Sqlite3Mc.InitialImportBufferedRow[] rows, int pageNumber, bool hasMore) {
    string[] serialized = new string[rows.Length];
    for (int i = 0; i < rows.Length; i++) serialized[i] = rows[i].Json;
    return CandidatePageFrameBytes(serialized, pageNumber, rows[rows.Length - 1].CreatedTime, rows[rows.Length - 1].Id, hasMore);
  }

  static void CaptureSlotUsage(Sqlite3Mc.InitialImportPrefetcher prefetch, ref int highWater, ref int maxRows, ref long maxBytes) {
    const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
    Type type = typeof(Sqlite3Mc.InitialImportPrefetcher);
    FieldInfo gateField = type.GetField("gate", flags), slotsField = type.GetField("slots", flags);
    if (gateField == null || slotsField == null) throw new MissingFieldException("probe_prefetch_slots_unavailable");
    object gate = gateField.GetValue(prefetch);
    lock (gate) {
      IList slots = slotsField.GetValue(prefetch) as IList;
      if (slots == null) throw new InvalidDataException("probe_prefetch_slots_invalid");
      highWater = Math.Max(highWater, slots.Count);
      int residentRows = 0; long residentBytes = 0;
      foreach (object item in slots) {
        Sqlite3Mc.InitialImportPrefetcher.WindowBuffer buffer = item as Sqlite3Mc.InitialImportPrefetcher.WindowBuffer;
        if (buffer != null && buffer.Ready) { residentRows += buffer.RowCount; residentBytes = checked(residentBytes + buffer.AccountedBytes); }
      }
      maxRows = Math.Max(maxRows, residentRows); maxBytes = Math.Max(maxBytes, residentBytes);
    }
  }

  static string CountFamily(string name) {
    lock (PreparedByFamily) return PreparedByFamily.ContainsKey(name) ? PreparedByFamily[name].ToString(CultureInfo.InvariantCulture) : "0";
  }

  static long MessageStatementStatus(int operation) {
    long total = operation == SortStatus ? Interlocked.Read(ref finalizedMessageSorts) : Interlocked.Read(ref finalizedMessageReprepares);
    if (sqliteStmtStatus == null) return -1;
    lock (messageStatements) {
      foreach (IntPtr statement in messageStatements) {
        try { total += (int)sqliteStmtStatus.DynamicInvoke(statement, operation, 0); } catch { return -1; }
      }
    }
    return total;
  }

  static int CandidatePageFrameBytes(string[] rows, int pageNumber, string lastTime, string lastId, bool hasMore) {
    JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
    object[] parsedRows = new object[rows.Length];
    for (int i = 0; i < rows.Length; i++) parsedRows[i] = json.DeserializeObject(rows[i]);
    Dictionary<string, object> cursor = new Dictionary<string, object> { { "createdTime", lastTime }, { "id", lastId } };
    Dictionary<string, object> fields = new Dictionary<string, object> {
      { "pageNumber", pageNumber }, { "batchDigest", DigestText(String.Join("\n", rows)) },
      { "rows", parsedRows }, { "lastCursor", cursor }, { "hasMore", hasMore }
    };
    const BindingFlags flags = BindingFlags.Static | BindingFlags.NonPublic;
    Type bridge = typeof(ExternalReaderBridge);
    FieldInfo requestId = bridge.GetField("requestId", flags);
    MethodInfo emitPage = bridge.GetMethod("EmitPage", flags);
    if (requestId == null || emitPage == null) throw new MissingMethodException("probe_emit_page_unavailable");
    requestId.SetValue(null, "0123456789abcdef0123456789abcdef");
    using (MemoryStream wireFrame = new MemoryStream()) {
      ParameterInfo[] parameters = emitPage.GetParameters();
      if (parameters.Length == 2) emitPage.Invoke(null, new object[] { wireFrame, fields });
      else emitPage.Invoke(null, new object[] { wireFrame, fields, true });
      byte[] bytes = wireFrame.ToArray();
      try {
        if (bytes.Length < 4) throw new InvalidDataException("probe_emit_page_frame_invalid");
        int bodyLength = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
        if (bodyLength != bytes.Length - 4) throw new InvalidDataException("probe_emit_page_frame_invalid");
        return bodyLength;
      } finally { Array.Clear(bytes, 0, bytes.Length); }
    }
  }

  static void RunInitialImportPageSamples(Sqlite3Mc reader, MethodInfo setAuth, MethodInfo clearAuth, MethodInfo query) {
    object[] firstArgs;
    string[] first = RunInitialImportPage(reader, null, null, 1, out firstArgs);
    string page1Time = (string)firstArgs[4], page1Id = (string)firstArgs[5];
    object[] secondArgs;
    RunInitialImportPage(reader, page1Time, page1Id, 2, out secondArgs);

    setAuth.Invoke(reader, new object[] { new Dictionary<string, string[]> {
      { "_message", new string[] { "_id", "_createdTime" } }
    } });
    List<object[]> cursorRows;
    Stopwatch offsetClock = Stopwatch.StartNew();
    try {
      cursorRows = InvokeQuery(query, reader,
        "SELECT _createdTime,_id FROM _message WHERE _createdTime IS NOT NULL AND _id IS NOT NULL ORDER BY _createdTime ASC,_id COLLATE BINARY ASC LIMIT 1 OFFSET 1000000", 4096);
    } finally { clearAuth.Invoke(reader, null); }
    offsetClock.Stop();
    if (cursorRows.Count != 1 || !(cursorRows[0][0] is long) || !(cursorRows[0][1] is string)) throw new InvalidDataException("probe_mid_cursor_invalid");
    object[] midArgs;
    RunInitialImportPage(reader, ((long)cursorRows[0][0]).ToString(CultureInfo.InvariantCulture), (string)cursorRows[0][1], 3, out midArgs);
    Console.WriteLine("MID_CURSOR|ordinal=1000001|lookup_ms=" + Ms(offsetClock.Elapsed));
  }

  static string[] RunInitialImportPage(Sqlite3Mc reader, string afterTime, string afterId, int pageNumber, out object[] args) {
    MethodInfo method = typeof(Sqlite3Mc).GetMethod("ReadMessageKeysetPage", BindingFlags.Instance | BindingFlags.NonPublic);
    if (method == null) throw new MissingMethodException("probe_page_api_unavailable");
    lock (PreparedByFamily) PreparedByFamily.Clear();
    currentMessageBytes = 0; maxMessageBytes = 0;
    long preparesBefore = Interlocked.Read(ref prepareCalls), vmBefore = Interlocked.Read(ref vmSteps), stepsBefore = Interlocked.Read(ref stepCalls);
    args = new object[] { afterTime, afterId, 500, false, null, null, false, false, null, null, true };
    Stopwatch clock = Stopwatch.StartNew();
    string[] rows = (string[])method.Invoke(reader, args);
    clock.Stop();
    long rawBytes = maxMessageBytes;
    long rowJsonBytes = 0;
    object[] parsedRows = new object[rows.Length];
    JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    for (int i = 0; i < rows.Length; i++) {
      rowJsonBytes += Encoding.UTF8.GetByteCount(rows[i]);
      parsedRows[i] = json.DeserializeObject(rows[i]);
    }
    Dictionary<string, object> cursor = rows.Length == 0 ? null : new Dictionary<string, object> {
      { "createdTime", args[4] }, { "id", args[5] }
    };
    Dictionary<string, object> frame = new Dictionary<string, object> {
      { "version", 1 }, { "requestId", "0123456789abcdef0123456789abcdef" }, { "sequence", pageNumber + 10 }, { "type", "page" },
      { "pageNumber", pageNumber }, { "batchDigest", DigestText(String.Join("\n", rows)) },
      { "rows", parsedRows }, { "lastCursor", cursor }, { "hasMore", (bool)args[3] }
    };
    int frameBytes = Encoding.UTF8.GetByteCount(json.Serialize(frame));
    Console.WriteLine("INITIAL_PAGE|number=" + pageNumber.ToString(CultureInfo.InvariantCulture) +
      "|rows=" + rows.Length.ToString(CultureInfo.InvariantCulture) +
      "|has_more=" + ((bool)args[3] ? "1" : "0") +
      "|elapsed_ms=" + Ms(clock.Elapsed) +
      "|raw_501_or_less_row_query_bytes=" + rawBytes.ToString(CultureInfo.InvariantCulture) +
      "|serialized_row_json_bytes=" + rowJsonBytes.ToString(CultureInfo.InvariantCulture) +
      "|candidate_page_frame_body_bytes=" + frameBytes.ToString(CultureInfo.InvariantCulture) +
      "|candidate_frame_limit_bytes=1048576" +
      "|prepared=" + (Interlocked.Read(ref prepareCalls) - preparesBefore).ToString(CultureInfo.InvariantCulture) +
      "|vm_steps=" + (sqliteStmtStatus == null ? "unavailable" : (Interlocked.Read(ref vmSteps) - vmBefore).ToString(CultureInfo.InvariantCulture)) +
      "|step_calls=" + (Interlocked.Read(ref stepCalls) - stepsBefore).ToString(CultureInfo.InvariantCulture) +
      "|query_family_counts=" + FamilySummary());
    return rows;
  }

  static string DigestText(string value) {
    using (SHA256 sha = SHA256.Create())
      return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant();
  }

  static string[] RunPage(Sqlite3Mc reader, string afterTime, string afterId, out object[] args) {
    MethodInfo method = typeof(Sqlite3Mc).GetMethod("ReadMessageKeysetPage", BindingFlags.Instance | BindingFlags.NonPublic);
    if (method == null) throw new MissingMethodException("probe_page_api_unavailable");
    lock (PreparedByFamily) PreparedByFamily.Clear();
    long preparesBefore = prepareCalls, vmBefore = vmSteps, stepsBefore = stepCalls;
    args = new object[] { afterTime, afterId, 100, false, null, null, false, false, null, null };
    Stopwatch clock = Stopwatch.StartNew();
    string[] rows = (string[])method.Invoke(reader, args);
    clock.Stop();
    args[6] = clock.ElapsedMilliseconds;
    args[7] = Interlocked.Read(ref prepareCalls) - preparesBefore;
    args[8] = Interlocked.Read(ref vmSteps) - vmBefore;
    args[9] = Interlocked.Read(ref stepCalls) - stepsBefore;
    return rows;
  }

  static void EmitPage(string label, string[] rows, object[] args) {
    Console.WriteLine("PAGE|kind=" + label + "|rows=" + rows.Length.ToString(CultureInfo.InvariantCulture) +
      "|has_more=" + ((bool)args[3] ? "1" : "0") + "|elapsed_ms=" + Convert.ToString(args[6], CultureInfo.InvariantCulture) +
      "|prepared=" + Convert.ToString(args[7], CultureInfo.InvariantCulture) +
      "|vm_steps=" + (sqliteStmtStatus == null || (long)args[8] < 0 ? "unavailable" : Convert.ToString(args[8], CultureInfo.InvariantCulture)) +
      "|step_calls=" + Convert.ToString(args[9], CultureInfo.InvariantCulture) +
      "|query_family_counts=" + FamilySummary());
  }

  static string FamilySummary() {
    lock (PreparedByFamily) {
      List<string> items = new List<string>();
      foreach (KeyValuePair<string, long> pair in PreparedByFamily) items.Add(pair.Key + ":" + pair.Value.ToString(CultureInfo.InvariantCulture));
      return String.Join(",", items.ToArray());
    }
  }

  static void EmitOrderedStreamSample(Sqlite3Mc reader, MethodInfo setAuth, MethodInfo clearAuth) {
    setAuth.Invoke(reader, new object[] { new Dictionary<string, string[]> {
      { "_message", new string[] { "_id", "_from", "_toType", "_createdTime", "_chatId", "_text", "_contentType" } }
    } });
    try {
      Stopwatch clock = Stopwatch.StartNew();
      long count = StreamRows(reader, 10000, false);
      clock.Stop();
      Console.WriteLine("ORDERED_STREAM|rows=" + count.ToString(CultureInfo.InvariantCulture) + "|elapsed_ms=" + Ms(clock.Elapsed) +
        "|rows_per_second=" + Rate(count, clock.Elapsed));
    } finally { clearAuth.Invoke(reader, null); }
  }

  static void EmitStreamingAdapterSample(Sqlite3Mc reader, MethodInfo setAuth, MethodInfo clearAuth) {
    setAuth.Invoke(reader, new object[] { new Dictionary<string, string[]> {
      { "_message", new string[] { "_id", "_from", "_toType", "_createdTime", "_chatId", "_text", "_contentType" } }
    } });
    try {
      lock (PreparedByFamily) PreparedByFamily.Clear();
      long preparesBefore = Interlocked.Read(ref prepareCalls), vmBefore = Interlocked.Read(ref vmSteps), stepsBefore = Interlocked.Read(ref stepCalls);
      Process process = Process.GetCurrentProcess();
      process.Refresh();
      long workingBefore = process.WorkingSet64, privateBefore = process.PrivateMemorySize64, peakBefore = process.PeakWorkingSet64;
      long managedBefore = GC.GetTotalMemory(true);
      Stopwatch clock = Stopwatch.StartNew();
      TimeSpan firstBatch;
      long maxRawPage, maxSerializedRows, reprepares;
      long count = StreamAdaptPages(reader, 10000, out firstBatch, out maxRawPage, out maxSerializedRows, out reprepares);
      clock.Stop();
      process.Refresh();
      long workingAfter = process.WorkingSet64, privateAfter = process.PrivateMemorySize64, peakAfter = process.PeakWorkingSet64;
      long managedAfter = GC.GetTotalMemory(true);
      Console.WriteLine("ORDERED_STREAM_ADAPTER|rows=" + count.ToString(CultureInfo.InvariantCulture) + "|elapsed_ms=" + Ms(clock.Elapsed) +
        "|first_100_ms=" + Ms(firstBatch) + "|remaining_ms=" + Ms(clock.Elapsed - firstBatch) +
        "|rows_per_second=" + Rate(count, clock.Elapsed) + "|max_101_row_query_bytes=" + maxRawPage.ToString(CultureInfo.InvariantCulture) +
        "|max_100_row_json_bytes=" + maxSerializedRows.ToString(CultureInfo.InvariantCulture) +
        "|message_statement_reprepares=" + (reprepares < 0 ? "unavailable" : reprepares.ToString(CultureInfo.InvariantCulture)) +
        "|prepared=" + (Interlocked.Read(ref prepareCalls) - preparesBefore).ToString(CultureInfo.InvariantCulture) +
        "|vm_steps=" + (sqliteStmtStatus == null ? "unavailable" : (Interlocked.Read(ref vmSteps) - vmBefore).ToString(CultureInfo.InvariantCulture)) +
        "|step_calls=" + (Interlocked.Read(ref stepCalls) - stepsBefore).ToString(CultureInfo.InvariantCulture) + "|query_family_counts=" + FamilySummary() +
        "|working_before_mib=" + MiB(workingBefore) + "|working_after_mib=" + MiB(workingAfter) +
        "|peak_before_mib=" + MiB(peakBefore) + "|peak_after_mib=" + MiB(peakAfter) +
        "|peak_delta_mib=" + MiB(Math.Max(0, peakAfter - peakBefore)) +
        "|private_before_mib=" + MiB(privateBefore) + "|private_after_mib=" + MiB(privateAfter) +
        "|managed_before_mib=" + MiB(managedBefore) + "|managed_after_mib=" + MiB(managedAfter));
    } finally { clearAuth.Invoke(reader, null); }
  }

  static long StreamAdaptPages(Sqlite3Mc reader, int limit, out TimeSpan firstBatchTime,
      out long maxRawPageBytes, out long maxSerializedRowsBytes, out long messageStatementReprepares) {
    const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
    Type type = typeof(Sqlite3Mc);
    MethodInfo prepare = type.GetMethod("PrepareStatement", flags), column = type.GetMethod("Column", flags);
    MethodInfo serialize = type.GetMethod("SerializeNativeMessageRow", flags);
    FieldInfo stepField = type.GetField("step", flags), countField = type.GetField("columnCount", flags),
      bytesField = type.GetField("columnBytes", flags), finalizeField = type.GetField("finalize", flags);
    if (prepare == null || column == null || serialize == null || stepField == null || countField == null || bytesField == null || finalizeField == null)
      throw new MissingMethodException("probe_stream_api_unavailable");
    IntPtr statement = (IntPtr)prepare.Invoke(reader, new object[] {
      "SELECT _id,_from,_toType,_createdTime,_chatId,_text,_contentType FROM _message WHERE _createdTime IS NOT NULL AND _id IS NOT NULL ORDER BY _createdTime ASC,_id COLLATE BINARY ASC LIMIT " +
      (limit + 1).ToString(CultureInfo.InvariantCulture)
    });
    Delegate step = (Delegate)stepField.GetValue(reader), count = (Delegate)countField.GetValue(reader);
    Delegate columnBytes = (Delegate)bytesField.GetValue(reader), finalize = (Delegate)finalizeField.GetValue(reader);
    Type cacheType = serialize.GetParameters()[1].ParameterType;
    List<StreamRecord> window = new List<StreamRecord>(101);
    StreamRecord carry = null;
    long rows = 0;
    firstBatchTime = TimeSpan.Zero;
    maxRawPageBytes = 0;
    maxSerializedRowsBytes = 0;
    messageStatementReprepares = -1;
    Stopwatch elapsed = Stopwatch.StartNew();
    try {
      while (rows < limit) {
        window.Clear();
        long rawPageBytes = 0;
        if (carry != null) { window.Add(carry); rawPageBytes += carry.ByteCount; carry = null; }
        bool exhausted = false;
        while (window.Count < 101 && !exhausted) {
          int state = (int)step.DynamicInvoke(statement);
          if (state == 101) { exhausted = true; break; }
          if (state != 100) throw new InvalidDataException("probe_stream_step_failed");
          int columns = (int)count.DynamicInvoke(statement), total = 0;
          object[] row = new object[columns];
          for (int i = 0; i < columns; i++) {
            object[] args = new object[] { statement, i, total, 1024 * 1024 };
            row[i] = column.Invoke(reader, args);
            total = (int)args[2];
          }
          window.Add(new StreamRecord { Values = row, ByteCount = total });
          rawPageBytes += total;
        }
        if (window.Count == 0) break;
        int take = Math.Min(100, Math.Min(window.Count, limit - (int)rows));
        if (rawPageBytes > 128 * 1024) throw new InvalidDataException("probe_stream_page_budget_exceeded");
        object pageCache = Activator.CreateInstance(cacheType);
        long serializedRowsBytes = 0;
        for (int i = 0; i < take; i++) {
          object[] output = new object[] { window[i].Values, pageCache, null, null };
          string json = (string)serialize.Invoke(reader, output);
          serializedRowsBytes += Encoding.UTF8.GetByteCount(json);
          json = null;
          for (int c = 0; c < window[i].Values.Length; c++)
            if (window[i].Values[c] is byte[]) Array.Clear((byte[])window[i].Values[c], 0, ((byte[])window[i].Values[c]).Length);
        }
        if (serializedRowsBytes > 1024 * 1024) throw new InvalidDataException("probe_stream_frame_budget_exceeded");
        maxRawPageBytes = Math.Max(maxRawPageBytes, rawPageBytes);
        maxSerializedRowsBytes = Math.Max(maxSerializedRowsBytes, serializedRowsBytes);
        rows += take;
        if (rows == take) { elapsed.Stop(); firstBatchTime = elapsed.Elapsed; elapsed.Start(); }
        if (take < window.Count) carry = window[take];
      }
      return rows;
    } finally {
      if (sqliteStmtStatus != null) {
        try { messageStatementReprepares = (int)sqliteStmtStatus.DynamicInvoke(statement, 5, 0); } catch {}
      }
      finalize.DynamicInvoke(statement);
    }
  }

  sealed class StreamRecord { internal object[] Values; internal int ByteCount; }

  static long StreamRows(Sqlite3Mc reader, int limit, bool adapt) {
    const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
    Type type = typeof(Sqlite3Mc);
    MethodInfo prepare = type.GetMethod("PrepareStatement", flags), column = type.GetMethod("Column", flags);
    MethodInfo serialize = type.GetMethod("SerializeNativeMessageRow", flags);
    FieldInfo stepField = type.GetField("step", flags), countField = type.GetField("columnCount", flags), bytesField = type.GetField("columnBytes", flags);
    if (prepare == null || column == null || stepField == null || countField == null || bytesField == null || (adapt && serialize == null))
      throw new MissingMethodException("probe_stream_api_unavailable");
    IntPtr statement = (IntPtr)prepare.Invoke(reader, new object[] {
      "SELECT _id,_from,_toType,_createdTime,_chatId,_text,_contentType FROM _message WHERE _createdTime IS NOT NULL AND _id IS NOT NULL ORDER BY _createdTime ASC,_id COLLATE BINARY ASC LIMIT " + limit.ToString(CultureInfo.InvariantCulture)
    });
    Delegate step = (Delegate)stepField.GetValue(reader), count = (Delegate)countField.GetValue(reader);
    Delegate columnBytes = (Delegate)bytesField.GetValue(reader);
    IDictionary pageCache = null;
    if (adapt) {
      Type cacheType = serialize.GetParameters()[1].ParameterType;
      pageCache = (IDictionary)CreateCache(cacheType);
    }
    long rows = 0;
    try {
      while (true) {
        int state = (int)step.DynamicInvoke(statement);
        if (state == 101) break;
        if (state != 100) throw new InvalidDataException("probe_stream_step_failed");
        int columns = (int)count.DynamicInvoke(statement), total = 0;
        object[] row = new object[columns];
        for (int i = 0; i < columns; i++) {
          object[] args = new object[] { statement, i, total, 1024 * 1024 };
          row[i] = column.Invoke(reader, args);
          total = (int)args[2];
        }
        if (adapt) {
          if (rows % 100 == 0) pageCache.Clear();
          object[] output = new object[] { row, pageCache, null, null };
          serialize.Invoke(reader, output);
        }
        for (int i = 0; i < row.Length; i++) if (row[i] is byte[]) Array.Clear((byte[])row[i], 0, ((byte[])row[i]).Length);
        rows++;
      }
      return rows;
    } finally {
      FieldInfo finalizeField = type.GetField("finalize", flags);
      ((Delegate)finalizeField.GetValue(reader)).DynamicInvoke(statement);
    }
  }

  static object CreateCache(Type type) {
    return Activator.CreateInstance(type);
  }

  static string Rate(long rows, TimeSpan time) {
    return time.TotalSeconds <= 0 ? "unavailable" : (rows / time.TotalSeconds).ToString("F1", CultureInfo.InvariantCulture);
  }
  static string MiB(long bytes) { return (bytes / (1024.0 * 1024.0)).ToString("F1", CultureInfo.InvariantCulture); }
  static string Ms(TimeSpan time) { return time.TotalMilliseconds.ToString("F1", CultureInfo.InvariantCulture); }
  static string SafeSchema(string value) {
    if (String.IsNullOrEmpty(value) || value.Length > 1024) return "unavailable";
    foreach (char ch in value) if (!(Char.IsLetterOrDigit(ch) || ch == '_' || ch == '-' || ch == '"' || ch == '(' || ch == ')' || ch == ',' || ch == ' ' || ch == '.' || ch == ';' || ch == '<' || ch == '=' || ch == '>' || ch == '?')) return "unavailable";
    return value;
  }
  static string SafeSymbol(Exception error) {
    string value = error.Message;
    if (String.IsNullOrEmpty(value) || value.Length > 100) return "unavailable";
    foreach (char ch in value) if (!(Char.IsLetterOrDigit(ch) || ch == '_' || ch == '-')) return "unavailable";
    return value;
  }
  static string SafeDiagnostic(string value) {
    if (String.IsNullOrEmpty(value) || value.Length > 256) return "none";
    foreach (char ch in value) if (!(Char.IsLetterOrDigit(ch) || ch == '_' || ch == '-' || ch == '=' || ch == '|')) return "none";
    return value;
  }
  static Exception Unwrap(Exception error) {
    while (error is TargetInvocationException && error.InnerException != null) error = error.InnerException;
    return error;
  }
}
