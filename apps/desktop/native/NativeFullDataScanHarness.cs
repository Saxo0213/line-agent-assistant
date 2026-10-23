using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Temporary worktree-local full-copy diagnostic. It opens one existing
// CaptureFixed copy and streams every _message row in the production order.
internal static class NativeFullDataScanHarness {
  const int Row = 100, Done = 101, QueryBudget = 128 * 1024, FrameBudget = 1024 * 1024, RowBudget = 128 * 1024;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
  static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
  static readonly Dictionary<string, long> issues = new Dictionary<string, long>(StringComparer.Ordinal);
  static readonly Dictionary<string, long> contentTypes = new Dictionary<string, long>(StringComparer.Ordinal);
  static readonly Dictionary<string, long> senderEmptyContexts = new Dictionary<string, long>(StringComparer.Ordinal);
  static readonly Dictionary<string, long> textContexts = new Dictionary<string, long>(StringComparer.Ordinal);
  static readonly Dictionary<string, long> toTypes = new Dictionary<string, long>(StringComparer.Ordinal);
  static long textMaxBytes, textMaxChars, textOver16384, senderMaxChars, senderEmpty, idMaxChars, chatMaxChars;
  static long pages, queryOver, rowOver, frameOver, frameMax, totalRows;
  static int Main() {
    string expectedMid = Console.In.ReadLine();
    string copyDirectory = Console.In.ReadLine();
    byte[] key = null;
    try {
      if (String.IsNullOrEmpty(expectedMid) || expectedMid.Length > 200 || expectedMid.IndexOf('\0') >= 0 ||
          String.IsNullOrEmpty(copyDirectory)) throw new InvalidDataException("audit_input_invalid");
      string fullCopy = Path.GetFullPath(copyDirectory);
      string tempRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
      if (!fullCopy.StartsWith(tempRoot, StringComparison.OrdinalIgnoreCase) ||
          !Path.GetFileName(fullCopy).StartsWith("linejs-native-audit-", StringComparison.Ordinal) ||
          (File.GetAttributes(fullCopy) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("audit_copy_invalid");

      string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
      OfficialSourceInventoryResult source = OfficialSourceInventory.Inspect(Path.Combine(localAppData, "LINE"),
        OfficialSourceInventory.SupportedBuildVersion, OfficialSourceInventory.SupportedBuildBytes,
        OfficialSourceInventory.SupportedBuildSha256, new WindowsOfficialSourceInventoryEnvironment());
      key = OfficialSourceKeyProbe.Find(source, new WindowsOfficialSourceInventoryEnvironment(), DateTime.UtcNow.AddMinutes(30), CancellationToken.None, null);
      source = null; // Key probing closed its file/process handles before offline copy access.

      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(Path.Combine(fullCopy, "snapshot.edb"), key)) {
        reader.VerifySchemaReadable();
        FullRowStream stream = new FullRowStream(reader);
        stream.Run();
      }
      PrintSummary();
      Console.WriteLine("WAITING_FOR_OWNER|send CLEANUP after root accepts report, or KEEP to retain encrypted copy");
      if (String.Equals(Console.In.ReadLine(), "CLEANUP", StringComparison.Ordinal)) {
        // SnapshotOwner is intentionally not available after the CaptureFixed process exited.
        // Retention is left to the original capture owner/root cleanup flow.
        Console.WriteLine("CLEANUP|OWNER_PROCESS_REQUIRED");
      } else Console.WriteLine("COPY_RETAINED|1");
      return 0;
    } catch (Exception error) {
      Console.WriteLine("AUDIT|FAIL|type=" + error.GetType().Name + "|symbol=" + SafeSymbol(Unwrap(error)));
      return 1;
    } finally { if (key != null) Array.Clear(key, 0, key.Length); }
  }

  sealed class RowRecord { internal object[] Values; internal int[] Bytes; internal bool DecodeFailed; }

  sealed class FullRowStream {
    readonly Sqlite3Mc reader;
    readonly MethodInfo setAuthorizer, prepareStatement, column;
    readonly FieldInfo stepField, countField, bytesField;
    readonly Dictionary<string, string[]> authorized = new Dictionary<string, string[]> {
      { "_message", new string[] { "_id", "_from", "_toType", "_createdTime", "_chatId", "_text", "_contentType" } }
    };
    internal FullRowStream(Sqlite3Mc value) {
      reader = value; Type type = typeof(Sqlite3Mc); BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
      setAuthorizer = type.GetMethod("SetReadAuthorizer", flags); prepareStatement = type.GetMethod("PrepareStatement", flags);
      column = type.GetMethod("Column", flags); stepField = type.GetField("step", flags);
      countField = type.GetField("columnCount", flags); bytesField = type.GetField("columnBytes", flags);
      if (setAuthorizer == null || prepareStatement == null || column == null || stepField == null || countField == null || bytesField == null)
        throw new MissingMethodException("audit_reader_unavailable");
    }
    internal void Run() {
      setAuthorizer.Invoke(reader, new object[] { authorized });
      IntPtr statement = (IntPtr)prepareStatement.Invoke(reader, new object[] {
        "SELECT _id,_from,_toType,_createdTime,_chatId,_text,_contentType FROM _message ORDER BY _createdTime ASC,_id COLLATE BINARY ASC"
      });
      Delegate step = (Delegate)stepField.GetValue(reader), count = (Delegate)countField.GetValue(reader), columnBytes = (Delegate)bytesField.GetValue(reader);
      List<RowRecord> window = new List<RowRecord>(101);
      bool exhausted = false; int pageNumber = 0;
      try {
        while (!exhausted) {
          int queryBytes = 0;
          foreach (RowRecord previous in window) for (int c = 0; c < previous.Bytes.Length; c++) queryBytes += previous.Bytes[c];
          while (window.Count < 101) {
            int state = (int)step.DynamicInvoke(statement);
            if (state == Done) { exhausted = true; break; }
            if (state != Row) { Add("stream_step_error"); exhausted = true; break; }
            RowRecord record = ReadRow(statement, (int)count.DynamicInvoke(statement), columnBytes);
            window.Add(record);
            for (int c = 0; c < record.Bytes.Length; c++) queryBytes += record.Bytes[c];
            totalRows++;
          }
          if (window.Count == 0) break;
          pageNumber++; pages++;
          bool hasMore = window.Count == 101;
          int actualRows = Math.Min(100, window.Count);
          Dictionary<string, NativeConversationInfo> pageCache = new Dictionary<string, NativeConversationInfo>(StringComparer.Ordinal);
          string[] serialized = new string[actualRows];
          string lastTime = null, lastId = null;
          bool pageValid = true;
          for (int i = 0; i < actualRows; i++) {
            RowRecord record = window[i];
            ValidateRecord(record);
            try {
              object[] values = record.Values;
              object[] args = new object[] { values, pageCache, null, null };
              MethodInfo serialize = typeof(Sqlite3Mc).GetMethod("SerializeNativeMessageRow", BindingFlags.Instance | BindingFlags.NonPublic);
              serialized[i] = (string)serialize.Invoke(reader, args);
              lastTime = (string)args[2]; lastId = (string)args[3];
            } catch (Exception error) { pageValid = false; Add("adapter_" + SafeSymbol(Unwrap(error))); }
          }
          if (queryBytes > QueryBudget) queryOver++;
          if (pageValid) MeasureWire(pageNumber, serialized, hasMore, lastTime, lastId);
          if (pageNumber % 1000 == 0) Console.WriteLine("AUDIT_PROGRESS|rows=" + totalRows + "|pages=" + pageNumber);
          window.RemoveRange(0, actualRows); // Keep lookahead as the next page's first row.
          if (!hasMore) exhausted = true;
        }
      } finally {
        FieldInfo finalizeField = typeof(Sqlite3Mc).GetField("finalize", BindingFlags.Instance | BindingFlags.NonPublic);
        if (finalizeField != null) ((Delegate)finalizeField.GetValue(reader)).DynamicInvoke(statement);
        MethodInfo clear = typeof(Sqlite3Mc).GetMethod("ClearAuthorizer", BindingFlags.Instance | BindingFlags.NonPublic);
        if (clear != null) clear.Invoke(reader, null);
      }
      ReadEmptySenderAggregate();
    }
    void ReadEmptySenderAggregate() {
      setAuthorizer.Invoke(reader, new object[] { new Dictionary<string, string[]> {
        { "_message", new string[] { "_from", "_fromType", "_toType", "_contentType", "_text" } }
      } });
      try {
        List<object[]> rows = (List<object[]>)typeof(Sqlite3Mc).GetMethod("QueryLimited", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(reader, new object[] {
          "SELECT typeof(_fromType),CASE WHEN typeof(_fromType)='integer' THEN _fromType ELSE NULL END,typeof(_toType),CASE WHEN typeof(_toType)='integer' THEN _toType ELSE NULL END,typeof(_contentType),CASE WHEN typeof(_contentType)='integer' THEN _contentType ELSE NULL END,COUNT(*),SUM(CASE WHEN _text IS NULL THEN 1 ELSE 0 END),SUM(CASE WHEN _text='' THEN 1 ELSE 0 END) FROM _message WHERE _from='' GROUP BY typeof(_fromType),_fromType,typeof(_toType),_toType,typeof(_contentType),_contentType",
          128 * 1024, new object[0]
        });
        foreach (object[] row in rows) {
          string line = "EMPTY_SENDER_DETAIL|fromType=" + SqlType(row[0]) + ":" + SqlValue(row[1]) +
            "|toType=" + SqlType(row[2]) + ":" + SqlValue(row[3]) + "|contentType=" + SqlType(row[4]) + ":" + SqlValue(row[5]) +
            "|count=" + SqlValue(row[6]) + "|textNull=" + SqlValue(row[7]) + "|textEmpty=" + SqlValue(row[8]);
          Console.WriteLine(line);
        }
      } finally {
        MethodInfo clear = typeof(Sqlite3Mc).GetMethod("ClearAuthorizer", BindingFlags.Instance | BindingFlags.NonPublic);
        if (clear != null) clear.Invoke(reader, null);
      }
    }
    static string SqlType(object value) { return value is string && System.Text.RegularExpressions.Regex.IsMatch((string)value, "^[A-Za-z]+$") ? (string)value : "other"; }
    static string SqlValue(object value) { return value == null ? "null" : value is long ? ((long)value).ToString(System.Globalization.CultureInfo.InvariantCulture) : "other"; }
    RowRecord ReadRow(IntPtr statement, int columns, Delegate columnBytes) {
      RowRecord row = new RowRecord { Values = new object[columns], Bytes = new int[columns] };
      int total = 0;
      for (int i = 0; i < columns; i++) {
        int bytes = (int)columnBytes.DynamicInvoke(statement, i);
        row.Bytes[i] = Math.Max(0, bytes);
        try {
          object[] args = new object[] { statement, i, total, Int32.MaxValue };
          row.Values[i] = column.Invoke(reader, args); total = (int)args[2];
        } catch (Exception error) { row.DecodeFailed = true; Add("decode_" + SafeSymbol(Unwrap(error))); }
      }
      return row;
    }
    void ValidateRecord(RowRecord row) {
      if (row.DecodeFailed) Add("row_decode_failed");
      if (row.Values.Length != 7) { Add("wrong_column_count"); return; }
      ValidateText(row.Values[0], row.Bytes[0], "id", true, 512);
      ValidateSender(row.Values[1]);
      ValidateInteger(row.Values[2], "toType", true, false);
      ValidateInteger(row.Values[3], "createdTime", false, false);
      ValidateText(row.Values[4], row.Bytes[4], "chatId", true, 512);
      ValidateText(row.Values[5], row.Bytes[5], "text", true, Int32.MaxValue);
      ValidateInteger(row.Values[6], "contentType", true, true);
      string contentKey = row.Values[6] is long ? ((long)row.Values[6]).ToString(System.Globalization.CultureInfo.InvariantCulture) : row.Values[6] == null ? "null" : "other";
      string toTypeKey = row.Values[2] is long ? ((long)row.Values[2]).ToString(System.Globalization.CultureInfo.InvariantCulture) : row.Values[2] == null ? "null" : "other";
      Increment(contentTypes, contentKey); Increment(toTypes, toTypeKey);
      if (row.Values[1] is string && ((string)row.Values[1]).Length == 0) {
        senderEmpty++; Increment(senderEmptyContexts, "toType=" + toTypeKey + "|contentType=" + contentKey);
      }
      string textKey = row.Values[5] == null ? "null" : row.Values[5] is string && ((string)row.Values[5]).Length == 0 ? "empty" : row.Values[5] is string ? "nonempty" : "other";
      Increment(textContexts, "contentType=" + contentKey + "|text=" + textKey);
      if (row.Values[5] is string) {
        string text = (string)row.Values[5]; int chars = text.Length; long bytes = row.Bytes[5];
        if (bytes > textMaxBytes) textMaxBytes = bytes; if (chars > textMaxChars) textMaxChars = chars;
        if (chars > 16384) textOver16384++;
        if (String.IsNullOrWhiteSpace(text) && chars > 0) Add("text_whitespace");
        if (text.IndexOf('\0') >= 0) Add("text_nul");
      }
      if (row.Values[1] is string && ((string)row.Values[1]).Length > senderMaxChars) senderMaxChars = ((string)row.Values[1]).Length;
      if (row.Values[0] is string && ((string)row.Values[0]).Length > idMaxChars) idMaxChars = ((string)row.Values[0]).Length;
      if (row.Values[4] is string && ((string)row.Values[4]).Length > chatMaxChars) chatMaxChars = ((string)row.Values[4]).Length;
      if (row.Values[1] is string && ((string)row.Values[1]).Length > 0 && String.IsNullOrWhiteSpace((string)row.Values[1])) Add("sender_whitespace");
      if (row.Values[0] is string && ((string)row.Values[0]).IndexOf('\0') >= 0) Add("id_nul");
      if (row.Values[1] is string && ((string)row.Values[1]).IndexOf('\0') >= 0) Add("sender_nul");
      if (row.Values[4] is string && ((string)row.Values[4]).IndexOf('\0') >= 0) Add("chatId_nul");
    }
    void ValidateText(object value, int bytes, string name, bool required, int maxChars) {
      if (value == null) { if (required) Add(name + "_null"); return; }
      if (!(value is string)) { Add(name + "_non_text"); return; }
      string text = (string)value;
      if (text.Length == 0) { Add(name + "_empty"); return; }
      if (text.Length > maxChars) Add(name + "_over_" + maxChars.ToString(System.Globalization.CultureInfo.InvariantCulture));
      if (text.IndexOf('\0') >= 0) Add(name + "_nul");
    }
    void ValidateSender(object value) {
      if (value == null) { Add("sender_null"); return; }
      if (!(value is string)) { Add("sender_non_text"); return; }
      string sender = (string)value;
      if (sender.Length > 512) Add("sender_over_512");
    }
    void ValidateInteger(object value, string name, bool nullable, bool int32) {
      if (value == null) { if (!nullable) Add(name + "_null"); return; }
      if (!(value is long)) { Add(name + "_non_integer"); return; }
      if (int32 && ((long)value < Int32.MinValue || (long)value > Int32.MaxValue)) Add(name + "_outside_int32");
    }
    void MeasureWire(int pageNumber, string[] rows, bool hasMore, string lastTime, string lastId) {
      try {
        object[] parsed = new object[rows.Length];
        for (int i = 0; i < rows.Length; i++) {
          int bytes = Utf8.GetByteCount(rows[i]); if (bytes > RowBudget) rowOver++;
          parsed[i] = Json.DeserializeObject(rows[i]);
        }
        string digest;
        using (SHA256 sha = SHA256.Create()) {
          byte[] input = Utf8.GetBytes(String.Join("\n", rows));
          byte[] result = sha.ComputeHash(input); Array.Clear(input, 0, input.Length);
          digest = BitConverter.ToString(result).Replace("-", "").ToLowerInvariant(); Array.Clear(result, 0, result.Length);
        }
        Dictionary<string, object> cursor = new Dictionary<string, object> {
          { "createdTime", lastTime }, { "id", lastId }
        };
        Dictionary<string, object> frame = new Dictionary<string, object> {
          { "version", 1 }, { "requestId", "0123456789abcdef0123456789abcdef" }, { "sequence", pageNumber + 3 }, { "type", "page" },
          { "pageNumber", pageNumber }, { "batchDigest", digest }, { "rows", parsed },
          { "lastCursor", rows.Length == 0 ? null : cursor }, { "hasMore", hasMore }
        };
        byte[] body = Utf8.GetBytes(Json.Serialize(frame));
        if (body.Length > FrameBudget) frameOver++;
        if (body.Length > frameMax) frameMax = body.Length;
        Array.Clear(body, 0, body.Length);
      } catch (Exception error) { Add("wire_" + SafeSymbol(Unwrap(error))); }
    }
  }
  static void Add(string code) { Increment(issues, code); }
  static void Increment(Dictionary<string, long> values, string code) { long count; values.TryGetValue(code, out count); values[code] = count + 1; }
  static Exception Unwrap(Exception error) { return error is TargetInvocationException && error.InnerException != null ? error.InnerException : error; }
  static string SafeSymbol(Exception error) {
    string value = error.Message;
    if (String.IsNullOrEmpty(value) || value.Length > 80) return "unavailable";
    foreach (char c in value) if (!(Char.IsLetterOrDigit(c) || c == '_' || c == '-')) return "unavailable";
    return value;
  }
  static void PrintSummary() {
    long adapterFailures = 0;
    foreach (KeyValuePair<string, long> item in issues) if (item.Key.StartsWith("adapter_", StringComparison.Ordinal)) adapterFailures += item.Value;
    Console.WriteLine("AUDIT_SUMMARY|rows=" + totalRows + "|pages=" + pages + "|adapter_failures=" + adapterFailures + "|empty_senders=" + senderEmpty + "|query_over_128k=" + queryOver +
      "|row_over_128k=" + rowOver + "|frame_over_1m=" + frameOver + "|frame_max=" + frameMax +
      "|text_max_bytes=" + textMaxBytes + "|text_max_utf16=" + textMaxChars + "|text_over_16384=" + textOver16384 +
      "|sender_max_utf16=" + senderMaxChars + "|id_max_utf16=" + idMaxChars + "|chat_max_utf16=" + chatMaxChars);
    foreach (KeyValuePair<string, long> item in issues) Console.WriteLine("ISSUE|" + item.Key + "|" + item.Value);
    foreach (KeyValuePair<string, long> item in contentTypes) Console.WriteLine("CONTENT_TYPE|" + item.Key + "|" + item.Value);
    foreach (KeyValuePair<string, long> item in toTypes) Console.WriteLine("TO_TYPE|" + item.Key + "|" + item.Value);
    foreach (KeyValuePair<string, long> item in senderEmptyContexts) Console.WriteLine("EMPTY_SENDER_CONTEXT|" + item.Key + "|" + item.Value);
    foreach (KeyValuePair<string, long> item in textContexts) Console.WriteLine("TEXT_CONTEXT|" + item.Key + "|" + item.Value);
  }
}
