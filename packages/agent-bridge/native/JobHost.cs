// Windows 10/11 x64 process ownership. This host never receives a prompt in argv.
// The unnamed Job handle is not inheritable; no breakaway flags are enabled.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class JobHost {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public uint cb; public string reserved, desktop, title;
    public uint x,y,xSize,ySize,xCountChars,yCountChars,fillAttribute,flags;
    public ushort showWindow,reserved2;
    public IntPtr reservedPointer, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint processId,threadId; }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo startup; public IntPtr attributes; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int infoClass,ref ExtendedLimits info,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int infoClass,out Accounting info,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInfo info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  // CommandLineToArgvW/MS CRT quoting; no shell participates in parsing.
  static string Quote(string value) {
    StringBuilder result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') {slashes++;continue;}
      if(c=='"') {result.Append('\\',slashes*2+1);result.Append('"');slashes=0;continue;}
      result.Append('\\',slashes);slashes=0;result.Append(c);
    }
    result.Append('\\',slashes*2);return result.Append('"').ToString();
  }
  static bool WaitEmpty(IntPtr job) {
    DateTime end=DateTime.UtcNow.AddSeconds(5);
    do {
      Accounting accounting;
      Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
      if(accounting.ActiveProcesses==0) return true;
      Thread.Sleep(10);
    } while(DateTime.UtcNow<end);
    return false;
  }
  public static int Main(string[] args) {
    IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,attributes=IntPtr.Zero,jobValue=IntPtr.Zero;
    EventWaitHandle cancel=null; ProcessInfo child=new ProcessInfo(); bool attributesReady=false;
    try {
      Guid jobId; uint parentId;
      if(args.Length==2 && args[0]=="--cancel" && Guid.TryParse(args[1],out jobId)) {
        try {using(EventWaitHandle signal=EventWaitHandle.OpenExisting("Local\\LineAgentJob-"+jobId.ToString("D"))) {signal.Set();return 0;}}
        catch(WaitHandleCannotBeOpenedException) {return 3;}
      }
      if(args.Length<5 || !Guid.TryParse(args[0],out jobId) || !UInt32.TryParse(args[1],out parentId) || (args[2]!="pipe" && args[2]!="interactive") || !Path.IsPathRooted(args[3]) || !Path.IsPathRooted(args[4])) return 125;
      bool interactive=args[2]=="interactive";
      parent=OpenProcess(0x00100000,false,parentId);Check(parent!=IntPtr.Zero);
      cancel=new EventWaitHandle(false,EventResetMode.ManualReset,"Local\\LineAgentJob-"+jobId.ToString("D"));
      job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
      Check(SetHandleInformation(job,1,0));
      ExtendedLimits limits=new ExtendedLimits();limits.BasicLimitInformation.LimitFlags=0x2000; // KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      StartupInfoEx startup=new StartupInfoEx();startup.startup.cb=(uint)Marshal.SizeOf(typeof(StartupInfoEx));
      if(!interactive) {
        startup.startup.flags=0x100; // STARTF_USESTDHANDLES
        startup.startup.input=GetStdHandle(-10);startup.startup.output=GetStdHandle(-11);startup.startup.error=GetStdHandle(-12);
        Check(SetHandleInformation(startup.startup.input,1,1));Check(SetHandleInformation(startup.startup.output,1,1));Check(SetHandleInformation(startup.startup.error,1,1));
      }
      // Windows 10 JOB_LIST assigns ownership atomically at creation, eliminating
      // the host-crash gap between CreateProcess and AssignProcessToJobObject.
      IntPtr attributeSize=IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attributeSize);
      attributes=Marshal.AllocHGlobal(attributeSize);
      Check(InitializeProcThreadAttributeList(attributes,1,0,ref attributeSize));attributesReady=true;
      jobValue=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobValue,job);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x0002000D),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      startup.attributes=attributes;
      StringBuilder command=new StringBuilder(Quote(args[3]));
      for(int i=5;i<args.Length;i++) command.Append(' ').Append(Quote(args[i]));
      uint flags=0x4 | 0x400 | 0x80000 | (interactive?0x10u:0x08000000u);
      Check(CreateProcess(args[3],command,IntPtr.Zero,IntPtr.Zero,!interactive,flags,IntPtr.Zero,args[4],ref startup,out child));
      Console.CancelKeyPress += delegate(object sender,ConsoleCancelEventArgs e) {e.Cancel=true;cancel.Set();};
      Check(ResumeThread(child.thread)!=UInt32.MaxValue);
      uint reason=WaitForMultipleObjects(3,new IntPtr[]{parent,cancel.SafeWaitHandle.DangerousGetHandle(),child.process},false,UInt32.MaxValue);
      Check(reason<=2);
      uint exitCode=130;
      if(reason==2) Check(GetExitCodeProcess(child.process,out exitCode));
      Check(TerminateJobObject(job,exitCode));
      if(!WaitEmpty(job)) return 124;
      return unchecked((int)exitCode);
    } catch {
      // No exception paths, argv, environment or credential details are exposed.
      Console.Error.WriteLine("Windows process isolation failed.");return 125;
    } finally {
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(child.process!=IntPtr.Zero) CloseHandle(child.process);
      if(parent!=IntPtr.Zero) CloseHandle(parent);
      if(cancel!=null) cancel.Dispose();
      if(attributesReady) DeleteProcThreadAttributeList(attributes);
      if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if(jobValue!=IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
    }
  }
}
