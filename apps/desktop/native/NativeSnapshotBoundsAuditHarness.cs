using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Threading;

// Bounded follow-up diagnostic for an already-created encrypted fixed copy.
// It emits only timestamp aggregates and SQLite diagnostic stage/codes, never
// keys, IDs, paths, SQL, or source values.
internal static class NativeSnapshotBoundsAuditHarness {
  const long JavaScriptDateMin = -8640000000000000L;
  const long JavaScriptDateMax = 8640000000000000L;
  static int Main() {
    string expectedMid = Console.In.ReadLine();
    string copyDirectory = Console.In.ReadLine();
    byte[] key = null;
    string stage = "input";
    try {
      if (String.IsNullOrEmpty(expectedMid) || expectedMid.Length > 200 || expectedMid.IndexOf('\0') >= 0 || String.IsNullOrEmpty(copyDirectory))
        throw new InvalidDataException("audit_input_invalid");
      string fullCopy = Path.GetFullPath(copyDirectory);
      string tempRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
      if (!fullCopy.StartsWith(tempRoot, StringComparison.OrdinalIgnoreCase) ||
          !Path.GetFileName(fullCopy).StartsWith("linejs-native-audit-", StringComparison.Ordinal) ||
          (File.GetAttributes(fullCopy) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("audit_copy_invalid");

      stage = "inventory";
      string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
      OfficialSourceInventoryResult source = OfficialSourceInventory.Inspect(Path.Combine(localAppData, "LINE"),
        OfficialSourceInventory.SupportedBuildVersion, OfficialSourceInventory.SupportedBuildBytes,
        OfficialSourceInventory.SupportedBuildSha256, new WindowsOfficialSourceInventoryEnvironment());
      key = OfficialSourceKeyProbe.Find(source, new WindowsOfficialSourceInventoryEnvironment(), DateTime.UtcNow.AddMinutes(30), CancellationToken.None, null);
      source = null; // Key probing closes all official-source handles before this offline copy is opened.

      stage = "copy_open";
      using (Sqlite3Mc reader = (Sqlite3Mc)Activator.CreateInstance(typeof(Sqlite3Mc),
        BindingFlags.Instance | BindingFlags.NonPublic, null,
        new object[] { Path.Combine(fullCopy, "snapshot.edb"), key, true, false, true }, CultureInfo.InvariantCulture)) {
        stage = "schema";
        reader.VerifySchemaReadable();
        stage = "authorizer";
        MethodInfo authorizerMethod = typeof(Sqlite3Mc).GetMethod("SetReadAuthorizer", BindingFlags.Instance | BindingFlags.NonPublic);
        MethodInfo queryMethod = typeof(Sqlite3Mc).GetMethod("QueryLimited", BindingFlags.Instance | BindingFlags.NonPublic);
        if (authorizerMethod == null || queryMethod == null) throw new MissingMethodException("audit_query_unavailable");
        authorizerMethod.Invoke(reader, new object[] { new Dictionary<string, string[]> {
          { "_message", new string[] { "_createdTime" } }
        } });
        try {
          stage = "timestamp_min_query";
          List<object[]> lowRows = (List<object[]>)queryMethod.Invoke(reader, new object[] {
            "SELECT _createdTime FROM _message ORDER BY _createdTime ASC LIMIT 1", 4096, new object[0]
          });
          stage = "timestamp_max_query";
          List<object[]> highRows = (List<object[]>)queryMethod.Invoke(reader, new object[] {
            "SELECT _createdTime FROM _message ORDER BY _createdTime DESC LIMIT 1", 4096, new object[0]
          });
          stage = "timestamp_decode";
          if (lowRows.Count != 1 || highRows.Count != 1 || lowRows[0].Length != 1 || highRows[0].Length != 1 ||
              !(lowRows[0][0] is long) || !(highRows[0][0] is long))
            throw new InvalidDataException("audit_timestamp_aggregate_invalid");
          long min = (long)lowRows[0][0], max = (long)highRows[0][0];
          bool allWithinDate = min >= JavaScriptDateMin && max <= JavaScriptDateMax;
          bool allWithinSafeInteger = min >= -9007199254740991L && max <= 9007199254740991L;
          Console.WriteLine("TIMESTAMP_RANGE|minimum_ms=" + min.ToString(CultureInfo.InvariantCulture) + "|maximum_ms=" + max.ToString(CultureInfo.InvariantCulture) +
            "|all_within_js_date_range=" + (allWithinDate ? "1" : "0") + "|all_within_js_safe_integer=" + (allWithinSafeInteger ? "1" : "0"));
        } finally {
          MethodInfo clear = typeof(Sqlite3Mc).GetMethod("ClearAuthorizer", BindingFlags.Instance | BindingFlags.NonPublic);
          if (clear != null) clear.Invoke(reader, null);
        }
        stage = "snapshot_bounds";
        object[] bounds = reader.ReadMessageSnapshotBounds();
        Console.WriteLine("SNAPSHOT_BOUNDS|count=" + Convert.ToString(bounds[0], CultureInfo.InvariantCulture) + "|key_and_unique_id_counts_match=1");
      }
      return 0;
    } catch (Exception error) {
      Exception root = error is TargetInvocationException && error.InnerException != null ? error.InnerException : error;
      SqliteDiagnosticException diagnostic = root as SqliteDiagnosticException;
      Console.WriteLine("AUDIT|FAIL|stage=" + stage + "|type=" + root.GetType().Name + "|symbol=" + SafeSymbol(root) +
        "|diagnostic=" + (diagnostic == null ? "none" : SafeDiagnostic(diagnostic.Summary)));
      return 1;
    } finally { if (key != null) Array.Clear(key, 0, key.Length); }
  }
  static string SafeSymbol(Exception error) {
    string value = error.Message;
    if (String.IsNullOrEmpty(value) || value.Length > 80) return "unavailable";
    foreach (char c in value) if (!(Char.IsLetterOrDigit(c) || c == '_' || c == '-')) return "unavailable";
    return value;
  }
  static string SafeDiagnostic(string value) {
    if (String.IsNullOrEmpty(value) || value.Length > 256) return "none";
    foreach (char c in value) if (!(Char.IsLetterOrDigit(c) || c == '_' || c == '-' || c == '=' || c == '|')) return "none";
    return value;
  }
}
