using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

// Fixture-only acceptance harness for the schema-names reader (Sqlite3McSchemaNames.cs). It only creates a synthetic
// encrypted database under the given temp root; it never discovers LINE paths or processes.
internal static class OfficialSchemaNamesToolHarness {
  static readonly byte[] Key = Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");
  const string Marker = "UNIQUE-CELL-MARKER-7f3a91c2";

  static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

  static int Main(string[] args) {
    if (args.Length != 2 || args[0] != "schema-names") return 2;
    try {
      Directory.CreateDirectory(args[1]);
      string path = Path.Combine(Path.GetFullPath(args[1]), "fixture.edb");
      using (Sqlite3Mc w = Sqlite3Mc.OpenFixtureWriter(path, Key)) {
        w.FixtureSchemaExecute("CREATE TABLE _message (_id TEXT NOT NULL, _createdTime INTEGER NOT NULL, _readCount INTEGER, _text TEXT, _blob BLOB, PRIMARY KEY (_id, _createdTime))");
        w.FixtureSchemaExecute("CREATE TABLE _chat (_chatId TEXT PRIMARY KEY, _title)");
        w.FixtureSchemaExecute("CREATE INDEX idx_message_time ON _message (_createdTime, _readCount)");
        w.FixtureSchemaExecute("INSERT INTO _message VALUES ('" + Marker + "', 5, 0, '" + Marker + "', X'00')");
        w.FixtureSchemaExecute("INSERT INTO _chat VALUES ('" + Marker + "', '" + Marker + "')");
      }
      string output;
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(path, Key)) {
        output = reader.ReadSchemaNames().Render("fixture-build");
        Check(output.IndexOf(Marker, StringComparison.Ordinal) < 0, "marker_in_output");
        Check(output.IndexOf(path, StringComparison.OrdinalIgnoreCase) < 0 && output.IndexOf("fixture.edb", StringComparison.OrdinalIgnoreCase) < 0, "path_in_output");
        Check(reader.SchemaNamesDenies("SELECT _text FROM _message"), "user_column_not_denied");
        Check(reader.SchemaNamesDenies("SELECT * FROM _message"), "user_star_not_denied");
        Check(reader.SchemaNamesDenies("SELECT count(*) FROM _message"), "count_not_denied");
        Check(reader.SchemaNamesDenies("SELECT count(*) FROM sqlite_master"), "count_master_not_denied");
        Check(reader.SchemaNamesDenies("SELECT sql FROM sqlite_master"), "sql_column_not_denied");
        Check(reader.SchemaNamesDenies("SELECT * FROM sqlite_master"), "master_star_not_denied");
        Check(reader.SchemaNamesDenies("PRAGMA table_info(\"_message\")"), "pragma_without_scope_not_denied");
        Check(reader.SchemaNamesDenies("PRAGMA user_version"), "other_pragma_not_denied");
        Check(!reader.SchemaNamesDenies("SELECT type, name, tbl_name FROM sqlite_master"), "allowed_master_denied");
      }
      JavaScriptSerializer json = new JavaScriptSerializer();
      Dictionary<string, object> document = json.Deserialize<Dictionary<string, object>>(output);
      Check(Convert.ToInt32(document["format"]) == 1 && (string)document["lineBuild"] == "fixture-build", "header");
      Check(document.Count == 4, "unexpected_keys");
      System.Collections.ArrayList tables = (System.Collections.ArrayList)document["tables"], indexes = (System.Collections.ArrayList)document["indexes"];
      Check(tables.Count == 2, "table_count");
      Dictionary<string, object> chat = (Dictionary<string, object>)tables[0], message = (Dictionary<string, object>)tables[1];
      Check((string)chat["name"] == "_chat" && (string)message["name"] == "_message", "table_names");
      string[] expected = { "_id|TEXT|1", "_createdTime|INTEGER|2", "_readCount|INTEGER|0", "_text|TEXT|0", "_blob|BLOB|0" };
      System.Collections.ArrayList columns = (System.Collections.ArrayList)message["columns"];
      Check(columns.Count == expected.Length, "column_count");
      for (int i = 0; i < expected.Length; i++) {
        Dictionary<string, object> c = (Dictionary<string, object>)columns[i];
        Check(c.Count == 3 && (string)c["name"] + "|" + (string)c["type"] + "|" + Convert.ToInt64(c["pk"]) == expected[i], "column_" + i);
      }
      System.Collections.ArrayList chatColumns = (System.Collections.ArrayList)chat["columns"];
      Dictionary<string, object> title = (Dictionary<string, object>)chatColumns[1];
      Check((string)title["type"] == "" && Convert.ToInt64(title["pk"]) == 0, "untyped_column");
      Check(Convert.ToInt64(((Dictionary<string, object>)chatColumns[0])["pk"]) == 1, "chat_pk");
      Dictionary<string, object> index = null;
      foreach (object item in indexes) { Dictionary<string, object> candidate = (Dictionary<string, object>)item; if ((string)candidate["name"] == "idx_message_time") index = candidate; }
      Check(index != null && (string)index["table"] == "_message", "index_missing");
      System.Collections.ArrayList indexColumns = (System.Collections.ArrayList)index["columns"];
      Check(indexColumns.Count == 2 && (string)indexColumns[0] == "_createdTime" && (string)indexColumns[1] == "_readCount", "index_columns");
      Console.Out.WriteLine("PASS|schema-names");
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine("FAIL|schema-names|" + error.Message + "|" + error.StackTrace);
      return 1;
    }
  }
}
