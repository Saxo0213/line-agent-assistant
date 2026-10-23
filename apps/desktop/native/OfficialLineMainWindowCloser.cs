using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class OfficialLineMainWindowCloser {
  const uint WmClose = 0x0010;
  const uint SmtoBlock = 0x0001;
  const uint SmtoAbortIfHung = 0x0002;
  const uint CloseMessageTimeoutMs = 5000;
  const int VisibilityWaitTimeoutMs = 5000;
  const int ProcessQueryLimitedInformation = 0x1000;
  const int MaxMainWindows = 8;

  delegate bool EnumWindowsCallback(IntPtr window, IntPtr state);

  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);
  [DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern int GetWindowTextW(IntPtr window, StringBuilder text, int maximum);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern int GetClassNameW(IntPtr window, StringBuilder className, int maximum);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW", SetLastError=true)]
  static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam,
      uint flags, uint timeout, out IntPtr result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int access, bool inherit, int processId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder imagePath, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

  internal static void CloseVisibleMainWindowToTray(OfficialSourceInventoryResult pinned, CancellationToken cancellation) {
    if (pinned == null || pinned.ProcessId <= 0 || pinned.ProcessCreationTime <= 0 || String.IsNullOrEmpty(pinned.ExecutablePath))
      throw new InvalidDataException("source_changed");

    VerifyPinnedProcess(pinned);
    List<IntPtr> matches = FindMatchingVisibleMainWindows(pinned.ProcessId);
    if (matches.Count == 0) {
      VerifyPinnedProcess(pinned);
      cancellation.ThrowIfCancellationRequested();
      return;
    }
    if (matches.Count > MaxMainWindows) throw new InvalidDataException("line_window_close_failed");

    foreach (IntPtr target in matches) {
      cancellation.ThrowIfCancellationRequested();
      // A window that disappeared on its own before its turn is fine.
      if (!IsWindow(target) || !IsWindowVisible(target)) continue;
      CloseOneWindow(pinned, target, cancellation);
    }

    VerifyPinnedProcess(pinned);
    if (FindMatchingVisibleMainWindows(pinned.ProcessId).Count != 0) throw new InvalidDataException("line_window_close_failed");
  }

  static void CloseOneWindow(OfficialSourceInventoryResult pinned, IntPtr target, CancellationToken cancellation) {
    VerifyPinnedProcess(pinned);
    if (!IsWindow(target) || !IsWindowVisible(target)) return;
    if (!MatchesPinnedWindow(target, pinned.ProcessId)) throw new InvalidDataException("line_window_close_failed");
    VerifyPinnedProcess(pinned);
    IntPtr messageResult;
    IntPtr sent = SendMessageTimeout(target, WmClose, UIntPtr.Zero, IntPtr.Zero,
      SmtoBlock | SmtoAbortIfHung, CloseMessageTimeoutMs, out messageResult);
    if (sent == IntPtr.Zero) throw new InvalidDataException("line_window_close_failed");
    VerifyPinnedProcess(pinned);

    Stopwatch wait = Stopwatch.StartNew();
    while (IsWindow(target) && IsWindowVisible(target)) {
      cancellation.ThrowIfCancellationRequested();
      if (wait.ElapsedMilliseconds >= VisibilityWaitTimeoutMs) throw new InvalidDataException("line_window_close_failed");
      Thread.Sleep(50);
    }
    VerifyPinnedProcess(pinned);
  }

  static bool MatchesPinnedWindow(IntPtr window, int processId) {
    uint actualProcessId;
    GetWindowThreadProcessId(window, out actualProcessId);
    return actualProcessId == unchecked((uint)processId) && IsWindowVisible(window) && IsExactMainWindow(window);
  }

  static List<IntPtr> FindMatchingVisibleMainWindows(int processId) {
    List<IntPtr> matches = new List<IntPtr>();
    EnumWindowsCallback callback = delegate(IntPtr window, IntPtr state) {
      uint actualProcessId;
      GetWindowThreadProcessId(window, out actualProcessId);
      if (actualProcessId == unchecked((uint)processId) && IsWindowVisible(window) && IsExactMainWindow(window))
        matches.Add(window);
      return true;
    };
    if (!EnumWindows(callback, IntPtr.Zero)) throw new InvalidDataException("line_window_close_failed");
    return matches;
  }

  static bool IsExactMainWindow(IntPtr window) {
    int titleLength = GetWindowTextLengthW(window);
    if (titleLength < 0 || titleLength > 1024) return false;
    StringBuilder title = new StringBuilder(titleLength + 1);
    if (GetWindowTextW(window, title, title.Capacity) <= 0 || !String.Equals(title.ToString(), "LINE", StringComparison.Ordinal)) return false;
    StringBuilder className = new StringBuilder(256);
    if (GetClassNameW(window, className, className.Capacity) <= 0) return false;
    return IsQtWindowIconClass(className.ToString());
  }

  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern int GetWindowTextLengthW(IntPtr window);

  static bool IsQtWindowIconClass(string value) {
    const string prefix = "Qt", suffix = "QWindowIcon";
    if (value == null || value.Length <= prefix.Length + suffix.Length ||
        !value.StartsWith(prefix, StringComparison.Ordinal) || !value.EndsWith(suffix, StringComparison.Ordinal)) return false;
    for (int i = prefix.Length; i < value.Length - suffix.Length; i++)
      if (value[i] < '0' || value[i] > '9') return false;
    return true;
  }

  static void VerifyPinnedProcess(OfficialSourceInventoryResult pinned) {
    IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, pinned.ProcessId);
    if (process == IntPtr.Zero) throw new InvalidDataException("source_changed");
    try {
      StringBuilder imagePath = new StringBuilder(32768);
      int imagePathLength = imagePath.Capacity;
      long creation, exit, kernel, user;
      if (!QueryFullProcessImageNameW(process, 0, imagePath, ref imagePathLength) ||
          !String.Equals(Path.GetFullPath(imagePath.ToString()), Path.GetFullPath(pinned.ExecutablePath), StringComparison.OrdinalIgnoreCase) ||
          !GetProcessTimes(process, out creation, out exit, out kernel, out user) ||
          creation != pinned.ProcessCreationTime || exit != 0)
        throw new InvalidDataException("source_changed");
    } finally { CloseHandle(process); }
  }
}
