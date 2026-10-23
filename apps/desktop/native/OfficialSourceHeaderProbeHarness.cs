using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

internal static class OfficialSourceHeaderProbeHarness {
  const int ChunkBytes = 1024 * 1024;
  static int Main() {
    byte[] source = Encoding.ASCII.GetBytes("POST /S4 HTTP/1.1\r\nX-Line-Application: DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64\r\nX-Line-Access: fixture-token-alpha\r\n\r\n");
    byte[] reverseOrder = Encoding.ASCII.GetBytes("POST /S4 HTTP/1.1\r\nX-Line-Access: fixture-token-reverse\r\nX-Line-Application: DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64\r\n\r\n");
    byte[] duplicate = Encoding.ASCII.GetBytes("POST /S4 HTTP/1.1\r\nX-Line-Application: DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64\r\nX-Line-Access: fixture-token-alpha\r\n\r\n");
    byte[] wrongVersion = Encoding.ASCII.GetBytes("POST /S4 HTTP/1.1\r\nX-Line-Application: CHROMEOS\t3.7.2\tChrome_OS\r\nX-Line-Access: fixture-token-beta\r\n\r\n");
    byte[] injected = Encoding.ASCII.GetBytes("POST /S4 HTTP/1.1\r\nX-Line-Application: DESKTOPWIN\t26.4.2.3957\r\nX-Line-Access: fixture-token-gamma\nX-Injected: bad\r\n\r\n");
    byte[] dense = new byte[8192];
    byte[] accessMarker = Encoding.ASCII.GetBytes("X-LINE-ACCESS:");
    for (int offset = 0; offset + accessMarker.Length < dense.Length; offset += accessMarker.Length) {
      Buffer.BlockCopy(accessMarker, 0, dense, offset, accessMarker.Length);
    }
    byte[] split = SplitHeader();
    byte[] reverseSplit = SplitHeader(true);
    try {
      List<OfficialSourceHeaderProbe.HeaderCandidate> found = new List<OfficialSourceHeaderProbe.HeaderCandidate>();
      HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
      OfficialSourceHeaderProbe.ParseWindow(source, source.Length, true, found, seen, 16);
      OfficialSourceHeaderProbe.ParseWindow(duplicate, duplicate.Length, true, found, seen, 16);
      if (found.Count != 1 || found[0].Application != "DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64" ||
          found[0].Token != "fixture-token-alpha") { Console.WriteLine("FAIL|header_parse|count=" + found.Count); return 1; }
      List<OfficialSourceHeaderProbe.HeaderCandidate> reversed = new List<OfficialSourceHeaderProbe.HeaderCandidate>();
      OfficialSourceHeaderProbe.ParseWindow(reverseOrder, reverseOrder.Length, true, reversed,
        new HashSet<string>(StringComparer.Ordinal), 16);
      if (reversed.Count != 1 || reversed[0].Token != "fixture-token-reverse") {
        Console.WriteLine("FAIL|header_order|count=" + reversed.Count); return 1;
      }
      OfficialSourceHeaderProbe.ParseWindow(wrongVersion, wrongVersion.Length, true, found, seen, 16);
      OfficialSourceHeaderProbe.ParseWindow(injected, injected.Length, true, found, seen, 16);
      if (found.Count != 1) { Console.WriteLine("FAIL|malformed|count=" + found.Count); return 1; }

      List<OfficialSourceHeaderProbe.HeaderCandidate> denseFound = new List<OfficialSourceHeaderProbe.HeaderCandidate>();
      OfficialSourceHeaderProbe.ParseWindow(dense, dense.Length, true, denseFound,
        new HashSet<string>(StringComparer.Ordinal), 16);
      if (denseFound.Count != 0) { Console.WriteLine("FAIL|dense_markers|count=" + denseFound.Count); return 1; }
      using (CancellationTokenSource cancelled = new CancellationTokenSource()) {
        cancelled.Cancel();
        bool cancellationObserved = false;
        try { OfficialSourceHeaderProbe.ParseWindow(source, source.Length, true, new List<OfficialSourceHeaderProbe.HeaderCandidate>(),
          new HashSet<string>(StringComparer.Ordinal), 16, cancelled.Token, DateTime.MaxValue); }
        catch (OperationCanceledException) { cancellationObserved = true; }
        if (!cancellationObserved) { Console.WriteLine("FAIL|parser_cancel"); return 1; }
      }
      bool deadlineObserved = false;
      try { OfficialSourceHeaderProbe.ParseWindow(source, source.Length, true, new List<OfficialSourceHeaderProbe.HeaderCandidate>(),
        new HashSet<string>(StringComparer.Ordinal), 16, CancellationToken.None, DateTime.UtcNow.AddMilliseconds(-1)); }
      catch (TimeoutException) { deadlineObserved = true; }
      if (!deadlineObserved) { Console.WriteLine("FAIL|parser_deadline"); return 1; }
      List<OfficialSourceHeaderProbe.HeaderCandidate> capped = new List<OfficialSourceHeaderProbe.HeaderCandidate>();
      OfficialSourceHeaderProbe.ParseWindow(source, source.Length, true, capped, new HashSet<string>(StringComparer.Ordinal), 1);
      if (capped.Count != 1) { Console.WriteLine("FAIL|candidate_cap|count=" + capped.Count); return 1; }

      int splitReadBytes;
      List<OfficialSourceHeaderProbe.HeaderCandidate> splitCandidates = Scan(split, 16, 0, null, out splitReadBytes);
      if (splitCandidates.Count != 1 || splitReadBytes != split.Length) { Console.WriteLine("FAIL|split_chunk|count=" + splitCandidates.Count); return 1; }
      int reverseSplitReadBytes;
      List<OfficialSourceHeaderProbe.HeaderCandidate> reverseSplitCandidates = Scan(reverseSplit, 16, 0, null, out reverseSplitReadBytes);
      if (reverseSplitCandidates.Count != 1 || reverseSplitReadBytes != reverseSplit.Length) {
        Console.WriteLine("FAIL|reverse_split_chunk|count=" + reverseSplitCandidates.Count); return 1;
      }
      int cappedReadBytes;
      List<OfficialSourceHeaderProbe.HeaderCandidate> cappedScan = Scan(JoinHeaders(3), 2, 0, null, out cappedReadBytes);
      if (cappedScan.Count != 2 || cappedReadBytes > ChunkBytes) { Console.WriteLine("FAIL|scan_candidate_cap|count=" + cappedScan.Count); return 1; }

      int cleanupCount = 0;
      bool byteLimitObserved = false;
      int byteReadBytes;
      try { Scan(new byte[512], 16, 128, () => cleanupCount++, out byteReadBytes); }
      catch (InvalidDataException) { byteLimitObserved = true; }
      if (!byteLimitObserved || cleanupCount != 1 || LastReadBytes != 128) {
        Console.WriteLine("FAIL|byte_cap|observed=" + (byteLimitObserved ? "1" : "0") + "|cleanup=" + cleanupCount + "|bytes=" + LastReadBytes); return 1;
      }

      cleanupCount = 0;
      using (CancellationTokenSource scanCancellation = new CancellationTokenSource()) {
        CancelDuringNextRead = scanCancellation;
        bool scanCancelled = false;
        try { int cancelledReadBytes; Scan(split, 16, 0, () => cleanupCount++, out cancelledReadBytes, scanCancellation.Token); }
        catch (OperationCanceledException) { scanCancelled = true; }
        finally { CancelDuringNextRead = null; }
        if (!scanCancelled || cleanupCount != 1) { Console.WriteLine("FAIL|scan_cancel_cleanup|cancelled=" + (scanCancelled ? "1" : "0") + "|cleanup=" + cleanupCount); return 1; }
      }

      cleanupCount = 0;
      int verifyCount = 0;
      OfficialSourceHeaderProbe.TestVerifyHandle = () => { if (++verifyCount > 1) throw new InvalidDataException("source_changed"); };
      bool identityChanged = false;
      int ignored;
      try { Scan(source, 16, 0, () => cleanupCount++, out ignored); }
      catch (InvalidDataException) { identityChanged = true; }
      if (!identityChanged || cleanupCount != 1) { Console.WriteLine("FAIL|identity_cleanup|changed=" + (identityChanged ? "1" : "0") + "|cleanup=" + cleanupCount); return 1; }
      OfficialSourceHeaderProbe.TestVerifyHandle = null;

      Console.WriteLine("PASS|HEADER_PARSE|orders=2|split=2|caps=1|identity_change=1|cleanup=1|cancel=1");
      return 0;
    } finally {
      ClearHooks();
      Array.Clear(source, 0, source.Length); Array.Clear(duplicate, 0, duplicate.Length);
      Array.Clear(reverseOrder, 0, reverseOrder.Length);
      Array.Clear(wrongVersion, 0, wrongVersion.Length); Array.Clear(injected, 0, injected.Length);
      Array.Clear(dense, 0, dense.Length); Array.Clear(split, 0, split.Length); Array.Clear(reverseSplit, 0, reverseSplit.Length);
      Array.Clear(accessMarker, 0, accessMarker.Length);
    }
  }

  static int LastReadBytes;
  static CancellationTokenSource CancelDuringNextRead;
  static List<OfficialSourceHeaderProbe.HeaderCandidate> Scan(byte[] bytes, int maximumCandidates, long maximumBytes,
      Action onCleanup, out int readBytes, CancellationToken cancellation = default(CancellationToken)) {
    LastReadBytes = 0;
    OfficialSourceHeaderProbe.TestMaxCandidateCount = maximumCandidates;
    OfficialSourceHeaderProbe.TestMaxScanBytes = maximumBytes;
    OfficialSourceHeaderProbe.TestOpenReader = () => new IntPtr(0x42);
    OfficialSourceHeaderProbe.TestCloseReader = (handle) => { if (handle == new IntPtr(0x42) && onCleanup != null) onCleanup(); };
    long memoryBase = 0x10000;
    OfficialSourceHeaderProbe.TestQueryRegion = (address) => {
      if (address != 0) return null;
      return new OfficialSourceHeaderProbe.MemoryRegion { BaseAddress = new IntPtr(memoryBase), RegionSize = new UIntPtr((uint)bytes.Length),
        State = 0x1000, Type = 0x20000, Protect = 4 };
    };
    OfficialSourceHeaderProbe.TestReadMemory = (address, buffer) => {
      int offset = checked((int)(address - memoryBase));
      int count = Math.Min(buffer.Length, bytes.Length - offset);
      if (count <= 0) return 0;
      Buffer.BlockCopy(bytes, offset, buffer, 0, count);
      LastReadBytes += count;
      if (CancelDuringNextRead != null) CancelDuringNextRead.Cancel();
      return count;
    };
    OfficialSourceInventoryResult source = FixtureInventory.Create();
    try {
      List<OfficialSourceHeaderProbe.HeaderCandidate> result = OfficialSourceHeaderProbe.Find(source,
        new FixtureEnvironment(), DateTime.UtcNow.AddSeconds(5), cancellation);
      readBytes = LastReadBytes;
      return result;
    } finally { readBytes = LastReadBytes; ClearHooks(); }
  }

  static byte[] SplitHeader(bool accessBeforeApplication = false) {
    byte[] prefix = new byte[ChunkBytes - 36];
    for (int i = 0; i < prefix.Length; i++) prefix[i] = (byte)'A';
    string fields = accessBeforeApplication
      ? "X-Line-Access: fixture-reverse-split-token\r\nX-Line-Application: DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64"
      : "X-Line-Application: DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64\r\nX-Line-Access: fixture-split-token";
    byte[] header = Encoding.ASCII.GetBytes("\r\nPOST /S4 HTTP/1.1\r\n" + fields + "\r\n\r\n");
    byte[] result = new byte[prefix.Length + header.Length];
    Buffer.BlockCopy(prefix, 0, result, 0, prefix.Length);
    Buffer.BlockCopy(header, 0, result, prefix.Length, header.Length);
    Array.Clear(prefix, 0, prefix.Length); Array.Clear(header, 0, header.Length);
    return result;
  }

  static byte[] JoinHeaders(int count) {
    byte[][] pieces = new byte[count][];
    int length = 0;
    for (int i = 0; i < count; i++) { pieces[i] = Encoding.ASCII.GetBytes("POST /S4 HTTP/1.1\r\nX-Line-Application: DESKTOPWIN\t26.4.2.3957\r\nX-Line-Access: fixture-token-" + i + "\r\n\r\n"); length += pieces[i].Length; }
    byte[] result = new byte[length]; int offset = 0;
    foreach (byte[] piece in pieces) { Buffer.BlockCopy(piece, 0, result, offset, piece.Length); offset += piece.Length; Array.Clear(piece, 0, piece.Length); }
    return result;
  }

  static void ClearHooks() {
    OfficialSourceHeaderProbe.TestQueryRegion = null; OfficialSourceHeaderProbe.TestReadMemory = null;
    OfficialSourceHeaderProbe.TestVerifyHandle = null; OfficialSourceHeaderProbe.TestOpenReader = null;
    OfficialSourceHeaderProbe.TestCloseReader = null;
    OfficialSourceHeaderProbe.TestMaxCandidateCount = 0; OfficialSourceHeaderProbe.TestMaxScanBytes = 0;
  }
}

internal sealed class FixtureEnvironment : IOfficialSourceInventoryEnvironment {
  readonly OfficialSourceFileIdentity database = new OfficialSourceFileIdentity { Path = @"C:\fixture\chat.edb", Length = 8,
    LastWriteTicks = 1, FileId = "database", IsRegular = true };
  readonly OfficialSourceFileIdentity executable = new OfficialSourceFileIdentity { Path = @"C:\fixture\LINE.exe", Length = 8,
    LastWriteTicks = 1, FileId = "executable", IsRegular = true };
  public string[] EnumerateDatabaseFiles(string directory) { return new string[0]; }
  public OfficialSourceFileIdentity InspectFile(string path, bool allowMissing) {
    if (String.Equals(path, database.Path, StringComparison.OrdinalIgnoreCase)) return database;
    if (String.Equals(path, executable.Path, StringComparison.OrdinalIgnoreCase)) return executable;
    if (allowMissing) return null;
    throw new InvalidDataException("fixture_path");
  }
  public bool IsReparsePoint(string path) { return false; }
  public string HashFile(string path) { return OfficialSourceInventory.SupportedBuildSha256; }
  public int[] GetCandidateProcessIds() { return new int[0]; }
  public long GetMatchingLineProcessCreationTime(int processId, string executablePath) { return 1; }
}

internal static class FixtureInventory {
  internal static OfficialSourceInventoryResult Create() {
    FixtureEnvironment environment = new FixtureEnvironment();
    return new OfficialSourceInventoryResult { DatabasePath = @"C:\fixture\chat.edb", ExecutablePath = @"C:\fixture\LINE.exe",
      ProcessId = 1, ProcessCreationTime = 1, DatabaseIdentity = environment.InspectFile(@"C:\fixture\chat.edb", false),
      ExecutableIdentity = environment.InspectFile(@"C:\fixture\LINE.exe", false), BuildSha256 = OfficialSourceInventory.SupportedBuildSha256 };
  }
}
