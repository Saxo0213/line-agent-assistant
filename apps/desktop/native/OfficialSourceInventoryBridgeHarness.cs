using System;

internal static class OfficialSourceInventoryBridgeHarness {
  static int Main(string[] args) {
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
}
