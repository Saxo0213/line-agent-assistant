using System;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Standalone developer tool: prints the table and column names (declared types, primary-key flags) and index
// columns of the official LINE database, never any row value. It opens the live database exactly as the direct
// monitor does (OfficialSourceInventory, OfficialSourceKeyProbe, HoldExistingShm, Sqlite3Mc.OpenReadOnly) and
// reads through a names-only authorizer. It writes nothing but stdout/stderr and prints no path, key, MID or count.
internal static class OfficialSchemaNamesTool {
  internal static int Main(string[] args) {
    if (args.Length != 0) return Fail("command_invalid");
    try {
      using (CancellationTokenSource cancellation = new CancellationTokenSource()) {
        OfficialSourceInventoryResult inventory = ExternalReaderBridge.ReadOfficialSourceInventory();
        byte[] key = OfficialSourceKeyProbe.Find(inventory, new WindowsOfficialSourceInventoryEnvironment(),
          DateTime.UtcNow.AddMinutes(2), cancellation.Token, null);
        if (key == null || key.Length != 32) return Fail("key_unavailable");
        SchemaNames names;
        using (SafeFileHandle shmGuard = ExternalReaderBridge.HoldExistingShm(inventory))
        using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(inventory.DatabasePath, key)) names = reader.ReadSchemaNames();
        Console.Out.Write(names.Render(inventory.BuildVersion));
        Console.Out.Flush();
        return 0;
      }
    } catch (InvalidDataException error) { return Fail(SafeCode(error.Message, "schema_unavailable")); }
    catch { return Fail("schema_unavailable"); }
  }

  static int Fail(string code) { Console.Error.WriteLine("ERROR|" + code); return 1; }

  // Only fixed lowercase codes are ever printed; anything else collapses to the fallback.
  static string SafeCode(string message, string fallback) {
    if (message == null || message.Length == 0 || message.Length > 40) return fallback;
    foreach (char c in message) if (!((c >= 'a' && c <= 'z') || c == '_')) return fallback;
    return message;
  }
}
