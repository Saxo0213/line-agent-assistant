using System;
using System.Diagnostics;

internal static class OfficialSourceInventoryBridgeHarness {
  static int Main(string[] args) {
    if (args != null && args.Length == 4 && args[2] == "change_signal_loop") return RunChangeSignalLoop(args[1], Int32.Parse(args[3]));
    if (args == null || (args.Length < 3 || args.Length > 5)) return 2;
    int realProcessId = args.Length >= 4 ? Int32.Parse(args[3]) : 0;
    string[] bridgeArgs = new string[] { "--request-id", args[0] };
    string lineRoot = System.IO.Path.Combine(args[1], "LINE");
    ExternalReaderBridge.TestOfficialSourceRoot = lineRoot;
    ExternalReaderBridge.TestOfficialPauseStage = args.Length == 5 ? args[4] : null;
    ExternalReaderBridge.TestOfficialSourceEnvironment = new OfficialSourceInventoryHarness.SyntheticEnvironment(
      new WindowsOfficialSourceInventoryEnvironment(), lineRoot, args[2], realProcessId);
    return ExternalReaderBridge.Main(bridgeArgs);
  }

  // Runs the change check in a loop on <root>\messages.edb for durationMs. The test renames and deletes the -shm file
  // meanwhile. A sharing violation (Win32 error 32) from the check is the failure this loop looks for.
  static int RunChangeSignalLoop(string root, int durationMs) {
    string database = System.IO.Path.Combine(root, "messages.edb");
    Stopwatch clock = Stopwatch.StartNew();
    long iterations = 0, unreadable = 0, sharingViolations = 0;
    bool announced = false;
    while (clock.ElapsedMilliseconds < durationMs) {
      OfficialChangeSignal.LastOpenError = 0;
      string value = OfficialChangeSignal.Read(database);
      iterations++;
      if (value == null) {
        unreadable++;
        if (OfficialChangeSignal.LastOpenError == 32) sharingViolations++;
      }
      if (!announced) { Console.Out.WriteLine("READY"); announced = true; }
    }
    Console.Out.WriteLine("LOOP|" + iterations + "|" + unreadable + "|" + sharingViolations);
    return 0;
  }
}
