using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Collections.Generic;
using System.Text;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

// One-shot observational snapshot primitive. It reads source files as bytes
// only; callers may open the owned private copy after key validation.
internal static class LineEncryptedSnapshot {
  internal sealed class Limits {
    internal long MaxDatabaseBytes = 64L * 1024 * 1024;
    internal long MaxWalBytes = 16L * 1024 * 1024;
    internal long MaxSnapshotBytes = 80L * 1024 * 1024;
    internal int ReadChunkBytes = 64 * 1024;
  }
  internal sealed class Capture {
    internal string DatabasePath;
    internal string WalPath;
    internal long DatabaseBytes;
    internal long WalBytes;
    internal int DatabasePageSize;
    internal int CommittedWalBytes;
    internal string DatabaseSha256;
    internal string WalSha256;
    internal SnapshotOwner Owner;
    internal void Cleanup(bool removeDirectory = false) { if (Owner != null) Owner.Cleanup(removeDirectory); }
  }
  internal enum Stage { Database1Copied, Wal1Copied, Wal2Observed, Database2Observed, WalValidated, BeforeOpen }
  internal delegate void StageHook(Stage stage, SnapshotOwner owner);

  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] struct ByHandleFileInformation {
    public uint Attributes; public FileTime Creation; public FileTime Access; public FileTime Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
    internal int Length; internal IntPtr SecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] internal bool InheritHandle;
  }
  [StructLayout(LayoutKind.Sequential)] struct AclSizeInformation { internal uint AceCount, AclBytesInUse, AclBytesFree; }
  [StructLayout(LayoutKind.Sequential)] struct FileDispositionInfo { [MarshalAs(UnmanagedType.U1)] internal bool DeleteFile; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle, out ByHandleFileInformation info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, ref FileDispositionInfo info, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType, uint information, IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorControl(IntPtr descriptor, out ushort control, out uint revision);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetAclInformation(IntPtr acl, out AclSizeInformation info, uint length, uint informationClass);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetAce(IntPtr acl, uint index, out IntPtr ace);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr stringSid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  sealed class Observation {
    internal bool Present; internal uint Volume; internal uint IndexHigh; internal uint IndexLow;
    internal long Length; internal long WriteTime; internal byte[] Hash; internal string CopyPath; internal FileStream CopyStream;
  }
  internal sealed class SnapshotOwner {
    internal sealed class FileIdentity { internal uint Volume, IndexHigh, IndexLow; }
    readonly string directory, marker;
    readonly FileIdentity directoryIdentity;
    readonly SafeFileHandle directoryHandle;
    readonly Dictionary<string, FileIdentity> files = new Dictionary<string, FileIdentity>(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, FileStream> guards = new Dictionary<string, FileStream>(StringComparer.OrdinalIgnoreCase);
    readonly List<FileStream> guardOrder = new List<FileStream>();
    bool cleaned;
    SnapshotOwner(string root, FileIdentity identity, SafeFileHandle handle) { directory = root; marker = Path.Combine(root, "snapshot.owner"); directoryIdentity = identity; directoryHandle = handle; }
    internal static SnapshotOwner Create(string root) {
      SafeFileHandle handle = OpenDirectoryHandle(root);
      try {
        ByHandleFileInformation info;
        if (handle.IsInvalid || !GetFileInformationByHandle(handle.DangerousGetHandle(), out info) || (info.Attributes & 0x400) != 0)
          throw new InvalidOperationException("snapshot_directory_identity_failed");
        FileIdentity directoryId = new FileIdentity { Volume = info.Volume, IndexHigh = info.IndexHigh, IndexLow = info.IndexLow };
        VerifySecureDirectory(handle);
        SnapshotOwner owner = new SnapshotOwner(root, directoryId, handle);
        byte[] token = Guid.NewGuid().ToByteArray();
        try {
          using (FileStream stream = new FileStream(owner.marker, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete)) {
            stream.Write(token, 0, token.Length); stream.Flush(true); owner.Record(owner.marker, stream);
          }
        } finally { Array.Clear(token, 0, token.Length); }
        owner.AssertDirectory(); return owner;
      } catch {
        handle.Dispose(); throw;
      }
    }
    internal void Record(string path, FileStream opened) {
      path = Path.GetFullPath(path);
      if (files.ContainsKey(path)) throw new InvalidOperationException("snapshot_ownership_lost");
      ByHandleFileInformation info = Info(opened);
      files.Add(path, new FileIdentity { Volume = info.Volume, IndexHigh = info.IndexHigh, IndexLow = info.IndexLow });
    }
    internal void AssertDirectory() {
      ByHandleFileInformation heldInfo;
      if (directoryHandle.IsClosed || directoryHandle.IsInvalid || !GetFileInformationByHandle(directoryHandle.DangerousGetHandle(), out heldInfo) ||
          heldInfo.Volume != directoryIdentity.Volume || heldInfo.IndexHigh != directoryIdentity.IndexHigh || heldInfo.IndexLow != directoryIdentity.IndexLow)
        throw new InvalidOperationException("snapshot_ownership_lost");
      AssertDirectoryPath(directory);
      FileIdentity record;
      if (!files.TryGetValue(marker, out record) || !MatchesPath(marker, record)) throw new InvalidOperationException("snapshot_ownership_lost");
    }
    internal void AssertAllOwned() {
      AssertDirectory();
      foreach (KeyValuePair<string, FileIdentity> entry in files) {
        FileStream held;
        if (guards.TryGetValue(entry.Key, out held)) AssertOpenIdentity(entry.Key, held);
        else AssertOwnedPath(entry.Key);
      }
    }
    internal FileStream AcquireGuard(string path, FileAccess access, FileShare share) {
      path = Path.GetFullPath(path); AssertOwnedPath(path);
      FileStream stream = new FileStream(path, FileMode.Open, access, share);
      try { AssertOwnedHandle(path, stream); guards[path] = stream; guardOrder.Add(stream); return stream; }
      catch { stream.Dispose(); throw; }
    }
    internal void AdoptGuard(string path, FileStream stream) {
      path = Path.GetFullPath(path);
      if (guards.ContainsKey(path)) throw new InvalidOperationException("snapshot_ownership_lost");
      AssertOpenIdentity(path, stream); guards[path] = stream; guardOrder.Add(stream);
    }
    internal void CreateOwnedShm(string path) {
      path = Path.GetFullPath(path); AssertDirectory();
      if (File.Exists(path) || Directory.Exists(path)) throw new InvalidOperationException("snapshot_ownership_lost");
      FileStream stream;
      try { stream = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.ReadWrite); }
      catch (IOException) { throw new InvalidOperationException("snapshot_ownership_lost"); }
      try { Record(path, stream); AssertOwnedHandle(path, stream); guards[path] = stream; guardOrder.Add(stream); }
      catch { stream.Dispose(); throw; }
    }
    internal void ReleaseGuards() {
      for (int i = guardOrder.Count - 1; i >= 0; i--) guardOrder[i].Dispose();
      guards.Clear();
      guardOrder.Clear();
    }
    internal FileStream GuardedStream(string path) {
      FileStream stream; if (!guards.TryGetValue(Path.GetFullPath(path), out stream)) throw new InvalidOperationException("snapshot_ownership_lost");
      AssertOpenIdentity(path, stream); return stream;
    }
    internal void AssertGuardedPaths() { foreach (KeyValuePair<string, FileStream> entry in guards) AssertOpenIdentity(entry.Key, entry.Value); }
    internal void AssertOwnedPath(string path) {
      path = Path.GetFullPath(path); AssertDirectory();
      FileIdentity record;
      if (!files.TryGetValue(path, out record) || !MatchesPath(path, record)) throw new InvalidOperationException("snapshot_ownership_lost");
    }
    internal void AssertOptionalOwnedPath(string path, bool expectedPresent) {
      path = Path.GetFullPath(path); AssertDirectory(); FileIdentity record;
      bool owned = files.TryGetValue(path, out record);
      bool present = File.Exists(path) || Directory.Exists(path);
      if (present != expectedPresent || owned != expectedPresent || (owned && !MatchesPath(path, record)))
        throw new InvalidOperationException("snapshot_ownership_lost");
    }
    internal void AssertOwnedHandle(string path, FileStream opened) {
      path = Path.GetFullPath(path); AssertOwnedPath(path); FileIdentity record = files[path]; ByHandleFileInformation info = Info(opened);
      AssertIdentity(record, info);
    }
    internal void AssertOpenIdentity(string path, FileStream opened) {
      path = Path.GetFullPath(path); AssertDirectory(); FileIdentity record;
      if (!files.TryGetValue(path, out record)) throw new InvalidOperationException("snapshot_ownership_lost");
      AssertIdentity(record, Info(opened));
    }
    static void AssertIdentity(FileIdentity record, ByHandleFileInformation info) {
      if (info.Volume != record.Volume || info.IndexHigh != record.IndexHigh || info.IndexLow != record.IndexLow)
        throw new InvalidOperationException("snapshot_ownership_lost");
    }
    internal void AssertNoJournal() {
      string path = Path.Combine(directory, "snapshot.edb-journal");
      try { AssertPlainPath(path, true); }
      catch { throw new InvalidOperationException("snapshot_ownership_lost"); }
      if (File.Exists(path) || Directory.Exists(path)) throw new InvalidOperationException("snapshot_ownership_lost");
    }
    bool MatchesPath(string path, FileIdentity record) {
      try {
        AssertPlainPath(path, false); FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return false;
        ByHandleFileInformation info = InfoPath(path);
        return info.Volume == record.Volume && info.IndexHigh == record.IndexHigh && info.IndexLow == record.IndexLow;
      } catch { return false; }
    }
    bool MatchesDirectory(string path) {
      try {
        using (SafeFileHandle handle = CreateFileW(path, 0x80, 0x1 | 0x2, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
          if (handle.IsInvalid) return false;
          ByHandleFileInformation info;
          if (!GetFileInformationByHandle(handle.DangerousGetHandle(), out info)) return false;
          return info.Volume == directoryIdentity.Volume && info.IndexHigh == directoryIdentity.IndexHigh && info.IndexLow == directoryIdentity.IndexLow;
        }
      } catch { return false; }
    }
    internal void DeleteOwned(string path) {
      path = Path.GetFullPath(path); AssertDirectory(); FileIdentity record;
      if (!files.TryGetValue(path, out record)) throw new InvalidOperationException("snapshot_ownership_lost");
      if (!MatchesPath(path, record)) throw new InvalidOperationException("snapshot_ownership_lost");
      DeleteIdentityBound(path, record); files.Remove(path);
    }
    internal void Cleanup(bool removeDirectory = false) {
      if (cleaned) return;
      ReleaseGuards();
      bool lost = false; string cleanupRoot = directory;
      try {
        if (!MatchesDirectory(cleanupRoot)) cleanupRoot = FindRelocatedDirectory();
        string[] order = new string[] { "snapshot.edb-wal", "snapshot.edb-shm", "snapshot.edb-journal", "snapshot.edb", "snapshot.owner" };
        foreach (string name in order) {
          string path = Path.Combine(cleanupRoot, name), recordedPath = Path.Combine(directory, name); FileIdentity record;
          if (!files.TryGetValue(recordedPath, out record)) continue;
          FileAttributes attributes;
          try { attributes = File.GetAttributes(path); }
          catch (FileNotFoundException) { files.Remove(recordedPath); continue; }
          catch (DirectoryNotFoundException) { files.Remove(recordedPath); continue; }
          if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 || !MatchesPath(path, record)) { lost = true; continue; }
          try { DeleteIdentityBound(path, record, cleanupRoot); files.Remove(recordedPath); }
          catch { lost = true; }
        }
        try { if (Directory.GetFileSystemEntries(cleanupRoot).Length != 0) lost = true; }
        catch { lost = true; }
        if (removeDirectory && !lost) {
          AssertDirectoryPath(cleanupRoot);
          FileDispositionInfo disposition = new FileDispositionInfo { DeleteFile = true };
          if (!SetFileInformationByHandle(directoryHandle, 4, ref disposition,
              (uint)Marshal.SizeOf(typeof(FileDispositionInfo)))) lost = true;
        }
      } catch { lost = true; }
      finally {
        if (files.Count == 0) cleaned = true;
        directoryHandle.Dispose();
      }
      if (lost) throw new InvalidOperationException("snapshot_ownership_lost");
    }
    void DeleteIdentityBound(string path, FileIdentity record) { DeleteIdentityBound(path, record, directory); }
    void DeleteIdentityBound(string path, FileIdentity record, string root) {
      AssertDirectoryPath(root);
      using (SafeFileHandle handle = CreateFileW(path, 0x10080, 0x1 | 0x2 | 0x4, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
        ByHandleFileInformation info;
        if (handle.IsInvalid || !GetFileInformationByHandle(handle.DangerousGetHandle(), out info) ||
            info.Volume != record.Volume || info.IndexHigh != record.IndexHigh || info.IndexLow != record.IndexLow)
          throw new InvalidOperationException("snapshot_ownership_lost");
        AssertDirectoryPath(root);
        FileDispositionInfo disposition = new FileDispositionInfo { DeleteFile = true };
        if (!SetFileInformationByHandle(handle, 4, ref disposition, (uint)Marshal.SizeOf(typeof(FileDispositionInfo))))
          throw new IOException("snapshot_owned_delete_failed");
      }
    }
    string FindRelocatedDirectory() {
      StringBuilder value = new StringBuilder(1024);
      uint length = GetFinalPathNameByHandleW(directoryHandle, value, (uint)value.Capacity, 0);
      if (length == 0 || length >= value.Capacity) throw new InvalidOperationException("snapshot_ownership_lost");
      string path = value.ToString();
      if (path.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) path = "\\\\" + path.Substring(8);
      else if (path.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase)) path = path.Substring(4);
      if (String.Equals(path, directory, StringComparison.OrdinalIgnoreCase) || !MatchesDirectory(path))
        throw new InvalidOperationException("snapshot_ownership_lost");
      return path;
    }
    void AssertDirectoryPath(string path) {
      AssertPlainPath(path, false); FileAttributes attributes = File.GetAttributes(path);
      if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0 || !MatchesDirectory(path))
        throw new InvalidOperationException("snapshot_ownership_lost");
    }
  }

  internal static Capture CaptureOnce(string databasePath, string privateDirectory, byte[] key, Limits limits,
      DateTime deadlineUtc, CancellationToken cancellation, StageHook hook, Action<string> openPrivateSnapshot,
      bool removeOwnedDirectory = false, Action<long, long> copyProgress = null, long totalCopyBytes = -1,
      Action<long> snapshotProgress = null, Action<long> consistencyProgress = null) {
    ValidateInputs(databasePath, privateDirectory, key, limits, deadlineUtc);
    string db = Path.GetFullPath(databasePath), wal = db + "-wal", journal = db + "-journal";
    string directory = Path.GetFullPath(privateDirectory);
    AssertPlainPath(db, false); AssertPlainPath(wal, true); AssertPlainPath(journal, true);
    if (File.Exists(journal)) throw new InvalidOperationException("snapshot_hot_journal");
    if (Directory.Exists(directory)) throw new InvalidOperationException("snapshot_destination_exists");
    CreatePrivateDirectory(directory);
    AssertPlainPath(directory, false);
    string privateDb = Path.Combine(directory, "snapshot.edb"), privateWal = Path.Combine(directory, "snapshot.edb-wal");
    SnapshotOwner owner = SnapshotOwner.Create(directory);
    Observation db1 = null, wal1 = null; byte[] committedWalHash = null; long hashedBytes = 0, rereadBytes = 0;
    Action<long> hashProgress = null;
    if (snapshotProgress != null) hashProgress = delegate(long bytes) { hashedBytes += bytes; snapshotProgress(hashedBytes); };
    Action<long> rereadProgress = null;
    if (consistencyProgress != null) rereadProgress = delegate(long bytes) {
      rereadBytes += bytes; consistencyProgress(rereadBytes);
    };
    try {
      Check(deadlineUtc, cancellation);
      db1 = Observe(db, false, privateDb, limits.MaxDatabaseBytes, limits, 0, deadlineUtc, cancellation, owner, false, copyProgress, totalCopyBytes);
      if (hook != null) hook(Stage.Database1Copied, owner);
      Check(deadlineUtc, cancellation);
      wal1 = Observe(wal, true, privateWal, limits.MaxWalBytes, limits, db1.Length, deadlineUtc, cancellation, owner, true, copyProgress, totalCopyBytes);
      if (hook != null) hook(Stage.Wal1Copied, owner);
      Check(deadlineUtc, cancellation);
      Observation wal2 = Observe(wal, true, null, limits.MaxWalBytes, limits, db1.Length, deadlineUtc, cancellation, owner, false, null, -1, rereadProgress);
      if (hook != null) hook(Stage.Wal2Observed, owner);
      Check(deadlineUtc, cancellation);
      Observation db2 = Observe(db, false, null, limits.MaxDatabaseBytes, limits, wal2.Present ? wal2.Length : 0, deadlineUtc, cancellation, owner, false, null, -1, rereadProgress);
      if (hook != null) hook(Stage.Database2Observed, owner);
      if (!Same(db1, db2) || !Same(wal1, wal2)) throw new InvalidOperationException("snapshot_source_changed");
      AssertPlainPath(journal, true);
      if (File.Exists(journal)) throw new InvalidOperationException("snapshot_hot_journal");
      int pageSize = DatabasePageSize(privateDb, db1.Length, deadlineUtc, cancellation, owner);
      int committedBytes = 0;
      if (wal1.Present && wal1.Length > 0) {
        FileStream walStream = wal1.CopyStream;
        owner.AssertOpenIdentity(privateWal, walStream);
        if (walStream.Length != wal1.Length || !Equal(HashGuard(walStream, limits, deadlineUtc, cancellation, hashProgress), wal1.Hash))
          throw new InvalidOperationException("snapshot_source_changed");
        WalValidation walValidation = ValidateAndTrimWal(privateWal, walStream, wal1.Length, pageSize, limits, deadlineUtc, cancellation, owner, hashProgress);
        committedBytes = walValidation.CommittedBytes; committedWalHash = walValidation.CommittedHash;
        if (committedBytes <= 32) throw new InvalidOperationException("snapshot_wal_no_commit");
        if (hook != null) hook(Stage.WalValidated, owner);
        if (walStream.Length != committedBytes || !Equal(HashGuard(walStream, limits, deadlineUtc, cancellation, hashProgress), committedWalHash))
          throw new InvalidOperationException("snapshot_source_changed");
      }
      if (hook != null) hook(Stage.BeforeOpen, owner);
      Check(deadlineUtc, cancellation);
      owner.AssertOwnedPath(privateDb);
      FileStream dbGuard = owner.AcquireGuard(privateDb, FileAccess.Read, FileShare.Read);
      if (dbGuard.Length != db1.Length || !Equal(HashGuard(dbGuard, limits, deadlineUtc, cancellation, hashProgress), db1.Hash))
        throw new InvalidOperationException("snapshot_source_changed");
      byte[] firstPage = ReadPrefixGuard(dbGuard, 4096, deadlineUtc, cancellation);
      bool valid;
      try { valid = LineEncryptedPageValidator.FirstPageValid(firstPage, key); }
      finally { Array.Clear(firstPage, 0, firstPage.Length); }
      if (!valid) throw new InvalidOperationException("snapshot_key_mismatch");
      owner.AssertNoJournal();
      if (openPrivateSnapshot != null) {
        owner.CreateOwnedShm(Path.Combine(directory, "snapshot.edb-shm"));
        owner.AssertNoJournal();
        try { Check(deadlineUtc, cancellation); openPrivateSnapshot(privateDb); Check(deadlineUtc, cancellation); owner.AssertNoJournal(); owner.AssertAllOwned(); }
        finally { owner.ReleaseGuards(); }
      } else {
        owner.AssertNoJournal(); owner.AssertAllOwned();
      }
      bool hasPrivateWal = wal1.Present && committedBytes > 0;
      return new Capture { DatabasePath = privateDb, WalPath = hasPrivateWal ? privateWal : null,
        DatabaseBytes = db1.Length, WalBytes = wal1.Present ? committedBytes : 0, DatabasePageSize = pageSize,
        CommittedWalBytes = committedBytes, DatabaseSha256 = Hex(db1.Hash),
        WalSha256 = hasPrivateWal ? Hex(committedWalHash) : null, Owner = owner };
    } catch {
      try { owner.Cleanup(removeOwnedDirectory); } catch { throw new InvalidOperationException("snapshot_ownership_lost"); }
      throw;
    } finally {
      Clear(db1 == null ? null : db1.Hash); Clear(wal1 == null ? null : wal1.Hash); Clear(committedWalHash);
    }
  }

  internal static Capture CaptureFixed(string databasePath, string privateDirectory, byte[] key, Limits limits,
      CancellationToken cancellation, string expectedMid, Action<string> openPrivateSnapshot,
      Action<long, long> copyProgress, Action<long> snapshotProgress = null) {
    ValidateInputs(databasePath, privateDirectory, key, limits, DateTime.MaxValue);
    if (String.IsNullOrEmpty(expectedMid) || openPrivateSnapshot == null || copyProgress == null)
      throw new InvalidOperationException("snapshot_request_invalid");
    string db = Path.GetFullPath(databasePath), directory = Path.GetFullPath(privateDirectory);
    AssertPlainPath(db, false); AssertPlainPath(db + "-wal", true); AssertPlainPath(db + "-journal", true);
    if (File.Exists(db + "-journal")) throw new InvalidOperationException("snapshot_hot_journal");
    FileInfo sourceInfo = new FileInfo(db);
    if (!sourceInfo.Exists || sourceInfo.Length > limits.MaxDatabaseBytes) throw new InvalidOperationException("snapshot_size_limit");
    if (Directory.Exists(directory)) throw new InvalidOperationException("snapshot_destination_exists");
    CreatePrivateDirectory(directory);
    AssertPlainPath(directory, false);
    string privateDb = Path.Combine(directory, "snapshot.edb");
    SnapshotOwner owner = SnapshotOwner.Create(directory);
    try {
      cancellation.ThrowIfCancellationRequested(); owner.AssertDirectory();
      using (FileStream destinationGuard = new FileStream(privateDb, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.ReadWrite)) {
        owner.Record(privateDb, destinationGuard); owner.AssertOpenIdentity(privateDb, destinationGuard);
        using (Sqlite3Mc source = Sqlite3Mc.OpenReadOnly(db, key)) {
          source.BackupTo(privateDb, key, expectedMid, cancellation, limits.MaxDatabaseBytes, limits.MaxWalBytes,
            limits.MaxSnapshotBytes, copyProgress);
        }
        cancellation.ThrowIfCancellationRequested(); owner.AssertOpenIdentity(privateDb, destinationGuard);
        AssertNoPrivateSidecars(directory); owner.AssertOwnedPath(privateDb); owner.AssertNoJournal();
        openPrivateSnapshot(privateDb);
        AssertNoPrivateSidecars(directory); owner.AssertOpenIdentity(privateDb, destinationGuard);
        cancellation.ThrowIfCancellationRequested(); owner.AssertNoJournal(); owner.AssertAllOwned();
        long databaseBytes = new FileInfo(privateDb).Length;
        if (databaseBytes < 1 || databaseBytes > limits.MaxSnapshotBytes) throw new InvalidOperationException("snapshot_size_limit");
        byte[] digest = HashFile(privateDb, limits, DateTime.MaxValue, cancellation, owner, snapshotProgress, FileShare.ReadWrite);
        try {
          owner.AssertNoJournal(); owner.AssertOpenIdentity(privateDb, destinationGuard); owner.AssertAllOwned();
          return new Capture { DatabasePath = privateDb, WalPath = null, DatabaseBytes = databaseBytes, WalBytes = 0,
            DatabasePageSize = 0, CommittedWalBytes = 0, DatabaseSha256 = Hex(digest), WalSha256 = null, Owner = owner };
        } finally { Clear(digest); }
      }
    } catch {
      try { owner.Cleanup(true); } catch { throw new InvalidOperationException("snapshot_ownership_lost"); }
      throw;
    }
  }

  static void AssertNoPrivateSidecars(string directory) {
    foreach (string suffix in new string[] { "-wal", "-shm", "-journal" }) {
      string path = Path.Combine(directory, "snapshot.edb" + suffix);
      if (File.Exists(path) || Directory.Exists(path)) throw new InvalidOperationException("snapshot_backup_failed");
    }
  }
  static Observation Observe(string path, bool optional, string destination, long maxBytes, Limits limits,
      long aggregateBase, DateTime deadline, CancellationToken cancellation, SnapshotOwner owner, bool retainTarget,
      Action<long, long> copyProgress = null, long totalCopyBytes = -1, Action<long> rereadProgress = null) {
    owner.AssertAllOwned();
    Check(deadline, cancellation); AssertPlainPath(path, optional);
    if (!File.Exists(path)) {
      if (optional) {
        if (destination != null && retainTarget) {
          AssertPlainPath(Path.GetDirectoryName(destination), false);
          FileStream empty = new FileStream(destination, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read,
            limits.ReadChunkBytes, FileOptions.SequentialScan);
          owner.Record(destination, empty); owner.AssertOpenIdentity(destination, empty); owner.AdoptGuard(destination, empty);
        }
        return new Observation { Present = false };
      }
      throw new InvalidOperationException("snapshot_source_missing");
    }
    Observation result = new Observation { Present = true };
    FileStream source = null, target = null;
    try {
      source = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, limits.ReadChunkBytes, FileOptions.SequentialScan);
      ByHandleFileInformation before = Info(source);
      result.Volume = before.Volume; result.IndexHigh = before.IndexHigh; result.IndexLow = before.IndexLow;
      result.WriteTime = Time(before.Write); result.Length = Size(before);
      if (result.Length > maxBytes || aggregateBase + result.Length > limits.MaxSnapshotBytes) throw new InvalidOperationException("snapshot_size_limit");
      if (destination != null) {
        AssertPlainPath(Path.GetDirectoryName(destination), false);
        if (File.Exists(destination) || Directory.Exists(destination)) throw new InvalidOperationException("snapshot_ownership_lost");
        target = new FileStream(destination, FileMode.CreateNew, retainTarget ? FileAccess.ReadWrite : FileAccess.Write,
          retainTarget ? FileShare.Read : FileShare.Read | FileShare.Delete, limits.ReadChunkBytes, FileOptions.SequentialScan);
        owner.Record(destination, target);
        if (retainTarget) owner.AssertOpenIdentity(destination, target);
        else owner.AssertOwnedHandle(destination, target);
        result.CopyPath = destination;
      }
      using (SHA256 sha = SHA256.Create()) {
        byte[] buffer = new byte[limits.ReadChunkBytes]; long total = 0;
        try {
          while (true) {
            Check(deadline, cancellation);
            int read = source.Read(buffer, 0, buffer.Length); if (read == 0) break;
            total += read;
            if (rereadProgress != null) rereadProgress(read);
            if (total > maxBytes || aggregateBase + total > limits.MaxSnapshotBytes) throw new InvalidOperationException("snapshot_size_limit");
            sha.TransformBlock(buffer, 0, read, buffer, 0);
            if (target != null) target.Write(buffer, 0, read);
            if (copyProgress != null) copyProgress(aggregateBase + total, totalCopyBytes);
          }
          sha.TransformFinalBlock(new byte[0], 0, 0); result.Hash = sha.Hash;
        } finally { Array.Clear(buffer, 0, buffer.Length); }
        if (total != result.Length) throw new InvalidOperationException("snapshot_source_changed");
      }
      if (target != null) {
        target.Flush(true);
        if (retainTarget) owner.AssertOpenIdentity(destination, target);
        else owner.AssertOwnedHandle(destination, target);
        if (retainTarget) { owner.AdoptGuard(destination, target); result.CopyStream = target; target = null; }
        else { target.Dispose(); target = null; owner.AssertOwnedPath(destination); }
      }
      ByHandleFileInformation after = Info(source); ByHandleFileInformation pathAfter = InfoPath(path);
      if (!SameMetadata(before, after) || !SameMetadata(after, pathAfter)) throw new InvalidOperationException("snapshot_source_changed");
    } catch {
      if (target != null) target.Dispose();
      throw;
    }
    finally { if (source != null) source.Dispose(); }
    return result;
  }

  sealed class WalValidation { internal int CommittedBytes; internal byte[] CommittedHash; }
  static WalValidation ValidateAndTrimWal(string path, FileStream stream, long walLength, int dbPageSize, Limits limits,
      DateTime deadline, CancellationToken cancellation, SnapshotOwner owner, Action<long> progress = null) {
    owner.AssertOpenIdentity(path, stream);
    if (stream.Length != walLength) throw new InvalidOperationException("snapshot_source_changed");
    if (walLength == 0) throw new InvalidOperationException("snapshot_wal_no_commit");
    if (walLength < 32) throw new InvalidOperationException("snapshot_wal_invalid");
    byte[] header = new byte[32], frameHeader = new byte[24], data = new byte[Math.Min(65536, dbPageSize)];
    try {
      stream.Position = 0; ReadExact(stream, header, 0, 32);
      uint magic = ReadU32(header, 0), version = ReadU32(header, 4), pageSize = ReadU32(header, 8);
      bool bigEndian = magic == 0x377f0683;
      if ((magic != 0x377f0682 && magic != 0x377f0683) || version != 3007000 || pageSize != dbPageSize || pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) != 0)
        throw new InvalidOperationException("snapshot_wal_invalid");
      uint check1, check2; WalChecksum(header, 0, 24, bigEndian, 0, 0, out check1, out check2);
      if (ReadU32(header, 24) != check1 || ReadU32(header, 28) != check2) throw new InvalidOperationException("snapshot_wal_invalid");
      uint salt1 = ReadU32(header, 16), salt2 = ReadU32(header, 20);
      long frameSize = 24L + pageSize, offset = 32, validFrames = 0, lastCommit = 0; bool anyBadTail = false;
      while (walLength - offset >= frameSize) {
        Check(deadline, cancellation);
        stream.Position = offset; ReadExact(stream, frameHeader, 0, 24);
        uint page = ReadU32(frameHeader, 0), commit = ReadU32(frameHeader, 4);
        if (page == 0 || ReadU32(frameHeader, 8) != salt1 || ReadU32(frameHeader, 12) != salt2) { anyBadTail = true; break; }
        uint c1 = check1, c2 = check2;
        WalChecksum(frameHeader, 0, 8, bigEndian, c1, c2, out c1, out c2);
        long remaining = pageSize; long pos = offset + 24;
        while (remaining > 0) {
          Check(deadline, cancellation);
          int chunk = (int)Math.Min(data.Length, remaining); stream.Position = pos; ReadExact(stream, data, 0, chunk);
          WalChecksum(data, 0, chunk, bigEndian, c1, c2, out c1, out c2);
          if (progress != null) progress(chunk);
          pos += chunk; remaining -= chunk;
        }
        if (ReadU32(frameHeader, 16) != c1 || ReadU32(frameHeader, 20) != c2) { anyBadTail = true; break; }
        check1 = c1; check2 = c2; validFrames++; offset += frameSize; if (commit != 0) lastCommit = validFrames;
      }
      if (lastCommit == 0) throw new InvalidOperationException("snapshot_wal_no_commit");
      long committedLength = 32 + lastCommit * frameSize;
      if (committedLength < 32 || committedLength > walLength) throw new InvalidOperationException("snapshot_wal_invalid");
      if (committedLength != walLength || anyBadTail) stream.SetLength(committedLength);
      stream.Flush(true);
      if (stream.Length != committedLength) throw new InvalidOperationException("snapshot_source_changed");
      return new WalValidation { CommittedBytes = checked((int)committedLength),
        CommittedHash = HashGuard(stream, limits, deadline, cancellation, progress) };
    } finally { Array.Clear(header, 0, header.Length); Array.Clear(frameHeader, 0, frameHeader.Length); Array.Clear(data, 0, data.Length); }
  }

  static void WalChecksum(byte[] data, int offset, int count, bool big, uint seed1, uint seed2, out uint first, out uint second) {
    if ((count & 7) != 0) throw new InvalidOperationException("snapshot_wal_invalid");
    first = seed1; second = seed2;
    for (int i = 0; i < count; i += 8) {
      uint a = ReadWord(data, offset + i, big), b = ReadWord(data, offset + i + 4, big);
      first = unchecked(first + a + second); second = unchecked(second + b + first);
    }
  }
  static uint ReadWord(byte[] b, int i, bool big) { return big ? ReadU32(b, i) : (uint)(b[i] | b[i+1] << 8 | b[i+2] << 16 | b[i+3] << 24); }
  static uint ReadU32(byte[] b, int i) { return ((uint)b[i] << 24) | ((uint)b[i+1] << 16) | ((uint)b[i+2] << 8) | b[i+3]; }
  static int DatabasePageSize(string path, long length, DateTime deadline, CancellationToken cancellation, SnapshotOwner owner) {
    byte[] prefix = ReadPrefix(path, 100, deadline, cancellation, owner);
    int encoded = (prefix[16] << 8) | prefix[17]; int pageSize = encoded == 1 ? 65536 : encoded;
    Array.Clear(prefix, 0, prefix.Length);
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) != 0 || length % pageSize != 0)
      throw new InvalidOperationException("snapshot_database_header_invalid");
    return pageSize;
  }
  static byte[] ReadPrefix(string path, int length, DateTime deadline, CancellationToken cancellation, SnapshotOwner owner) {
    owner.AssertOwnedPath(path);
    byte[] result = new byte[length]; using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) { owner.AssertOwnedHandle(path, stream); int read = 0; while (read < length) { Check(deadline, cancellation); int n = stream.Read(result, read, length-read); if (n == 0) throw new InvalidOperationException("snapshot_database_header_invalid"); read += n; } }
    return result;
  }
  static byte[] HashFile(string path, Limits limits, DateTime deadline, CancellationToken cancellation, SnapshotOwner owner,
      Action<long> progress = null, FileShare share = FileShare.Read) {
    owner.AssertOwnedPath(path);
    using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, share)) using (SHA256 sha = SHA256.Create()) {
      owner.AssertOwnedHandle(path, stream);
      byte[] buffer = new byte[limits.ReadChunkBytes];
      try {
        long hashed = 0;
        while (true) { Check(deadline, cancellation); int read = stream.Read(buffer, 0, buffer.Length); if (read == 0) break; sha.TransformBlock(buffer, 0, read, buffer, 0); hashed += read; if (progress != null) progress(hashed); }
        sha.TransformFinalBlock(new byte[0], 0, 0); return sha.Hash;
      } finally { Array.Clear(buffer, 0, buffer.Length); }
    }
  }
  static byte[] HashGuard(FileStream stream, Limits limits, DateTime deadline, CancellationToken cancellation, Action<long> progress = null) {
    stream.Position = 0;
    using (SHA256 sha = SHA256.Create()) {
      byte[] buffer = new byte[limits.ReadChunkBytes];
      try {
        while (true) { Check(deadline, cancellation); int read = stream.Read(buffer, 0, buffer.Length); if (read == 0) break; sha.TransformBlock(buffer, 0, read, buffer, 0); if (progress != null) progress(read); }
        sha.TransformFinalBlock(new byte[0], 0, 0); return sha.Hash;
      } finally { Array.Clear(buffer, 0, buffer.Length); }
    }
  }
  static byte[] ReadPrefixGuard(FileStream stream, int length, DateTime deadline, CancellationToken cancellation) {
    stream.Position = 0; byte[] result = new byte[length]; int read = 0;
    while (read < length) { Check(deadline, cancellation); int n = stream.Read(result, read, length-read); if (n == 0) throw new InvalidOperationException("snapshot_database_header_invalid"); read += n; }
    return result;
  }
  static void ReadExact(Stream stream, byte[] data, int offset, int count) { while (count > 0) { int read = stream.Read(data, offset, count); if (read == 0) throw new InvalidOperationException("snapshot_wal_invalid"); offset += read; count -= read; } }
  static bool Same(Observation a, Observation b) { return a != null && b != null && a.Present == b.Present && (!a.Present ||
    (a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow && a.Length == b.Length && a.WriteTime == b.WriteTime && Equal(a.Hash, b.Hash))); }
  static bool SameMetadata(ByHandleFileInformation a, ByHandleFileInformation b) { return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow && Size(a) == Size(b) && Time(a.Write) == Time(b.Write); }
  static ByHandleFileInformation Info(FileStream stream) { ByHandleFileInformation i; if (!GetFileInformationByHandle(stream.SafeFileHandle.DangerousGetHandle(), out i)) throw new IOException("snapshot_stat_failed"); return i; }
  static ByHandleFileInformation InfoPath(string path) { using (FileStream s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) return Info(s); }
  static SafeFileHandle OpenDirectoryHandle(string path) { return CreateFileW(path, 0x80 | 0x10000 | 0x20000 | 0x40000, 0x1 | 0x2, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero); }
  static string PrivateDirectorySddl(string sid) { return "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)"; }
  internal static void CreatePrivateDirectory(string path) {
    AssertPlainPath(Path.GetDirectoryName(path), false);
    string sid = WindowsIdentity.GetCurrent().User.Value; IntPtr descriptor = IntPtr.Zero; uint size;
    try {
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(PrivateDirectorySddl(sid), 1, out descriptor, out size) || descriptor == IntPtr.Zero)
        throw new IOException("snapshot_directory_acl_convert_failed");
      SecurityAttributes attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), SecurityDescriptor = descriptor, InheritHandle = false };
      if (!CreateDirectoryW(path, ref attributes)) {
        int error = Marshal.GetLastWin32Error();
        if (error == 183) throw new InvalidOperationException("snapshot_destination_exists");
        throw new IOException("snapshot_directory_create_failed");
      }
    } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
  }
  static void VerifySecureDirectory(SafeFileHandle handle) {
    IntPtr actualDescriptor = IntPtr.Zero, actualDacl = IntPtr.Zero;
    try {
      if (GetSecurityInfo(handle, 1, 0x4, IntPtr.Zero, IntPtr.Zero, out actualDacl, IntPtr.Zero, out actualDescriptor) != 0 || actualDescriptor == IntPtr.Zero)
        throw new IOException("snapshot_directory_acl_verify_failed");
      ushort control; uint revision;
      if (!GetSecurityDescriptorControl(actualDescriptor, out control, out revision) || (control & 0x1000) == 0)
        throw new IOException("snapshot_directory_acl_verify_failed");
      bool present, defaulted; IntPtr dacl; AclSizeInformation aclInfo;
      if (!GetSecurityDescriptorDacl(actualDescriptor, out present, out dacl, out defaulted) || !present || dacl == IntPtr.Zero ||
          !GetAclInformation(dacl, out aclInfo, (uint)Marshal.SizeOf(typeof(AclSizeInformation)), 2) || aclInfo.AceCount != 2)
        throw new IOException("snapshot_directory_acl_verify_failed");
      string userSid = WindowsIdentity.GetCurrent().User.Value; bool sawUser = false, sawSystem = false;
      for (uint i = 0; i < aclInfo.AceCount; i++) {
        IntPtr ace, sidText = IntPtr.Zero;
        if (!GetAce(dacl, i, out ace) || Marshal.ReadByte(ace) != 0 || Marshal.ReadByte(ace, 1) != 3 || Marshal.ReadInt32(ace, 4) != unchecked((int)0x001F01FF) ||
            !ConvertSidToStringSidW(IntPtr.Add(ace, 8), out sidText)) throw new IOException("snapshot_directory_acl_verify_failed");
        try {
          string value = Marshal.PtrToStringUni(sidText);
          if (String.Equals(value, userSid, StringComparison.OrdinalIgnoreCase)) sawUser = true;
          else if (String.Equals(value, "S-1-5-18", StringComparison.OrdinalIgnoreCase)) sawSystem = true;
          else throw new IOException("snapshot_directory_acl_verify_failed");
        } finally { if (sidText != IntPtr.Zero) LocalFree(sidText); }
      }
      if (!sawUser || !sawSystem) throw new IOException("snapshot_directory_acl_verify_failed");
    } finally {
      if (actualDescriptor != IntPtr.Zero) LocalFree(actualDescriptor);
    }
  }
  static long Size(ByHandleFileInformation i) { return ((long)i.SizeHigh << 32) | i.SizeLow; }
  static long Time(FileTime t) { return ((long)t.High << 32) | t.Low; }
  static void AssertPlainPath(string path, bool optionalLeaf) {
    string full = Path.GetFullPath(path), root = Path.GetPathRoot(full), current = root;
    string[] parts = full.Substring(root.Length).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    for (int i = 0; i < parts.Length; i++) {
      if (parts[i].Length == 0) continue; current = Path.Combine(current, parts[i]);
      FileAttributes a;
      try { a = File.GetAttributes(current); }
      catch (FileNotFoundException) { if (optionalLeaf && i == parts.Length - 1) return; throw new InvalidOperationException("snapshot_path_missing"); }
      catch (DirectoryNotFoundException) { if (optionalLeaf && i == parts.Length - 1) return; throw new InvalidOperationException("snapshot_path_missing"); }
      if ((a & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("snapshot_reparse_rejected");
    }
  }
  static void ValidateInputs(string db, string dir, byte[] key, Limits limits, DateTime deadline) {
    if (String.IsNullOrWhiteSpace(db) || String.IsNullOrWhiteSpace(dir) || key == null || key.Length != 32 || limits == null ||
        limits.MaxDatabaseBytes < 1 || limits.MaxWalBytes < 1 || limits.MaxSnapshotBytes < 1 || limits.ReadChunkBytes < 4096 || limits.ReadChunkBytes > 1024*1024 ||
        limits.MaxDatabaseBytes > limits.MaxSnapshotBytes || deadline <= DateTime.UtcNow) throw new InvalidOperationException("snapshot_request_invalid");
  }
  static void Check(DateTime deadline, CancellationToken cancellation) { if (cancellation.IsCancellationRequested) throw new OperationCanceledException("snapshot_cancelled"); if (DateTime.UtcNow >= deadline) throw new TimeoutException("snapshot_deadline"); }
  static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
  static bool Equal(byte[] a, byte[] b) { if (a == null || b == null || a.Length != b.Length) return false; int d=0; for (int i=0;i<a.Length;i++) d|=a[i]^b[i]; return d==0; }
  static void Clear(byte[] b) { if (b != null) Array.Clear(b, 0, b.Length); }
}
