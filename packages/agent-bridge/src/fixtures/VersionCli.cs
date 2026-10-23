using System;
public static class VersionCli {
  public static int Main(string[] args) {
    if (args.Length != 1 || args[0] != "--version") return 3;
    Console.WriteLine("codex-cli 0.144.5");
    return 0;
  }
}
