using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class LineFixtureProcess {
  static int Main() {
    byte[] passphrase = Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");
    GCHandle pinned = GCHandle.Alloc(passphrase, GCHandleType.Pinned);
    Console.Out.WriteLine("READY");
    try { Console.In.ReadLine(); }
    finally {
      Array.Clear(passphrase, 0, passphrase.Length);
      if (pinned.IsAllocated) pinned.Free();
    }
    return 0;
  }
}
