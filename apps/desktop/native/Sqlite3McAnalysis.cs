using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;

// Raw cell view used by the retained-snapshot analyzer. Data holds at most AnalysisMaxCopyBytes of a TEXT/BLOB cell.
internal sealed class AnalysisCell {
  internal int Type;      // SQLite storage class: 1 INTEGER, 2 REAL, 3 TEXT, 4 BLOB, 5 NULL
  internal long Integer;
  internal double Real;
  internal byte[] Data = new byte[0];
  internal int Length;    // full byte length of a TEXT/BLOB cell
  internal int Copied;    // bytes valid in Data
}

internal delegate void AnalysisRowHandler(AnalysisCell[] cells);
internal delegate void AnalysisMessageHandler(string[] columns, AnalysisCell[] cells, string projectedJson, string projectionError);

// Analysis-only reading primitives for the standalone OfficialSnapshotTool. They live beside the production reader
// (partial class) so they can use its private SQLite binding without changing any production read path.
internal sealed partial class Sqlite3Mc {
  internal const int AnalysisMaxCopyBytes = 256 * 1024;
  static readonly Regex SafeErrorCode = new Regex("^[A-Z][A-Z_]{2,39}$", RegexOptions.CultureInvariant);

  void SetAnalysisAuthorizer() {
    authorizer = delegate(IntPtr user, int action, IntPtr arg1, IntPtr arg2, IntPtr database, IntPtr trigger) {
      if (trigger != IntPtr.Zero) return AuthorizerDeny;
      if (action == AuthorizerSelect) return 0;
      if (action == AuthorizerRead) { string name = Text(database); return name == "main" || name == "" ? 0 : AuthorizerDeny; }
      if (action == AuthorizerFunction) { string fn = Text(arg2); return fn == "count" || fn == "typeof" || fn == "length" ? 0 : AuthorizerDeny; }
      return AuthorizerDeny;
    };
    Check(setAuthorizer(db, authorizer, IntPtr.Zero));
  }

  // Analysis reads rows the production importer would reject for size; the whole-cell cap stays bounded.
  internal void AnalysisConfigure() { limit(db, 0, 128 * 1024 * 1024); SetAnalysisAuthorizer(); }

  // Tables whose rows are archived in native_source_catalog_records: the production catalog list plus _message rows
  // (every _message row carries its protected full row in nativePayload).
  internal static string[] AnalysisArchivedTableNames() {
    string[] result = new string[NativeCatalogTableNames.Length + 1];
    Array.Copy(NativeCatalogTableNames, result, NativeCatalogTableNames.Length);
    result[result.Length - 1] = "_message";
    return result;
  }
  internal static string AnalysisCategory(long? midType) { return CategoryForNativeType(midType); }

  static string QuoteIdentifier(string name) { return "\"" + name.Replace("\"", "\"\"") + "\""; }

  string ReadStrictText(IntPtr statement, int index) {
    int type = columnType(statement, index);
    if (type != 3) return null;
    IntPtr pointer = columnText(statement, index); int length = columnBytes(statement, index);
    if (length < 0 || length > 4096 || (length > 0 && pointer == IntPtr.Zero)) return null;
    byte[] bytes = new byte[length]; if (length > 0) Marshal.Copy(pointer, bytes, 0, length);
    try { return StrictUtf8.GetString(bytes); } catch { return null; }
  }

  internal List<string> AnalysisTableNames() {
    SetAnalysisAuthorizer();
    List<string> names = new List<string>();
    IntPtr statement = PrepareStatement("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    try {
      while (true) {
        int state = step(statement);
        if (state == Done) break;
        if (state != Row) throw Failure("DATABASE_READ_FAILED", state);
        string name = ReadStrictText(statement, 0);
        if (name != null && name.Length > 0 && !name.StartsWith("sqlite_", StringComparison.Ordinal) && names.Count < 4096) names.Add(name);
      }
    } finally { finalize(statement); }
    return names;
  }

  string[] StatementColumnNames(IntPtr statement) {
    int count = columnCount(statement); string[] names = new string[count];
    for (int i = 0; i < count; i++) {
      IntPtr pointer = columnName(statement, i);
      names[i] = pointer == IntPtr.Zero ? "" : Marshal.PtrToStringAnsi(pointer);
    }
    return names;
  }

  internal string[] AnalysisColumnNames(string table) {
    SetAnalysisAuthorizer();
    IntPtr statement = PrepareStatement("SELECT * FROM " + QuoteIdentifier(table) + " LIMIT 0");
    try { return StatementColumnNames(statement); } finally { finalize(statement); }
  }

  void ReadAnalysisCell(IntPtr statement, int index, AnalysisCell cell) {
    int type = columnType(statement, index);
    cell.Type = type; cell.Length = 0; cell.Copied = 0; cell.Integer = 0; cell.Real = 0;
    if (type == 1) cell.Integer = columnInt64(statement, index);
    else if (type == 2) cell.Real = columnDouble(statement, index);
    else if (type == 3 || type == 4) {
      IntPtr pointer = type == 3 ? columnText(statement, index) : columnBlob(statement, index);
      int length = columnBytes(statement, index);
      if (length < 0) throw new InvalidOperationException("DATABASE_READ_FAILED");
      cell.Length = length;
      int copy = Math.Min(length, AnalysisMaxCopyBytes);
      if (copy > 0) {
        if (pointer == IntPtr.Zero) throw new InvalidOperationException("DATABASE_READ_FAILED");
        if (cell.Data.Length < copy) cell.Data = new byte[Math.Max(copy, Math.Min(AnalysisMaxCopyBytes, cell.Data.Length * 2 + 64))];
        Marshal.Copy(pointer, cell.Data, 0, copy);
      }
      cell.Copied = copy;
    }
  }

  static void ClearAnalysisCells(AnalysisCell[] cells) {
    for (int i = 0; i < cells.Length; i++) if (cells[i] != null && cells[i].Data.Length > 0) Array.Clear(cells[i].Data, 0, cells[i].Data.Length);
  }

  internal long AnalysisScanTable(string table, CancellationToken cancellation, AnalysisRowHandler handler) {
    SetAnalysisAuthorizer();
    IntPtr statement = PrepareStatement("SELECT * FROM " + QuoteIdentifier(table));
    AnalysisCell[] cells = null;
    try {
      int count = columnCount(statement);
      cells = new AnalysisCell[count];
      for (int i = 0; i < count; i++) cells[i] = new AnalysisCell();
      long rows = 0;
      while (true) {
        if ((rows & 255) == 0) cancellation.ThrowIfCancellationRequested();
        int state = step(statement);
        if (state == Done) break;
        if (state != Row) throw Failure("DATABASE_READ_FAILED", state);
        for (int c = 0; c < count; c++) ReadAnalysisCell(statement, c, cells[c]);
        handler(cells); rows++;
      }
      return rows;
    } finally { finalize(statement); if (cells != null) ClearAnalysisCells(cells); }
  }

  static bool SameNames(string[] actual, string[] expected) {
    if (actual.Length != expected.Length) return false;
    HashSet<string> set = new HashSet<string>(expected, StringComparer.Ordinal);
    for (int i = 0; i < actual.Length; i++) if (!set.Remove(actual[i])) return false;
    return set.Count == 0;
  }

  // One streaming pass over _message. When the schema equals the production column set, each row is also run through
  // the production SerializeNativeMessageRow and the resulting JSON (without the protected payload) is handed over.
  // Returns whether the projection ran.
  internal bool AnalysisScanMessages(CancellationToken cancellation, AnalysisMessageHandler handler) {
    SetAnalysisAuthorizer();
    IntPtr statement = PrepareStatement("SELECT * FROM \"_message\"");
    AnalysisCell[] cells = null;
    try {
      string[] names = StatementColumnNames(statement);
      bool project = SameNames(names, NativeMessageColumnNames);
      cells = new AnalysisCell[names.Length];
      for (int i = 0; i < cells.Length; i++) cells[i] = new AnalysisCell();
      Dictionary<string, NativeConversationInfo> pageCache = new Dictionary<string, NativeConversationInfo>(StringComparer.Ordinal);
      Dictionary<string, NativeSenderInfo> senderNameCache = new Dictionary<string, NativeSenderInfo>(StringComparer.Ordinal);
      long rows = 0;
      while (true) {
        if ((rows & 255) == 0) cancellation.ThrowIfCancellationRequested();
        int state = step(statement);
        if (state == Done) break;
        if (state != Row) throw Failure("DATABASE_READ_FAILED", state);
        for (int c = 0; c < cells.Length; c++) ReadAnalysisCell(statement, c, cells[c]);
        string json = null, error = null;
        if (project) {
          NativeSourceRow row = null;
          try {
            int total = 0;
            row = ReadNativeSourceRow(statement, "_message", names, ref total, MaxResultBytes);
            string createdTime, messageId;
            json = SerializeNativeMessageRow(row, pageCache, senderNameCache, out createdTime, out messageId);
          } catch (OperationCanceledException) { throw; }
          catch (Exception failure) {
            error = SafeErrorCode.IsMatch(failure.Message ?? "") ? failure.Message : "OTHER";
            if (row != null) row.Clear();
          }
        }
        handler(names, cells, json, error);
        rows++;
      }
      return project;
    } finally { finalize(statement); if (cells != null) ClearAnalysisCells(cells); }
  }

  // Sandbox reads of one row by native id; the caller supplies the column list (all names are fixed schema constants).
  internal bool AnalysisReadMessageById(string id, string[] columns, AnalysisCell[] cells) {
    SetAnalysisAuthorizer();
    StringBuilder list = new StringBuilder();
    for (int i = 0; i < columns.Length; i++) { if (i > 0) list.Append(','); list.Append(QuoteIdentifier(columns[i])); }
    IntPtr statement = PrepareStatement("SELECT " + list + " FROM \"_message\" WHERE \"_id\" = ? LIMIT 1");
    try {
      Bind(statement, 1, id);
      int state = step(statement);
      if (state == Done) return false;
      if (state != Row) throw Failure("DATABASE_READ_FAILED", state);
      for (int c = 0; c < columns.Length; c++) ReadAnalysisCell(statement, c, cells[c]);
      return true;
    } finally { finalize(statement); }
  }

  // Side databases cannot pass the main-schema/MID check. The caller verifies page 1, schema readability and
  // quick_check on the finished copy instead. The destination file must already exist (created by the caller).
  internal void BackupSideTo(string destinationPath, byte[] keyBytes, CancellationToken cancellation,
      long maxDatabaseBytes, long maxWalBytes, long maxSnapshotBytes) {
    if (!readOnly || String.IsNullOrEmpty(destinationPath) || keyBytes == null || maxDatabaseBytes < 1 || maxWalBytes < 0 || maxSnapshotBytes < 1)
      throw new InvalidOperationException("snapshot_request_invalid");
    bool transaction = false;
    using (Sqlite3Mc destination = OpenBackupDestination(destinationPath, keyBytes)) {
      IntPtr handle = IntPtr.Zero; Exception failure = null;
      try {
        RunStatement("BEGIN"); transaction = true;
        List<object[]> probe = Query("SELECT COUNT(*) FROM sqlite_master");
        if (probe.Count != 1) throw new InvalidOperationException("snapshot_backup_failed");
        long pageSize = ReadPageSize();
        cancellation.ThrowIfCancellationRequested();
        destination.RunStatement("PRAGMA journal_mode=OFF");
        destination.RunStatement("PRAGMA synchronous=OFF");
        handle = backupInit(destination.db, Utf8Z("main"), db, Utf8Z("main"));
        if (handle == IntPtr.Zero) throw new InvalidOperationException("snapshot_backup_init_failed");
        long lastProgressAt = Stopwatch.GetTimestamp(); int lastCopiedPages = 0;
        while (true) {
          cancellation.ThrowIfCancellationRequested();
          CheckBackupSourceBounds(maxDatabaseBytes, maxWalBytes);
          int state = backupStep(handle, 256);
          int pageCount = backupPageCount(handle), remaining = backupRemaining(handle);
          if (pageCount < 0 || remaining < 0 || remaining > pageCount) throw new InvalidOperationException("snapshot_backup_failed");
          long copiedPages = pageCount - remaining;
          if (checked((long)pageCount * pageSize) > maxSnapshotBytes) throw new InvalidOperationException("snapshot_size_limit");
          if (copiedPages > lastCopiedPages) { lastCopiedPages = (int)copiedPages; lastProgressAt = Stopwatch.GetTimestamp(); }
          else if (Stopwatch.GetTimestamp() - lastProgressAt >= Stopwatch.Frequency * 120L) throw new InvalidOperationException("snapshot_backup_no_progress");
          if (state == Done) break;
          if (state != 0 && state != 5 && state != 6) throw new InvalidOperationException("snapshot_backup_failed");
          if (state == 5 || state == 6) cancellation.WaitHandle.WaitOne(25);
        }
      } catch (Exception error) { failure = error; throw; }
      finally {
        try {
          if (handle != IntPtr.Zero) {
            int finishState = backupFinish(handle); handle = IntPtr.Zero;
            if (finishState != 0 && failure == null) throw new InvalidOperationException("snapshot_backup_failed");
          }
          if (failure == null) destination.DisableJournalMode();
        } finally { if (transaction) RunStatement("ROLLBACK"); }
      }
    }
  }

  // Replacement verification for side copies; runs on a fresh read-only connection without an authorizer.
  internal bool AnalysisVerifySideCopy() {
    List<object[]> master = Query("SELECT COUNT(*) FROM sqlite_master");
    if (master.Count != 1 || master[0].Length != 1 || !(master[0][0] is long)) return false;
    List<object[]> check = Query("PRAGMA quick_check");
    return check.Count == 1 && check[0].Length == 1 && check[0][0] is string && String.Equals((string)check[0][0], "ok", StringComparison.Ordinal);
  }

#if SQLITE_FIXTURE_WRITER
  internal void FixtureExecute(string sql) { RunStatement(sql); }
#endif
}
