// Windows x64 attachment writer. All untrusted descendants are opened relative
// to an already-open root/directory handle through NtCreateFile. No shell, path
// concatenation, or ambient-current-directory lookup is used below the root.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class AttachmentBroker {
  static string Stage="START";
  const string Protocol = "line-attachment-broker/v1";
  const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, Delete = 0x00010000, Synchronize = 0x00100000;
  const uint FileTraverse = 0x0020, FileReadAttributes = 0x0080;
  const uint ShareAll = 7, OpenExisting = 3, BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
  const uint ShareReadDelete = 5, FileDeleteOnClose = 0x00001000;
  const uint ObjCaseInsensitive = 0x40, FileDirectory = 1, FileSynchronous = 0x20, FileNonDirectory = 0x40;
  const uint FileOpenReparsePoint = 0x00200000, FileOpen = 1, FileCreate = 2, FileOpenIf = 3;
  const uint FileAttributeNormal = 0x80, FileAttributeReparsePoint = 0x400;
  const int StatusObjectNameCollision = unchecked((int)0xC0000035);
  const int StatusObjectNameExists = unchecked((int)0x40000000);

  [DataContract] sealed class Header {
    [DataMember(Name="protocol")] public string protocol="";
    [DataMember(Name="root")] public string root="";
    [DataMember(Name="directorySegments")] public string[] directorySegments=new string[0];
    [DataMember(Name="targetFileName")] public string targetFileName="";
    [DataMember(Name="maxBytes")] public long maxBytes=-1;
  }
  sealed class BrokerFailure : Exception {
    public readonly string Code;
    public BrokerFailure(string code, string message) : base(message) { Code=code; }
  }
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
    public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoStatusBlock { public IntPtr Status, Information; }
  [StructLayout(LayoutKind.Sequential)] struct ByHandleInfo {
    public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct JobBasicLimits {
    public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct JobIoCounters { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct JobExtendedLimits { public JobBasicLimits BasicLimitInformation; public JobIoCounters IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out ByHandleInfo info);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle file,uint access,ref ObjectAttributes attributes,out IoStatusBlock status,IntPtr allocation,uint fileAttributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle file,out IoStatusBlock status,IntPtr information,uint length,int informationClass);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle file);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,SafeFileHandle source,IntPtr targetProcess,out SafeFileHandle target,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int informationClass,ref JobExtendedLimits information,uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);

  static void FailNt(int status) { throw new Win32Exception((int)RtlNtStatusToDosError(status)); }
  static void ValidateName(string value) {
    if(String.IsNullOrEmpty(value)||value=="."||value==".."||value.IndexOfAny(new[]{'\\','/',':','\0'})>=0||value.EndsWith(".")||value.EndsWith(" "))
      throw new BrokerFailure("INVALID_REQUEST","Invalid relative component.");
  }
  static void AssertNotReparse(SafeFileHandle handle) {
    ByHandleInfo info; if(!GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if((info.FileAttributes & FileAttributeReparsePoint)!=0) throw new BrokerFailure("REPARSE_POINT","A reparse point was rejected.");
  }
  static SafeFileHandle OpenRelative(SafeFileHandle root,string name,bool directory,uint disposition,uint access,uint share,uint extraOptions) {
    ValidateName(name); IntPtr text=IntPtr.Zero, unicodePointer=IntPtr.Zero;
    try {
      text=Marshal.StringToHGlobalUni(name); UnicodeString unicode=new UnicodeString{Length=(ushort)(name.Length*2),MaximumLength=(ushort)(name.Length*2),Buffer=text};
      unicodePointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString))); Marshal.StructureToPtr(unicode,unicodePointer,false);
      ObjectAttributes attributes=new ObjectAttributes{Length=Marshal.SizeOf(typeof(ObjectAttributes)),RootDirectory=root.DangerousGetHandle(),ObjectName=unicodePointer,Attributes=ObjCaseInsensitive};
      IoStatusBlock io; SafeFileHandle result; uint options=FileSynchronous|FileOpenReparsePoint|extraOptions|(directory?FileDirectory:FileNonDirectory);
      int status=NtCreateFile(out result,access|Synchronize,ref attributes,out io,IntPtr.Zero,FileAttributeNormal,share,disposition,options,IntPtr.Zero,0);
      if(status<0) FailNt(status); AssertNotReparse(result); return result;
    } finally { if(unicodePointer!=IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer); if(text!=IntPtr.Zero) Marshal.FreeHGlobal(text); }
  }
  static void SetDeleteDisposition(SafeFileHandle file,bool delete) {
    IntPtr value=Marshal.AllocHGlobal(1); try { Marshal.WriteByte(value,delete?(byte)1:(byte)0); IoStatusBlock io; int status=NtSetInformationFile(file,out io,value,1,13); if(status<0) FailNt(status); }
    finally { Marshal.FreeHGlobal(value); }
  }
  static void MarkDelete(SafeFileHandle file) { SetDeleteDisposition(file,true); }
  static SafeFileHandle Duplicate(SafeFileHandle file) {
    SafeFileHandle copy; IntPtr process=GetCurrentProcess();
    if(!DuplicateHandle(process,file,process,out copy,0,false,2)) throw new Win32Exception(Marshal.GetLastWin32Error()); // DUPLICATE_SAME_ACCESS
    return copy;
  }
  static void OwnProcessTree() {
    // The helper launches no children. Still, owning itself in a no-breakaway
    // KILL_ON_JOB_CLOSE job guarantees a substituted/crashing helper cannot
    // leave descendants when its last job handle closes at process teardown.
    IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    JobExtendedLimits limits=new JobExtendedLimits(); limits.BasicLimitInformation.LimitFlags=0x2000;
    if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(JobExtendedLimits)))||!AssignProcessToJobObject(job,GetCurrentProcess())) throw new Win32Exception(Marshal.GetLastWin32Error());
    // Deliberately held until process teardown; closing it here would terminate
    // this process because it is itself a job member.
  }
  static int LinkNoReplace(SafeFileHandle staging,SafeFileHandle directory,string target) {
    ValidateName(target); byte[] name=Encoding.Unicode.GetBytes(target); int handleOffset=IntPtr.Size==8?8:4, lengthOffset=handleOffset+IntPtr.Size, nameOffset=lengthOffset+4;
    IntPtr value=Marshal.AllocHGlobal(nameOffset+name.Length);
    try {
      for(int i=0;i<nameOffset;i++) Marshal.WriteByte(value,i,0);
      Marshal.WriteIntPtr(value,handleOffset,directory.DangerousGetHandle()); Marshal.WriteInt32(value,lengthOffset,name.Length); Marshal.Copy(name,0,IntPtr.Add(value,nameOffset),name.Length);
      // FileLinkInformation with ReplaceIfExists=false atomically creates the
      // final name. The staging link remains delete-on-close, so process death
      // before or after this call cannot leave a .part file or delete the final
      // hard link.
      IoStatusBlock io; return NtSetInformationFile(staging,out io,value,(uint)(nameOffset+name.Length),11);
    } finally { Marshal.FreeHGlobal(value); }
  }
  static byte[] ReadExact(Stream stream,int count) {
    byte[] value=new byte[count]; int offset=0; while(offset<count) { int read=stream.Read(value,offset,count-offset); if(read==0) throw new BrokerFailure("TRUNCATED_INPUT","Input ended before a committed terminal frame."); offset+=read; } return value;
  }
  static uint UInt32LE(byte[] value) { return (uint)(value[0]|value[1]<<8|value[2]<<16|value[3]<<24); }
  static string Hex(byte[] bytes) { StringBuilder text=new StringBuilder(bytes.Length*2); foreach(byte b in bytes) text.Append(b.ToString("x2")); return text.ToString(); }
  static void WriteResult(bool ok,string code,string hash,long size,bool idempotent) {
    // Values emitted here are internally fixed or hex/numeric; no path or input is reflected.
    if(ok) Console.Out.WriteLine("{\"protocol\":\""+Protocol+"\",\"ok\":true,\"sha256\":\""+hash+"\",\"size\":"+size+",\"idempotent\":"+(idempotent?"true":"false")+"}");
    else Console.Out.WriteLine("{\"protocol\":\""+Protocol+"\",\"ok\":false,\"code\":\""+code+"\"}");
  }
  static Header ReadHeader(Stream input) {
    uint length=UInt32LE(ReadExact(input,4)); if(length==0||length>65536) throw new BrokerFailure("INVALID_REQUEST","Invalid header length.");
    using(MemoryStream data=new MemoryStream(ReadExact(input,(int)length))) {
      Header header=(Header)new DataContractJsonSerializer(typeof(Header)).ReadObject(data);
      if(header==null||header.protocol!=Protocol||header.directorySegments==null||header.maxBytes<0||String.IsNullOrEmpty(header.root)) throw new BrokerFailure("PROTOCOL_ERROR","Unsupported protocol.");
      return header;
    }
  }
  static bool EqualExisting(SafeFileHandle directory,string target,string expected,long expectedSize) {
    using(SafeFileHandle file=OpenRelative(directory,target,false,FileOpen,GenericRead,ShareReadDelete,0)) using(FileStream stream=new FileStream(file,FileAccess.Read,65536,false)) using(SHA256 hash=SHA256.Create()) {
      if(stream.Length!=expectedSize) return false; return Hex(hash.ComputeHash(stream))==expected;
    }
  }
  static bool EqualHandle(SafeFileHandle file,string expected,long expectedSize) {
    using(SafeFileHandle copy=Duplicate(file)) using(FileStream stream=new FileStream(copy,FileAccess.Read,65536,false)) using(SHA256 hash=SHA256.Create()) {
      if(stream.Length!=expectedSize) return false; stream.Position=0; return Hex(hash.ComputeHash(stream))==expected;
    }
  }
  static SafeFileHandle OpenAnchoredRoot(string configuredRoot,List<SafeFileHandle> opened) {
    string full=Path.GetFullPath(configuredRoot);
    if(!Path.IsPathRooted(full)||full.StartsWith("\\\\")||full.StartsWith("\\\\?")||full.StartsWith("\\\\.")) throw new BrokerFailure("INVALID_ROOT","Root must be a local absolute path.");
    string volume=Path.GetPathRoot(full);
    if(volume==null||volume.Length!=3||volume[1]!=':'||(volume[2]!='\\'&&volume[2]!='/')) throw new BrokerFailure("INVALID_ROOT","Root must use a local drive-letter volume.");
    uint directoryAccess=FileTraverse|FileReadAttributes;
    Stage="VOLUME"; SafeFileHandle current=CreateFile(volume,directoryAccess|Synchronize,ShareAll,IntPtr.Zero,OpenExisting,BackupSemantics|OpenReparsePoint,IntPtr.Zero);
    if(current.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error()); opened.Add(current); AssertNotReparse(current);
    string remainder=full.Substring(volume.Length); string[] parts=remainder.Split(new[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries);
    Stage="ROOT"; foreach(string part in parts) {
      SafeFileHandle next=OpenRelative(current,part,true,FileOpenIf,directoryAccess,ShareAll,0); opened.Add(next); current=next;
    }
    return current;
  }
  static void Store(Stream input,Header header,out string digest,out long size,out bool idempotent) {
    List<SafeFileHandle> opened=new List<SafeFileHandle>();
    try {
      SafeFileHandle directory=OpenAnchoredRoot(header.root,opened);
        // Keep directory opens to traversal/read-attributes plus the two create
        // rights. Windows' link/rename target open can otherwise report a
        // sharing violation even when FILE_SHARE_DELETE was requested.
        Stage="DIRECTORY"; foreach(string segment in header.directorySegments) { SafeFileHandle next=OpenRelative(directory,segment,true,FileOpenIf,FileTraverse|FileReadAttributes,ShareAll,0); opened.Add(next); directory=next; }
        ValidateName(header.targetFileName); string staging="."+Guid.NewGuid().ToString("N")+".part";
        // DELETE_ON_CLOSE is the crash/TerminateProcess cleanup guarantee. The
        // handle also withholds FILE_SHARE_WRITE, so no external writer can
        // modify bytes while they are hashed or published.
        Stage="TEMP"; using(SafeFileHandle temporary=OpenRelative(directory,staging,false,FileCreate,GenericRead|GenericWrite|Delete,ShareReadDelete,FileDeleteOnClose)) {
          try {
            using(SHA256 hash=SHA256.Create()) using(SafeFileHandle streamHandle=Duplicate(temporary)) using(FileStream output=new FileStream(streamHandle,FileAccess.Write,65536,false)) {
              size=0; while(true) {
                uint length=UInt32LE(ReadExact(input,4)); if(length==0) break; if(length>1024*1024) throw new BrokerFailure("INVALID_REQUEST","Chunk is too large.");
                byte[] chunk=ReadExact(input,(int)length); size+=chunk.Length; if(size>header.maxBytes) throw new BrokerFailure("MAX_BYTES_EXCEEDED","Byte limit exceeded.");
                output.Write(chunk,0,chunk.Length); hash.TransformBlock(chunk,0,chunk.Length,null,0);
              }
              hash.TransformFinalBlock(new byte[0],0,0); output.Flush(); if(!FlushFileBuffers(temporary)) throw new Win32Exception(Marshal.GetLastWin32Error()); digest=Hex(hash.Hash);
            }
            if(!EqualHandle(temporary,digest,size)) throw new BrokerFailure("CONTENT_CONFLICT","Staging content changed before publication.");
            Stage="LINK"; int status=LinkNoReplace(temporary,directory,header.targetFileName);
              if(status<0 && status!=StatusObjectNameCollision) FailNt(status);
              if(status==StatusObjectNameCollision||status==StatusObjectNameExists) {
                if(!EqualExisting(directory,header.targetFileName,digest,size)) throw new BrokerFailure("CONTENT_CONFLICT","A different target already exists."); idempotent=true;
              } else {
                if(!EqualHandle(temporary,digest,size)) throw new BrokerFailure("CONTENT_CONFLICT","Published content did not match its streamed digest.");
                idempotent=false;
              }
          } catch {
            if(!temporary.IsInvalid && !temporary.IsClosed) { try { MarkDelete(temporary); } catch {} }
            throw;
          }
        }
    } finally { for(int i=opened.Count-1;i>=0;i--) opened[i].Dispose(); }
  }
  public static int Main(string[] args) {
    try {
      OwnProcessTree();
      if(args.Length==1&&args[0]=="--version") { Console.Out.WriteLine("{\"protocol\":\""+Protocol+"\",\"version\":\"1.0.0\",\"rootHandleAnchored\":true,\"rejectsReparsePoints\":true,\"publishNoReplace\":true}"); return 0; }
      if(args.Length!=1||args[0]!="--stdio-v1") throw new BrokerFailure("PROTOCOL_ERROR","Unsupported invocation.");
      Stream input=Console.OpenStandardInput(); Header header=ReadHeader(input); string hash; long size; bool idempotent; Store(input,header,out hash,out size,out idempotent); WriteResult(true,null,hash,size,idempotent); return 0;
    } catch(BrokerFailure error) { WriteResult(false,error.Code,null,0,false); return 2; }
      catch(Win32Exception error) { WriteResult(false,"WIN32_"+Stage+"_"+error.NativeErrorCode,null,0,false); return 3; }
      catch { WriteResult(false,"BROKER_FAILURE",null,0,false); return 3; }
  }
}
