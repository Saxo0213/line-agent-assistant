using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// Bounded projections used only by the existing direct-monitor private pipe.
internal static class NativeAttachmentOperations {
  internal const int MaxRequestFrameBytes = 8 * 1024 * 1024;
  internal const int MaxResultFrameBytes = 32 * 1024;
  const int MaxMetadataJsonChars = 16 * 1024;
  const int MaxContentInfoJsonChars = 64 * 1024;
  const int MaxEnvelopePlaintextBytes = 12 * 1024 * 1024;
  static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
  static readonly JavaScriptSerializer EnvelopeJson = new JavaScriptSerializer {
    MaxJsonLength = MaxRequestFrameBytes, RecursionLimit = 32
  };
  static readonly JavaScriptSerializer MetadataJson = new JavaScriptSerializer {
    MaxJsonLength = MaxContentInfoJsonChars, RecursionLimit = 8
  };

  internal static Dictionary<string, object> FindAuthCandidates(OfficialSourceInventoryResult source,
      IOfficialSourceInventoryEnvironment environment, CancellationToken cancellation, bool verifyProcess = true) {
    List<Dictionary<string, object>> candidates = new List<Dictionary<string, object>>();
    string errorCode = null;
    try {
      List<OfficialSourceHeaderProbe.HeaderCandidate> found = OfficialSourceHeaderProbe.Find(source, environment,
        DateTime.UtcNow.AddSeconds(20), cancellation, verifyProcess);
      if (found == null || found.Count > OfficialSourceHeaderProbe.MaxCandidateCount)
        throw new InvalidDataException("candidate_limit");
      foreach (OfficialSourceHeaderProbe.HeaderCandidate candidate in found) {
        cancellation.ThrowIfCancellationRequested();
        if (candidate == null || String.IsNullOrEmpty(candidate.Token) || candidate.Token.Length > 1024 ||
            String.IsNullOrEmpty(candidate.Application) || candidate.Application.Length > 512 ||
            !candidate.Application.StartsWith("DESKTOPWIN\t", StringComparison.Ordinal)) continue;
        candidates.Add(new Dictionary<string, object> {
          { "token", candidate.Token }, { "application", candidate.Application }
        });
      }
    } catch (OperationCanceledException) { throw; }
    catch (Exception error) { errorCode = SafeAuthError(error); candidates.Clear(); }
    return new Dictionary<string, object> { { "candidates", candidates.ToArray() }, { "errorCode", errorCode } };
  }

  internal static Dictionary<string, object> DecodeAttachmentEnvelope(string envelope,
      string expectedMessageId, string expectedChatId, CancellationToken cancellation) {
    byte[] ciphertext = null, plaintext = null;
    try {
      cancellation.ThrowIfCancellationRequested();
      if (envelope != null && envelope.Length > MaxRequestFrameBytes) return Failure("attachment_metadata_too_large");
      if (String.IsNullOrEmpty(envelope) || String.IsNullOrEmpty(expectedMessageId) || expectedMessageId.Length > 512 ||
          String.IsNullOrEmpty(expectedChatId) || expectedChatId.Length > 512)
        return Failure("attachment_metadata_invalid");
      IDictionary outer = ParseObject(EnvelopeJson.DeserializeObject(envelope));
      IDictionary fields;
      if (outer != null && outer.Count == 5 && IsFormat(outer, 2)) {
        // Format 2: plaintext row (columns + cells), the same cell representation the DPAPI body used.
        if (!String.Equals(outer["table"] as string, "_message", StringComparison.Ordinal) ||
            !String.Equals(outer["encoding"] as string, "plain", StringComparison.Ordinal) ||
            !IsSha256(outer["sourceDigest"] as string)) return Failure("attachment_metadata_invalid");
        fields = PlainRowFields(ParseObject(outer["row"]));
        if (fields == null) return Failure("attachment_metadata_invalid");
      } else {
        if (outer == null || outer.Count != 5 || !IsFormat(outer, 1) ||
            !String.Equals(outer["table"] as string, "_message", StringComparison.Ordinal) ||
            !String.Equals(outer["encoding"] as string, "dpapi", StringComparison.Ordinal) ||
            !IsSha256(outer["sourceDigest"] as string)) return Failure("attachment_metadata_invalid");
        string encoded = outer["data"] as string;
        if (String.IsNullOrEmpty(encoded) || encoded.Length > MaxRequestFrameBytes ||
            (ciphertext = Convert.FromBase64String(encoded)).Length > MaxEnvelopePlaintextBytes ||
            !String.Equals(Convert.ToBase64String(ciphertext), encoded, StringComparison.Ordinal))
          return Failure("attachment_metadata_invalid");
        plaintext = NativeCurrentUserProtection.Unprotect(ciphertext);
        cancellation.ThrowIfCancellationRequested();
        if (plaintext.Length > MaxEnvelopePlaintextBytes) return Failure("attachment_metadata_invalid");
        string json = StrictUtf8.GetString(plaintext);
        IDictionary inner = ParseObject(EnvelopeJson.DeserializeObject(json));
        if (inner == null || inner.Count != 3 || !HasFormatOne(inner) ||
            !String.Equals(inner["table"] as string, "_message", StringComparison.Ordinal))
          return Failure("attachment_metadata_invalid");
        fields = ParseObject(inner["fields"]);
        if (fields == null) return Failure("attachment_metadata_invalid");
      }
      string messageId = ReadTextCell(fields, "_id", true);
      string chatId = ReadTextCell(fields, "_chatId", true);
      if (!String.Equals(messageId, expectedMessageId, StringComparison.Ordinal) ||
          !String.Equals(chatId, expectedChatId, StringComparison.Ordinal)) return Failure("attachment_identity_mismatch");

      string metadataText = ReadJsonCell(fields, "_contentMetadata", MaxMetadataJsonChars);
      IDictionary metadata = metadataText == null ? null : ParseObject(MetadataJson.DeserializeObject(metadataText));
      if (metadataText != null && metadata == null) return Failure("attachment_metadata_invalid");
      string contentInfoText = ReadJsonCell(fields, "_contentInfo", MaxContentInfoJsonChars);
      IDictionary contentInfo = null;
      if (contentInfoText != null) {
        try { contentInfo = ParseObject(MetadataJson.DeserializeObject(contentInfoText)); }
        catch { contentInfo = null; }
      }

      Dictionary<string, object> safeMetadata = BuildSafeContentMetadata(metadata);
      if (safeMetadata == null) return Failure("attachment_metadata_invalid");
      string keyMaterial = ReadValidKeyMaterial(contentInfo);
      string fileName = ReadSafeFileName(contentInfo, metadata);
      long? sizeBytes = ReadSafeSize(contentInfo, metadata);
      Dictionary<string, object> result = new Dictionary<string, object> {
        { "messageId", messageId }, { "chatId", chatId },
        { "from", ReadOptionalTextCell(fields, "_from") }, { "to", ReadOptionalTextCell(fields, "_to") },
        { "toType", ReadIntCell(fields, "_toType", 0, 7) }, { "contentType", ReadIntCell(fields, "_contentType", 0, 255) },
        { "contentMetadata", safeMetadata }, { "keyMaterial", keyMaterial },
        { "fileName", fileName }, { "sizeBytes", sizeBytes.HasValue ? (object)sizeBytes.Value : null }
      };
      cancellation.ThrowIfCancellationRequested();
      if (Encoding.UTF8.GetByteCount(MetadataJson.Serialize(result)) > MaxResultFrameBytes)
        return Failure("attachment_metadata_too_large");
      return new Dictionary<string, object> { { "metadata", result }, { "errorCode", null } };
    } catch (DecoderFallbackException) { return Failure("attachment_metadata_invalid"); }
    catch (OperationCanceledException) { throw; }
    catch (Exception) { return Failure("attachment_metadata_invalid"); }
    finally {
      if (ciphertext != null) Array.Clear(ciphertext, 0, ciphertext.Length);
      if (plaintext != null) Array.Clear(plaintext, 0, plaintext.Length);
    }
  }

  static Dictionary<string, object> Failure(string code) {
    return new Dictionary<string, object> { { "metadata", null }, { "errorCode", code } };
  }

  static bool IsFormat(IDictionary value, long expected) {
    object format = value["format"];
    return format is int && (int)format == expected || format is long && (long)format == expected;
  }

  static IDictionary PlainRowFields(IDictionary row) {
    if (row == null || row.Count != 2) return null;
    IList columns = row["columns"] as IList;
    IList cells = row["cells"] as IList;
    if (columns == null || cells == null || columns.Count != cells.Count || columns.Count > 128) return null;
    Dictionary<string, object> fields = new Dictionary<string, object>(StringComparer.Ordinal);
    for (int i = 0; i < columns.Count; i++) {
      string name = columns[i] as string;
      if (String.IsNullOrEmpty(name) || fields.ContainsKey(name)) return null;
      fields.Add(name, cells[i]);
    }
    return fields;
  }

  static bool HasFormatOne(IDictionary value) {
    object format = value["format"];
    return format is int && (int)format == 1 || format is long && (long)format == 1L;
  }

  static IDictionary ParseObject(object value) { return value as IDictionary; }

  static string ReadTextCell(IDictionary fields, string name, bool required) {
    object raw;
    if (!fields.Contains(name)) {
      if (required) throw new InvalidDataException("attachment_metadata_invalid");
      return null;
    }
    raw = fields[name];
    if (raw == null) {
      if (required) throw new InvalidDataException("attachment_metadata_invalid");
      return null;
    }
    string direct = raw as string;
    if (direct != null) {
      if (direct.Length <= 512 && direct.IndexOf('\0') < 0) return direct;
      if (required) throw new InvalidDataException("attachment_metadata_invalid");
      return null;
    }
    IDictionary typed = ParseObject(raw);
    if (typed == null || !String.Equals(typed["sqliteType"] as string, "text", StringComparison.Ordinal))
      throw new InvalidDataException("attachment_metadata_invalid");
    string encoding = typed["encoding"] as string;
    string value = DecodeCellBytes(typed, encoding);
    if (value != null && value.Length <= 512 && value.IndexOf('\0') < 0) return value;
    if (required) throw new InvalidDataException("attachment_metadata_invalid");
    return null;
  }

  static string ReadOptionalTextCell(IDictionary fields, string name) {
    try { return ReadTextCell(fields, name, false); }
    catch { return null; }
  }

  static long? ReadIntCell(IDictionary fields, string name, long minimum, long maximum) {
    if (!fields.Contains(name) || fields[name] == null) return null;
    IDictionary typed = ParseObject(fields[name]);
    string value = typed == null ? null : typed["value"] as string;
    long parsed;
    if (typed == null || !String.Equals(typed["sqliteType"] as string, "integer", StringComparison.Ordinal) ||
        !Int64.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out parsed) || parsed < minimum || parsed > maximum)
      return null;
    return parsed;
  }

  static string ReadJsonCell(IDictionary fields, string name, int maximumChars) {
    if (!fields.Contains(name) || fields[name] == null) return null;
    string direct = fields[name] as string;
    string value = direct;
    if (value == null) {
      IDictionary typed = ParseObject(fields[name]);
      if (typed == null) throw new InvalidDataException("attachment_metadata_invalid");
      string sqliteType = typed["sqliteType"] as string;
      if (sqliteType != "text" && sqliteType != "blob") throw new InvalidDataException("attachment_metadata_invalid");
      value = DecodeCellBytes(typed, typed["encoding"] as string);
    }
    if (value != null && value.Length == 0) return null;
    if (value == null || value.Length > maximumChars) throw new InvalidDataException("attachment_metadata_invalid");
    return value;
  }

  static string DecodeCellBytes(IDictionary typed, string encoding) {
    if (!String.Equals(encoding, "base64", StringComparison.Ordinal))
      throw new InvalidDataException("attachment_metadata_invalid");
    string data = typed["data"] as string;
    if (data == null || data.Length > MaxContentInfoJsonChars * 2) throw new InvalidDataException("attachment_metadata_invalid");
    byte[] bytes = Convert.FromBase64String(data);
    try {
      if (!String.Equals(Convert.ToBase64String(bytes), data, StringComparison.Ordinal)) throw new InvalidDataException("attachment_metadata_invalid");
      return StrictUtf8.GetString(bytes);
    } finally { Array.Clear(bytes, 0, bytes.Length); }
  }

  static Dictionary<string, object> BuildSafeContentMetadata(IDictionary metadata) {
    string[] keys = new string[] { "OID", "SID", "OBS_POP", "FILE_SIZE", "MEDIA_CONTENT_INFO", "DOWNLOAD_URL" };
    int[] limits = new int[] { 128, 32, 256, 20, 4096, 8192 };
    Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal);
    for (int i = 0; i < keys.Length; i++) {
      object value = metadata == null ? null : metadata[keys[i]];
      if (value == null) { result.Add(keys[i], null); continue; }
      string text = value as string;
      if (text == null || text.Length > limits[i]) return null;
      result.Add(keys[i], text);
    }
    return result;
  }

  static string ReadValidKeyMaterial(IDictionary contentInfo) {
    string value = contentInfo == null ? null : contentInfo["keyMaterial"] as string;
    if (String.IsNullOrEmpty(value) || value.Length > 64) return null;
    byte[] bytes = null;
    try {
      bytes = Convert.FromBase64String(value);
      return bytes.Length == 32 && String.Equals(Convert.ToBase64String(bytes), value, StringComparison.Ordinal) ? value : null;
    } catch { return null; }
    finally { if (bytes != null) Array.Clear(bytes, 0, bytes.Length); }
  }

  static string ReadSafeFileName(IDictionary contentInfo, IDictionary metadata) {
    string value = contentInfo == null ? null : contentInfo["fileName"] as string;
    if (String.IsNullOrEmpty(value) || value.Length > 1024 || value.IndexOf('\0') >= 0)
      value = metadata == null ? null : metadata["FILE_NAME"] as string;
    return !String.IsNullOrEmpty(value) && value.Length <= 1024 && value.IndexOf('\0') < 0 ? value : null;
  }

  static long? ReadSafeSize(IDictionary contentInfo, IDictionary metadata) {
    object value = contentInfo == null ? null : (contentInfo["size"] ?? contentInfo["fileSize"]);
    long parsed;
    if (value is long) parsed = (long)value;
    else if (value is int) parsed = (int)value;
    else if (value is double && !Double.IsNaN((double)value) && !Double.IsInfinity((double)value) &&
        Math.Floor((double)value) == (double)value && (double)value >= 0 && (double)value <= 9007199254740991d) parsed = (long)(double)value;
    else if (value is decimal && (decimal)value >= 0 && (decimal)value <= 9007199254740991m &&
        Decimal.Truncate((decimal)value) == (decimal)value) parsed = Decimal.ToInt64((decimal)value);
    else if (!(value is string) || !Int64.TryParse((string)value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed)) {
      string text = metadata == null ? null : metadata["FILE_SIZE"] as string;
      if (!Int64.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out parsed)) return null;
    }
    return parsed >= 0 && parsed <= 9007199254740991L ? (long?)parsed : null;
  }

  static bool IsSha256(string value) {
    if (value == null || value.Length != 64) return false;
    for (int i = 0; i < value.Length; i++) if (!Uri.IsHexDigit(value[i])) return false;
    return true;
  }

  static string SafeAuthError(Exception error) {
    if (error is OperationCanceledException) throw error;
    string message = error is InvalidDataException || error is InvalidOperationException ? error.Message : String.Empty;
    switch (message) {
      case "source_changed": case "process_missing": case "process_ambiguous": case "process_limit":
      case "source_reparse_or_type": case "unsupported_build": case "candidate_missing": case "candidate_ambiguous":
      case "candidate_limit": case "process_unavailable": case "scan_limit":
        return message;
      default: return "auth_candidates_unavailable";
    }
  }
}
