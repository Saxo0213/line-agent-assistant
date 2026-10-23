using System;
using System.IO;

internal static class OfficialSourceInventoryHarness {
  static int Main(string[] args) {
    if (args == null || args.Length != 2) return 2;
    string root = Path.GetFullPath(args[0]);
    string scenario = args[1];
    if (scenario == "contract") {
      Console.WriteLine("CONTRACT|" + OfficialSourceInventory.SupportedBuildVersion + "|" + OfficialSourceInventory.SupportedBuildBytes + "|" +
        OfficialSourceInventory.SupportedBuildSha256);
      return 0;
    }
    WindowsOfficialSourceInventoryEnvironment physical = new WindowsOfficialSourceInventoryEnvironment();
    if (scenario == "version") {
      // Exercises the production file-version read on an arbitrary local file (never the installed LINE in tests).
      Console.WriteLine("VER|" + physical.ReadFileVersion(root));
      return 0;
    }
    IOfficialSourceInventoryEnvironment environment = new SyntheticEnvironment(physical, root, scenario);
    try {
      bool versionScenario = scenario.StartsWith("ver-", StringComparison.Ordinal);
      // Version scenarios use the seeded trust with version-only admission; all
      // other scenarios keep the legacy single exact fixture identity.
      OfficialSourceInventoryResult result = versionScenario
        ? OfficialSourceInventory.Inspect(Path.Combine(root, "LINE"), OfficialBuildTrust.Seeds(), environment)
        : OfficialSourceInventory.Inspect(Path.Combine(root, "LINE"), "26.4.2.3957",
            LineFixtureBuildContract.Bytes, LineFixtureBuildContract.Sha256, environment);
      if (scenario.StartsWith("multi-", StringComparison.Ordinal)) {
        // Active-candidate selection: only the chosen file name and the candidate count are reported (never paths or MIDs).
        Console.WriteLine("ACTIVE|" + Path.GetFileName(result.DatabasePath) + "|" + result.CandidateCount);
        return 0;
      }
      Console.WriteLine("PASS|" + result.BuildVersion + "|" + result.EdbMiB[0] + "|" + result.WalMiB[0] + "|" + result.ProcessCount + "|" + result.BuildVerdict);
    } catch (Exception error) {
      string code = error is InvalidDataException && !String.IsNullOrEmpty(error.Message) ? error.Message : "source_io_error";
      OfficialBuildDecision decision = OfficialBuildRejection.DecisionOf(error);
      Console.WriteLine("REJECT|" + code + (decision == null ? "" : "|" + decision.Verdict + "|" + decision.Reason));
    }
    return 0;
  }

  internal sealed class SyntheticEnvironment : IOfficialSourceInventoryEnvironment, IOfficialExecutableInspector {
    readonly WindowsOfficialSourceInventoryEnvironment physical;
    readonly string root;
    readonly string scenario;
    readonly int realProcessId;
    bool replacementApplied;
    int processInspectionCount;
    // Direct-monitor key-scan scenarios (real LINE fixture process, pinned
    // build). Process inspections in that flow are: 1-2 initial inventory,
    // 3 key-probe entry revalidation, 4 pre-scan revalidation (its last
    // identity check), then the memory scan, then 5+ post-scan checks. Each
    // scan scenario mutates at the end of inspection 4, so the change lands
    // after every pre-scan check and is first observable after the scan.
    const int PreScanProcessInspection = 4;
    int scanProcessInspectionCount;
    bool scanStarted;
    bool ScanScenario {
      get {
        return scenario == "scanwalappend" || scenario == "scandbreplace" || scenario == "scanprocessrotate" ||
          scenario == "scanexechashrotate";
      }
    }
    bool PinnedBuild { get { return scenario == "pinnedaccept" || ScanScenario; } }
    internal SyntheticEnvironment(WindowsOfficialSourceInventoryEnvironment physical, string root, string scenario, int realProcessId = 0) {
      this.physical = physical; this.root = root; this.scenario = scenario; this.realProcessId = realProcessId;
    }
    public string[] EnumerateDatabaseFiles(string directory) {
      string[] files = physical.EnumerateDatabaseFiles(directory);
      if (scenario == "zero") return new string[0];
      if (scenario == "multiple" || scenario.StartsWith("multi-", StringComparison.Ordinal))
        return new string[] { Path.Combine(directory, "messages.edb"), Path.Combine(directory, "second.edb") };
      return files;
    }
    // Fabricated last-write times per scenario so selection never depends on the test's wall clock.
    static long? ScenarioTicks(string scenario, string fileName) {
      switch (scenario) {
        case "multiple": return 5000;
        case "multi-second-newer": return fileName == "second.edb" ? 2000 : fileName == "messages.edb" ? 1000 : 500;
        case "multi-first-newer": return fileName == "messages.edb" ? 2000 : fileName == "second.edb" ? 1000 : 500;
        case "multi-wal-newer": return fileName == "messages.edb-wal" ? 3000 : fileName == "second.edb" ? 2000 : 1000;
        default: return null;
      }
    }
    public OfficialSourceFileIdentity InspectFile(string path, bool allowMissing) {
      OfficialSourceFileIdentity info = physical.InspectFile(path, allowMissing);
      if (info != null) {
        long? ticks = ScenarioTicks(scenario, Path.GetFileName(path));
        if (ticks.HasValue) info.LastWriteTicks = ticks.Value;
      }
      if (info != null && PinnedBuild && String.Equals(Path.GetFileName(path), "LINE.exe", StringComparison.OrdinalIgnoreCase)) {
        info.Length = OfficialSourceInventory.SupportedBuildBytes;
      }
      // The fixture writer holds messages.edb open without delete sharing, so a
      // replacement after the scan starts is modelled as a new file identity.
      if (info != null && scenario == "scandbreplace" && scanStarted &&
          String.Equals(Path.GetExtension(path), ".edb", StringComparison.OrdinalIgnoreCase)) {
        info.FileId = "scan-replaced:" + info.FileId;
      }
      if (info != null && (scenario == "reparse" || scenario == "ver-reparse") &&String.Equals(Path.GetExtension(path), ".edb", StringComparison.OrdinalIgnoreCase)) {
        info.IsReparsePoint = true; info.IsRegular = false;
      }
      return info;
    }
    public bool IsReparsePoint(string path) { return physical.IsReparsePoint(path); }
    public string HashFile(string path) {
      // The executable content "rotates" once the scan has started: every later hash differs.
      if (scenario == "scanexechashrotate" && scanStarted && String.Equals(Path.GetFileName(path), "LINE.exe", StringComparison.OrdinalIgnoreCase))
        return new string('0', 64);
      if (PinnedBuild && String.Equals(Path.GetFileName(path), "LINE.exe", StringComparison.OrdinalIgnoreCase)) {
        return OfficialSourceInventory.SupportedBuildSha256;
      }
      return physical.HashFile(path);
    }
    // Test hook: fabricated file versions (the fixture LINE.exe has no version
    // resource and the real installed LINE is never consulted). "ver-real"
    // delegates to the production file-version read.
    public string ReadFileVersion(string path) {
      switch (scenario) {
        case "ver-real": return physical.ReadFileVersion(path);
        case "ver-new":
        case "ver-reparse": return "26.5.0.3975";
        case "ver-old": return "26.4.1.100";
        case "ver-bad": return "not-a-version";
        case "ver-missing": return null;
        default: return null;
      }
    }
    public int[] GetCandidateProcessIds() {
      if (realProcessId > 0) return new int[] { realProcessId };
      string wal = Path.Combine(root, "LINE", "Data", "db", "messages.edb-wal");
      if (scenario == "walcreate") File.WriteAllBytes(wal, new byte[] { 1, 2, 3, 4 });
      if (scenario == "waldelete") File.Delete(wal);
      if (scenario == "walreplace") {
        string replacementWal = wal + ".replacement";
        File.WriteAllBytes(replacementWal, new byte[] { 5, 6, 7, 8 });
        File.Delete(wal);
        File.Move(replacementWal, wal);
      }
      if (scenario == "replace" && !replacementApplied) {
        replacementApplied = true;
        string database = Path.Combine(root, "LINE", "Data", "db", "messages.edb");
        string replacement = database + ".replacement";
        File.WriteAllBytes(replacement, File.ReadAllBytes(database));
        File.Delete(database);
        File.Move(replacement, database);
      }
      if (scenario == "processzero") return new int[0];
      if (scenario == "processmultiple") return new int[] { 4242, 4343 };
      return new int[] { 4242 };
    }
    public long GetMatchingLineProcessCreationTime(int processId, string executablePath) {
      if (ScanScenario) return ScanProcessCreationTime(processId, executablePath);
      if (realProcessId > 0) return processId == realProcessId ? physical.GetMatchingLineProcessCreationTime(processId, executablePath) : 0;
      processInspectionCount++;
      if (scenario == "processwrongimage") return 0;
      if (scenario == "processrotate" && processInspectionCount > 1) return 5678;
      return processId == 4242 ? 1234 : 1235;
    }
    long ScanProcessCreationTime(int processId, string executablePath) {
      if (realProcessId <= 0) throw new InvalidDataException("scan_scenario_requires_process");
      long creation = processId == realProcessId ? physical.GetMatchingLineProcessCreationTime(processId, executablePath) : 0;
      scanProcessInspectionCount++;
      if (scanProcessInspectionCount == PreScanProcessInspection) {
        ApplyScanMutation();
        scanStarted = true;
        Console.Error.WriteLine("TEST_SCAN_MUTATION:" + scenario);
        return creation;
      }
      // A different process now owns the pinned id: every post-scan identity check sees it.
      if (scenario == "scanprocessrotate" && scanStarted && creation > 0) return creation + 1;
      return creation;
    }
    void ApplyScanMutation() {
      if (scenario != "scanwalappend") return;
      // Live LINE keeps writing: the WAL grows (a trailing partial frame
      // SQLite ignores) and the database write time moves, while the database
      // file itself (FileId) stays the same. Scan scenarios run only under
      // OfficialSourceInventoryBridgeHarness, whose root is the LINE directory.
      string database = Path.Combine(root, "Data", "db", "messages.edb");
      using (FileStream stream = new FileStream(database + "-wal", FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
        stream.WriteByte(0);
      File.SetLastWriteTimeUtc(database, File.GetLastWriteTimeUtc(database).AddSeconds(5));
    }
  }
}
