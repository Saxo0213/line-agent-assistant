using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

// Bounded decoders and the redaction rule shared by the retained-snapshot analyzer and correlator.
// Nothing here prints or stores decoded values; callers aggregate counts only.
internal sealed class SnapshotJsonNode {
  internal const int JNull = 0, JBool = 1, JNumber = 2, JString = 3, JObject = 4, JArray = 5;
  internal int Type;
  internal bool BoolValue;
  internal bool IsInteger;
  internal long IntValue;
  internal double DoubleValue;
  internal string Text;
  internal List<KeyValuePair<string, SnapshotJsonNode>> Members;
  internal List<SnapshotJsonNode> Items;
  internal string TypeName {
    get {
      switch (Type) {
        case JNull: return "null"; case JBool: return "boolean"; case JNumber: return "number";
        case JString: return "string"; case JObject: return "object"; default: return "array";
      }
    }
  }
}

internal sealed class PbVarint { internal ulong Value; }
internal sealed class PbFixed64 { internal long Bits; }
internal sealed class PbFixed32 { internal int Bits; }

internal static class SnapshotDecode {
  internal const string RedactedKey = "<redacted-key>";
  internal const int MaxDepth = 16;
  internal const int MaxLeaves = 4096;
  internal const int MaxJsonNodes = 200000;
  static readonly Regex MidLike = new Regex("[a-z]?[0-9a-f]{32,}", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

  // A key is reported verbatim only when it cannot be a MID/ID or free text.
  internal static string RedactKey(string key) {
    if (String.IsNullOrEmpty(key) || key.Length > 64 || MidLike.IsMatch(key)) return RedactedKey;
    for (int i = 0; i < key.Length; i++) {
      char c = key[i];
      bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-';
      if (!ok) return RedactedKey;
    }
    return key;
  }

  // Valid UTF-8 check without allocation. hasControl is true for any C0 control other than TAB/LF/CR, or DEL.
  internal static bool Utf8Valid(byte[] b, int offset, int length, out bool hasControl) {
    hasControl = false;
    int i = offset, end = offset + length;
    while (i < end) {
      int c = b[i];
      if (c < 0x80) {
        if ((c < 0x20 && c != 9 && c != 10 && c != 13) || c == 0x7f) hasControl = true;
        i++; continue;
      }
      int need; int min;
      if (c >= 0xc2 && c <= 0xdf) { need = 1; min = 0x80; }
      else if (c >= 0xe0 && c <= 0xef) { need = 2; min = 0x800; }
      else if (c >= 0xf0 && c <= 0xf4) { need = 3; min = 0x10000; }
      else return false;
      int code = c & (0x3f >> need);
      for (int k = 1; k <= need; k++) {
        if (i + k >= end) return false;
        int d = b[i + k];
        if ((d & 0xc0) != 0x80) return false;
        code = (code << 6) | (d & 0x3f);
      }
      if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
      i += need + 1;
    }
    return true;
  }

  // ---------------- JSON ----------------
  internal static SnapshotJsonNode ParseJson(string text) {
    if (text == null) return null;
    try {
      JsonParser parser = new JsonParser(text);
      SnapshotJsonNode root = parser.ParseValue(0);
      parser.SkipWhitespace();
      if (parser.Position != text.Length) return null;
      return root;
    } catch (FormatException) { return null; }
  }

  sealed class JsonParser {
    readonly string s; int i; int nodes;
    internal JsonParser(string text) { s = text; }
    internal int Position { get { return i; } }
    internal void SkipWhitespace() { while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++; }
    internal SnapshotJsonNode ParseValue(int depth) {
      if (depth > MaxDepth || ++nodes > MaxJsonNodes) throw new FormatException();
      SkipWhitespace();
      if (i >= s.Length) throw new FormatException();
      char c = s[i];
      SnapshotJsonNode node = new SnapshotJsonNode();
      if (c == '{') {
        i++; node.Type = SnapshotJsonNode.JObject; node.Members = new List<KeyValuePair<string, SnapshotJsonNode>>();
        SkipWhitespace();
        if (i < s.Length && s[i] == '}') { i++; return node; }
        while (true) {
          SkipWhitespace();
          if (i >= s.Length || s[i] != '"') throw new FormatException();
          string key = ParseString();
          SkipWhitespace();
          if (i >= s.Length || s[i] != ':') throw new FormatException();
          i++;
          SnapshotJsonNode value = ParseValue(depth + 1);
          node.Members.Add(new KeyValuePair<string, SnapshotJsonNode>(key, value));
          SkipWhitespace();
          if (i >= s.Length) throw new FormatException();
          if (s[i] == ',') { i++; continue; }
          if (s[i] == '}') { i++; return node; }
          throw new FormatException();
        }
      }
      if (c == '[') {
        i++; node.Type = SnapshotJsonNode.JArray; node.Items = new List<SnapshotJsonNode>();
        SkipWhitespace();
        if (i < s.Length && s[i] == ']') { i++; return node; }
        while (true) {
          node.Items.Add(ParseValue(depth + 1));
          SkipWhitespace();
          if (i >= s.Length) throw new FormatException();
          if (s[i] == ',') { i++; continue; }
          if (s[i] == ']') { i++; return node; }
          throw new FormatException();
        }
      }
      if (c == '"') { node.Type = SnapshotJsonNode.JString; node.Text = ParseString(); return node; }
      if (c == 't') { Expect("true"); node.Type = SnapshotJsonNode.JBool; node.BoolValue = true; return node; }
      if (c == 'f') { Expect("false"); node.Type = SnapshotJsonNode.JBool; node.BoolValue = false; return node; }
      if (c == 'n') { Expect("null"); node.Type = SnapshotJsonNode.JNull; return node; }
      ParseNumber(node);
      return node;
    }
    void Expect(string word) {
      if (String.CompareOrdinal(s, i, word, 0, word.Length) != 0) throw new FormatException();
      i += word.Length;
    }
    void ParseNumber(SnapshotJsonNode node) {
      int start = i;
      if (i < s.Length && s[i] == '-') i++;
      if (i >= s.Length) throw new FormatException();
      if (s[i] == '0') i++;
      else if (s[i] >= '1' && s[i] <= '9') { while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++; }
      else throw new FormatException();
      bool integer = true;
      if (i < s.Length && s[i] == '.') {
        integer = false; i++;
        int digits = 0; while (i < s.Length && s[i] >= '0' && s[i] <= '9') { i++; digits++; }
        if (digits == 0) throw new FormatException();
      }
      if (i < s.Length && (s[i] == 'e' || s[i] == 'E')) {
        integer = false; i++;
        if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++;
        int digits = 0; while (i < s.Length && s[i] >= '0' && s[i] <= '9') { i++; digits++; }
        if (digits == 0) throw new FormatException();
      }
      string token = s.Substring(start, i - start);
      node.Type = SnapshotJsonNode.JNumber;
      long asLong;
      if (integer && Int64.TryParse(token, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out asLong)) { node.IsInteger = true; node.IntValue = asLong; node.DoubleValue = asLong; return; }
      double asDouble;
      if (!Double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out asDouble) || Double.IsInfinity(asDouble) || Double.IsNaN(asDouble)) throw new FormatException();
      node.DoubleValue = asDouble;
    }
    string ParseString() {
      i++;
      StringBuilder builder = null; int segment = i;
      while (true) {
        if (i >= s.Length) throw new FormatException();
        char c = s[i];
        if (c == '"') {
          string result;
          if (builder == null) result = s.Substring(segment, i - segment);
          else { builder.Append(s, segment, i - segment); result = builder.ToString(); }
          i++; return result;
        }
        if (c < 0x20) throw new FormatException();
        if (c == '\\') {
          if (builder == null) builder = new StringBuilder();
          builder.Append(s, segment, i - segment);
          i++;
          if (i >= s.Length) throw new FormatException();
          char e = s[i++];
          switch (e) {
            case '"': builder.Append('"'); break; case '\\': builder.Append('\\'); break; case '/': builder.Append('/'); break;
            case 'b': builder.Append('\b'); break; case 'f': builder.Append('\f'); break; case 'n': builder.Append('\n'); break;
            case 'r': builder.Append('\r'); break; case 't': builder.Append('\t'); break;
            case 'u':
              if (i + 4 > s.Length) throw new FormatException();
              int code;
              if (!Int32.TryParse(s.Substring(i, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code)) throw new FormatException();
              builder.Append((char)code); i += 4; break;
            default: throw new FormatException();
          }
          segment = i; continue;
        }
        i++;
      }
    }
  }

  // Flattens a parsed JSON tree into (path, scalar) pairs. Object keys are redacted per RedactKey.
  internal static void FlattenJson(SnapshotJsonNode node, string path, List<KeyValuePair<string, object>> leaves) {
    if (node == null || leaves.Count >= MaxLeaves) return;
    switch (node.Type) {
      case SnapshotJsonNode.JObject:
        foreach (KeyValuePair<string, SnapshotJsonNode> member in node.Members) {
          string key = RedactKey(member.Key);
          FlattenJson(member.Value, path.Length == 0 ? key : path + "." + key, leaves);
        }
        break;
      case SnapshotJsonNode.JArray:
        foreach (SnapshotJsonNode item in node.Items) FlattenJson(item, path + "[]", leaves);
        break;
      case SnapshotJsonNode.JString: leaves.Add(new KeyValuePair<string, object>(path.Length == 0 ? "$" : path, node.Text)); break;
      case SnapshotJsonNode.JBool: leaves.Add(new KeyValuePair<string, object>(path.Length == 0 ? "$" : path, node.BoolValue)); break;
      case SnapshotJsonNode.JNumber:
        leaves.Add(new KeyValuePair<string, object>(path.Length == 0 ? "$" : path, node.IsInteger ? (object)node.IntValue : (object)node.DoubleValue)); break;
      default: break;
    }
  }

  internal static bool TryDecodeJson(byte[] data, int length, List<KeyValuePair<string, object>> leaves) {
    bool control;
    if (length < 1 || length > 1024 * 1024 || !Utf8Valid(data, 0, length, out control)) return false;
    string text;
    try { text = new UTF8Encoding(false, true).GetString(data, 0, length); } catch { return false; }
    SnapshotJsonNode root = ParseJson(text);
    if (root == null) return false;
    if (leaves != null) FlattenJson(root, "", leaves);
    return true;
  }

  // ---------------- shared binary reader ----------------
  sealed class Wire {
    internal byte[] B; internal int Pos; internal int End;
    internal int LeafCount; internal List<KeyValuePair<string, object>> Leaves;
    internal bool Collect { get { return Leaves != null; } }
    internal bool Add(string path, object value) {
      if (++LeafCount > MaxLeaves) return false;
      if (Leaves != null) Leaves.Add(new KeyValuePair<string, object>(path, value));
      return true;
    }
    internal bool Varint(out ulong value) {
      value = 0; int shift = 0;
      while (Pos < End && shift < 70) {
        byte b = B[Pos++];
        if (shift < 64) value |= (ulong)(b & 0x7f) << shift;
        if ((b & 0x80) == 0) return true;
        shift += 7;
      }
      return false;
    }
    internal bool Take(int count, out int offset) {
      offset = Pos;
      if (count < 0 || count > End - Pos) return false;
      Pos += count; return true;
    }
    internal object BytesValue(int offset, int count) {
      if (!Collect) return null;
      bool control;
      if (Utf8Valid(B, offset, count, out control)) return Encoding.UTF8.GetString(B, offset, count);
      byte[] copy = new byte[count]; Buffer.BlockCopy(B, offset, copy, 0, count); return copy;
    }
    internal string Sub(string path, string suffix) { return Leaves == null ? null : (path.Length == 0 ? suffix : path + suffix); }
  }

  static long ZigZag(ulong v) { return (long)(v >> 1) ^ -(long)(v & 1); }

  // ---------------- Thrift compact ----------------
  internal static bool TryDecodeThriftCompact(byte[] data, int length, List<KeyValuePair<string, object>> leaves) {
    if (length < 2 || length > 1024 * 1024) return false;
    Wire w = new Wire { B = data, Pos = 0, End = length, Leaves = leaves };
    int fields;
    return CompactStruct(w, "", 0, out fields) && w.Pos == length && fields > 0;
  }
  static bool CompactStruct(Wire w, string path, int depth, out int fields) {
    fields = 0; int last = 0;
    while (true) {
      if (w.Pos >= w.End) return false;
      byte header = w.B[w.Pos++];
      if (header == 0) return true;
      int type = header & 0x0f, delta = header >> 4, id;
      if (type == 0) return false;
      if (delta == 0) {
        ulong z; if (!w.Varint(out z)) return false;
        long signed = ZigZag(z); if (signed < 1 || signed > 32767) return false; id = (int)signed;
      } else { id = last + delta; if (id > 32767) return false; }
      last = id; fields++;
      string p = w.Leaves == null ? null : (path.Length == 0 ? id.ToString(CultureInfo.InvariantCulture) : path + "." + id.ToString(CultureInfo.InvariantCulture));
      if (!CompactValue(w, type, p, depth, false)) return false;
    }
  }
  static bool CompactValue(Wire w, int type, string p, int depth, bool inCollection) {
    int offset; ulong v;
    switch (type) {
      case 1: if (inCollection) { if (w.Pos >= w.End) return false; return w.Add(p, w.B[w.Pos++] == 1); } return w.Add(p, true);
      case 2: if (inCollection) { if (w.Pos >= w.End) return false; return w.Add(p, w.B[w.Pos++] == 1); } return w.Add(p, false);
      case 3: if (w.Pos >= w.End) return false; return w.Add(p, (long)(sbyte)w.B[w.Pos++]);
      case 4: case 5: case 6: if (!w.Varint(out v)) return false; return w.Add(p, ZigZag(v));
      case 7:
        if (!w.Take(8, out offset)) return false;
        return w.Add(p, BitConverter.ToDouble(w.B, offset));
      case 8:
        if (!w.Varint(out v) || v > (ulong)(w.End - w.Pos) || !w.Take((int)v, out offset)) return false;
        return w.Add(p, w.BytesValue(offset, (int)v));
      case 9: case 10: {
        if (depth + 1 > MaxDepth || w.Pos >= w.End) return false;
        byte header = w.B[w.Pos++]; ulong size = (ulong)(header >> 4); int elementType = header & 0x0f;
        if (size == 15 && !w.Varint(out size)) return false;
        if (elementType == 0 || elementType > 12 || size > (ulong)(w.End - w.Pos)) return false;
        string ep = w.Sub(p, "[]");
        for (ulong n = 0; n < size; n++) if (!CompactValue(w, elementType, ep, depth + 1, true)) return false;
        return true;
      }
      case 11: {
        if (depth + 1 > MaxDepth || !w.Varint(out v)) return false;
        if (v == 0) return true;
        if (w.Pos >= w.End || v > (ulong)(w.End - w.Pos)) return false;
        byte kv = w.B[w.Pos++]; int kt = kv >> 4, vt = kv & 0x0f;
        if (kt == 0 || vt == 0 || kt > 12 || vt > 12) return false;
        string kp = w.Sub(p, "{k}"), vp = w.Sub(p, "{v}");
        for (ulong n = 0; n < v; n++) {
          if (!CompactValue(w, kt, kp, depth + 1, true) || !CompactValue(w, vt, vp, depth + 1, true)) return false;
        }
        return true;
      }
      case 12: {
        if (depth + 1 > MaxDepth) return false;
        int nested;
        return CompactStruct(w, p == null ? "" : p, depth + 1, out nested);
      }
      default: return false;
    }
  }

  // ---------------- Thrift binary ----------------
  internal static bool TryDecodeThriftBinary(byte[] data, int length, List<KeyValuePair<string, object>> leaves) {
    if (length < 4 || length > 1024 * 1024) return false;
    Wire w = new Wire { B = data, Pos = 0, End = length, Leaves = leaves };
    int fields;
    return BinaryStruct(w, "", 0, out fields) && w.Pos == length && fields > 0;
  }
  static bool BinI16(Wire w, out int v) { v = 0; int o; if (!w.Take(2, out o)) return false; v = (short)((w.B[o] << 8) | w.B[o + 1]); return true; }
  static bool BinI32(Wire w, out int v) { v = 0; int o; if (!w.Take(4, out o)) return false; v = (w.B[o] << 24) | (w.B[o + 1] << 16) | (w.B[o + 2] << 8) | w.B[o + 3]; return true; }
  static bool BinI64(Wire w, out long v) {
    v = 0; int o; if (!w.Take(8, out o)) return false;
    for (int n = 0; n < 8; n++) v = (v << 8) | w.B[o + n];
    return true;
  }
  static bool BinaryStruct(Wire w, string path, int depth, out int fields) {
    fields = 0;
    while (true) {
      if (w.Pos >= w.End) return false;
      int type = w.B[w.Pos++];
      if (type == 0) return true;
      int id; if (!BinI16(w, out id) || id < 1) return false;
      fields++;
      string p = w.Leaves == null ? null : (path.Length == 0 ? id.ToString(CultureInfo.InvariantCulture) : path + "." + id.ToString(CultureInfo.InvariantCulture));
      if (!BinaryValue(w, type, p, depth)) return false;
    }
  }
  static bool BinaryValue(Wire w, int type, string p, int depth) {
    int i32, offset; long i64;
    switch (type) {
      case 2: if (w.Pos >= w.End) return false; return w.Add(p, w.B[w.Pos++] != 0);
      case 3: if (w.Pos >= w.End) return false; return w.Add(p, (long)(sbyte)w.B[w.Pos++]);
      case 4: if (!BinI64(w, out i64)) return false; return w.Add(p, BitConverter.Int64BitsToDouble(i64));
      case 6: if (!BinI16(w, out i32)) return false; return w.Add(p, (long)i32);
      case 8: if (!BinI32(w, out i32)) return false; return w.Add(p, (long)i32);
      case 10: if (!BinI64(w, out i64)) return false; return w.Add(p, i64);
      case 11:
        if (!BinI32(w, out i32) || i32 < 0 || !w.Take(i32, out offset)) return false;
        return w.Add(p, w.BytesValue(offset, i32));
      case 12: {
        if (depth + 1 > MaxDepth) return false;
        int nested; return BinaryStruct(w, p == null ? "" : p, depth + 1, out nested);
      }
      case 13: {
        if (depth + 1 > MaxDepth || w.End - w.Pos < 6) return false;
        int kt = w.B[w.Pos++], vt = w.B[w.Pos++]; int size;
        if (!BinI32(w, out size) || size < 0 || size > w.End - w.Pos || !BinaryTypeKnown(kt) || !BinaryTypeKnown(vt)) return false;
        string kp = w.Sub(p, "{k}"), vp = w.Sub(p, "{v}");
        for (int n = 0; n < size; n++) if (!BinaryValue(w, kt, kp, depth + 1) || !BinaryValue(w, vt, vp, depth + 1)) return false;
        return true;
      }
      case 14: case 15: {
        if (depth + 1 > MaxDepth || w.End - w.Pos < 5) return false;
        int et = w.B[w.Pos++]; int size;
        if (!BinI32(w, out size) || size < 0 || size > w.End - w.Pos || !BinaryTypeKnown(et)) return false;
        string ep = w.Sub(p, "[]");
        for (int n = 0; n < size; n++) if (!BinaryValue(w, et, ep, depth + 1)) return false;
        return true;
      }
      default: return false;
    }
  }
  static bool BinaryTypeKnown(int t) { return t == 2 || t == 3 || t == 4 || t == 6 || t == 8 || t == 10 || t == 11 || t == 12 || t == 13 || t == 14 || t == 15; }

  // ---------------- protobuf wire format ----------------
  internal static bool TryDecodeProtobuf(byte[] data, int length, List<KeyValuePair<string, object>> leaves) {
    if (length < 2 || length > 1024 * 1024) return false;
    Wire w = new Wire { B = data, Pos = 0, End = length, Leaves = leaves };
    int fields;
    return ProtoMessage(w, "", 0, out fields) && fields > 0;
  }
  static bool ProtoMessage(Wire w, string path, int depth, out int fields) {
    fields = 0;
    while (w.Pos < w.End) {
      ulong tag; if (!w.Varint(out tag)) return false;
      ulong field = tag >> 3; int wire = (int)(tag & 7);
      if (field < 1 || field > 65535) return false;
      fields++;
      string p = w.Leaves == null ? null : (path.Length == 0 ? field.ToString(CultureInfo.InvariantCulture) : path + "." + field.ToString(CultureInfo.InvariantCulture));
      int offset;
      if (wire == 0) { ulong v; if (!w.Varint(out v) || !w.Add(p, new PbVarint { Value = v })) return false; }
      else if (wire == 1) {
        if (!w.Take(8, out offset)) return false;
        if (!w.Add(p, new PbFixed64 { Bits = BitConverter.ToInt64(w.B, offset) })) return false;
      } else if (wire == 5) {
        if (!w.Take(4, out offset)) return false;
        if (!w.Add(p, new PbFixed32 { Bits = BitConverter.ToInt32(w.B, offset) })) return false;
      } else if (wire == 2) {
        ulong size; if (!w.Varint(out size) || size > (ulong)(w.End - w.Pos)) return false;
        int count = (int)size; offset = w.Pos; w.Pos += count;
        bool control; bool text = Utf8Valid(w.B, offset, count, out control) && !control;
        if (text) { if (!w.Add(p, w.BytesValue(offset, count))) return false; continue; }
        bool nested = false;
        if (depth + 1 <= 8 && count > 0) {
          Wire inner = new Wire { B = w.B, Pos = offset, End = offset + count, Leaves = w.Leaves == null ? null : new List<KeyValuePair<string, object>>() };
          int innerFields;
          if (ProtoMessage(inner, p == null ? "" : p, depth + 1, out innerFields) && innerFields > 0) {
            nested = true;
            w.LeafCount += inner.LeafCount;
            if (w.LeafCount > MaxLeaves) return false;
            if (w.Leaves != null) w.Leaves.AddRange(inner.Leaves);
          }
        }
        if (!nested && !w.Add(p, w.BytesValue(offset, count))) return false;
      } else return false;
    }
    return true;
  }

  // ---------------- classification ----------------
  internal const int MaxClassifyBytes = 256 * 1024;

  // Encoding class of one TEXT/BLOB cell from at most MaxClassifyBytes copied bytes.
  internal static string Classify(byte[] data, int copied, int fullLength, out SnapshotJsonNode json) {
    json = null;
    if (fullLength == 0) return "empty";
    if (fullLength > copied) return "oversize";
    int first = 0;
    while (first < copied && (data[first] == ' ' || data[first] == '\t' || data[first] == '\n' || data[first] == '\r')) first++;
    bool control;
    bool utf8 = Utf8Valid(data, 0, copied, out control);
    if (utf8 && first < copied) {
      byte b = data[first];
      bool jsonStart = b == '{' || b == '[' || b == '"' || b == '-' || (b >= '0' && b <= '9') || b == 't' || b == 'f' || b == 'n';
      if (jsonStart) {
        SnapshotJsonNode root = null;
        try { root = ParseJson(new UTF8Encoding(false, true).GetString(data, 0, copied)); } catch { root = null; }
        if (root != null) {
          json = root;
          return root.Type == SnapshotJsonNode.JObject ? "json_object" : root.Type == SnapshotJsonNode.JArray ? "json_array" : "json_other";
        }
      }
    }
    if (utf8 && !control) return "utf8_text";
    if (TryDecodeThriftCompact(data, copied, null)) return "thrift_compact_like";
    if (TryDecodeProtobuf(data, copied, null)) return "protobuf_like";
    if (TryDecodeThriftBinary(data, copied, null)) return "thrift_binary_like";
    return utf8 ? "utf8_text_control" : "binary";
  }

  // ---------------- leaf comparison ----------------
  static bool IsGeoPath(string path) {
    if (path == null) return false;
    int dot = path.LastIndexOf('.');
    string last = (dot >= 0 ? path.Substring(dot + 1) : path).ToLowerInvariant();
    return last == "latitude" || last == "longitude" || last == "lat" || last == "lon" || last == "lng";
  }

  // native is a decoder value; server is string / long / double / bool from the live row.
  internal static bool LeafEquals(object native, object server, string serverPath) {
    bool geo = IsGeoPath(serverPath);
    string s = server as string;
    if (s != null) { string n = native as string; return n != null && String.Equals(n, s, StringComparison.Ordinal); }
    if (server is bool) {
      bool b = (bool)server;
      if (native is bool) return (bool)native == b;
      PbVarint pv = native as PbVarint; return pv != null && (pv.Value == (b ? 1UL : 0UL));
    }
    if (server is long) {
      long l = (long)server;
      if (native is long) return (long)native == l;
      if (native is double) return (double)native == (double)l;
      PbVarint pv = native as PbVarint;
      if (pv != null) return (l >= 0 && pv.Value == (ulong)l) || ZigZag(pv.Value) == l;
      PbFixed64 f64 = native as PbFixed64;
      if (f64 != null) return f64.Bits == l || Int64BitsEquals(f64.Bits, (double)l, false);
      PbFixed32 f32 = native as PbFixed32;
      return f32 != null && (long)f32.Bits == l;
    }
    if (server is double) {
      double d = (double)server;
      if (native is double) return DoubleEquals((double)native, d, geo);
      if (native is long) return DoubleEquals((double)(long)native, d, false);
      PbFixed64 f64 = native as PbFixed64;
      if (f64 != null) return Int64BitsEquals(f64.Bits, d, geo);
      PbFixed32 f32 = native as PbFixed32;
      if (f32 != null) {
        float f = BitConverter.ToSingle(BitConverter.GetBytes(f32.Bits), 0);
        return geo ? Math.Abs((double)f - d) <= 1e-6 : (float)d == f;
      }
      PbVarint pv = native as PbVarint;
      return pv != null && DoubleEquals((double)pv.Value, d, false);
    }
    return false;
  }
  static bool Int64BitsEquals(long bits, double d, bool geo) { return DoubleEquals(BitConverter.Int64BitsToDouble(bits), d, geo); }
  static bool DoubleEquals(double a, double b, bool geo) {
    if (Double.IsNaN(a) || Double.IsNaN(b)) return false;
    return geo ? Math.Abs(a - b) <= 1e-6 : a == b;
  }
}
