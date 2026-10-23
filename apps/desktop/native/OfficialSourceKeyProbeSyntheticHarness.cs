using System;
using System.IO;
using System.Text;
using System.Threading;

// Disposable scanner boundary tests. Production builds have no memory hooks.
internal static class OfficialSourceKeyProbeSyntheticHarness {
  const int Chunk = 1024 * 1024;

  // Wraps the real environment and reports a modified view of one file or of the LINE process, without touching disk.
  sealed class TweakedEnvironment : IOfficialSourceInventoryEnvironment {
    readonly IOfficialSourceInventoryEnvironment inner;
    readonly string scenario;
    readonly OfficialSourceInventoryResult pinned;
    internal TweakedEnvironment(IOfficialSourceInventoryEnvironment inner, OfficialSourceInventoryResult pinned, string scenario) {
      this.inner = inner; this.pinned = pinned; this.scenario = scenario;
    }
    public string[] EnumerateDatabaseFiles(string directory) { return inner.EnumerateDatabaseFiles(directory); }
    public bool IsReparsePoint(string path) { return inner.IsReparsePoint(path); }
    public int[] GetCandidateProcessIds() { return inner.GetCandidateProcessIds(); }
    public string HashFile(string path) {
      string hash = inner.HashFile(path);
      return scenario == "same_exe_hash" && path == pinned.ExecutablePath ? new string('0', 64) : hash;
    }
    public long GetMatchingLineProcessCreationTime(int processId, string executablePath) {
      long creation = inner.GetMatchingLineProcessCreationTime(processId, executablePath);
      return scenario == "same_process_restart" ? creation + 1 : creation;
    }
    public OfficialSourceFileIdentity InspectFile(string path, bool allowMissing) {
      OfficialSourceFileIdentity file = inner.InspectFile(path, allowMissing);
      if (file == null) return null;
      OfficialSourceFileIdentity copy = new OfficialSourceFileIdentity {
        Path = file.Path, Length = file.Length, LastWriteTicks = file.LastWriteTicks, FileId = file.FileId,
        IsRegular = file.IsRegular, IsReparsePoint = file.IsReparsePoint,
      };
      bool db = path == pinned.DatabasePath, wal = path == pinned.DatabasePath + "-wal", exe = path == pinned.ExecutablePath;
      if ((scenario == "same_db_grow" && db) || (scenario == "same_wal_grow" && wal)) { copy.Length += 4096; copy.LastWriteTicks += 70000000; }
      if (scenario == "same_db_replaced" && db) copy.FileId = copy.FileId + "-new";
      if (scenario == "same_exe_stat" && exe) copy.LastWriteTicks += 1;
      return copy;
    }
  }

  static int RunSameSource(OfficialSourceInventoryResult source, IOfficialSourceInventoryEnvironment inner, string scenario) {
    try {
      OfficialSourceInventory.RequireSameSource(source, new TweakedEnvironment(inner, source, scenario));
      Console.WriteLine("SAME|" + scenario);
      return 0;
    } catch (InvalidDataException error) {
      Console.WriteLine("CHANGED|" + scenario + "|" + error.Message);
      return 0;
    }
  }
  static int Main(string[] args) {
    if (args.Length != 2) return 2;
    string root = Path.GetFullPath(args[0]), scenario = args[1];
    var environment = new OfficialSourceInventoryHarness.SyntheticEnvironment(
      new WindowsOfficialSourceInventoryEnvironment(), Path.Combine(root, "LINE"), "accept");
    OfficialSourceInventoryResult source = OfficialSourceInventory.Inspect(Path.Combine(root, "LINE"),
      "26.4.2.3957", LineFixtureBuildContract.Bytes, LineFixtureBuildContract.Sha256, environment);
    if (scenario.StartsWith("same_")) return RunSameSource(source, environment, scenario);
    byte[] key = Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");
    byte[] region = new byte[Chunk + 128];
    for (int i = 0; i < region.Length; i++) region[i] = (byte)'|';
    int start = Chunk - (scenario == "utf16_carry" ? 32 : 16);
    for (int i = 0; i < key.Length; i++) {
      int position = start + i * (scenario == "utf16_carry" ? 2 : 1);
      region[position] = key[i];
      if (scenario == "utf16_carry") region[position + 1] = 0;
    }
    // rescan_*: FindWithRescan. A "blank" copy has the key overwritten, so a scan over it finds nothing.
    bool rescan = scenario.StartsWith("rescan_", StringComparison.Ordinal);
    byte[] blank = (byte[])region.Clone();
    for (int i = 0; i < blank.Length; i++) blank[i] = (byte)'|';
    int verifies = 0, reads = 0, passes = 0;
    // wal_grow: LINE appends to the live WAL and touches the database during the scan; the key must still be found.
    string dbDirectory = Path.Combine(root, "LINE", "Data", "db");
    string walPath = Path.Combine(dbDirectory, "messages.edb-wal");
    byte[] walOriginal = null;
    if (scenario == "wal_grow") using (FileStream wal = new FileStream(walPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      walOriginal = new byte[wal.Length];
      int filled = 0;
      while (filled < walOriginal.Length) { int n = wal.Read(walOriginal, filled, walOriginal.Length - filled); if (n <= 0) break; filled += n; }
    }
    using (CancellationTokenSource cancellation = new CancellationTokenSource()) {
      OfficialSourceKeyProbe.TestQueryRegion = delegate(long address) {
        if (address != 0) return null;
        return new OfficialSourceKeyProbe.MemoryRegion {
          BaseAddress = new IntPtr(0x1000), RegionSize = new UIntPtr((uint)(scenario == "region_limit" ? 129 * Chunk : region.Length)),
          State = 0x1000, Type = 0x20000, Protect = 4,
        };
      };
      OfficialSourceKeyProbe.TestReadMemory = delegate(long address, byte[] buffer) {
        reads++;
        if (address == 0x1000) passes++;
        byte[] data = scenario == "rescan_found" && passes >= 2 ? region : rescan ? blank : region;
        int offset = checked((int)(address - 0x1000));
        int count = Math.Min(buffer.Length, region.Length - offset);
        if (scenario == "rescan_deadline" && reads == 1) Thread.Sleep(600);
        if (scenario == "wal_grow" && reads == 1) {
          using (FileStream wal = new FileStream(walPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
            wal.Write(new byte[] { 9, 9, 9, 9 }, 0, 4);
          File.SetLastWriteTimeUtc(Path.Combine(dbDirectory, "messages.edb"), DateTime.UtcNow.AddSeconds(7));
        }
        if (scenario == "unreadable_gap" && reads == 1) return -1;
        if (scenario == "partial_gap" && reads == 1) count -= 16;
        Buffer.BlockCopy(data, offset, buffer, 0, count);
        if ((scenario == "cancel" || scenario == "rescan_cancel") && reads == 1) cancellation.Cancel();
        return count;
      };
      OfficialSourceKeyProbe.TestVerifyHandle = delegate() {
        verifies++;
        if (scenario == "identity_change" && verifies > 1) throw new InvalidDataException("source_changed");
      };
      try {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(scenario == "rescan_deadline" ? 300 : 5000);
        byte[] found = rescan
          ? OfficialSourceKeyProbe.FindWithRescan(source, environment, deadline, cancellation.Token)
          : OfficialSourceKeyProbe.Find(source, environment, deadline, cancellation.Token);
        try {
          if (scenario != "ascii_carry" && scenario != "utf16_carry" && scenario != "wal_grow" && scenario != "rescan_found") return 1;
          Console.WriteLine("FOUND|" + scenario + "|reads=" + reads + "|passes=" + passes);
          return 0;
        } finally { Array.Clear(found, 0, found.Length); }
      } catch (OperationCanceledException) {
        if (scenario == "rescan_cancel") { Console.WriteLine("REJECT|rescan_cancel|reads=" + reads + "|passes=" + passes); return 0; }
        if (scenario != "cancel") return 1;
        Console.WriteLine("REJECT|cancel"); return 0;
      } catch (InvalidDataException error) {
        if (scenario == "identity_change" && error.Message == "source_changed" ||
            (scenario == "rescan_none" || scenario == "rescan_deadline") && error.Message == "key_unavailable") {
          Console.WriteLine("REJECT|" + scenario + "|reads=" + reads + "|passes=" + passes); return 0;
        }
        if ((scenario == "unreadable_gap" || scenario == "partial_gap" || scenario == "region_limit") &&
              error.Message == "key_unavailable") {
          Console.WriteLine("REJECT|" + scenario + "|reads=" + reads); return 0;
        }
        return 1;
      } finally {
        if (walOriginal != null) {
          using (FileStream wal = new FileStream(walPath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) {
            wal.SetLength(0); wal.Write(walOriginal, 0, walOriginal.Length);
          }
        }
        Array.Clear(key, 0, key.Length);
        Array.Clear(region, 0, region.Length);
      }
    }
  }
}
