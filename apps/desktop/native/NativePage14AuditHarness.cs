using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading;

// Temporary bounded diagnostic for the first failing production page.
internal static class NativePage14AuditHarness {
  static int Main() {
    string expectedMid = Console.In.ReadLine(), copyDirectory = Console.In.ReadLine();
    byte[] key = null;
    try {
      OfficialSourceInventoryResult source = OfficialSourceInventory.Inspect(
        System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LINE"),
        OfficialSourceInventory.SupportedBuildVersion, OfficialSourceInventory.SupportedBuildBytes,
        OfficialSourceInventory.SupportedBuildSha256, new WindowsOfficialSourceInventoryEnvironment());
      key = OfficialSourceKeyProbe.Find(source, new WindowsOfficialSourceInventoryEnvironment(), DateTime.UtcNow.AddMinutes(30), CancellationToken.None, null);
      source = null;
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(System.IO.Path.Combine(copyDirectory, "snapshot.edb"), key)) {
        Type type = typeof(Sqlite3Mc); BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
        type.GetMethod("SetReadAuthorizer", flags).Invoke(reader, new object[] { new Dictionary<string, string[]> {
          { "_message", new string[] { "_id", "_from", "_toType", "_createdTime", "_chatId", "_text", "_contentType" } }
        } });
        object rowsObject = type.GetMethod("QueryLimited", flags).Invoke(reader, new object[] {
          "SELECT _id,_from,_toType,_createdTime,_chatId,_text,_contentType FROM _message ORDER BY _createdTime ASC,_id COLLATE BINARY ASC LIMIT 101 OFFSET 1300",
          128 * 1024, new object[0]
        });
        List<object[]> rows = (List<object[]>)rowsObject;
        Dictionary<string, long> issues = new Dictionary<string, long>(StringComparer.Ordinal);
        Dictionary<string, int> firstOffsets = new Dictionary<string, int>(StringComparer.Ordinal);
        Dictionary<string, long> contentTypes = new Dictionary<string, long>(StringComparer.Ordinal);
        for (int i = 0; i < rows.Count; i++) {
          object[] row = rows[i];
          Check(issues, firstOffsets, i, "id_shape", row[0] is string && ((string)row[0]).Length > 0 && ((string)row[0]).Length <= 512);
          Check(issues, firstOffsets, i, "sender_shape", row[1] is string && ((string)row[1]).Length > 0);
          Check(issues, firstOffsets, i, "toType_shape", row[2] == null || row[2] is long);
          Check(issues, firstOffsets, i, "createdTime_shape", row[3] is long);
          Check(issues, firstOffsets, i, "chatId_shape", row[4] is string && ((string)row[4]).Length > 0 && ((string)row[4]).Length <= 512);
          Check(issues, firstOffsets, i, "text_shape", row[5] == null || row[5] is string);
          bool contentTypeValid = row[6] == null || row[6] is long;
          if (contentTypeValid && row[6] is long) contentTypeValid = (long)row[6] >= Int32.MinValue && (long)row[6] <= Int32.MaxValue;
          Check(issues, firstOffsets, i, "contentType_shape", contentTypeValid);
          if (row[1] is string && ((string)row[1]).Length == 0) Count(issues, firstOffsets, "sender_empty", i);
          if (row[4] is string && ((string)row[4]).Length == 0) Count(issues, firstOffsets, "chatId_empty", i);
          if (row[0] is string && ((string)row[0]).Length == 0) Count(issues, firstOffsets, "id_empty", i);
          if (row[6] is long) Add(contentTypes, ((long)row[6]).ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        Console.WriteLine("PAGE14_SLICE|rows=" + rows.Count);
        foreach (KeyValuePair<string, long> item in issues) Console.WriteLine("FIELD|" + item.Key + "|count=" + item.Value + "|first_row=" + (1301 + firstOffsets[item.Key]));
        foreach (KeyValuePair<string, long> item in contentTypes) Console.WriteLine("CONTENT_TYPE|" + item.Key + "|count=" + item.Value);
      }
      return 0;
    } catch (Exception error) {
      Exception actual = error is TargetInvocationException && error.InnerException != null ? error.InnerException : error;
      Console.WriteLine("SLICE|FAIL|type=" + actual.GetType().Name + "|symbol=" + Safe(actual.Message));
      return 1;
    } finally { if (key != null) Array.Clear(key, 0, key.Length); }
  }
  static void Check(Dictionary<string,long> issues, Dictionary<string,int> offsets, int ordinal, string code, bool valid) { if (!valid) Count(issues, offsets, code, ordinal); }
  static void Count(Dictionary<string,long> issues, Dictionary<string,int> offsets, string code, int ordinal) {
    long count; issues.TryGetValue(code, out count); issues[code] = count + 1;
    if (!offsets.ContainsKey(code)) offsets[code] = ordinal;
  }
  static void Add(Dictionary<string,long> values, string code) { long count; values.TryGetValue(code,out count); values[code]=count+1; }
  static string Safe(string value) { return value != null && value.Length < 80 && System.Text.RegularExpressions.Regex.IsMatch(value, "^[A-Za-z0-9_-]+$") ? value : "unavailable"; }
}
