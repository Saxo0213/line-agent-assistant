using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

// Correlates server-format fields of live messages (bounded NDJSON on stdin) with the official database's BLOB/TEXT
// columns in a sandbox copy. Output is counts only: no values, IDs, MIDs or names.
internal sealed class SnapshotToolException : Exception {
  internal readonly string Code;
  internal SnapshotToolException(string code) : base(code) { Code = code; }
}

internal sealed class CorrelationLiveRow {
  internal string MessageId;
  internal string ContentType;
  internal List<KeyValuePair<string, object>> Leaves;
}

internal static class OfficialSnapshotCorrelator {
  internal const int MaxLineBytes = 64 * 1024;
  internal const long MaxTotalBytes = 32L * 1024 * 1024;
  const int MaxRows = 100000;
  const int MaxPairs = 200000;
  static readonly Regex TypeToken = new Regex("^[A-Za-z0-9_]{1,24}$", RegexOptions.CultureInvariant);
  static readonly string[] DecodeColumns = new string[] { "_location", "_contentInfo", "_eventInfo", "_reactions", "_chunks", "_contentPreview", "_urlPreview", "_contentMetadata" };
  static readonly string[] DecoderNames = new string[] { "json", "thrift_compact", "thrift_binary", "protobuf" };

  internal static List<CorrelationLiveRow> ReadRows(Stream input, out long invalid) {
    invalid = 0;
    List<CorrelationLiveRow> rows = new List<CorrelationLiveRow>();
    byte[] chunk = new byte[64 * 1024];
    MemoryStream line = new MemoryStream();
    long total = 0;
    try {
      while (true) {
        int read = input.Read(chunk, 0, chunk.Length);
        if (read <= 0) break;
        total += read;
        if (total > MaxTotalBytes) throw new SnapshotToolException("stdin_cap_exceeded");
        for (int i = 0; i < read; i++) {
          if (chunk[i] == (byte)'\n') { Finish(line, rows, ref invalid); line.SetLength(0); continue; }
          if (line.Length >= MaxLineBytes) throw new SnapshotToolException("stdin_cap_exceeded");
          line.WriteByte(chunk[i]);
        }
      }
      Finish(line, rows, ref invalid);
      return rows;
    } finally {
      Array.Clear(chunk, 0, chunk.Length);
      byte[] buffer = line.GetBuffer(); Array.Clear(buffer, 0, buffer.Length); line.Dispose();
    }
  }

  static void Finish(MemoryStream line, List<CorrelationLiveRow> rows, ref long invalid) {
    if (line.Length == 0) return;
    if (rows.Count >= MaxRows) throw new SnapshotToolException("stdin_cap_exceeded");
    SnapshotJsonNode node = null; string text = null;
    try {
      text = new UTF8Encoding(false, true).GetString(line.GetBuffer(), 0, (int)line.Length);
      node = SnapshotDecode.ParseJson(text.TrimEnd('\r'));
    } catch { node = null; }
    text = null;
    if (node == null || node.Type != SnapshotJsonNode.JObject) { invalid++; return; }
    string id = null, contentType = "other"; SnapshotJsonNode fields = null;
    foreach (KeyValuePair<string, SnapshotJsonNode> member in node.Members) {
      if (member.Key == "messageId" && member.Value.Type == SnapshotJsonNode.JString) id = member.Value.Text;
      else if (member.Key == "fields" && member.Value.Type == SnapshotJsonNode.JObject) fields = member.Value;
    }
    if (fields != null) foreach (KeyValuePair<string, SnapshotJsonNode> member in fields.Members) {
      if (member.Key != "contentType") continue;
      string token = member.Value.Type == SnapshotJsonNode.JString ? member.Value.Text : member.Value.Type == SnapshotJsonNode.JNumber && member.Value.IsInteger ? member.Value.IntValue.ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
      if (token != null && TypeToken.IsMatch(token)) contentType = token;
    }
    if (String.IsNullOrEmpty(id) || id.Length > 512 || fields == null) { invalid++; return; }
    List<KeyValuePair<string, object>> leaves = new List<KeyValuePair<string, object>>();
    SnapshotDecode.FlattenJson(fields, "", leaves);
    rows.Add(new CorrelationLiveRow { MessageId = id, ContentType = contentType, Leaves = leaves });
  }

  static Dictionary<string, List<object>> Group(List<KeyValuePair<string, object>> leaves) {
    Dictionary<string, List<object>> groups = new Dictionary<string, List<object>>(StringComparer.Ordinal);
    foreach (KeyValuePair<string, object> leaf in leaves) {
      List<object> values;
      if (!groups.TryGetValue(leaf.Key, out values)) { values = new List<object>(); groups[leaf.Key] = values; }
      values.Add(leaf.Value);
    }
    return groups;
  }

  static bool Decode(int decoder, byte[] data, int length, List<KeyValuePair<string, object>> leaves) {
    switch (decoder) {
      case 0: return SnapshotDecode.TryDecodeJson(data, length, leaves);
      case 1: return SnapshotDecode.TryDecodeThriftCompact(data, length, leaves);
      case 2: return SnapshotDecode.TryDecodeThriftBinary(data, length, leaves);
      default: return SnapshotDecode.TryDecodeProtobuf(data, length, leaves);
    }
  }

  internal static Dictionary<string, object> Correlate(Sqlite3Mc reader, List<CorrelationLiveRow> rows, long invalid, CancellationToken cancellation) {
    reader.AnalysisConfigure(); reader.EnableCancellation(cancellation);
    AnalysisCell[] cells = new AnalysisCell[DecodeColumns.Length];
    for (int i = 0; i < cells.Length; i++) cells[i] = new AnalysisCell();
    Dictionary<string, long[]> perType = new Dictionary<string, long[]>(StringComparer.Ordinal);
    long[] nonEmpty = new long[DecodeColumns.Length];
    long[,] success = new long[DecodeColumns.Length, DecoderNames.Length];
    Dictionary<string, long[]> pairs = new Dictionary<string, long[]>(StringComparer.Ordinal);
    long pairOverflow = 0, matched = 0;
    try {
      foreach (CorrelationLiveRow row in rows) {
        cancellation.ThrowIfCancellationRequested();
        long[] counts; if (!perType.TryGetValue(row.ContentType, out counts)) { counts = new long[2]; perType[row.ContentType] = counts; }
        counts[0]++;
        if (!reader.AnalysisReadMessageById(row.MessageId, DecodeColumns, cells)) continue;
        counts[1]++; matched++;
        Dictionary<string, List<object>> server = null;
        for (int c = 0; c < cells.Length; c++) {
          AnalysisCell cell = cells[c];
          if ((cell.Type != 3 && cell.Type != 4) || cell.Length == 0) continue;
          nonEmpty[c]++;
          if (cell.Length > cell.Copied) continue;
          for (int d = 0; d < DecoderNames.Length; d++) {
            List<KeyValuePair<string, object>> leaves = new List<KeyValuePair<string, object>>();
            if (!Decode(d, cell.Data, cell.Length, leaves)) continue;
            success[c, d]++;
            if (server == null) server = Group(row.Leaves);
            foreach (KeyValuePair<string, List<object>> native in Group(leaves)) {
              foreach (KeyValuePair<string, List<object>> field in server) {
                bool equal = false;
                for (int a = 0; a < native.Value.Count && !equal; a++)
                  for (int b = 0; b < field.Value.Count && !equal; b++) equal = SnapshotDecode.LeafEquals(native.Value[a], field.Value[b], field.Key);
                string key = DecodeColumns[c] + "|" + DecoderNames[d] + "|" + native.Key + "|" + field.Key;
                long[] pair;
                if (!pairs.TryGetValue(key, out pair)) {
                  if (pairs.Count >= MaxPairs) { pairOverflow++; continue; }
                  pair = new long[2]; pairs[key] = pair;
                }
                pair[equal ? 0 : 1]++;
              }
            }
          }
        }
        foreach (AnalysisCell cell in cells) if (cell.Data.Length > 0) Array.Clear(cell.Data, 0, cell.Data.Length);
      }
    } finally { foreach (AnalysisCell cell in cells) if (cell.Data.Length > 0) Array.Clear(cell.Data, 0, cell.Data.Length); }

    List<string> typeKeys = new List<string>(perType.Keys); typeKeys.Sort(StringComparer.Ordinal);
    Dictionary<string, object> types = new Dictionary<string, object>();
    foreach (string key in typeKeys) types[key] = new Dictionary<string, object> { { "live", perType[key][0] }, { "matchedInSnapshot", perType[key][1] } };
    Dictionary<string, object> columns = new Dictionary<string, object>();
    for (int c = 0; c < DecodeColumns.Length; c++) {
      Dictionary<string, object> decoders = new Dictionary<string, object>();
      for (int d = 0; d < DecoderNames.Length; d++) decoders[DecoderNames[d]] = new Dictionary<string, object> { { "decoded", success[c, d] } };
      columns[DecodeColumns[c]] = new Dictionary<string, object> { { "nonEmpty", nonEmpty[c] }, { "decoders", decoders } };
    }
    List<KeyValuePair<string, long[]>> ordered = new List<KeyValuePair<string, long[]>>(pairs);
    ordered.Sort(delegate(KeyValuePair<string, long[]> a, KeyValuePair<string, long[]> b) {
      int byMatch = b.Value[0].CompareTo(a.Value[0]); return byMatch != 0 ? byMatch : String.CompareOrdinal(a.Key, b.Key);
    });
    List<object> pairReport = new List<object>();
    for (int i = 0; i < ordered.Count && pairReport.Count < 2000; i++) {
      if (ordered[i].Value[0] == 0 && ordered[i].Value[1] == 0) continue;
      string[] part = ordered[i].Key.Split(new char[] { '|' }, 4);
      int column = Array.IndexOf(DecodeColumns, part[0]), decoder = Array.IndexOf(DecoderNames, part[1]);
      long decoded = success[column, decoder];
      pairReport.Add(new Dictionary<string, object> { { "column", part[0] }, { "decoder", part[1] }, { "nativePath", part[2] }, { "serverField", part[3] },
        { "match", ordered[i].Value[0] }, { "mismatch", ordered[i].Value[1] }, { "absent", decoded - ordered[i].Value[0] - ordered[i].Value[1] } });
    }
    return new Dictionary<string, object> {
      { "format", 1 }, { "rows", new Dictionary<string, object> { { "live", (long)rows.Count }, { "invalid", invalid }, { "matchedInSnapshot", matched }, { "perContentType", types } } },
      { "columns", columns }, { "pairs", pairReport }, { "pairOverflow", pairOverflow }
    };
  }
}
