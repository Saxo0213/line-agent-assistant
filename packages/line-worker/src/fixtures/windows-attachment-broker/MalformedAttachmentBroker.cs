using System;
internal static class MalformedAttachmentBroker {
  public static int Main(string[] args) {
    if(args.Length==1&&args[0]=="--version") { Console.Out.WriteLine("{\"protocol\":\"line-attachment-broker/v1\",\"version\":\"1.0.0\",\"rootHandleAnchored\":true,\"rejectsReparsePoints\":true,\"publishNoReplace\":true}"); return 0; }
    Console.Out.WriteLine("not-json"); return 0;
  }
}
