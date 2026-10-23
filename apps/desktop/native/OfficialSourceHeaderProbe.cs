using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Research-only read-only acquisition. Candidate values leave this process
// only over the parent-owned captured stdout pipe.
internal static class OfficialSourceHeaderProbe {
#if READER_AUTH_PROBE_TEST
  internal static Func<long, MemoryRegion?> TestQueryRegion;
  internal static Func<long, byte[], int> TestReadMemory;
  internal static Action TestVerifyHandle;
  internal static Func<IntPtr> TestOpenReader;
  internal static Action<IntPtr> TestCloseReader;
  internal static long TestMaxScanBytes;
  internal static int TestMaxCandidateCount;
#endif
  internal const int MaxCandidateCount = 16;
  internal const int MaxTokenChars = 1024;
  internal const int MaxApplicationChars = 512;
  const int MaxHeaderBlockBytes = 8192;
  const int ChunkBytes = 1024 * 1024;
  const long MaxScanBytes = 256L * 1024 * 1024;
  const int MaxDurationMs = 20000;
  const int ProcessQueryInformation = 0x0400, ProcessVmRead = 0x0010;
  const uint MemCommit = 0x1000, MemPrivate = 0x20000, PageGuard = 0x100;
  const uint PageNoAccess = 0x01;
  static readonly byte[] AccessMarker = Encoding.ASCII.GetBytes("X-LINE-ACCESS:");
  static readonly byte[] ApplicationMarker = Encoding.ASCII.GetBytes("X-LINE-APPLICATION:");
  static readonly byte[] HttpVersionMarker = Encoding.ASCII.GetBytes("HTTP/1.");

  [StructLayout(LayoutKind.Sequential)]
  internal struct MemoryRegion {
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

  internal sealed class HeaderCandidate {
    internal string Token;
    internal string Application;
  }

  internal static List<HeaderCandidate> Find(OfficialSourceInventoryResult source,
      IOfficialSourceInventoryEnvironment environment, DateTime deadlineUtc, CancellationToken cancellation,
      bool verifyProcess = true) {
    if (source == null || environment == null) throw new InvalidDataException("source_unavailable");
    cancellation.ThrowIfCancellationRequested();
    OfficialSourceInventory.RequireSameSource(source, environment, verifyProcess);
    bool injected = false;
#if READER_AUTH_PROBE_TEST
    injected = TestQueryRegion != null && TestReadMemory != null;
#endif
    long scanByteLimit = MaxScanBytes;
    int candidateLimit = MaxCandidateCount;
#if READER_AUTH_PROBE_TEST
    if (TestMaxScanBytes > 0) scanByteLimit = Math.Min(scanByteLimit, TestMaxScanBytes);
    if (TestMaxCandidateCount > 0) candidateLimit = Math.Min(candidateLimit, TestMaxCandidateCount);
#endif
    IntPtr process = IntPtr.Zero;
#if READER_AUTH_PROBE_TEST
    if (injected && TestOpenReader != null) process = TestOpenReader();
#endif
    if (!injected) process = OpenProcess(ProcessQueryInformation | ProcessVmRead, false, source.ProcessId);
    if (!injected && process == IntPtr.Zero) throw new InvalidDataException("process_unavailable");
    try {
      VerifyCurrentHandle(process, source, injected);
      OfficialSourceInventory.RequireSameSource(source, environment, verifyProcess);
      Stopwatch clock = Stopwatch.StartNew();
      long scanned = 0, address = 0;
      List<HeaderCandidate> candidates = new List<HeaderCandidate>();
      HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
      while (address >= 0 && address < 0x00007FFFFFFF0000L && scanned < scanByteLimit &&
          clock.ElapsedMilliseconds < MaxDurationMs && DateTime.UtcNow < deadlineUtc && candidates.Count < candidateLimit) {
        cancellation.ThrowIfCancellationRequested();
        if (clock.ElapsedMilliseconds >= MaxDurationMs || DateTime.UtcNow >= deadlineUtc) break;
        MemoryRegion region = new MemoryRegion();
        if (injected) {
#if READER_AUTH_PROBE_TEST
          MemoryRegion? observed = TestQueryRegion(address);
          if (!observed.HasValue) break;
          region = observed.Value;
#endif
        } else if (VirtualQueryEx(process, new IntPtr(address), out region,
            new UIntPtr((uint)Marshal.SizeOf(typeof(MemoryRegion)))).ToUInt64() == 0) break;
        long next = checked(region.BaseAddress.ToInt64() + (long)region.RegionSize.ToUInt64());
        if (next <= address) throw new InvalidDataException("process_unavailable");
        uint protection = region.Protect & 0xff;
        bool readable = region.State == MemCommit && region.Type == MemPrivate &&
          protection != PageNoAccess && (protection == 2 || protection == 4 || protection == 8 ||
            protection == 0x20 || protection == 0x40 || protection == 0x80) && (region.Protect & PageGuard) == 0;
        ulong size = region.RegionSize.ToUInt64();
        if (readable && size > 0 && size <= 128UL * 1024 * 1024) {
          byte[] carry = new byte[0];
          try {
            for (ulong offset = 0; offset < size && scanned < scanByteLimit && candidates.Count < candidateLimit &&
                clock.ElapsedMilliseconds < MaxDurationMs && DateTime.UtcNow < deadlineUtc;) {
              cancellation.ThrowIfCancellationRequested();
              int length = (int)Math.Min((ulong)ChunkBytes, Math.Min(size - offset, (ulong)(scanByteLimit - scanned)));
              byte[] buffer = new byte[length];
              byte[] window = null;
              try {
                int count;
                bool ok;
                if (injected) {
#if READER_AUTH_PROBE_TEST
                  int observed = TestReadMemory(checked(region.BaseAddress.ToInt64() + (long)offset), buffer);
                  ok = observed >= 0;
                  count = Math.Min(length, Math.Abs(observed));
#else
                  throw new InvalidDataException("process_unavailable");
#endif
                } else {
                  UIntPtr read;
                  ok = ReadProcessMemory(process, new IntPtr(checked(region.BaseAddress.ToInt64() + (long)offset)),
                    buffer, new UIntPtr((uint)length), out read);
                  count = (int)Math.Min((ulong)length, read.ToUInt64());
                }
                scanned += count;
                if (ok && count > 0) {
                  window = new byte[carry.Length + count];
                  Buffer.BlockCopy(carry, 0, window, 0, carry.Length);
                  Buffer.BlockCopy(buffer, 0, window, carry.Length, count);
                  ParseWindow(window, window.Length, offset == 0 && carry.Length == 0, candidates, seen, candidateLimit,
                    cancellation, deadlineUtc);
                  Array.Clear(carry, 0, carry.Length);
                  int keep = Math.Min(MaxHeaderBlockBytes, window.Length);
                  carry = new byte[keep];
                  if (keep > 0) Buffer.BlockCopy(window, window.Length - keep, carry, 0, keep);
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
      cancellation.ThrowIfCancellationRequested();
      if (DateTime.UtcNow >= deadlineUtc || clock.ElapsedMilliseconds >= MaxDurationMs) {
        if (candidates.Count == 0) throw new InvalidDataException("scan_limit");
      }
      if (scanned >= scanByteLimit && candidates.Count == 0) throw new InvalidDataException("scan_limit");
      VerifyCurrentHandle(process, source, injected);
      OfficialSourceInventory.RequireSameSource(source, environment, verifyProcess);
      return candidates;
    } finally {
      if (process != IntPtr.Zero) {
#if READER_AUTH_PROBE_TEST
        if (injected && TestCloseReader != null) TestCloseReader(process);
        else CloseHandle(process);
#else
        CloseHandle(process);
#endif
      }
    }
  }

  internal static void ParseWindow(byte[] bytes, int length, bool startsAtRegionBoundary,
      List<HeaderCandidate> output, HashSet<string> seen, int maximum,
      CancellationToken cancellation = default(CancellationToken), DateTime deadlineUtc = default(DateTime)) {
    if (bytes == null || output == null || seen == null || maximum < 1) return;
    int boundedLength = Math.Min(bytes.Length, length);
    for (int access = 0; access + AccessMarker.Length < boundedLength && output.Count < maximum; access++) {
      if ((access & 0xff) == 0) ThrowIfStopped(cancellation, deadlineUtc);
      if (!Matches(bytes, boundedLength, access, AccessMarker) || !IsLineStart(bytes, access, startsAtRegionBoundary)) continue;
      int accessEnd;
      string token;
      if (!ReadField(bytes, boundedLength, access + AccessMarker.Length, MaxTokenChars, false, out token, out accessEnd,
          cancellation, deadlineUtc)) continue;
      int blockStart = FindBlockStart(bytes, access, startsAtRegionBoundary, cancellation, deadlineUtc);
      if (blockStart < 0) continue;
      int blockEnd = FindBlockEnd(bytes, accessEnd, boundedLength, blockStart, cancellation, deadlineUtc);
      if (blockEnd < 0 || blockEnd - blockStart > MaxHeaderBlockBytes) continue;
      for (int app = blockStart; app + ApplicationMarker.Length < blockEnd && output.Count < maximum; app++) {
        if ((app & 0xff) == 0) ThrowIfStopped(cancellation, deadlineUtc);
        if (!Matches(bytes, blockEnd, app, ApplicationMarker) || !IsLineStart(bytes, app, startsAtRegionBoundary)) continue;
        int appEnd;
        string application;
        if (!ReadField(bytes, blockEnd, app + ApplicationMarker.Length, MaxApplicationChars, true,
            out application, out appEnd, cancellation, deadlineUtc)) continue;
        if (!application.StartsWith("DESKTOPWIN\t", StringComparison.Ordinal)) continue;
        string key = application + "\u0000" + token;
        if (!seen.Add(key)) continue;
        output.Add(new HeaderCandidate { Token = token, Application = application });
        break;
      }
    }
  }

  static int FindBlockStart(byte[] bytes, int marker, bool startsAtRegionBoundary,
      CancellationToken cancellation, DateTime deadlineUtc) {
    int boundedStart = Math.Max(0, marker - MaxHeaderBlockBytes);
    for (int i = marker - 1; i >= boundedStart; i--) {
      if ((i & 0xff) == 0) ThrowIfStopped(cancellation, deadlineUtc);
      if (bytes[i] == 0) return i + 1;
      if (i + 3 < marker && bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10) {
        return i + 4;
      }
    }
    // If this chunk starts inside a header, locate that header's request line
    // inside the same bounded window so either header field order stays valid.
    for (int i = marker - HttpVersionMarker.Length; i >= boundedStart; i--) {
      if ((i & 0xff) == 0) ThrowIfStopped(cancellation, deadlineUtc);
      if (!Matches(bytes, marker, i, HttpVersionMarker)) continue;
      int lineStart = i;
      while (lineStart > boundedStart && bytes[lineStart - 1] != 10 && bytes[lineStart - 1] != 0) lineStart--;
      if (lineStart > boundedStart && lineStart >= 2 && bytes[lineStart - 2] == 13 && bytes[lineStart - 1] == 10) return lineStart;
      if (lineStart == 0 && startsAtRegionBoundary) return 0;
    }
    return startsAtRegionBoundary ? 0 : boundedStart;
  }

  static int FindBlockEnd(byte[] bytes, int afterField, int length, int start,
      CancellationToken cancellation, DateTime deadlineUtc) {
    int maximum = Math.Min(length - 3, start + MaxHeaderBlockBytes);
    // The CRLF ending the final header field begins two bytes before afterField.
    for (int i = Math.Max(start, afterField - 2); i < maximum; i++) {
      if ((i & 0xff) == 0) ThrowIfStopped(cancellation, deadlineUtc);
      if (bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10) return i + 4;
    }
    return -1;
  }

  static bool ReadField(byte[] bytes, int length, int valueStart, int maximum, bool allowTab,
      out string value, out int lineEnd, CancellationToken cancellation, DateTime deadlineUtc) {
    value = null; lineEnd = -1;
    int end = -1;
    int scanLimit = Math.Min(length - 1, valueStart + maximum + 4);
    for (int i = valueStart; i < scanLimit; i++) {
      if ((i & 0xff) == 0) ThrowIfStopped(cancellation, deadlineUtc);
      if (bytes[i] == 13 && bytes[i + 1] == 10) { end = i; lineEnd = i + 2; break; }
      if (bytes[i] == 10 || bytes[i] == 0) return false;
    }
    if (end < 0) return false;
    int start = valueStart;
    while (start < end && (bytes[start] == 32 || bytes[start] == 9)) start++;
    while (end > start && (bytes[end - 1] == 32 || bytes[end - 1] == 9)) end--;
    int count = end - start;
    if (count <= 0 || count > maximum) return false;
    char[] chars = new char[count];
    for (int i = 0; i < count; i++) {
      byte b = bytes[start + i];
      if (b < 0x20 && !(allowTab && b == 9) || b > 0x7e) { Array.Clear(chars, 0, chars.Length); return false; }
      chars[i] = (char)b;
    }
    value = new string(chars);
    Array.Clear(chars, 0, chars.Length);
    return true;
  }

  static void ThrowIfStopped(CancellationToken cancellation, DateTime deadlineUtc) {
    cancellation.ThrowIfCancellationRequested();
    if (deadlineUtc != default(DateTime) && DateTime.UtcNow >= deadlineUtc) throw new TimeoutException("scan_limit");
  }

  static bool IsLineStart(byte[] bytes, int index, bool startsAtRegionBoundary) {
    return index == 0 ? startsAtRegionBoundary : bytes[index - 1] == 0 ||
      (index >= 2 && bytes[index - 2] == 13 && bytes[index - 1] == 10);
  }

  static bool Matches(byte[] bytes, int length, int index, byte[] marker) {
    if (index < 0 || index + marker.Length > length) return false;
    for (int i = 0; i < marker.Length; i++) {
      byte actual = bytes[index + i], expected = marker[i];
      if (actual >= 'a' && actual <= 'z') actual = (byte)(actual - 32);
      if (actual != expected) return false;
    }
    return true;
  }

  static void VerifyCurrentHandle(IntPtr process, OfficialSourceInventoryResult source, bool injected) {
    if (injected) {
#if READER_AUTH_PROBE_TEST
      if (TestVerifyHandle != null) TestVerifyHandle();
#endif
      return;
    }
    StringBuilder image = new StringBuilder(32768);
    int size = image.Capacity;
    long creation, exit, kernel, user;
    if (!QueryFullProcessImageNameW(process, 0, image, ref size) ||
        !String.Equals(Path.GetFullPath(image.ToString()), source.ExecutablePath, StringComparison.OrdinalIgnoreCase) ||
        !GetProcessTimes(process, out creation, out exit, out kernel, out user) || creation != source.ProcessCreationTime)
      throw new InvalidDataException("source_changed");
  }
}
