using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// The bridge exposes only fixed operations over private stdio. The fixture
// source operation is compiled only into disposable test binaries.
internal static class ExternalReaderBridge {
  delegate string[] NativeCatalogPageReader(int pageNumber, string snapshotDigest, out bool hasMore, out string batchDigest);
  delegate void NativeCatalogPageAcknowledger(int pageNumber, string batchDigest);
  delegate string[] NativeDirectoryPageReader(int pageNumber, out bool hasMore, out string batchDigest);
  delegate void NativeDirectoryPageAcknowledger(int pageNumber, string batchDigest);
  const int MaxControlFrameBytes = 4096;
  // The init frame may carry the persisted build-trust lists (<=64 builds, <=8 pins).
  const int MaxInitFrameBytes = 16 * 1024;
  const int MaxPageFrameBytes = 1024 * 1024;
  const int MaxInitialImportPageFrameBytes = 8 * 1024 * 1024;
  const int MaxNativeAuxiliaryResultFrameBytes = 32 * 1024;
#if READER_OFFICIAL_SOURCE_TEST
  // Fixture builds scale the idle window so progressing and frozen scans can
  // exercise the same watchdog behavior without two-minute test sleeps.
  const int FirstImportIdleWatchdogMs = 1000;
  const int ScanProgressOpcodeInterval = 10;
  static bool TestSlowProgressLogged;
#else
  const int FirstImportIdleWatchdogMs = 120000;
  const int ScanProgressOpcodeInterval = 1000;
#endif
  const int LineWindowCloseNoticeMs = 2000;
#if READER_FIXTURE_SOURCE_TEST
  const int ProcessQueryInformation = 0x0400;
  const int ProcessQueryLimitedInformation = 0x1000;
  const int ProcessVmRead = 0x0010;
  const uint MemCommit = 0x1000;
  const uint MemPrivate = 0x20000;
  const uint PageGuard = 0x100;
  const int MaxCandidates = 10000;
  const long MaxScanBytes = 1024L * 1024 * 1024;
#endif
#if READER_WATCHDOG_TEST
  const int PreparationTimeoutMs = 700;
  const int MaxSessionTimeoutMs = 700;
#else
  const int PreparationTimeoutMs = 45000;
  const int MaxSessionTimeoutMs = 1800000;
#endif
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxPageFrameBytes };
  static readonly JavaScriptSerializer InitialImportJson = new JavaScriptSerializer { MaxJsonLength = MaxInitialImportPageFrameBytes };
  static Timer watchdog;
  static ProtocolInput protocolInput;
  static bool softWatchdog;
  static string requestId;
  static int outputSequence;
  static int inputSequence;
  const uint SidecarFileReadAttributes = 0x80, SidecarFileShareRead = 1, SidecarFileShareWrite = 2,
    SidecarOpenExisting = 3, SidecarOpenReparsePoint = 0x00200000, SidecarDirectory = 0x10, SidecarReparsePoint = 0x400;
  [StructLayout(LayoutKind.Sequential)] struct SidecarFileInformation {
    internal uint Attributes;
    internal uint CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh, VolumeSerial;
    internal uint SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(
    string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(
    SafeFileHandle handle, out SidecarFileInformation information);
  sealed class OfficialInputMonitor : IDisposable {
    internal readonly CancellationTokenSource Cancellation = new CancellationTokenSource();
    readonly Thread thread;
    bool unexpectedInput;
    internal OfficialInputMonitor(Stream input) {
      thread = new Thread(delegate() {
        try { unexpectedInput = input.ReadByte() != -1; }
        catch { unexpectedInput = true; }
        finally { Cancellation.Cancel(); }
      });
      thread.IsBackground = true;
      thread.Start();
    }
    internal void AwaitEof() {
      if (!thread.Join(5000) || unexpectedInput) throw new InvalidDataException("protocol_invalid");
    }
    public void Dispose() {
      // The reader may still be blocked in ReadByte when the watchdog ends
      // this process. Its finally block must retain a live cancellation source.
      if (thread.Join(0)) Cancellation.Dispose();
    }
  }
#if READER_OFFICIAL_SOURCE_TEST
  internal static string TestOfficialSourceRoot;
  internal static IOfficialSourceInventoryEnvironment TestOfficialSourceEnvironment;
  internal static string TestOfficialPauseStage;
  static void PauseOfficialStage(string stage, CancellationToken cancellation) {
    if (TestOfficialPauseStage != stage) return;
    Console.Error.WriteLine("TEST_STAGE:" + stage);
    cancellation.WaitHandle.WaitOne();
    cancellation.ThrowIfCancellationRequested();
  }
#endif
#if READER_FIXTURE_SOURCE_TEST
  static string diagnosticStage = "startup";
  static int processIdentitySize = Marshal.SizeOf(typeof(MemoryRegion));

  [StructLayout(LayoutKind.Sequential)] struct MemoryRegion {
    public IntPtr BaseAddress;
    public IntPtr AllocationBase;
    public uint AllocationProtect;
    public UIntPtr RegionSize;
    public uint State;
    public uint Protect;
    public uint Type;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int access, bool inherit, int processId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder imageName, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MemoryRegion info, UIntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr length, out UIntPtr read);

  sealed class SourceInventory {
    internal string Root;
    internal string Executable;
    internal string Database;
    internal string Wal;
    internal string Shm;
    internal int ProcessId;
    internal long ProcessCreated;
    internal long EdbLength;
    internal long WalLength;
    internal long EdbLastWriteTicks;
    internal long WalLastWriteTicks;
  }

  sealed class SyntheticProbeEnvironment {
    internal readonly Func<string, string[]> EnumerateDatabaseFiles;
    internal readonly Func<int, Process> OpenProcessById;
    internal SyntheticProbeEnvironment(Func<string, string[]> enumerateDatabaseFiles, Func<int, Process> openProcessById) {
      EnumerateDatabaseFiles = enumerateDatabaseFiles;
      OpenProcessById = openProcessById;
    }
  }
#endif

  sealed class ProtocolInput : Stream {
    const int MaxBufferedBytes = 1024 * 1024;
    readonly Stream source;
    readonly object sync = new object();
    readonly Queue<byte[]> chunks = new Queue<byte[]>();
    readonly AutoResetEvent available = new AutoResetEvent(false);
    readonly Thread reader;
    int bufferedBytes;
    byte[] current; int currentOffset;
    bool eof, timedOut, disposed;
    Exception failure;
    internal readonly CancellationTokenSource Cancellation = new CancellationTokenSource();
    internal ProtocolInput(Stream source) {
      this.source = source;
      reader = new Thread(ReadSource) { IsBackground = true, Name = "js-reader-stdin" };
      reader.Start();
    }
    void ReadSource() {
      byte[] buffer = new byte[4096];
      try {
        for (;;) {
          int count = source.Read(buffer, 0, buffer.Length);
          lock (sync) {
            if (disposed || timedOut) break;
            if (count <= 0) { eof = true; Cancellation.Cancel(); available.Set(); break; }
            if (bufferedBytes + count > MaxBufferedBytes) { failure = new InvalidDataException("protocol_invalid"); eof = true; Cancellation.Cancel(); available.Set(); break; }
            byte[] copy = new byte[count]; Buffer.BlockCopy(buffer, 0, copy, 0, count); chunks.Enqueue(copy); bufferedBytes += count; available.Set();
          }
        }
      } catch (Exception error) {
        lock (sync) { if (!disposed) { failure = error; eof = true; Cancellation.Cancel(); try { available.Set(); } catch { } } }
      } finally { Array.Clear(buffer, 0, buffer.Length); }
    }
    // True when bytes that no frame read has consumed yet are queued (a frame that arrived during wait_change).
    internal bool HasBufferedInput { get { lock (sync) { return chunks.Count > 0 || (current != null && currentOffset < current.Length); } } }
    internal void CancelForTimeout() {
      lock (sync) { if (disposed) return; timedOut = true; eof = true; Cancellation.Cancel(); available.Set(); }
    }
    public override int Read(byte[] buffer, int offset, int count) {
      if (buffer == null || offset < 0 || count < 0 || offset + count > buffer.Length) throw new ArgumentException();
      if (count == 0) return 0;
      for (;;) {
        lock (sync) {
          if (current == null || currentOffset == current.Length) {
            current = null; currentOffset = 0;
            if (chunks.Count > 0) { current = chunks.Dequeue(); bufferedBytes -= current.Length; }
          }
          if (current != null) { int copied = Math.Min(count, current.Length - currentOffset); Buffer.BlockCopy(current, currentOffset, buffer, offset, copied); currentOffset += copied; return copied; }
          if (failure != null) throw new IOException("protocol_input_failed", failure);
          if (eof || disposed) return 0;
        }
        available.WaitOne();
      }
    }
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { throw new NotSupportedException(); } }
    public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    protected override void Dispose(bool disposing) {
      lock (sync) { disposed = true; eof = true; try { available.Set(); } catch { } }
      if (disposing) { try { source.Dispose(); } catch { } try { reader.Join(500); } catch { } Cancellation.Dispose(); available.Dispose(); }
      base.Dispose(disposing);
    }
  }

  internal static int Main(string[] args) {
    try {
      if (args.Length != 2 || args[0] != "--request-id" || args[1].Length != 32) return 2;
      for (int i = 0; i < args[1].Length; i++) if (!Uri.IsHexDigit(args[1][i])) return 2;
      requestId = args[1].ToLowerInvariant();
      ArmWatchdog(PreparationTimeoutMs);
      protocolInput = new ProtocolInput(Console.OpenStandardInput());
      Stream input = protocolInput;
      Stream output = Console.OpenStandardOutput();
      Emit(output, "hello", new Dictionary<string, object> {
      { "bridgeVersion", "candidate-reader-0.2.0" }, { "capability", "fixed_readonly_verify" }
      });

      SetDiagnosticStage("init");
      int initBytes;
      Dictionary<string, object> init = ReadFrame(input, MaxInitFrameBytes, out initBytes);
      if (init.ContainsKey("operation") && (Convert.ToString(init["operation"]) == "verify_official_source" ||
          Convert.ToString(init["operation"]) == "first_import_snapshot" ||
          Convert.ToString(init["operation"]) == "direct_monitor" ||
          Convert.ToString(init["operation"]) == "read_official_identity")) {
        // read_official_identity takes no expectedMid: it reports the account
        // currently logged in to the official LINE (the active candidate).
        bool identityRead = Convert.ToString(init["operation"]) == "read_official_identity";
        RequireFrame(init, "init", identityRead
          ? (init.ContainsKey("trust") ? new string[] { "operation", "deadlineUnixMs", "trust" } : new string[] { "operation", "deadlineUnixMs" })
          : init.ContainsKey("trust")
            ? new string[] { "operation", "expectedMid", "deadlineUnixMs", "trust" }
            : new string[] { "operation", "expectedMid", "deadlineUnixMs" });
        ValidateInit(init);
        Dictionary<string, object> ownerReady = ReadFrame(input);
        RequireFrame(ownerReady, "owner_ready", new string[0]);
        bool firstImport = Convert.ToString(init["operation"]) == "first_import_snapshot";
        bool directMonitor = Convert.ToString(init["operation"]) == "direct_monitor";
        softWatchdog = firstImport || directMonitor;
        if (firstImport || directMonitor) ArmWatchdog(FirstImportIdleWatchdogMs); else ArmDeadline(init);
        OfficialInputMonitor monitor = EmitOfficialSourceInventory(input, output, init, firstImport, directMonitor);
        try {
          Emit(output, "closed", new Dictionary<string, object> { { "sourceAccessed", true } });
          if (monitor == null) RequireEnd(input);
          else monitor.AwaitEof();
        } finally { if (monitor != null) monitor.Dispose(); }
      } else if (init.ContainsKey("operation") && Convert.ToString(init["operation"]) == "verify_local_source") {
#if READER_FIXTURE_SOURCE_TEST
        RunSourceVerification(input, output, init);
#else
        // The packaged candidate intentionally has no authority to discover or
        // inspect a user's LINE installation. Only disposable fixture builds
        // compile the source-verification path.
        throw new InvalidDataException();
#endif
      } else {
        RequireFrame(init, "init", new string[] { "expectedMid", "deadlineUnixMs" });
        ValidateInit(init);
        ArmDeadline(init);
        Emit(output, "inventory", new Dictionary<string, object> {
          { "candidateCount", 0 }, { "processCount", 0 }, { "edbMiB", new int[0] }, { "walMiB", new int[0] }
        });
        Dictionary<string, object> close = ReadFrame(input);
        RequireFrame(close, "close", new string[] { "reason" });
        if (Convert.ToString(close["reason"]) != "fixture_complete") throw new InvalidDataException();
        Emit(output, "closed", new Dictionary<string, object> { { "sourceAccessed", false } });
        RequireEnd(input);
      }
      output.Flush();
      return 0;
    }
#if READER_FIXTURE_SOURCE_TEST
    catch (Exception error) {
      Console.Error.WriteLine("FIXTURE_BRIDGE_FAILURE:" + diagnosticStage + ":" + error.GetType().Name);
      return 4;
    }
#else
    catch { return 4; }
#endif
    finally { softWatchdog = false; if (watchdog != null) watchdog.Dispose(); if (protocolInput != null) protocolInput.Dispose(); }
  }

  static OfficialInputMonitor EmitOfficialSourceInventory(Stream input, Stream output, Dictionary<string, object> init, bool firstImport, bool directMonitor) {
    OfficialInputMonitor monitor = null;
    try {
      string requestDirectory = VerifyOwnedRequestDirectory(init);
      OfficialBuildTrust buildTrust = OfficialBuildTrust.FromInit(init.ContainsKey("trust") ? init["trust"] : null);
      OfficialSourceInventoryResult inventory = ReadInitialOfficialSourceInventory(directMonitor, init, buildTrust);
      Dictionary<string, object> inventoryFrame = new Dictionary<string, object> {
        { "buildCode", inventory.BuildVerdict ?? "accepted" },
        { "buildVersion", inventory.BuildVersion },
        { "buildBytes", inventory.BuildBytes },
        { "buildSha256", inventory.BuildSha256 },
        { "candidateCount", inventory.CandidateCount },
        { "processCount", inventory.ProcessCount },
        { "edbMiB", inventory.EdbMiB },
        { "walMiB", inventory.WalMiB }
      };
      if (directMonitor) inventoryFrame["sourceIdentityDigest"] = DigestText(Convert.ToString(init["expectedMid"]) + "\n" +
        Path.GetFullPath(inventory.DatabasePath).ToLowerInvariant() + "\n" + inventory.DatabaseIdentity.FileId);
      Emit(output, "inventory", inventoryFrame);
      Dictionary<string, object> verify = ReadFrame(input);
      RequireFrame(verify, "verify", directMonitor
        ? new string[] { "workDeadlineUnixMs", "sourceIdentityDigest", "cursor" }
        : new string[] { "workDeadlineUnixMs" });
      if (!(verify["workDeadlineUnixMs"] is int) && !(verify["workDeadlineUnixMs"] is long) &&
          !(verify["workDeadlineUnixMs"] is double)) throw new InvalidDataException("protocol_invalid");
      long workDeadline = Convert.ToInt64(verify["workDeadlineUnixMs"]);
      long absoluteDeadline = Convert.ToInt64(init["deadlineUnixMs"]);
      long workStartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      if (workDeadline <= workStartedAt ||
          (directMonitor && workDeadline > workStartedAt + MaxSessionTimeoutMs) ||
          (!firstImport && !directMonitor && (workDeadline > absoluteDeadline || workDeadline > workStartedAt + MaxSessionTimeoutMs)))
        throw new InvalidDataException("deadline_invalid");
      // Streaming owns stdin for NEXT/ACK; a concurrent EOF reader would race frames.
      monitor = firstImport || directMonitor ? null : new OfficialInputMonitor(input);
      CancellationToken cancellation = protocolInput == null ? CancellationToken.None : protocolInput.Cancellation.Token;
      ArmWatchdog(firstImport || directMonitor ? FirstImportIdleWatchdogMs : (int)Math.Max(1, Math.Min(MaxSessionTimeoutMs, workDeadline - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())));
      byte[] key = null;
      try {
        if (firstImport) {
          Emit(output, "progress", new Dictionary<string, object> { { "phase", "close_line_window" }, { "bytesCopied", null }, { "totalBytes", null },
            { "rowsScanned", null }, { "eligibleCount", null }, { "scanSteps", null } });
          // Let the notice be seen before the window closes; the idle watchdog covers the wait and is re-armed after it.
          ArmWatchdog(FirstImportIdleWatchdogMs + LineWindowCloseNoticeMs);
          if (cancellation.WaitHandle.WaitOne(LineWindowCloseNoticeMs)) cancellation.ThrowIfCancellationRequested();
          ArmWatchdog(FirstImportIdleWatchdogMs);
          OfficialLineMainWindowCloser.CloseVisibleMainWindowToTray(inventory, cancellation);
        }
#if READER_OFFICIAL_SOURCE_TEST
        OfficialSourceKeyProbe.TestAfterFirstRead = delegate(CancellationToken token) { PauseOfficialStage("scan", token); };
        Sqlite3Mc.TestBeforeOfficialQuery = delegate(CancellationToken token) {
          if (TestOfficialPauseStage == "query_fail") throw new InvalidOperationException("DATABASE_READ_FAILED");
          PauseOfficialStage("query", token);
        };
#endif
        ByteProgressReporter keyScanProgress = new ByteProgressReporter(output, "key_scan", -1, firstImport || directMonitor);
        // Only the active (newest) database goes through the key scan; a missing key is the key error, never a fallback.
        // A scan that finds no key is repeated once (page 1 re-read) before the key error is reported.
        key = OfficialSourceKeyProbe.FindWithRescan(inventory,
#if READER_OFFICIAL_SOURCE_TEST
          TestOfficialSourceEnvironment,
#else
          new WindowsOfficialSourceInventoryEnvironment(),
#endif
          DateTimeOffset.FromUnixTimeMilliseconds(workDeadline).UtcDateTime, cancellation, delegate(long scanned) {
            keyScanProgress.Report(scanned, -1);
          });
        keyScanProgress.Flush();
        cancellation.ThrowIfCancellationRequested();
        // The key scan can outlast several live WAL writes. Pin fresh sidecar
        // metadata before RequireActiveMid opens SQLite, while retaining the
        // initial database FileId and executable/process identity checks.
        if (directMonitor) inventory = RefreshDirectMonitorSource(inventory);
        string destination = Path.Combine(requestDirectory, "snapshot");
        // The monitoring target must be the active account: a different logged-in account is not the one to monitor.
        if (!(init.ContainsKey("operation") && Convert.ToString(init["operation"]) == "read_official_identity"))
          RequireActiveMid(inventory, (string)init["expectedMid"], key);
        if (directMonitor) {
          RunDirectMonitor(input, output, init, verify, (string)init["expectedMid"], inventory, key, cancellation, workDeadline);
          return monitor;
        }
        if (init.ContainsKey("operation") && Convert.ToString(init["operation"]) == "read_official_identity") {
          // Read-only: report the account the official LINE is logged in to (active candidate only).
          string directIdentityDigest = DirectSourceIdentityDigest(inventory);
          string ownMid, ownDisplayName, ownPicturePath;
          ReadDirectIdentity(inventory, key, cancellation, out ownMid, out ownDisplayName, out ownPicturePath);
          cancellation.ThrowIfCancellationRequested();
          OfficialSourceInventory.RequireSameSource(inventory,
#if READER_OFFICIAL_SOURCE_TEST
            TestOfficialSourceEnvironment
#else
            new WindowsOfficialSourceInventoryEnvironment()
#endif
          );
          cancellation.ThrowIfCancellationRequested();
          Emit(output, "result", new Dictionary<string, object> {
            { "verdict", "supported" }, { "buildCode", inventory.BuildVerdict ?? "accepted" }, { "buildVersion", inventory.BuildVersion },
            { "mappingCode", "line-profile-mid-v1" }, { "sourceDigest", directIdentityDigest },
            { "liveReadState", "not_tested" },
            { "mid", ownMid }, { "displayName", ownDisplayName }, { "picturePath", ownPicturePath }, { "candidateCount", inventory.CandidateCount }
          });
          return monitor;
        }
        if (!firstImport) {
          // Guard verification reads the live source in place (no snapshot copy/hash/reread): key already proven by the page-1 probe.
          string directDigest = DirectSourceIdentityDigest(inventory);
          // Only a false MID/schema check is a mismatch; I/O, busy and decrypt failures stay source_io_error (guard: unknown, fail-closed).
          VerifyDirectSource(inventory, (string)init["expectedMid"], key, cancellation);
          cancellation.ThrowIfCancellationRequested();
          OfficialSourceInventory.RequireSameSource(inventory,
#if READER_OFFICIAL_SOURCE_TEST
            TestOfficialSourceEnvironment
#else
            new WindowsOfficialSourceInventoryEnvironment()
#endif
          );
          cancellation.ThrowIfCancellationRequested();
          Emit(output, "result", new Dictionary<string, object> {
            { "verdict", "supported" }, { "buildCode", inventory.BuildVerdict ?? "accepted" }, { "buildVersion", inventory.BuildVersion },
            { "mappingCode", "line-profile-mid-v1" }, { "sourceDigest", directDigest },
            { "liveReadState", "not_tested" }
          });
          return monitor;
        }
        LineEncryptedSnapshot.Limits limits = new LineEncryptedSnapshot.Limits {
          MaxDatabaseBytes = 5L * 1024 * 1024 * 1024,
          MaxWalBytes = 512L * 1024 * 1024,
          MaxSnapshotBytes = 5632L * 1024 * 1024,
        };
#if READER_OFFICIAL_SOURCE_TEST
        if (TestOfficialPauseStage == "slow_progress") limits.ReadChunkBytes = 4096;
#endif
#if READER_OFFICIAL_SOURCE_TEST && SQLITE_FIXTURE_WRITER
        if (TestOfficialPauseStage == "source_change_during_backup") {
          using (Sqlite3Mc fixtureWriter = Sqlite3Mc.OpenFixtureWriter(inventory.DatabasePath, key))
            fixtureWriter.CreateFixtureBackupPayload(8 * 1024 * 1024);
          Sqlite3Mc.TestBackupAfterBatch = delegate() {
            string sourceDatabase = Path.Combine(TestOfficialSourceRoot, "Data", "db", "messages.edb");
            using (Sqlite3Mc writer = Sqlite3Mc.OpenFixtureWriter(sourceDatabase, key)) writer.UpdateFixtureBackupMarker();
            Console.Error.WriteLine("TEST_BACKUP_MUTATION:1");
          };
        }
#endif
        // Only first_import_snapshot reaches here: verify_official_source and direct_monitor returned above.
        ByteProgressReporter copyProgress = new ByteProgressReporter(output, "snapshot_copy", -1, true);
        ByteProgressReporter hashProgress = new ByteProgressReporter(output, "snapshot_hash", -1, true);
        LineEncryptedSnapshot.Capture capture;
        using (SafeFileHandle shmGuard = HoldExistingShm(inventory)) {
          capture = LineEncryptedSnapshot.CaptureFixed(inventory.DatabasePath, destination, key, limits, cancellation,
            (string)init["expectedMid"], delegate(string privateDatabase) {
              cancellation.ThrowIfCancellationRequested();
              using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(privateDatabase, key)) {
                try {
                  if (!reader.VerifyOfficialSchemaAndMid((string)init["expectedMid"], cancellation))
                    throw new InvalidDataException("mid_or_schema_mismatch");
                } catch (InvalidDataException) { cancellation.ThrowIfCancellationRequested(); throw; }
                catch { cancellation.ThrowIfCancellationRequested(); throw new InvalidDataException("mid_or_schema_mismatch"); }
              }
              cancellation.ThrowIfCancellationRequested();
            }, delegate(long copied, long total) { copyProgress.Report(copied, total); },
            delegate(long hashed) { copyProgress.Flush(); hashProgress.Report(hashed, -1); });
        }
        copyProgress.Flush(); hashProgress.Flush();
        try {
          OfficialSourceInventory.RequireSameSource(inventory,
#if READER_OFFICIAL_SOURCE_TEST
            TestOfficialSourceEnvironment
#else
            new WindowsOfficialSourceInventoryEnvironment()
#endif
          );
          StreamSnapshotPages(input, output, capture, inventory, (string)init["expectedMid"], key, cancellation);
          return monitor;
        } finally { capture.Cleanup(true); }
      } finally { if (key != null) Array.Clear(key, 0, key.Length); }
    } catch (Exception error) {
      string code = protocolInput != null && protocolInput.Cancellation.IsCancellationRequested ? "cancelled" : SafeInventoryErrorCode(error);
      Dictionary<string, object> failure = new Dictionary<string, object> {
        { "verdict", "unsupported" },
        { "buildCode", code == "build_rotation" ? "rotation" : code == "unsupported_build" ? "unsupported" : "unknown" },
        { "mappingCode", "not_checked" },
        { "errorCode", code }
      };
      // A statically rejected build reports what was observed (finite fields
      // only) so main can record it and, for a signer change, ask the user.
      OfficialBuildDecision rejected = OfficialBuildRejection.DecisionOf(error);
      if (rejected != null && code != "cancelled") {
        failure["buildReason"] = rejected.Reason;
        if (rejected.Version != null) failure["buildVersion"] = rejected.Version;
        if (rejected.Verdict == OfficialBuildVerdict.Rotation && rejected.Thumbprint != null)
          failure["signerThumbprint"] = rejected.Thumbprint;
      }
      Emit(output, "result", failure);
    }
    return monitor;
  }

  // Direct polling opens the encrypted source only for a bounded read. The
  // connection and every SQLite statement are disposed before the page is
  // emitted, so PostgreSQL commit/ACK waiting never pins a source WAL reader.
  static void RunDirectMonitor(Stream input, Stream output, Dictionary<string, object> init,
      Dictionary<string, object> verify, string expectedMid, OfficialSourceInventoryResult initial,
      byte[] key, CancellationToken cancellation, long workDeadline) {
    string sourceIdentity = DigestText(expectedMid + "\n" + Path.GetFullPath(initial.DatabasePath).ToLowerInvariant() + "\n" + initial.DatabaseIdentity.FileId);
    if (!String.Equals(Convert.ToString(verify["sourceIdentityDigest"]), sourceIdentity, StringComparison.Ordinal))
      throw new InvalidDataException("source_changed");
    Dictionary<string, object> cursor = verify["cursor"] as Dictionary<string, object>;
    ValidateDirectCursor(cursor);
    OfficialSourceInventoryResult firstPoll = RefreshDirectMonitorSource(initial);
    string firstIdentity = DigestText(expectedMid + "\n" + Path.GetFullPath(firstPoll.DatabasePath).ToLowerInvariant() + "\n" + firstPoll.DatabaseIdentity.FileId);
    if (!String.Equals(sourceIdentity, firstIdentity, StringComparison.Ordinal)) throw new InvalidDataException("source_changed");
    VerifyDirectSource(firstPoll, expectedMid, key, cancellation);
    Emit(output, "ready", new Dictionary<string, object> {
      { "sourceArchiveFormat", 1 }, { "sourceIdentityDigest", sourceIdentity }, { "schemaVersion", "line-profile-mid-v1" }
    });
    StreamMonitorDirectory(input, output, expectedMid, sourceIdentity, initial, key, cancellation);
    int pageNumber = 0;
    bool roundBoundCaptured = false, roundBoundEmpty = false;
    string roundSignalBefore = null;
    string roundUpperTime = null, roundUpperId = null;
    bool roundTailCaptured = false;
    string[] roundTailRows = null;
    object[] roundTailParsed = null;
    int roundTailOffset = 0;
    Dictionary<string, object> roundUnreadCounts = null;
    for (;;) {
      cancellation.ThrowIfCancellationRequested();
      ArmWatchdog(FirstImportIdleWatchdogMs);
      Dictionary<string, object> poll = ReadNextDirectMonitorRequest(input, output, expectedMid, sourceIdentity, initial, cancellation);
      if (poll.ContainsKey("type") && Convert.ToString(poll["type"]) == "close") {
        RequireFrame(poll, "close", new string[] { "reason" });
        if (Convert.ToString(poll["reason"]) != "monitor_stop") throw new InvalidDataException("protocol_invalid");
        break;
      }
      RequireFrame(poll, "poll", new string[] { "pageNumber", "cursor" });
      int requestedPage = Convert.ToInt32(poll["pageNumber"]);
      if (requestedPage != pageNumber + 1) throw new InvalidDataException("protocol_invalid");
      cursor = poll["cursor"] as Dictionary<string, object>;
      ValidateDirectCursor(cursor);
      OfficialSourceInventoryResult current = RefreshDirectMonitorSource(initial);
      string currentIdentity = DigestText(expectedMid + "\n" + Path.GetFullPath(current.DatabasePath).ToLowerInvariant() + "\n" + current.DatabaseIdentity.FileId);
      if (!String.Equals(sourceIdentity, currentIdentity, StringComparison.Ordinal)) throw new InvalidDataException("source_changed");
      string afterTime = cursor == null ? null : Convert.ToString(cursor["createdTime"]);
      string afterId = cursor == null ? null : Convert.ToString(cursor["id"]);
      bool forwardMore = false; string lastTime = null, lastId = null; string[] candidateRows = new string[0];
      // The change signal is read before and after SQLite is open (see OfficialChangeSignal.Settle).
      // The "before" value is read once per round, before the round upper bound is captured on the first page.
      if (!roundBoundCaptured) roundSignalBefore = OfficialChangeSignal.Read(initial.DatabasePath);
      using (SafeFileHandle shmGuard = HoldExistingShm(current))
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(current.DatabasePath, key)) {
        cancellation.ThrowIfCancellationRequested();
        if (!reader.VerifyOfficialSchemaAndMid(expectedMid, cancellation)) throw new InvalidDataException("mid_or_schema_mismatch");
        if (!roundBoundCaptured) {
          roundBoundEmpty = !reader.ReadMessageHighWater(out roundUpperTime, out roundUpperId);
          roundBoundCaptured = true;
        }
        if (!roundTailCaptured) {
          candidateRows = reader.ReadMessageKeysetPage(afterTime, afterId, 100, out forwardMore, out lastTime, out lastId,
            true, roundBoundEmpty, roundUpperTime, roundUpperId);
          // A zero-row keyset result proves the forward cursor has drained. Capturing here
          // also handles a shortened final candidate page without retaining/refetching rows.
          if (!forwardMore && candidateRows.Length == 0) {
            roundTailRows = reader.ReadMessageTail(50, true, roundBoundEmpty, roundUpperTime, roundUpperId);
            roundTailParsed = new object[roundTailRows.Length];
            for (int i = 0; i < roundTailRows.Length; i++) {
              roundTailParsed[i] = Json.DeserializeObject(roundTailRows[i]);
            }
            bool unreadSupported;
            List<KeyValuePair<string, long>> unread = reader.ReadChatUnreadCounts(out unreadSupported);
            roundUnreadCounts = unreadSupported ? BuildUnreadCounts(unread) : null;
            // Oversized payloads are dropped for this round so they can never starve the page budget.
            if (roundUnreadCounts != null && MeasureRowBytes(roundUnreadCounts) > 128 * 1024) roundUnreadCounts = null;
            roundTailCaptured = true;
          }
        }
      }
      cancellation.ThrowIfCancellationRequested();
      // SQLite is closed here: the baseline for wait_change is the signal from before the round upper bound was captured.
      // A commit after that capture is not in this round, so it must still wake the next wait_change.
      OfficialChangeSignal.Baseline = OfficialChangeSignal.Settle(roundSignalBefore, OfficialChangeSignal.Read(initial.DatabasePath));
      object[] candidateParsed = new object[candidateRows.Length];
      for (int i = 0; i < candidateRows.Length; i++) {
        candidateParsed[i] = Json.DeserializeObject(candidateRows[i]);
      }
      object pageCursor = cursor;
      object[] tailCandidates = roundTailCaptured && roundTailOffset < roundTailRows.Length
        ? SliceObjects(roundTailParsed, roundTailOffset) : new object[0];
      int forwardCount, tailCount;
      // The complete tail key range rides on the page that delivers the last tail slice; its bytes are reserved on every
      // page of a captured round so the final page can never exceed the frame limit.
      Dictionary<string, object> tailWindow = roundTailCaptured && !roundBoundEmpty
        ? BuildTailWindow(roundUpperTime, roundUpperId, roundTailParsed) : null;
      int reservedBytes = (tailWindow == null ? 0 : MeasureRowBytes(tailWindow) + 16) + (roundUnreadCounts == null ? 0 : MeasureRowBytes(roundUnreadCounts) + 16);
      FitPagePrefix(candidateParsed, tailCandidates, requestedPage, cursor, false, forwardMore,
        !roundTailCaptured || tailCandidates.Length > 0, reservedBytes, out forwardCount, out tailCount);
      bool forwardPending = forwardMore || forwardCount < candidateRows.Length;
      bool tailPending = !roundTailCaptured || roundTailOffset + tailCount < roundTailRows.Length;
      bool pageMore = forwardPending || tailPending;
      string[] rows = new string[forwardCount]; Array.Copy(candidateRows, rows, forwardCount);
      object[] parsed = new object[forwardCount]; Array.Copy(candidateParsed, parsed, forwardCount);
      string[] tailRows = new string[tailCount]; object[] tailParsed = new object[tailCount];
      if (tailCount > 0) {
        Array.Copy(roundTailRows, roundTailOffset, tailRows, 0, tailCount);
        Array.Copy(roundTailParsed, roundTailOffset, tailParsed, 0, tailCount);
      }
      string digest = DigestText(String.Join("\n", rows) + "\n--tail--\n" + String.Join("\n", tailRows));
      string emittedTime = forwardCount == 0 ? afterTime : null, emittedId = forwardCount == 0 ? afterId : null;
      if (forwardCount > 0 && !TryReadNativeCursor(parsed[forwardCount - 1] as Dictionary<string, object>, out emittedTime, out emittedId))
        throw new InvalidOperationException("SOURCE_ROW_INVALID");
      pageCursor = emittedTime == null ? null : new Dictionary<string, object> { { "createdTime", emittedTime }, { "id", emittedId } };
      Dictionary<string, object> pageFields = new Dictionary<string, object> {
        { "pageNumber", requestedPage }, { "batchDigest", digest }, { "rows", parsed }, { "tailRows", tailParsed },
        { "lastCursor", pageCursor }, { "hasMore", pageMore }
      };
      if (tailWindow != null && roundTailCaptured && roundTailOffset + tailCount == roundTailRows.Length) pageFields.Add("tailWindow", tailWindow);
      if (!pageMore && roundUnreadCounts != null) pageFields.Add("unreadCounts", roundUnreadCounts);
      EmitPage(output, pageFields);
      Dictionary<string, object> ack = ReadFrame(input);
      RequireFrame(ack, "ack", new string[] { "pageNumber", "batchDigest", "lastCursor" });
      if (!DirectAckMatches(ack, requestedPage, digest, pageCursor))
        throw new InvalidDataException("protocol_invalid");
      if (tailCount > 0) roundTailOffset += tailCount;
      pageNumber++;
      if (!pageMore) {
        roundBoundCaptured = false; roundBoundEmpty = false; roundUpperTime = null; roundUpperId = null; roundSignalBefore = null;
        roundTailCaptured = false; roundTailRows = null; roundTailParsed = null; roundTailOffset = 0; roundUnreadCounts = null;
      }
    }
    cancellation.ThrowIfCancellationRequested();
  }

  // Complete key range of one round tail: ids is every tail row (at most 50); lower is the oldest tail key only when the tail
  // is full, otherwise null (the range reaches the start of the table). Built from rows already read in this round.
  internal static Dictionary<string, object> BuildTailWindow(string upperTime, string upperId, object[] tailParsed) {
    string[] ids = new string[tailParsed.Length];
    object lower = null;
    for (int i = 0; i < tailParsed.Length; i++) {
      string time, id;
      if (!TryReadNativeCursor(tailParsed[i] as Dictionary<string, object>, out time, out id))
        throw new InvalidOperationException("SOURCE_ROW_INVALID");
      ids[i] = id;
      if (i == 0 && tailParsed.Length == 50) lower = new Dictionary<string, object> { { "createdTime", time }, { "id", id } };
    }
    return new Dictionary<string, object> {
      { "upper", new Dictionary<string, object> { { "createdTime", upperTime }, { "id", upperId } } },
      { "lower", lower }, { "complete", true }, { "ids", ids }
    };
  }

  internal static Dictionary<string, object> BuildUnreadCounts(List<KeyValuePair<string, long>> counts) {
    object[] entries = new object[counts.Count];
    for (int i = 0; i < counts.Count; i++) entries[i] = new object[] { counts[i].Key, counts[i].Value };
    return new Dictionary<string, object> { { "entries", entries } };
  }

  static void ValidateDirectCursor(Dictionary<string, object> cursor) {
    if (cursor == null) return;
    if (cursor.Count != 2 || !cursor.ContainsKey("createdTime") || !cursor.ContainsKey("id") ||
        !System.Text.RegularExpressions.Regex.IsMatch(Convert.ToString(cursor["createdTime"]), @"^-?\d+$") ||
        String.IsNullOrEmpty(Convert.ToString(cursor["id"])) || Convert.ToString(cursor["id"]).Length > 512)
      throw new InvalidDataException("protocol_invalid");
  }

  static bool SameCursor(object actual, object expected) {
    if (actual == null || expected == null) return actual == null && expected == null;
    Dictionary<string, object> a = actual as Dictionary<string, object>, e = expected as Dictionary<string, object>;
    return a != null && e != null && a.Count == 2 && e.Count == 2 && a.ContainsKey("createdTime") && a.ContainsKey("id") &&
      e.ContainsKey("createdTime") && e.ContainsKey("id") &&
      Convert.ToString(a["createdTime"]) == Convert.ToString(e["createdTime"]) && Convert.ToString(a["id"]) == Convert.ToString(e["id"]);
  }

  static bool DirectAckMatches(Dictionary<string, object> ack, int pageNumber, string digest, object cursor) {
    return ack != null && ack.ContainsKey("pageNumber") && ack.ContainsKey("batchDigest") && ack.ContainsKey("lastCursor") &&
      Convert.ToInt32(ack["pageNumber"]) == pageNumber && Convert.ToString(ack["batchDigest"]) == digest &&
      SameCursor(ack["lastCursor"], cursor);
  }

  // Auxiliary work is admitted only between acknowledged pages. The caller
  // enters this loop after the prior page ACK and resumes normal polling only
  // when a poll/close frame is returned.
  static Dictionary<string, object> ReadNextDirectMonitorRequest(Stream input, Stream output,
      string expectedMid, string sourceIdentity, OfficialSourceInventoryResult pinned, CancellationToken cancellation) {
    for (;;) {
      cancellation.ThrowIfCancellationRequested();
      int bodyBytes;
      Dictionary<string, object> request = ReadFrame(input, NativeAttachmentOperations.MaxRequestFrameBytes, out bodyBytes);
      string type = Convert.ToString(request.ContainsKey("type") ? request["type"] : null);
      if (String.Equals(type, "auth_candidates", StringComparison.Ordinal)) {
        if (bodyBytes > MaxControlFrameBytes) throw new InvalidDataException("protocol_invalid");
        RequireFrame(request, "auth_candidates", new string[0]);
        Dictionary<string, object> response = new Dictionary<string, object> {
          { "candidates", new object[0] }, { "errorCode", "auth_probe_disabled" }
        };
        EmitAuxiliary(output, "auth_candidates", response);
        continue;
      }
      if (String.Equals(type, "wake", StringComparison.Ordinal)) {
        if (bodyBytes > MaxControlFrameBytes) throw new InvalidDataException("protocol_invalid");
        RequireFrame(request, "wake", new string[0]);
        continue;
      }
      if (String.Equals(type, "wait_change", StringComparison.Ordinal)) {
        if (bodyBytes > MaxControlFrameBytes) throw new InvalidDataException("protocol_invalid");
        RequireFrame(request, "wait_change", new string[] { "timeoutMs" });
        if (!(request["timeoutMs"] is int) || (int)request["timeoutMs"] < 1000 || (int)request["timeoutMs"] > 60000)
          throw new InvalidDataException("protocol_invalid");
        // The idle watchdog is re-armed on every check, so a wait never trips it.
        // Queued input (a wake frame sent by the controller for auxiliary work) ends the wait with changed=false.
        bool changed = OfficialChangeSignal.WaitForChange(pinned.DatabasePath, (int)request["timeoutMs"], cancellation,
          delegate() { ArmWatchdog(FirstImportIdleWatchdogMs); },
          delegate() { return protocolInput != null && protocolInput.HasBufferedInput; });
        ArmWatchdog(FirstImportIdleWatchdogMs);
        Emit(output, "change", new Dictionary<string, object> { { "changed", changed } });
        continue;
      }
      if (String.Equals(type, "attachment_metadata", StringComparison.Ordinal)) {
        RequireFrame(request, "attachment_metadata", new string[] { "envelope", "expectedMessageId", "expectedChatId" });
        Dictionary<string, object> response;
        try {
          string expectedMessageId = request["expectedMessageId"] as string;
          string expectedChatId = request["expectedChatId"] as string;
          object envelopeValue = request["envelope"];
          IDictionary envelopeObject = envelopeValue as IDictionary;
          if (envelopeObject == null)
            throw new InvalidDataException("attachment_metadata_too_large");
          string envelope = InitialImportJson.Serialize(envelopeValue);
          if (Encoding.UTF8.GetByteCount(envelope) > NativeAttachmentOperations.MaxRequestFrameBytes)
            throw new InvalidDataException("attachment_metadata_too_large");
          OfficialSourceInventoryResult current = RefreshDirectMonitorSource(pinned);
          string currentIdentity = DigestText(expectedMid + "\n" + Path.GetFullPath(current.DatabasePath).ToLowerInvariant() + "\n" + current.DatabaseIdentity.FileId);
          if (!String.Equals(sourceIdentity, currentIdentity, StringComparison.Ordinal)) throw new InvalidDataException("source_changed");
          response = NativeAttachmentOperations.DecodeAttachmentEnvelope(envelope, expectedMessageId, expectedChatId, cancellation);
        } catch (OperationCanceledException) { throw; }
        catch (Exception error) {
          response = new Dictionary<string, object> {
            { "metadata", null }, { "errorCode", SafeInventoryErrorCode(error) }
          };
        }
        EmitAuxiliary(output, "attachment_metadata", response);
        continue;
      }
      if (bodyBytes > MaxControlFrameBytes) throw new InvalidDataException("protocol_invalid");
      return request;
    }
  }

  static OfficialSourceInventoryResult RefreshDirectMonitorSource(OfficialSourceInventoryResult pinned) {
    return OfficialSourceInventory.RefreshPinnedSource(pinned, CurrentOfficialSourceEnvironment(), true);
  }

  static IOfficialSourceInventoryEnvironment CurrentOfficialSourceEnvironment() {
#if READER_OFFICIAL_SOURCE_TEST
    return TestOfficialSourceEnvironment;
#else
    return new WindowsOfficialSourceInventoryEnvironment();
#endif
  }

  static void EmitAuxiliary(Stream output, string type, Dictionary<string, object> fields) {
    Dictionary<string, object> value = new Dictionary<string, object> {
      { "version", 1 }, { "requestId", requestId }, { "sequence", outputSequence + 1 }, { "type", type }
    };
    foreach (KeyValuePair<string, object> item in fields) value.Add(item.Key, item.Value);
    byte[] body = Encoding.UTF8.GetBytes(InitialImportJson.Serialize(value));
    if (body.Length > MaxNativeAuxiliaryResultFrameBytes) {
      Array.Clear(body, 0, body.Length);
      value = new Dictionary<string, object> {
        { "version", 1 }, { "requestId", requestId }, { "sequence", outputSequence + 1 }, { "type", type }
      };
      if (String.Equals(type, "auth_candidates", StringComparison.Ordinal)) {
        value.Add("candidates", new object[0]); value.Add("errorCode", "auth_candidates_unavailable");
      } else {
        value.Add("metadata", null); value.Add("errorCode", "attachment_metadata_unavailable");
      }
      body = Encoding.UTF8.GetBytes(InitialImportJson.Serialize(value));
    }
    try {
      if (body.Length < 1 || body.Length > MaxNativeAuxiliaryResultFrameBytes) throw new InvalidDataException("protocol_invalid");
      outputSequence++;
      WriteFrame(output, body);
    } finally { Array.Clear(body, 0, body.Length); }
  }

  static bool TryReadNativeCursor(Dictionary<string, object> row, out string createdTime, out string id) {
    createdTime = null; id = null;
    if (row == null || !row.ContainsKey("createdTime") || !row.ContainsKey("nativeMessageId")) return false;
    createdTime = Convert.ToString(row["createdTime"]); id = Convert.ToString(row["nativeMessageId"]);
    return !String.IsNullOrEmpty(createdTime) && !String.IsNullOrEmpty(id) && id.Length <= 512 &&
      System.Text.RegularExpressions.Regex.IsMatch(createdTime, @"^-?\d+$");
  }

  // Source identity only (no content hashes): file ids and LINE process creation time.
  static string DirectSourceIdentityDigest(OfficialSourceInventoryResult inventory) {
    OfficialSourceFileIdentity wal = inventory.WalIdentity;
    return DigestText(inventory.DatabaseIdentity.FileId + ":" + inventory.ProcessCreationTime + ":" + (wal == null ? "nowal" : wal.FileId));
  }

  static void VerifyDirectSource(OfficialSourceInventoryResult inventory, string expectedMid, byte[] key, CancellationToken cancellation) {
    using (SafeFileHandle shmGuard = HoldExistingShm(inventory))
#if READER_OFFICIAL_SOURCE_TEST
    { PauseOfficialStage("shm_guard", cancellation);
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(inventory.DatabasePath, key)) {
        if (!reader.VerifyOfficialSchemaAndMid(expectedMid, cancellation)) throw new InvalidDataException("mid_or_schema_mismatch");
      }
    }
#else
    using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(inventory.DatabasePath, key)) {
      if (!reader.VerifyOfficialSchemaAndMid(expectedMid, cancellation)) throw new InvalidDataException("mid_or_schema_mismatch");
    }
#endif
  }

  // The key-validated (active) database must belong to expectedMid. Only `_profile._mid` is read here (authorizer);
  // a missing or ambiguous profile is left to the schema check (mid_or_schema_mismatch).
  static void RequireActiveMid(OfficialSourceInventoryResult inventory, string expectedMid, byte[] key) {
    string mid;
    using (SafeFileHandle shmGuard = HoldExistingShm(inventory))
    using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(inventory.DatabasePath, key)) mid = reader.ReadOwnMid();
    if (mid != null && !String.Equals(mid, expectedMid, StringComparison.Ordinal)) throw new InvalidDataException("official_account_not_active");
  }

  // Reads the own MID and display name (_profile first, then _contact)
  // from the active candidate only. A missing or malformed profile is a mismatch.
  static void ReadDirectIdentity(OfficialSourceInventoryResult inventory, byte[] key, CancellationToken cancellation,
      out string mid, out string displayName, out string picturePath) {
    mid = null; displayName = null; picturePath = null;
    using (SafeFileHandle shmGuard = HoldExistingShm(inventory))
    using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(inventory.DatabasePath, key)) {
      string ownMid = reader.ReadOwnMid();
      if (ownMid == null || !reader.VerifyOfficialSchemaAndMid(ownMid, cancellation)) throw new InvalidDataException("mid_or_schema_mismatch");
      mid = ownMid;
      displayName = reader.ReadOwnIdentity(ownMid, out picturePath);
    }
  }

  internal static SafeFileHandle HoldExistingShm(OfficialSourceInventoryResult inventory) {
    if (inventory.WalIdentity == null) return null;
    if (inventory.ShmIdentity == null) throw new InvalidDataException("source_shm_missing");
    SafeFileHandle handle = CreateFileW(inventory.DatabasePath + "-shm", SidecarFileReadAttributes,
      SidecarFileShareRead | SidecarFileShareWrite, IntPtr.Zero, SidecarOpenExisting, SidecarOpenReparsePoint, IntPtr.Zero);
    if (handle == null || handle.IsInvalid) {
      if (handle != null) handle.Dispose();
      throw new InvalidDataException("source_shm_missing");
    }
    SidecarFileInformation info;
    if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & (SidecarDirectory | SidecarReparsePoint)) != 0) {
      handle.Dispose();
      throw new InvalidDataException("source_reparse_or_type");
    }
    // LINE owns its WAL sidecars and may recreate -shm; its FileId is not target identity.
    // Omit FILE_SHARE_DELETE while SQLite uses the already-existing WAL index.
    // This prevents a racing sidecar rotation from turning readonly open into creation.
    return handle;
  }

  static void StreamSnapshotPages(Stream input, Stream output, LineEncryptedSnapshot.Capture capture,
      OfficialSourceInventoryResult inventory, string expectedMid, byte[] key, CancellationToken cancellation) {
    ArmWatchdog(FirstImportIdleWatchdogMs);
    string sourceIdentity = DigestText(expectedMid + "\n" + Path.GetFullPath(inventory.DatabasePath).ToLowerInvariant() + "\n" + inventory.DatabaseIdentity.FileId);
    string snapshotDigest = DigestText(capture.DatabaseSha256 + ":" + (capture.WalSha256 ?? "") + ":" + capture.DatabaseBytes + ":" + capture.WalBytes);
    using (Sqlite3Mc snapshot = Sqlite3Mc.OpenReadOnly(capture.DatabasePath, key)) {
      using (Sqlite3Mc.InitialImportPrefetcher prefetch = new Sqlite3Mc.InitialImportPrefetcher(snapshot, cancellation)) {
      bool producerStarted = false;
      snapshot.EnableScanProgress(prefetch.CancellationToken, delegate(string phase, long steps) {
        if (producerStarted) prefetch.PublishProgress(phase, steps);
        else {
          ArmWatchdog(FirstImportIdleWatchdogMs);
          Emit(output, "progress", new Dictionary<string, object> { { "phase", phase }, { "bytesCopied", null }, { "totalBytes", null },
            { "rowsScanned", null }, { "eligibleCount", null }, { "scanSteps", steps.ToString(System.Globalization.CultureInfo.InvariantCulture) } });
        }
#if READER_OFFICIAL_SOURCE_TEST
        if (TestOfficialPauseStage == "slow_progress") {
          if (!TestSlowProgressLogged) { TestSlowProgressLogged = true; Console.Error.WriteLine("TEST_STAGE:slow_progress"); }
          Thread.Sleep(250);
        }
#endif
      }, ScanProgressOpcodeInterval);
      object[] bounds = snapshot.ReadMessageSnapshotBounds();
      long count = Convert.ToInt64(bounds[0]);
      string highTime = bounds[1] == null ? null : Convert.ToString(bounds[1]);
      string highId = bounds[2] == null ? null : Convert.ToString(bounds[2]);
      Emit(output, "ready", new Dictionary<string, object> {
        { "sourceArchiveFormat", 1 }, { "sourceIdentityDigest", sourceIdentity }, { "snapshotDigest", snapshotDigest }, { "schemaVersion", "line-profile-mid-v1" },
        { "eligibleCount", count.ToString() }, { "highWatermark", highTime == null ? null : new Dictionary<string, object>{{"createdTime",highTime},{"id",highId}} }
      });
      StreamDirectoryPages(input, output, snapshot.ReadNativeDirectoryPage, snapshot.AckNativeDirectoryPage, cancellation);
      StreamSnapshotCatalog(input, output, snapshot, snapshotDigest, cancellation);
      int pageNumber = 0; long rowsRead = 0; string afterTime = null, afterId = null;
      Sqlite3Mc.InitialImportPrefetcher.WindowBuffer currentPageWindow = null;
      int currentChunkIndex = 0, currentChunkOffset = 0;
      while (true) {
        cancellation.ThrowIfCancellationRequested();
        Dictionary<string, object> next = ReadFrame(input);
        RequireFrame(next, "next", new string[] { "pageNumber", "limitRows", "cursor" });
        int requestedPage = Convert.ToInt32(next["pageNumber"]), limit = Convert.ToInt32(next["limitRows"]);
        ArmWatchdog(FirstImportIdleWatchdogMs);
        if (requestedPage != pageNumber + 1 || limit < 1 || limit > 2000) throw new InvalidDataException("protocol_invalid");
        if (pageNumber == 0 && next["cursor"] != null) {
          Dictionary<string, object> start = next["cursor"] as Dictionary<string, object>;
          if (start == null || !start.ContainsKey("createdTime") || !start.ContainsKey("id") ||
              !System.Text.RegularExpressions.Regex.IsMatch(Convert.ToString(start["createdTime"]), @"^-?\d+$") ||
              String.IsNullOrEmpty(Convert.ToString(start["id"]))) throw new InvalidDataException("protocol_invalid");
          afterTime = Convert.ToString(start["createdTime"]); afterId = Convert.ToString(start["id"]);
        }
        DrainPrefetchProgress(prefetch, output);
        if (pageNumber == 0) { producerStarted = true; prefetch.Start(afterTime, afterId); }
        Sqlite3Mc.InitialImportPrefetcher.WindowBuffer current = null;
        int chunkIndex = 0, chunkOffset = 0;
        // The current acknowledged window remains in the two-slot budget until its last ACK.
        // Keep the local reference across requests and only release it after validating ACK.
        if (pageNumber > 0) current = currentPageWindow;
        if (current == null) current = prefetch.AcquireWindow(delegate { DrainPrefetchProgress(prefetch, output); });
        if (current == null && rowsRead < count) throw new InvalidOperationException("SOURCE_PREFETCH_EMPTY");
        bool hasActualWindow = current != null;
        if (current == null) current = new Sqlite3Mc.InitialImportPrefetcher.WindowBuffer();
        if (pageNumber > 0) { chunkIndex = currentChunkIndex; chunkOffset = currentChunkOffset; }
        Sqlite3Mc.InitialImportBufferedRow[] chunk = current.Chunks.Count == 0 ? new Sqlite3Mc.InitialImportBufferedRow[0] : current.Chunks[chunkIndex];
        int candidateRows = Math.Min(limit, chunk.Length - chunkOffset);
        int rowsBeforePage = chunkOffset;
        for (int preceding = 0; preceding < chunkIndex; preceding++) rowsBeforePage = checked(rowsBeforePage + current.Chunks[preceding].Length);
        string[] candidateJson = new string[candidateRows];
        object[] candidateParsed = new object[candidateRows];
        for (int i = 0; i < candidateRows; i++) {
          candidateJson[i] = chunk[chunkOffset + i].Json;
          candidateParsed[i] = InitialImportJson.DeserializeObject(candidateJson[i]);
        }
        int pageRows, unusedTailRows;
        bool moreAfterCandidate = current.RowCount > rowsBeforePage + candidateRows || current.HasMore;
        FitPagePrefix(candidateParsed, new object[0], requestedPage, null, true, moreAfterCandidate, false,
          out pageRows, out unusedTailRows);
        Sqlite3Mc.InitialImportBufferedRow[] selected = new Sqlite3Mc.InitialImportBufferedRow[pageRows];
        if (pageRows > 0) Array.Copy(chunk, chunkOffset, selected, 0, pageRows);
        string[] rows = new string[pageRows];
        object[] parsedRows = new object[pageRows];
        Array.Copy(candidateJson, rows, pageRows); Array.Copy(candidateParsed, parsedRows, pageRows);
        string lastTime = pageRows == 0 ? null : selected[pageRows - 1].CreatedTime;
        string lastId = pageRows == 0 ? null : selected[pageRows - 1].Id;
        bool more = current.RowCount > rowsBeforePage + pageRows || current.HasMore;
        string digest = DigestText(String.Join("\n", rows));
        EmitPage(output, new Dictionary<string, object> {
          { "pageNumber", requestedPage }, { "batchDigest", digest }, { "rows", parsedRows },
          { "lastCursor", pageRows == 0 ? null : new Dictionary<string, object>{{"createdTime",lastTime},{"id",lastId}} }, { "hasMore", more }
        }, true);
        Dictionary<string, object> ack = ReadFrame(input);
        RequireFrame(ack, "ack", new string[] { "pageNumber", "batchDigest", "lastCursor" });
        if (Convert.ToInt32(ack["pageNumber"]) != requestedPage || Convert.ToString(ack["batchDigest"]) != digest) throw new InvalidDataException("protocol_invalid");
        Dictionary<string, object> ackCursor = ack["lastCursor"] as Dictionary<string, object>;
        if (pageRows == 0 ? ack["lastCursor"] != null : ackCursor == null || Convert.ToString(ackCursor["createdTime"]) != lastTime || Convert.ToString(ackCursor["id"]) != lastId)
          throw new InvalidDataException("protocol_invalid");
        pageNumber++; rowsRead += pageRows;
        if (pageRows > 0) chunkOffset += pageRows;
        if (current.Chunks.Count == 0 || chunkOffset == chunk.Length) {
          if (current.Chunks.Count > 0) { chunkIndex++; chunkOffset = 0; }
          if (chunkIndex >= current.Chunks.Count) {
            if (hasActualWindow) prefetch.ReleaseWindow(current);
            currentPageWindow = null; currentChunkIndex = 0; currentChunkOffset = 0;
          } else {
            currentPageWindow = current; currentChunkIndex = chunkIndex; currentChunkOffset = chunkOffset;
          }
        } else {
          currentPageWindow = current; currentChunkIndex = chunkIndex; currentChunkOffset = chunkOffset;
        }
        ArmWatchdog(FirstImportIdleWatchdogMs);
        DrainPrefetchProgress(prefetch, output);
        if (!more) break;
      }
      Dictionary<string, object> done = ReadFrame(input);
      RequireFrame(done, "done", new string[] { "pageCount", "rowCount" });
      if (Convert.ToInt32(done["pageCount"]) != pageNumber || Convert.ToInt64(done["rowCount"]) != rowsRead) throw new InvalidDataException("protocol_invalid");
      Emit(output, "complete", new Dictionary<string, object> { { "sourceIdentityDigest", sourceIdentity }, { "snapshotDigest", snapshotDigest },
        { "pageCount", pageNumber }, { "rowCount", rowsRead }, { "highWatermark", highTime == null ? null : new Dictionary<string, object>{{"createdTime",highTime},{"id",highId}} } });
      }
    }
  }

  static void StreamSnapshotCatalog(Stream input, Stream output, Sqlite3Mc snapshot, string snapshotDigest,
      CancellationToken cancellation) {
    StreamCatalogPages(input, output, snapshotDigest, snapshot.ReadNativeCatalogPage,
      snapshot.AckNativeCatalogPage, cancellation);
  }

  static void StreamCatalogPages(Stream input, Stream output, string snapshotDigest,
      NativeCatalogPageReader readPage, NativeCatalogPageAcknowledger acknowledgePage,
      CancellationToken cancellation) {
    int pageNumber = 0;
    for (;;) {
      cancellation.ThrowIfCancellationRequested();
      ArmWatchdog(FirstImportIdleWatchdogMs);
      Dictionary<string, object> request = ReadFrame(input);
      RequireFrame(request, "catalog_next", new string[] { "pageNumber" });
      int requestedPage = Convert.ToInt32(request["pageNumber"]);
      if (requestedPage != pageNumber + 1) throw new InvalidDataException("protocol_invalid");

      bool hasMore;
      string digest;
      string[] rows = readPage(requestedPage, snapshotDigest, out hasMore, out digest);
      if (rows == null || rows.Length > 1000 || (rows.Length == 0 && hasMore) ||
          !System.Text.RegularExpressions.Regex.IsMatch(digest ?? "", "^[a-f0-9]{64}$"))
        throw new InvalidOperationException("SOURCE_CATALOG_PAGE_INVALID");
      EmitCatalogPage(output, requestedPage, digest, rows, hasMore);

      Dictionary<string, object> ack = ReadFrame(input);
      RequireFrame(ack, "catalog_ack", new string[] { "pageNumber", "batchDigest" });
      if (Convert.ToInt32(ack["pageNumber"]) != requestedPage ||
          !String.Equals(Convert.ToString(ack["batchDigest"]), digest, StringComparison.Ordinal))
        throw new InvalidDataException("protocol_invalid");
      acknowledgePage(requestedPage, digest);
      pageNumber = requestedPage;
      if (!hasMore) return;
    }
  }

  // Friend/conversation name pass. Ack-driven like the catalog; the pager caps each
  // page's payload so it stays under the monitor's 1 MiB frame limit.
  static void StreamDirectoryPages(Stream input, Stream output, NativeDirectoryPageReader readPage,
      NativeDirectoryPageAcknowledger acknowledgePage, CancellationToken cancellation) {
    int pageNumber = 0;
    for (;;) {
      cancellation.ThrowIfCancellationRequested();
      ArmWatchdog(FirstImportIdleWatchdogMs);
      Dictionary<string, object> request = ReadFrame(input);
      RequireFrame(request, "directory_next", new string[] { "pageNumber" });
      int requestedPage = Convert.ToInt32(request["pageNumber"]);
      if (requestedPage != pageNumber + 1) throw new InvalidDataException("protocol_invalid");
      bool hasMore;
      string digest;
      string[] rows = readPage(requestedPage, out hasMore, out digest);
      if (rows == null || rows.Length > 2000 || (rows.Length == 0 && hasMore) ||
          !System.Text.RegularExpressions.Regex.IsMatch(digest ?? "", "^[a-f0-9]{64}$"))
        throw new InvalidOperationException("SOURCE_DIRECTORY_PAGE_INVALID");
      EmitCatalogPage(output, requestedPage, digest, rows, hasMore, "directory_page");
      Dictionary<string, object> ack = ReadFrame(input);
      RequireFrame(ack, "directory_ack", new string[] { "pageNumber", "batchDigest" });
      if (Convert.ToInt32(ack["pageNumber"]) != requestedPage ||
          !String.Equals(Convert.ToString(ack["batchDigest"]), digest, StringComparison.Ordinal))
        throw new InvalidDataException("protocol_invalid");
      acknowledgePage(requestedPage, digest);
      pageNumber = requestedPage;
      if (!hasMore) return;
    }
  }

  // Direct monitor: one directory pass per reader session. Each page opens the
  // verified current source and closes it before the page is emitted.
  static void StreamMonitorDirectory(Stream input, Stream output, string expectedMid, string sourceIdentity,
      OfficialSourceInventoryResult pinned, byte[] key, CancellationToken cancellation) {
    Sqlite3Mc.NativeDirectoryPager pager = new Sqlite3Mc.NativeDirectoryPager();
    NativeDirectoryPageReader read = delegate(int page, out bool more, out string digest) {
      OfficialSourceInventoryResult current = RefreshDirectMonitorSource(pinned);
      string currentIdentity = DigestText(expectedMid + "\n" + Path.GetFullPath(current.DatabasePath).ToLowerInvariant() + "\n" + current.DatabaseIdentity.FileId);
      if (!String.Equals(sourceIdentity, currentIdentity, StringComparison.Ordinal)) throw new InvalidDataException("source_changed");
      using (SafeFileHandle shmGuard = HoldExistingShm(current))
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(current.DatabasePath, key)) {
        cancellation.ThrowIfCancellationRequested();
        if (!reader.VerifyOfficialSchemaAndMid(expectedMid, cancellation)) throw new InvalidDataException("mid_or_schema_mismatch");
        return pager.ReadPage(reader, page, out more, out digest);
      }
    };
    StreamDirectoryPages(input, output, read, pager.Ack, cancellation);
  }

  static void EmitCatalogPage(Stream output, int pageNumber, string digest, string[] rows, bool hasMore, string frameType = "catalog_page") {
    StringBuilder bodyText = new StringBuilder();
    bodyText.Append("{\"version\":1,\"requestId\":\"").Append(requestId)
      .Append("\",\"sequence\":").Append((outputSequence + 1).ToString(System.Globalization.CultureInfo.InvariantCulture))
      .Append(",\"type\":\"").Append(frameType).Append("\",\"pageNumber\":").Append(pageNumber.ToString(System.Globalization.CultureInfo.InvariantCulture))
      .Append(",\"batchDigest\":\"").Append(digest).Append("\",\"rows\":[");
    for (int i = 0; i < rows.Length; i++) {
      if (String.IsNullOrEmpty(rows[i])) throw new InvalidOperationException("SOURCE_CATALOG_ROW_INVALID");
      if (i > 0) bodyText.Append(',');
      bodyText.Append(rows[i]);
    }
    bodyText.Append("],\"hasMore\":").Append(hasMore ? "true" : "false").Append('}');
    byte[] body = Encoding.UTF8.GetBytes(bodyText.ToString());
    try {
      if (body.Length < 1 || body.Length > MaxInitialImportPageFrameBytes ||
          3L * body.Length + 128L * rows.Length + 65536L > MaxInitialImportPageFrameBytes)
        throw new InvalidOperationException("SOURCE_CATALOG_PAGE_TOO_LARGE");
      outputSequence++;
      WriteFrame(output, body);
    }
    finally { Array.Clear(body, 0, body.Length); }
  }

#if READER_OFFICIAL_SOURCE_TEST
  internal static string[] FixtureRunCatalogWire(string fixtureRequestId, string snapshotDigest,
      string[][] pages, bool[] hasMore, int wrongAckPage, bool cancelBeforeRead) {
    if (String.IsNullOrEmpty(fixtureRequestId) || fixtureRequestId.Length != 32 || pages == null ||
        hasMore == null || pages.Length == 0 || pages.Length != hasMore.Length || wrongAckPage < 0 || wrongAckPage > pages.Length)
      throw new ArgumentException("FIXTURE_CATALOG_INPUT_INVALID");
    string priorRequestId = requestId; int priorInputSequence = inputSequence, priorOutputSequence = outputSequence;
    string[] frames = null;
    requestId = fixtureRequestId.ToLowerInvariant(); inputSequence = 0; outputSequence = 0;
    try {
      using (MemoryStream input = new MemoryStream())
      using (MemoryStream output = new MemoryStream()) {
        int inputFrameSequence = 0;
        for (int i = 0; i < pages.Length; i++) {
          if (pages[i] == null || pages[i].Length > 1000 || (pages[i].Length == 0 && hasMore[i]))
            throw new ArgumentException("FIXTURE_CATALOG_PAGE_INVALID");
          string digest = DigestText(String.Join("\n", pages[i]));
          WriteFixtureProtocolFrame(input, ++inputFrameSequence, "catalog_next", new Dictionary<string, object> {
            { "pageNumber", i + 1 }
          });
          string ackDigest = wrongAckPage == i + 1 ? (digest == new string('a', 64) ? new string('b', 64) : new string('a', 64)) : digest;
          WriteFixtureProtocolFrame(input, ++inputFrameSequence, "catalog_ack", new Dictionary<string, object> {
            { "pageNumber", i + 1 }, { "batchDigest", ackDigest }
          });
        }
        input.Position = 0;
        int readIndex = 0, acknowledged = 0;
        NativeCatalogPageReader readPage = delegate(int page, string requestedSnapshot, out bool more, out string digest) {
          if (page != readIndex + 1 || requestedSnapshot != snapshotDigest || readIndex >= pages.Length)
            throw new InvalidOperationException("FIXTURE_CATALOG_READ_SEQUENCE_INVALID");
          more = hasMore[readIndex];
          digest = DigestText(String.Join("\n", pages[readIndex]));
          return pages[readIndex++];
        };
        NativeCatalogPageAcknowledger acknowledge = delegate(int page, string digest) {
          if (page != acknowledged + 1 || page > pages.Length || digest != DigestText(String.Join("\n", pages[page - 1])))
            throw new InvalidOperationException("FIXTURE_CATALOG_ACK_SEQUENCE_INVALID");
          acknowledged++;
        };
        bool rejected = false;
        using (CancellationTokenSource cancellation = new CancellationTokenSource()) {
          if (cancelBeforeRead) cancellation.Cancel();
          try { StreamCatalogPages(input, output, snapshotDigest, readPage, acknowledge, cancellation.Token); }
          catch (OperationCanceledException) { if (!cancelBeforeRead) throw; rejected = true; }
          catch (InvalidDataException) { if (wrongAckPage == 0) throw; rejected = true; }
        }
        if (cancelBeforeRead) {
          if (!rejected || readIndex != 0 || acknowledged != 0 || output.Length != 0)
            throw new InvalidOperationException("FIXTURE_CATALOG_CANCEL_ADVANCED");
        } else if (wrongAckPage > 0) {
          if (!rejected || readIndex != wrongAckPage || acknowledged != wrongAckPage - 1)
            throw new InvalidOperationException("FIXTURE_CATALOG_BAD_ACK_ADVANCED");
        } else if (acknowledged != pages.Length || readIndex != pages.Length) {
          throw new InvalidOperationException("FIXTURE_CATALOG_NOT_DRAINED");
        }
        byte[] framed = output.ToArray();
        try { frames = ReadFixtureProtocolBodies(framed); }
        finally { Array.Clear(framed, 0, framed.Length); }
      }
      return frames;
    } finally {
      if (watchdog != null) { watchdog.Dispose(); watchdog = null; }
      requestId = priorRequestId; inputSequence = priorInputSequence; outputSequence = priorOutputSequence;
    }
  }

  internal static string[] FixtureRunDirectoryWire(string fixtureRequestId, string[][] pages, bool[] hasMore, int wrongAckPage) {
    if (String.IsNullOrEmpty(fixtureRequestId) || fixtureRequestId.Length != 32 || pages == null || hasMore == null ||
        pages.Length == 0 || pages.Length != hasMore.Length || wrongAckPage < 0 || wrongAckPage > pages.Length)
      throw new ArgumentException("FIXTURE_DIRECTORY_INPUT_INVALID");
    string priorRequestId = requestId; int priorInputSequence = inputSequence, priorOutputSequence = outputSequence;
    requestId = fixtureRequestId.ToLowerInvariant(); inputSequence = 0; outputSequence = 0;
    try {
      using (MemoryStream input = new MemoryStream())
      using (MemoryStream output = new MemoryStream()) {
        int inputFrameSequence = 0;
        for (int i = 0; i < pages.Length; i++) {
          string digest = DigestText(String.Join("\n", pages[i]));
          WriteFixtureProtocolFrame(input, ++inputFrameSequence, "directory_next", new Dictionary<string, object> { { "pageNumber", i + 1 } });
          string ackDigest = wrongAckPage == i + 1 ? (digest == new string('a', 64) ? new string('b', 64) : new string('a', 64)) : digest;
          WriteFixtureProtocolFrame(input, ++inputFrameSequence, "directory_ack", new Dictionary<string, object> {
            { "pageNumber", i + 1 }, { "batchDigest", ackDigest }
          });
        }
        input.Position = 0;
        int readIndex = 0, acknowledged = 0;
        NativeDirectoryPageReader readPage = delegate(int page, out bool more, out string digest) {
          if (page != readIndex + 1 || readIndex >= pages.Length) throw new InvalidOperationException("FIXTURE_DIRECTORY_READ_SEQUENCE_INVALID");
          more = hasMore[readIndex];
          digest = DigestText(String.Join("\n", pages[readIndex]));
          return pages[readIndex++];
        };
        NativeDirectoryPageAcknowledger acknowledge = delegate(int page, string digest) { acknowledged++; };
        bool rejected = false;
        using (CancellationTokenSource cancellation = new CancellationTokenSource()) {
          try { StreamDirectoryPages(input, output, readPage, acknowledge, cancellation.Token); }
          catch (InvalidDataException) { if (wrongAckPage == 0) throw; rejected = true; }
        }
        if (wrongAckPage > 0 && (!rejected || acknowledged != wrongAckPage - 1)) throw new InvalidOperationException("FIXTURE_DIRECTORY_BAD_ACK_ADVANCED");
        if (wrongAckPage == 0 && acknowledged != pages.Length) throw new InvalidOperationException("FIXTURE_DIRECTORY_NOT_DRAINED");
        byte[] framed = output.ToArray();
        try { return ReadFixtureProtocolBodies(framed); }
        finally { Array.Clear(framed, 0, framed.Length); }
      }
    } finally {
      if (watchdog != null) { watchdog.Dispose(); watchdog = null; }
      requestId = priorRequestId; inputSequence = priorInputSequence; outputSequence = priorOutputSequence;
    }
  }

  static void WriteFixtureProtocolFrame(Stream output, int sequence, string type, Dictionary<string, object> fields) {
    Dictionary<string, object> frame = new Dictionary<string, object> {
      { "version", 1 }, { "requestId", requestId }, { "sequence", sequence }, { "type", type }
    };
    foreach (KeyValuePair<string, object> field in fields) frame.Add(field.Key, field.Value);
    byte[] body = Encoding.UTF8.GetBytes(Json.Serialize(frame));
    try { WriteFrame(output, body); } finally { Array.Clear(body, 0, body.Length); }
  }

  static string[] ReadFixtureProtocolBodies(byte[] framed) {
    List<string> bodies = new List<string>(); int offset = 0;
    while (offset < framed.Length) {
      if (framed.Length - offset < 4) throw new InvalidDataException("FIXTURE_CATALOG_FRAME_INVALID");
      int length = (framed[offset] << 24) | (framed[offset + 1] << 16) | (framed[offset + 2] << 8) | framed[offset + 3];
      offset += 4;
      if (length < 1 || length > framed.Length - offset) throw new InvalidDataException("FIXTURE_CATALOG_FRAME_INVALID");
      bodies.Add(Encoding.UTF8.GetString(framed, offset, length)); offset += length;
    }
    return bodies.ToArray();
  }
#endif

#if READER_ATTACHMENT_AUX_TEST && READER_OFFICIAL_SOURCE_TEST
  internal static string[] FixtureRunDirectMonitorAuxWire(string fixtureRequestId, string fixtureRoot,
      IOfficialSourceInventoryEnvironment environment, string expectedMid, byte[] requests,
      int expectedAckPage, string expectedAckDigest, object expectedAckCursor) {
    string priorRequestId = requestId;
    int priorInputSequence = inputSequence, priorOutputSequence = outputSequence;
    string priorRoot = TestOfficialSourceRoot;
    IOfficialSourceInventoryEnvironment priorEnvironment = TestOfficialSourceEnvironment;
    try {
      requestId = fixtureRequestId; inputSequence = 0; outputSequence = 0;
      TestOfficialSourceRoot = fixtureRoot; TestOfficialSourceEnvironment = environment;
      OfficialSourceInventoryResult source = ReadOfficialSourceInventory(true);
      string sourceIdentity = DigestText(expectedMid + "\n" + Path.GetFullPath(source.DatabasePath).ToLowerInvariant() + "\n" + source.DatabaseIdentity.FileId);
      using (MemoryStream input = new MemoryStream(requests, false))
      using (MemoryStream output = new MemoryStream()) {
        Dictionary<string, object> poll = ReadNextDirectMonitorRequest(input, output, expectedMid, sourceIdentity, source, CancellationToken.None);
        if (Convert.ToString(poll["type"]) != "poll") throw new InvalidDataException("protocol_invalid");
        Dictionary<string, object> ack = ReadFrame(input);
        RequireFrame(ack, "ack", new string[] { "pageNumber", "batchDigest", "lastCursor" });
        bool accepted = DirectAckMatches(ack, expectedAckPage, expectedAckDigest, expectedAckCursor);
        if (input.Position != input.Length) throw new InvalidDataException("protocol_invalid");
        byte[] emitted = output.ToArray();
        try { return new string[] { String.Join("\n", ReadFixtureProtocolBodies(emitted)), InitialImportJson.Serialize(poll), accepted ? "1" : "0" }; }
        finally { Array.Clear(emitted, 0, emitted.Length); }
      }
    } finally {
      requestId = priorRequestId; inputSequence = priorInputSequence; outputSequence = priorOutputSequence;
      TestOfficialSourceRoot = priorRoot; TestOfficialSourceEnvironment = priorEnvironment;
    }
  }

  internal static string FixtureRunOversizedAuxiliaryEmission(string fixtureRequestId) {
    string priorRequestId = requestId; int priorOutputSequence = outputSequence;
    try {
      requestId = fixtureRequestId; outputSequence = 0;
      using (MemoryStream output = new MemoryStream()) {
        EmitAuxiliary(output, "attachment_metadata", new Dictionary<string, object> {
          { "metadata", new string('x', MaxNativeAuxiliaryResultFrameBytes + 1) }, { "errorCode", null }
        });
        byte[] framed = output.ToArray();
        try { return ReadFixtureProtocolBodies(framed)[0]; }
        finally { Array.Clear(framed, 0, framed.Length); }
      }
    } finally { requestId = priorRequestId; outputSequence = priorOutputSequence; }
  }
#endif

  static void DrainPrefetchProgress(Sqlite3Mc.InitialImportPrefetcher prefetch, Stream output) {
    string phase; long steps;
    if (!prefetch.TryTakeProgress(out phase, out steps)) return;
    ArmWatchdog(FirstImportIdleWatchdogMs);
    Emit(output, "progress", new Dictionary<string, object> { { "phase", phase }, { "bytesCopied", null }, { "totalBytes", null },
      { "rowsScanned", null }, { "eligibleCount", null }, { "scanSteps", steps.ToString(System.Globalization.CultureInfo.InvariantCulture) } });
  }

  static string DigestText(string value) {
    using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant();
  }

  static string VerifyOwnedRequestDirectory(Dictionary<string, object> init) {
    string directory = Path.GetFullPath(Environment.CurrentDirectory);
    if (!String.Equals(Path.GetFileName(directory), "probe-" + requestId, StringComparison.OrdinalIgnoreCase))
      throw new InvalidDataException("owner_invalid");
    string markerPath = Path.Combine(directory, "owner.json");
    if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0 ||
        (File.GetAttributes(markerPath) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 ||
        new FileInfo(markerPath).Length > 2048) throw new InvalidDataException("owner_invalid");
    Dictionary<string, object> marker = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(markerPath));
    Process self = Process.GetCurrentProcess();
#if !READER_OFFICIAL_SOURCE_TEST
    long startedAt = self.StartTime.ToUniversalTime().ToFileTimeUtc();
    string image = Path.GetFullPath(self.MainModule.FileName);
#endif
    if (marker == null || Convert.ToString(marker["phase"]) != "owned" ||
        Convert.ToString(marker["requestId"]) != requestId ||
        Convert.ToInt32(marker["childPid"]) != self.Id ||
#if !READER_OFFICIAL_SOURCE_TEST
        Convert.ToString(marker["childStartedAt"]) != startedAt.ToString() ||
        !String.Equals(Path.GetFullPath(Convert.ToString(marker["childImagePath"])), image, StringComparison.OrdinalIgnoreCase) ||
#endif
        Convert.ToInt64(marker["deadlineUnixMs"]) != Convert.ToInt64(init["deadlineUnixMs"]))
      throw new InvalidDataException("owner_invalid");
    return directory;
  }

  internal static OfficialSourceInventoryResult ReadOfficialSourceInventory(bool requireWalShm = false, OfficialBuildTrust trust = null) {
#if READER_OFFICIAL_SOURCE_TEST
    if (String.IsNullOrEmpty(TestOfficialSourceRoot) || TestOfficialSourceEnvironment == null) throw new InvalidDataException();
    string root = TestOfficialSourceRoot;
    IOfficialSourceInventoryEnvironment environment = TestOfficialSourceEnvironment;
#else
    string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    if (String.IsNullOrEmpty(localAppData)) throw new IOException("source_io_error");
    string root = Path.Combine(localAppData, "LINE");
    IOfficialSourceInventoryEnvironment environment = new WindowsOfficialSourceInventoryEnvironment();
#endif
    return OfficialSourceInventory.Inspect(root, trust ?? OfficialBuildTrust.Seeds(), environment, requireWalShm);
  }

  static OfficialSourceInventoryResult ReadInitialOfficialSourceInventory(bool requireWalShm, Dictionary<string, object> init, OfficialBuildTrust trust) {
    const int retryCount = 3;
    const int retryDelayMs = 250;
    CancellationToken cancellation = protocolInput == null ? CancellationToken.None : protocolInput.Cancellation.Token;
    long deadline = Convert.ToInt64(init["deadlineUnixMs"]);
    for (int attempt = 0; ; attempt++) {
      cancellation.ThrowIfCancellationRequested();
      if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadline) throw new InvalidDataException("deadline_invalid");
      try {
        return ReadOfficialSourceInventory(requireWalShm, trust);
      } catch (InvalidDataException error) {
        if (error.Message != "process_ambiguous" || attempt >= retryCount) throw;
        long remaining = deadline - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (remaining <= 0) throw new InvalidDataException("deadline_invalid");
        int delay = (int)Math.Min(retryDelayMs, remaining);
        if (cancellation.WaitHandle.WaitOne(delay)) cancellation.ThrowIfCancellationRequested();
      }
    }
  }

  static string SafeInventoryErrorCode(Exception error) {
    if (error is OperationCanceledException) return "cancelled";
    string message = error is InvalidDataException || error is InvalidOperationException ? error.Message : String.Empty;
    switch (message) {
      case "unsupported_build":
      case "build_rotation":
      case "candidate_missing":
      case "candidate_ambiguous":
      case "candidate_limit":
      case "process_missing":
      case "process_ambiguous":
      case "process_limit":
      case "source_reparse_or_type":
      case "source_changed":
      case "source_too_large":
      case "source_shm_missing":
      case "line_window_ambiguous":
      case "line_window_close_failed":
      case "owner_invalid":
      case "key_unavailable":
      case "snapshot_hot_journal":
      case "snapshot_source_changed":
      case "snapshot_key_mismatch":
      case "snapshot_backup_failed":
      case "snapshot_backup_init_failed":
      case "snapshot_backup_no_progress":
      case "snapshot_source_unavailable":
      case "snapshot_wal_no_commit":
      case "snapshot_wal_invalid":
      case "snapshot_database_header_invalid":
      case "snapshot_size_limit":
      case "mid_or_schema_mismatch":
      case "official_account_not_active":
      case "deadline_invalid":
      case "protocol_invalid":
      case "attachment_metadata_too_large":
      case "attachment_metadata_invalid":
      case "attachment_identity_mismatch":
        return message;
      case "SOURCE_ROW_INVALID":
        return "source_row_invalid";
      case "SOURCE_CONVERSATION_INVALID":
        return "source_conversation_invalid";
      case "SOURCE_SCHEMA_UNSUPPORTED":
        return "source_schema_unsupported";
      case "SOURCE_ROW_TOO_LARGE":
        return "source_row_too_large";
      case "RESULT_TOO_LARGE":
        return "source_result_too_large";
      default:
        return "source_io_error";
    }
  }

#if READER_FIXTURE_SOURCE_TEST
  static void RunSourceVerification(Stream input, Stream output, Dictionary<string, object> init) {
    SetDiagnosticStage("init_fields");
    RequireFrame(init, "init", new string[] { "operation", "expectedMid", "deadlineUnixMs", "fixtureRoot", "fixtureProcessId" });
    SetDiagnosticStage("init_values");
    ValidateInit(init);
    string expectedMid = (string)init["expectedMid"];
    if (!(init["fixtureRoot"] is string)) throw new InvalidDataException();
    if (!(init["fixtureProcessId"] is int) && !(init["fixtureProcessId"] is long)) throw new InvalidDataException();
    int fixtureProcessId = Convert.ToInt32(init["fixtureProcessId"]);
    if (fixtureProcessId <= 0) throw new InvalidDataException();
    string root = Path.Combine(ValidateFixtureRoot((string)init["fixtureRoot"]), "LINE");
    SetDiagnosticStage("discovery");
    SyntheticProbeEnvironment environment = new SyntheticProbeEnvironment(
      delegate(string directory) { return Directory.GetFiles(directory, "*", SearchOption.TopDirectoryOnly); },
      delegate(int processId) { return Process.GetProcessById(processId); });
    SourceInventory inventory = Discover(root, fixtureProcessId, environment);
    SetDiagnosticStage("verify_request");
    Emit(output, "inventory", new Dictionary<string, object> {
      { "candidateCount", 1 }, { "processCount", 1 },
      { "edbMiB", new int[] { ToMiB(inventory.EdbLength) } },
      { "walMiB", new int[] { ToMiB(inventory.WalLength) } }
    });
    ArmDeadline(init);
    Dictionary<string, object> verify = ReadFrame(input);
    RequireFrame(verify, "verify", new string[] { "expectedMid", "workBudgetSeconds" });
    if (Convert.ToString(verify["expectedMid"]) != expectedMid) throw new InvalidDataException();
    object suppliedBudget = verify["workBudgetSeconds"];
    if (!(suppliedBudget is int) && !(suppliedBudget is long)) throw new InvalidDataException();
    int workBudgetSeconds = Convert.ToInt32(suppliedBudget);
    int calculatedBudget = CalculateWorkBudget(inventory);
    if (workBudgetSeconds != calculatedBudget || workBudgetSeconds < 1 || workBudgetSeconds > 14400) throw new InvalidDataException();
    int workRemaining = (int)Math.Min((long)MaxSessionTimeoutMs, Math.Min((long)workBudgetSeconds * 1000,
      (long)(Convert.ToDouble(init["deadlineUnixMs"]) - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())));
    if (workRemaining <= 0) throw new InvalidDataException();
    ArmWatchdog(workRemaining);

    SetDiagnosticStage("key_scan");
    byte[] key = FindValidatedKey(inventory, expectedMid);
    try {
      SetDiagnosticStage("ready");
      VerifySourceUnchanged(inventory);
      Emit(output, "ready", new Dictionary<string, object> {
        { "keyValidated", true }, { "identityMatched", true }, { "mappingVersion", "line-profile-mid-v1" }
      });
      int nextPageNumber = 1;
      int pagesRead = 0;
      string pendingDigest = null;
      bool pendingHasMore = false;
      while (true) {
        Dictionary<string, object> request = ReadFrame(input);
        if (pendingDigest != null) {
          SetDiagnosticStage("page_ack");
          RequireFrame(request, "ack", new string[] { "pageNumber", "batchDigest" });
          if (Convert.ToInt32(request["pageNumber"]) != nextPageNumber || Convert.ToString(request["batchDigest"]) != pendingDigest) throw new InvalidDataException();
          pendingDigest = null;
          if (!pendingHasMore) nextPageNumber = 0;
          else nextPageNumber++;
          continue;
        }
        if (request.ContainsKey("type") && Convert.ToString(request["type"]) == "close") {
          RequireFrame(request, "close", new string[] { "reason" });
          if (Convert.ToString(request["reason"]) != "fixture_complete") throw new InvalidDataException();
          break;
        }
        if (nextPageNumber == 0) throw new InvalidDataException();
        SetDiagnosticStage("page_request");
        RequireFrame(request, "next", new string[] { "pageNumber", "limitRows" });
        int pageNumber = Convert.ToInt32(request["pageNumber"]);
        int limitRows = Convert.ToInt32(request["limitRows"]);
        if (pageNumber != nextPageNumber || pageNumber > 500 || limitRows != 100 || pagesRead >= 500) throw new InvalidDataException();
        VerifySourceUnchanged(inventory);
        string[] rows;
        string diagnostic;
        bool hasMore;
        SetDiagnosticStage("page_open");
        using (Sqlite3Mc reader = Sqlite3Mc.OpenFixtureProbe(inventory.Database, key)) {
          SetDiagnosticStage("page_query");
          rows = reader.ReadFixtureMessagePage(pageNumber, limitRows, out hasMore);
          diagnostic = reader.DiagnosticSummary;
        }
        VerifySourceUnchanged(inventory);
        string digest = Sqlite3Mc.DigestFixturePage(pageNumber, rows);
        EmitPage(output, new Dictionary<string, object> {
          { "pageNumber", pageNumber }, { "batchDigest", digest }, { "hasMore", hasMore },
          { "rows", rows }, { "diagnostic", diagnostic }
        });
        pagesRead++;
        pendingDigest = digest;
        pendingHasMore = hasMore;
      }
    } finally { if (key != null) Array.Clear(key, 0, key.Length); }

    Emit(output, "closed", new Dictionary<string, object> { { "sourceAccessed", true } });
    RequireEnd(input);
  }
#endif

  static void ValidateInit(Dictionary<string, object> init) {
    if (init.ContainsKey("operation") && Convert.ToString(init["operation"]) == "read_official_identity") {
      if (init.ContainsKey("expectedMid")) throw new InvalidDataException();
    } else if (!(init["expectedMid"] is string) || ((string)init["expectedMid"]).Length < 1 || ((string)init["expectedMid"]).Length > 200 || ((string)init["expectedMid"]).IndexOf('\0') >= 0) throw new InvalidDataException();
    if (!(init["deadlineUnixMs"] is int) && !(init["deadlineUnixMs"] is long) && !(init["deadlineUnixMs"] is double)) throw new InvalidDataException();
    double deadline = Convert.ToDouble(init["deadlineUnixMs"]);
    if (deadline <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) throw new InvalidDataException();
  }

  static void ArmDeadline(Dictionary<string, object> init) {
    int remaining = (int)Math.Min(MaxSessionTimeoutMs, Convert.ToDouble(init["deadlineUnixMs"]) - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    ArmWatchdog(Math.Max(1, remaining));
  }

#if READER_FIXTURE_SOURCE_TEST
  static string ValidateFixtureRoot(string root) {
    string full = Path.GetFullPath(root);
    string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    if (!full.StartsWith(temp, StringComparison.OrdinalIgnoreCase) || !Directory.Exists(full)) throw new InvalidDataException();
    RequireNoReparse(full, true);
    return full;
  }

  static SourceInventory Discover(string root, int processId, SyntheticProbeEnvironment environment) {
    SetDiagnosticStage("discover_paths");
    string fullRoot = Path.GetFullPath(root);
    string exe = Path.Combine(fullRoot, "bin", "current", "LINE.exe");
    string dbDirectory = Path.Combine(fullRoot, "Data", "db");
    RequireNoReparse(exe, true);
    RequireNoReparse(dbDirectory, true);
    FileInfo exeInfo = new FileInfo(exe);
    SetDiagnosticStage("discover_build");
    if (exeInfo.Length != LineFixtureBuildContract.Bytes || HashFile(exe) != LineFixtureBuildContract.Sha256) throw new InvalidDataException();
    List<string> candidates = new List<string>();
    SetDiagnosticStage("discover_database");
    foreach (string path in environment.EnumerateDatabaseFiles(dbDirectory)) {
      string name = Path.GetFileName(path);
      string lower = name.ToLowerInvariant();
      if (!String.Equals(Path.GetExtension(name), ".edb", StringComparison.OrdinalIgnoreCase)) continue;
      if (lower.StartsWith("album") || lower.StartsWith("chatstats") || lower.StartsWith("keep")) continue;
      RequireNoReparse(path, true);
      candidates.Add(path);
    }
    SetDiagnosticStage("candidate_count");
    if (candidates.Count != 1) throw new InvalidDataException();
    string db = candidates[0], wal = db + "-wal", shm = db + "-shm";
    SetDiagnosticStage("sidecars");
    RequireNoReparse(wal, true); RequireNoReparse(shm, true);
    FileInfo dbInfo = new FileInfo(db), walInfo = new FileInfo(wal);
    SetDiagnosticStage("database_sizes");
    SetDiagnosticStage("discover_process");
    if (dbInfo.Length <= 0 || walInfo.Length < 0 || dbInfo.Length > 16L * 1024 * 1024 * 1024 || walInfo.Length > 2L * 1024 * 1024 * 1024) throw new InvalidDataException();
    Process process = environment.OpenProcessById(processId);
    try {
      if (process.Id != processId) throw new InvalidDataException();
      IntPtr handle = OpenProcess(ProcessQueryLimitedInformation, false, process.Id);
      if (handle == IntPtr.Zero) throw new InvalidDataException();
      try {
        StringBuilder image = new StringBuilder(32768);
        int imageLength = image.Capacity;
        if (!QueryFullProcessImageNameW(handle, 0, image, ref imageLength) ||
            !String.Equals(Path.GetFullPath(image.ToString()), Path.GetFullPath(exe), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
      } finally { CloseHandle(handle); }
      handle = OpenProcess(ProcessQueryInformation | ProcessVmRead, false, process.Id);
      if (handle == IntPtr.Zero) throw new InvalidDataException();
      long creation;
      try { SetDiagnosticStage("verify_process"); VerifyProcessIdentity(handle, exe, out creation); }
      finally { CloseHandle(handle); }
      return new SourceInventory { Root = fullRoot, Executable = exe, Database = db, Wal = wal, Shm = shm,
        ProcessId = process.Id, ProcessCreated = creation, EdbLength = dbInfo.Length, WalLength = walInfo.Length,
        EdbLastWriteTicks = dbInfo.LastWriteTimeUtc.Ticks, WalLastWriteTicks = walInfo.LastWriteTimeUtc.Ticks };
    } finally { process.Dispose(); }
  }

  static byte[] FindValidatedKey(SourceInventory inventory, string mid) {
    IntPtr handle = OpenProcess(ProcessQueryInformation | ProcessVmRead, false, inventory.ProcessId);
    if (handle == IntPtr.Zero) throw new InvalidDataException();
    DateTime started = DateTime.UtcNow;
    long scanned = 0;
    int candidates = 0;
    HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
    try {
      long creation;
      VerifyProcessIdentity(handle, inventory.Executable, out creation);
      if (creation != inventory.ProcessCreated) throw new InvalidDataException();
      long address = 0;
      while (address >= 0 && address < 0x00007FFFFFFF0000L) {
        if (scanned >= MaxScanBytes || (DateTime.UtcNow - started).TotalSeconds > 90 || candidates >= MaxCandidates) break;
        MemoryRegion region;
        if (VirtualQueryEx(handle, new IntPtr(address), out region, new UIntPtr((uint)processIdentitySize)).ToUInt64() == 0) break;
        long baseAddress = region.BaseAddress.ToInt64();
        ulong size = region.RegionSize.ToUInt64();
        long next = checked(baseAddress + (long)size);
        if (next <= address) throw new InvalidDataException();
        uint protection = region.Protect & 0xff;
        bool readable = region.State == MemCommit && region.Type == MemPrivate &&
          (protection == 2 || protection == 4 || protection == 8 || protection == 0x20 || protection == 0x40 || protection == 0x80) &&
          (region.Protect & PageGuard) == 0;
        if (readable && size > 0 && size <= 128UL * 1024 * 1024) {
          ulong offset = 0;
          byte[] carry = new byte[0];
          try {
            while (offset < size && scanned < MaxScanBytes && (DateTime.UtcNow - started).TotalSeconds <= 90 && candidates < MaxCandidates) {
              int length = (int)Math.Min(1024 * 1024, Math.Min(size - offset, (ulong)(MaxScanBytes - scanned)));
              byte[] buffer = new byte[length];
              byte[] window = null;
              try {
                UIntPtr read;
                bool ok = ReadProcessMemory(handle, new IntPtr(checked(baseAddress + (long)offset)), buffer, new UIntPtr((uint)length), out read);
                int count = (int)Math.Min((ulong)length, read.ToUInt64());
                if (ok && count > 0) {
                  scanned += count;
                  window = new byte[carry.Length + count];
                  Buffer.BlockCopy(carry, 0, window, 0, carry.Length);
                  Buffer.BlockCopy(buffer, 0, window, carry.Length, count);
                  byte[] candidate = ScanWindow(window, seen, inventory.Database, mid, ref candidates);
                  if (candidate != null) return candidate;
                  Array.Clear(carry, 0, carry.Length);
                  if (count == length) {
                    int tailLength = Math.Min(128, window.Length);
                    carry = new byte[tailLength];
                    Buffer.BlockCopy(window, window.Length - tailLength, carry, 0, tailLength);
                  } else carry = new byte[0];
                } else {
                  Array.Clear(carry, 0, carry.Length);
                  carry = new byte[0];
                }
              } finally {
                Array.Clear(buffer, 0, buffer.Length);
                if (window != null) Array.Clear(window, 0, window.Length);
              }
              offset += (ulong)length;
            }
          } finally { Array.Clear(carry, 0, carry.Length); }
        }
        address = next;
      }
      SetDiagnosticStage("key_not_found_" + scanned.ToString() + "_" + candidates.ToString());
      throw new InvalidDataException();
    } finally { seen.Clear(); CloseHandle(handle); }
  }

  static bool TryCandidate(byte[] candidate, HashSet<string> seen, string database, string mid) {
    byte[] fingerprint;
    using (SHA256 hash = SHA256.Create()) fingerprint = hash.ComputeHash(candidate);
    string signature = Convert.ToBase64String(fingerprint);
    Array.Clear(fingerprint, 0, fingerprint.Length);
    if (!seen.Add(signature)) { Array.Clear(candidate, 0, candidate.Length); return false; }
    return LineEncryptedPageValidator.FirstPageValid(database, candidate);
  }

  static byte[] ScanWindow(byte[] bytes, HashSet<string> seen, string database, string mid, ref int candidates) {
    for (int i = 0; i + 32 <= bytes.Length && candidates < MaxCandidates; i++) {
      if (!IsHexKey(bytes, i, 1)) continue;
      byte[] candidate = new byte[32];
      for (int n = 0; n < 32; n++) candidate[n] = bytes[i + n];
      if (TryCandidate(candidate, seen, database, mid)) return candidate;
      candidates++;
      Array.Clear(candidate, 0, candidate.Length);
    }
    for (int i = 0; i + 64 <= bytes.Length && candidates < MaxCandidates; i++) {
      if (!IsHexKey(bytes, i, 2)) continue;
      byte[] candidate = new byte[32];
      for (int n = 0; n < 32; n++) candidate[n] = bytes[i + n * 2];
      if (TryCandidate(candidate, seen, database, mid)) return candidate;
      candidates++;
      Array.Clear(candidate, 0, candidate.Length);
    }
    return null;
  }

  static bool IsHexKey(byte[] bytes, int start, int stride) {
    for (int i = 0; i < 32; i++) {
      byte b = bytes[start + i * stride];
      if (!((b >= (byte)'0' && b <= (byte)'9') || (b >= (byte)'a' && b <= (byte)'f') || (b >= (byte)'A' && b <= (byte)'F'))) return false;
      if (stride == 2 && bytes[start + i * stride + 1] != 0) return false;
    }
    return true;
  }

  static void VerifyProcessIdentity(IntPtr handle, string expectedExe, out long creation) {
    StringBuilder buffer = new StringBuilder(32768);
    int size = buffer.Capacity;
    if (!QueryFullProcessImageNameW(handle, 0, buffer, ref size) || !String.Equals(Path.GetFullPath(buffer.ToString()), Path.GetFullPath(expectedExe), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
    long exit, kernel, user;
    if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user) || creation <= 0) throw new InvalidDataException();
  }

  static void VerifySourceUnchanged(SourceInventory original) {
    RequireNoReparse(original.Database, true); RequireNoReparse(original.Wal, true); RequireNoReparse(original.Shm, true);
    FileInfo edb = new FileInfo(original.Database), wal = new FileInfo(original.Wal);
    if (edb.Length != original.EdbLength || wal.Length != original.WalLength ||
        edb.LastWriteTimeUtc.Ticks != original.EdbLastWriteTicks || wal.LastWriteTimeUtc.Ticks != original.WalLastWriteTicks) throw new InvalidDataException();
  }

  static int ToMiB(long bytes) { return (int)Math.Min(Int32.MaxValue, (bytes + 1024 * 1024 - 1) / (1024 * 1024)); }
  static int CalculateWorkBudget(SourceInventory inventory) {
    double variableSeconds = 9.0 * ((double)ToMiB(inventory.EdbLength) + ToMiB(inventory.WalLength)) / 24.0;
    double seconds = 60 + 210 + Math.Ceiling(variableSeconds);
    if (seconds > 14400) throw new InvalidDataException();
    return (int)seconds;
  }
  static void RequireNoReparse(string path, bool includeLeaf) {
    string full = Path.GetFullPath(path);
    string current = Path.GetPathRoot(full);
    string remainder = full.Substring(current.Length);
    string[] parts = remainder.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    int count = includeLeaf ? parts.Length : parts.Length - 1;
    for (int i = 0; i < count; i++) {
      if (parts[i].Length == 0) continue;
      current = Path.Combine(current, parts[i]);
      if (!File.Exists(current) && !Directory.Exists(current)) throw new FileNotFoundException();
      if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
    }
  }

  static string HashFile(string path) {
    using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
    using (SHA256 hash = SHA256.Create()) {
      byte[] digest = hash.ComputeHash(stream); StringBuilder value = new StringBuilder();
      foreach (byte b in digest) value.Append(b.ToString("x2"));
      Array.Clear(digest, 0, digest.Length); return value.ToString();
    }
  }
#endif

  static void ArmWatchdog(int timeoutMs) {
    if (watchdog == null) watchdog = new Timer(delegate {
      if (softWatchdog && protocolInput != null) { protocolInput.CancelForTimeout(); watchdog.Change(15000, Timeout.Infinite); }
      else Process.GetCurrentProcess().Kill();
    }, null, timeoutMs, Timeout.Infinite);
    else watchdog.Change(timeoutMs, Timeout.Infinite);
  }
  sealed class ByteProgressReporter {
    readonly Stream output; readonly string phase;
    readonly bool enabled;
    long lastBytes, pendingBytes, pendingTotal = -1, lastTimestamp = Stopwatch.GetTimestamp();
    internal ByteProgressReporter(Stream stream, string progressPhase, long totalBytes, bool shouldEmit) { output = stream; phase = progressPhase; pendingTotal = totalBytes; enabled = shouldEmit; }
    internal void Report(long bytes, long totalBytes) { pendingBytes = bytes; pendingTotal = totalBytes; Report(bytes, totalBytes, false); }
    internal void Flush() { Report(pendingBytes, pendingTotal, true); }
    void Report(long bytes, long totalBytes, bool force) {
      if (!enabled) return;
      if (bytes <= lastBytes) return;
      ArmWatchdog(FirstImportIdleWatchdogMs);
      long now = Stopwatch.GetTimestamp();
      if (!force && now - lastTimestamp < Stopwatch.Frequency / 2) return;
      lastBytes = bytes; lastTimestamp = now;
      Emit(output, "progress", new Dictionary<string, object> { { "phase", phase }, { "bytesCopied", bytes.ToString(System.Globalization.CultureInfo.InvariantCulture) },
        { "totalBytes", totalBytes < 0 ? null : totalBytes.ToString(System.Globalization.CultureInfo.InvariantCulture) },
        { "rowsScanned", null }, { "eligibleCount", null }, { "scanSteps", null } });
    }
  }
  static void SetDiagnosticStage(string stage) {
#if READER_FIXTURE_SOURCE_TEST
    diagnosticStage = stage;
#endif
  }
  static Dictionary<string, object> ReadFrame(Stream input) {
    int ignored;
    return ReadFrame(input, MaxControlFrameBytes, out ignored);
  }
  static Dictionary<string, object> ReadFrame(Stream input, int maximumBytes, out int bodyLength) {
    byte[] header = ReadExact(input, 4);
    int length = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
    if (length < 2 || length > maximumBytes) throw new InvalidDataException();
    bodyLength = length;
    byte[] bytes = ReadExact(input, length);
    try {
      JavaScriptSerializer serializer = maximumBytes > MaxControlFrameBytes ? InitialImportJson : Json;
      Dictionary<string, object> value = serializer.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes));
      if (value == null) throw new InvalidDataException(); inputSequence++; return value;
    } finally { Array.Clear(bytes, 0, bytes.Length); }
  }
  static byte[] ReadExact(Stream input, int length) {
    byte[] bytes = new byte[length]; int offset = 0;
    while (offset < length) { int read = input.Read(bytes, offset, length - offset); if (read <= 0) throw new EndOfStreamException(); offset += read; }
    return bytes;
  }
  static void RequireEnd(Stream input) { if (input.ReadByte() != -1) throw new InvalidDataException(); }
  static void RequireFrame(Dictionary<string, object> frame, string type, string[] fields) {
    if (frame.Count != fields.Length + 4 || !frame.ContainsKey("version") || !frame.ContainsKey("requestId") || !frame.ContainsKey("sequence") || !frame.ContainsKey("type")) throw new InvalidDataException();
    foreach (string field in fields) if (!frame.ContainsKey(field)) throw new InvalidDataException();
    if (Convert.ToInt32(frame["version"]) != 1 || Convert.ToInt32(frame["sequence"]) != inputSequence || Convert.ToString(frame["requestId"]) != requestId || Convert.ToString(frame["type"]) != type) throw new InvalidDataException();
  }
  static void Emit(Stream output, string type, Dictionary<string, object> fields) {
    Dictionary<string, object> value = new Dictionary<string, object> { { "version", 1 }, { "requestId", requestId }, { "sequence", ++outputSequence }, { "type", type } };
    foreach (KeyValuePair<string, object> item in fields) value.Add(item.Key, item.Value);
    byte[] body = Encoding.UTF8.GetBytes(Json.Serialize(value));
    try { if (body.Length < 1 || body.Length > MaxControlFrameBytes) throw new InvalidDataException(); WriteFrame(output, body); }
    finally { Array.Clear(body, 0, body.Length); }
  }
  static void EmitPage(Stream output, Dictionary<string, object> fields, bool initialImport = false) {
    Dictionary<string, object> value = new Dictionary<string, object> { { "version", 1 }, { "requestId", requestId }, { "sequence", outputSequence + 1 }, { "type", "page" } };
    foreach (KeyValuePair<string, object> item in fields) value.Add(item.Key, item.Value);
    JavaScriptSerializer serializer = initialImport ? InitialImportJson : Json;
    int maximumBytes = initialImport ? MaxInitialImportPageFrameBytes : MaxPageFrameBytes;
    byte[] body = Encoding.UTF8.GetBytes(serializer.Serialize(value));
    try {
      int rowCount = ((value["rows"] as Array) ?? new object[0]).Length;
      int tailCount = ((value.ContainsKey("tailRows") ? value["tailRows"] : null) as Array ?? new object[0]).Length;
      if (body.Length < 1 || body.Length > maximumBytes ||
          3L * body.Length + 128L * (rowCount + tailCount) + 65536L > maximumBytes)
        throw new InvalidOperationException("SOURCE_ROW_TOO_LARGE");
      outputSequence++;
      WriteFrame(output, body);
    }
    finally { Array.Clear(body, 0, body.Length); }
  }

  static readonly JavaScriptSerializer MeasureJson = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };

  internal static int MeasurePageBaseBytes(int pageNumber, object cursor, bool hasMore, bool initialImport, bool includeTail) {
    Dictionary<string, object> fields = new Dictionary<string, object> {
      { "pageNumber", pageNumber }, { "batchDigest", new string('0', 64) }, { "rows", new object[0] }
    };
    if (includeTail) fields.Add("tailRows", new object[0]);
    fields.Add("lastCursor", cursor); fields.Add("hasMore", hasMore);
    Dictionary<string, object> frame = new Dictionary<string, object> {
      { "version", 1 }, { "requestId", requestId }, { "sequence", outputSequence + 1 }, { "type", "page" }
    };
    foreach (KeyValuePair<string, object> item in fields) frame.Add(item.Key, item.Value);
    return Encoding.UTF8.GetByteCount(MeasureJson.Serialize(frame));
  }

  internal static int MeasureRowBytes(object row) { return Encoding.UTF8.GetByteCount(MeasureJson.Serialize(row)); }

  internal static void FitPagePrefix(object[] rows, object[] tailRows, int pageNumber, object currentCursor,
      bool initialImport, bool moreAfterRows, bool tailPending, out int rowCount, out int tailCount) {
    FitPagePrefix(rows, tailRows, pageNumber, currentCursor, initialImport, moreAfterRows, tailPending, 0, out rowCount, out tailCount);
  }

  internal static void FitPagePrefix(object[] rows, object[] tailRows, int pageNumber, object currentCursor,
      bool initialImport, bool moreAfterRows, bool tailPending, int reservedBytes, out int rowCount, out int tailCount) {
    if (rows == null) rows = new object[0];
    if (tailRows == null) tailRows = new object[0];
    int wireLimit = initialImport ? MaxInitialImportPageFrameBytes : MaxPageFrameBytes;
    int repositoryLimit = initialImport ? MaxInitialImportPageFrameBytes : MaxPageFrameBytes;
    long rowBytes = 0, tailBytes = 0;
    rowCount = 0; tailCount = 0;
    for (int i = 0; i < rows.Length; i++) {
      rowBytes += MeasureRowBytes(rows[i]);
      string time, id;
      if (!TryReadNativeCursor(rows[i] as Dictionary<string, object>, out time, out id))
        throw new InvalidOperationException("SOURCE_ROW_INVALID");
      object rowCursor = new Dictionary<string, object> { { "createdTime", time }, { "id", id } };
      bool hasMore = moreAfterRows || i + 1 < rows.Length || tailPending;
      int baseBytes = MeasurePageBaseBytes(pageNumber, rowCursor, hasMore, initialImport, !initialImport) + reservedBytes;
      if (!PageFits(baseBytes, rowBytes, i + 1, 0, 0, wireLimit, repositoryLimit)) break;
      rowCount = i + 1;
    }
    if (rowCount == rows.Length && !moreAfterRows && tailRows.Length > 0) {
      for (int i = 0; i < tailRows.Length; i++) {
        tailBytes += MeasureRowBytes(tailRows[i]);
        bool hasMore = i + 1 < tailRows.Length;
        int baseBytes = MeasurePageBaseBytes(pageNumber, currentCursor, hasMore, false, true) + reservedBytes;
        if (!PageFits(baseBytes, rowBytes, rowCount, tailBytes, i + 1, wireLimit, repositoryLimit)) break;
        tailCount = i + 1;
      }
    }
    if (rowCount == 0 && tailCount == 0 && (rows.Length > 0 || tailRows.Length > 0))
      throw new InvalidOperationException("SOURCE_ROW_TOO_LARGE");
  }

  static object[] SliceObjects(object[] values, int start) {
    int count = values.Length - start;
    object[] result = new object[count];
    if (count > 0) Array.Copy(values, start, result, 0, count);
    return result;
  }

  internal static bool PageFits(int baseBytes, long rowBytes, int rowCount, long tailBytes, int tailCount,
      int wireLimit, int repositoryLimit) {
    long wireBytes = baseBytes + rowBytes + Math.Max(0, rowCount - 1) + tailBytes + Math.Max(0, tailCount - 1);
    return wireBytes <= wireLimit && 3L * wireBytes + 128L * (rowCount + tailCount) + 65536L <= repositoryLimit;
  }

#if READER_PAGE_BUDGET_TEST
  internal static string FixtureBuildTailWindowJson(string upperTime, string upperId, object[] tailParsed) {
    return MeasureJson.Serialize(BuildTailWindow(upperTime, upperId, tailParsed));
  }

  internal static void FixtureFitPagePrefix(object[] rows, object[] tailRows, int pageNumber, object cursor,
      bool initialImport, bool moreAfterRows, bool tailPending, out int rowCount, out int tailCount) {
    requestId = new string('a', 32); outputSequence = 0;
    FitPagePrefix(rows, tailRows, pageNumber, cursor, initialImport, moreAfterRows, tailPending, out rowCount, out tailCount);
  }

  internal static bool FixtureDirectAckMatches(int pageNumber, string digest, object emittedCursor, object ackCursor) {
    return DirectAckMatches(new Dictionary<string, object> { { "pageNumber", pageNumber }, { "batchDigest", digest }, { "lastCursor", ackCursor } },
      pageNumber, digest, emittedCursor);
  }

  internal static string FixtureSerializePage(Dictionary<string, object> fields, bool initialImport) {
    requestId = new string('a', 32); outputSequence = 0;
    using (MemoryStream stream = new MemoryStream()) {
      EmitPage(stream, fields, initialImport);
      byte[] frame = stream.ToArray();
      try { return Encoding.UTF8.GetString(frame, 4, frame.Length - 4); }
      finally { Array.Clear(frame, 0, frame.Length); }
    }
  }
#endif
  static void WriteFrame(Stream output, byte[] body) {
    byte[] header = new byte[] { (byte)(body.Length >> 24), (byte)(body.Length >> 16), (byte)(body.Length >> 8), (byte)body.Length };
    output.Write(header, 0, header.Length); output.Write(body, 0, body.Length); output.Flush();
  }
}

// Cheap change signal for the official database (WAL mode). Each write transaction updates both copies of the
// WAL-index header at bytes 0..95 of "<db>-shm" (iChange, mxFrame, salts, checksums), and it grows "<db>-wal".
// The signal is those 96 bytes plus the -wal size. Bytes 96..135 (reader marks, nBackfill), the last-write times
// and the database size are not part of it: LINE's own reads, checkpoints and the late NTFS last-write update
// must not start an extra full read. SQLite takes byte-range locks on -shm from offset 120 (WIN_SHM_BASE) and 128
// (DMS); a read of those bytes fails with ERROR_LOCK_VIOLATION while LINE writes, so nothing from offset 96 up is read.
// The check opens every file with a NEW handle that shares read, write and delete, and closes it at once,
// so it never blocks LINE and never pins a file.
internal static class OfficialChangeSignal {
  internal const int ShmHeaderBytes = 96;
  const uint GenericRead = 0x80000000, FileReadAttributes = 0x80, ShareAll = 7, OpenExisting = 3,
    OpenReparsePoint = 0x00200000, DirectoryAttribute = 0x10, ReparsePointAttribute = 0x400;
  [StructLayout(LayoutKind.Sequential)] struct Information {
    internal uint Attributes;
    internal uint CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh, VolumeSerial;
    internal uint SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(
    string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(
    SafeFileHandle handle, out Information information);

  // The signal at the end of the last full read. Null means "unknown": every check reports a change.
  internal static string Baseline;
  // The last Win32 error of a failed open (test evidence: a sharing violation is error 32).
  internal static int LastOpenError;

  // Returns null when -shm is missing or unreadable. A missing -wal reads as size "missing".
  internal static string Read(string databasePath) {
    byte[] header = ReadShmHeader(databasePath + "-shm");
    if (header == null) return null;
    StringBuilder value = new StringBuilder(ShmHeaderBytes * 2 + 24);
    for (int i = 0; i < header.Length; i++) value.Append(header[i].ToString("x2"));
    return value.Append('|').Append(WalSize(databasePath + "-wal")).ToString();
  }

  // The baseline for the next wait. A write that commits while a full read runs makes the two values differ.
  // The older value is then the baseline, so the next check reports a change and the next poll reads again.
  internal static string Settle(string before, string after) {
    if (before == null || after == null) return null;
    return before;
  }

  // True when the database changed since Baseline, false when timeoutMs passed without a change
  // or when interrupted() reports queued input.
  // An unreadable -shm after a readable baseline is a change. While -shm stays unreadable and the
  // baseline is unknown, the answer is "changed" only after the old 5000 ms poll period, so a
  // missing sidecar never makes a tight read loop.
  internal static bool WaitForChange(string databasePath, int timeoutMs, CancellationToken cancellation, Action rearm, Func<bool> interrupted) {
    Stopwatch clock = Stopwatch.StartNew();
    int unreadableAfterMs = Math.Min(timeoutMs, 5000);
    for (;;) {
      cancellation.ThrowIfCancellationRequested();
      if (rearm != null) rearm();
      if (interrupted != null && interrupted()) return false;
      string current = Read(databasePath);
      string baseline = Baseline;
      if (current == null) {
        if (baseline != null) return true;
        if (clock.ElapsedMilliseconds >= unreadableAfterMs) return true;
      } else if (baseline == null || !String.Equals(current, baseline, StringComparison.Ordinal)) return true;
      long remaining = timeoutMs - clock.ElapsedMilliseconds;
      if (remaining <= 0) return false;
      cancellation.WaitHandle.WaitOne((int)Math.Min(200L, remaining));
    }
  }

  static byte[] ReadShmHeader(string path) {
    SafeFileHandle handle = Open(path, GenericRead);
    if (handle == null) return null;
    try {
      Information info;
      if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & (DirectoryAttribute | ReparsePointAttribute)) != 0) return null;
      byte[] header = new byte[ShmHeaderBytes];
      using (FileStream stream = new FileStream(handle, FileAccess.Read, 1, false)) {
        int offset = 0;
        while (offset < header.Length) {
          int read = stream.Read(header, offset, header.Length - offset);
          if (read <= 0) return null;
          offset += read;
        }
      }
      return header;
    } catch (Exception) { return null; }
    finally { handle.Dispose(); }
  }

  static string WalSize(string path) {
    SafeFileHandle handle = Open(path, FileReadAttributes);
    if (handle == null) return "missing";
    try {
      Information info;
      if (!GetFileInformationByHandle(handle, out info)) return "unreadable";
      return (((long)info.SizeHigh << 32) | info.SizeLow).ToString(System.Globalization.CultureInfo.InvariantCulture);
    } finally { handle.Dispose(); }
  }

  static SafeFileHandle Open(string path, uint access) {
    SafeFileHandle handle = CreateFileW(path, access, ShareAll, IntPtr.Zero, OpenExisting, OpenReparsePoint, IntPtr.Zero);
    if (handle == null || handle.IsInvalid) {
      LastOpenError = Marshal.GetLastWin32Error();
      if (handle != null) handle.Dispose();
      return null;
    }
    return handle;
  }
}
