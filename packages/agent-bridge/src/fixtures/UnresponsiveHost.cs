using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
public static class UnresponsiveHost {
  public static void Main() {
    File.AppendAllText(Assembly.GetExecutingAssembly().Location+".pids",Process.GetCurrentProcess().Id+"\n");
    Thread.Sleep(60000);
  }
}
