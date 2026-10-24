using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class IdentityProbe {
  [StructLayout(LayoutKind.Sequential)] struct ByHandleInfo {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out ByHandleInfo info);
  static int Main(string[] args) {
    if(args.Length!=1) return 2;
    using(SafeFileHandle handle=CreateFile(args[0],0x80,7,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero)) {
      if(handle.IsInvalid) return 3;
      ByHandleInfo info; if(!GetFileInformationByHandle(handle,out info)) return 4;
      ulong id=((ulong)info.FileIndexHigh<<32)|info.FileIndexLow;
      Console.Out.WriteLine("{\"volumeSerial\":\""+info.VolumeSerialNumber.ToString()+"\",\"fileId\":\""+id.ToString("x16")+"\"}");
      return 0;
    }
  }
}
