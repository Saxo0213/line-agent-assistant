using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Threading;

// Standalone, read-only research harness. The parent must capture stdout; this
// executable never writes candidate values to an interactive console.
internal static class OfficialAuthCandidateMain {
  const int MaxFrameBytes = 30 * 1024;
  static int Main() {
    if (!Console.IsOutputRedirected || !Console.IsErrorRedirected || Environment.GetCommandLineArgs().Length != 1) return 2;
    List<OfficialSourceHeaderProbe.HeaderCandidate> candidates = new List<OfficialSourceHeaderProbe.HeaderCandidate>();
    byte[] frame = null;
    try {
      string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
      if (String.IsNullOrEmpty(localAppData)) throw new InvalidDataException();
      string root = Path.Combine(localAppData, "LINE");
      WindowsOfficialSourceInventoryEnvironment environment = new WindowsOfficialSourceInventoryEnvironment();
      OfficialSourceInventoryResult source = OfficialSourceInventory.Inspect(root,
        OfficialSourceInventory.SupportedBuildVersion, OfficialSourceInventory.SupportedBuildBytes,
        OfficialSourceInventory.SupportedBuildSha256, environment);
      candidates = OfficialSourceHeaderProbe.Find(source, environment, DateTime.UtcNow.AddSeconds(20), CancellationToken.None);
      source = null;
      string serialized;
      do {
        serialized = Serialize(candidates);
        frame = Encoding.UTF8.GetBytes(serialized);
        if (frame.Length <= MaxFrameBytes || candidates.Count == 0) break;
        Array.Clear(frame, 0, frame.Length);
        frame = null;
        candidates.RemoveAt(candidates.Count - 1);
      } while (true);
      Console.Out.WriteLine(Encoding.UTF8.GetString(frame));
      Console.Out.Flush();
      return 0;
    } catch {
      // The parent treats a nonzero exit or malformed/empty frame as a generic
      // bounded acquisition failure. No exception text reaches output streams.
      return 1;
    } finally {
      if (frame != null) Array.Clear(frame, 0, frame.Length);
      if (candidates != null) candidates.Clear();
    }
  }

  static string Serialize(List<OfficialSourceHeaderProbe.HeaderCandidate> candidates) {
    List<Dictionary<string, string>> safe = new List<Dictionary<string, string>>(candidates.Count);
    foreach (OfficialSourceHeaderProbe.HeaderCandidate candidate in candidates) {
      safe.Add(new Dictionary<string, string> { { "token", candidate.Token }, { "application", candidate.Application } });
    }
    return new JavaScriptSerializer { MaxJsonLength = 256 * 1024 }.Serialize(new Dictionary<string, object> {
      { "status", "ok" }, { "candidates", safe }
    });
  }
}
