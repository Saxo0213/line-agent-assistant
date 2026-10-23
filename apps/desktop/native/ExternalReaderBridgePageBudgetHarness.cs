using System;
using System.Collections;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

internal static class ExternalReaderBridgePageBudgetHarness {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };

  static int Main() {
    try {
      VerifyAllPages(false, 1800, 120);
      VerifyAllPages(true, 2000, 450);
      VerifyTailContinuation();
      VerifyAckCursor();
      VerifySingleOversizeRow();
      Console.WriteLine("PASS");
      return 0;
    } catch (Exception error) {
      Console.WriteLine(error.GetType().Name + ":" + error.Message);
      return 1;
    }
  }

  static void VerifyAllPages(bool initialImport, int rowCount, int mentionIdLength) {
    List<object> source = BuildRows(rowCount, mentionIdLength, "source-");
    List<object> observed = new List<object>();
    int offset = 0, page = 1, ceiling = initialImport ? 8 * 1024 * 1024 : 1024 * 1024;
    string previousId = null;
    while (offset < source.Count) {
      object[] candidate = Slice(source, offset);
      int selected, tail;
      ExternalReaderBridge.FixtureFitPagePrefix(candidate, new object[0], page, null, initialImport,
        false, false, out selected, out tail);
      if (selected < 1 || tail != 0) throw new InvalidOperationException("EMPTY_OR_INVALID_PREFIX");
      object[] rows = candidateSubset(candidate, selected);
      Dictionary<string, object> last = (Dictionary<string, object>)rows[rows.Length - 1];
      Dictionary<string, object> cursor = new Dictionary<string, object> {
        { "createdTime", Convert.ToString(last["createdTime"]) }, { "id", Convert.ToString(last["nativeMessageId"]) }
      };
      bool more = offset + selected < source.Count;
      Dictionary<string, object> fields = new Dictionary<string, object> {
        { "pageNumber", page }, { "batchDigest", DigestRows(rows, null) }, { "rows", rows },
        { "lastCursor", cursor }, { "hasMore", more }
      };
      if (!initialImport) fields.Add("tailRows", new object[0]);
      string encoded = ExternalReaderBridge.FixtureSerializePage(fields, initialImport);
      Dictionary<string, object> frame = Json.Deserialize<Dictionary<string, object>>(encoded);
      byte[] bytes = Encoding.UTF8.GetBytes(encoded);
      if (bytes.Length > ceiling || 3L * bytes.Length + 128L * selected + 65536L > ceiling)
        throw new InvalidOperationException("PAGE_BUDGET_EXCEEDED");
      object[] emitted = ToArray(frame["rows"]);
      if (emitted.Length != selected || !String.Equals(Convert.ToString(((Dictionary<string, object>)emitted[0])["nativeMessageId"]),
          Convert.ToString(((Dictionary<string, object>)source[offset])["nativeMessageId"]), StringComparison.Ordinal))
        throw new InvalidOperationException("PREFIX_ORDER_CHANGED");
      if (previousId != null && String.Equals(previousId, Convert.ToString(((Dictionary<string, object>)emitted[0])["nativeMessageId"]), StringComparison.Ordinal))
        throw new InvalidOperationException("PREFIX_DUPLICATED");
      foreach (object value in emitted) {
        Dictionary<string, object> row = (Dictionary<string, object>)value;
        if (!row.ContainsKey("mentionRanges") || ToArray(row["mentionRanges"]).Length != 1)
          throw new InvalidOperationException("OPTIONAL_RANGE_DROPPED");
        observed.Add(value);
      }
      previousId = Convert.ToString(((Dictionary<string, object>)emitted[emitted.Length - 1])["nativeMessageId"]);
      Array.Clear(bytes, 0, bytes.Length);
      offset += selected; page++;
    }
    if (observed.Count != source.Count) throw new InvalidOperationException("ROW_COUNT_CHANGED");
    for (int i = 0; i < source.Count; i++) {
      string expected = Convert.ToString(((Dictionary<string, object>)source[i])["nativeMessageId"]);
      string actual = Convert.ToString(((Dictionary<string, object>)observed[i])["nativeMessageId"]);
      if (expected != actual) throw new InvalidOperationException("ROW_ORDER_CHANGED");
    }
  }

  static void VerifyTailContinuation() {
    List<object> forward = BuildRows(8, 120, "forward-");
    List<object> tail = BuildRows(50, 240, "tail-", 8000);
    int rows, tails;
    ExternalReaderBridge.FixtureFitPagePrefix(forward.ToArray(), tail.ToArray(), 3,
      new Dictionary<string, object> { { "createdTime", "17" }, { "id", "forward-00007" } }, false,
      false, true, out rows, out tails);
    if (rows != forward.Count || tails >= tail.Count || tails < 0)
      throw new InvalidOperationException("TAIL_DID_NOT_CONTINUE");
    int nextRows, nextTails;
    object cursor = new Dictionary<string, object> { { "createdTime", "17" }, { "id", "forward-00007" } };
    int tailOffset = tails, page = 4;
    while (tailOffset < tail.Count) {
      ExternalReaderBridge.FixtureFitPagePrefix(new object[0], Slice(tail, tailOffset), page, cursor, false,
        false, true, out nextRows, out nextTails);
      if (nextRows != 0 || nextTails < 1) throw new InvalidOperationException("TAIL_ONLY_PAGE_MISSING");
      object[] tailPageRows = candidateSubset(Slice(tail, tailOffset), nextTails);
      bool hasMore = tailOffset + nextTails < tail.Count;
      Dictionary<string, object> tailPage = new Dictionary<string, object> {
        { "pageNumber", page }, { "batchDigest", DigestRows(new object[0], tailPageRows) }, { "rows", new object[0] },
        { "tailRows", tailPageRows }, { "lastCursor", cursor }, { "hasMore", hasMore }
      };
      string encoded = ExternalReaderBridge.FixtureSerializePage(tailPage, false);
      Dictionary<string, object> emitted = Json.Deserialize<Dictionary<string, object>>(encoded);
      if (!String.Equals(Convert.ToString(((Dictionary<string, object>)emitted["lastCursor"])["id"]), "forward-00007", StringComparison.Ordinal))
        throw new InvalidOperationException("CURSOR_ADVANCED_BY_TAIL");
      tailOffset += nextTails; page++;
    }
  }

  static void VerifyAckCursor() {
    Dictionary<string, object> cursor = new Dictionary<string, object> { { "createdTime", "21" }, { "id", "fixture-cursor" } };
    if (!ExternalReaderBridge.FixtureDirectAckMatches(7, new string('a', 64), cursor,
        new Dictionary<string, object> { { "createdTime", "21" }, { "id", "fixture-cursor" } }))
      throw new InvalidOperationException("ACK_VALID_CURSOR_REJECTED");
    if (ExternalReaderBridge.FixtureDirectAckMatches(7, new string('a', 64), cursor,
        new Dictionary<string, object> { { "createdTime", "22" }, { "id", "wrong" } }))
      throw new InvalidOperationException("ACK_WRONG_CURSOR_ACCEPTED");
  }

  static void VerifySingleOversizeRow() {
    Dictionary<string, object> row = new Dictionary<string, object> {
      { "nativeMessageId", "oversize" }, { "createdTime", "18" }, { "text", new string('x', 1100000) },
      { "mentionRanges", new object[] { new Dictionary<string, object> { { "start", 0 }, { "end", 1 }, { "userId", "target" } } } }
    };
    int rows, tails;
    try {
      ExternalReaderBridge.FixtureFitPagePrefix(new object[] { row }, new object[0], 1, null, false,
        false, false, out rows, out tails);
    } catch (InvalidOperationException error) {
      if (error.Message == "SOURCE_ROW_TOO_LARGE") return;
      throw;
    }
    throw new InvalidOperationException("OVERSIZE_ROW_NOT_REJECTED");
  }

  static List<object> BuildRows(int count, int mentionIdLength, string idPrefix, int textLength = 800) {
    List<object> rows = new List<object>(count);
    string mentionId = new string('m', mentionIdLength);
    for (int i = 0; i < count; i++) {
      rows.Add(new Dictionary<string, object> {
        { "nativeMessageId", idPrefix + i.ToString("D5", System.Globalization.CultureInfo.InvariantCulture) + new string('i', Math.Max(0, 512 - idPrefix.Length - 5)) },
        { "createdTime", i.ToString(System.Globalization.CultureInfo.InvariantCulture) },
        { "text", "quotes \" and slash \\\\; Unicode \u2028 \uD83D\uDE42; " + new string('t', textLength) },
        { "mentionRanges", new object[] { new Dictionary<string, object> { { "start", 0 }, { "end", 1 }, { "userId", mentionId } } } }
      });
    }
    return rows;
  }

  static object[] Slice(List<object> source, int offset) {
    int count = source.Count - offset;
    object[] result = new object[count];
    source.CopyTo(offset, result, 0, count);
    return result;
  }

  static object[] candidateSubset(object[] source, int count) {
    object[] result = new object[count]; Array.Copy(source, result, count); return result;
  }

  static object[] ToArray(object value) {
    object[] array = value as object[];
    if (array != null) return array;
    IList list = value as IList;
    if (list == null) return new object[0];
    object[] result = new object[list.Count]; list.CopyTo(result, 0); return result;
  }

  static string DigestRows(object[] rows, object[] tail) {
    List<string> values = new List<string>(rows.Length + (tail == null ? 0 : tail.Length));
    foreach (object row in rows) values.Add(Json.Serialize(row));
    string material = String.Join("\n", values.ToArray());
    if (tail != null) {
      values.Clear(); foreach (object row in tail) values.Add(Json.Serialize(row));
      material += "\n--tail--\n" + String.Join("\n", values.ToArray());
    }
    using (SHA256 hash = SHA256.Create()) {
      byte[] bytes = hash.ComputeHash(Encoding.UTF8.GetBytes(material));
      StringBuilder hex = new StringBuilder(); foreach (byte value in bytes) hex.Append(value.ToString("x2"));
      Array.Clear(bytes, 0, bytes.Length); return hex.ToString();
    }
  }
}
