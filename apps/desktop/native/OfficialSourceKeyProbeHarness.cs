using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

internal static class OfficialSourceKeyProbeHarness {
  static int Main(string[] args) {
    if (args.Length != 1) return 2;
    byte[] page = new byte[4096];
    using (FileStream input = new FileStream(args[0], FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      int read = 0;
      while (read < page.Length) {
        int count = input.Read(page, read, page.Length - read);
        if (count <= 0) return 2;
        read += count;
      }
    }
    byte[] valid = Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");
    byte[] invalid = Encoding.ASCII.GetBytes("00000000000000000000000000000000");
    byte[] window = Encoding.ASCII.GetBytes("|00000000000000000000000000000000|0123456789abcdef0123456789abcdef|");
    int candidates = 0;
    byte[] found = OfficialSourceKeyProbe.ScanWindow(window, page, new HashSet<string>(), ref candidates, true, true);
    try {
      if (found == null || !Equal(found, valid) || candidates != 2) return 1;
      int boundaryCount = 0;
      byte[] embedded = Encoding.ASCII.GetBytes("a0123456789abcdef0123456789abcdefz");
      if (OfficialSourceKeyProbe.ScanWindow(embedded, page, new HashSet<string>(), ref boundaryCount, true, true) != null ||
          boundaryCount != 0) return 1;
      int badCount = 0;
      if (OfficialSourceKeyProbe.ScanWindow(invalid, page, new HashSet<string>(), ref badCount, true, true) != null ||
          badCount != 1) return 1;
      Console.WriteLine("PASS|FIRST_PAGE_BEFORE_SQLITE|CANDIDATES=2");
      return 0;
    } finally {
      Array.Clear(page, 0, page.Length);
      Array.Clear(valid, 0, valid.Length);
      Array.Clear(invalid, 0, invalid.Length);
      Array.Clear(window, 0, window.Length);
      if (found != null) Array.Clear(found, 0, found.Length);
    }
  }
  static bool Equal(byte[] left, byte[] right) {
    if (left.Length != right.Length) return false;
    for (int i = 0; i < left.Length; i++) if (left[i] != right[i]) return false;
    return true;
  }
}
