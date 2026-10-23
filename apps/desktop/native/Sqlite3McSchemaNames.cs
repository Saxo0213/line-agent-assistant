using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;

internal sealed class SchemaNameColumn { internal string Name; internal string Type; internal long Pk; }
internal sealed class SchemaNameTable { internal string Name; internal List<SchemaNameColumn> Columns = new List<SchemaNameColumn>(); }
internal sealed class SchemaNameIndex { internal string Name; internal string Table; internal List<string> Columns = new List<string>(); }
internal sealed class SchemaNames {
  internal List<SchemaNameTable> Tables = new List<SchemaNameTable>();
  internal List<SchemaNameIndex> Indexes = new List<SchemaNameIndex>();

  internal string Render(string lineBuild) {
    List<object> tables = new List<object>(), indexes = new List<object>();
    foreach (SchemaNameTable table in Tables) {
      List<object> columns = new List<object>();
      foreach (SchemaNameColumn column in table.Columns)
        columns.Add(new Dictionary<string, object> { { "name", column.Name }, { "type", column.Type }, { "pk", column.Pk } });
      tables.Add(new Dictionary<string, object> { { "name", table.Name }, { "columns", columns } });
    }
    foreach (SchemaNameIndex index in Indexes)
      indexes.Add(new Dictionary<string, object> { { "name", index.Name }, { "table", index.Table }, { "columns", index.Columns } });
    Dictionary<string, object> document = new Dictionary<string, object> {
      { "format", 1 }, { "lineBuild", lineBuild }, { "tables", tables }, { "indexes", indexes } };
    return new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue }.Serialize(document) + "\n";
  }
}

// Schema-names-only reading for the standalone OfficialSchemaNamesTool. A restrictive authorizer allows nothing but
// sqlite_master columns type/name/tbl_name and the table_info / index_info pragmas of one named object at a time.
// User-table reads, the sql column and every function (count included) are denied.
internal sealed partial class Sqlite3Mc {
  internal const int SchemaNamesMaxObjects = 4096, SchemaNamesMaxColumns = 512, SchemaNamesMaxNameLength = 128;
  string schemaNamesPragma, schemaNamesTarget;

  void SetSchemaNamesAuthorizer() {
    authorizer = delegate(IntPtr user, int action, IntPtr arg1, IntPtr arg2, IntPtr database, IntPtr trigger) {
      if (trigger != IntPtr.Zero) return AuthorizerDeny;
      if (action == 19) {
        string database0 = Text(database);
        return schemaNamesPragma != null && (database0 == "" || database0 == "main") &&
          String.Equals(Text(arg1), schemaNamesPragma, StringComparison.Ordinal) &&
          String.Equals(Text(arg2), schemaNamesTarget, StringComparison.Ordinal) ? 0 : AuthorizerDeny;
      }
      if (action == AuthorizerSelect) return 0;
      if (action == AuthorizerRead && Text(database) == "main" &&
          (Text(arg1) == "sqlite_master" || Text(arg1) == "sqlite_schema")) {
        string column = Text(arg2);
        return column == "type" || column == "name" || column == "tbl_name" ? 0 : AuthorizerDeny;
      }
      return AuthorizerDeny;
    };
    Check(setAuthorizer(db, authorizer, IntPtr.Zero));
  }

  static string SchemaName(object value) {
    string text = value as string;
    if (String.IsNullOrEmpty(text) || text.Length > SchemaNamesMaxNameLength || text.IndexOf('"') >= 0 || text.IndexOf('\0') >= 0)
      throw new InvalidDataException("schema_bound");
    return text;
  }

  List<object[]> SchemaNamesRows(string sql, string pragma, string target, int columnCount, int maximumRows) {
    schemaNamesPragma = pragma; schemaNamesTarget = target;
    IntPtr statement = PrepareStatement(sql);
    try {
      List<object[]> rows = new List<object[]>();
      int totalBytes = 0;
      for (;;) {
        int state = step(statement);
        if (state == Done) break;
        if (state != Row) throw Failure("DATABASE_READ_FAILED", state);
        if (rows.Count >= maximumRows) throw new InvalidDataException("schema_bound");
        object[] row = new object[columnCount];
        for (int i = 0; i < columnCount; i++) row[i] = Column(statement, i, ref totalBytes, 64 * 1024);
        rows.Add(row);
      }
      return rows;
    } finally { finalize(statement); schemaNamesPragma = null; schemaNamesTarget = null; }
  }

  internal SchemaNames ReadSchemaNames() {
    SetSchemaNamesAuthorizer();
    try {
      SchemaNames result = new SchemaNames();
      List<object[]> master = SchemaNamesRows("SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name",
        null, null, 3, SchemaNamesMaxObjects);
      List<string[]> indexes = new List<string[]>();
      foreach (object[] row in master) {
        string type = row[0] as string, name = SchemaName(row[1]);
        string owner = row[2] == null ? null : SchemaName(row[2]);
        if (type == "table") {
          SchemaNameTable table = new SchemaNameTable { Name = name };
          foreach (object[] column in SchemaNamesRows("PRAGMA table_info(\"" + name + "\")", "table_info", name, 6, SchemaNamesMaxColumns)) {
            // table_info: cid, name, type, notnull, dflt_value, pk. Only name, declared type and pk are kept.
            string declared = column[2] as string ?? "";
            if (declared.Length > SchemaNamesMaxNameLength || !(column[5] is long)) throw new InvalidDataException("schema_bound");
            table.Columns.Add(new SchemaNameColumn { Name = SchemaName(column[1]), Type = declared, Pk = (long)column[5] });
          }
          result.Tables.Add(table);
        } else if (type == "index") indexes.Add(new string[] { name, owner });
        else throw new InvalidDataException("schema_bound");
      }
      foreach (string[] entry in indexes) {
        SchemaNameIndex index = new SchemaNameIndex { Name = entry[0], Table = entry[1] };
        foreach (object[] column in SchemaNamesRows("PRAGMA index_info(\"" + entry[0] + "\")", "index_info", entry[0], 3, SchemaNamesMaxColumns))
          index.Columns.Add(column[2] == null ? "" : SchemaName(column[2])); // expression indexes report a NULL name
        result.Indexes.Add(index);
      }
      return result;
    } finally { ClearAuthorizer(); }
  }

#if SQLITE_FIXTURE_WRITER
  internal void FixtureSchemaExecute(string sql) { RunStatement(sql); }

  // Fixture-only: true when the schema-names authorizer rejects the statement.
  internal bool SchemaNamesDenies(string sql) {
    SetSchemaNamesAuthorizer();
    try { SchemaNamesRows(sql, null, null, 1, 8); return false; }
    catch (InvalidOperationException) { return true; }
    finally { ClearAuthorizer(); }
  }
#endif
}
