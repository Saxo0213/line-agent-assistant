using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

// Standalone synthetic-file harness; never discovers processes or LINE paths.
internal static class SnapshotFixtureHarness {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateSymbolicLinkW(string link, string target, int flags);
  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    if (args.Length != 3) return 2;
    string database = Path.GetFullPath(args[0]), directory = Path.GetFullPath(args[1]), scenario = args[2];
    byte[] key = Encoding.ASCII.GetBytes(scenario == "wrong-key" ? "00000000000000000000000000000000" : "0123456789abcdef0123456789abcdef");
    byte[] savedDatabase = null, savedWal = null; string backupPath = null; bool madeJournal = false; int openAttempts = 0;
    DateTime originalWrite = File.GetLastWriteTimeUtc(database);
    DateTime deadline = DateTime.UtcNow.AddSeconds(20);
    List<string> order = new List<string>();
    LineEncryptedSnapshot.SnapshotOwner activeOwner = null; FileStream expectedWalStream = null;
    using (CancellationTokenSource cancellation = new CancellationTokenSource()) {
    try {
      LineEncryptedSnapshot.StageHook hook = delegate(LineEncryptedSnapshot.Stage stage, LineEncryptedSnapshot.SnapshotOwner owner) {
        if (stage == LineEncryptedSnapshot.Stage.Database1Copied || stage == LineEncryptedSnapshot.Stage.Wal1Copied ||
            stage == LineEncryptedSnapshot.Stage.Wal2Observed || stage == LineEncryptedSnapshot.Stage.Database2Observed) order.Add(stage.ToString());
        if (stage == LineEncryptedSnapshot.Stage.Wal1Copied) {
          activeOwner = owner;
          if (File.Exists(Path.Combine(directory, "snapshot.edb-wal"))) expectedWalStream = owner.GuardedStream(Path.Combine(directory, "snapshot.edb-wal"));
        }
        if (expectedWalStream != null && (stage == LineEncryptedSnapshot.Stage.Wal1Copied || stage == LineEncryptedSnapshot.Stage.WalValidated || stage == LineEncryptedSnapshot.Stage.BeforeOpen)) {
          if (expectedWalStream == null || !Object.ReferenceEquals(expectedWalStream, owner.GuardedStream(Path.Combine(directory, "snapshot.edb-wal"))))
            throw new InvalidOperationException("snapshot_wal_stream_changed");
          if (scenario == "wal-stream-lifecycle") AssertExternalWalMutationDenied(Path.Combine(directory, "snapshot.edb-wal"));
        }
        if (stage == LineEncryptedSnapshot.Stage.WalValidated && scenario == "private-db-same-length-change") {
          string privateDatabase = Path.Combine(directory, "snapshot.edb");
          using (FileStream stream = new FileStream(privateDatabase, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete)) {
            stream.Position = stream.Length - 1; int original = stream.ReadByte(); stream.Position = stream.Length - 1; stream.WriteByte((byte)(original ^ 1)); stream.Flush(true);
          }
        }
        if (stage == LineEncryptedSnapshot.Stage.Wal1Copied && scenario == "wal-mutated-before-validation") MutateHeldWal(expectedWalStream);
        if (stage == LineEncryptedSnapshot.Stage.WalValidated && scenario == "wal-mutated-at-validation") MutateHeldWal(expectedWalStream);
        if (stage == LineEncryptedSnapshot.Stage.Database1Copied) {
          string privateDatabase = Path.Combine(directory, "snapshot.edb");
          if (scenario == "replace-private-directory") {
            string moved = directory + "-moved";
            try { Directory.Move(directory, moved); }
            catch {
              File.WriteAllBytes(Path.Combine(directory, "UNOWNED_SENTINEL"), Encoding.ASCII.GetBytes("UNOWNED_DIRECTORY_SENTINEL"));
              throw new InvalidOperationException("snapshot_ownership_lost");
            }
            Directory.CreateDirectory(directory);
            File.WriteAllBytes(Path.Combine(directory, "UNOWNED_SENTINEL"), Encoding.ASCII.GetBytes("UNOWNED_DIRECTORY_SENTINEL"));
            throw new InvalidOperationException("snapshot_ownership_lost");
          }
          if (scenario == "wal-collision") File.WriteAllBytes(Path.Combine(directory, "snapshot.edb-wal"), Encoding.ASCII.GetBytes("UNOWNED_WAL_COLLISION"));
          if (scenario == "replace-file") { File.Delete(privateDatabase); File.WriteAllBytes(privateDatabase, Encoding.ASCII.GetBytes("UNOWNED_FILE_REPLACEMENT")); }
          if (scenario == "replace-directory") { File.Delete(privateDatabase); Directory.CreateDirectory(privateDatabase); File.WriteAllBytes(Path.Combine(privateDatabase, "sentinel"), Encoding.ASCII.GetBytes("UNOWNED_DIRECTORY_REPLACEMENT")); }
          if (scenario == "replace-reparse") {
            File.Delete(privateDatabase);
            string target = Path.Combine(Path.GetDirectoryName(directory), "snapshot-reparse-target");
            File.WriteAllBytes(target, Encoding.ASCII.GetBytes("UNOWNED_REPARSE_TARGET"));
            if (!CreateSymbolicLinkW(privateDatabase, target, 0)) throw new InvalidOperationException("snapshot_fixture_reparse_unavailable");
          }
        }
        if (stage != LineEncryptedSnapshot.Stage.Wal1Copied) return;
        if (scenario == "shm-collision") File.WriteAllText(Path.Combine(directory, "snapshot.edb-shm"), "UNOWNED_SHM_COLLISION");
        if (scenario == "private-journal-collision") File.WriteAllText(Path.Combine(directory, "snapshot.edb-journal"), "UNOWNED_JOURNAL_COLLISION");
        if (scenario == "same-length-change") {
          savedDatabase = File.ReadAllBytes(database);
          using (FileStream stream = new FileStream(database, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete)) {
            stream.Position = stream.Length - 1; int original = stream.ReadByte(); stream.Position = stream.Length - 1;
            stream.WriteByte((byte)(original ^ 1)); stream.Flush(true);
          }
          File.SetLastWriteTimeUtc(database, originalWrite);
        } else if (scenario == "hot-journal") {
          File.WriteAllBytes(database + "-journal", new byte[] { 1 }); madeJournal = true;
        } else if (scenario == "cancel") {
          cancellation.Cancel();
        } else if (scenario == "deadline") {
          Thread.Sleep(1200);
        } else if (scenario == "wal-replacement") {
          string wal = database + "-wal";
          savedWal = File.ReadAllBytes(wal);
          string replacement = wal + ".replacement", backup = wal + ".backup";
          File.Copy(wal, replacement, true);
          using (FileStream stream = new FileStream(replacement, FileMode.Open, FileAccess.ReadWrite, FileShare.Read)) {
            int value = stream.ReadByte(); stream.Position = 0; stream.WriteByte((byte)(value ^ 1)); stream.Flush(true);
          }
          File.Replace(replacement, wal, backup); backupPath = backup;
        }
      };
      if (scenario == "wal-absent" || scenario == "wal-empty" || scenario == "wal-header-only") {
        string sourceWal = database + "-wal";
        savedWal = File.ReadAllBytes(sourceWal);
        if (scenario == "wal-absent") File.Delete(sourceWal);
        else if (scenario == "wal-empty") File.WriteAllBytes(sourceWal, new byte[0]);
        else { byte[] header = new byte[32]; Buffer.BlockCopy(savedWal, 0, header, 0, Math.Min(header.Length, savedWal.Length)); File.WriteAllBytes(sourceWal, header); Array.Clear(header, 0, header.Length); }
      }
      LineEncryptedSnapshot.Limits limits = new LineEncryptedSnapshot.Limits();
      if (scenario == "size-limit") limits.MaxDatabaseBytes = 512;
      if (scenario == "deadline" || scenario == "deadline-held-guards") deadline = DateTime.UtcNow.AddMilliseconds(1000); // generous: a loaded machine can spend >250 ms before the first open
      if (scenario == "bad-wal-header" || scenario == "no-wal-commit" || scenario == "uncommitted-tail") {
        string sourceWal = database + "-wal";
        savedWal = File.ReadAllBytes(sourceWal);
        byte[] altered = (byte[])savedWal.Clone();
        if (scenario == "bad-wal-header") altered[0] ^= 0x01;
        else if (scenario == "no-wal-commit") RemoveAllWalCommits(altered);
        else altered = AppendUncommittedWalFrame(altered);
        File.WriteAllBytes(sourceWal, altered);
        Array.Clear(altered, 0, altered.Length);
      }
      LineEncryptedSnapshot.Capture capture = LineEncryptedSnapshot.CaptureOnce(database, directory, key, limits,
        deadline, cancellation.Token, hook, delegate(string privateDatabase) {
          if (scenario == "wal-stream-lifecycle") {
            string walPath = Path.Combine(directory, "snapshot.edb-wal");
            if (activeOwner == null || expectedWalStream == null || !Object.ReferenceEquals(expectedWalStream, activeOwner.GuardedStream(walPath)))
              throw new InvalidOperationException("snapshot_wal_stream_changed");
            AssertExternalWalMutationDenied(walPath);
          }
          if (scenario == "shm-replacement-boundary") {
            bool denied = false;
            try { File.Move(privateDatabase + "-shm", privateDatabase + "-shm.moved"); }
            catch (IOException) { denied = true; }
            if (!denied) throw new InvalidOperationException("snapshot_shm_rename_allowed");
          }
          string databaseOnlyDirectory = directory + "-database-only";
          Directory.CreateDirectory(databaseOnlyDirectory);
          string databaseOnlyPath = Path.Combine(databaseOnlyDirectory, "database-only.edb");
          try {
            File.Copy(privateDatabase, databaseOnlyPath, false);
            if (scenario == "guarded-open-boundary") {
              foreach (string guardedPath in new string[] { privateDatabase, privateDatabase + "-wal" }) {
                bool denied = false;
                try { using (FileStream mutation = new FileStream(guardedPath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) { mutation.WriteByte(0x55); mutation.Flush(true); } }
                catch (IOException) { denied = true; }
                if (!denied) throw new InvalidOperationException("snapshot_guard_write_allowed");
                denied = false;
                try { File.Move(guardedPath, guardedPath + ".moved"); }
                catch (IOException) { denied = true; }
                if (!denied) throw new InvalidOperationException("snapshot_guard_rename_allowed");
              }
            }
            openAttempts++;
            using (Sqlite3Mc databaseOnly = Sqlite3Mc.OpenReadOnly(databaseOnlyPath, key)) {
              if (!databaseOnly.VerifySchemaReadable()) throw new InvalidOperationException("snapshot_schema_unreadable");
              if (databaseOnly.ReadFixtureValue(1) != "fixture-row") throw new InvalidOperationException("snapshot_database_only_contains_wal_value");
            }
            DeleteFixtureFiles(databaseOnlyDirectory);
            openAttempts++;
            using (Sqlite3Mc connection = Sqlite3Mc.OpenReadOnly(privateDatabase, key)) {
              if (!connection.VerifySchemaReadable()) throw new InvalidOperationException("snapshot_schema_unreadable");
              string expectedValue = scenario == "wal-absent" || scenario == "wal-empty" ? "fixture-row" : "wal-only-value";
              if (connection.ReadFixtureValue(1) != expectedValue) throw new InvalidOperationException("snapshot_wal_value_missing");
              if (scenario == "journal-mid-callback") File.WriteAllText(privateDatabase + "-journal", "UNOWNED_JOURNAL_MID_CALLBACK");
              if (scenario == "journal-directory-boundary") { Directory.CreateDirectory(privateDatabase + "-journal"); File.WriteAllText(Path.Combine(privateDatabase + "-journal", "sentinel"), "UNOWNED_JOURNAL_DIRECTORY"); }
            }
            if (scenario == "cancel-held-guards") cancellation.Cancel();
            if (scenario == "deadline-held-guards") Thread.Sleep(1200);
            if (scenario == "callback-failure") throw new InvalidOperationException("snapshot_callback_failure");
          } finally {
            DeleteFixtureFiles(databaseOnlyDirectory);
          }
        });
      if (capture.CommittedWalBytes <= 32 && scenario != "wal-absent" && scenario != "wal-empty") throw new InvalidOperationException("snapshot_wal_no_commit");
      Console.WriteLine("PASS|ORDER=" + String.Join(",", order.ToArray()) + "|OPEN_ATTEMPTS=" + openAttempts + "|PAGE_SIZE=" + capture.DatabasePageSize + "|WAL_COMMIT_BYTES=" + capture.CommittedWalBytes);
      capture.Cleanup();
      return 0;
    } catch (Exception error) {
      Console.WriteLine("FAIL|" + FixedCode(error) + "|OPEN_ATTEMPTS=" + openAttempts + "|ORDER=" + String.Join(",", order.ToArray()));
      return 1;
    } finally {
      try { if (savedDatabase != null) { File.WriteAllBytes(database, savedDatabase); File.SetLastWriteTimeUtc(database, originalWrite); } } catch { }
      try { if (savedWal != null) { File.WriteAllBytes(database + "-wal", savedWal); } } catch { }
      try { if (backupPath != null && File.Exists(backupPath)) File.Delete(backupPath); } catch { }
      try { if (madeJournal && File.Exists(database + "-journal")) File.Delete(database + "-journal"); } catch { }
      if (savedDatabase != null) Array.Clear(savedDatabase, 0, savedDatabase.Length);
      if (savedWal != null) Array.Clear(savedWal, 0, savedWal.Length);
      Array.Clear(key, 0, key.Length);
    }
    }
  }
  static string FixedCode(Exception error) {
    if (error is OperationCanceledException) return "CANCELLED";
    if (error is TimeoutException) return "DEADLINE";
    string text = error.Message ?? "";
    foreach (string code in new string[] { "snapshot_directory_acl_convert_failed", "snapshot_directory_acl_verify_failed", "snapshot_directory_acl_failed", "snapshot_directory_create_failed", "snapshot_directory_identity_failed", "snapshot_source_changed", "snapshot_wal_invalid", "snapshot_wal_no_commit", "snapshot_wal_stream_changed", "snapshot_wal_guard_write_allowed", "snapshot_wal_guard_truncate_allowed", "snapshot_wal_guard_delete_allowed", "snapshot_wal_guard_replace_allowed", "snapshot_callback_failure", "snapshot_key_mismatch", "snapshot_hot_journal", "snapshot_size_limit", "snapshot_request_invalid", "snapshot_schema_unreadable", "snapshot_wal_value_missing" })
      if (text == code) return code;
    if (text == "snapshot_destination_exists" || text == "snapshot_ownership_lost") return text;
    return "snapshot_failure";
  }
  static void DeleteFixtureFiles(string directory) {
    foreach (string name in new string[] { "database-only.edb-wal", "database-only.edb-shm", "database-only.edb-journal", "database-only.edb" }) {
      string path = Path.Combine(directory, name);
      if (File.Exists(path)) File.Delete(path);
      else if (Directory.Exists(path)) throw new InvalidOperationException("snapshot_fixture_cleanup_ownership_lost");
    }
    if (Directory.Exists(directory)) Directory.Delete(directory, false);
  }
  static void MutateHeldWal(FileStream stream) {
    long originalPosition = stream.Position; stream.Position = stream.Length - 1; int value = stream.ReadByte();
    stream.Position = stream.Length - 1; stream.WriteByte((byte)(value ^ 1)); stream.Flush(true); stream.Position = originalPosition;
  }
  static void AssertExternalWalMutationDenied(string walPath) {
    bool denied = false;
    try { using (FileStream mutation = new FileStream(walPath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) { mutation.WriteByte(0x55); mutation.Flush(true); } }
    catch (IOException error) { if (!IsExpectedSharingViolation(error)) throw; denied = true; }
    if (!denied) throw new InvalidOperationException("snapshot_wal_guard_write_allowed");
    denied = false;
    try { using (FileStream mutation = new FileStream(walPath, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete)) mutation.SetLength(0); }
    catch (IOException error) { if (!IsExpectedSharingViolation(error)) throw; denied = true; }
    if (!denied) throw new InvalidOperationException("snapshot_wal_guard_truncate_allowed");
    denied = false;
    try { File.Delete(walPath); }
    catch (IOException error) { if (!IsExpectedSharingViolation(error)) throw; denied = true; }
    if (!denied) throw new InvalidOperationException("snapshot_wal_guard_delete_allowed");
    if (!File.Exists(walPath)) throw new InvalidOperationException("snapshot_wal_guard_delete_allowed");
    string replacement = walPath + ".replacement", backup = walPath + ".backup";
    try {
      File.WriteAllText(replacement, "UNOWNED_WAL_REPLACEMENT"); denied = false;
      try { File.Replace(replacement, walPath, backup); }
      catch (IOException error) { if (!IsExpectedSharingViolation(error)) throw; denied = true; }
      if (!denied || !File.Exists(walPath)) throw new InvalidOperationException("snapshot_wal_guard_replace_allowed");
    } finally { if (File.Exists(replacement)) File.Delete(replacement); if (File.Exists(backup)) File.Delete(backup); }
  }
  static bool IsExpectedSharingViolation(IOException error) { return (error.HResult & 0xffff) == 32; }
  static void RemoveAllWalCommits(byte[] wal) {
    int pageSize = WalPageSize(wal), frameSize = 24 + pageSize;
    if (wal.Length < 32 + frameSize || (wal.Length - 32) % frameSize != 0) throw new InvalidOperationException("snapshot_fixture_wal_shape");
    bool big = ReadU32Be(wal, 0) == 0x377f0683;
    uint c1 = ReadU32Be(wal, 24), c2 = ReadU32Be(wal, 28);
    for (int offset = 32; offset < wal.Length; offset += frameSize) {
      WriteU32Be(wal, offset + 4, 0);
      WalChecksum(wal, offset, 8, big, c1, c2, out c1, out c2);
      WalChecksum(wal, offset + 24, pageSize, big, c1, c2, out c1, out c2);
      WriteU32Be(wal, offset + 16, c1); WriteU32Be(wal, offset + 20, c2);
    }
  }
  static byte[] AppendUncommittedWalFrame(byte[] wal) {
    int pageSize = WalPageSize(wal), frameSize = 24 + pageSize;
    if (wal.Length < 32 + frameSize || (wal.Length - 32) % frameSize != 0) throw new InvalidOperationException("snapshot_fixture_wal_shape");
    int last = wal.Length - frameSize; byte[] result = new byte[wal.Length + frameSize];
    Buffer.BlockCopy(wal, 0, result, 0, wal.Length); Buffer.BlockCopy(wal, last, result, wal.Length, frameSize);
    WriteU32Be(result, wal.Length + 4, 0);
    bool big = ReadU32Be(wal, 0) == 0x377f0683;
    uint c1 = ReadU32Be(wal, last + 16), c2 = ReadU32Be(wal, last + 20);
    WalChecksum(result, wal.Length, 8, big, c1, c2, out c1, out c2);
    WalChecksum(result, wal.Length + 24, pageSize, big, c1, c2, out c1, out c2);
    WriteU32Be(result, wal.Length + 16, c1); WriteU32Be(result, wal.Length + 20, c2);
    return result;
  }
  static int WalPageSize(byte[] wal) {
    if (wal.Length < 32) throw new InvalidOperationException("snapshot_fixture_wal_shape");
    int page = (int)ReadU32Be(wal, 8); return page == 1 ? 65536 : page;
  }
  static void WalChecksum(byte[] data, int offset, int count, bool big, uint seed1, uint seed2, out uint first, out uint second) {
    if ((count & 7) != 0) throw new InvalidOperationException("snapshot_fixture_wal_shape");
    first = seed1; second = seed2;
    for (int i = 0; i < count; i += 8) {
      uint a = big ? ReadU32Be(data, offset + i) : ReadU32Le(data, offset + i);
      uint b = big ? ReadU32Be(data, offset + i + 4) : ReadU32Le(data, offset + i + 4);
      first = unchecked(first + a + second); second = unchecked(second + b + first);
    }
  }
  static uint ReadU32Be(byte[] data, int offset) { return ((uint)data[offset] << 24) | ((uint)data[offset + 1] << 16) | ((uint)data[offset + 2] << 8) | data[offset + 3]; }
  static uint ReadU32Le(byte[] data, int offset) { return (uint)data[offset] | ((uint)data[offset + 1] << 8) | ((uint)data[offset + 2] << 16) | ((uint)data[offset + 3] << 24); }
  static void WriteU32Be(byte[] data, int offset, uint value) { data[offset] = (byte)(value >> 24); data[offset + 1] = (byte)(value >> 16); data[offset + 2] = (byte)(value >> 8); data[offset + 3] = (byte)value; }
}
