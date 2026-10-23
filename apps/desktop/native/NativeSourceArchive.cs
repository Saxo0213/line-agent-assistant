using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

internal sealed class NativeSourceCell {
  internal readonly int SqliteType;
  internal readonly long IntegerValue;
  internal readonly double RealValue;
  byte[] bytes;
  static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

  internal NativeSourceCell(int type, long integerValue, double realValue, byte[] rawBytes) {
    SqliteType = type; IntegerValue = integerValue; RealValue = realValue; bytes = rawBytes ?? new byte[0];
  }

  internal object ProjectionValue() {
    switch (SqliteType) {
      case 1: return IntegerValue;
      case 2: return RealValue;
      case 3: return DecodeProjectionText();
      case 5: return null;
      default: return null;
    }
  }

  internal string ProjectionText() {
    if (SqliteType == 5) return null;
    if (SqliteType != 3) throw new InvalidOperationException("SOURCE_ROW_INVALID");
    return DecodeProjectionText();
  }

  internal object OptionalJsonProjection() {
    if (SqliteType == 5) return null;
    if (SqliteType == 3) {
      try { return StrictUtf8.GetString(bytes); }
      catch (DecoderFallbackException) { return null; }
    }
    return null;
  }

  // Attachment metadata projection accepts the native TEXT or BLOB storage
  // variants only when the complete bytes are valid UTF-8 JSON. Archival
  // SourceJsonValue remains type preserving and unchanged.
  internal object OptionalAttachmentJsonProjection() {
    if (SqliteType != 3 && SqliteType != 4) return null;
    try { return StrictUtf8.GetString(bytes); }
    catch (DecoderFallbackException) { return null; }
  }

  internal long? ProjectionInt64() {
    if (SqliteType == 5) return null;
    if (SqliteType != 1) throw new InvalidOperationException("SOURCE_ROW_INVALID");
    return IntegerValue;
  }

  string DecodeProjectionText() {
    string text = Encoding.UTF8.GetString(bytes);
    return text.IndexOf('\0') < 0 ? text : text.Replace('\0', '\ufffd');
  }

  internal object SourceJsonValue() {
    switch (SqliteType) {
      case 5: return null;
      case 1: return new Dictionary<string, object> {
        { "sqliteType", "integer" }, { "value", IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture) }
      };
      case 2: return new Dictionary<string, object> {
        { "sqliteType", "real" }, { "encoding", "ieee754-be" }, { "data", Hex(RealBytes(RealValue)) }
      };
      case 3:
        try {
          string text = StrictUtf8.GetString(bytes);
          if (text.IndexOf('\0') < 0) return text;
        } catch (DecoderFallbackException) { }
        return new Dictionary<string, object> { { "sqliteType", "text" }, { "encoding", "base64" }, { "data", Convert.ToBase64String(bytes) } };
      case 4:
        return new Dictionary<string, object> { { "sqliteType", "blob" }, { "encoding", "base64" }, { "data", Convert.ToBase64String(bytes) } };
      default: throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
    }
  }

  internal void AppendDigest(Stream stream) {
    stream.WriteByte((byte)SqliteType);
    byte[] value = DigestValueBytes();
    try { WriteUInt32BigEndian(stream, checked((uint)value.Length)); stream.Write(value, 0, value.Length); }
    finally { Array.Clear(value, 0, value.Length); }
  }

  byte[] DigestValueBytes() {
    if (SqliteType == 5) return new byte[0];
    if (SqliteType == 1) return Int64Bytes(IntegerValue);
    if (SqliteType == 2) return RealBytes(RealValue);
    if (SqliteType == 3 || SqliteType == 4) return (byte[])bytes.Clone();
    throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
  }

  internal void Clear() { Array.Clear(bytes, 0, bytes.Length); bytes = new byte[0]; }

  internal static void WriteUInt32BigEndian(Stream stream, uint value) {
    stream.WriteByte((byte)(value >> 24)); stream.WriteByte((byte)(value >> 16));
    stream.WriteByte((byte)(value >> 8)); stream.WriteByte((byte)value);
  }
  internal static byte[] Int64Bytes(long value) {
    byte[] bytes = BitConverter.GetBytes(value);
    if (BitConverter.IsLittleEndian) Array.Reverse(bytes);
    return bytes;
  }
  internal static byte[] RealBytes(double value) {
    byte[] bytes = BitConverter.GetBytes(BitConverter.DoubleToInt64Bits(value));
    if (BitConverter.IsLittleEndian) Array.Reverse(bytes);
    return bytes;
  }
  internal static string Hex(byte[] bytes) {
    StringBuilder result = new StringBuilder(bytes.Length * 2);
    foreach (byte value in bytes) result.Append(value.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
    return result.ToString();
  }
}

internal sealed class NativeSourceRow {
  internal readonly string TableName;
  internal readonly string[] ColumnNames;
  internal readonly NativeSourceCell[] Cells;
  readonly Dictionary<string, int> indexes;

  internal NativeSourceRow(string tableName, string[] columns, NativeSourceCell[] values) {
    if (String.IsNullOrEmpty(tableName) || columns == null || values == null || columns.Length != values.Length)
      throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
    TableName = tableName; ColumnNames = columns; Cells = values;
    indexes = new Dictionary<string, int>(StringComparer.Ordinal);
    for (int i = 0; i < columns.Length; i++) {
      if (String.IsNullOrEmpty(columns[i]) || columns[i].Length > 128 || indexes.ContainsKey(columns[i]))
        throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
      indexes.Add(columns[i], i);
    }
  }

  internal NativeSourceCell Cell(string column) {
    int index;
    if (!indexes.TryGetValue(column, out index)) throw new InvalidOperationException("SOURCE_SCHEMA_UNSUPPORTED");
    return Cells[index];
  }
  internal string Text(string column) { return Cell(column).ProjectionText(); }
  internal long? Int64(string column) { return Cell(column).ProjectionInt64(); }
  internal object OptionalJson(string column) { return Cell(column).OptionalJsonProjection(); }
  internal object OptionalAttachmentJson(string column) { return Cell(column).OptionalAttachmentJsonProjection(); }

  internal string SourceDigest() {
    using (MemoryStream stream = new MemoryStream()) {
      byte[] table = Encoding.UTF8.GetBytes(TableName);
      try { NativeSourceCell.WriteUInt32BigEndian(stream, checked((uint)table.Length)); stream.Write(table, 0, table.Length); }
      finally { Array.Clear(table, 0, table.Length); }
      NativeSourceCell.WriteUInt32BigEndian(stream, checked((uint)ColumnNames.Length));
      for (int i = 0; i < ColumnNames.Length; i++) {
        byte[] name = Encoding.UTF8.GetBytes(ColumnNames[i]);
        try { NativeSourceCell.WriteUInt32BigEndian(stream, checked((uint)name.Length)); stream.Write(name, 0, name.Length); }
        finally { Array.Clear(name, 0, name.Length); }
        Cells[i].AppendDigest(stream);
      }
      byte[] preimage = stream.ToArray();
      try {
        using (SHA256 sha = SHA256.Create()) {
          byte[] digest = sha.ComputeHash(preimage);
          try { return NativeSourceCell.Hex(digest); }
          finally { Array.Clear(digest, 0, digest.Length); }
        }
      } finally { Array.Clear(preimage, 0, preimage.Length); }
    }
  }

  internal string PlainEnvelopeJson() {
    JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue, RecursionLimit = 32 };
    string digest = SourceDigest();
    List<object> cells = new List<object>(Cells.Length);
    for (int i = 0; i < Cells.Length; i++) cells.Add(Cells[i].SourceJsonValue());
    string result = serializer.Serialize(new Dictionary<string, object> {
      { "format", 2 }, { "table", TableName }, { "sourceDigest", digest },
      { "encoding", "plain" }, { "row", new Dictionary<string, object> { { "columns", ColumnNames }, { "cells", cells } } }
    });
    for (int i = 0; i < Cells.Length; i++) Cells[i].Clear();
    return result;
  }

  internal void Clear() {
    for (int i = 0; i < Cells.Length; i++) if (Cells[i] != null) Cells[i].Clear();
  }
}

internal static class NativeCurrentUserProtection {
  const uint CryptProtectUiForbidden = 0x1;
  [StructLayout(LayoutKind.Sequential)] struct DataBlob { internal int Length; internal IntPtr Data; }
  [DllImport("crypt32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CryptProtectData(
    ref DataBlob input, string description, IntPtr entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
  [DllImport("crypt32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CryptUnprotectData(
    ref DataBlob input, out IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  internal static byte[] Protect(byte[] plaintext) { return Transform(plaintext, true); }
  internal static byte[] Unprotect(byte[] ciphertext) { return Transform(ciphertext, false); }

  static byte[] Transform(byte[] inputBytes, bool protect) {
    if (inputBytes == null || inputBytes.Length < 1 || inputBytes.Length > 16 * 1024 * 1024)
      throw new InvalidOperationException("SOURCE_PROTECTION_FAILED");
    IntPtr inputPointer = IntPtr.Zero; DataBlob input = new DataBlob(); DataBlob output = new DataBlob(); IntPtr description = IntPtr.Zero;
    try {
      inputPointer = Marshal.AllocHGlobal(inputBytes.Length);
      Marshal.Copy(inputBytes, 0, inputPointer, inputBytes.Length);
      input.Length = inputBytes.Length; input.Data = inputPointer;
      bool success = protect
        ? CryptProtectData(ref input, "LINE native source row", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, out output)
        : CryptUnprotectData(ref input, out description, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, out output);
      if (!success || output.Data == IntPtr.Zero || output.Length < 1 || output.Length > 16 * 1024 * 1024)
        throw new InvalidOperationException("SOURCE_PROTECTION_FAILED");
      byte[] result = new byte[output.Length]; Marshal.Copy(output.Data, result, 0, result.Length); return result;
    } catch (InvalidOperationException) { throw; }
    catch { throw new InvalidOperationException("SOURCE_PROTECTION_FAILED"); }
    finally {
      if (inputPointer != IntPtr.Zero) {
        byte[] zero = new byte[inputBytes.Length]; Marshal.Copy(zero, 0, inputPointer, zero.Length); Array.Clear(zero, 0, zero.Length);
        Marshal.FreeHGlobal(inputPointer);
      }
      if (output.Data != IntPtr.Zero) {
        byte[] zero = new byte[output.Length];
        try { Marshal.Copy(zero, 0, output.Data, zero.Length); }
        finally { Array.Clear(zero, 0, zero.Length); LocalFree(output.Data); }
      }
      if (description != IntPtr.Zero) LocalFree(description);
    }
  }
}
