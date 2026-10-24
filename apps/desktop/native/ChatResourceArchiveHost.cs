// Persistent Windows archive host. Every descendant operation is relative to
// a verified directory handle; protocol inputs never contain filesystem paths.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Xml;
using Microsoft.Win32.SafeHandles;

internal static class ChatResourceArchiveHost {
  const string Protocol="chat-resource-archive/v1";
  const uint GenericRead=0x80000000, GenericWrite=0x40000000, Delete=0x00010000, Synchronize=0x00100000;
  const uint FileTraverse=0x20, FileListDirectory=1, FileReadAttributes=0x80, FileAddFile=2, FileAddSubdirectory=4;
  const uint ShareAll=7, ShareRead=1, ShareReadWrite=3, OpenExisting=3, BackupSemantics=0x02000000, OpenReparsePoint=0x00200000;
  const uint ObjCaseInsensitive=0x40, FileDirectory=1, FileSynchronous=0x20, FileNonDirectory=0x40;
  const uint FileAttributeNormal=0x80, FileAttributeReparsePoint=0x400, FileDeleteOnClose=0x1000;
  const uint FileOpen=1, FileCreate=2, FileOpenIf=3;
  const int StatusNameCollision=unchecked((int)0xC0000035), StatusNameExists=unchecked((int)0x40000000), StatusNoMoreFiles=unchecked((int)0x80000006);
  const int MaxHeader=65536, MaxEntries=10000, MaxPayload=32*1024*1024;
  static string Stage="START";
#if CHAT_RESOURCE_ARCHIVE_TESTS
  static void PauseBoundary(string name,string detail=null) {
    string path=Environment.GetEnvironmentVariable("CHAT_RESOURCE_ARCHIVE_TEST_PAUSE_FILE"); if(String.IsNullOrEmpty(path)||!File.Exists(path+"."+name+".enabled")) return;
    string entered=path+"."+name+".entered",release=path+"."+name+".release"; if(detail!=null) File.WriteAllText(path+"."+name+".target",detail); File.WriteAllText(entered,"paused"); DateTime deadline=DateTime.UtcNow.AddSeconds(10);
    while(!File.Exists(release)&&DateTime.UtcNow<deadline) System.Threading.Thread.Sleep(5);
  }
#else
  static void PauseBoundary(string name,string detail=null) { }
#endif
  [DataContract] sealed class Request {
    [DataMember(Name="protocol")] public string protocol="";
    [DataMember(Name="requestId")] public string requestId="";
    [DataMember(Name="op")] public string op="";
    [DataMember(Name="chatSegments")] public string[] chatSegments=new string[0];
    [DataMember(Name="volumeSerial")] public string volumeSerial="";
    [DataMember(Name="fileId")] public string fileId="";
    [DataMember(Name="kind")] public string kind="";
    [DataMember(Name="resourceId")] public string resourceId="";
    [DataMember(Name="albumKey")] public string albumKey="";
    [DataMember(Name="limit")] public int limit=0;
    [DataMember(Name="cursor")] public string cursor="";
    [DataMember(Name="stageId")] public string stageId="";
  }
  [DataContract] sealed class Entry {
    [DataMember(Name="resourceId")] public string resourceId="";
    [DataMember(Name="revision")] public long revision;
    [DataMember(Name="savedAt")] public string savedAt="";
    [DataMember(Name="contentHash")] public string contentHash="";
    [DataMember(Name="byteLength")] public long byteLength;
  }
  [DataContract] sealed class Result {
    [DataMember(Name="protocol")] public string protocol=Protocol;
    [DataMember(Name="requestId")] public string requestId="";
    [DataMember(Name="ok")] public bool ok;
    [DataMember(Name="unchanged",EmitDefaultValue=false)] public bool unchanged;
    [DataMember(Name="code",EmitDefaultValue=false)] public string code="";
    [DataMember(Name="revision")] public long revision;
    [DataMember(Name="savedAt",EmitDefaultValue=false)] public string savedAt="";
    [DataMember(Name="contentHash",EmitDefaultValue=false)] public string contentHash="";
    [DataMember(Name="byteLength",EmitDefaultValue=false)] public long byteLength;
    [DataMember(Name="items",EmitDefaultValue=false)] public Entry[] items;
    [DataMember(Name="nextCursor",EmitDefaultValue=false)] public string nextCursor="";
    [DataMember(Name="payloadLength",EmitDefaultValue=false)] public int payloadLength;
    [DataMember(Name="stageId",EmitDefaultValue=false)] public string stageId="";
    [DataMember(Name="folderName",EmitDefaultValue=false)] public string folderName="";
    [DataMember(Name="fileName",EmitDefaultValue=false)] public string fileName="";
  }
  [DataContract] sealed class Commit {
    [DataMember(Name="protocol")] public string protocol=Protocol;
    [DataMember(Name="kind")] public string kind="";
    [DataMember(Name="resourceKey")] public string resourceKey="";
    [DataMember(Name="revision")] public long revision;
    [DataMember(Name="savedAt")] public string savedAt="";
    [DataMember(Name="contentHash")] public string contentHash="";
    [DataMember(Name="byteLength")] public long byteLength;
  }
  [DataContract] sealed class ErrorResult {
    [DataMember(Name="protocol")] public string protocol=Protocol;
    [DataMember(Name="requestId")] public string requestId="";
    [DataMember(Name="ok")] public bool ok=false;
    [DataMember(Name="code")] public string code="ARCHIVE_FAILURE";
  }
  sealed class Failure : Exception { public readonly string Code; public Failure(string code):base(code){Code=code;} }
  sealed class FileItem { public string name; public uint attributes; }
  sealed class CommitItem { public Commit commit; public string record,identity; }
  sealed class PendingCommit { public string id,key,kind,record; public long previousRevision; public Commit commit; public SafeFileHandle staging; public List<SafeFileHandle> ancestry; }
  static PendingCommit pendingCommit;
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length,MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public int Length; public IntPtr RootDirectory,ObjectName; public uint Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IoStatusBlock { public IntPtr Status,Information; }
  [StructLayout(LayoutKind.Sequential)] struct ByHandleInfo {
    public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime,LastAccessTime,LastWriteTime;
    public uint VolumeSerialNumber,FileSizeHigh,FileSizeLow,NumberOfLinks,FileIndexHigh,FileIndexLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out ByHandleInfo info);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle file,uint access,ref ObjectAttributes attributes,out IoStatusBlock status,IntPtr allocation,uint fileAttributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle file,out IoStatusBlock status,IntPtr information,uint length,int informationClass);
  [DllImport("ntdll.dll")] static extern int NtQueryDirectoryFile(SafeFileHandle file,IntPtr ev,IntPtr apc,IntPtr apcContext,out IoStatusBlock status,IntPtr buffer,uint length,int informationClass,[MarshalAs(UnmanagedType.U1)] bool singleEntry,IntPtr fileName,[MarshalAs(UnmanagedType.U1)] bool restartScan);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle file);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,SafeFileHandle source,IntPtr targetProcess,out SafeFileHandle target,uint access,bool inherit,uint options);

  static void FailNt(int status) { throw new Win32Exception((int)RtlNtStatusToDosError(status)); }
  static void ValidateName(string value) {
    if(String.IsNullOrEmpty(value)||value=="."||value==".."||value.IndexOfAny(new[]{'\\','/',':','\0'})>=0||value.EndsWith(".")||value.EndsWith(" ")) throw new Failure("INVALID_SEGMENT");
  }
  static void AssertPlain(SafeFileHandle handle) {
    ByHandleInfo info; if(!GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if((info.FileAttributes&FileAttributeReparsePoint)!=0) throw new Failure("REPARSE_POINT");
  }
  static SafeFileHandle OpenRelative(SafeFileHandle root,string name,bool directory,uint disposition,uint access,uint options,uint share=ShareAll) {
    ValidateName(name); IntPtr text=IntPtr.Zero,pointer=IntPtr.Zero;
    try {
      text=Marshal.StringToHGlobalUni(name); UnicodeString unicode=new UnicodeString{Length=(ushort)(name.Length*2),MaximumLength=(ushort)(name.Length*2),Buffer=text};
      pointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString))); Marshal.StructureToPtr(unicode,pointer,false);
      ObjectAttributes attributes=new ObjectAttributes{Length=Marshal.SizeOf(typeof(ObjectAttributes)),RootDirectory=root.DangerousGetHandle(),ObjectName=pointer,Attributes=ObjCaseInsensitive};
      IoStatusBlock io; SafeFileHandle result; uint createOptions=FileSynchronous|OpenReparsePoint|options|(directory?FileDirectory:FileNonDirectory);
      int status=NtCreateFile(out result,access|Synchronize,ref attributes,out io,IntPtr.Zero,FileAttributeNormal,share,disposition,createOptions,IntPtr.Zero,0);
      if(status<0) FailNt(status); AssertPlain(result); return result;
    } finally { if(pointer!=IntPtr.Zero) Marshal.FreeHGlobal(pointer); if(text!=IntPtr.Zero) Marshal.FreeHGlobal(text); }
  }
  static SafeFileHandle Duplicate(SafeFileHandle file) {
    SafeFileHandle copy; IntPtr process=GetCurrentProcess(); if(!DuplicateHandle(process,file,process,out copy,0,false,2)) throw new Win32Exception(Marshal.GetLastWin32Error()); return copy;
  }
  static SafeFileHandle OpenRoot(string configuredRoot,List<SafeFileHandle> opened) {
    string full=Path.GetFullPath(configuredRoot); if(!Path.IsPathRooted(full)||full.StartsWith("\\\\")) throw new Failure("INVALID_ROOT");
    string volume=Path.GetPathRoot(full); if(volume==null||volume.Length!=3||volume[1]!=':') throw new Failure("INVALID_ROOT");
    uint access=FileTraverse|FileListDirectory|FileReadAttributes;
    Stage="VOLUME"; SafeFileHandle current=CreateFile(volume,(FileTraverse|FileReadAttributes)|Synchronize,ShareAll,IntPtr.Zero,OpenExisting,BackupSemantics|OpenReparsePoint,IntPtr.Zero);
    if(current.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error()); opened.Add(current); AssertPlain(current);
    Stage="ROOT"; foreach(string part in full.Substring(volume.Length).Split(new[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries)) { SafeFileHandle next=OpenRelative(current,part,true,FileOpenIf,access,0,ShareReadWrite); opened.Add(next); current=next; }
    return current;
  }
  static string Encode(string value) { byte[] bytes=Encoding.UTF8.GetBytes(value); return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_'); }
  static string Decode(string value) { string padded=value.Replace('-','+').Replace('_','/'); padded+=new string('=',(4-padded.Length%4)%4); return Encoding.UTF8.GetString(Convert.FromBase64String(padded)); }
  static string Hex(byte[] bytes) { StringBuilder text=new StringBuilder(bytes.Length*2); foreach(byte b in bytes) text.Append(b.ToString("x2")); return text.ToString(); }
  static string KindDirectory(string kind) { if(kind=="note") return "notes"; if(kind=="album"||kind=="photo-page"||kind=="photo"||kind=="album-photo") return "albums"; throw new Failure("INVALID_KIND"); }
  static string KindToken(string kind) { if(kind=="note") return "n"; if(kind=="album") return "a"; if(kind=="photo-page") return "p"; if(kind=="photo"||kind=="album-photo") return "f"; throw new Failure("INVALID_KIND"); }
  static string ResourceKey(Request request) {
    if(String.IsNullOrEmpty(request.resourceId)||Encoding.UTF8.GetByteCount(request.resourceId)>96) throw new Failure("INVALID_RESOURCE_ID");
    return KindToken(request.kind)+"_"+Encode(request.resourceId);
  }
  static bool ValidResourceKey(string key,string kind) {
    try {
      string token=KindToken(kind); if(String.IsNullOrEmpty(key)||!key.StartsWith(token+"_",StringComparison.Ordinal)) return false;
      string encoded=key.Substring(token.Length+1); if(encoded.Length<1||encoded.Length>128||!System.Text.RegularExpressions.Regex.IsMatch(encoded,"^[A-Za-z0-9_-]+$")) return false;
      string padded=encoded.Replace('-','+').Replace('_','/'); padded+=new string('=',(4-padded.Length%4)%4);
      string resourceId=new UTF8Encoding(false,true).GetString(Convert.FromBase64String(padded));
      return resourceId.Length>0&&Encoding.UTF8.GetByteCount(resourceId)<=96&&Encode(resourceId)==encoded;
    } catch { return false; }
  }
  static bool CanonicalSavedAt(string value) {
    DateTime parsed; const string format="yyyy-MM-dd'T'HH:mm:ss.fff'Z'";
    return !String.IsNullOrEmpty(value)&&DateTime.TryParseExact(value,format,CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal|DateTimeStyles.AdjustToUniversal,out parsed)&&parsed.ToString(format,CultureInfo.InvariantCulture)==value;
  }
  static SafeFileHandle OpenChat(SafeFileHandle root,Request request,List<SafeFileHandle> opened) {
    if(request.chatSegments==null||request.chatSegments.Length<2||request.chatSegments.Length>8) throw new Failure("INVALID_CHAT");
    SafeFileHandle current=root;
    Stage="CHAT"; for(int i=0;i<request.chatSegments.Length;i++) { uint access=FileTraverse|FileListDirectory|FileReadAttributes; if(i==request.chatSegments.Length-1) access|=FileAddFile|FileAddSubdirectory; SafeFileHandle next=OpenRelative(current,request.chatSegments[i],true,FileOpen,access,0,ShareReadWrite); opened.Add(next); current=next; }
    ByHandleInfo info; if(!GetFileInformationByHandle(current,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    ulong id=((ulong)info.FileIndexHigh<<32)|info.FileIndexLow;
    if(info.VolumeSerialNumber.ToString()!=request.volumeSerial||id.ToString("x16")!=request.fileId) throw new Failure("CHAT_IDENTITY_CHANGED");
    Stage="RESOURCE_DIRECTORY";
    uint resourceAccess=FileTraverse|FileListDirectory|FileReadAttributes|FileAddFile; if(request.kind=="album-photo") resourceAccess|=FileAddSubdirectory;
    try { SafeFileHandle directory=OpenRelative(current,KindDirectory(request.kind),true,(request.op=="stage"||request.op=="album-open")?FileOpenIf:FileOpen,resourceAccess,0,ShareReadWrite); opened.Add(directory);
      if(request.kind!="album-photo") return directory;
      if(!System.Text.RegularExpressions.Regex.IsMatch(request.albumKey??"", "^[0-9a-f]{64}$")) throw new Failure("INVALID_ALBUM_KEY");
      try { SafeFileHandle album=OpenRelative(directory,request.albumKey,true,(request.op=="stage"||request.op=="album-open")?FileOpenIf:FileOpen,FileTraverse|FileListDirectory|FileReadAttributes|FileAddFile,0,ShareReadWrite); opened.Add(album); return album; }
      catch(Win32Exception error) { if((request.op=="read"||request.op=="list"||request.op=="contains")&&error.NativeErrorCode==2) return null; throw; }
    }
    catch(Win32Exception error) { if((request.op=="read"||request.op=="list"||request.op=="contains")&&error.NativeErrorCode==2) return null; throw; }
  }
  static byte[] ReadExact(Stream stream,int count) { byte[] value=new byte[count]; int offset=0; while(offset<count) { int read=stream.Read(value,offset,count-offset); if(read==0) throw new Failure("TRUNCATED_FRAME"); offset+=read; } return value; }
  static uint ReadLength(Stream stream) { byte[] bytes=ReadExact(stream,4); return (uint)(bytes[0]|bytes[1]<<8|bytes[2]<<16|bytes[3]<<24); }
  static byte[] ReadFrame(Stream stream,int maximum) { uint size=ReadLength(stream); if(size>maximum) throw new Failure("FRAME_TOO_LARGE"); return ReadExact(stream,(int)size); }
  static Request ReadRequest(Stream input) {
    byte[] header=ReadFrame(input,MaxHeader); using(MemoryStream data=new MemoryStream(header)) { Request request=(Request)new DataContractJsonSerializer(typeof(Request)).ReadObject(data); if(request==null||request.protocol!=Protocol||String.IsNullOrEmpty(request.requestId)) throw new Failure("PROTOCOL_ERROR"); return request; }
  }
  static void WriteFrame(Stream output,byte[] value) { byte[] length=BitConverter.GetBytes((uint)value.Length); output.Write(length,0,4); if(value.Length>0) output.Write(value,0,value.Length); output.Flush(); }
  static void WriteResult(Stream output,Result result,byte[] payload) {
    using(MemoryStream data=new MemoryStream()) { new DataContractJsonSerializer(typeof(Result)).WriteObject(data,result); WriteFrame(output,data.ToArray()); }
    WriteFrame(output,payload??new byte[0]);
  }
  static void WriteError(Stream output,string requestId,string code) {
    using(MemoryStream data=new MemoryStream()) { new DataContractJsonSerializer(typeof(ErrorResult)).WriteObject(data,new ErrorResult{requestId=requestId,code=code}); WriteFrame(output,data.ToArray()); }
    WriteFrame(output,new byte[0]);
  }
  static void Enumerate(SafeFileHandle directory,Action<FileItem> visit) {
    Stage="ENUMERATE"; int count=0; IntPtr memory=Marshal.AllocHGlobal(65536); bool restart=true;
    try {
    while(true) {
      IoStatusBlock io; int status=NtQueryDirectoryFile(directory,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out io,memory,65536,1,false,IntPtr.Zero,restart); restart=false;
      if(status==StatusNoMoreFiles) break; if(status<0) throw new Failure("ENUM_NT_"+unchecked((uint)status).ToString("x8"));
      int bytes=io.Information.ToInt32(); int offset=0; bool any=false;
      while(true) {
        if(offset>=bytes) break; int next=Marshal.ReadInt32(memory,offset); uint attr=unchecked((uint)Marshal.ReadInt32(memory,offset+56)); uint nameLength=unchecked((uint)Marshal.ReadInt32(memory,offset+60));
        if(nameLength>0&&nameLength<=65534&&offset+64+nameLength<=bytes) { byte[] name=new byte[(int)nameLength]; Marshal.Copy(IntPtr.Add(memory,offset+64),name,0,(int)nameLength); if(++count>MaxEntries) throw new Failure("ENTRY_LIMIT"); visit(new FileItem{name=Encoding.Unicode.GetString(name),attributes=attr}); any=true; }
        if(next<=0) break; offset+=next;
      }
      if(!any) break;
    }
    Stage="ENUMERATE_DONE";
    } finally { Marshal.FreeHGlobal(memory); }
  }
  static bool IsKey(string key) { return key.Length>=3&&key.Length<=700&&key.IndexOfAny(new[]{'\\','/',':','.'})<0; }
  static string FileSavedAt(string value) { DateTime parsed; return DateTime.TryParseExact(value,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal|DateTimeStyles.AdjustToUniversal,out parsed)?parsed.ToString("yyyyMMdd'T'HHmmssfff'Z'",CultureInfo.InvariantCulture):null; }
  static string SavedAtFromFile(string value) { DateTime parsed; return DateTime.TryParseExact(value,"yyyyMMdd'T'HHmmssfff'Z'",CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal|DateTimeStyles.AdjustToUniversal,out parsed)?parsed.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture):null; }
  static string PayloadExtension(string kind,byte[] content) {
    try {
      if(kind=="note") { new UTF8Encoding(false,true).GetString(content); return "md"; }
      if(kind=="album"||kind=="photo-page") { byte[] utf8=content; new UTF8Encoding(false,true).GetString(utf8); using(XmlDictionaryReader reader=JsonReaderWriterFactory.CreateJsonReader(utf8,XmlDictionaryReaderQuotas.Max)) { XmlDocument doc=new XmlDocument(); doc.Load(reader); } return "json"; }
      if((kind!="photo"&&kind!="album-photo")||content.Length<12) throw new Failure("UNSUPPORTED_MEDIA");
      if(content[0]==0xff&&content[1]==0xd8&&content[2]==0xff) return "jpg";
      if(content[0]==0x89&&content[1]==0x50&&content[2]==0x4e&&content[3]==0x47&&content[4]==0x0d&&content[5]==0x0a&&content[6]==0x1a&&content[7]==0x0a) return "png";
      if(content[0]==0x47&&content[1]==0x49&&content[2]==0x46&&content[3]==0x38&&(content[4]==0x37||content[4]==0x39)&&content[5]==0x61) return "gif";
      if(content[0]==0x52&&content[1]==0x49&&content[2]==0x46&&content[3]==0x46&&content[8]==0x57&&content[9]==0x45&&content[10]==0x42&&content[11]==0x50) return "webp";
    } catch { throw new Failure(kind=="photo"?"UNSUPPORTED_MEDIA":"INVALID_TEXT_PAYLOAD"); }
    throw new Failure("UNSUPPORTED_MEDIA");
  }
  static bool ValidPayload(string kind,string extension,byte[] content) { try { return PayloadExtension(kind,content)==extension; } catch { return false; } }
  static string RecordName(string key,long revision,string savedAt,string hash,string extension) { return "record_"+key+"_"+revision.ToString("D20")+"_"+FileSavedAt(savedAt)+"_"+hash+"."+extension; }
  static Commit ReadRecord(SafeFileHandle directory,string name,out byte[] payload,out string identity) {
    payload=null; identity=null; System.Text.RegularExpressions.Match match=System.Text.RegularExpressions.Regex.Match(name,"^record_([napf]_[A-Za-z0-9_-]+)_([0-9]{20})_([0-9]{8}T[0-9]{9}Z)_([0-9a-f]{64})\\.(md|json|jpg|png|webp|gif)$");
    if(!match.Success) return null; string key=match.Groups[1].Value; string extension=match.Groups[5].Value; long revision; if(!Int64.TryParse(match.Groups[2].Value,out revision)||revision<1||!IsKey(key)) return null;
    string kind=key.StartsWith("n_",StringComparison.Ordinal)?"note":key.StartsWith("a_",StringComparison.Ordinal)?"album":key.StartsWith("p_",StringComparison.Ordinal)?"photo-page":"photo";
    if(!ValidResourceKey(key,kind)) return null; string savedAt=SavedAtFromFile(match.Groups[3].Value); if(savedAt==null) return null;
    using(SafeFileHandle file=OpenRelative(directory,name,false,FileOpen,GenericRead,0,ShareRead)) {
      identity=HandleIdentity(file); ByHandleInfo info; if(!GetFileInformationByHandle(file,out info)) throw new Win32Exception(Marshal.GetLastWin32Error()); long length=((long)info.FileSizeHigh<<32)|info.FileSizeLow; if(length<0||length>MaxPayload) return null;
      payload=new byte[(int)length]; using(FileStream input=new FileStream(Duplicate(file),FileAccess.Read,65536,false)) { int offset=0; while(offset<payload.Length) { int count=input.Read(payload,offset,payload.Length-offset); if(count==0) return null; offset+=count; } }
    }
    string hash; using(SHA256 sha=SHA256.Create()) hash=Hex(sha.ComputeHash(payload)); if(hash!=match.Groups[4].Value||!ValidPayload(kind,extension,payload)) return null;
    return new Commit{kind=kind,resourceKey=key,revision=revision,savedAt=savedAt,contentHash=hash,byteLength=payload.Length};
  }
  static string HandleIdentity(SafeFileHandle file) {
    ByHandleInfo info; if(!GetFileInformationByHandle(file,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    ulong id=((ulong)info.FileIndexHigh<<32)|info.FileIndexLow; return info.VolumeSerialNumber.ToString("x8")+":"+id.ToString("x16");
  }
  static byte[] ReadRecordFromHandle(SafeFileHandle file) {
    ByHandleInfo info; if(!GetFileInformationByHandle(file,out info)) throw new Win32Exception(Marshal.GetLastWin32Error()); long length=((long)info.FileSizeHigh<<32)|info.FileSizeLow; if(length<0||length>MaxPayload) return null;
    byte[] payload=new byte[(int)length]; using(FileStream input=new FileStream(Duplicate(file),FileAccess.Read,65536,false)) { input.Position=0; int offset=0; while(offset<payload.Length) { int count=input.Read(payload,offset,payload.Length-offset); if(count==0) return null; offset+=count; } }
    return payload;
  }
  static List<CommitItem> ValidCommits(SafeFileHandle directory,string onlyKey) {
    Dictionary<string,List<CommitItem>> groups=new Dictionary<string,List<CommitItem>>();
    Enumerate(directory,item=>{
      if((item.attributes&FileAttributeReparsePoint)!=0||!item.name.StartsWith("record_",StringComparison.Ordinal)) return;
      System.Text.RegularExpressions.Match match=System.Text.RegularExpressions.Regex.Match(item.name,"^record_([napf]_[A-Za-z0-9_-]+)_([0-9]{20})_"); if(!match.Success) return; string key=match.Groups[1].Value; long filenameRevision; if(!Int64.TryParse(match.Groups[2].Value,out filenameRevision)||(onlyKey!=null&&key!=onlyKey)) return;
      try {
        byte[] payload; string identity; Commit commit=ReadRecord(directory,item.name,out payload,out identity); if(commit==null||commit.resourceKey!=key||commit.revision!=filenameRevision) return;
        if(!groups.ContainsKey(key)) groups[key]=new List<CommitItem>(); groups[key].Add(new CommitItem{commit=commit,record=item.name,identity=identity});
      } catch { /* Invalid generated candidates are ignored and never selected. */ }
    });
    List<CommitItem> result=new List<CommitItem>(); foreach(List<CommitItem> items in groups.Values) { items.Sort((a,b)=>a.commit.revision.CompareTo(b.commit.revision)); result.AddRange(items); }
    return result;
  }
  static int LinkNoReplace(SafeFileHandle staging,SafeFileHandle directory,string target) {
    byte[] name=Encoding.Unicode.GetBytes(target); int handleOffset=IntPtr.Size==8?8:4,lengthOffset=handleOffset+IntPtr.Size,nameOffset=lengthOffset+4; IntPtr value=Marshal.AllocHGlobal(nameOffset+name.Length);
    try { for(int i=0;i<nameOffset;i++) Marshal.WriteByte(value,i,0); Marshal.WriteIntPtr(value,handleOffset,directory.DangerousGetHandle()); Marshal.WriteInt32(value,lengthOffset,name.Length); Marshal.Copy(name,0,IntPtr.Add(value,nameOffset),name.Length); IoStatusBlock io; return NtSetInformationFile(staging,out io,value,(uint)(nameOffset+name.Length),11); }
    finally { Marshal.FreeHGlobal(value); }
  }
  static byte[] ReadPayload(Stream input) {
    MemoryStream data=new MemoryStream(); while(true) { uint size=ReadLength(input); if(size==0) break; if(size>1024*1024||data.Length+size>MaxPayload) throw new Failure("PAYLOAD_LIMIT"); byte[] chunk=ReadExact(input,(int)size); data.Write(chunk,0,chunk.Length); } return data.ToArray();
  }
  static Entry ToEntry(Commit commit) { return new Entry{resourceId=Decode(commit.resourceKey.Substring(2)),revision=commit.revision,savedAt=commit.savedAt,contentHash=commit.contentHash,byteLength=commit.byteLength}; }
  static Result Handle(SafeFileHandle root,Stream input,Request request,out byte[] payload) {
    payload=null; List<SafeFileHandle> opened=new List<SafeFileHandle>(); bool keepOpened=false;
    try {
      string key=String.IsNullOrEmpty(request.resourceId)?null:ResourceKey(request);
      if(request.op!="list"&&request.op!="album-open"&&key==null) throw new Failure("INVALID_RESOURCE_ID");
      SafeFileHandle directory=OpenChat(root,request,opened);
      if(directory==null) {
        if(request.op=="read"||request.op=="contains") return new Result{requestId=request.requestId,ok=true,revision=0,payloadLength=0};
        if(request.op=="list") return new Result{requestId=request.requestId,ok=true,items=new Entry[0],nextCursor=""};
        throw new Failure("RESOURCE_DIRECTORY_MISSING");
      }
      if(request.op=="album-open") return new Result{requestId=request.requestId,ok=true};
      List<CommitItem> commits=ValidCommits(directory,key); CommitItem latest=commits.Count==0?null:commits[commits.Count-1];
      if(request.op=="contains") return new Result{requestId=request.requestId,ok=true,revision=latest==null?0:latest.commit.revision,
        folderName=latest==null?"":request.albumKey,fileName=latest==null?"":latest.record,
        savedAt=latest==null?"":latest.commit.savedAt,contentHash=latest==null?"":latest.commit.contentHash,byteLength=latest==null?0:latest.commit.byteLength};
      if(request.op=="stage") {
        if(pendingCommit!=null) throw new Failure("STAGE_BUSY");
        PauseBoundary("stage-open");
        byte[] content=ReadPayload(input); if(content.Length>MaxPayload) throw new Failure("PAYLOAD_LIMIT");
        long revision=latest==null?1:latest.commit.revision+1; if(revision<1) throw new Failure("REVISION_LIMIT");
        string savedAt=DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture); string hash; using(SHA256 sha=SHA256.Create()) hash=Hex(sha.ComputeHash(content));
        if(latest!=null&&latest.commit.contentHash==hash&&latest.commit.byteLength==content.Length) return new Result{requestId=request.requestId,ok=true,unchanged=true,revision=latest.commit.revision,savedAt=latest.commit.savedAt,contentHash=latest.commit.contentHash,byteLength=latest.commit.byteLength,
          folderName=request.kind=="album-photo"?request.albumKey:"",fileName=request.kind=="album-photo"?latest.record:""};
        Commit marker=new Commit{kind=request.kind,resourceKey=key,revision=revision,savedAt=savedAt,contentHash=hash,byteLength=content.Length};
        string extension=PayloadExtension(request.kind,content); string staging="."+Guid.NewGuid().ToString("N")+".part";
        SafeFileHandle temporary=OpenRelative(directory,staging,false,FileCreate,GenericRead|GenericWrite|Delete,FileDeleteOnClose,0x5);
        try { using(SafeFileHandle copy=Duplicate(temporary)) using(FileStream output=new FileStream(copy,FileAccess.Write,65536,false)) { output.Write(content,0,content.Length); output.Flush(); } if(!FlushFileBuffers(temporary)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        catch { temporary.Dispose(); throw; }
        string target=RecordName(key,revision,savedAt,hash,extension); string ticket=Guid.NewGuid().ToString("N"); pendingCommit=new PendingCommit{id=ticket,key=key,kind=request.kind,record=target,previousRevision=latest==null?0:latest.commit.revision,commit=marker,staging=temporary,ancestry=opened}; keepOpened=true;
        return new Result{requestId=request.requestId,ok=true,stageId=ticket,revision=revision,savedAt=savedAt,contentHash=hash,byteLength=content.Length};
      }
      if(request.op=="commit") {
        PendingCommit candidate=pendingCommit;
        if(candidate==null||candidate.id!=request.stageId||candidate.key!=key||candidate.kind!=request.kind) throw new Failure("STAGE_EXPIRED");
        List<CommitItem> current=ValidCommits(directory,key); long currentRevision=current.Count==0?0:current[current.Count-1].commit.revision;
        if(currentRevision!=candidate.previousRevision) { pendingCommit=null; throw new Failure("REVISION_CHANGED"); }
        byte[] staged=ReadRecordFromHandle(candidate.staging); string stagedHash; using(SHA256 sha=SHA256.Create()) stagedHash=Hex(sha.ComputeHash(staged??new byte[0]));
        if(staged==null||stagedHash!=candidate.commit.contentHash||!ValidPayload(candidate.kind,Path.GetExtension(candidate.record).Substring(1),staged)) throw new Failure("STAGED_RECORD_INVALID");
        PauseBoundary("commit-link",candidate.record); Stage="PUBLISH_RECORD"; int linkStatus=LinkNoReplace(candidate.staging,directory,candidate.record); if(linkStatus<0&&linkStatus!=StatusNameCollision&&linkStatus!=StatusNameExists) FailNt(linkStatus); if(linkStatus==StatusNameCollision||linkStatus==StatusNameExists) throw new Failure("NO_REPLACE_CONFLICT");
        // Like AttachmentBroker, the staging name stays delete-on-close while
        // the final hard link survives closing this handle.
        candidate.staging.Dispose(); pendingCommit=null; DisposeHandles(candidate.ancestry);
        return new Result{requestId=request.requestId,ok=true,revision=candidate.commit.revision,savedAt=candidate.commit.savedAt,contentHash=candidate.commit.contentHash,byteLength=candidate.commit.byteLength,
          folderName=request.kind=="album-photo"?request.albumKey:"",fileName=request.kind=="album-photo"?candidate.record:""};
      }
      if(request.op=="read") {
        if(latest==null) return new Result{requestId=request.requestId,ok=true,revision=0,payloadLength=0};
        PauseBoundary("read-open");
        string readIdentity; Commit verifiedRead=ReadRecord(directory,latest.record,out payload,out readIdentity); if(verifiedRead==null||verifiedRead.revision!=latest.commit.revision||readIdentity!=latest.identity) throw new Failure("CONTENT_INVALID");
        return new Result{requestId=request.requestId,ok=true,revision=latest.commit.revision,savedAt=latest.commit.savedAt,contentHash=latest.commit.contentHash,byteLength=latest.commit.byteLength,payloadLength=payload.Length,
          folderName=request.kind=="album-photo"?request.albumKey:"",fileName=request.kind=="album-photo"?latest.record:""};
      }
      if(request.op=="list") {
        PauseBoundary("list-open");
        if(request.limit<1||request.limit>50) throw new Failure("INVALID_LIMIT");
        string prefix=KindToken(request.kind)+"_";
        string after=request.cursor==""?"":Decode(request.cursor); Dictionary<string,Commit> latestByKey=new Dictionary<string,Commit>();
        foreach(CommitItem item in ValidCommits(directory,null)) { if(!item.commit.resourceKey.StartsWith(prefix,StringComparison.Ordinal)) continue; Commit current; if(!latestByKey.TryGetValue(item.commit.resourceKey,out current)||current.revision<item.commit.revision) latestByKey[item.commit.resourceKey]=item.commit; }
        List<string> keys=new List<string>(latestByKey.Keys); keys.Sort(StringComparer.Ordinal); List<Entry> page=new List<Entry>(); string last="";
        foreach(string resourceKey in keys) { if(String.Compare(resourceKey,after,StringComparison.Ordinal)<=0) continue; page.Add(ToEntry(latestByKey[resourceKey])); last=resourceKey; if(page.Count==request.limit) break; }
        bool more=false; foreach(string resourceKey in keys) if(String.Compare(resourceKey,last,StringComparison.Ordinal)>0&&last!="") { more=true; break; }
        return new Result{requestId=request.requestId,ok=true,items=page.ToArray(),nextCursor=more?Encode(last):""};
      }
      throw new Failure("INVALID_OPERATION");
    } finally { if(!keepOpened) DisposeHandles(opened); }
  }
  static void DisposeHandles(List<SafeFileHandle> handles) { if(handles==null) return; for(int i=handles.Count-1;i>=0;i--) try { handles[i].Dispose(); } catch { } }
  public static int Main(string[] args) {
    if(args.Length==1&&args[0]=="--version") { Console.Out.WriteLine("{\"protocol\":\""+Protocol+"\",\"version\":\"1.0.0\",\"rootHandleAnchored\":true,\"rejectsReparsePoints\":true,\"publishNoReplace\":true,\"persistent\":true}"); return 0; }
    if(args.Length!=2||args[0]!="--stdio-v1") return 2;
    List<SafeFileHandle> opened=new List<SafeFileHandle>();
    try {
      SafeFileHandle root=OpenRoot(args[1],opened); Stream input=Console.OpenStandardInput(),output=Console.OpenStandardOutput();
      while(true) {
        Request request;
        try { request=ReadRequest(input); } catch(EndOfStreamException) { return 0; }
        try { byte[] payload; Result result=Handle(root,input,request,out payload); if(payload!=null) result.payloadLength=payload.Length; WriteResult(output,result,payload); }
        catch(Failure error) { WriteError(output,request.requestId,error.Code); }
        catch(Win32Exception error) { WriteError(output,request.requestId,"WIN32_"+Stage+"_"+error.NativeErrorCode); }
        catch { WriteError(output,request.requestId,"ARCHIVE_FAILURE"); }
      }
    } catch { return 3; }
    finally { for(int i=opened.Count-1;i>=0;i--) opened[i].Dispose(); }
  }
}
