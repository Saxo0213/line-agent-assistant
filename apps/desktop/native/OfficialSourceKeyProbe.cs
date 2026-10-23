using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

// Reads bounded private memory from the unique, pinned LINE process. It never
// sends a candidate to SQLite before encrypted page-1 validation succeeds.
internal static class OfficialSourceKeyProbe {
#if READER_OFFICIAL_SOURCE_TEST
  internal static Action<CancellationToken> TestAfterFirstRead = null;
  internal static Func<long, MemoryRegion?> TestQueryRegion = null;
  internal static Func<long, byte[], int> TestReadMemory = null;
  internal static Action TestVerifyHandle = null;
#endif
  const int MaxCandidates = 10000;
  const long MaxScanBytes = 1024L * 1024 * 1024;
  const int ChunkBytes = 1024 * 1024;
  const int ProcessQueryInformation = 0x400, ProcessVmRead = 0x10;
  const uint MemCommit = 0x1000, MemPrivate = 0x20000, PageGuard = 0x100;
  [StructLayout(LayoutKind.Sequential)] internal struct MemoryRegion {
    internal IntPtr BaseAddress, AllocationBase;
    internal uint AllocationProtect;
    internal UIntPtr RegionSize;
    internal uint State, Protect, Type;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder path, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MemoryRegion region, UIntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr length, out UIntPtr read);

  internal static byte[] Find(OfficialSourceInventoryResult source, IOfficialSourceInventoryEnvironment environment,
      DateTime deadlineUtc, CancellationToken cancellation, Action<long> scanProgress = null) {
    return FindCore(source, environment, deadlineUtc, cancellation, scanProgress, null);
  }

  // The whole scan finished and no candidate decrypted page 1. Still the "key_unavailable" wire code.
  // InvalidDataException is sealed, so the distinction rides in Exception.Data.
  const string KeyNotFoundMarker = "officialKeyNotFound";
  static InvalidDataException KeyNotFound() {
    InvalidDataException error = new InvalidDataException("key_unavailable");
    error.Data[KeyNotFoundMarker] = true;
    return error;
  }

  // One scan, and when it finds no key, exactly one more: page 1 is re-read from disk and the process is scanned
  // again under the same deadline and cancellation. Cancellation, deadline expiry, process mismatch and source
  // changes propagate from the first scan without a second one. No loop, timer or background work.
  internal static byte[] FindWithRescan(OfficialSourceInventoryResult source, IOfficialSourceInventoryEnvironment environment,
      DateTime deadlineUtc, CancellationToken cancellation, Action<long> scanProgress = null) {
    long firstScanBytes = 0;
    Action<long> firstProgress = scanProgress == null ? (Action<long>)null : delegate(long scanned) {
      firstScanBytes = scanned; scanProgress(scanned);
    };
    try { return Find(source, environment, deadlineUtc, cancellation, firstProgress); }
    catch (InvalidDataException error) {
      if (!error.Data.Contains(KeyNotFoundMarker)) throw;
      cancellation.ThrowIfCancellationRequested();
      // Progress stays monotonic across both scans.
      Action<long> secondProgress = scanProgress == null ? (Action<long>)null : delegate(long scanned) { scanProgress(firstScanBytes + scanned); };
      return Find(source, environment, deadlineUtc, cancellation, secondProgress);
    }
  }

  // Thin entry for retained side databases: the same pinned-process scan and candidate rules, validated against the
  // supplied encrypted page 1 instead of the main database's. The pinned main source may keep changing while LINE runs.
  internal static byte[] FindForFirstPage(OfficialSourceInventoryResult source, IOfficialSourceInventoryEnvironment environment,
      byte[] suppliedFirstPage, DateTime deadlineUtc, CancellationToken cancellation) {
    if (suppliedFirstPage == null || suppliedFirstPage.Length != 4096) throw new InvalidDataException("key_unavailable");
    return FindCore(source, environment, deadlineUtc, cancellation, null, suppliedFirstPage);
  }

  static byte[] FindCore(OfficialSourceInventoryResult source, IOfficialSourceInventoryEnvironment environment,
      DateTime deadlineUtc, CancellationToken cancellation, Action<long> scanProgress, byte[] suppliedFirstPage) {
    if (source == null || environment == null) throw new InvalidDataException("key_unavailable");
    cancellation.ThrowIfCancellationRequested();
    OfficialSourceInventory.RequireSameSource(source, environment);
    byte[] firstPage = new byte[4096];
    try {
      if (suppliedFirstPage != null) Buffer.BlockCopy(suppliedFirstPage, 0, firstPage, 0, firstPage.Length);
      else using (FileStream stream = new FileStream(source.DatabasePath, FileMode.Open, FileAccess.Read,
          FileShare.ReadWrite | FileShare.Delete)) {
        int filled = 0;
        while (filled < firstPage.Length) {
          cancellation.ThrowIfCancellationRequested();
          int count = stream.Read(firstPage, filled, firstPage.Length - filled);
          if (count <= 0) throw new InvalidDataException("key_unavailable");
          filled += count;
        }
      }
      bool injected = false;
#if READER_OFFICIAL_SOURCE_TEST
      injected = TestQueryRegion != null && TestReadMemory != null;
#endif
      IntPtr process = injected ? IntPtr.Zero : OpenProcess(ProcessQueryInformation | ProcessVmRead, false, source.ProcessId);
      if (!injected && process == IntPtr.Zero) throw new InvalidDataException("key_unavailable");
      try {
        VerifyCurrentHandle(process, source, injected);
        OfficialSourceInventory.RequireSameSource(source, environment);
        Stopwatch clock = Stopwatch.StartNew();
        long scanned = 0, address = 0;
        int candidates = 0;
#if READER_OFFICIAL_SOURCE_TEST
        bool firstRead = false;
#endif
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        while (address >= 0 && address < 0x00007FFFFFFF0000L && scanned < MaxScanBytes &&
            clock.ElapsedMilliseconds < 90000 && DateTime.UtcNow < deadlineUtc && candidates < MaxCandidates) {
          cancellation.ThrowIfCancellationRequested();
          MemoryRegion region = new MemoryRegion();
          if (injected) {
#if READER_OFFICIAL_SOURCE_TEST
            MemoryRegion? observed = TestQueryRegion(address);
            if (!observed.HasValue) break;
            region = observed.Value;
#endif
          } else if (VirtualQueryEx(process, new IntPtr(address), out region,
              new UIntPtr((uint)Marshal.SizeOf(typeof(MemoryRegion)))).ToUInt64() == 0) break;
          long next = checked(region.BaseAddress.ToInt64() + (long)region.RegionSize.ToUInt64());
          if (next <= address) throw new InvalidDataException("key_unavailable");
          uint protection = region.Protect & 0xff;
          bool readable = region.State == MemCommit && region.Type == MemPrivate &&
            (protection == 2 || protection == 4 || protection == 8 || protection == 0x20 ||
             protection == 0x40 || protection == 0x80) && (region.Protect & PageGuard) == 0;
          ulong size = region.RegionSize.ToUInt64();
          if (readable && size > 0 && size <= 128UL * 1024 * 1024) {
            byte[] carry = new byte[0];
            try {
              for (ulong offset = 0; offset < size && scanned < MaxScanBytes && candidates < MaxCandidates &&
                   clock.ElapsedMilliseconds < 90000 && DateTime.UtcNow < deadlineUtc;) {
                cancellation.ThrowIfCancellationRequested();
                int length = (int)Math.Min(ChunkBytes, Math.Min(size - offset, (ulong)(MaxScanBytes - scanned)));
                byte[] buffer = new byte[length];
                byte[] window = null;
                try {
                  int count;
                  bool ok;
                  if (injected) {
#if READER_OFFICIAL_SOURCE_TEST
                    int observed = TestReadMemory(checked(region.BaseAddress.ToInt64() + (long)offset), buffer);
                    ok = observed >= 0;
                    count = Math.Min(length, Math.Abs(observed));
#else
                    throw new InvalidDataException("key_unavailable");
#endif
                  } else {
                    UIntPtr read;
                    ok = ReadProcessMemory(process, new IntPtr(checked(region.BaseAddress.ToInt64() + (long)offset)),
                      buffer, new UIntPtr((uint)length), out read);
                    count = (int)Math.Min((ulong)length, read.ToUInt64());
                  }
                  if (ok && count > 0) {
                    scanned += count;
                    if (scanProgress != null) scanProgress(scanned);
#if READER_OFFICIAL_SOURCE_TEST
                    if (!firstRead && TestAfterFirstRead != null) { firstRead = true; TestAfterFirstRead(cancellation); }
#endif
                    window = new byte[carry.Length + count];
                    Buffer.BlockCopy(carry, 0, window, 0, carry.Length);
                    Buffer.BlockCopy(buffer, 0, window, carry.Length, count);
                    byte[] found = ScanWindow(window, firstPage, seen, ref candidates,
                      offset == 0, count == length && offset + (ulong)length == size);
                    if (found != null) {
                      try {
                        cancellation.ThrowIfCancellationRequested();
                        VerifyCurrentHandle(process, source, injected);
                        OfficialSourceInventory.RequireSameSource(source, environment);
                        return found;
                      } catch { Array.Clear(found, 0, found.Length); throw; }
                    }
                    Array.Clear(carry, 0, carry.Length);
                    carry = new byte[ok && count == length ? Math.Min(128, window.Length) : 0];
                    if (carry.Length > 0) Buffer.BlockCopy(window, window.Length - carry.Length, carry, 0, carry.Length);
                  } else { Array.Clear(carry, 0, carry.Length); carry = new byte[0]; }
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
        // Only a scan that ran out of memory to read while the deadline still held is a "no key found" outcome
        // worth one rescan; a deadline expiry or a scan cap stays the plain error.
        if (DateTime.UtcNow < deadlineUtc && address >= 0 && scanned < MaxScanBytes && candidates < MaxCandidates &&
            clock.ElapsedMilliseconds < 90000) throw KeyNotFound();
        throw new InvalidDataException("key_unavailable");
      } finally { if (!injected) CloseHandle(process); }
    } finally { Array.Clear(firstPage, 0, firstPage.Length); }
  }

  static void VerifyCurrentHandle(IntPtr process, OfficialSourceInventoryResult source, bool injected) {
    if (injected) {
#if READER_OFFICIAL_SOURCE_TEST
      if (TestVerifyHandle != null) TestVerifyHandle();
#endif
    } else VerifyHandle(process, source);
  }

  static void VerifyHandle(IntPtr process, OfficialSourceInventoryResult source) {
    StringBuilder image = new StringBuilder(32768);
    int size = image.Capacity;
    long creation, exit, kernel, user;
    if (!QueryFullProcessImageNameW(process, 0, image, ref size) ||
        !String.Equals(Path.GetFullPath(image.ToString()), source.ExecutablePath, StringComparison.OrdinalIgnoreCase) ||
        !GetProcessTimes(process, out creation, out exit, out kernel, out user) ||
        creation != source.ProcessCreationTime) throw new InvalidDataException("source_changed");
  }

  internal static byte[] ScanWindow(byte[] window, byte[] firstPage, HashSet<string> seen, ref int candidates,
      bool startIsBoundary, bool complete) {
    foreach (int stride in new int[] { 1, 2 }) {
      for (int i = 0; i + stride * 32 <= window.Length && candidates < MaxCandidates; i++) {
        int end = i + stride * 32;
        if ((!startIsBoundary && i < stride) || (!complete && end >= window.Length)) continue;
        if (stride == 1) {
          if ((i > 0 && IsAlnum(window[i - 1])) || (end < window.Length && IsAlnum(window[end]))) continue;
        } else {
          if ((i >= 2 && window[i - 1] == 0 && IsAlnum(window[i - 2])) ||
              (end + 1 < window.Length && window[end + 1] == 0 && IsAlnum(window[end]))) continue;
        }
        byte[] candidate = new byte[32];
        bool plausible = true;
        for (int n = 0; n < 32; n++) {
          byte value = window[i + n * stride];
          if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') ||
                (value >= 'A' && value <= 'F')) || (stride == 2 && window[i + n * stride + 1] != 0)) {
            plausible = false; break;
          }
          candidate[n] = value;
        }
        if (!plausible) { Array.Clear(candidate, 0, candidate.Length); continue; }
        byte[] digest;
        using (SHA256 hash = SHA256.Create()) digest = hash.ComputeHash(candidate);
        string signature = Convert.ToBase64String(digest);
        Array.Clear(digest, 0, digest.Length);
        if (!seen.Add(signature)) { Array.Clear(candidate, 0, candidate.Length); continue; }
        candidates++;
        if (LineEncryptedPageValidator.FirstPageValid(firstPage, candidate)) return candidate;
        Array.Clear(candidate, 0, candidate.Length);
      }
    }
    return null;
  }
  static bool IsAlnum(byte value) {
    return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'z') ||
      (value >= 'A' && value <= 'Z');
  }
}
