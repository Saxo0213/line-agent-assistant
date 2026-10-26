using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// Standalone developer tool: retained official-database capture, sandboxed aggregate analysis, and live-message
// correlation. It never prints text, names, IDs, MIDs, file names, key bytes or blob bytes. See
// docs/architecture/official-db-retained-capture-and-content-bridge.md (Track A).
internal static partial class OfficialSnapshotTool {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue, RecursionLimit = 64 };
  const long MaxDatabaseBytes = 5L * 1024 * 1024 * 1024;
  const long MaxWalBytes = 512L * 1024 * 1024;
  const long MaxCaptureBytes = 8L * 1024 * 1024 * 1024;
  const int MaxSidePerKind = 8;

  // Test hooks: null in the shipped executable.
  internal static Func<Tuple<string, byte[]>> TestInventory;     // (main database path, main key) instead of inventory + probe
  internal static Func<OfficialBuildDecision> TestBuildDecision;
  internal static Func<byte[], byte[]> TestSideProbe;            // stands in for the pinned-process scan of a side file's page 1
  internal static string TestStorageRoot;
  internal static Action<string> TestStage;                       // may throw to induce a failure at a named stage
  internal static Stream TestStdin;
  internal static long TestCaptureCapBytes;
  internal static Func<string, bool> TestSideVerifyFails;       // "<kind>-<n>"
  internal static Action<Exception> TestFailure;                 // observes the cause of a failed operation
  internal static Action<FileStream> TestKeyWrite;                // simulates a partial protected-key write failure

  static int Main(string[] args) { return Run(args); }
  internal static int RunForTest(string[] args) { return Run(args); }

  static void Stage(string name) { if (TestStage != null) TestStage(name); }
  static Stream OpenStdin() { return TestStdin ?? Console.OpenStandardInput(); }
  static int Fail(string code) { Console.Error.WriteLine("ERROR|" + code); return 1; }

  static int Run(string[] args) {
    string root = TestStorageRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LineAgentAssistant", "official-snapshots");
    List<string> positional = new List<string>();
    for (int i = 0; i < args.Length; i++) {
      if (args[i] == "--root" && i + 1 < args.Length) root = args[++i]; else positional.Add(args[i]);
    }
    if (positional.Count < 1) return Fail("command_invalid");
    string command = positional[0];
    bool needsId = command == "analyze" || command == "correlate" || command == "delete";
    if (command != "capture" && command != "list" && !needsId) return Fail("command_invalid");
    if (needsId && (positional.Count != 2 || !ValidId(positional[1]))) return Fail("capture_id_invalid");
    if (!needsId && positional.Count != 1) return Fail("command_invalid");
    FileStream runLock = null;
    using (CancellationTokenSource cancellation = new CancellationTokenSource()) {
      ConsoleCancelEventHandler onCancel = delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; cancellation.Cancel(); };
      Console.CancelKeyPress += onCancel;
      try {
        root = Path.GetFullPath(root); Directory.CreateDirectory(root);
        try { runLock = new FileStream(Path.Combine(root, ".official-snapshot.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose); }
        catch (IOException) { return Fail("snapshot_locked"); }
        if (command == "capture") return Capture(root, cancellation.Token);
        if (command == "list") return ListCaptures(root);
        string directory = Path.Combine(root, positional[1]);
        if (command == "analyze") return Analyze(directory, positional[1], cancellation.Token);
        if (command == "correlate") return Correlate(directory, positional[1], cancellation.Token);
        return Delete(root, directory, positional[1]);
      } catch (SnapshotToolException error) { return Fail(error.Code); }
      catch (OperationCanceledException) { return Fail("cancelled"); }
      catch { return Fail("snapshot_operation_failed"); }
      finally {
        Console.CancelKeyPress -= onCancel;
        if (runLock != null) runLock.Dispose();
      }
    }
  }

  // ---------------- helpers ----------------
  static bool ValidId(string id) { return id != null && Regex.IsMatch(id, "^[0-9]{8}T[0-9]{6}Z[0-9a-f]{8}$"); }
  static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
  static string Sha256Hex(string path) {
    using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) using (SHA256 hash = SHA256.Create()) return Hex(hash.ComputeHash(stream));
  }
  static void Zero(byte[] bytes) { if (bytes != null) Array.Clear(bytes, 0, bytes.Length); }

  static string ReadLine(Stream input, int maxBytes) {
    MemoryStream line = new MemoryStream();
    try {
      byte[] one = new byte[1];
      while (input.Read(one, 0, 1) == 1) {
        if (one[0] == (byte)'\n') break;
        if (line.Length >= maxBytes) throw new SnapshotToolException("stdin_cap_exceeded");
        line.WriteByte(one[0]);
      }
      return new UTF8Encoding(false, true).GetString(line.GetBuffer(), 0, (int)line.Length).TrimEnd('\r');
    } finally { byte[] buffer = line.GetBuffer(); Array.Clear(buffer, 0, buffer.Length); line.Dispose(); }
  }

  static void WriteNewFile(string path, byte[] bytes) {
    using (FileStream output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { output.Write(bytes, 0, bytes.Length); output.Flush(true); }
  }
  static void WriteProtectedKey(string path, byte[] key) {
    byte[] protectedKey = NativeCurrentUserProtection.Protect(key);
    try {
      using (FileStream output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
        if (TestKeyWrite != null) TestKeyWrite(output);
        else { output.Write(protectedKey, 0, protectedKey.Length); output.Flush(true); }
      }
    } finally { Zero(protectedKey); }
  }
  static void WriteAtomic(string directory, string name, string content) {
    string temporary = Path.Combine(directory, name + ".tmp"), final = Path.Combine(directory, name);
    if (File.Exists(temporary)) File.Delete(temporary);
    byte[] bytes = new UTF8Encoding(false).GetBytes(content);
    try { WriteNewFile(temporary, bytes); } finally { Zero(bytes); }
    if (File.Exists(final)) File.Replace(temporary, final, null); else File.Move(temporary, final);
  }
  static bool IsReparse(string path) { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }

  // ---------------- capture ----------------
  sealed class SideSource { internal string Kind; internal int N; internal string Path; }

  static List<SideSource> EnumerateSides(string databaseDirectory) {
    List<string> files = new List<string>();
    foreach (string path in Directory.EnumerateFiles(databaseDirectory, "*.edb", SearchOption.TopDirectoryOnly)) files.Add(path);
    files.Sort(delegate(string a, string b) { return String.Compare(Path.GetFileName(a), Path.GetFileName(b), StringComparison.OrdinalIgnoreCase); });
    Dictionary<string, int> counts = new Dictionary<string, int>(StringComparer.Ordinal);
    List<SideSource> result = new List<SideSource>();
    foreach (string path in files) {
      string lower = Path.GetFileName(path).ToLowerInvariant(), kind = null;
      foreach (string candidate in new string[] { "album", "chatstats", "keep" }) if (lower.StartsWith(candidate, StringComparison.Ordinal)) kind = candidate;
      if (kind == null || IsReparse(path)) continue;
      int n; counts.TryGetValue(kind, out n); n++; counts[kind] = n;
      if (n <= MaxSidePerKind) result.Add(new SideSource { Kind = kind, N = n, Path = path });
    }
    return result;
  }

  static int Capture(string root, CancellationToken cancellation) {
    byte[] key = null; string directory = null, sideDirectory = null; LineEncryptedSnapshot.Capture capture = null;
    List<string> created = new List<string>(); List<byte[]> foundKeys = new List<byte[]>();
    string stage = "inventory", buildFailure = null;
    try {
      string expectedMid = ReadLine(OpenStdin(), 512);
      if (String.IsNullOrEmpty(expectedMid) || expectedMid.Length > 200 || expectedMid.IndexOf('\0') >= 0) throw new InvalidDataException();
      string database, build; string buildKind = "accepted"; Func<byte[], byte[]> probe;
      if (TestInventory != null) {
        Tuple<string, byte[]> source = TestInventory(); database = source.Item1; key = source.Item2; build = "fixture"; probe = TestSideProbe;
        if (TestBuildDecision != null) {
          OfficialBuildDecision decision = TestBuildDecision();
          if (decision.Verdict != OfficialBuildVerdict.Accepted && decision.Verdict != OfficialBuildVerdict.Candidate) throw OfficialBuildRejection.Create(decision);
          buildKind = decision.Verdict == OfficialBuildVerdict.Candidate ? "candidate" : "accepted";
          build = decision.Version;
        }
      } else {
        WindowsOfficialSourceInventoryEnvironment environment = new WindowsOfficialSourceInventoryEnvironment();
        OfficialSourceInventoryResult source = OfficialSourceInventory.Inspect(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LINE"),
          OfficialBuildTrust.Seeds(), environment);
        database = source.DatabasePath; build = source.BuildVersion; buildKind = source.BuildVerdict;
        stage = "key_probe";
        key = OfficialSourceKeyProbe.Find(source, environment, DateTime.UtcNow.AddMinutes(2), cancellation, null);
        probe = delegate(byte[] firstPage) {
          try { return OfficialSourceKeyProbe.FindForFirstPage(source, environment, firstPage, DateTime.UtcNow.AddMinutes(2), cancellation); }
          catch (InvalidDataException) { return null; }
        };
      }
      stage = "backup";
      if (key == null || key.Length != 32) throw new InvalidDataException();
      long sourceBytes = new FileInfo(database).Length;
      string id = DateTime.UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'", System.Globalization.CultureInfo.InvariantCulture) + Guid.NewGuid().ToString("N").Substring(0, 8);
      directory = Path.Combine(root, id);
      LineEncryptedSnapshot.Limits limits = new LineEncryptedSnapshot.Limits { MaxDatabaseBytes = MaxDatabaseBytes, MaxWalBytes = MaxWalBytes, MaxSnapshotBytes = MaxDatabaseBytes };
      byte[] mainKey = key;
      capture = LineEncryptedSnapshot.CaptureFixed(database, directory, key, limits, cancellation, expectedMid,
        delegate(string path) { stage = "verify"; using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(path, mainKey)) { if (!reader.VerifySchemaReadable()) throw new InvalidDataException(); } }, delegate(long a, long b) { });
      Stage("after_main");
      stage = "backup";
      string keyPath = Path.Combine(directory, "key.dpapi");
      created.Add(keyPath); WriteProtectedKey(keyPath, key);
      Stage("after_key");
      long cap = TestCaptureCapBytes > 0 ? TestCaptureCapBytes : MaxCaptureBytes;
      List<object> sides = new List<object>();
      List<SideSource> sources = EnumerateSides(Path.GetDirectoryName(database));
      if (sources.Count > 0) {
        sideDirectory = Path.Combine(directory, "side");
        LineEncryptedSnapshot.CreatePrivateDirectory(sideDirectory);
      }
      long used = capture.DatabaseBytes;
      foreach (SideSource side in sources) {
        stage = "side";
        Dictionary<string, object> entry = CaptureSide(side, sideDirectory, key, foundKeys, cap - used, probe, cancellation, created);
        if ((string)entry["status"] == "captured") used += (long)entry["sizeBytes"];
        sides.Add(entry);
        Stage("after_side:" + side.Kind + "-" + side.N.ToString(System.Globalization.CultureInfo.InvariantCulture));
      }
      Stage("before_manifest");
      string expectedHash; using (SHA256 hash = SHA256.Create()) expectedHash = Hex(hash.ComputeHash(Encoding.UTF8.GetBytes(expectedMid)));
      Dictionary<string, object> manifest = new Dictionary<string, object> {
        { "format", 1 }, { "captureId", id }, { "createdAt", DateTime.UtcNow.ToString("o") }, { "lineBuild", build }, { "lineBuildKind", buildKind },
        { "sourceBytes", sourceBytes }, { "snapshotBytes", capture.DatabaseBytes }, { "databaseSha256", capture.DatabaseSha256 },
        { "snapshotFile", "snapshot.edb" }, { "keyFile", "key.dpapi" }, { "expectedMidSha256", expectedHash }, { "sides", sides }
      };
      string manifestPath = Path.Combine(directory, "manifest.json");
      created.Add(manifestPath);
      // The capture owner holds the directory without share-delete, so a rename is impossible here; one complete write instead.
      byte[] manifestBytes = new UTF8Encoding(false).GetBytes(Json.Serialize(manifest));
      try { WriteNewFile(manifestPath, manifestBytes); } finally { Zero(manifestBytes); }
      // Release the capture owner's directory handle (SafeFileHandle finalizer) so later renames in the directory work in-process.
      capture = null; GC.Collect(); GC.WaitForPendingFinalizers();
      Console.WriteLine("CAPTURED|" + id);
      return 0;
    } catch (Exception failure) {
      if (TestFailure != null) TestFailure(failure);
      OfficialBuildDecision rejected = OfficialBuildRejection.DecisionOf(failure);
      if (rejected != null) buildFailure = Regex.IsMatch(rejected.Reason ?? "", "^[a-z_]{2,32}$") ? rejected.Reason : "other";
      if (capture != null) {
        for (int i = created.Count - 1; i >= 0; i--) { try { if (File.Exists(created[i])) File.Delete(created[i]); } catch { } }
        if (sideDirectory != null) { try { Directory.Delete(sideDirectory); } catch { } }
        try { capture.Cleanup(true); } catch { }
      }
      if (failure is OperationCanceledException) throw;
      return Fail("capture_failed" + (buildFailure != null ? "|build_" + buildFailure : "|" + stage));
    } finally {
      Zero(key);
      foreach (byte[] found in foundKeys) Zero(found);
    }
  }

  static byte[] ReadFirstPage(string path) {
    byte[] page = new byte[4096];
    using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      int filled = 0;
      while (filled < page.Length) { int read = stream.Read(page, filled, page.Length - filled); if (read <= 0) return null; filled += read; }
    }
    return page;
  }

  // Captures one side file. Never throws except for cancellation; a failed side leaves no partial files.
  static Dictionary<string, object> CaptureSide(SideSource side, string sideDirectory, byte[] mainKey, List<byte[]> foundKeys, long remaining,
      Func<byte[], byte[]> probe, CancellationToken cancellation, List<string> created) {
    string name = side.Kind + "-" + side.N.ToString(System.Globalization.CultureInfo.InvariantCulture);
    Dictionary<string, object> entry = new Dictionary<string, object> {
      { "kind", side.Kind }, { "n", side.N }, { "sizeBytes", 0L }, { "sha256", null }, { "keyRef", null }, { "file", null }, { "status", "verify_failed" } };
    string destination = Path.Combine(sideDirectory, name + ".edb"), keyFile = Path.Combine(sideDirectory, name + ".key.dpapi");
    int createdBefore = created.Count;
    byte[] page = null;
    try {
      FileInfo info = new FileInfo(side.Path);
      if (!info.Exists) return entry;
      if (info.Length > MaxDatabaseBytes || info.Length > remaining) { entry["status"] = "limit_exceeded"; return entry; }
      page = ReadFirstPage(side.Path);
      if (page == null) return entry;
      byte[] sideKey = null;
      if (LineEncryptedPageValidator.FirstPageValid(page, mainKey)) sideKey = mainKey;
      foreach (byte[] found in foundKeys) { if (sideKey == null && LineEncryptedPageValidator.FirstPageValid(page, found)) sideKey = found; }
      if (sideKey == null && probe != null) {
        byte[] probed = probe(page);
        if (probed != null) {
          if (probed.Length == 32 && LineEncryptedPageValidator.FirstPageValid(page, probed)) { foundKeys.Add(probed); sideKey = probed; } else Zero(probed);
        }
      }
      if (sideKey == null) { entry["status"] = "key_not_found"; return entry; }
      using (new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
      created.Add(destination);
      try {
        using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(side.Path, sideKey)) reader.BackupSideTo(destination, sideKey, cancellation, MaxDatabaseBytes, MaxWalBytes, remaining);
      } catch (InvalidOperationException error) {
        if (error.Message == "snapshot_size_limit") { entry["status"] = "limit_exceeded"; RemoveSide(created, createdBefore); return entry; }
        throw;
      }
      bool verified = false;
      byte[] copyPage = ReadFirstPage(destination);
      try { verified = copyPage != null && LineEncryptedPageValidator.FirstPageValid(copyPage, sideKey); } finally { Zero(copyPage); }
      if (verified) using (Sqlite3Mc copy = Sqlite3Mc.OpenReadOnly(destination, sideKey)) verified = copy.AnalysisVerifySideCopy();
      if (verified && TestSideVerifyFails != null && TestSideVerifyFails(name)) verified = false;
      if (!verified) { RemoveSide(created, createdBefore); return entry; }
      bool own = !Object.ReferenceEquals(sideKey, mainKey);
      if (own) { created.Add(keyFile); WriteProtectedKey(keyFile, sideKey); }
      entry["sizeBytes"] = new FileInfo(destination).Length; entry["sha256"] = Sha256Hex(destination);
      entry["keyRef"] = own ? "side/" + name + ".key.dpapi" : "main"; entry["file"] = "side/" + name + ".edb"; entry["status"] = "captured";
      return entry;
    } catch (OperationCanceledException) { throw; }
    catch { RemoveSide(created, createdBefore); entry["status"] = "verify_failed"; entry["sizeBytes"] = 0L; entry["sha256"] = null; entry["keyRef"] = null; entry["file"] = null; return entry; }
    finally { Zero(page); }
  }

  static void RemoveSide(List<string> created, int keep) {
    for (int i = created.Count - 1; i >= keep; i--) { try { if (File.Exists(created[i])) File.Delete(created[i]); } catch { } created.RemoveAt(i); }
  }

  // ---------------- list / delete ----------------
  static int ListCaptures(string root) {
    string[] directories = Directory.GetDirectories(root); Array.Sort(directories, StringComparer.Ordinal);
    foreach (string path in directories) {
      string manifest = Path.Combine(path, "manifest.json");
      if (!ValidId(Path.GetFileName(path)) || IsReparse(path) || !File.Exists(manifest)) continue;
      try { Console.WriteLine(Json.Serialize(Json.DeserializeObject(File.ReadAllText(manifest, Encoding.UTF8)))); } catch { }
    }
    return 0;
  }

  static Dictionary<string, object> ReadManifest(string directory, string id) {
    if (!Directory.Exists(directory) || IsReparse(directory)) throw new SnapshotToolException("capture_identity_invalid");
    string path = Path.Combine(directory, "manifest.json");
    if (!File.Exists(path)) throw new SnapshotToolException("capture_identity_invalid");
    Dictionary<string, object> manifest = Json.DeserializeObject(File.ReadAllText(path, Encoding.UTF8)) as Dictionary<string, object>;
    if (manifest == null || !manifest.ContainsKey("captureId") || !Object.Equals(manifest["captureId"], id) || !manifest.ContainsKey("format") || Convert.ToInt32(manifest["format"]) != 1)
      throw new SnapshotToolException("capture_identity_invalid");
    return manifest;
  }

  static int Delete(string root, string directory, string id) {
    string full = Path.GetFullPath(directory);
    if (!full.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return Fail("capture_identity_invalid");
    ReadManifest(full, id);
    Directory.Delete(full, true);
    Console.WriteLine("DELETED|" + id);
    return 0;
  }

  // ---------------- sandbox ----------------
  sealed class SideCopy { internal string Label; internal string Path; internal byte[] Key; internal string Problem; }
  sealed class Sandbox {
    internal string Directory; internal string MainPath; internal byte[] MainKey; internal List<SideCopy> Sides = new List<SideCopy>();
    internal void Dispose() {
      Zero(MainKey); foreach (SideCopy side in Sides) if (side.Key != null && !Object.ReferenceEquals(side.Key, MainKey)) Zero(side.Key);
      if (Directory != null) { try { System.IO.Directory.Delete(Directory, true); } catch { } }
    }
  }

  static void CleanStaleSandboxes(string directory) {
    foreach (string path in Directory.GetDirectories(directory, "work-*")) {
      if (!Regex.IsMatch(Path.GetFileName(path), "^work-[0-9a-f]{8}$") || IsReparse(path)) continue;
      try { Directory.Delete(path, true); } catch { }
    }
  }

  static byte[] ReadProtectedKey(string path) {
    byte[] protectedKey = File.ReadAllBytes(path);
    try {
      byte[] key = NativeCurrentUserProtection.Unprotect(protectedKey);
      if (key.Length != 32) { Zero(key); throw new SnapshotToolException("analysis_key_invalid"); }
      return key;
    } finally { Zero(protectedKey); }
  }

  // Byte copy with hash; the retained file is only read.
  static bool CopyVerified(string source, string destination, string expectedSha256) {
    using (FileStream input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
    using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
    using (SHA256 hash = SHA256.Create()) {
      byte[] buffer = new byte[1024 * 1024];
      try {
        while (true) {
          int read = input.Read(buffer, 0, buffer.Length); if (read <= 0) break;
          hash.TransformBlock(buffer, 0, read, null, 0); output.Write(buffer, 0, read);
        }
        hash.TransformFinalBlock(new byte[0], 0, 0); output.Flush(true);
      } finally { Array.Clear(buffer, 0, buffer.Length); }
      return String.Equals(Hex(hash.Hash), expectedSha256, StringComparison.Ordinal);
    }
  }

  static Sandbox PrepareSandbox(string directory, Dictionary<string, object> manifest, bool includeSides = true) {
    Sandbox sandbox = new Sandbox();
    try {
      sandbox.MainKey = ReadProtectedKey(Path.Combine(directory, "key.dpapi"));
      sandbox.Directory = Path.Combine(directory, "work-" + Guid.NewGuid().ToString("N").Substring(0, 8));
      LineEncryptedSnapshot.CreatePrivateDirectory(sandbox.Directory);
      Stage("sandbox_created");
      sandbox.MainPath = Path.Combine(sandbox.Directory, "snapshot.edb");
      if (!CopyVerified(Path.Combine(directory, "snapshot.edb"), sandbox.MainPath, (string)manifest["databaseSha256"])) throw new SnapshotToolException("analysis_hash_mismatch");
      byte[] page = ReadFirstPage(sandbox.MainPath);
      try { if (page == null || !LineEncryptedPageValidator.FirstPageValid(page, sandbox.MainKey)) throw new SnapshotToolException("analysis_key_invalid"); } finally { Zero(page); }
      if (!includeSides) return sandbox;
      object sidesObject; manifest.TryGetValue("sides", out sidesObject);
      System.Collections.IEnumerable sides = sidesObject as System.Collections.IEnumerable;
      if (sides != null) foreach (object item in sides) {
        Dictionary<string, object> side = item as Dictionary<string, object>;
        if (side == null || !Object.Equals(side["status"], "captured")) continue;
        string kind = side["kind"] as string; int n = Convert.ToInt32(side["n"]);
        string file = side["file"] as string, keyRef = side["keyRef"] as string, sha = side["sha256"] as string;
        string label = kind + "#" + n.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (kind == null || !Regex.IsMatch(kind, "^(album|chatstats|keep)$") || file == null || !Regex.IsMatch(file, "^side/(album|chatstats|keep)-[0-9]{1,2}\\.edb$") || sha == null || keyRef == null) continue;
        SideCopy copy = new SideCopy { Label = label, Path = Path.Combine(sandbox.Directory, file.Substring(5)) };
        sandbox.Sides.Add(copy);
        try {
          if (keyRef == "main") copy.Key = sandbox.MainKey;
          else if (Regex.IsMatch(keyRef, "^side/(album|chatstats|keep)-[0-9]{1,2}\\.key\\.dpapi$")) copy.Key = ReadProtectedKey(Path.Combine(directory, keyRef.Replace('/', Path.DirectorySeparatorChar)));
          else { copy.Problem = "key_reference_invalid"; continue; }
          if (!CopyVerified(Path.Combine(directory, file.Replace('/', Path.DirectorySeparatorChar)), copy.Path, sha)) copy.Problem = "hash_mismatch";
        } catch (SnapshotToolException) { copy.Problem = "key_invalid"; }
        catch (IOException) { copy.Problem = "copy_failed"; }
      }
      return sandbox;
    } catch { sandbox.Dispose(); throw; }
  }

  // ---------------- analyze ----------------
  static int Analyze(string directory, string id, CancellationToken cancellation) {
    Dictionary<string, object> manifest = ReadManifest(directory, id);
    CleanStaleSandboxes(directory);
    Sandbox sandbox = null;
    try {
      sandbox = PrepareSandbox(directory, manifest);
      Stage("analyzing");
      Dictionary<string, object> report = new Dictionary<string, object> {
        { "format", 1 }, { "captureId", id }, { "analyzedAt", DateTime.UtcNow.ToString("o") }, { "lineBuild", manifest["lineBuild"] }, { "snapshotBytes", manifest["snapshotBytes"] } };
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(sandbox.MainPath, sandbox.MainKey)) report["main"] = OfficialSnapshotAnalyzer.AnalyzeMain(reader, cancellation);
      Dictionary<string, object> sides = new Dictionary<string, object>();
      foreach (SideCopy side in sandbox.Sides) {
        if (side.Problem != null) { sides[side.Label] = new Dictionary<string, object> { { "error", side.Problem } }; continue; }
        try { using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(side.Path, side.Key)) sides[side.Label] = OfficialSnapshotAnalyzer.AnalyzeGeneric(reader, cancellation); }
        catch (OperationCanceledException) { throw; }
        catch (SnapshotToolException) { throw; }
        catch { cancellation.ThrowIfCancellationRequested(); sides[side.Label] = new Dictionary<string, object> { { "error", "analysis_failed" } }; }
      }
      report["sides"] = sides;
      string json = Json.Serialize(report);
      WriteAtomic(directory, "analysis.json", json);
      Console.WriteLine(json);
      return 0;
    } catch (SnapshotToolException) { throw; }
    catch (OperationCanceledException) { throw; }
    catch (Exception failure) { if (TestFailure != null) TestFailure(failure); return Fail("analysis_failed"); }
    finally { if (sandbox != null) sandbox.Dispose(); }
  }

  // ---------------- correlate ----------------
  static int Correlate(string directory, string id, CancellationToken cancellation) {
    Dictionary<string, object> manifest = ReadManifest(directory, id);
    long invalid; List<CorrelationLiveRow> rows;
    using (Stream input = OpenStdin()) rows = OfficialSnapshotCorrelator.ReadRows(input, out invalid);
    CleanStaleSandboxes(directory);
    Sandbox sandbox = null;
    try {
      sandbox = PrepareSandbox(directory, manifest, false);
      Stage("correlating");
      Dictionary<string, object> report;
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(sandbox.MainPath, sandbox.MainKey)) report = OfficialSnapshotCorrelator.Correlate(reader, rows, invalid, cancellation);
      report["captureId"] = id;
      string json = Json.Serialize(report);
      WriteAtomic(directory, "correlation.json", json);
      Console.WriteLine(json);
      return 0;
    } catch (SnapshotToolException) { throw; }
    catch (OperationCanceledException) { throw; }
    catch (Exception failure) { if (TestFailure != null) TestFailure(failure); return Fail("correlation_failed"); }
    finally { if (sandbox != null) sandbox.Dispose(); rows = null; }
  }
}
