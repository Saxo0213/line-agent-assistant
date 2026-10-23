using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

// Aggregate-only analysis of a retained official database copy. Nothing here stores or prints cell text, names, IDs,
// MIDs or blob bytes: only counts, lengths, storage/encoding classes, redacted JSON key names and enumerations.
internal sealed class SnapshotLengthStats {
  internal long Count, Max;
  readonly long[] buckets = new long[240];
  static int Bucket(long length) {
    if (length < 16) return (int)length;
    int msb = 4;
    while ((length >> (msb + 1)) != 0) msb++;
    int sub = (int)((length >> (msb - 3)) & 7);
    return 16 + (msb - 4) * 8 + sub;
  }
  static long Lower(int index) {
    if (index < 16) return index;
    int j = index - 16, msb = 4 + j / 8, sub = j % 8;
    return (long)(8 + sub) << (msb - 3);
  }
  internal void Add(long length) { Count++; if (length > Max) Max = length; buckets[Bucket(length)]++; }
  // Exact below 16 bytes, otherwise the lower bound of a 1/8-octave bucket.
  internal long Percentile(double p) {
    if (Count == 0) return 0;
    long target = (long)Math.Ceiling(p * Count); if (target < 1) target = 1;
    long cumulative = 0;
    for (int i = 0; i < buckets.Length; i++) { cumulative += buckets[i]; if (cumulative >= target) return Math.Min(Lower(i), Max); }
    return Max;
  }
}

internal sealed class SnapshotJsonAgg {
  const int MaxKeySets = 4096, MaxKeys = 2048, MaxNestedParents = 256, MaxNestedKeys = 256;
  readonly Dictionary<string, long> keySets = new Dictionary<string, long>(StringComparer.Ordinal);
  readonly Dictionary<string, long[]> keyTypes = new Dictionary<string, long[]>(StringComparer.Ordinal);
  readonly Dictionary<string, Dictionary<string, long[]>> nested = new Dictionary<string, Dictionary<string, long[]>>(StringComparer.Ordinal);
  long keySetOverflow, keyOverflow, nestedOverflow, objects;
  static readonly string[] TypeNames = new string[] { "null", "boolean", "number", "string", "object", "array" };

  internal void Add(SnapshotJsonNode root) {
    if (root == null || root.Type != SnapshotJsonNode.JObject) return;
    objects++;
    List<string> names = new List<string>(root.Members.Count);
    foreach (KeyValuePair<string, SnapshotJsonNode> member in root.Members) {
      string key = SnapshotDecode.RedactKey(member.Key);
      if (!names.Contains(key)) names.Add(key);
      Count(keyTypes, key, member.Value.Type, MaxKeys, ref keyOverflow);
      if (member.Value.Type == SnapshotJsonNode.JObject) {
        Dictionary<string, long[]> children;
        if (!nested.TryGetValue(key, out children)) {
          if (nested.Count >= MaxNestedParents) { nestedOverflow++; continue; }
          children = new Dictionary<string, long[]>(StringComparer.Ordinal); nested[key] = children;
        }
        foreach (KeyValuePair<string, SnapshotJsonNode> child in member.Value.Members)
          Count(children, SnapshotDecode.RedactKey(child.Key), child.Value.Type, MaxNestedKeys, ref nestedOverflow);
      }
    }
    names.Sort(StringComparer.Ordinal);
    string signature = String.Join("\u001f", names.ToArray());
    long existing;
    if (keySets.TryGetValue(signature, out existing)) keySets[signature] = existing + 1;
    else if (keySets.Count < MaxKeySets) keySets[signature] = 1;
    else keySetOverflow++;
  }
  static void Count(Dictionary<string, long[]> map, string key, int type, int cap, ref long overflow) {
    long[] counts;
    if (!map.TryGetValue(key, out counts)) {
      if (map.Count >= cap) { overflow++; return; }
      counts = new long[6]; map[key] = counts;
    }
    counts[type]++;
  }
  static Dictionary<string, object> Types(long[] counts) {
    Dictionary<string, object> result = new Dictionary<string, object>();
    for (int i = 0; i < counts.Length; i++) if (counts[i] > 0) result[TypeNames[i]] = counts[i];
    return result;
  }
  static Dictionary<string, object> Map(Dictionary<string, long[]> map) {
    List<string> keys = new List<string>(map.Keys); keys.Sort(StringComparer.Ordinal);
    Dictionary<string, object> result = new Dictionary<string, object>();
    foreach (string key in keys) result[key] = Types(map[key]);
    return result;
  }
  internal Dictionary<string, object> Report() {
    List<KeyValuePair<string, long>> ordered = new List<KeyValuePair<string, long>>(keySets);
    ordered.Sort(delegate(KeyValuePair<string, long> a, KeyValuePair<string, long> b) {
      int byCount = b.Value.CompareTo(a.Value); return byCount != 0 ? byCount : String.CompareOrdinal(a.Key, b.Key);
    });
    List<object> top = new List<object>();
    for (int i = 0; i < ordered.Count && i < 50; i++)
      top.Add(new Dictionary<string, object> { { "keys", ordered[i].Key.Length == 0 ? new string[0] : ordered[i].Key.Split('\u001f') }, { "count", ordered[i].Value } });
    List<string> parents = new List<string>(nested.Keys); parents.Sort(StringComparer.Ordinal);
    Dictionary<string, object> nestedReport = new Dictionary<string, object>();
    foreach (string parent in parents) nestedReport[parent] = Map(nested[parent]);
    return new Dictionary<string, object> {
      { "objects", objects }, { "distinctKeySets", (long)keySets.Count }, { "keySetOverflow", keySetOverflow }, { "topKeySets", top },
      { "keys", Map(keyTypes) }, { "keyOverflow", keyOverflow }, { "nested", nestedReport }, { "nestedOverflow", nestedOverflow }
    };
  }
}

internal sealed class SnapshotColumnAgg {
  static readonly string[] StorageNames = new string[] { "", "INTEGER", "REAL", "TEXT", "BLOB", "NULL" };
  readonly long[] storage = new long[6];
  readonly Dictionary<string, KeyValuePair<long, SnapshotLengthStats>> encodings = new Dictionary<string, KeyValuePair<long, SnapshotLengthStats>>(StringComparer.Ordinal);
  readonly Dictionary<string, SnapshotLengthStats> classStats = new Dictionary<string, SnapshotLengthStats>(StringComparer.Ordinal);
  SnapshotJsonAgg json;
  internal void Add(AnalysisCell cell) {
    storage[cell.Type]++;
    if (cell.Type != 3 && cell.Type != 4) return;
    SnapshotJsonNode node;
    string cls = SnapshotDecode.Classify(cell.Data, cell.Copied, cell.Length, out node);
    SnapshotLengthStats stats;
    if (!classStats.TryGetValue(cls, out stats)) { stats = new SnapshotLengthStats(); classStats[cls] = stats; }
    stats.Add(cell.Length);
    if (node != null && node.Type == SnapshotJsonNode.JObject) { if (json == null) json = new SnapshotJsonAgg(); json.Add(node); }
  }
  internal Dictionary<string, object> Report() {
    Dictionary<string, object> counts = new Dictionary<string, object>();
    for (int i = 1; i <= 5; i++) counts[StorageNames[i]] = storage[i];
    Dictionary<string, object> classes = new Dictionary<string, object>();
    List<string> names = new List<string>(classStats.Keys); names.Sort(StringComparer.Ordinal);
    foreach (string name in names) {
      SnapshotLengthStats s = classStats[name];
      classes[name] = new Dictionary<string, object> { { "count", s.Count }, { "lengthMax", s.Max }, { "lengthP50", s.Percentile(0.5) }, { "lengthP95", s.Percentile(0.95) } };
    }
    Dictionary<string, object> report = new Dictionary<string, object> {
      { "nonNull", storage[1] + storage[2] + storage[3] + storage[4] }, { "storage", counts } };
    if (classes.Count > 0) report["encodings"] = classes;
    if (json != null) report["json"] = json.Report();
    return report;
  }
}

internal static class OfficialSnapshotAnalyzer {
  // Tables whose columns reach app tables through the production readers: SerializeNativeMessageRow (_message,
  // conversation info), the directory pager (_contact, _chat) and sender names (_squareMember).
  static readonly string[] ProjectedTables = new string[] { "_message", "_chat", "_contact", "_groupChat", "_squareChat", "_squareThread", "_squareMember" };
  static readonly Regex EnumToken = new Regex("^[a-z_]{1,24}$", RegexOptions.CultureInvariant);
  static readonly Regex KeyToken = new Regex("^[A-Za-z][A-Za-z0-9]{0,40}$", RegexOptions.CultureInvariant);
  const int MaxHashes = 16 * 1024 * 1024;

  internal static string Coverage(string table) {
    bool archived = Array.IndexOf(Sqlite3Mc.AnalysisArchivedTableNames(), table) >= 0;
    bool projected = Array.IndexOf(ProjectedTables, table) >= 0;
    return archived && projected ? "archived+projected" : archived ? "archived" : "not-imported";
  }

  static string SafeCode(Exception error) {
    string message = error.Message ?? "";
    return Regex.IsMatch(message, "^[A-Z][A-Z_]{2,39}$") ? message : "OTHER";
  }

  static Dictionary<string, object> AnalyzeTable(Sqlite3Mc reader, string table, CancellationToken cancellation, bool withCoverage) {
    string[] columns;
    try { columns = reader.AnalysisColumnNames(table); }
    catch (Exception error) { cancellation.ThrowIfCancellationRequested(); return new Dictionary<string, object> { { "error", SafeCode(error) } }; }
    SnapshotColumnAgg[] aggs = new SnapshotColumnAgg[columns.Length];
    for (int i = 0; i < aggs.Length; i++) aggs[i] = new SnapshotColumnAgg();
    long rows = 0; string scanError = null;
    try {
      rows = reader.AnalysisScanTable(table, cancellation, delegate(AnalysisCell[] cells) { for (int i = 0; i < aggs.Length; i++) aggs[i].Add(cells[i]); });
    } catch (Exception error) {
      cancellation.ThrowIfCancellationRequested();
      scanError = SafeCode(error);
    }
    Dictionary<string, object> columnReport = new Dictionary<string, object>();
    HashSet<string> used = new HashSet<string>(StringComparer.Ordinal);
    for (int i = 0; i < columns.Length; i++) columnReport[UniqueName(columns[i], used, "column")] = aggs[i].Report();
    Dictionary<string, object> report = new Dictionary<string, object> { { "rowCount", rows }, { "columnCount", (long)columns.Length }, { "columns", columnReport } };
    if (withCoverage) report["coverage"] = Coverage(table);
    if (scanError != null) report["scanError"] = scanError;
    return report;
  }

  static string UniqueName(string name, HashSet<string> used, string kind) {
    string shown = SnapshotDecode.RedactKey(name);
    if (shown == SnapshotDecode.RedactedKey) {
      int n = 1; while (used.Contains(SnapshotDecode.RedactedKey + "#" + n)) n++;
      shown = SnapshotDecode.RedactedKey + "#" + n;
    }
    used.Add(shown); return shown;
  }

  // Generic aggregates for any database (used for the side files).
  internal static Dictionary<string, object> AnalyzeGeneric(Sqlite3Mc reader, CancellationToken cancellation) {
    reader.AnalysisConfigure(); reader.EnableCancellation(cancellation);
    Dictionary<string, object> tables = new Dictionary<string, object>();
    HashSet<string> used = new HashSet<string>(StringComparer.Ordinal);
    foreach (string table in reader.AnalysisTableNames()) tables[UniqueName(table, used, "table")] = AnalyzeTable(reader, table, cancellation, false);
    return new Dictionary<string, object> { { "tableCount", (long)tables.Count }, { "tables", tables } };
  }

  internal static Dictionary<string, object> AnalyzeMain(Sqlite3Mc reader, CancellationToken cancellation) {
    reader.AnalysisConfigure(); reader.EnableCancellation(cancellation);
    List<string> names = reader.AnalysisTableNames();
    Dictionary<string, object> tables = new Dictionary<string, object>(), coverage = new Dictionary<string, object>();
    HashSet<string> used = new HashSet<string>(StringComparer.Ordinal);
    foreach (string table in names) {
      string shown = UniqueName(table, used, "table");
      Dictionary<string, object> report = AnalyzeTable(reader, table, cancellation, true);
      tables[shown] = report; coverage[shown] = Coverage(table);
    }
    Dictionary<string, object> result = new Dictionary<string, object> { { "tableCount", (long)tables.Count }, { "tables", tables }, { "tableCoverage", coverage } };
    if (names.Contains("_message")) result["message"] = AnalyzeMessages(reader, cancellation);
    result["names"] = AnalyzeNames(reader, names, cancellation);
    return result;
  }

  // ---------------- _message ----------------
  sealed class TypeAgg {
    internal long Rows;
    internal long[] NonNull;
    internal Dictionary<string, SnapshotColumnAgg> Blobs = new Dictionary<string, SnapshotColumnAgg>(StringComparer.Ordinal);
    internal Dictionary<string, long> Types = new Dictionary<string, long>(), Statuses = new Dictionary<string, long>(),
      Kinds = new Dictionary<string, long>(), Errors = new Dictionary<string, long>(), ContentTypes = new Dictionary<string, long>(),
      TopLevelKeys = new Dictionary<string, long>();
    internal long Projected, Sticker, StickerId, StickerPackage, StickerVersion, Attachments, Mentions, ContentPresent, ParseFailures;
  }
  static readonly string[] BlobColumns = new string[] { "_contentMetadata", "_location", "_contentInfo", "_eventInfo", "_reactions" };

  static void Bump(Dictionary<string, long> map, string key) { long v; map.TryGetValue(key, out v); map[key] = v + 1; }
  static string IntKey(string prefix, AnalysisCell cell) { return cell == null || cell.Type != 1 ? prefix + "null" : prefix + cell.Integer.ToString(System.Globalization.CultureInfo.InvariantCulture); }
  static ulong Fnv(AnalysisCell cell) {
    ulong h = 14695981039346656037UL;
    for (int i = 0; i < cell.Copied; i++) { h ^= cell.Data[i]; h *= 1099511628211UL; }
    return h ^ (ulong)cell.Length;
  }
  static Dictionary<string, object> Sorted(Dictionary<string, long> map) {
    List<string> keys = new List<string>(map.Keys); keys.Sort(StringComparer.Ordinal);
    Dictionary<string, object> result = new Dictionary<string, object>();
    foreach (string key in keys) result[key] = map[key];
    return result;
  }
  static SnapshotJsonNode Member(SnapshotJsonNode node, string key) {
    if (node == null || node.Type != SnapshotJsonNode.JObject) return null;
    foreach (KeyValuePair<string, SnapshotJsonNode> m in node.Members) if (m.Key == key) return m.Value;
    return null;
  }

  static Dictionary<string, object> AnalyzeMessages(Sqlite3Mc reader, CancellationToken cancellation) {
    Dictionary<string, TypeAgg> perType = new Dictionary<string, TypeAgg>(StringComparer.Ordinal);
    Dictionary<string, long> byToType = new Dictionary<string, long>(), relation = new Dictionary<string, long>();
    List<ulong> ids = new List<ulong>(), related = new List<ulong>();
    long idOverflow = 0, relatedOverflow = 0, relatedPresent = 0, rows = 0, projectionFailures = 0;
    int iType = -1, iTo = -1, iTypeCol = -1, iStatus = -1, iRel = -1, iRelId = -1, iId = -1;
    int[] blobIndex = null;
    bool projected;
    try {
      projected = reader.AnalysisScanMessages(cancellation, delegate(string[] columns, AnalysisCell[] cells, string json, string error) {
        if (iType < 0) {
          iType = Array.IndexOf(columns, "_contentType"); iTo = Array.IndexOf(columns, "_toType"); iTypeCol = Array.IndexOf(columns, "_type");
          iStatus = Array.IndexOf(columns, "_status"); iRel = Array.IndexOf(columns, "_messageRelationType");
          iRelId = Array.IndexOf(columns, "_relatedMessageId"); iId = Array.IndexOf(columns, "_id");
          blobIndex = new int[BlobColumns.Length];
          for (int b = 0; b < BlobColumns.Length; b++) blobIndex[b] = Array.IndexOf(columns, BlobColumns[b]);
        }
        rows++;
        string typeKey = iType >= 0 ? IntKey("ct:", cells[iType]) : "ct:null";
        TypeAgg agg;
        if (!perType.TryGetValue(typeKey, out agg)) {
          agg = new TypeAgg { NonNull = new long[columns.Length] };
          for (int b = 0; b < BlobColumns.Length; b++) agg.Blobs[BlobColumns[b]] = new SnapshotColumnAgg();
          perType[typeKey] = agg;
        }
        agg.Rows++;
        if (iTo >= 0) Bump(byToType, typeKey + "|to:" + (cells[iTo].Type == 1 ? cells[iTo].Integer.ToString(System.Globalization.CultureInfo.InvariantCulture) : "null"));
        for (int c = 0; c < columns.Length; c++) if (cells[c].Type != 5) agg.NonNull[c]++;
        for (int b = 0; b < blobIndex.Length; b++) if (blobIndex[b] >= 0) agg.Blobs[BlobColumns[b]].Add(cells[blobIndex[b]]);
        if (iTypeCol >= 0) Bump(agg.Types, IntKey("", cells[iTypeCol]));
        if (iStatus >= 0) Bump(agg.Statuses, IntKey("", cells[iStatus]));
        if (iRel >= 0) Bump(relation, IntKey("relation:", cells[iRel]));
        if (iId >= 0 && cells[iId].Type == 3) { if (ids.Count < MaxHashes) ids.Add(Fnv(cells[iId])); else idOverflow++; }
        if (iRelId >= 0 && (cells[iRelId].Type == 3 || cells[iRelId].Type == 4) && cells[iRelId].Length > 0) {
          relatedPresent++;
          if (related.Count < MaxHashes) related.Add(Fnv(cells[iRelId])); else relatedOverflow++;
        }
        if (error != null) { projectionFailures++; Bump(agg.Errors, error); }
        if (json != null) Tally(agg, json);
      });
    } catch (Exception error) {
      cancellation.ThrowIfCancellationRequested();
      return new Dictionary<string, object> { { "error", SafeCode(error) } };
    }
    ulong[] sorted = ids.ToArray(); Array.Sort(sorted);
    long resolved = 0;
    foreach (ulong r in related) if (Array.BinarySearch(sorted, r) >= 0) resolved++;
    string[] names = null;
    Dictionary<string, object> types = new Dictionary<string, object>();
    List<string> typeKeys = new List<string>(perType.Keys); typeKeys.Sort(StringComparer.Ordinal);
    foreach (string key in typeKeys) {
      TypeAgg agg = perType[key];
      Dictionary<string, object> blobs = new Dictionary<string, object>();
      foreach (string column in BlobColumns) blobs[column] = agg.Blobs[column].Report();
      Dictionary<string, object> entry = new Dictionary<string, object> {
        { "rows", agg.Rows }, { "columnNonNull", agg.NonNull }, { "typeDistribution", Sorted(agg.Types) }, { "statusDistribution", Sorted(agg.Statuses) },
        { "blobColumns", blobs }
      };
      if (projected) entry["projection"] = new Dictionary<string, object> {
        { "projectedRows", agg.Projected }, { "projectionErrors", Sorted(agg.Errors) }, { "kind", Sorted(agg.Kinds) },
        { "nativeStickerMetadata", agg.Sticker }, { "stickerWithId", agg.StickerId }, { "stickerWithPackageId", agg.StickerPackage }, { "stickerWithVersion", agg.StickerVersion },
        { "nativeAttachments", agg.Attachments }, { "mentionRanges", agg.Mentions }, { "contentPresent", agg.ContentPresent }, { "contentType", Sorted(agg.ContentTypes) },
        { "topLevelKeys", Sorted(agg.TopLevelKeys) }, { "parseFailures", agg.ParseFailures }
      };
      types[key] = entry;
    }
    if (names == null) names = new string[0];
    return new Dictionary<string, object> {
      { "rows", rows }, { "contentTypeByToType", Sorted(byToType) }, { "perContentType", types },
      { "relationType", Sorted(relation) },
      { "relatedMessageIdPresent", relatedPresent }, { "relatedResolvedInSnapshot", resolved }, { "relatedUnresolved", related.Count - resolved },
      { "idHashOverflow", idOverflow }, { "relatedHashOverflow", relatedOverflow },
      { "projectionAvailable", projected }, { "projectionFailures", projectionFailures }
    };
  }

  static void Tally(TypeAgg agg, string json) {
    int cut = json.IndexOf(",\"nativePayload\":", StringComparison.Ordinal);
    SnapshotJsonNode node = SnapshotDecode.ParseJson(cut >= 0 ? json.Substring(0, cut) + "}" : json);
    if (node == null || node.Type != SnapshotJsonNode.JObject) { agg.ParseFailures++; return; }
    agg.Projected++;
    SnapshotJsonNode kind = Member(node, "kind");
    Bump(agg.Kinds, kind != null && kind.Type == SnapshotJsonNode.JString && EnumToken.IsMatch(kind.Text) ? kind.Text : "other");
    foreach (KeyValuePair<string, SnapshotJsonNode> m in node.Members)
      if (m.Value.Type != SnapshotJsonNode.JNull && KeyToken.IsMatch(m.Key)) Bump(agg.TopLevelKeys, m.Key);
    SnapshotJsonNode sticker = Member(node, "nativeStickerMetadata");
    if (sticker != null && sticker.Type == SnapshotJsonNode.JObject) {
      agg.Sticker++;
      if (Member(sticker, "STKID") != null) agg.StickerId++;
      if (Member(sticker, "STKPKGID") != null) agg.StickerPackage++;
      if (Member(sticker, "STKVER") != null) agg.StickerVersion++;
    }
    SnapshotJsonNode attachments = Member(node, "nativeAttachments");
    if (attachments != null && attachments.Type == SnapshotJsonNode.JArray) agg.Attachments++;
    SnapshotJsonNode mentions = Member(node, "mentionRanges");
    if (mentions != null && mentions.Type == SnapshotJsonNode.JArray) agg.Mentions++;
    SnapshotJsonNode content = Member(node, "content");
    if (content != null && content.Type != SnapshotJsonNode.JNull) {
      agg.ContentPresent++;
      SnapshotJsonNode type = Member(content, "type");
      Bump(agg.ContentTypes, type != null && type.Type == SnapshotJsonNode.JString && EnumToken.IsMatch(type.Text) ? type.Text : "other");
    }
  }

  // ---------------- names ----------------
  static int Col(string[] columns, string name) { return Array.IndexOf(columns, name); }
  static bool NonEmptyText(AnalysisCell cell) { return (cell.Type == 3 || cell.Type == 4) && cell.Length > 0; }

  // Reads (keyColumn, optional value columns) of a table; returns false when the table or key column is absent.
  static bool Scan(Sqlite3Mc reader, List<string> tables, string table, string keyColumn, string[] nameColumns, CancellationToken cancellation,
      Action<AnalysisCell, AnalysisCell[], int[]> row, out long total) {
    total = 0;
    if (!tables.Contains(table)) return false;
    string[] columns = reader.AnalysisColumnNames(table);
    int key = Col(columns, keyColumn); if (key < 0) return false;
    int[] valueIndex = new int[nameColumns.Length];
    for (int i = 0; i < valueIndex.Length; i++) valueIndex[i] = Col(columns, nameColumns[i]);
    total = reader.AnalysisScanTable(table, cancellation, delegate(AnalysisCell[] cells) { row(cells[key], cells, valueIndex); });
    return true;
  }

  static Dictionary<string, object> AnalyzeNames(Sqlite3Mc reader, List<string> tables, CancellationToken cancellation) {
    Dictionary<string, object> result = new Dictionary<string, object> { { "rule", "production-title-rules" } };
    try {
      HashSet<ulong> contactNames = new HashSet<ulong>(), groupNames = new HashSet<ulong>(), squareNames = new HashSet<ulong>(), threadsWithParent = new HashSet<ulong>();
      Dictionary<string, long> combos = new Dictionary<string, long>();
      long total; string[] contactColumns = new string[] { "_displayName", "_displayNameOverridden" };
      long contactRows = 0;
      bool hasContacts = Scan(reader, tables, "_contact", "_mid", contactColumns, cancellation, delegate(AnalysisCell key, AnalysisCell[] cells, int[] idx) {
        List<string> present = new List<string>();
        bool named = false;
        for (int i = 0; i < idx.Length; i++) if (idx[i] >= 0 && NonEmptyText(cells[idx[i]])) { present.Add(contactColumns[i].Substring(1)); named = true; }
        Bump(combos, present.Count == 0 ? "none" : String.Join("+", present.ToArray()));
        if (named && key.Type == 3 && contactNames.Count < MaxHashes) contactNames.Add(Fnv(key));
      }, out contactRows);
      long groupRows = 0, groupNamed = 0, squareRows = 0, squareNamed = 0, threadRows = 0;
      bool hasGroups = Scan(reader, tables, "_groupChat", "_chatMid", new string[] { "_chatName" }, cancellation, delegate(AnalysisCell key, AnalysisCell[] cells, int[] idx) {
        if (idx[0] >= 0 && NonEmptyText(cells[idx[0]]) && key.Type == 3) { groupNames.Add(Fnv(key)); groupNamed++; }
      }, out groupRows);
      bool hasSquare = Scan(reader, tables, "_squareChat", "_squareChatMid", new string[] { "_name" }, cancellation, delegate(AnalysisCell key, AnalysisCell[] cells, int[] idx) {
        if (idx[0] >= 0 && NonEmptyText(cells[idx[0]]) && key.Type == 3) { squareNames.Add(Fnv(key)); squareNamed++; }
      }, out squareRows);
      bool hasThreads = Scan(reader, tables, "_squareThread", "_threadMid", new string[] { "_chatMid" }, cancellation, delegate(AnalysisCell key, AnalysisCell[] cells, int[] idx) {
        if (idx[0] >= 0 && NonEmptyText(cells[idx[0]]) && key.Type == 3) threadsWithParent.Add(Fnv(key));
      }, out threadRows);
      Dictionary<string, long[]> chats = new Dictionary<string, long[]>(StringComparer.Ordinal);
      bool hasChats = Scan(reader, tables, "_chat", "_id", new string[] { "_midType" }, cancellation, delegate(AnalysisCell key, AnalysisCell[] cells, int[] idx) {
        long? midType = idx[0] >= 0 && cells[idx[0]].Type == 1 ? (long?)cells[idx[0]].Integer : null;
        string category = Sqlite3Mc.AnalysisCategory(midType);
        long[] counts; if (!chats.TryGetValue(category, out counts)) { counts = new long[2]; chats[category] = counts; }
        counts[0]++;
        if (key.Type != 3) return;
        ulong h = Fnv(key); bool named = false;
        if (category == "direct") named = contactNames.Contains(h);
        else if (category == "group") named = groupNames.Contains(h);
        else if (category == "community") named = squareNames.Contains(h);
        else if (category == "thread") named = threadsWithParent.Contains(h);
        if (named) counts[1]++;
      }, out total);
      Dictionary<string, object> chatReport = new Dictionary<string, object>();
      foreach (string category in new string[] { "direct", "group", "room", "community", "thread" }) {
        long[] counts; chats.TryGetValue(category, out counts);
        chatReport[category] = new Dictionary<string, object> { { "total", counts == null ? 0L : counts[0] }, { "withName", counts == null ? 0L : counts[1] } };
      }
      result["chats"] = hasChats ? (object)chatReport : "unavailable";
      result["contacts"] = hasContacts ? (object)new Dictionary<string, object> { { "rows", contactRows }, { "nameFieldCombinations", Sorted(combos) } } : "unavailable";
      result["groupChats"] = hasGroups ? (object)new Dictionary<string, object> { { "rows", groupRows }, { "withName", groupNamed } } : "unavailable";
      result["squareChats"] = hasSquare ? (object)new Dictionary<string, object> { { "rows", squareRows }, { "withName", squareNamed } } : "unavailable";
      result["squareThreads"] = hasThreads ? (object)new Dictionary<string, object> { { "rows", threadRows } } : "unavailable";
    } catch (Exception error) {
      cancellation.ThrowIfCancellationRequested();
      result["error"] = SafeCode(error);
    }
    return result;
  }
}
