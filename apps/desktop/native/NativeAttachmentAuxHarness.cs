using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

internal static class NativeAttachmentAuxHarness {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 32 };
  static int assertions;
  static string stage = "startup";

  static int Main() {
    try {
      stage = "envelope_projection"; TestEnvelopeProjection();
      stage = "invalid_envelopes"; TestInvalidEnvelopeCases();
      stage = "invalid_optional_content_metadata"; TestInvalidOptionalContentMetadata();
      stage = "auth_cancellation_cleanup"; TestAuthCancellationCleanup();
      stage = "oversized_output_fallback"; TestOversizedOutputFallback();
      stage = "bridge_auth_failure"; TestBridgeContinueAfterAuthFailure();
      stage = "bridge_roundtrip"; TestBridgeAttachmentRoundTrip();
      Console.WriteLine("PASS|native_attachment_aux|assertions=" + assertions);
      return 0;
    } catch (Exception error) {
      Console.WriteLine("FAIL|native_attachment_aux|" + stage + "|" + SafeFailureCode(error));
      return 1;
    } finally { ResetAuthHooks(); }
  }

  static void TestEnvelopeProjection() {
    string json = "{\"OID\":\"oid-value\",\"SID\":\"m\",\"OBS_POP\":\"talk\",\"FILE_SIZE\":\"42\",\"MEDIA_CONTENT_INFO\":\"opaque\",\"DOWNLOAD_URL\":\"https://example.invalid/a\",\"UNRELATED\":\"must-not-leak\"}";
    string info = "{\"keyMaterial\":\"" + Convert.ToBase64String(new byte[32]) + "\",\"fileName\":\"fixture.bin\",\"size\":42}";
    string envelope = BuildEnvelope("_message", new Dictionary<string, NativeSourceCell> {
      { "_id", Text("message-1") }, { "_chatId", Text("chat-1") }, { "_from", Text("sender-1") },
      { "_to", Null() }, { "_toType", Integer(2) }, { "_contentType", Integer(7) },
      { "_contentMetadata", Text(json) }, { "_contentInfo", Blob(info) }
    });
    IDictionary response = AsObject(NativeAttachmentOperations.DecodeAttachmentEnvelope(envelope, "message-1", "chat-1", default(System.Threading.CancellationToken)));
    Equal(null, response["errorCode"], "valid envelope error");
    IDictionary metadata = AsObject(response["metadata"]);
    Equal("message-1", metadata["messageId"], "message id");
    Equal("chat-1", metadata["chatId"], "chat id");
    Equal(null, metadata["to"], "missing destination remains null");
    Equal(2L, Convert.ToInt64(metadata["toType"]), "destination type");
    Equal(7L, Convert.ToInt64(metadata["contentType"]), "content type");
    Equal(Convert.ToBase64String(new byte[32]), metadata["keyMaterial"], "32-byte key material");
    Equal("fixture.bin", metadata["fileName"], "file name");
    Equal(42L, Convert.ToInt64(metadata["sizeBytes"]), "size");
    IDictionary projected = AsObject(metadata["contentMetadata"]);
    Equal("m", projected["SID"], "sid");
    Equal(null, projected["UNRELATED"], "unknown metadata excluded");
    True(Encoding.UTF8.GetByteCount(Json.Serialize(response)) <= NativeAttachmentOperations.MaxResultFrameBytes, "response cap");

    string blobMetadata = "{\"OID\":\"blob-oid\"}";
    string blobEnvelope = BuildEnvelope("_message", new Dictionary<string, NativeSourceCell> {
      { "_id", Text("message-blob") }, { "_chatId", Text("chat-1") },
      { "_contentMetadata", Blob(blobMetadata) }, { "_contentInfo", Text("{}") }
    });
    IDictionary blobResponse = AsObject(NativeAttachmentOperations.DecodeAttachmentEnvelope(blobEnvelope, "message-blob", "chat-1", default(System.Threading.CancellationToken)));
    Equal(null, blobResponse["errorCode"], "blob json accepted");
    Equal("blob-oid", AsObject(AsObject(blobResponse["metadata"])["contentMetadata"])["OID"], "blob json projected");

    string plainEnvelope = BuildEnvelope("_message", new Dictionary<string, NativeSourceCell> {
      { "_id", Text("plain-message") }, { "_chatId", Text("plain-chat") },
      { "_contentMetadata", Text("") }, { "_contentInfo", Blob("") }
    });
    IDictionary plainResponse = AsObject(NativeAttachmentOperations.DecodeAttachmentEnvelope(plainEnvelope, "plain-message", "plain-chat", default(System.Threading.CancellationToken)));
    Equal(null, plainResponse["errorCode"], "empty plain metadata accepted");
    Equal(null, AsObject(plainResponse["metadata"])["keyMaterial"], "plain attachment has no key material");

    // Format 1 (DPAPI) envelopes imported before the plaintext change must keep working for downloads.
    string legacyEnvelope = BuildDpapiEnvelope("_message", new Dictionary<string, NativeSourceCell> {
      { "_id", Text("legacy-message") }, { "_chatId", Text("legacy-chat") }, { "_toType", Integer(2) }, { "_contentType", Integer(7) },
      { "_contentMetadata", Text(json) }, { "_contentInfo", Blob(info) }
    });
    True(legacyEnvelope.Contains("\"encoding\":\"dpapi\""), "legacy fixture is format 1 dpapi");
    IDictionary legacyResponse = AsObject(NativeAttachmentOperations.DecodeAttachmentEnvelope(legacyEnvelope, "legacy-message", "legacy-chat", default(System.Threading.CancellationToken)));
    Equal(null, legacyResponse["errorCode"], "dpapi envelope accepted");
    IDictionary legacyMetadata = AsObject(legacyResponse["metadata"]);
    Equal(Convert.ToBase64String(new byte[32]), legacyMetadata["keyMaterial"], "dpapi key material");
    Equal(7L, Convert.ToInt64(legacyMetadata["contentType"]), "dpapi content type");
    Equal("oid-value", AsObject(legacyMetadata["contentMetadata"])["OID"], "dpapi metadata projected");
    IDictionary legacyMismatch = AsObject(NativeAttachmentOperations.DecodeAttachmentEnvelope(legacyEnvelope, "other-message", "legacy-chat", default(System.Threading.CancellationToken)));
    Equal("attachment_identity_mismatch", legacyMismatch["errorCode"], "dpapi identity mismatch");
  }

  static void TestInvalidEnvelopeCases() {
    string envelope = BuildEnvelope("_message", new Dictionary<string, NativeSourceCell> {
      { "_id", Text("expected") }, { "_chatId", Text("chat") }, { "_contentMetadata", Text("{\"OID\":7}") }
    });
    Equal("attachment_identity_mismatch", Error(NativeAttachmentOperations.DecodeAttachmentEnvelope(envelope, "wrong", "chat", default(System.Threading.CancellationToken))), "wrong message id");
    Equal("attachment_identity_mismatch", Error(NativeAttachmentOperations.DecodeAttachmentEnvelope(envelope, "expected", "wrong", default(System.Threading.CancellationToken))), "wrong chat id");
    Equal("attachment_metadata_invalid", Error(NativeAttachmentOperations.DecodeAttachmentEnvelope(envelope, "expected", "chat", default(System.Threading.CancellationToken))), "invalid routing metadata rejects attachment projection");
    string malformedJson = BuildEnvelope("_message", new Dictionary<string, NativeSourceCell> {
      { "_id", Text("expected") }, { "_chatId", Text("chat") }, { "_contentMetadata", Text("{malformed") }
    });
    Equal("attachment_metadata_invalid", Error(NativeAttachmentOperations.DecodeAttachmentEnvelope(malformedJson, "expected", "chat", default(System.Threading.CancellationToken))), "malformed metadata json");
    string wrongTable = BuildEnvelope("_contact", new Dictionary<string, NativeSourceCell> {
      { "_id", Text("expected") }, { "_chatId", Text("chat") }
    });
    Equal("attachment_metadata_invalid", Error(NativeAttachmentOperations.DecodeAttachmentEnvelope(wrongTable, "expected", "chat", default(System.Threading.CancellationToken))), "wrong table");
    Equal("attachment_metadata_too_large", Error(NativeAttachmentOperations.DecodeAttachmentEnvelope(new string('x', NativeAttachmentOperations.MaxRequestFrameBytes + 1), "m", "c", default(System.Threading.CancellationToken))), "request cap");
    using (System.Threading.CancellationTokenSource canceled = new System.Threading.CancellationTokenSource()) {
      canceled.Cancel(); bool observed = false;
      try { NativeAttachmentOperations.DecodeAttachmentEnvelope(envelope, "expected", "chat", canceled.Token); }
      catch (OperationCanceledException) { observed = true; }
      True(observed, "metadata cancellation propagates");
    }
  }

  static void TestInvalidOptionalContentMetadata() {
    string[] keys = new string[] { "DOWNLOAD_URL", "OID", "SID" };
    int[] limits = new int[] { 8192, 128, 32 };
    for (int i = 0; i < keys.Length; i++) {
      AssertInvalidContentMetadata(keys[i], 7L, "non-string " + keys[i]);
      AssertInvalidContentMetadata(keys[i], new string('x', limits[i] + 1), "oversized " + keys[i]);
    }
    string nullEnvelope = BuildEnvelope("_message", new Dictionary<string, NativeSourceCell> {
      { "_id", Text("null-metadata-message") }, { "_chatId", Text("null-metadata-chat") },
      { "_contentMetadata", Text("{\"DOWNLOAD_URL\":null,\"OID\":null,\"SID\":null}") },
      { "_contentInfo", Text("{}") }
    });
    IDictionary nullResponse = AsObject(NativeAttachmentOperations.DecodeAttachmentEnvelope(
      nullEnvelope, "null-metadata-message", "null-metadata-chat", default(System.Threading.CancellationToken)));
    Equal(null, nullResponse["errorCode"], "explicit null optional metadata accepted");
    IDictionary nullProjection = AsObject(AsObject(nullResponse["metadata"])["contentMetadata"]);
    Equal(null, nullProjection["DOWNLOAD_URL"], "explicit null url preserved as null");
    Equal(null, nullProjection["OID"], "explicit null oid preserved as null");
    Equal(null, nullProjection["SID"], "explicit null sid preserved as null");
  }

  static void AssertInvalidContentMetadata(string key, object value, string label) {
    Dictionary<string, object> sourceMetadata = new Dictionary<string, object>(StringComparer.Ordinal);
    sourceMetadata.Add(key, value);
    string envelope = BuildEnvelope("_message", new Dictionary<string, NativeSourceCell> {
      { "_id", Text("metadata-message") }, { "_chatId", Text("metadata-chat") },
      { "_contentMetadata", Text(Json.Serialize(sourceMetadata)) }, { "_contentInfo", Text("{}") }
    });
    IDictionary response = AsObject(NativeAttachmentOperations.DecodeAttachmentEnvelope(
      envelope, "metadata-message", "metadata-chat", default(System.Threading.CancellationToken)));
    Equal("attachment_metadata_invalid", response["errorCode"], label + " controlled error");
    Equal(null, response["metadata"], label + " no route metadata");
  }

  static void TestAuthCancellationCleanup() {
    ResetAuthHooks(); FakeEnvironment environment = new FakeEnvironment(true, false);
    OfficialSourceInventoryResult source = OfficialSourceInventory.Inspect(FixtureRoot(), OfficialSourceInventory.SupportedBuildVersion,
      OfficialSourceInventory.SupportedBuildBytes, OfficialSourceInventory.SupportedBuildSha256, environment, true);
    byte[] bytes = Encoding.ASCII.GetBytes("GET / HTTP/1.1\r\nX-LINE-ACCESS: cancel-token\r\nX-LINE-APPLICATION: DESKTOPWIN\tfixture\r\n\r\n");
    System.Threading.CancellationTokenSource cancellation = new System.Threading.CancellationTokenSource(); int closed = 0;
    OfficialSourceHeaderProbe.TestMaxScanBytes = bytes.Length;
    OfficialSourceHeaderProbe.TestQueryRegion = delegate(long address) {
      if (address != 0) return null;
      return new OfficialSourceHeaderProbe.MemoryRegion { BaseAddress = IntPtr.Zero, RegionSize = new UIntPtr((uint)bytes.Length), State = 0x1000, Type = 0x20000, Protect = 4 };
    };
    OfficialSourceHeaderProbe.TestReadMemory = delegate(long address, byte[] buffer) { cancellation.Cancel(); Buffer.BlockCopy(bytes, 0, buffer, 0, bytes.Length); return bytes.Length; };
    OfficialSourceHeaderProbe.TestOpenReader = delegate { return new IntPtr(456); };
    OfficialSourceHeaderProbe.TestCloseReader = delegate(IntPtr handle) { closed++; };
    bool observed = false;
    try { NativeAttachmentOperations.FindAuthCandidates(source, environment, cancellation.Token); }
    catch (OperationCanceledException) { observed = true; }
    finally { cancellation.Dispose(); Array.Clear(bytes, 0, bytes.Length); ResetAuthHooks(); }
    True(observed, "auth cancellation propagates"); Equal(1, closed, "auth reader closed after cancellation");
  }

  static void TestBridgeContinueAfterAuthFailure() {
    ResetAuthHooks();
    FakeEnvironment environment = new FakeEnvironment(true, true);
    byte[] requests = JoinFrames(
      Frame(1, "auth_candidates", new Dictionary<string, object>()),
      Frame(2, "poll", new Dictionary<string, object>()),
      Frame(3, "ack", AckFields()));
    string[] result = ExternalReaderBridge.FixtureRunDirectMonitorAuxWire("fixture-request", FixtureRoot(), environment,
      "fixture-mid", requests, 1, "digest", null);
    IList frames = (IList)Json.DeserializeObject("[" + result[0].Replace("}\n{", "},{") + "]");
    True(frames.Count == 1, "auth failure emits one response");
    IDictionary response = AsObject(frames[0]);
    Equal("auth_candidates", response["type"], "auth response type");
    Equal("process_missing", response["errorCode"], "safe auth error");
    Equal("poll", AsObject(Json.DeserializeObject(result[1]))["type"], "normal poll follows failed auth");
    Equal("1", result[2], "ack accepted after auth failure");
  }

  static void TestOversizedOutputFallback() {
    string body = ExternalReaderBridge.FixtureRunOversizedAuxiliaryEmission("fixture-request");
    True(Encoding.UTF8.GetByteCount(body) <= NativeAttachmentOperations.MaxResultFrameBytes, "oversize result replaced within frame cap");
    IDictionary frame = AsObject(Json.DeserializeObject(body));
    Equal("attachment_metadata_unavailable", frame["errorCode"], "safe output fallback error");
    Equal(null, frame["metadata"], "oversize payload omitted");
  }

  static void TestBridgeAttachmentRoundTrip() {
    ResetAuthHooks();
    FakeEnvironment environment = new FakeEnvironment(true, false);
    byte[] header = Encoding.ASCII.GetBytes("GET / HTTP/1.1\r\nX-LINE-ACCESS: fixture-token\r\nX-LINE-APPLICATION: DESKTOPWIN\tfixture\r\n\r\n");
    OfficialSourceHeaderProbe.TestMaxScanBytes = header.Length;
    OfficialSourceHeaderProbe.TestQueryRegion = delegate(long address) {
      if (address != 0) return null;
      return new OfficialSourceHeaderProbe.MemoryRegion {
        BaseAddress = IntPtr.Zero, RegionSize = new UIntPtr((uint)header.Length), State = 0x1000, Type = 0x20000, Protect = 4
      };
    };
    OfficialSourceHeaderProbe.TestReadMemory = delegate(long address, byte[] buffer) {
      Buffer.BlockCopy(header, 0, buffer, 0, header.Length); return header.Length;
    };
    OfficialSourceHeaderProbe.TestOpenReader = delegate { return new IntPtr(123); };
    OfficialSourceHeaderProbe.TestCloseReader = delegate(IntPtr handle) { True(handle.ToInt64() == 123, "auth handle closed"); };

    string envelope = BuildEnvelope("_message", new Dictionary<string, NativeSourceCell> {
      { "_id", Text("message-bridge") }, { "_chatId", Text("chat-bridge") },
      { "_contentMetadata", Text("{\"OID\":\"bridge-oid\"}") }, { "_contentInfo", Text("{}") }
    });
    byte[] requests = JoinFrames(
      Frame(1, "auth_candidates", new Dictionary<string, object>()),
      Frame(2, "attachment_metadata", new Dictionary<string, object> {
        { "envelope", Json.DeserializeObject(envelope) }, { "expectedMessageId", "message-bridge" }, { "expectedChatId", "chat-bridge" }
      }),
      Frame(3, "poll", new Dictionary<string, object>()),
      Frame(4, "ack", AckFields()));
    string[] result = ExternalReaderBridge.FixtureRunDirectMonitorAuxWire("fixture-request", FixtureRoot(), environment,
      "fixture-mid", requests, 1, "digest", null);
    IList frames = (IList)Json.DeserializeObject("[" + result[0].Replace("}\n{", "},{") + "]");
    Equal(2, frames.Count, "both auxiliary commands answered");
    IDictionary auth = AsObject(frames[0]);
    Equal("auth_candidates", auth["type"], "auth response type");
    IList candidates = (IList)auth["candidates"];
    Equal(1, candidates.Count, "one auth candidate");
    Equal("fixture-token", AsObject(candidates[0])["token"], "auth token");
    IDictionary attachment = AsObject(frames[1]);
    Equal("attachment_metadata", attachment["type"], "attachment response type");
    Equal(null, attachment["errorCode"], "attachment response error");
    Equal("message-bridge", AsObject(attachment["metadata"])["messageId"], "attachment message identity");
    Equal("poll", AsObject(Json.DeserializeObject(result[1]))["type"], "poll resumes after aux responses");
    Equal("1", result[2], "ack accepted after auxiliary responses");
    Array.Clear(header, 0, header.Length);
  }

  static Dictionary<string, object> AckFields() {
    return new Dictionary<string, object> { { "pageNumber", 1 }, { "batchDigest", "digest" }, { "lastCursor", null } };
  }
  static byte[] Frame(int sequence, string type, Dictionary<string, object> fields) {
    Dictionary<string, object> frame = new Dictionary<string, object> {
      { "version", 1 }, { "requestId", "fixture-request" }, { "sequence", sequence }, { "type", type }
    };
    foreach (KeyValuePair<string, object> field in fields) frame.Add(field.Key, field.Value);
    byte[] body = Encoding.UTF8.GetBytes(Json.Serialize(frame));
    byte[] output = new byte[body.Length + 4];
    output[0] = (byte)(body.Length >> 24); output[1] = (byte)(body.Length >> 16); output[2] = (byte)(body.Length >> 8); output[3] = (byte)body.Length;
    Buffer.BlockCopy(body, 0, output, 4, body.Length); Array.Clear(body, 0, body.Length); return output;
  }
  static byte[] JoinFrames(params byte[][] frames) {
    int size = 0; foreach (byte[] frame in frames) size += frame.Length;
    byte[] output = new byte[size]; int offset = 0;
    foreach (byte[] frame in frames) { Buffer.BlockCopy(frame, 0, output, offset, frame.Length); offset += frame.Length; Array.Clear(frame, 0, frame.Length); }
    return output;
  }
  static string BuildEnvelope(string table, Dictionary<string, NativeSourceCell> values) {
    string[] columns = new string[values.Count]; NativeSourceCell[] cells = new NativeSourceCell[values.Count]; int index = 0;
    foreach (KeyValuePair<string, NativeSourceCell> item in values) { columns[index] = item.Key; cells[index++] = item.Value; }
    return new NativeSourceRow(table, columns, cells).PlainEnvelopeJson();
  }
  // The pre-plaintext (format 1) shape: DPAPI-protected {format, table, fields} behind a digest header.
  static string BuildDpapiEnvelope(string table, Dictionary<string, NativeSourceCell> values) {
    string[] columns = new string[values.Count]; NativeSourceCell[] cells = new NativeSourceCell[values.Count]; int index = 0;
    foreach (KeyValuePair<string, NativeSourceCell> item in values) { columns[index] = item.Key; cells[index++] = item.Value; }
    NativeSourceRow row = new NativeSourceRow(table, columns, cells);
    string digest = row.SourceDigest();
    Dictionary<string, object> fields = new Dictionary<string, object>(StringComparer.Ordinal);
    for (int i = 0; i < columns.Length; i++) fields.Add(columns[i], cells[i].SourceJsonValue());
    byte[] plaintext = Encoding.UTF8.GetBytes(Json.Serialize(new Dictionary<string, object> { { "format", 1 }, { "table", table }, { "fields", fields } }));
    byte[] protectedBytes = NativeCurrentUserProtection.Protect(plaintext);
    return Json.Serialize(new Dictionary<string, object> { { "format", 1 }, { "table", table }, { "sourceDigest", digest },
      { "encoding", "dpapi" }, { "data", Convert.ToBase64String(protectedBytes) } });
  }
  static NativeSourceCell Text(string value) { return new NativeSourceCell(3, 0, 0, Encoding.UTF8.GetBytes(value)); }
  static NativeSourceCell Blob(string value) { return new NativeSourceCell(4, 0, 0, Encoding.UTF8.GetBytes(value)); }
  static NativeSourceCell Integer(long value) { return new NativeSourceCell(1, value, 0, null); }
  static NativeSourceCell Null() { return new NativeSourceCell(5, 0, 0, null); }
  static IDictionary AsObject(object value) { IDictionary result = value as IDictionary; if (result == null) throw new InvalidDataException("fixture_assertion"); return result; }
  static string Error(Dictionary<string, object> result) { return result["errorCode"] as string; }
  static void Equal(object expected, object actual, string label) { assertions++; if (!Object.Equals(expected, actual)) throw new InvalidDataException("assert_" + label.Replace(' ', '_')); }
  static void True(bool condition, string label) { assertions++; if (!condition) throw new InvalidDataException("assert_" + label.Replace(' ', '_')); }
  static string SafeFailureCode(Exception error) {
    string message = error is InvalidDataException ? error.Message : String.Empty;
    return message.Length > 0 && message.Length <= 80 && System.Text.RegularExpressions.Regex.IsMatch(message, "^[a-z_]+$")
      ? message : error.GetType().Name;
  }
  static string FixtureRoot() { return Path.Combine(Path.GetTempPath(), "linejs-native-aux-fixture"); }
  static void ResetAuthHooks() {
    OfficialSourceHeaderProbe.TestQueryRegion = null; OfficialSourceHeaderProbe.TestReadMemory = null;
    OfficialSourceHeaderProbe.TestVerifyHandle = null; OfficialSourceHeaderProbe.TestOpenReader = null;
    OfficialSourceHeaderProbe.TestCloseReader = null; OfficialSourceHeaderProbe.TestMaxScanBytes = 0;
    OfficialSourceHeaderProbe.TestMaxCandidateCount = 0;
  }

  sealed class FakeEnvironment : IOfficialSourceInventoryEnvironment {
    readonly bool hasProcess;
    readonly bool failAfterInitialInventory;
    int processEnumerationCount;
    readonly string root = FixtureRoot();
    readonly string executable;
    readonly string database;
    internal FakeEnvironment(bool hasProcess, bool failAfterInitialInventory) {
      this.hasProcess = hasProcess; this.failAfterInitialInventory = failAfterInitialInventory;
      executable = Path.Combine(root, "bin", "current", "LINE.exe");
      database = Path.Combine(root, "Data", "db", "messages.edb");
    }
    public string[] EnumerateDatabaseFiles(string directory) { return new string[] { database }; }
    public OfficialSourceFileIdentity InspectFile(string path, bool allowMissing) {
      if (path.EndsWith("-wal", StringComparison.OrdinalIgnoreCase) || path.EndsWith("-shm", StringComparison.OrdinalIgnoreCase)) return null;
      return new OfficialSourceFileIdentity { Path = path, Length = path == executable ? OfficialSourceInventory.SupportedBuildBytes : 1024,
        LastWriteTicks = 10, FileId = path == executable ? "fixture-exe" : "fixture-db", IsRegular = true };
    }
    public bool IsReparsePoint(string path) { return false; }
    public string HashFile(string path) { return OfficialSourceInventory.SupportedBuildSha256; }
    public int[] GetCandidateProcessIds() {
      processEnumerationCount++;
      return hasProcess && !(failAfterInitialInventory && processEnumerationCount > 1) ? new int[] { 1234 } : new int[0];
    }
    public long GetMatchingLineProcessCreationTime(int processId, string executablePath) { return hasProcess && processId == 1234 ? 99 : 0; }
  }
}
