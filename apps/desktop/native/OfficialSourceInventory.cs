using System.Collections;
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal sealed class OfficialSourceFileIdentity {
  internal string Path;
  internal long Length;
  internal long LastWriteTicks;
  internal string FileId;
  internal bool IsRegular;
  internal bool IsReparsePoint;
}

internal sealed class OfficialSourceInventoryResult {
  internal string DatabasePath;
  internal string ExecutablePath;
  internal int ProcessId;
  internal long ProcessCreationTime;
  internal OfficialSourceFileIdentity DatabaseIdentity;
  internal OfficialSourceFileIdentity WalIdentity;
  internal OfficialSourceFileIdentity ShmIdentity;
  internal OfficialSourceFileIdentity ExecutableIdentity;
  internal string BuildVersion;
  internal int BuildBytes;
  internal string BuildVerdict;
  internal string BuildSha256;
  internal int ProcessCount;
  internal int CandidateCount;
  internal int[] EdbMiB;
  internal int[] WalMiB;
}

internal interface IOfficialSourceInventoryEnvironment {
  string[] EnumerateDatabaseFiles(string directory);
  OfficialSourceFileIdentity InspectFile(string path, bool allowMissing);
  bool IsReparsePoint(string path);
  string HashFile(string path);
  int[] GetCandidateProcessIds();
  long GetMatchingLineProcessCreationTime(int processId, string executablePath);
}

internal enum OfficialBuildVerdict { Accepted, Candidate, Rotation, Untrusted }

internal sealed class OfficialBuildIdentity {
  internal string Version;
  internal long Bytes;
  internal string Sha256;
}

// Optional capability of an inventory environment. Environments that do not
// provide it can only ever accept an exact, already-trusted build identity.
internal interface IOfficialExecutableInspector {
  // The executable's file version ("a.b.c.d"), or null when unreadable.
  string ReadFileVersion(string path);
}

[Serializable]
internal sealed class OfficialBuildDecision {
  internal OfficialBuildVerdict Verdict;
  internal string Reason;
  internal string Version;
  internal long Bytes;
  internal string Sha256;
  internal string Thumbprint;
}

// Raised when the executable is neither an accepted build nor a statically
// trustworthy candidate. It is an ordinary InvalidDataException whose message
// is the finite wire code; the observed decision rides in Exception.Data.
internal static class OfficialBuildRejection {
  const string DataKey = "officialBuildDecision";
  internal static InvalidDataException Create(OfficialBuildDecision decision) {
    InvalidDataException error = new InvalidDataException(
      decision.Verdict == OfficialBuildVerdict.Rotation ? "build_rotation" : "unsupported_build");
    error.Data[DataKey] = decision;
    return error;
  }
  internal static OfficialBuildDecision DecisionOf(Exception error) {
    return error == null || !error.Data.Contains(DataKey) ? null : error.Data[DataKey] as OfficialBuildDecision;
  }
}

internal sealed class OfficialBuildTrust {
  internal const long MaxClientBytes = 128L * 1024 * 1024;
  internal const int MaxAccepted = 64;
  internal const int MaxPinned = 8;
  internal const string SeedThumbprint = "3E85990B906DD895BB28206319546E2EEBA81336";
  internal readonly List<OfficialBuildIdentity> Accepted = new List<OfficialBuildIdentity>();
  internal readonly List<string> Pinned = new List<string>();
  internal bool AllowCandidates = true;

  // Code seeds are always present and cannot be removed by persisted state.
  internal static OfficialBuildTrust Seeds() {
    OfficialBuildTrust trust = new OfficialBuildTrust();
    trust.Accepted.Add(new OfficialBuildIdentity { Version = OfficialSourceInventory.SupportedBuildVersion,
      Bytes = OfficialSourceInventory.SupportedBuildBytes, Sha256 = OfficialSourceInventory.SupportedBuildSha256 });
    trust.Pinned.Add(SeedThumbprint);
    return trust;
  }

  // One exact identity and no candidate path: the legacy fixed-build gate.
  internal static OfficialBuildTrust Exact(string version, long bytes, string sha256) {
    OfficialBuildTrust trust = new OfficialBuildTrust { AllowCandidates = false };
    trust.Accepted.Add(new OfficialBuildIdentity { Version = version, Bytes = bytes, Sha256 = sha256 });
    return trust;
  }

  internal static bool IsValidVersion(string value) {
    return value != null && System.Text.RegularExpressions.Regex.IsMatch(value, @"^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$");
  }
  static bool IsLowerSha(string value) {
    return value != null && System.Text.RegularExpressions.Regex.IsMatch(value, "^[0-9a-f]{64}$");
  }
  static bool IsThumbprint(string value) {
    return value != null && System.Text.RegularExpressions.Regex.IsMatch(value, "^[0-9A-F]{40}$");
  }

  // Parses the optional init.trust object: { accepted: [{version, bytes,
  // sha256}] (<=64), pinned: [thumbprint] (<=8) } merged over the seeds.
  internal static OfficialBuildTrust FromInit(object node) {
    OfficialBuildTrust trust = Seeds();
    if (node == null) return trust;
    Dictionary<string, object> root = node as Dictionary<string, object>;
    if (root == null || root.Count != 2 || !root.ContainsKey("accepted") || !root.ContainsKey("pinned"))
      throw new InvalidDataException("protocol_invalid");
    IEnumerable accepted = root["accepted"] as IEnumerable, pinned = root["pinned"] as IEnumerable;
    if (accepted == null || pinned == null || root["accepted"] is string || root["pinned"] is string)
      throw new InvalidDataException("protocol_invalid");
    int acceptedCount = 0;
    foreach (object item in accepted) {
      if (++acceptedCount > MaxAccepted) throw new InvalidDataException("protocol_invalid");
      Dictionary<string, object> entry = item as Dictionary<string, object>;
      if (entry == null || entry.Count != 3 || !entry.ContainsKey("version") || !entry.ContainsKey("bytes") || !entry.ContainsKey("sha256"))
        throw new InvalidDataException("protocol_invalid");
      string version = entry["version"] as string, sha = entry["sha256"] as string;
      if (!(entry["bytes"] is int) && !(entry["bytes"] is long)) throw new InvalidDataException("protocol_invalid");
      long bytes = Convert.ToInt64(entry["bytes"]);
      if (!IsValidVersion(version) || !IsLowerSha(sha) || bytes < 1 || bytes > MaxClientBytes) throw new InvalidDataException("protocol_invalid");
      bool known = false;
      foreach (OfficialBuildIdentity existing in trust.Accepted)
        if (existing.Bytes == bytes && String.Equals(existing.Sha256, sha, StringComparison.Ordinal)) known = true;
      if (!known) trust.Accepted.Add(new OfficialBuildIdentity { Version = version, Bytes = bytes, Sha256 = sha });
    }
    int pinnedCount = 0;
    foreach (object item in pinned) {
      if (++pinnedCount > MaxPinned) throw new InvalidDataException("protocol_invalid");
      string thumbprint = item as string;
      if (!IsThumbprint(thumbprint)) throw new InvalidDataException("protocol_invalid");
      if (!trust.Pinned.Contains(thumbprint)) trust.Pinned.Add(thumbprint);
    }
    return trust;
  }

}

// Static build policy, version only: an exact accepted identity passes;
// otherwise any build whose executable carries a well-formed file version
// passes. There is no signature, signer, timestamp or downgrade check. The
// size limit, path and reparse checks run before this decision.
internal static class OfficialBuildPolicy {
  static OfficialBuildDecision Decide(OfficialBuildVerdict verdict, string reason, string version, long bytes, string sha, string thumbprint) {
    return new OfficialBuildDecision { Verdict = verdict, Reason = reason, Version = version, Bytes = bytes, Sha256 = sha, Thumbprint = thumbprint };
  }

  internal static OfficialBuildDecision Evaluate(string executable, long length, IOfficialSourceInventoryEnvironment environment,
      OfficialBuildTrust trust) {
    if (length < 1 || length > OfficialBuildTrust.MaxClientBytes) return Decide(OfficialBuildVerdict.Untrusted, "too_large", null, length, null, null);
    string sha = environment.HashFile(executable);
    if (sha == null || sha.Length != 64) return Decide(OfficialBuildVerdict.Untrusted, "hash_failed", null, length, null, null);
    sha = sha.ToLowerInvariant();
    foreach (OfficialBuildIdentity accepted in trust.Accepted) {
      if (accepted.Bytes == length && String.Equals(accepted.Sha256, sha, StringComparison.OrdinalIgnoreCase))
        return Decide(OfficialBuildVerdict.Accepted, "accepted", accepted.Version, length, sha, null);
    }
    if (!trust.AllowCandidates) return Decide(OfficialBuildVerdict.Untrusted, "not_accepted", null, length, sha, null);
    IOfficialExecutableInspector inspector = environment as IOfficialExecutableInspector;
    if (inspector == null) return Decide(OfficialBuildVerdict.Untrusted, "no_inspector", null, length, sha, null);
    string fileVersion;
    try { fileVersion = inspector.ReadFileVersion(executable); }
    catch (Exception error) {
      if (error is OperationCanceledException) throw;
      fileVersion = null;
    }
    Version parsed;
    if (!OfficialBuildTrust.IsValidVersion(fileVersion) || !System.Version.TryParse(fileVersion, out parsed))
      return Decide(OfficialBuildVerdict.Untrusted, "bad_version", null, length, sha, null);
    return Decide(OfficialBuildVerdict.Accepted, "version_only", fileVersion, length, sha, null);
  }
}

internal static class OfficialSourceInventory {
  internal const string SupportedBuildVersion = "26.4.2.3957";
  internal const int SupportedBuildBytes = 30634432;
  internal const string SupportedBuildSha256 = "893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1";
  const long MaxEdbBytes = 5L * 1024 * 1024 * 1024;
  const long MaxWalBytes = 512L * 1024 * 1024;
  const int MaxEdbCandidates = 8;
  const int MaxLineProcesses = 16;

  // Legacy fixed-build gate: exactly one accepted identity, never a candidate.
  internal static OfficialSourceInventoryResult Inspect(string root, string buildVersion, int buildBytes, string buildSha256,
      IOfficialSourceInventoryEnvironment environment, bool requireWalShm = false) {
    if (environment == null || buildVersion == null || buildBytes <= 0 || !IsSha256(buildSha256)) throw new InvalidDataException();
    return Inspect(root, OfficialBuildTrust.Exact(buildVersion, buildBytes, buildSha256), environment, requireWalShm);
  }

  internal static OfficialSourceInventoryResult Inspect(string root, OfficialBuildTrust trust,
      IOfficialSourceInventoryEnvironment environment, bool requireWalShm = false) {
    if (environment == null || trust == null) throw new InvalidDataException();
    string fullRoot = Path.GetFullPath(root);
    string executable = Path.Combine(fullRoot, "bin", "current", "LINE.exe");
    string databaseDirectory = Path.Combine(fullRoot, "Data", "db");
    RequireNoReparseAncestors(fullRoot, environment, true);
    RequireNoReparseAncestors(executable, environment, false);
    RequireNoReparseAncestors(databaseDirectory, environment, true);

    OfficialSourceFileIdentity executableIdentity = RequireRegular(environment.InspectFile(executable, false));
    // Executable identity gate: an exact accepted build or any well-formed file
    // version passes; an unreadable or malformed version stops here, before any
    // process memory is touched.
    OfficialBuildDecision build = OfficialBuildPolicy.Evaluate(executable, executableIdentity.Length, environment, trust);
    if (build.Verdict != OfficialBuildVerdict.Accepted)
      throw OfficialBuildRejection.Create(build);
    string buildVersion = build.Version;
    int buildBytes = (int)build.Bytes;
    string buildSha256 = build.Sha256;

    List<string> candidates = new List<string>();
    foreach (string path in environment.EnumerateDatabaseFiles(databaseDirectory)) {
      string filename = Path.GetFileName(path);
      string lower = filename.ToLowerInvariant();
      if (!String.Equals(Path.GetExtension(filename), ".edb", StringComparison.OrdinalIgnoreCase) ||
          lower.StartsWith("album", StringComparison.Ordinal) || lower.StartsWith("chatstats", StringComparison.Ordinal) ||
          lower.StartsWith("keep", StringComparison.Ordinal)) continue;
      candidates.Add(Path.GetFullPath(path));
      if (candidates.Count > MaxEdbCandidates) throw new InvalidDataException("candidate_limit");
    }
    if (candidates.Count == 0) throw new InvalidDataException("candidate_missing");
    int candidateCount = candidates.Count;
    // The active database is the candidate with the newest last-write time (.edb or its -wal). The other
    // candidates get stat only: they are never decrypted, opened or read.
    string database = candidateCount > 1 ? SelectActiveCandidate(candidates, environment) : candidates[0];
    OfficialSourceFileIdentity databaseIdentity, walIdentity, shmIdentity;
    InspectDatabaseFiles(database, environment, requireWalShm, true, out databaseIdentity, out walIdentity, out shmIdentity);
    string wal = database + "-wal";
    string shm = database + "-shm";

    int[] processIds = environment.GetCandidateProcessIds();
    if (processIds == null || processIds.Length == 0) throw new InvalidDataException("process_missing");
    if (processIds.Length > MaxLineProcesses) throw new InvalidDataException("process_limit");
    int matchingProcesses = 0;
    int matchingProcessId = 0;
    long matchingProcessCreation = 0;
    foreach (int processId in processIds) {
      if (processId <= 0) continue;
      long creation = environment.GetMatchingLineProcessCreationTime(processId, executable);
      if (creation <= 0) continue;
      matchingProcesses++;
      matchingProcessId = processId;
      matchingProcessCreation = creation;
    }
    if (matchingProcesses == 0) throw new InvalidDataException("process_missing");
    if (matchingProcesses != 1) throw new InvalidDataException("process_ambiguous");

    RequireNoReparseAncestors(fullRoot, environment, true);
    RequireNoReparseAncestors(executable, environment, false);
    RequireNoReparseAncestors(databaseDirectory, environment, true);
    OfficialSourceFileIdentity finalWalIdentity = environment.InspectFile(wal, true);
    if (finalWalIdentity != null) {
      RequireRegular(finalWalIdentity);
      if (finalWalIdentity.Length > MaxWalBytes) throw new InvalidDataException("source_too_large");
    }
    OfficialSourceFileIdentity finalShmIdentity = environment.InspectFile(shm, true);
    if (finalShmIdentity != null) RequireRegular(finalShmIdentity);
    if (requireWalShm && finalWalIdentity != null && finalShmIdentity == null) throw new InvalidDataException("source_shm_missing");

    OfficialSourceInventoryResult inspected = new OfficialSourceInventoryResult {
      DatabasePath = database, ExecutablePath = executable, ProcessId = matchingProcessId,
      ProcessCreationTime = matchingProcessCreation, DatabaseIdentity = databaseIdentity, WalIdentity = finalWalIdentity,
      ShmIdentity = finalShmIdentity,
      ExecutableIdentity = executableIdentity,
      BuildVersion = buildVersion, BuildBytes = buildBytes, BuildSha256 = buildSha256,
      BuildVerdict = "accepted",
      ProcessCount = matchingProcesses, CandidateCount = candidateCount, EdbMiB = new int[] { ToMiB(databaseIdentity.Length) },
      WalMiB = new int[] { ToMiB(finalWalIdentity == null ? 0 : finalWalIdentity.Length) }
    };
    RequireSameSource(inspected, environment);
    return inspected;
  }

  // Stat-only inspection of one candidate database and its sidecars. Strict mode (the database that will be
  // opened) also enforces size limits and the WAL/SHM rule; the stand-in for an undecided candidate does not.
  static void InspectDatabaseFiles(string database, IOfficialSourceInventoryEnvironment environment, bool requireWalShm, bool strict,
      out OfficialSourceFileIdentity databaseIdentity, out OfficialSourceFileIdentity walIdentity, out OfficialSourceFileIdentity shmIdentity) {
    RequireNoReparseAncestors(database, environment, false);
    databaseIdentity = RequireRegular(environment.InspectFile(database, false));
    if (strict && (databaseIdentity.Length <= 0 || databaseIdentity.Length > MaxEdbBytes)) throw new InvalidDataException("source_too_large");
    string wal = database + "-wal";
    RequireNoReparseAncestors(wal, environment, false);
    walIdentity = environment.InspectFile(wal, true);
    if (walIdentity != null) {
      RequireRegular(walIdentity);
      if (strict && walIdentity.Length > MaxWalBytes) throw new InvalidDataException("source_too_large");
    }
    // SQLite may create a missing shared-memory sidecar when opening a WAL
    // database. Direct monitoring must never cause a write under LINE's data
    // directory, so reject that source before SQLite is opened.
    string shm = database + "-shm";
    RequireNoReparseAncestors(shm, environment, false);
    shmIdentity = environment.InspectFile(shm, true);
    if (shmIdentity != null) RequireRegular(shmIdentity);
    if (requireWalShm && walIdentity != null && shmIdentity == null) throw new InvalidDataException("source_shm_missing");
  }

  // The active database is the candidate with the newest last-write time, where a candidate's time is the later of
  // its .edb and its -wal. An exact tie is ambiguous. Stat only: no candidate is opened here.
  static string SelectActiveCandidate(List<string> candidates, IOfficialSourceInventoryEnvironment environment) {
    string best = null;
    long bestTime = long.MinValue;
    bool tied = false;
    foreach (string candidate in candidates) {
      RequireNoReparseAncestors(candidate, environment, false);
      OfficialSourceFileIdentity db = RequireRegular(environment.InspectFile(candidate, false));
      RequireNoReparseAncestors(candidate + "-wal", environment, false);
      OfficialSourceFileIdentity wal = environment.InspectFile(candidate + "-wal", true);
      if (wal != null) RequireRegular(wal);
      long time = Math.Max(db.LastWriteTicks, wal == null ? long.MinValue : wal.LastWriteTicks);
      if (best == null || time > bestTime) { best = candidate; bestTime = time; tied = false; }
      else if (time == bestTime) tied = true;
    }
    if (tied) throw new InvalidDataException("candidate_ambiguous");
    return best;
  }

  // The ONLY definition of "same official source". LINE keeps writing the live database and WAL, so those are
  // identified by FileId alone (never Length/LastWriteTicks); the executable and the LINE process are pinned fully.
  internal static void RequireSameSource(OfficialSourceInventoryResult pinned, IOfficialSourceInventoryEnvironment environment,
      bool verifyProcess = true) {
    if (pinned == null || environment == null) throw new InvalidDataException("source_changed");
    RequireNoReparseAncestors(pinned.DatabasePath, environment, false);
    RequireNoReparseAncestors(pinned.ExecutablePath, environment, false);
    RequireNoReparseAncestors(pinned.DatabasePath + "-wal", environment, false);
    OfficialSourceFileIdentity database = RequireRegular(environment.InspectFile(pinned.DatabasePath, false));
    if (!String.Equals(pinned.DatabaseIdentity.FileId, database.FileId, StringComparison.Ordinal))
      throw new InvalidDataException("source_changed");
    OfficialSourceFileIdentity executable = RequireRegular(environment.InspectFile(pinned.ExecutablePath, false));
    if (!SameIdentity(pinned.ExecutableIdentity, executable) ||
        !String.Equals(environment.HashFile(pinned.ExecutablePath), pinned.BuildSha256, StringComparison.OrdinalIgnoreCase) ||
        (verifyProcess && environment.GetMatchingLineProcessCreationTime(pinned.ProcessId, pinned.ExecutablePath) != pinned.ProcessCreationTime))
      throw new InvalidDataException("source_changed");
    OfficialSourceFileIdentity wal = environment.InspectFile(pinned.DatabasePath + "-wal", true);
    if (wal != null) RequireRegular(wal);
    OfficialSourceFileIdentity shm = environment.InspectFile(pinned.DatabasePath + "-shm", true);
    if (shm != null) RequireRegular(shm);
  }

  internal static OfficialSourceInventoryResult RefreshPinnedSource(OfficialSourceInventoryResult pinned,
      IOfficialSourceInventoryEnvironment environment, bool requireWalShm) {
    if (pinned == null || environment == null) throw new InvalidDataException("source_changed");
    RequireSameSource(pinned, environment, false);
    OfficialSourceFileIdentity database = RequireRegular(environment.InspectFile(pinned.DatabasePath, false));
    if (database.Length <= 0 || database.Length > MaxEdbBytes) throw new InvalidDataException("source_too_large");
    OfficialSourceFileIdentity executable = RequireRegular(environment.InspectFile(pinned.ExecutablePath, false));
    string walPath = pinned.DatabasePath + "-wal";
    string shmPath = pinned.DatabasePath + "-shm";
    RequireNoReparseAncestors(walPath, environment, false);
    RequireNoReparseAncestors(shmPath, environment, false);
    OfficialSourceFileIdentity wal = environment.InspectFile(walPath, true);
    if (wal != null) {
      RequireRegular(wal);
      if (wal.Length > MaxWalBytes) throw new InvalidDataException("source_too_large");
    }
    OfficialSourceFileIdentity shm = environment.InspectFile(shmPath, true);
    if (shm != null) RequireRegular(shm);
    if (requireWalShm && wal != null && shm == null) throw new InvalidDataException("source_shm_missing");
    return new OfficialSourceInventoryResult {
      DatabasePath = pinned.DatabasePath, ExecutablePath = pinned.ExecutablePath,
      ProcessId = pinned.ProcessId, ProcessCreationTime = pinned.ProcessCreationTime,
      DatabaseIdentity = database, WalIdentity = wal, ShmIdentity = shm, ExecutableIdentity = executable,
      BuildVersion = pinned.BuildVersion, BuildBytes = pinned.BuildBytes, BuildSha256 = pinned.BuildSha256, BuildVerdict = pinned.BuildVerdict,
      ProcessCount = pinned.ProcessCount, CandidateCount = pinned.CandidateCount, EdbMiB = new int[] { ToMiB(database.Length) },
      WalMiB = new int[] { ToMiB(wal == null ? 0 : wal.Length) }
    };
  }

  static OfficialSourceFileIdentity RequireRegular(OfficialSourceFileIdentity file) {
    if (file == null || !file.IsRegular || file.IsReparsePoint || file.Length < 0 || String.IsNullOrEmpty(file.FileId)) {
      throw new InvalidDataException("source_reparse_or_type");
    }
    return file;
  }

  static void RequireNoReparseAncestors(string path, IOfficialSourceInventoryEnvironment environment, bool includeLeaf) {
    string full = Path.GetFullPath(path);
    string root = Path.GetPathRoot(full);
    string current = root;
    string[] parts = full.Substring(root.Length).Split(new char[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
    int count = includeLeaf ? parts.Length : Math.Max(0, parts.Length - 1);
    for (int i = 0; i < count; i++) {
      current = Path.Combine(current, parts[i]);
      if (environment.IsReparsePoint(current)) throw new InvalidDataException("source_reparse_or_type");
    }
  }

  static bool SameIdentity(OfficialSourceFileIdentity left, OfficialSourceFileIdentity right) {
    return right != null && left.IsRegular == right.IsRegular && left.IsReparsePoint == right.IsReparsePoint &&
      left.Length == right.Length && left.LastWriteTicks == right.LastWriteTicks &&
      String.Equals(left.FileId, right.FileId, StringComparison.Ordinal);
  }

  static int ToMiB(long bytes) { return (int)((bytes + 1024 * 1024 - 1) / (1024 * 1024)); }
  static bool IsSha256(string value) {
    if (value == null || value.Length != 64) return false;
    for (int i = 0; i < value.Length; i++) if (!Uri.IsHexDigit(value[i])) return false;
    return true;
  }
}

internal sealed class WindowsOfficialSourceInventoryEnvironment : IOfficialSourceInventoryEnvironment, IOfficialExecutableInspector {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry32 {
    internal uint Size;
    internal uint Usage;
    internal uint ProcessId;
    internal IntPtr DefaultHeapId;
    internal uint ModuleId;
    internal uint Threads;
    internal uint ParentProcessId;
    internal int BasePriority;
    internal uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] internal string ExecutableName;
  }

  [StructLayout(LayoutKind.Sequential)] struct ByHandleFileInformation {
    internal uint FileAttributes;
    internal uint CreationTimeLow; internal uint CreationTimeHigh;
    internal uint LastAccessTimeLow; internal uint LastAccessTimeHigh;
    internal uint LastWriteTimeLow; internal uint LastWriteTimeHigh;
    internal uint VolumeSerialNumber;
    internal uint FileSizeHigh; internal uint FileSizeLow;
    internal uint NumberOfLinks;
    internal uint FileIndexHigh; internal uint FileIndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle, out ByHandleFileInformation information);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFileAttributesW(string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", EntryPoint="Process32FirstW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 entry);
  [DllImport("kernel32.dll", EntryPoint="Process32NextW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 entry);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder imageName, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  const uint GenericRead = 0x80000000, FileReadAttributes = 0x80, FileShareRead = 1, FileShareWrite = 2, FileShareDelete = 4;
  const uint OpenExisting = 3, OpenReparsePoint = 0x00200000, FileAttributeDirectory = 0x10, FileAttributeReparsePoint = 0x400;
  const uint SnapshotProcess = 2, ProcessQueryLimitedInformation = 0x1000;
  const int ErrorNoMoreFiles = 18;
  const int MaxDatabaseCandidates = 8, MaxMatchingProcesses = 16;

  public string[] EnumerateDatabaseFiles(string directory) {
    List<string> files = new List<string>();
    foreach (string path in Directory.EnumerateFiles(directory, "*.edb", SearchOption.TopDirectoryOnly)) {
      string name = Path.GetFileName(path).ToLowerInvariant();
      if (name.StartsWith("album", StringComparison.Ordinal) || name.StartsWith("chatstats", StringComparison.Ordinal) ||
          name.StartsWith("keep", StringComparison.Ordinal)) continue;
      files.Add(path);
      if (files.Count > MaxDatabaseCandidates) throw new InvalidDataException("candidate_limit");
    }
    return files.ToArray();
  }
  public bool IsReparsePoint(string path) {
    uint attributes = GetFileAttributesW(path);
    if (attributes == UInt32.MaxValue) throw new IOException("source_io_error");
    return (attributes & FileAttributeReparsePoint) != 0;
  }
  public OfficialSourceFileIdentity InspectFile(string path, bool allowMissing) {
    IntPtr handle = CreateFileW(path, FileReadAttributes, FileShareRead | FileShareWrite | FileShareDelete, IntPtr.Zero,
      OpenExisting, OpenReparsePoint, IntPtr.Zero);
    if (handle == new IntPtr(-1)) {
      int error = Marshal.GetLastWin32Error();
      if (allowMissing && error == 2) return null;
      throw new IOException("source_io_error");
    }
    try {
      ByHandleFileInformation info;
      if (!GetFileInformationByHandle(handle, out info)) throw new IOException("source_io_error");
      long length = ((long)info.FileSizeHigh << 32) | info.FileSizeLow;
      long lastWrite = ((long)info.LastWriteTimeHigh << 32) | info.LastWriteTimeLow;
      bool reparse = (info.FileAttributes & FileAttributeReparsePoint) != 0;
      bool regular = (info.FileAttributes & FileAttributeDirectory) == 0 && !reparse;
      string fileId = info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8");
      return new OfficialSourceFileIdentity { Path = Path.GetFullPath(path), Length = length, LastWriteTicks = lastWrite,
        FileId = fileId, IsRegular = regular, IsReparsePoint = reparse };
    } finally { CloseHandle(handle); }
  }
  public string HashFile(string path) {
    IntPtr handle = CreateFileW(path, GenericRead | FileReadAttributes, FileShareRead | FileShareWrite | FileShareDelete, IntPtr.Zero,
      OpenExisting, OpenReparsePoint, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new IOException("source_io_error");
    SafeFileHandle safe = new SafeFileHandle(handle, true);
    try {
      ByHandleFileInformation info;
      if (!GetFileInformationByHandle(handle, out info) || (info.FileAttributes & (FileAttributeDirectory | FileAttributeReparsePoint)) != 0) {
        throw new InvalidDataException("source_reparse_or_type");
      }
      long length = ((long)info.FileSizeHigh << 32) | info.FileSizeLow;
      if (length > OfficialBuildTrust.MaxClientBytes) throw new InvalidDataException("unsupported_build");
      using (FileStream stream = new FileStream(safe, FileAccess.Read))
      using (SHA256 hash = SHA256.Create()) {
        byte[] digest = hash.ComputeHash(stream);
        try { StringBuilder text = new StringBuilder(); foreach (byte value in digest) text.Append(value.ToString("x2")); return text.ToString(); }
        finally { Array.Clear(digest, 0, digest.Length); }
      }
    } catch { safe.Dispose(); throw; }
  }
  // The file version from the executable's version resource, or null when it
  // has none or cannot be read. The caller validates the format. The content
  // hashed by HashFile stays bound to this build by RequireSameSource.
  public string ReadFileVersion(string path) {
    try {
      System.Diagnostics.FileVersionInfo version = System.Diagnostics.FileVersionInfo.GetVersionInfo(Path.GetFullPath(path));
      if (version.FileMajorPart + version.FileMinorPart + version.FileBuildPart + version.FilePrivatePart == 0) return null;
      return version.FileMajorPart + "." + version.FileMinorPart + "." + version.FileBuildPart + "." + version.FilePrivatePart;
    } catch (IOException) { return null; }
    catch (UnauthorizedAccessException) { return null; }
  }
  public int[] GetCandidateProcessIds() {
    IntPtr snapshot = CreateToolhelp32Snapshot(SnapshotProcess, 0);
    if (snapshot == new IntPtr(-1)) throw new IOException("source_process_unavailable");
    try {
      List<int> processIds = new List<int>();
      ProcessEntry32 entry = new ProcessEntry32();
      entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
      bool next = Process32First(snapshot, ref entry);
      if (!next && Marshal.GetLastWin32Error() != ErrorNoMoreFiles) throw new IOException("source_process_unavailable");
      while (next) {
        if (String.Equals(entry.ExecutableName, "LINE.exe", StringComparison.OrdinalIgnoreCase)) {
          processIds.Add(unchecked((int)entry.ProcessId));
          if (processIds.Count > MaxMatchingProcesses) break;
        }
        next = Process32Next(snapshot, ref entry);
        if (!next && Marshal.GetLastWin32Error() != ErrorNoMoreFiles) throw new IOException("source_process_unavailable");
      }
      return processIds.ToArray();
    } finally { CloseHandle(snapshot); }
  }

  public long GetMatchingLineProcessCreationTime(int processId, string executablePath) {
    IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
    if (process == IntPtr.Zero) throw new IOException("source_process_unavailable");
    try {
      StringBuilder imagePath = new StringBuilder(32768);
      int imagePathLength = imagePath.Capacity;
      if (!QueryFullProcessImageNameW(process, 0, imagePath, ref imagePathLength)) throw new IOException("source_process_unavailable");
      string actualPath = Path.GetFullPath(imagePath.ToString());
      if (!String.Equals(actualPath, Path.GetFullPath(executablePath), StringComparison.OrdinalIgnoreCase)) return 0;
      long creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user) || creation <= 0) throw new IOException("source_process_unavailable");
      return creation;
    } finally { CloseHandle(process); }
  }
}

