using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

// Fixture-only acceptance harness for OfficialSnapshotTool (Track A rows A1-A5, A7-A9, A11-A13, A15).
// It only creates synthetic encrypted databases under the given temp root; it never discovers LINE paths or processes.
internal static class OfficialSnapshotToolHarness {
  static readonly byte[] Key = Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");
  static readonly byte[] Key2 = Encoding.ASCII.GetBytes("abcdef0123456789abcdef0123456789");
  static readonly byte[] Key3 = Encoding.ASCII.GetBytes("fedcba9876543210fedcba9876543210");
  const string Mid = "u1234567890abcdef1234567890abcdef";
  const string GroupMid = "c1234567890abcdef1234567890abcdef";
  const string OwnMid = "fixture-own-mid";
  static readonly string[] Forbidden = new string[] { "SENTINEL", Mid, GroupMid, OwnMid, "MSG-TEXT-1", "MISSING-ID", "0123456789abcdef0123456789abcdef", "abcdef0123456789abcdef0123456789", "fedcba9876543210fedcba9876543210", "p1234567890abcdef1234567890abcdef", "s1234567890abcdef1234567890abcdef", "m1234567890abcdef1234567890abcdef", "t1234567890abcdef1234567890abcdef" };
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue, RecursionLimit = 64 };
  static TextWriter realOut, realErr;
  static bool probeTouched;

  sealed class FakeBuildEnvironment : IOfficialSourceInventoryEnvironment, IOfficialExecutableInspector {
    internal string Version = "26.5.0.3975";
    const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    public string[] EnumerateDatabaseFiles(string directory) { return new string[0]; }
    public OfficialSourceFileIdentity InspectFile(string path, bool allowMissing) { return null; }
    public bool IsReparsePoint(string path) { return false; }
    public string HashFile(string path) { return Digest; }
    public int[] GetCandidateProcessIds() { return new int[0]; }
    public long GetMatchingLineProcessCreationTime(int processId, string executablePath) { return 0; }
    public string ReadFileVersion(string path) { return Version; }
  }

  static int Main(string[] args) {
    realOut = Console.Out; realErr = Console.Error;
    if (args.Length != 2) return 2;
    string scenario = args[0], root = Path.GetFullPath(args[1]);
    try {
      switch (scenario) {
        case "capture": Capture(root); break;
        case "candidate-build": CandidateBuild(root); break;
        case "capture-failure": CaptureFailure(root); break;
        case "capture-sides": CaptureSides(root); break;
        case "capture-side-failures": CaptureSideFailures(root); break;
        case "analyze": Analyze(root); break;
        case "analyze-failures": AnalyzeFailures(root); break;
        case "redaction": Redaction(root); break;
        case "lock": Lock(root); break;
        case "sandbox": Sandbox(root); break;
        case "correlate": Correlate(root); break;
        case "correlate-caps": CorrelateCaps(root); break;
        default: return 2;
      }
      realOut.WriteLine("PASS|" + scenario);
      return 0;
    } catch (Exception error) {
      Console.SetOut(realOut); Console.SetError(realErr);
      Console.Error.WriteLine("FAIL|" + scenario + "|" + error.Message + "|" + error.StackTrace);
      return 1;
    }
  }

  static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

  // ---------------- encoders ----------------
  static string Q(string value) { return value == null ? "NULL" : "'" + value.Replace("'", "''") + "'"; }
  static string X(byte[] value) { return value == null ? "NULL" : "X'" + BitConverter.ToString(value).Replace("-", "") + "'"; }
  static string I(long? value) { return value.HasValue ? value.Value.ToString() : "NULL"; }
  static byte[] U(string text) { return Encoding.UTF8.GetBytes(text); }
  static byte[] Cat(params byte[][] parts) { MemoryStream m = new MemoryStream(); foreach (byte[] p in parts) m.Write(p, 0, p.Length); return m.ToArray(); }
  static byte[] Varint(ulong v) { List<byte> b = new List<byte>(); while (v >= 0x80) { b.Add((byte)(v | 0x80)); v >>= 7; } b.Add((byte)v); return b.ToArray(); }
  static byte[] Le(double d) { return BitConverter.GetBytes(d); }
  static byte[] Be(double d) { byte[] b = BitConverter.GetBytes(d); Array.Reverse(b); return b; }
  static byte[] BeInt(int v) { return new byte[] { (byte)(v >> 24), (byte)(v >> 16), (byte)(v >> 8), (byte)v }; }

  static byte[] CompactLocation(string title, string address, double lat, double lon) {
    return Cat(new byte[] { 0x18 }, Varint((ulong)U(title).Length), U(title), new byte[] { 0x18 }, Varint((ulong)U(address).Length), U(address),
      new byte[] { 0x17 }, Le(lat), new byte[] { 0x17 }, Le(lon), new byte[] { 0x00 });
  }
  static byte[] BinaryLocation(string title, string address, double lat, double lon) {
    return Cat(new byte[] { 11, 0, 1 }, BeInt(U(title).Length), U(title), new byte[] { 11, 0, 2 }, BeInt(U(address).Length), U(address),
      new byte[] { 4, 0, 3 }, Be(lat), new byte[] { 4, 0, 4 }, Be(lon), new byte[] { 0 });
  }
  static byte[] ProtoLocation(string title, string address, double lat, double lon) {
    return Cat(new byte[] { 0x0a }, Varint((ulong)U(title).Length), U(title), new byte[] { 0x12 }, Varint((ulong)U(address).Length), U(address),
      new byte[] { 0x19 }, Le(lat), new byte[] { 0x21 }, Le(lon));
  }
  static byte[] JsonLocation(string title, string address, double lat, double lon) {
    return U("{\"title\":\"" + title + "\",\"address\":\"" + address + "\",\"latitude\":" + lat.ToString("R", System.Globalization.CultureInfo.InvariantCulture) +
      ",\"longitude\":" + lon.ToString("R", System.Globalization.CultureInfo.InvariantCulture) + "}");
  }

  // ---------------- fixture ----------------
  static void Exec(Sqlite3Mc w, string sql) { w.FixtureExecute(sql); }

  static void Message(Sqlite3Mc w, string id, long created, string chat, long toType, long ct, string text, string metadata, byte[] location,
      string related, long? relType, byte[] contentInfo, byte[] eventInfo, byte[] reactions) {
    Exec(w, "INSERT INTO _message (_from,_to,_toType,_id,_createdTime,_text,_location,_hasContent,_contentType,_contentMetadata,_relatedMessageId,_messageRelationType,_type,_status,_chatId,_contentInfo,_eventInfo,_reactions) VALUES (" +
      Q(Mid) + "," + Q(chat) + "," + toType + "," + Q(id) + "," + created + "," + Q(text) + "," + X(location) + ",0," + ct + "," + Q(metadata) + "," + Q(related) + "," + I(relType) +
      ",1,2," + Q(chat) + "," + X(contentInfo) + "," + X(eventInfo) + "," + X(reactions) + ")");
  }

  static string BuildMain(string root) {
    string directory = Path.Combine(root, "LINE", "Data", "db");
    Directory.CreateDirectory(directory);
    string path = Path.Combine(directory, "messages.edb");
    using (Sqlite3Mc w = Sqlite3Mc.OpenFixtureWriter(path, Key)) {
      Exec(w, "CREATE TABLE _profile (_mid TEXT NOT NULL)");
      Exec(w, "INSERT INTO _profile(_mid) VALUES(" + Q(OwnMid) + ")");
      Exec(w, "CREATE TABLE _chat (_id TEXT NOT NULL, _midType INTEGER)");
      Exec(w, "INSERT INTO _chat(_id,_midType) VALUES(" + Q(Mid) + ",0),('u0000000000000000000000000000000a',0),('u0000000000000000000000000000000b',0),(" + Q(GroupMid) + ",2),('c0000000000000000000000000000000a',2)");
      Exec(w, "CREATE TABLE _contact (_mid TEXT NOT NULL, _displayName TEXT, _displayNameOverridden TEXT)");
      Exec(w, "INSERT INTO _contact(_mid,_displayName,_displayNameOverridden) VALUES(" + Q(Mid) + ",'SENTINELNAME-A',NULL),('u0000000000000000000000000000000a',NULL,NULL),('u0000000000000000000000000000000c',NULL,'SENTINELNAME-C')");
      Exec(w, "CREATE TABLE _groupChat (_chatMid TEXT, _chatName TEXT)");
      Exec(w, "INSERT INTO _groupChat(_chatMid,_chatName) VALUES(" + Q(GroupMid) + ",'SENTINELGROUPNAME'),('c0000000000000000000000000000000a',NULL)");
      Exec(w, "CREATE TABLE _squareChat (_squareChatMid TEXT, _squareMid TEXT, _name TEXT)");
      Exec(w, "CREATE TABLE _squareThread (_threadMid TEXT, _chatMid TEXT, _squareMid TEXT)");
      Exec(w, "CREATE TABLE _squareMember (_squareMemberMid TEXT, _squareMid TEXT, _displayName TEXT)");
      Exec(w, "CREATE TABLE _chatOption (_chatMid TEXT, _optionValue BLOB)");
      Exec(w, "INSERT INTO _chatOption(_chatMid,_optionValue) VALUES(" + Q(Mid) + ",X'410042')");
      Exec(w, "CREATE TABLE _unknownTable (_x TEXT)");
      Exec(w, "INSERT INTO _unknownTable(_x) VALUES('SENTINELUNKNOWN')");
      Exec(w, "CREATE TABLE _message (_from TEXT,_to TEXT,_toType INTEGER,_id TEXT NOT NULL,_createdTime INTEGER NOT NULL,_deliveredTime INTEGER,_text TEXT,_location BLOB,_hasContent INTEGER,_contentType INTEGER,_contentMetadata TEXT,_contentPreview BLOB,_sessionId TEXT,_chunks BLOB,_relatedMessageId TEXT,_messageRelationType INTEGER,_readCount INTEGER,_relatedMessageServiceCode INTEGER,_appExtensionType INTEGER,_reactions BLOB,_type INTEGER,_status INTEGER,_chatId TEXT NOT NULL,_reqSeqV2 INTEGER,_reqSeq INTEGER,_contentInfo BLOB,_eventInfo BLOB,_rev INTEGER,_errorCode INTEGER,_urlPreview BLOB,_hasUrlPreview INTEGER,_syncToken BLOB,_fromType INTEGER,_attribute BLOB,_flag INTEGER,_reactionStatus INTEGER)");
      byte[] location = CompactLocation("SENTINELTITLE", "SENTINELADDRESS", 35.123456, 139.654321);
      Message(w, "MSG-TEXT-1", 1000, Mid, 0, 0, "SENTINELTEXT one", null, null, null, null, null, null, null);
      Message(w, "MSG-STICKER", 1001, Mid, 0, 7, null, "{\"STKID\":\"100\",\"STKPKGID\":\"200\",\"STKVER\":\"3\",\"STKTXT\":\"SENTINELSTICKER\"}", null, null, null, null, null, null);
      Message(w, "MSG-LOC", 1002, Mid, 0, 15, null, null, location, "MSG-TEXT-1", 3, null, null, null);
      Message(w, "MSG-CONTACT", 1003, Mid, 0, 13, null, "{\"mid\":\"" + Mid + "\",\"displayName\":\"SENTINELDISPLAY\"}", null, null, null, null, null, null);
      Message(w, "MSG-IMAGE", 1004, Mid, 0, 1, null, null, null, "MISSING-ID", 3, U("{\"fileName\":\"SENTINELFILE.png\",\"size\":10}"), ProtoLocation("SENTINELEVENT", "SENTINELEVENTADDR", 1.5, 2.5), null);
      Message(w, "MSG-FLEX", 1005, Mid, 0, 22, null, "{\"ALT_TEXT\":\"SENTINELALT\"}", null, null, null, null, null, BinaryLocation("SENTINELREACT", "SENTINELREACTADDR", 3.5, 4.5));
      Message(w, "MSG-GROUP", 1006, GroupMid, 2, 0, "SENTINELTEXT group", null, null, null, null, null, null, null);
      string odd = "{\"STKID\":\"1\",\"" + Mid + "\":\"x\",\"" + new string('k', 65) + "\":2,\"has space\":true,\"日本\":null,\"nested\":{\"" + GroupMid + "\":1,\"ok_key\":\"v\"}}";
      odd = odd.Substring(0, odd.Length - 1) + ",\"p1234567890abcdef1234567890abcdef\":3,\"s1234567890abcdef1234567890abcdef\":4,\"m1234567890abcdef1234567890abcdef\":5,\"t1234567890abcdef1234567890abcdef\":6,\"0123456789abcdef0123456789abcdef\":7}";
      Message(w, "MSG-ODD", 1007, Mid, 0, 0, "SENTINELTEXT odd", odd, null, null, null, null, null, null);
      Message(w, "LJ1", 2001, Mid, 0, 15, null, null, JsonLocation("SENTINELJ1", "SENTINELADDRJ1", 35.111111, 139.111111), null, null, null, null, null);
      Message(w, "LJ2", 2002, Mid, 0, 15, null, null, JsonLocation("SENTINELJ2", "SENTINELADDRJ2", 35.222222, 139.222222), null, null, null, null, null);
      Message(w, "LT1", 2003, Mid, 0, 15, null, null, CompactLocation("SENTINELT1", "SENTINELADDRT1", 35.333333, 139.333333), null, null, null, null, null);
      Message(w, "LT2", 2004, Mid, 0, 15, null, null, CompactLocation("SENTINELT2", "SENTINELADDRT2", 35.444444, 139.444444), null, null, null, null, null);
      Message(w, "LB1", 2005, Mid, 0, 15, null, null, BinaryLocation("SENTINELB1", "SENTINELADDRB1", 35.555555, 139.555555), null, null, null, null, null);
      Message(w, "LP1", 2006, Mid, 0, 15, null, null, ProtoLocation("SENTINELP1", "SENTINELADDRP1", 35.666666, 139.666666), null, null, null, null, null);
    }
    return path;
  }

  static void BuildSide(string directory, string fileName, byte[] key, string table, string columns, string insert) {
    using (Sqlite3Mc w = Sqlite3Mc.OpenFixtureWriter(Path.Combine(directory, fileName), key)) {
      Exec(w, "CREATE TABLE " + table + " (" + columns + ")");
      Exec(w, insert);
    }
  }

  static string BuildAll(string root, bool sides) {
    string main = BuildMain(root);
    if (sides) {
      string dir = Path.GetDirectoryName(main);
      BuildSide(dir, "album_SENTINELFILENAME.edb", Key, "photos", "id INTEGER, path TEXT, meta TEXT", "INSERT INTO photos VALUES(1,'SENTINELPHOTO','{\"w\":1,\"" + Mid + "\":2,\"p1234567890abcdef1234567890abcdef\":3,\"s1234567890abcdef1234567890abcdef\":4,\"m1234567890abcdef1234567890abcdef\":5,\"t1234567890abcdef1234567890abcdef\":6,\"0123456789abcdef0123456789abcdef\":7}'),(2,'SENTINELPHOTO2',NULL)");
      BuildSide(dir, "chatstats.edb", Key2, "stats", "chat TEXT, total INTEGER, payload BLOB", "INSERT INTO stats VALUES('SENTINELCHAT',5," + X(U("{\"a\":1}")) + ")");
      BuildSide(dir, "keep.edb", Key3, "items", "k TEXT, v BLOB", "INSERT INTO items VALUES('SENTINELKEEP',X'0102')");
    }
    return main;
  }

  // ---------------- tool runner ----------------
  sealed class Result { internal int Code; internal string Out = "", Err = ""; }

  static void ResetHooks(string root, string main) {
    OfficialSnapshotTool.TestStorageRoot = Path.Combine(root, "captures");
    OfficialSnapshotTool.TestInventory = delegate { return Tuple.Create(main, (byte[])Key.Clone()); };
    OfficialSnapshotTool.TestSideProbe = delegate(byte[] page) { return LineEncryptedPageValidator.FirstPageValid(page, Key2) ? (byte[])Key2.Clone() : null; };
    OfficialSnapshotTool.TestFailure = delegate(Exception e) { if (Environment.GetEnvironmentVariable("OFFICIAL_SNAPSHOT_HARNESS_DEBUG") == "1") realErr.WriteLine("CAUSE|" + e); };
    OfficialSnapshotTool.TestStage = null; OfficialSnapshotTool.TestBuildDecision = null; OfficialSnapshotTool.TestCaptureCapBytes = 0; OfficialSnapshotTool.TestSideVerifyFails = null; OfficialSnapshotTool.TestKeyWrite = null;
  }
  static void ForbidProcessAccess() {
    probeTouched = false;
    OfficialSnapshotTool.TestInventory = delegate { probeTouched = true; throw new InvalidOperationException("process_access_forbidden"); };
    OfficialSnapshotTool.TestSideProbe = delegate(byte[] page) { probeTouched = true; throw new InvalidOperationException("process_access_forbidden"); };
  }

  static Result Run(string stdin, params string[] args) {
    StringWriter output = new StringWriter(), error = new StringWriter();
    Console.SetOut(output); Console.SetError(error);
    OfficialSnapshotTool.TestStdin = new MemoryStream(Encoding.UTF8.GetBytes(stdin ?? ""));
    int code;
    try { code = OfficialSnapshotTool.RunForTest(args); }
    finally { Console.SetOut(realOut); Console.SetError(realErr); }
    return new Result { Code = code, Out = output.ToString(), Err = error.ToString() };
  }
  static Result CaptureRun() { return Run(OwnMid + "\n", "capture"); }

  static string CapturedId(Result result) {
    Check(result.Code == 0, "capture_exit_" + result.Code + "_" + result.Err);
    string[] lines = result.Out.Trim().Split(new char[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
    Check(lines.Length == 1 && lines[0].Trim().StartsWith("CAPTURED|"), "capture_output_shape");
    return lines[0].Trim().Substring(9);
  }
  static string CaptureDir(string root, string id) { return Path.Combine(root, "captures", id); }
  static Dictionary<string, object> Obj(object o) { return (Dictionary<string, object>)o; }
  static object Get(object node, params string[] path) {
    foreach (string p in path) { Dictionary<string, object> d = node as Dictionary<string, object>; if (d == null || !d.ContainsKey(p)) return null; node = d[p]; }
    return node;
  }
  static long L(object o) { return Convert.ToInt64(o); }
  static Dictionary<string, object> ReadManifest(string dir) { return Obj(Json.DeserializeObject(File.ReadAllText(Path.Combine(dir, "manifest.json")))); }
  static object[] Arr(object o) { return (object[])o; }
  static string Sha(string path) { using (FileStream s = File.OpenRead(path)) using (SHA256 h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant(); }
  static void NoForbidden(string label, string text) {
    foreach (string f in Forbidden) Check(text.IndexOf(f, StringComparison.Ordinal) < 0, label + "_contains_" + (f.Length > 12 ? f.Substring(0, 12) : f));
  }
  static byte[] UnprotectFile(string path) { byte[] p = File.ReadAllBytes(path); try { return NativeCurrentUserProtection.Unprotect(p); } finally { Array.Clear(p, 0, p.Length); } }
  static bool Same(byte[] a, byte[] b) { if (a.Length != b.Length) return false; int d = 0; for (int i = 0; i < a.Length; i++) d |= a[i] ^ b[i]; return d == 0; }
  static List<string> Work(string dir) { return new List<string>(Directory.GetDirectories(dir, "work-*")); }

  // ---------------- A1 ----------------
  static void Capture(string root) {
    string main = BuildAll(root, false); ResetHooks(root, main);
    Result result = CaptureRun(); string id = CapturedId(result); string dir = CaptureDir(root, id);
    Check(result.Err.Length == 0, "stderr_not_empty");
    Check(File.Exists(Path.Combine(dir, "snapshot.edb")) && File.Exists(Path.Combine(dir, "key.dpapi")) && File.Exists(Path.Combine(dir, "manifest.json")), "files_missing");
    Check(!File.Exists(Path.Combine(root, "captures", ".official-snapshot.lock")), "lock_not_released");
    byte[] key = UnprotectFile(Path.Combine(dir, "key.dpapi"));
    Check(Same(key, Key), "dpapi_round_trip");
    using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(Path.Combine(dir, "snapshot.edb"), key)) Check(reader.VerifySchemaReadable(), "snapshot_open");
    DateTime manifestTime = File.GetLastWriteTimeUtc(Path.Combine(dir, "manifest.json"));
    foreach (string file in Directory.GetFiles(dir)) Check(File.GetLastWriteTimeUtc(file) <= manifestTime, "manifest_not_last");
    string text = File.ReadAllText(Path.Combine(dir, "manifest.json"));
    Dictionary<string, object> manifest = ReadManifest(dir);
    Check((string)manifest["databaseSha256"] == Sha(Path.Combine(dir, "snapshot.edb")), "database_hash");
    Check((string)manifest["lineBuildKind"] == "accepted" && (string)manifest["lineBuild"] == "fixture", "accepted_build_metadata");
    string expected; using (SHA256 h = SHA256.Create()) expected = BitConverter.ToString(h.ComputeHash(U(OwnMid))).Replace("-", "").ToLowerInvariant();
    Check((string)manifest["expectedMidSha256"] == expected, "mid_hash");
    NoForbidden("manifest", text);
    Check(Arr(manifest["sides"]).Length == 0, "sides_expected_empty");
    Result list = Run(null, "list");
    Check(list.Code == 0 && list.Out.Contains(id), "list_shows_capture"); NoForbidden("list", list.Out);
  }

  static void CaptureFailure(string root) {
    string main = BuildAll(root, true); ResetHooks(root, main);
    string captures = Path.Combine(root, "captures"); Directory.CreateDirectory(captures);
    string foreignDirectory = Path.Combine(captures, "20200101T000000Zdeadbeef"); Directory.CreateDirectory(foreignDirectory);
    File.WriteAllText(Path.Combine(foreignDirectory, "keep.txt"), "foreign");
    File.WriteAllText(Path.Combine(captures, "foreign-file.txt"), "foreign");
    foreach (string stage in new string[] { "after_main", "key_write", "after_key", "after_side:album-1", "after_side:chatstats-1", "before_manifest" }) {
      OfficialSnapshotTool.TestStage = delegate(string name) { if (name == stage) throw new InvalidOperationException("induced"); };
      OfficialSnapshotTool.TestKeyWrite = stage == "key_write" ? (Action<FileStream>)delegate(FileStream stream) { stream.WriteByte(0x01); throw new IOException("induced_key_write_failure"); } : null;
      Result result = CaptureRun();
      string diagnostic = stage.StartsWith("after_side:", StringComparison.Ordinal) || stage == "before_manifest" ? "side" : (stage == "after_main" ? "verify" : "backup");
      Check(result.Code == 1 && result.Err.Trim() == "ERROR|capture_failed|" + diagnostic, "failure_code_" + stage);
      Check(Directory.GetDirectories(captures).Length == 1 && Directory.Exists(foreignDirectory) && File.ReadAllText(Path.Combine(foreignDirectory, "keep.txt")) == "foreign" &&
        File.ReadAllText(Path.Combine(captures, "foreign-file.txt")) == "foreign", "own_dir_only_removed_" + stage);
      Check(Directory.GetFiles(captures).Length == 1, "no_leftover_files_" + stage);
    }
    OfficialSnapshotTool.TestStage = null; OfficialSnapshotTool.TestKeyWrite = null;
    CapturedId(CaptureRun());
  }

  static void CandidateBuild(string root) {
    string main = BuildAll(root, false); ResetHooks(root, main);
    FakeBuildEnvironment environment = new FakeBuildEnvironment();
    OfficialSnapshotTool.TestBuildDecision = delegate { return OfficialBuildPolicy.Evaluate("fixture", 42, environment, OfficialBuildTrust.Seeds()); };
    string id = CapturedId(CaptureRun());
    Dictionary<string, object> manifest = ReadManifest(CaptureDir(root, id));
    Check((string)manifest["lineBuildKind"] == "accepted" && (string)manifest["lineBuild"] == "26.5.0.3975", "version_only_manifest");
    foreach (string scenario in new string[] { "missing-version", "malformed-version" }) {
      environment.Version = scenario == "missing-version" ? null : "not-a-version";
      string reason = "bad_version";
      OfficialSnapshotTool.TestBuildDecision = delegate { return OfficialBuildPolicy.Evaluate("fixture", 42, environment, OfficialBuildTrust.Seeds()); };
      Result rejected = CaptureRun();
      Check(rejected.Code == 1 && rejected.Err.Trim() == "ERROR|capture_failed|build_" + reason, "build_rejection_" + scenario);
      Check(Directory.GetDirectories(Path.Combine(root, "captures")).Length == 1, "build_rejection_wrote_files_" + scenario);
    }
  }

  // ---------------- A7 / A8 ----------------
  static Dictionary<string, object> SideEntry(Dictionary<string, object> manifest, string kind) {
    foreach (object o in Arr(manifest["sides"])) if ((string)Obj(o)["kind"] == kind) return Obj(o);
    throw new InvalidOperationException("side_missing_" + kind);
  }

  static void CaptureSides(string root) {
    string main = BuildAll(root, true); ResetHooks(root, main);
    Result result = CaptureRun(); string id = CapturedId(result); string dir = CaptureDir(root, id);
    NoForbidden("capture_output", result.Out + result.Err);
    Dictionary<string, object> manifest = ReadManifest(dir);
    NoForbidden("manifest", File.ReadAllText(Path.Combine(dir, "manifest.json")));
    Dictionary<string, object> album = SideEntry(manifest, "album"), stats = SideEntry(manifest, "chatstats"), keep = SideEntry(manifest, "keep");
    Check((string)album["status"] == "captured" && (string)album["keyRef"] == "main" && L(album["n"]) == 1, "album_main_key");
    Check((string)stats["status"] == "captured" && (string)stats["keyRef"] == "side/chatstats-1.key.dpapi", "chatstats_own_key");
    Check((string)keep["status"] == "key_not_found" && keep["sha256"] == null, "keep_key_not_found");
    List<string> sideFiles = new List<string>(Directory.GetFiles(Path.Combine(dir, "side")));
    sideFiles.Sort(StringComparer.Ordinal);
    List<string> names = new List<string>(); foreach (string f in sideFiles) names.Add(Path.GetFileName(f));
    Check(String.Join(",", names.ToArray()) == "album-1.edb,chatstats-1.edb,chatstats-1.key.dpapi", "side_files_" + String.Join(",", names.ToArray()));
    byte[] sideKey = UnprotectFile(Path.Combine(dir, "side", "chatstats-1.key.dpapi"));
    Check(Same(sideKey, Key2), "side_key_round_trip");
    using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(Path.Combine(dir, "side", "chatstats-1.edb"), sideKey)) Check(reader.AnalysisVerifySideCopy(), "side_copy_verifies");
    Check((string)album["sha256"] == Sha(Path.Combine(dir, "side", "album-1.edb")) && L(album["sizeBytes"]) == new FileInfo(Path.Combine(dir, "side", "album-1.edb")).Length, "side_hash");
    DateTime manifestTime = File.GetLastWriteTimeUtc(Path.Combine(dir, "manifest.json"));
    foreach (string f in sideFiles) Check(File.GetLastWriteTimeUtc(f) <= manifestTime, "manifest_not_last");
  }

  static void CaptureSideFailures(string root) {
    string main = BuildAll(root, true); ResetHooks(root, main);
    OfficialSnapshotTool.TestSideVerifyFails = delegate(string name) { return name == "album-1"; };
    string id = CapturedId(CaptureRun()); string dir = CaptureDir(root, id);
    Dictionary<string, object> manifest = ReadManifest(dir);
    Dictionary<string, object> album = SideEntry(manifest, "album");
    Check((string)album["status"] == "verify_failed" && album["sha256"] == null && album["file"] == null, "verify_failed_recorded");
    Check((string)SideEntry(manifest, "chatstats")["status"] == "captured", "other_side_still_captured");
    Check(!File.Exists(Path.Combine(dir, "side", "album-1.edb")), "partial_removed");
    Check(File.GetLastWriteTimeUtc(Path.Combine(dir, "manifest.json")) >= File.GetLastWriteTimeUtc(Path.Combine(dir, "side", "chatstats-1.edb")), "manifest_last");
    OfficialSnapshotTool.TestSideVerifyFails = null;
    long mainBytes = L(manifest["snapshotBytes"]);
    OfficialSnapshotTool.TestCaptureCapBytes = mainBytes + 1;
    string id2 = CapturedId(CaptureRun()); string dir2 = CaptureDir(root, id2);
    Dictionary<string, object> manifest2 = ReadManifest(dir2);
    foreach (string kind in new string[] { "album", "chatstats" }) Check((string)SideEntry(manifest2, kind)["status"] == "limit_exceeded", "limit_" + kind);
    Check(Directory.GetFiles(Path.Combine(dir2, "side")).Length == 0, "limit_leaves_no_files");
    Check(File.Exists(Path.Combine(dir2, "snapshot.edb")), "main_survives_limit");
  }

  // ---------------- A2 / A3 / A9 ----------------
  static void Analyze(string root) {
    string main = BuildAll(root, true); ResetHooks(root, main);
    string id = CapturedId(CaptureRun()); string dir = CaptureDir(root, id);
    ForbidProcessAccess();
    string snapshotBefore = Sha(Path.Combine(dir, "snapshot.edb"));
    Result result = Run(null, "analyze", id);
    Check(result.Code == 0, "analyze_exit_" + result.Err);
    Check(!probeTouched, "analyze_touched_process_access");
    string analysisText = File.ReadAllText(Path.Combine(dir, "analysis.json"));
    NoForbidden("stdout", result.Out); NoForbidden("stderr", result.Err); NoForbidden("analysis", analysisText); NoForbidden("manifest", File.ReadAllText(Path.Combine(dir, "manifest.json")));
    Check(result.Out.Trim() == analysisText.Trim(), "stdout_equals_analysis");
    Check(Sha(Path.Combine(dir, "snapshot.edb")) == snapshotBefore && Work(dir).Count == 0, "retained_unchanged_no_sandbox");
    Dictionary<string, object> report = Obj(Json.DeserializeObject(analysisText));
    Check(L(Get(report, "main", "tables", "_message", "rowCount")) == 14, "message_rows");
    Check((string)Get(report, "main", "tableCoverage", "_message") == "archived+projected", "coverage_message");
    Check((string)Get(report, "main", "tableCoverage", "_chat") == "archived+projected", "coverage_chat");
    Check((string)Get(report, "main", "tableCoverage", "_profile") == "archived", "coverage_profile");
    Check((string)Get(report, "main", "tableCoverage", "_chatOption") == "archived", "coverage_chatoption");
    Check((string)Get(report, "main", "tableCoverage", "_unknownTable") == "not-imported", "coverage_unknown");
    Check(L(Get(report, "main", "tables", "_unknownTable", "rowCount")) == 1, "unknown_rowcount");
    Dictionary<string, object> message = Obj(Get(report, "main", "message"));
    Check(L(message["relatedMessageIdPresent"]) == 2 && L(message["relatedResolvedInSnapshot"]) == 1 && L(message["relatedUnresolved"]) == 1, "relation_stats");
    Check(L(Get(message, "contentTypeByToType", "ct:7|to:0")) == 1 && L(Get(message, "contentTypeByToType", "ct:0|to:2")) == 1, "content_type_by_to_type");
    Check(L(Get(message, "perContentType", "ct:7", "projection", "nativeStickerMetadata")) == 1 && L(Get(message, "perContentType", "ct:7", "projection", "stickerWithPackageId")) == 1 &&
      L(Get(message, "perContentType", "ct:7", "projection", "kind", "sticker")) == 1, "projection_sticker");
    Check(L(Get(message, "perContentType", "ct:1", "projection", "nativeAttachments")) == 1, "projection_attachment");
    Check(L(Get(message, "perContentType", "ct:13", "projection", "kind", "contact")) == 1 && L(Get(message, "perContentType", "ct:22", "projection", "kind", "event")) == 1, "projection_kinds");
    Check(L(Get(message, "perContentType", "ct:15", "blobColumns", "_location", "encodings", "thrift_compact_like", "count")) == 1 + 2, "location_compact_class");
    Check(L(Get(message, "perContentType", "ct:15", "blobColumns", "_location", "encodings", "json_object", "count")) == 2, "location_json_class");
    Check(L(Get(message, "perContentType", "ct:15", "blobColumns", "_location", "encodings", "thrift_binary_like", "count")) == 1, "location_binary_class");
    Check(L(Get(message, "perContentType", "ct:15", "blobColumns", "_location", "encodings", "protobuf_like", "count")) == 1, "location_protobuf_class");
    Check(Get(message, "perContentType", "ct:1", "blobColumns", "_contentInfo", "encodings", "json_object", "count") != null, "contentinfo_json");
    Check(Get(message, "perContentType", "ct:22", "blobColumns", "_reactions", "encodings", "thrift_binary_like", "count") != null, "reactions_binary");
    Check(Get(message, "perContentType", "ct:1", "blobColumns", "_eventInfo", "encodings", "protobuf_like", "count") != null, "eventinfo_protobuf");
    Check(L(Get(report, "main", "names", "chats", "direct", "total")) == 3 && L(Get(report, "main", "names", "chats", "direct", "withName")) == 1, "names_direct");
    Check(L(Get(report, "main", "names", "chats", "group", "total")) == 2 && L(Get(report, "main", "names", "chats", "group", "withName")) == 1, "names_group");
    Check(L(Get(report, "main", "names", "contacts", "rows")) == 3 && L(Get(report, "main", "names", "contacts", "nameFieldCombinations", "displayName")) == 1 &&
      L(Get(report, "main", "names", "contacts", "nameFieldCombinations", "none")) == 1, "names_contacts");
    // A9: side databases are aggregate-only generic reports and carry no names or contents.
    Check(Get(report, "sides", "album#1", "tables", "photos") != null && Get(report, "sides", "chatstats#1", "tables", "stats") != null, "side_reports");
    Check(Get(report, "sides", "keep#1") == null, "uncaptured_side_absent");
    Check(L(Get(report, "sides", "album#1", "tables", "photos", "rowCount")) == 2, "side_rowcount");
    Check(Get(report, "sides", "album#1", "tables", "photos", "columns", "meta", "json", "keys", SnapshotDecode.RedactedKey) != null, "side_json_key_redacted");
    Check(Get(report, "sides", "album#1", "message") == null && Get(report, "sides", "album#1", "names") == null, "side_no_projection_or_names");
    Check(Get(report, "main", "tables", "_message", "columns", "_text", "encodings", "utf8_text", "lengthMax") != null, "length_stats");
  }

  static void AnalyzeFailures(string root) {
    string main = BuildAll(root, true); ResetHooks(root, main);
    string id = CapturedId(CaptureRun()); string dir = CaptureDir(root, id);
    ForbidProcessAccess();
    string snapshot = Path.Combine(dir, "snapshot.edb");
    byte[] original = File.ReadAllBytes(snapshot);
    DateTime originalTime = File.GetLastWriteTimeUtc(snapshot);
    // hash mismatch fails closed
    byte[] tampered = (byte[])original.Clone(); tampered[tampered.Length - 1] ^= 1; File.WriteAllBytes(snapshot, tampered);
    Result mismatch = Run(null, "analyze", id);
    Check(mismatch.Code == 1 && mismatch.Err.Trim() == "ERROR|analysis_hash_mismatch" && !File.Exists(Path.Combine(dir, "analysis.json")) && Work(dir).Count == 0, "hash_mismatch_fails_closed");
    File.WriteAllBytes(snapshot, original); File.SetLastWriteTimeUtc(snapshot, originalTime);
    // wrong key fails closed
    string keyFile = Path.Combine(dir, "key.dpapi"); byte[] keyBytes = File.ReadAllBytes(keyFile);
    byte[] wrong = NativeCurrentUserProtection.Protect(Key3); File.WriteAllBytes(keyFile, wrong);
    Result wrongKey = Run(null, "analyze", id);
    Check(wrongKey.Code == 1 && wrongKey.Err.Trim() == "ERROR|analysis_key_invalid" && !File.Exists(Path.Combine(dir, "analysis.json")) && Work(dir).Count == 0, "wrong_key_fails_closed");
    byte[] shortKey = NativeCurrentUserProtection.Protect(Encoding.ASCII.GetBytes("short")); File.WriteAllBytes(keyFile, shortKey);
    Check(Run(null, "analyze", id).Err.Trim() == "ERROR|analysis_key_invalid", "short_key_rejected");
    File.WriteAllBytes(keyFile, keyBytes);
    Check(Sha(snapshot) == BitConverter.ToString(SHA256.Create().ComputeHash(original)).Replace("-", "").ToLowerInvariant() && !probeTouched, "state_restored");
  }

  static void Redaction(string root) {
    string main = BuildAll(root, true); ResetHooks(root, main);
    string id = CapturedId(CaptureRun()); string dir = CaptureDir(root, id);
    Result result = Run(null, "analyze", id); Check(result.Code == 0, "analyze_exit");
    string text = File.ReadAllText(Path.Combine(dir, "analysis.json"));
    Check(text.IndexOf(new string('k', 65), StringComparison.Ordinal) < 0 && text.IndexOf("has space", StringComparison.Ordinal) < 0 && text.IndexOf("日本", StringComparison.Ordinal) < 0 &&
      text.IndexOf("\\u65e5", StringComparison.Ordinal) < 0 && text.IndexOf(Mid, StringComparison.Ordinal) < 0 && text.IndexOf(GroupMid, StringComparison.Ordinal) < 0, "odd_keys_not_reported");
    Dictionary<string, object> report = Obj(Json.DeserializeObject(text));
    Dictionary<string, object> keys = Obj(Get(report, "main", "tables", "_message", "columns", "_contentMetadata", "json", "keys"));
    Check(keys.ContainsKey("STKID") && keys.ContainsKey(SnapshotDecode.RedactedKey) && keys.ContainsKey("nested") && keys.ContainsKey("MENTION") == false, "kept_and_redacted_keys");
    Check(L(Get(keys, SnapshotDecode.RedactedKey, "number")) >= 6 && Get(keys, SnapshotDecode.RedactedKey, "string") != null && Get(keys, SnapshotDecode.RedactedKey, "boolean") != null && Get(keys, SnapshotDecode.RedactedKey, "null") != null, "redacted_key_value_types");
    Check(
      Get(report, "sides", "album#1", "tables", "photos", "columns", "meta", "json", "keys", SnapshotDecode.RedactedKey) != null, "long_hex_keys_redacted");
    Check(Get(report, "main", "tables", "_message", "columns", "_contentMetadata", "json", "nested", "nested", "ok_key", "string") != null &&
      Get(report, "main", "tables", "_message", "columns", "_contentMetadata", "json", "nested", "nested", SnapshotDecode.RedactedKey, "number") != null, "nested_one_level_redacted");
    // the pure rule
    Check(SnapshotDecode.RedactKey("STKID") == "STKID" && SnapshotDecode.RedactKey("a.b-c_9") == "a.b-c_9" && SnapshotDecode.RedactKey(Mid) == SnapshotDecode.RedactedKey &&
      SnapshotDecode.RedactKey("U" + Mid.Substring(1)) == SnapshotDecode.RedactedKey && SnapshotDecode.RedactKey(new string('a', 64)) == SnapshotDecode.RedactedKey &&
      SnapshotDecode.RedactKey(new string('a', 65)) == SnapshotDecode.RedactedKey && SnapshotDecode.RedactKey("a b") == SnapshotDecode.RedactedKey && SnapshotDecode.RedactKey("") == SnapshotDecode.RedactedKey, "rule");
    Check(Get(report, "main", "tables", "_message", "columns", "_contentMetadata", "json", "topKeySets") != null, "keysets");
  }

  // ---------------- A5 ----------------
  static void Lock(string root) {
    string main = BuildAll(root, false); ResetHooks(root, main);
    string captures = Path.Combine(root, "captures"); Directory.CreateDirectory(captures);
    using (new FileStream(Path.Combine(captures, ".official-snapshot.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose)) {
      Result blocked = CaptureRun();
      Check(blocked.Code == 1 && blocked.Err.Trim() == "ERROR|snapshot_locked" && Directory.GetDirectories(captures).Length == 0, "second_run_blocked");
      Check(Run(null, "list").Err.Trim() == "ERROR|snapshot_locked", "list_blocked");
    }
    CapturedId(CaptureRun());
    Check(!File.Exists(Path.Combine(captures, ".official-snapshot.lock")), "lock_removed_after_run");
  }

  // ---------------- A11 ----------------
  static void Sandbox(string root) {
    string main = BuildAll(root, true); ResetHooks(root, main);
    string id = CapturedId(CaptureRun()); string dir = CaptureDir(root, id);
    ForbidProcessAccess();
    List<string> files = new List<string>(); files.Add(Path.Combine(dir, "snapshot.edb")); files.AddRange(Directory.GetFiles(Path.Combine(dir, "side")));
    Dictionary<string, string> hashes = new Dictionary<string, string>(); Dictionary<string, DateTime> times = new Dictionary<string, DateTime>();
    foreach (string f in files) { hashes[f] = Sha(f); times[f] = File.GetLastWriteTimeUtc(f); }
    string seenSandbox = null;
    OfficialSnapshotTool.TestStage = delegate(string name) { if (name == "analyzing") { List<string> w = Work(dir); Check(w.Count == 1 && File.Exists(Path.Combine(w[0], "snapshot.edb")), "sandbox_present_during"); seenSandbox = w[0]; } };
    Check(Run(null, "analyze", id).Code == 0, "success_run");
    Check(seenSandbox != null && !Directory.Exists(seenSandbox) && Work(dir).Count == 0, "sandbox_removed_on_success");
    foreach (string f in files) Check(Sha(f) == hashes[f] && File.GetLastWriteTimeUtc(f) == times[f], "retained_identical_after_success");
    OfficialSnapshotTool.TestStage = delegate(string name) { if (name == "analyzing") { seenSandbox = Work(dir)[0]; throw new InvalidOperationException("induced"); } };
    Result failed = Run(null, "analyze", id);
    Check(failed.Code == 1 && failed.Err.Trim() == "ERROR|analysis_failed" && Work(dir).Count == 0 && !Directory.Exists(seenSandbox), "sandbox_removed_on_failure");
    foreach (string f in files) Check(Sha(f) == hashes[f] && File.GetLastWriteTimeUtc(f) == times[f], "retained_identical_after_failure");
    // stale sandbox left by a crash is removed on the next run
    OfficialSnapshotTool.TestStage = null;
    string stale = Path.Combine(dir, "work-deadbeef"); Directory.CreateDirectory(stale); File.WriteAllText(Path.Combine(stale, "leftover.edb"), "x");
    string unrelated = Path.Combine(dir, "not-a-sandbox"); Directory.CreateDirectory(unrelated);
    Check(Run(null, "analyze", id).Code == 0 && !Directory.Exists(stale) && Directory.Exists(unrelated), "stale_sandbox_cleaned");
    // a held lock means no cleanup
    Directory.CreateDirectory(stale);
    using (new FileStream(Path.Combine(root, "captures", ".official-snapshot.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose))
      Check(Run(null, "analyze", id).Err.Trim() == "ERROR|snapshot_locked" && Directory.Exists(stale), "locked_run_does_not_clean");
    Directory.Delete(stale, true);
    Check(!probeTouched, "no_process_access");
    // delete removes only the capture
    Check(Run(null, "delete", id).Out.Trim() == "DELETED|" + id && !Directory.Exists(dir), "delete");
  }

  // ---------------- A12 / A13 / A15 ----------------
  static string LiveLine(string id, int contentType, string fields) { return "{\"messageId\":\"" + id + "\",\"kind\":\"location\",\"fields\":{\"contentType\":" + contentType + "," + fields + "}}\n"; }
  static string LiveLocation(string id, string title, string address, string lat, string lon) {
    return LiveLine(id, 15, "\"location\":{\"title\":\"" + title + "\",\"address\":\"" + address + "\",\"latitude\":" + lat + ",\"longitude\":" + lon + "},\"contentMetadata\":{\"" + Mid + "\":\"SENTINELMETA\",\"STKID\":\"9\"}");
  }
  static Dictionary<string, object> Pair(object[] pairs, string column, string decoder, string path, string field) {
    foreach (object o in pairs) { Dictionary<string, object> p = Obj(o); if ((string)p["column"] == column && (string)p["decoder"] == decoder && (string)p["nativePath"] == path && (string)p["serverField"] == field) return p; }
    return null;
  }

  static void Correlate(string root) {
    string main = BuildAll(root, true); ResetHooks(root, main);
    string id = CapturedId(CaptureRun()); string dir = CaptureDir(root, id);
    ForbidProcessAccess();
    StringBuilder live = new StringBuilder();
    live.Append(LiveLocation("LJ1", "SENTINELJ1", "SENTINELADDRJ1", "35.111111", "139.111111"));
    live.Append(LiveLocation("LJ2", "SENTINELJ2", "SENTINELADDRJ2", "35.2222221", "139.222222"));
    live.Append(LiveLocation("LT1", "SENTINELT1", "SENTINELADDRT1", "35.333333", "139.333333"));
    live.Append(LiveLocation("LT2", "SENTINELWRONG", "SENTINELADDRT2", "35.444444", "139.444444"));
    live.Append(LiveLocation("LB1", "SENTINELB1", "SENTINELADDRB1", "35.555555", "139.555555"));
    live.Append(LiveLocation("LP1", "SENTINELP1", "SENTINELADDRP1", "35.666666", "139.666666"));
    live.Append(LiveLocation("NOT-IN-SNAPSHOT", "SENTINELX", "SENTINELXADDR", "1", "2"));
    live.Append("not json\n");
    string snapshotBefore = Sha(Path.Combine(dir, "snapshot.edb"));
    bool sandboxOnlyMain = false;
    OfficialSnapshotTool.TestStage = delegate(string name) {
      if (name == "correlating") {
        List<string> work = Work(dir);
        if (work.Count == 1) {
          string[] files = Directory.GetFiles(work[0], "*", SearchOption.AllDirectories);
          sandboxOnlyMain = files.Length == 1 && Path.GetFileName(files[0]) == "snapshot.edb";
        }
      }
    };
    Result result = Run(live.ToString(), "correlate", id);
    Check(result.Code == 0, "correlate_exit_" + result.Err);
    Check(sandboxOnlyMain && !probeTouched && Work(dir).Count == 0 && Sha(Path.Combine(dir, "snapshot.edb")) == snapshotBefore, "sandbox_and_retained");
    string text = File.ReadAllText(Path.Combine(dir, "correlation.json"));
    NoForbidden("stdout", result.Out); NoForbidden("stderr", result.Err); NoForbidden("correlation", text);
    Check(text.IndexOf("NOT-IN-SNAPSHOT", StringComparison.Ordinal) < 0 && text.IndexOf("LJ1", StringComparison.Ordinal) < 0 && text.IndexOf("SENTINELMETA", StringComparison.Ordinal) < 0, "ids_values_absent");
    Dictionary<string, object> report = Obj(Json.DeserializeObject(text));
    Check(L(Get(report, "rows", "live")) == 7 && L(Get(report, "rows", "invalid")) == 1 && L(Get(report, "rows", "matchedInSnapshot")) == 6, "row_counts");
    Check(L(Get(report, "rows", "perContentType", "15", "live")) == 7 && L(Get(report, "rows", "perContentType", "15", "matchedInSnapshot")) == 6, "id_match_rate");
    Check(L(Get(report, "columns", "_location", "nonEmpty")) == 6, "nonempty");
    Check(L(Get(report, "columns", "_location", "decoders", "json", "decoded")) == 2 && L(Get(report, "columns", "_location", "decoders", "thrift_compact", "decoded")) == 2 &&
      L(Get(report, "columns", "_location", "decoders", "thrift_binary", "decoded")) == 1 && L(Get(report, "columns", "_location", "decoders", "protobuf", "decoded")) == 1, "decode_success_counts");
    object[] pairs = Arr(report["pairs"]);
    Dictionary<string, object> p;
    p = Pair(pairs, "_location", "json", "title", "location.title"); Check(p != null && L(p["match"]) == 2 && L(p["mismatch"]) == 0, "json_title");
    p = Pair(pairs, "_location", "json", "latitude", "location.latitude"); Check(p != null && L(p["match"]) == 2, "json_latitude_tolerance");
    p = Pair(pairs, "_location", "thrift_compact", "1", "location.title"); Check(p != null && L(p["match"]) == 1 && L(p["mismatch"]) == 1, "compact_title_match_and_mismatch");
    p = Pair(pairs, "_location", "thrift_compact", "3", "location.latitude"); Check(p != null && L(p["match"]) == 2, "compact_latitude");
    p = Pair(pairs, "_location", "thrift_binary", "2", "location.address"); Check(p != null && L(p["match"]) == 1, "binary_address");
    p = Pair(pairs, "_location", "thrift_binary", "4", "location.longitude"); Check(p != null && L(p["match"]) == 1, "binary_longitude");
    p = Pair(pairs, "_location", "protobuf", "1", "location.title"); Check(p != null && L(p["match"]) == 1, "protobuf_title");
    p = Pair(pairs, "_location", "protobuf", "3", "location.latitude"); Check(p != null && L(p["match"]) == 1, "protobuf_fixed64_latitude");
    Check(Pair(pairs, "_location", "thrift_compact", "1", "location.address") == null || L(Pair(pairs, "_location", "thrift_compact", "1", "location.address")["match"]) == 0, "no_false_cross_match");
  }

  static void CorrelateCaps(string root) {
    string main = BuildAll(root, false); ResetHooks(root, main);
    string id = CapturedId(CaptureRun()); string dir = CaptureDir(root, id);
    ForbidProcessAccess();
    // one line over 64 KiB
    Result longLine = Run("{\"messageId\":\"LJ1\",\"fields\":{\"contentType\":15,\"pad\":\"" + new string('a', 70000) + "\"}}\n", "correlate", id);
    Check(longLine.Code == 1 && longLine.Err.Trim() == "ERROR|stdin_cap_exceeded" && longLine.Out.Length == 0, "line_cap");
    Check(!File.Exists(Path.Combine(dir, "correlation.json")) && Work(dir).Count == 0, "line_cap_no_output_no_sandbox");
    // total over 32 MiB made of valid lines
    string line = "{\"messageId\":\"LJ1\",\"fields\":{\"contentType\":15,\"pad\":\"" + new string('b', 60000) + "\"}}\n";
    StringBuilder total = new StringBuilder();
    while (total.Length <= 32 * 1024 * 1024) total.Append(line);
    Result totalCap = Run(total.ToString(), "correlate", id);
    Check(totalCap.Code == 1 && totalCap.Err.Trim() == "ERROR|stdin_cap_exceeded" && totalCap.Out.Length == 0, "total_cap");
    Check(!File.Exists(Path.Combine(dir, "correlation.json")) && !File.Exists(Path.Combine(dir, "correlation.json.tmp")) && Work(dir).Count == 0, "total_cap_no_output_no_sandbox");
    Check(Run("", "correlate", id).Code == 0, "empty_input_ok");
    File.Delete(Path.Combine(dir, "correlation.json"));
    // sandbox is removed when the correlation itself fails
    OfficialSnapshotTool.TestStage = delegate(string name) { if (name == "correlating") throw new InvalidOperationException("induced"); };
    Result failed = Run(line.Replace("b", "c"), "correlate", id);
    Check(failed.Code == 1 && failed.Err.Trim() == "ERROR|correlation_failed" && Work(dir).Count == 0 && !File.Exists(Path.Combine(dir, "correlation.json")), "failure_cleans_sandbox");
  }
}
