using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class SqliteFixtureHarness {
  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    AssertNativeSourceArchiveRoundTrip();
    if (args.Length == 2 && args[0] == "--probe") return Probe(args[1], false);
    if (args.Length == 2 && args[0] == "--probe-zero-key") return Probe(args[1], true);
    bool largeFixture = args.Length == 2 && args[0] == "--snapshot-hold-large";
    bool snapshotHold = largeFixture || (args.Length == 2 && args[0] == "--snapshot-hold");
    bool hold = snapshotHold || (args.Length == 2 && args[0] == "--hold");
    bool keyset = args.Length == 1 && args[0] == "--keyset";
    if (args.Length != 0 && !hold && !keyset) return 2;
    string root = hold ? Path.GetFullPath(args[1]) : Path.Combine(Path.GetTempPath(), "linejs-sqlite-fixture-" + Guid.NewGuid().ToString("N"));
    string lineRoot = Path.Combine(root, "LINE");
    string databaseDirectory = Path.Combine(lineRoot, "Data", "db");
    Directory.CreateDirectory(databaseDirectory);
    Directory.CreateDirectory(root);
    string database = hold ? Path.Combine(databaseDirectory, "messages.edb") : Path.Combine(root, "fixture.edb");
    byte[] key = System.Text.Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");
    Sqlite3Mc writer = null;
    string[] initialRows = null;
    string stage = "writer_open";
    try {
      writer = Sqlite3Mc.OpenFixtureWriter(database, key);
      stage = "fixture_write";
      writer.CreateFixtureWal();
      if (largeFixture) writer.CreateFixtureBackupPayload(64 * 1024 * 1024); // >64 MiB main DB so a snapshot copy would be slow
      // Closing once establishes a valid encrypted EDB base page; reopening
      // and committing a no-op transaction leaves a synthetic committed WAL.
      writer.Dispose(); writer = null;
      writer = Sqlite3Mc.OpenFixtureWriter(database, key);
      if (snapshotHold) writer.SetFixtureWalOnlyValue();
      else writer.TouchFixtureWalWithoutChangingRows();
      stage = "encrypted_first_page_validation";
      string pageValidationStage;
      if (!LineEncryptedPageValidator.FirstPageValid(database, key, out pageValidationStage)) throw new InvalidOperationException("FIRST_PAGE_KEY_REJECTED_" + pageValidationStage);
      byte[] wrongFirstPageKey = Encoding.ASCII.GetBytes("00000000000000000000000000000000");
      try {
        if (LineEncryptedPageValidator.FirstPageValid(database, wrongFirstPageKey)) throw new InvalidOperationException("FIRST_PAGE_WRONG_KEY_ACCEPTED");
      } finally { Array.Clear(wrongFirstPageKey, 0, wrongFirstPageKey.Length); }
      stage = "source_inventory";
      string wal = database + "-wal";
      if (!File.Exists(database) || !File.Exists(wal) || !File.Exists(database + "-shm")) throw new InvalidOperationException("FIXTURE_WAL_NOT_CREATED");
      byte[] databaseBefore = Hash(database);
      byte[] walBefore = Hash(wal);
      stage = "readonly_open";
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(database, key)) {
        stage = "schema_verify";
        if (!reader.VerifySchemaReadable()) throw new InvalidOperationException("FIXTURE_SCHEMA_UNREADABLE");
        stage = "mid_verify";
        if (!reader.VerifyLineProfileMid("fixture-own-mid")) throw new InvalidOperationException("FIXTURE_MID_MISMATCH");
        if (reader.VerifyLineProfileMid("fixture-other-mid")) throw new InvalidOperationException("FIXTURE_WRONG_MID_ACCEPTED");
        stage = "own_display_name_profile_precedence";
        if (reader.ReadOwnDisplayName("fixture-own-mid") != "Fixture Profile Owner") throw new InvalidOperationException("OWN_DISPLAY_NAME_PROFILE_MISMATCH");
        string ownPicture;
        reader.ReadOwnIdentity("fixture-own-mid", out ownPicture);
        if (ownPicture != "/own-picture") throw new InvalidOperationException("OWN_PICTURE_PATH_MISMATCH");
        writer.SetFixtureOwnDisplayName("");
        if (reader.ReadOwnDisplayName("fixture-own-mid") != "Fixture Owner") throw new InvalidOperationException("OWN_DISPLAY_NAME_EMPTY_PROFILE_FALLBACK_MISMATCH");
        writer.SetFixtureProfileWithoutDisplayName();
        if (reader.ReadOwnDisplayName("fixture-own-mid") != "Fixture Owner") throw new InvalidOperationException("OWN_DISPLAY_NAME_MISSING_COLUMN_FALLBACK_MISMATCH");
        writer.RemoveFixtureOwnContact();
        if (reader.ReadOwnDisplayName("fixture-own-mid") != null) throw new InvalidOperationException("OWN_DISPLAY_NAME_MISSING_BOTH_NOT_NULL");
        writer.RestoreFixtureOwnProfileAndContact();
        databaseBefore = Hash(database);
        walBefore = Hash(wal);
        stage = "native_order_contract";
        initialRows = reader.ReadFixtureMessageOrder(100);
        AssertOrder(initialRows, new string[] { "m-10|1000|latest by id 臺灣😀", "m-02|1000|second", "m-01|1000|first", "m-03|999|older" });
        AssertOrder(reader.ReadFixtureMessageOrder(2), new string[] { "m-10|1000|latest by id 臺灣😀", "m-02|1000|second" });
        stage = "keyset_import_bounds_and_equal_timestamp_cursor";
        string[] directKind = reader.ReadMessageConversationKind("fixture-chat");
        string[] groupKind = reader.ReadMessageConversationKind("fixture-group");
        string[] unknownKind = reader.ReadMessageConversationKind("fixture-unknown");
        if (directKind[0] != "direct" || directKind[1] != "midType:0" || groupKind[0] != "group" || groupKind[1] != "midType:2" ||
            unknownKind[0] != "room" || unknownKind[1] != "midType:9")
          throw new InvalidOperationException("CONVERSATION_KIND_MAPPING_MISMATCH");
        object[] bounds = reader.ReadMessageSnapshotBounds();
        if ((long)bounds[0] != 4 || (string)bounds[1] != "1000" || (string)bounds[2] != "m-10") throw new InvalidOperationException("SOURCE_BOUNDS_MISMATCH");
        bool more;
        string lastTime, lastId;
        string[] firstImportPage = reader.ReadMessageKeysetPage(null, null, 2, out more, out lastTime, out lastId);
        if (!more || firstImportPage.Length != 2 || !firstImportPage[0].Contains("\"nativeMessageId\":\"m-03\"") || !firstImportPage[1].Contains("\"nativeMessageId\":\"m-01\""))
          throw new InvalidOperationException("KEYSET_FIRST_PAGE_MISMATCH");
        string[] replayedPage = reader.ReadMessageKeysetPage(null, null, 2, out more, out lastTime, out lastId);
        AssertSameProjectionOrder(replayedPage, firstImportPage);
        string[] equalTimestampNext = reader.ReadMessageKeysetPage("1000", "m-02", 2, out more, out lastTime, out lastId);
        if (more || equalTimestampNext.Length != 1 || !equalTimestampNext[0].Contains("\"nativeMessageId\":\"m-10\""))
          throw new InvalidOperationException("KEYSET_EQUAL_TIMESTAMP_CURSOR_MISMATCH");
        stage = "initial_import_500_and_live_100_bounds";
        string[] initial500 = reader.ReadMessageKeysetPage(null, null, 500, out more, out lastTime, out lastId,
          false, false, null, null, true);
        if (initial500.Length != 4 || more || lastId != "m-10") throw new InvalidOperationException("KEYSET_INITIAL_500_MISMATCH");
        bool initial501Rejected = false;
        try { reader.ReadMessageKeysetPage(null, null, 501, out more, out lastTime, out lastId, false, false, null, null, true); }
        catch (InvalidOperationException error) { initial501Rejected = error.Message == "SOURCE_PAGE_INVALID"; }
        if (!initial501Rejected) throw new InvalidOperationException("KEYSET_INITIAL_501_ACCEPTED");
        bool live101Rejected = false;
        try { reader.ReadMessageKeysetPage(null, null, 101, out more, out lastTime, out lastId); }
        catch (InvalidOperationException error) { live101Rejected = error.Message == "SOURCE_PAGE_INVALID"; }
        if (!live101Rejected) throw new InvalidOperationException("KEYSET_LIVE_101_ACCEPTED");
        stage = "bounded_read_contract";
        bool oversizedLimitRejected = false;
        try { reader.ReadFixtureMessageOrder(101); }
        catch (InvalidOperationException error) { oversizedLimitRejected = error.Message == "FIXTURE_LIMIT_INVALID"; }
        if (!oversizedLimitRejected) throw new InvalidOperationException("FIXTURE_LIMIT_NOT_ENFORCED");
        stage = "initial_reads_unchanged_source";
        AssertSourceUnchanged(database, wal, databaseBefore, walBefore);
        if (!hold) {
          stage = "private_first_import_snapshot";
          string snapshotDatabase = CopyFixtureSnapshot(root, database, wal);
          byte[] snapshotDatabaseHash = Hash(snapshotDatabase);
          byte[] snapshotWalHash = Hash(snapshotDatabase + "-wal");
          using (Sqlite3Mc snapshotReader = Sqlite3Mc.OpenReadOnly(snapshotDatabase, key)) {
            if (!snapshotReader.VerifySchemaReadable()) throw new InvalidOperationException("FIXTURE_SNAPSHOT_SCHEMA_UNREADABLE");
            AssertOrder(snapshotReader.ReadFixtureMessageOrder(100), initialRows);
          stage = "live_wal_growth";
          writer.InsertFixtureGrowthMessage();
          // Establish the second read-only interval after the intentional writer commit.
          databaseBefore = Hash(database);
          walBefore = Hash(wal);
          stage = "growth_read";
          AssertOrder(reader.ReadFixtureMessageOrder(100), new string[] { "m-11|1000|growth", "m-10|1000|latest by id 臺灣😀", "m-02|1000|second", "m-01|1000|first", "m-03|999|older" });
          // Later reads use the live source; the first-import copy remains fixed.
          AssertOrder(snapshotReader.ReadFixtureMessageOrder(100), initialRows);
          stage = "growth_read_unchanged_source";
          AssertSourceUnchanged(database, wal, databaseBefore, walBefore);
          if (!Equal(snapshotDatabaseHash, Hash(snapshotDatabase)) || !Equal(snapshotWalHash, Hash(snapshotDatabase + "-wal"))) throw new InvalidOperationException("FIXTURE_SNAPSHOT_CHANGED");
          }
        }
        if (keyset) {
          stage = "native_social_conversation_adaptation";
          writer.InsertFixtureSocialRows();
          stage = "native_catalog_paging_and_ack";
          AssertNativeCatalogPager(reader);
          stage = "native_catalog_bridge_wire";
          AssertNativeCatalogBridgeWire();
          stage = "native_directory_pass";
          stage = "native_directory_degraded_schema";
          AssertNativeDirectoryDegradedSchema(reader);
          stage = "native_directory_full_schema";
          AssertNativeDirectoryPass(root, key);
          stage = "native_directory_json_names";
          AssertNativeDirectoryJsonNames(root, key);
          stage = "native_directory_bridge_wire";
          AssertNativeDirectoryBridgeWire();
          System.Collections.Generic.List<string> scanProgress = new System.Collections.Generic.List<string>();
          reader.EnableScanProgress(CancellationToken.None, delegate(string phase, long steps) {
            scanProgress.Add(phase + "|" + steps.ToString(System.Globalization.CultureInfo.InvariantCulture));
          }, 1);
          object[] progressBounds = reader.ReadMessageSnapshotBounds();
          if ((long)progressBounds[0] < 6) throw new InvalidOperationException("SCAN_PROGRESS_BOUNDS_MISMATCH");
          databaseBefore = Hash(database); walBefore = Hash(wal);
          string[] classifiedPage = reader.ReadMessageKeysetPage("1000", "m-11", 100, out more, out lastTime, out lastId);
          AssertScanProgress(scanProgress);
          if (more || classifiedPage.Length != 31) throw new InvalidOperationException("IMPORT_CONVERSATION_ROW_COUNT_MISMATCH");
          // Content-type parsing moved out of the reader: it emits only routing kinds and the plaintext row; the TypeScript bridge converts.
          foreach (string row in classifiedPage) {
            if (row.Contains("\"content\":") || row.Contains("\"replyToMessageId\"")) throw new InvalidOperationException("IMPORT_READER_PARSED_CONTENT");
          }
          if (!ContainsRow(classifiedPage, "m-content-contact", "\"kind\":\"contact\"", "u-fixture", "Fixture Friend")) throw new InvalidOperationException("IMPORT_CONTENT_CONTACT_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-content-rich", "\"kind\":\"event\"", "Rich card", "secret payload ignored")) throw new InvalidOperationException("IMPORT_CONTENT_RICH_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-content-video", "\"kind\":\"video\"", "12345")) throw new InvalidOperationException("IMPORT_CONTENT_MEDIA_MISMATCH");
          foreach (string systemType in new string[] { "6", "9", "16" }) {
            if (!ContainsRow(classifiedPage, "m-content-event-" + systemType, "\"kind\":\"event\"", "\"encoding\":\"plain\"")) throw new InvalidOperationException("IMPORT_CONTENT_EVENT_MISMATCH");
          }
          if (!ContainsRow(classifiedPage, "m-community", "\"nativePayload\":{\"format\":2,\"table\":\"_message\",\"sourceDigest\":"))
            throw new InvalidOperationException("IMPORT_NATIVE_SOURCE_ENVELOPE_MISSING");
          if (!ContainsRow(classifiedPage, "m-direct", "\"chatType\":\"group\"", "\"nativeConversationKind\":\"midType:2\"", "\"readonlyForSending\":false")) throw new InvalidOperationException("IMPORT_PRIMARY_TOTYPE_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-group", "\"chatType\":\"group\"", "\"nativeConversationKind\":\"midType:2\"", "\"conversationTitle\":null", "\"readonlyForSending\":false")) throw new InvalidOperationException("IMPORT_MISSING_GROUP_CATALOG_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-primary", "\"chatType\":\"direct\"", "\"nativeConversationKind\":\"midType:0\"", "\"readonlyForSending\":false")) throw new InvalidOperationException("IMPORT_CATALOG_FALLBACK_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-community", "\"chatType\":\"community\"", "\"conversationTitle\":\"Fixture Square Chat\"", "\"communityId\":\"fixture-square\"", "\"senderName\":\"Square Alias\"", "\"senderPicturePath\":\"senderobs-hash-fixture12345678\"", "\"readonlyForSending\":true")) throw new InvalidOperationException("IMPORT_COMMUNITY_METADATA_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-community", "\"mentionRanges\":[{\"start\":4,\"end\":6,\"userId\":\"fixture-target\"},{\"start\":7,\"end\":11,\"userId\":\"@all\"}]")) throw new InvalidOperationException("IMPORT_MENTION_RANGE_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-sticker-direct", "\"nativeStickerMetadata\":{\"STKID\":\"10001\",\"STKPKGID\":\"20001\",\"STKVER\":\"3\",\"STKTXT\":\"hello sticker\",\"STKOPT\":\"A\"}")) throw new InvalidOperationException("IMPORT_DIRECT_STICKER_METADATA_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-sticker-nested", "\"nativeStickerMetadata\":{\"STKID\":\"10002\",\"STKPKGID\":\"20002\",\"STKVER\":\"4\",\"STKOPT\":\"A\"}")) throw new InvalidOperationException("IMPORT_NESTED_STICKER_METADATA_MISMATCH");
          if (ContainsProperty(classifiedPage, "m-sticker-conflict", "nativeStickerMetadata") || ContainsProperty(classifiedPage, "m-sticker-malformed", "nativeStickerMetadata") || ContainsProperty(classifiedPage, "m-sticker-oversized", "nativeStickerMetadata")) throw new InvalidOperationException("IMPORT_INVALID_STICKER_METADATA_EXPOSED");
          if (!ContainsRow(classifiedPage, "m-sticker-boundary-direct", "\"nativeStickerMetadata\":{\"STKID\":\"10004\",\"STKPKGID\":\"20004\",\"STKVER\":\"6\",\"STKTXT\":\"" + new string('a', 199) + "\"}")) throw new InvalidOperationException("IMPORT_DIRECT_STICKER_TEXT_BOUNDARY_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-sticker-boundary-nested", "\"nativeStickerMetadata\":{\"STKID\":\"10005\",\"STKPKGID\":\"20005\",\"STKVER\":\"7\",\"STKTXT\":\"" + new string('a', 198) + "\uD83D\uDE42\"}")) throw new InvalidOperationException("IMPORT_NESTED_STICKER_TEXT_BOUNDARY_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-sticker-direct-max", "\"nativeStickerMetadata\":{\"STKID\":\"10006\",\"STKPKGID\":\"20006\",\"STKVER\":\"8\",\"STKTXT\":\"" + new string('a', 200) + "\"}")) throw new InvalidOperationException("IMPORT_DIRECT_STICKER_TEXT_MAXIMUM_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-sticker-nested-space-boundary", "\"nativeStickerMetadata\":{\"STKID\":\"10007\",\"STKPKGID\":\"20007\",\"STKVER\":\"9\",\"STKTXT\":\"" + new string('a', 199) + "\"}")) throw new InvalidOperationException("IMPORT_NESTED_STICKER_TEXT_SPACE_BOUNDARY_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-sticker-numeric-direct", "\"nativeStickerMetadata\":{\"STKID\":\"10008\",\"STKPKGID\":\"20008\",\"STKVER\":\"1\",\"STKOPT\":\"A\"}")) throw new InvalidOperationException("IMPORT_NUMERIC_DIRECT_STICKER_METADATA_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-sticker-numeric-nested", "\"nativeStickerMetadata\":{\"STKID\":\"10009\",\"STKPKGID\":\"20009\",\"STKVER\":\"2\"}")) throw new InvalidOperationException("IMPORT_NUMERIC_NESTED_STICKER_METADATA_MISMATCH");
          if (ContainsProperty(classifiedPage, "m-sticker-numeric-negative", "nativeStickerMetadata") || ContainsProperty(classifiedPage, "m-sticker-numeric-fractional", "nativeStickerMetadata")) throw new InvalidOperationException("IMPORT_INVALID_NUMERIC_STICKER_METADATA_EXPOSED");
          if (!ContainsRow(classifiedPage, "m-sticker-invalid-optional", "\"nativeStickerMetadata\":{\"STKID\":\"10003\",\"STKVER\":\"30003\"}")) throw new InvalidOperationException("IMPORT_INVALID_OPTIONAL_STICKER_FIELD_NOT_OMITTED");
          if (ContainsProperty(classifiedPage, "m-long-community", "mentionRanges") || ContainsProperty(classifiedPage, "m-room", "mentionRanges")) throw new InvalidOperationException("IMPORT_INVALID_OPTIONAL_MENTION_METADATA_EXPOSED");
          using (Sqlite3Mc.InitialImportWindow mentionWindow = reader.OpenInitialImportWindow(CancellationToken.None)) {
            bool mentionMore; string mentionTime, mentionId;
            string[] mentionPage = mentionWindow.ReadPage(100, null, null, out mentionMore, out mentionTime, out mentionId);
            if (!ContainsRow(mentionPage, "m-community", "\"mentionRanges\":[{\"start\":4,\"end\":6,\"userId\":\"fixture-target\"},{\"start\":7,\"end\":11,\"userId\":\"@all\"}]")) throw new InvalidOperationException("INITIAL_WINDOW_MENTION_RANGE_MISMATCH");
          }
          if (!ContainsRow(classifiedPage, "m-long-community", "\"chatType\":\"community\"", "\"nativeContentType\":22") || !HasTitleLength(classifiedPage, "m-long-community", 256)) throw new InvalidOperationException("IMPORT_TITLE_BOUND_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-thread", "\"chatType\":\"thread\"", "\"conversationTitle\":\"Fixture Square Chat · thread\"", "\"parentChatId\":\"fixture-community-chat\"", "\"communityId\":\"fixture-square\"", "\"senderName\":\"Square Alias\"", "\"nativeContentType\":99", "\"kind\":\"event\"", "\"readonlyForSending\":true")) throw new InvalidOperationException("IMPORT_THREAD_METADATA_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-room", "\"chatType\":\"room\"", "\"nativeConversationKind\":\"midType:1\"")) throw new InvalidOperationException("IMPORT_LEGACY_ROOM_MISMATCH");
          if (!ContainsRow(classifiedPage, "m-unknown", "\"chatType\":\"room\"", "\"nativeConversationKind\":\"midType:9\"", "\"readonlyForSending\":true")) throw new InvalidOperationException("IMPORT_UNKNOWN_TYPE_MISMATCH");
          bool unreadOk;
          System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, long>> unreadRows = reader.ReadChatUnreadCounts(out unreadOk);
          if (!unreadOk || unreadRows.Count != 2 || unreadRows[0].Key != "fixture-chat" || unreadRows[0].Value != 3
              || unreadRows[1].Key != "fixture-group" || unreadRows[1].Value != 1200) throw new InvalidOperationException("UNREAD_COUNTS_MISMATCH");
          string[] tailRows = reader.ReadMessageTail(50, true, false, "1002", "m-unknown");
          if (tailRows.Length < classifiedPage.Length) throw new InvalidOperationException("TAIL_ROW_COUNT_MISMATCH");
          if (!ContainsRow(tailRows, "m-community", "\"mentionRanges\":[{\"start\":4,\"end\":6,\"userId\":\"fixture-target\"},{\"start\":7,\"end\":11,\"userId\":\"@all\"}]")) throw new InvalidOperationException("TAIL_MENTION_RANGE_MISMATCH");
          foreach (string row in classifiedPage) {
            string id = ExtractMessageId(row);
            if (!SameProjection(FindRowByMessageId(tailRows, id), row)) throw new InvalidOperationException("TAIL_ROW_ADAPTATION_MISMATCH");
          }
          writer.AddFixtureUnknownGroupMembership();
          string[] unknownWithMembership = reader.ReadMessageConversationKind("fixture-unknown");
          if (unknownWithMembership[0] != "room" || unknownWithMembership[1] != "midType:9") throw new InvalidOperationException("UNKNOWN_MIDTYPE_GROUP_BECAME_WRITABLE");
          writer.InsertFixtureHighTimestampMessage();
          databaseBefore = Hash(database); walBefore = Hash(wal);
          string[] highTimestampPage = reader.ReadMessageKeysetPage("1002", "m-unknown", 2, out more, out lastTime, out lastId);
          if (more || highTimestampPage.Length != 1 || !highTimestampPage[0].Contains("\"createdTime\":\"9007199254740993\""))
            throw new InvalidOperationException("KEYSET_INT64_STRING_MISMATCH");
          writer.InsertFixtureEmptySenderMessages();
          databaseBefore = Hash(database); walBefore = Hash(wal);
          string[] emptySenderPage = reader.ReadMessageKeysetPage("1002", "m-unknown", 2, out more, out lastTime, out lastId);
          if (!more || emptySenderPage.Length != 2 ||
              !ContainsRow(emptySenderPage, "m-empty-sender-direct", "\"senderId\":\"\"", "\"chatType\":\"direct\"", "\"text\":\"\"", "\"nativeContentType\":0") ||
              !ContainsRow(emptySenderPage, "m-empty-sender-community", "\"senderId\":\"\"", "\"chatType\":\"community\"", "\"text\":\"archived body\"", "\"nativeContentType\":0"))
            throw new InvalidOperationException("EMPTY_SENDER_KEYSET_ADAPTATION_MISMATCH");
          string[] emptySenderTail = reader.ReadMessageTail(50, true, false, "9007199254740993", "m-big");
          if (!SameProjection(FindRowByMessageId(emptySenderTail, "m-empty-sender-direct"), FindRowByMessageId(emptySenderPage, "m-empty-sender-direct")) ||
              !SameProjection(FindRowByMessageId(emptySenderTail, "m-empty-sender-community"), FindRowByMessageId(emptySenderPage, "m-empty-sender-community")))
            throw new InvalidOperationException("EMPTY_SENDER_TAIL_ADAPTATION_MISMATCH");
          writer.InsertFixtureOtherCommunityMessage();
          string[] otherCommunityPage = reader.ReadMessageKeysetPage("1002", "m-unknown", 100, out more, out lastTime, out lastId);
          string otherCommunityRow = FindRowByMessageId(otherCommunityPage, "m-other-community");
          if (otherCommunityRow == null || !otherCommunityRow.Contains("\"chatType\":\"community\"") ||
              !otherCommunityRow.Contains("\"communityId\":\"other-square\"") || otherCommunityRow.Contains("\"senderName\""))
            throw new InvalidOperationException("IMPORT_CROSS_COMMUNITY_NICKNAME_LEAK");
          stage = "message_prefix_and_tail_stream_large_aggregate_rows";
          writer.ClearFixtureMessages();
          writer.InsertFixtureLargeAggregateRows("aggregate-forward-", 30, 40000, 2000);
          System.Collections.Generic.List<string> aggregateForwardRows = new System.Collections.Generic.List<string>();
          string aggregateCursorTime = null, aggregateCursorId = null;
          do {
            string[] aggregatePage = reader.ReadMessageKeysetPage(aggregateCursorTime, aggregateCursorId, 100, out more, out lastTime, out lastId);
            if (aggregatePage.Length == 0) throw new InvalidOperationException("MESSAGE_PREFIX_EMPTY_CONTINUATION");
            long aggregatePageBytes = 0;
            for (int i = 0; i < aggregatePage.Length; i++) aggregatePageBytes += Encoding.UTF8.GetByteCount(aggregatePage[i]);
            if (!Sqlite3Mc.FitsNativeMessagePageBudget(aggregatePageBytes, aggregatePage.Length))
              throw new InvalidOperationException("MESSAGE_PREFIX_PAGE_FRAME_BOUND_MISMATCH");
            aggregateForwardRows.AddRange(aggregatePage);
            aggregateCursorTime = lastTime; aggregateCursorId = lastId;
          } while (more);
          string[] aggregateForward = aggregateForwardRows.ToArray();
          if (aggregateForward.Length != 30 || aggregateCursorTime != "2000" || aggregateCursorId != "aggregate-forward-029" || 30L * 40000 * 2 <= 2L * 1024 * 1024)
            throw new InvalidOperationException("MESSAGE_PREFIX_AGGREGATE_FIXTURE_BOUNDS_MISMATCH");
          for (int aggregateIndex = 0; aggregateIndex < aggregateForward.Length; aggregateIndex++) {
            string expectedId = "aggregate-forward-" + aggregateIndex.ToString("D3", System.Globalization.CultureInfo.InvariantCulture);
            if (!aggregateForward[aggregateIndex].Contains("\"nativeMessageId\":\"" + expectedId + "\"") ||
                !aggregateForward[aggregateIndex].Contains("\"nativePayload\":{\"format\":2,\"table\":\"_message\",\"sourceDigest\":"))
              throw new InvalidOperationException("MESSAGE_PREFIX_AGGREGATE_ORDER_OR_ENVELOPE_MISMATCH");
          }
          string[] aggregateTail = reader.ReadMessageTail(50, true, false, "2000", "aggregate-forward-029");
          if (aggregateTail.Length != aggregateForward.Length) throw new InvalidOperationException("MESSAGE_TAIL_AGGREGATE_COUNT_MISMATCH");
          for (int aggregateIndex = 0; aggregateIndex < aggregateTail.Length; aggregateIndex++)
            if (!SameProjection(aggregateTail[aggregateIndex], aggregateForward[aggregateIndex]))
              throw new InvalidOperationException("MESSAGE_TAIL_AGGREGATE_ORDER_OR_ENVELOPE_MISMATCH");
          stage = "message_tail_stream_50_rows_over_old_aggregate_cap";
          writer.ClearFixtureMessages();
          writer.InsertFixtureLargeAggregateRows("aggregate-tail-", 50, 25000, 3000);
          string[] aggregateTail50 = reader.ReadMessageTail(50, true, false, "3000", "aggregate-tail-049");
          if (aggregateTail50.Length != 50 || 50L * 25000 * 2 <= 2L * 1024 * 1024)
            throw new InvalidOperationException("MESSAGE_TAIL_50_AGGREGATE_BOUNDS_MISMATCH");
          for (int aggregateIndex = 0; aggregateIndex < aggregateTail50.Length; aggregateIndex++) {
            string expectedId = "aggregate-tail-" + aggregateIndex.ToString("D3", System.Globalization.CultureInfo.InvariantCulture);
            if (!aggregateTail50[aggregateIndex].Contains("\"nativeMessageId\":\"" + expectedId + "\"") ||
                !aggregateTail50[aggregateIndex].Contains("\"nativePayload\":{\"format\":2,\"table\":\"_message\",\"sourceDigest\":"))
              throw new InvalidOperationException("MESSAGE_TAIL_50_AGGREGATE_ORDER_OR_ENVELOPE_MISMATCH");
          }
          stage = "monitor_message_single_row_1mib_boundary_and_initial_import_budget";
          writer.ClearFixtureMessages();
          writer.InsertFixtureOversizeMessage(400000);
          bool monitorPrefixOversizeRejected = false, monitorTailOversizeRejected = false;
          try { reader.ReadMessageKeysetPage(null, null, 100, out more, out lastTime, out lastId); }
          catch (InvalidOperationException error) { monitorPrefixOversizeRejected = error.Message == "SOURCE_ROW_TOO_LARGE"; }
          try { reader.ReadMessageTail(50, true, false, "1000", "window-oversize"); }
          catch (InvalidOperationException error) { monitorTailOversizeRejected = error.Message == "SOURCE_ROW_TOO_LARGE"; }
          string[] initialBudgetPage = reader.ReadMessageKeysetPage(null, null, 1, out more, out lastTime, out lastId,
            false, false, null, null, true);
          long initialBoundaryJsonBytes = initialBudgetPage.Length == 0 ? 0 : Encoding.UTF8.GetByteCount(initialBudgetPage[0]);
          if (!monitorPrefixOversizeRejected || !monitorTailOversizeRejected || initialBudgetPage.Length != 1 || lastId != "window-oversize" ||
              Sqlite3Mc.FitsNativeMessagePageBudget(initialBoundaryJsonBytes, 1) ||
              !Sqlite3Mc.FitsNativeMessagePageBudget(initialBoundaryJsonBytes, 1, 8L * 1024 * 1024))
            throw new InvalidOperationException("MONITOR_INITIAL_IMPORT_MESSAGE_BUDGET_MISMATCH");
          stage = "message_prefix_single_oversize_row_rejected";
          writer.ClearFixtureMessages();
          writer.InsertFixtureOversizeMessage(2 * 1024 * 1024);
          bool prefixOversizeRejected = false, tailOversizeRejected = false;
          try { reader.ReadMessageKeysetPage(null, null, 100, out more, out lastTime, out lastId); }
          catch (InvalidOperationException error) { prefixOversizeRejected = error.Message == "SOURCE_ROW_TOO_LARGE"; }
          try { reader.ReadMessageTail(50, true, false, "1000", "window-oversize"); }
          catch (InvalidOperationException error) { tailOversizeRejected = error.Message == "SOURCE_ROW_TOO_LARGE"; }
          if (!prefixOversizeRejected || !tailOversizeRejected) throw new InvalidOperationException("MESSAGE_SINGLE_OVERSIZE_ROW_NOT_REJECTED");
          writer.ClearFixtureMessages();
          writer.InsertFixtureChatMessage("m-01", 1000, "fixture-group");
          writer.InsertFixtureDuplicateMessageId();
          databaseBefore = Hash(database); walBefore = Hash(wal);
          bool duplicateIdRejected = false;
          try { reader.ReadMessageSnapshotBounds(); }
          catch (InvalidOperationException error) { duplicateIdRejected = error.Message == "SOURCE_SCHEMA_UNSUPPORTED"; }
          if (!duplicateIdRejected) throw new InvalidOperationException("DUPLICATE_MESSAGE_ID_ACCEPTED");
          stage = "native_source_window_1000_timing_and_budget";
          writer.ClearFixtureMessages();
          writer.InsertFixtureWindowMessages(1000);
          Stopwatch sourceTiming = Stopwatch.StartNew();
          using (Sqlite3Mc.InitialImportWindow timed = reader.OpenInitialImportWindow(CancellationToken.None)) {
            bool timingMore;
            Sqlite3Mc.InitialImportBufferedRow[] timedRows = timed.ReadBufferedPage(1000, null, null, out timingMore);
            sourceTiming.Stop();
            if (timedRows.Length != 1000 || timingMore || !Sqlite3Mc.InitialImportWindow.FixtureInitialPageFits(timedRows))
              throw new InvalidOperationException("NATIVE_SOURCE_1000_TIMING_BOUND_MISMATCH");
            for (int i = 0; i < timedRows.Length; i++) {
              string expectedId = "window-" + i.ToString("D5", System.Globalization.CultureInfo.InvariantCulture);
              if (timedRows[i].Id != expectedId) throw new InvalidOperationException("NATIVE_SOURCE_1000_TIMING_ORDER_MISMATCH");
            }
          }
          Console.WriteLine("NATIVE_SOURCE_1000_ROWS_MS=" + sourceTiming.ElapsedMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
          stage = "initial_import_window_single_oversize_row_rejected";
          writer.ClearFixtureMessages();
          writer.InsertFixtureOversizeMessage(1200000);
          bool oversizeRejected = false;
          try {
            using (Sqlite3Mc.InitialImportWindow oversized = reader.OpenInitialImportWindow(CancellationToken.None)) {
              bool ignoredMore; string ignoredTime, ignoredId;
              oversized.ReadPage(1, null, null, out ignoredMore, out ignoredTime, out ignoredId);
            }
          } catch (InvalidOperationException error) { oversizeRejected = error.Message == "SOURCE_ROW_TOO_LARGE"; }
          if (!oversizeRejected) throw new InvalidOperationException("WINDOW_SINGLE_OVERSIZE_ROW_NOT_REJECTED");
          stage = "initial_import_window_60500_order_refill_and_resume";
          writer.ClearFixtureMessages();
          writer.InsertFixtureWindowMessages(60537);
          Sqlite3Mc.ResetFixtureWindowStatementPreparations();
          string windowCursorTime = null, windowCursorId = null;
          int windowRows = 0, windowPages = 0, finalWindowPageRows = 0;
          int firstPageReprepareCount = -1, firstPageSortCount = -1;
          using (Sqlite3Mc.InitialImportWindow window = reader.OpenInitialImportWindow(CancellationToken.None)) {
            bool windowMore;
            do {
              string pageLastTime, pageLastId;
              string[] page = window.ReadPage(2000, windowCursorTime, windowCursorId, out windowMore, out pageLastTime, out pageLastId);
              if (page.Length == 0 && windowMore) throw new InvalidOperationException("WINDOW_EMPTY_CONTINUATION");
              if (page.Length > 2000 || !Sqlite3Mc.InitialImportWindow.FixtureInitialPageFits(page))
                throw new InvalidOperationException("WINDOW_PAGE_FRAME_BUDGET_MISMATCH");
              for (int i = 0; i < page.Length; i++) {
                string expectedId = "window-" + (windowRows + i).ToString("D5", System.Globalization.CultureInfo.InvariantCulture);
                if (!page[i].Contains("\"nativeMessageId\":\"" + expectedId + "\"")) throw new InvalidOperationException("WINDOW_ORDER_OR_DUPLICATE_MISMATCH");
              }
              windowRows += page.Length; windowPages++;
              finalWindowPageRows = page.Length;
              if (windowPages == 1) {
                firstPageReprepareCount = window.FixtureReprepareCount;
                firstPageSortCount = window.FixtureSortCount;
              } else if (windowPages == 2 &&
                  (window.FixtureReprepareCount != firstPageReprepareCount || window.FixtureSortCount != firstPageSortCount)) {
                throw new InvalidOperationException("WINDOW_STATEMENT_REPREPARED_OR_RESORTED");
              }
              if (page.Length > 0) { windowCursorTime = pageLastTime; windowCursorId = pageLastId; }
            } while (windowMore);
          }
          if (windowRows != 60537 || windowPages < 31 || finalWindowPageRows < 1 || finalWindowPageRows > 2000 || Sqlite3Mc.FixtureWindowStatementPreparations != 3 ||
              firstPageReprepareCount != 0 || firstPageSortCount < 1)
            throw new InvalidOperationException("WINDOW_REFILL_PREPARATION_COUNT_MISMATCH_" + windowRows + "_" + windowPages + "_" + finalWindowPageRows + "_" + Sqlite3Mc.FixtureWindowStatementPreparations + "_" + firstPageReprepareCount + "_" + firstPageSortCount);
          using (Sqlite3Mc.InitialImportWindow oversized = reader.OpenInitialImportWindow(CancellationToken.None)) {
            bool rejected = false;
            try { bool ignoredMore; string ignoredTime, ignoredId; oversized.ReadPage(2001, null, null, out ignoredMore, out ignoredTime, out ignoredId); }
            catch (InvalidOperationException error) { rejected = error.Message == "SOURCE_PAGE_INVALID"; }
            if (!rejected) throw new InvalidOperationException("WINDOW_2001_PAGE_ACCEPTED");
          }
          stage = "initial_import_window_partial_cursor_resume";
          Sqlite3Mc.ResetFixtureWindowStatementPreparations();
          using (Sqlite3Mc.InitialImportWindow resumed = reader.OpenInitialImportWindow(CancellationToken.None)) {
            bool resumedMore = true; string resumeLastTime = "1000", resumeLastId = "window-10249"; int suffixRows = 0;
            while (suffixRows < 2000) {
              string nextTime, nextId;
              string[] suffix = resumed.ReadPage(Math.Min(2000, 2000 - suffixRows), resumeLastTime, resumeLastId, out resumedMore, out nextTime, out nextId);
              if (suffix.Length < 1 || suffix.Length > 2000 || !Sqlite3Mc.InitialImportWindow.FixtureInitialPageFits(suffix))
                throw new InvalidOperationException("WINDOW_PARTIAL_RESUME_PAGE_BOUND_MISMATCH");
              for (int i = 0; i < suffix.Length; i++) {
                string expected = "window-" + (10250 + suffixRows + i).ToString("D5", System.Globalization.CultureInfo.InvariantCulture);
                if (!suffix[i].Contains("\"nativeMessageId\":\"" + expected + "\""))
                  throw new InvalidOperationException("WINDOW_PARTIAL_RESUME_ORDER_MISMATCH");
              }
              suffixRows += suffix.Length; resumeLastTime = nextTime; resumeLastId = nextId;
            }
            if (suffixRows != 2000 || !resumedMore || resumeLastId != "window-12249" || Sqlite3Mc.FixtureWindowStatementPreparations != 1)
              throw new InvalidOperationException("WINDOW_PARTIAL_RESUME_MISMATCH_" + suffixRows + "_" + resumedMore + "_" + resumeLastId + "_" + Sqlite3Mc.FixtureWindowStatementPreparations);
          }
          stage = "initial_import_window_exact_30000";
          writer.ClearFixtureMessages();
          writer.InsertFixtureWindowMessages(30000);
          Sqlite3Mc.ResetFixtureWindowStatementPreparations();
          using (Sqlite3Mc.InitialImportWindow exact = reader.OpenInitialImportWindow(CancellationToken.None)) {
            bool exactMore = true; string exactCursorTime = null, exactCursorId = null; int exactRows = 0;
            while (exactMore) {
              string pageLastTime, pageLastId;
              string[] page = exact.ReadPage(2000, exactCursorTime, exactCursorId, out exactMore, out pageLastTime, out pageLastId);
              exactRows += page.Length;
              if (page.Length > 0) { exactCursorTime = pageLastTime; exactCursorId = pageLastId; }
            }
            if (exactRows != 30000 || exactCursorId != "window-29999" || Sqlite3Mc.FixtureWindowStatementPreparations != 1)
              throw new InvalidOperationException("WINDOW_EXACT_30000_MISMATCH");
          }
          stage = "initial_import_window_2000_row_payload_over_1mib";
          writer.ClearFixtureMessages();
          writer.InsertFixtureWindowMessages(2000, new string('x', 700));
          using (Sqlite3Mc.InitialImportWindow largePage = reader.OpenInitialImportWindow(CancellationToken.None)) {
            bool pageMore; string pageTime, pageId;
            string[] serialized = largePage.ReadPage(2000, null, null, out pageMore, out pageTime, out pageId);
            int serializedBytes = Encoding.UTF8.GetByteCount(String.Join("", serialized));
            string expectedPageLastId = "window-" + (serialized.Length - 1).ToString("D5", System.Globalization.CultureInfo.InvariantCulture);
            if (serialized.Length < 1 || serialized.Length > 2000 || !pageMore || pageId != expectedPageLastId || serializedBytes <= 1024 * 1024 ||
                !Sqlite3Mc.InitialImportWindow.FixtureInitialPageFits(serialized))
              throw new InvalidOperationException("WINDOW_INITIAL_SERIALIZER_BOUND_MISMATCH");
          }
          stage = "initial_import_window_token_dense_prefix_fit";
          writer.ClearFixtureMessages();
          writer.InsertFixtureWindowMessages(2000, new string('"', 700));
          Sqlite3Mc.ResetFixtureWindowStatementPreparations();
          using (Sqlite3Mc.InitialImportWindow dense = reader.OpenInitialImportWindow(CancellationToken.None)) {
            string cursorTime = null, cursorId = null; bool denseMore = true; int denseRows = 0, densePages = 0;
            while (denseMore) {
              string nextTime, nextId;
              string[] page = dense.ReadPage(2000, cursorTime, cursorId, out denseMore, out nextTime, out nextId);
              if (page.Length < 1 || page.Length > 2000 || !Sqlite3Mc.InitialImportWindow.FixtureInitialPageFits(page))
                throw new InvalidOperationException("WINDOW_DENSE_PAGE_FRAME_BUDGET_MISMATCH");
              denseRows += page.Length; densePages++;
              cursorTime = nextTime; cursorId = nextId;
            }
            if (denseRows != 2000 || densePages < 2 || cursorId != "window-01999" || Sqlite3Mc.FixtureWindowStatementPreparations != 1)
              throw new InvalidOperationException("WINDOW_DENSE_PREFIX_RESUME_MISMATCH");
          }
          stage = "initial_import_window_empty";
          writer.ClearFixtureMessages();
          Sqlite3Mc.ResetFixtureWindowStatementPreparations();
          using (Sqlite3Mc.InitialImportWindow empty = reader.OpenInitialImportWindow(CancellationToken.None)) {
            bool emptyMore; string emptyTime, emptyId;
            string[] page = empty.ReadPage(500, null, null, out emptyMore, out emptyTime, out emptyId);
            if (page.Length != 0 || emptyMore || emptyTime != null || emptyId != null || Sqlite3Mc.FixtureWindowStatementPreparations != 1)
              throw new InvalidOperationException("WINDOW_EMPTY_MISMATCH");
          }
          stage = "initial_import_window_low_heap_cleanup";
          writer.InsertFixtureWindowMessages(60537);
          databaseBefore = Hash(database); walBefore = Hash(wal);
          long previousHeapLimit = reader.FixtureHeapLimit;
          reader.SetFixtureHeapLimitForTest(64 * 1024);
          bool lowHeapFailed = false;
          try {
            using (Sqlite3Mc.InitialImportWindow constrained = reader.OpenInitialImportWindow(CancellationToken.None, 128 * 1024 * 1024)) {
              if (reader.FixtureHeapLimit != 64 * 1024) throw new InvalidOperationException("WINDOW_RAISED_PRIOR_HEAP_LIMIT");
              try {
                bool ignoredMore; string ignoredTime, ignoredId;
                constrained.ReadPage(2000, null, null, out ignoredMore, out ignoredTime, out ignoredId);
              } catch (Exception) { lowHeapFailed = true; }
            }
          } finally { reader.SetFixtureHeapLimitForTest(previousHeapLimit); }
          if (!lowHeapFailed || reader.FixtureHeapLimit != previousHeapLimit)
            throw new InvalidOperationException("WINDOW_LOW_HEAP_NOT_RESTORED");
          stage = "initial_import_prefetch_two_slot_overlap_and_chunk_boundaries";
          writer.ClearFixtureMessages();
          writer.InsertFixtureWindowMessages(60537);
          databaseBefore = Hash(database); walBefore = Hash(wal);
          using (Sqlite3Mc.InitialImportPrefetcher prefetch = new Sqlite3Mc.InitialImportPrefetcher(reader, CancellationToken.None)) {
            prefetch.Start(null, null);
            Sqlite3Mc.InitialImportPrefetcher.WindowBuffer current = prefetch.AcquireWindow(null);
            if (current.AccountedBytes > 64L * 1024 * 1024 || current.RowCount > 30000) throw new InvalidOperationException("PREFETCH_DEFAULT_WINDOW_BUDGET_MISMATCH");
            if (!prefetch.FixtureWaitForBuiltWindows(2, 30000) || prefetch.FixtureBuiltWindows != 2 ||
                prefetch.FixtureSlotHighWater != 2 || prefetch.FixtureBuildAttempts != 2)
              throw new InvalidOperationException("PREFETCH_DID_NOT_OVERLAP_OR_EXCEEDED_TWO_SLOTS_" + prefetch.FixtureBuiltWindows + "_" + prefetch.FixtureSlotHighWater + "_" + prefetch.FixtureBuildAttempts + "_" + prefetch.FixtureLastBuildError);
            if (current.Chunks.Count == 0 || current.Chunks[0].Length < 1 || current.Chunks[0].Length > 2000)
              throw new InvalidOperationException("PREFETCH_FIRST_CHUNK_INVALID");
            int offset = 0, firstTake = Math.Min(1, current.Chunks[0].Length - offset); offset += firstTake;
            int secondTake = Math.Min(2000, current.Chunks[0].Length - offset);
            if (firstTake != 1 || secondTake != Math.Min(1999, current.Chunks[0].Length - 1) || offset + secondTake != current.Chunks[0].Length)
              throw new InvalidOperationException("PREFETCH_NEXT_CROSSED_CHUNK_BOUNDARY");
            int expected = 0, total = 0;
            for (int chunkIndex = 0; chunkIndex < current.Chunks.Count; chunkIndex++) {
              Sqlite3Mc.InitialImportBufferedRow[] chunk = current.Chunks[chunkIndex];
              if (chunk.Length < 1 || chunk.Length > 2000) throw new InvalidOperationException("PREFETCH_CHUNK_SIZE_INVALID");
              for (int rowIndex = 0; rowIndex < chunk.Length; rowIndex++, expected++, total++) {
                string expectedId = "window-" + expected.ToString("D5", System.Globalization.CultureInfo.InvariantCulture);
                if (chunk[rowIndex].Id != expectedId) throw new InvalidOperationException("PREFETCH_ORDER_OR_DUPLICATE_MISMATCH");
              }
            }
            prefetch.ReleaseWindow(current);
            if (!prefetch.FixtureWaitForBuiltWindows(3, 30000) || prefetch.FixtureBuiltWindows != 3 || prefetch.FixtureSlotHighWater != 2)
              throw new InvalidOperationException("PREFETCH_THIRD_WINDOW_DID_NOT_REFILL_AFTER_RELEASE");
            Sqlite3Mc.InitialImportPrefetcher.WindowBuffer window = prefetch.AcquireWindow(null);
            while (window != null) {
              if (window.AccountedBytes > 64L * 1024 * 1024 || window.RowCount > 30000) throw new InvalidOperationException("PREFETCH_DEFAULT_WINDOW_BUDGET_MISMATCH");
              for (int chunkIndex = 0; chunkIndex < window.Chunks.Count; chunkIndex++) {
                Sqlite3Mc.InitialImportBufferedRow[] chunk = window.Chunks[chunkIndex];
                if (chunk.Length < 1 || chunk.Length > 2000) throw new InvalidOperationException("PREFETCH_CHUNK_SIZE_INVALID");
                for (int rowIndex = 0; rowIndex < chunk.Length; rowIndex++, expected++, total++) {
                  string expectedId = "window-" + expected.ToString("D5", System.Globalization.CultureInfo.InvariantCulture);
                  if (chunk[rowIndex].Id != expectedId) throw new InvalidOperationException("PREFETCH_ORDER_OR_DUPLICATE_MISMATCH");
                }
              }
              bool hasMore = window.HasMore;
              prefetch.ReleaseWindow(window);
              window = hasMore ? prefetch.AcquireWindow(null) : null;
            }
            if (total != 60537 || expected != 60537 || prefetch.FixtureSlotHighWater != 2)
              throw new InvalidOperationException("PREFETCH_WINDOW_TOTAL_MISMATCH");
          }
          stage = "initial_import_prefetch_unaligned_byte_prefix_respects_30000_rows";
          writer.ClearFixtureMessages();
          writer.InsertFixtureMixedWindowMessages(60537, 500, new string('"', 700));
          using (Sqlite3Mc.InitialImportPrefetcher aligned = new Sqlite3Mc.InitialImportPrefetcher(reader, CancellationToken.None)) {
            aligned.SetFixtureWindowByteBudget(128L * 1024 * 1024);
            aligned.Start(null, null);
            Sqlite3Mc.InitialImportPrefetcher.WindowBuffer window = aligned.AcquireWindow(null);
            if (window == null || window.RowCount != 30000 || window.Chunks.Count < 2 || window.Chunks[0].Length >= 2000)
              throw new InvalidOperationException("PREFETCH_BYTE_PREFIX_DID_NOT_CREATE_UNALIGNED_WINDOW_" + (window == null ? -1 : window.RowCount) + "_" + (window == null ? -1 : window.Chunks.Count) + "_" + (window == null || window.Chunks.Count == 0 ? -1 : window.Chunks[0].Length) + "_" + aligned.FixtureLastBuildError);
            int expectedIndex = 0, total = 0;
            while (window != null) {
              if (window.RowCount > 30000 || window.AccountedBytes > 128L * 1024 * 1024)
                throw new InvalidOperationException("PREFETCH_WINDOW_LIMIT_EXCEEDED");
              for (int chunkIndex = 0; chunkIndex < window.Chunks.Count; chunkIndex++) {
                Sqlite3Mc.InitialImportBufferedRow[] chunk = window.Chunks[chunkIndex];
                for (int rowIndex = 0; rowIndex < chunk.Length; rowIndex++, expectedIndex++, total++) {
                  string expectedId = "window-" + expectedIndex.ToString("D5", System.Globalization.CultureInfo.InvariantCulture);
                  if (chunk[rowIndex].Id != expectedId) throw new InvalidOperationException("PREFETCH_UNALIGNED_WINDOW_ORDER_MISMATCH");
                }
              }
              bool hasMore = window.HasMore;
              aligned.ReleaseWindow(window);
              window = hasMore ? aligned.AcquireWindow(null) : null;
            }
            if (total != 60537 || expectedIndex != 60537 || aligned.FixtureMaximumWindowRows != 30000 || aligned.FixtureSlotHighWater > 2)
              throw new InvalidOperationException("PREFETCH_UNALIGNED_WINDOW_TOTAL_OR_LIMIT_MISMATCH");
          }
          using (Sqlite3Mc.InitialImportPrefetcher resumed = new Sqlite3Mc.InitialImportPrefetcher(reader, CancellationToken.None)) {
            resumed.Start("1000", "window-10249");
            Sqlite3Mc.InitialImportPrefetcher.WindowBuffer window = resumed.AcquireWindow(null);
            if (window.Chunks.Count == 0 || window.Chunks[0].Length == 0 || window.Chunks[0][0].Id != "window-10250")
              throw new InvalidOperationException("PREFETCH_RESUME_CURSOR_MISMATCH");
          }
          stage = "initial_import_prefetch_defers_next_window_failure";
          writer.ClearFixtureMessages();
          writer.InsertFixtureWindowMessages(60537);
          Sqlite3Mc.InitialImportPrefetcher.FixtureBuildFailure = delegate(int build) {
            return build == 2 ? new InvalidOperationException("FIXTURE_NEXT_WINDOW_FAILURE") : null;
          };
          try {
            using (Sqlite3Mc.InitialImportPrefetcher deferred = new Sqlite3Mc.InitialImportPrefetcher(reader, CancellationToken.None)) {
              deferred.Start(null, null);
              Sqlite3Mc.InitialImportPrefetcher.WindowBuffer current = deferred.AcquireWindow(null);
              if (current.RowCount < 1 || current.RowCount > 30000 || !deferred.FixtureWaitForBuildAttempts(2, 30000))
                throw new InvalidOperationException("PREFETCH_CURRENT_WINDOW_CANCELLED_BY_NEXT_FAILURE");
              deferred.ReleaseWindow(current);
              bool deferredFailure = false;
              try { deferred.AcquireWindow(null); }
              catch (InvalidOperationException error) { deferredFailure = error.Message == "FIXTURE_NEXT_WINDOW_FAILURE"; }
              if (!deferredFailure) throw new InvalidOperationException("PREFETCH_NEXT_FAILURE_NOT_DEFERRED");
            }
          } finally { Sqlite3Mc.InitialImportPrefetcher.FixtureBuildFailure = null; }
          stage = "initial_import_prefetch_budget_failure_restores_heap";
          writer.ClearFixtureMessages();
          writer.InsertFixtureWindowMessages(2000, new string('x', 700));
          long prefetchHeapBefore = reader.FixtureHeapLimit;
          using (Sqlite3Mc.InitialImportPrefetcher bounded = new Sqlite3Mc.InitialImportPrefetcher(reader, CancellationToken.None)) {
            bounded.SetFixtureWindowByteBudget(64 * 1024);
            bounded.Start(null, null);
            bool budgetFailed = false;
            try { bounded.AcquireWindow(null); }
            catch (InvalidOperationException error) { budgetFailed = error.Message == "SOURCE_PREFETCH_BUDGET_EXCEEDED"; }
            if (!budgetFailed) throw new InvalidOperationException("PREFETCH_BUDGET_OVERFLOW_ACCEPTED");
          }
          if (reader.FixtureHeapLimit != prefetchHeapBefore) throw new InvalidOperationException("PREFETCH_BUDGET_HEAP_NOT_RESTORED");
          stage = "initial_import_prefetch_cancel_during_sort_joins_and_restores_heap";
          writer.ClearFixtureMessages();
          writer.InsertFixtureWindowMessages(60537);
          long sortCancelHeapBefore = reader.FixtureHeapLimit;
          using (CancellationTokenSource sortParent = new CancellationTokenSource())
          using (Sqlite3Mc.InitialImportPrefetcher sorting = new Sqlite3Mc.InitialImportPrefetcher(reader, sortParent.Token)) {
            reader.EnableScanProgress(sorting.CancellationToken, delegate(string phase, long steps) { }, 1000);
            sorting.Start(null, null);
            DateTime sortDeadline = DateTime.UtcNow.AddSeconds(5);
            while (reader.FixtureScanSteps == 0 && DateTime.UtcNow < sortDeadline) Thread.Sleep(5);
            if (reader.FixtureScanSteps == 0) throw new InvalidOperationException("PREFETCH_SORT_CANCEL_NOT_IN_QUERY");
            sorting.Dispose();
            if (sortParent.IsCancellationRequested) throw new InvalidOperationException("PREFETCH_OWNERSHIP_CANCELLED_PARENT");
          }
          reader.EnableScanProgress(CancellationToken.None, delegate(string phase, long steps) { }, 1000);
          if (reader.FixtureHeapLimit != sortCancelHeapBefore) throw new InvalidOperationException("PREFETCH_SORT_CANCEL_HEAP_NOT_RESTORED");
          stage = "initial_import_prefetch_cancel_at_capacity_joins_and_restores_heap";
          writer.ClearFixtureMessages();
          writer.InsertFixtureWindowMessages(60537);
          databaseBefore = Hash(database); walBefore = Hash(wal);
          long cancelHeapBefore = reader.FixtureHeapLimit;
          using (CancellationTokenSource prefetchCancellation = new CancellationTokenSource())
          using (Sqlite3Mc.InitialImportPrefetcher cancelled = new Sqlite3Mc.InitialImportPrefetcher(reader, prefetchCancellation.Token)) {
            cancelled.Start(null, null);
            if (!cancelled.FixtureWaitForBuiltWindows(2, 30000)) throw new InvalidOperationException("PREFETCH_CANCEL_TEST_NOT_AT_CAPACITY");
            cancelled.AcquireWindow(null);
            cancelled.Dispose();
          }
          if (reader.FixtureHeapLimit != cancelHeapBefore) throw new InvalidOperationException("PREFETCH_CANCEL_HEAP_NOT_RESTORED");
          stage = "optional_square_member_malformed_name_and_absent_catalog";
          writer.ClearFixtureMessages();
          writer.InsertFixtureCommunityThreadMessages();
          writer.SetFixtureSquareMemberMalformedName();
          string[] malformedNamePage = reader.ReadMessageKeysetPage(null, null, 10, out more, out lastTime, out lastId);
          string[] optionalExpectedOrder = new string[] { "m-optional-community", "m-optional-thread" };
          AssertMessageOrder(malformedNamePage, optionalExpectedOrder, more);
          foreach (string messageId in optionalExpectedOrder) {
            string row = FindRowByMessageId(malformedNamePage, messageId);
            if (row == null || row.Contains("\"senderName\"")) throw new InvalidOperationException("MALFORMED_OPTIONAL_SQUARE_MEMBER_NAME_REJECTED");
          }
          writer.DropFixtureSquareMemberCatalog();
          databaseBefore = Hash(database); walBefore = Hash(wal);
          string[] missingCatalogPage = reader.ReadMessageKeysetPage(null, null, 10, out more, out lastTime, out lastId);
          AssertMessageOrder(missingCatalogPage, optionalExpectedOrder, more);
          foreach (string messageId in optionalExpectedOrder) {
            string row = FindRowByMessageId(missingCatalogPage, messageId);
            if (row == null || row.Contains("\"senderName\"")) throw new InvalidOperationException("OPTIONAL_SQUARE_MEMBER_CATALOG_ABSENCE_REJECTED");
          }
        }
        stage = "readonly_policy";
        reader.VerifyFixtureReadPolicy();
      }
      bool wrongKeyRejected = false;
      byte[] wrongKeyBytes = Encoding.UTF8.GetBytes("00000000000000000000000000000000");
      try {
        using (Sqlite3Mc wrongKey = Sqlite3Mc.OpenReadOnly(database, wrongKeyBytes)) {
          if (wrongKey.VerifySchemaReadable()) throw new InvalidOperationException("WRONG_KEY_SCHEMA_ACCEPTED");
        }
      } catch (InvalidOperationException error) {
        wrongKeyRejected = error.Message == "DATABASE_READ_FAILED";
      } finally { Array.Clear(wrongKeyBytes, 0, wrongKeyBytes.Length); }
      if (!wrongKeyRejected) throw new InvalidOperationException("WRONG_KEY_ACCEPTED");
      if (hold) {
        Console.Out.WriteLine("NATIVE_ROWS_BEGIN");
        foreach (string row in initialRows) Console.Out.WriteLine("ROW\t" + row);
        Console.Out.WriteLine("NATIVE_ROWS_END");
        Console.Out.WriteLine("READY");
        string command;
        while ((command = Console.In.ReadLine()) != null) {
          if (command == "GROW") {
            writer.InsertFixtureGrowthMessage();
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("COMMITTED");
          } else if (command.StartsWith("GROW_MANY ", StringComparison.Ordinal)) {
            int count;
            if (!Int32.TryParse(command.Substring(10), out count) || count < 1 || count > 1000) throw new InvalidOperationException("FIXTURE_GROW_COUNT_INVALID");
            writer.InsertFixtureGrowthMessages(count);
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("GROWN " + count);
          } else if (command == "CHECKPOINT") {
            writer.CheckpointFixtureWal();
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("CHECKPOINTED");
          } else if (command == "GROW_NEWER") {
            writer.InsertFixtureNewerMessage();
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("NEWER_COMMITTED");
          } else if (command.StartsWith("DELETE_ID ", StringComparison.Ordinal)) {
            writer.DeleteFixtureMessage(command.Substring(10));
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("DELETED");
          } else if (command == "CLEAR_MESSAGES") {
            writer.ClearFixtureMessages();
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("COMMITTED");
          } else if (command == "EMPTY_SENDER") {
            writer.InsertFixtureEmptySenderMessages();
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("EMPTY_SENDER_ADDED");
          } else if (command == "NULL_SENDER") {
            writer.InsertFixtureNullSenderMessage();
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("NULL_SENDER_ADDED");
          } else if (command == "BEGIN_GROWTH") {
            writer.BeginFixtureGrowth();
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("BUSY");
          } else if (command == "COMMIT_GROWTH") {
            writer.CommitFixtureGrowth();
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("COMMITTED");
          } else if (command.StartsWith("PROFILE_", StringComparison.Ordinal)) {
            writer.SetFixtureProfileShape(command.Substring(8).ToLowerInvariant());
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("PROFILE_SET");
          } else if (command == "CLOSE") {
            Console.Out.WriteLine("CLOSING");
            break;
          } else if (command == "REFRESH_HASHES") {
            databaseBefore = Hash(database); walBefore = Hash(wal);
            Console.Out.WriteLine("REFRESHED");
          } else throw new InvalidOperationException("FIXTURE_COMMAND_INVALID");
        }
      }
      stage = "source_unchanged";
      byte[] databaseAfter = Hash(database);
      byte[] walAfter = Hash(wal);
      if (!Equal(databaseBefore, databaseAfter) || !Equal(walBefore, walAfter)) throw new InvalidOperationException("READONLY_SOURCE_CHANGED");
      Console.Out.WriteLine("PASS");
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(stage + ":" + error.GetType().Name + ":" + error.Message);
      Console.Error.WriteLine("FIXTURE_FAILED");
      return 1;
    } finally {
      if (writer != null) writer.Dispose();
      Array.Clear(key, 0, key.Length);
      if (!hold) try { Directory.Delete(root, true); } catch { }
    }
  }

  static bool ContainsRow(string[] rows, string id, params string[] fields) {
    foreach (string row in rows) {
      if (!row.Contains("\"nativeMessageId\":" + "\"" + id + "\"")) continue;
      foreach (string field in fields) if (!row.Contains(field)) return false;
      return true;
    }
    return false;
  }

  static void AssertNativeSourceArchiveRoundTrip() {
    string[] columns = Sqlite3Mc.NativeMessageColumnNames;
    NativeSourceCell[] cells = new NativeSourceCell[columns.Length];
    for (int i = 0; i < cells.Length; i++) cells[i] = new NativeSourceCell(5, 0, 0, new byte[0]);
    cells[0] = new NativeSourceCell(3, 0, 0, Encoding.UTF8.GetBytes("private-synthetic-sender"));
    cells[1] = new NativeSourceCell(1, 9007199254740993L, 0, new byte[0]);
    cells[2] = new NativeSourceCell(2, 0, 1.25, new byte[0]);
    cells[3] = new NativeSourceCell(3, 0, 0, new byte[] { 0xff, 0x41 });
    cells[4] = new NativeSourceCell(3, 0, 0, new byte[] { 0x41, 0x00, 0x42 });
    cells[5] = new NativeSourceCell(4, 0, 0, new byte[] { 0x00, 0xff, 0x42 });
    NativeSourceRow row = new NativeSourceRow("_message", columns, cells);
    string digest = row.SourceDigest();
    string envelope = row.PlainEnvelopeJson();
    if (String.IsNullOrEmpty(digest) || digest.Length != 64 || !envelope.Contains("\"encoding\":\"plain\"") ||
        !envelope.Contains("\"table\":\"_message\"") || envelope.Contains("\"data\":\"AQ"))
      throw new InvalidOperationException("NATIVE_SOURCE_ENVELOPE_PLAIN_OR_DIGEST_MISMATCH");
    System.Web.Script.Serialization.JavaScriptSerializer serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
    System.Collections.Generic.Dictionary<string, object> outer = serializer.Deserialize<System.Collections.Generic.Dictionary<string, object>>(envelope);
    if ((string)outer["sourceDigest"] != digest || (int)outer["format"] != 2 || (string)outer["encoding"] != "plain")
      throw new InvalidOperationException("NATIVE_SOURCE_ENVELOPE_HEADER_MISMATCH");
    System.Collections.Generic.Dictionary<string, object> body = (System.Collections.Generic.Dictionary<string, object>)outer["row"];
    System.Collections.IList names = (System.Collections.IList)body["columns"];
    System.Collections.IList values = (System.Collections.IList)body["cells"];
    if (names.Count != 36 || values.Count != 36 || !envelope.Contains("private-synthetic-sender") || !envelope.Contains("9007199254740993") ||
        !envelope.Contains("\"sqliteType\":\"text\""))
      throw new InvalidOperationException("NATIVE_SOURCE_FULL_ROW_ROUNDTRIP_MISMATCH");
    System.Collections.Generic.Dictionary<string, object> fields = new System.Collections.Generic.Dictionary<string, object>();
    for (int i = 0; i < names.Count; i++) fields[(string)names[i]] = values[i];
    if (fields["_contentMetadata"] != null) throw new InvalidOperationException("NATIVE_SOURCE_NULL_NOT_PRESERVED");
    System.Collections.Generic.Dictionary<string, object> integer = fields["_to"] as System.Collections.Generic.Dictionary<string, object>;
    if (integer == null || (string)integer["sqliteType"] != "integer" || (string)integer["value"] != "9007199254740993")
      throw new InvalidOperationException("NATIVE_SOURCE_INTEGER_PRECISION_LOST");
    System.Collections.Generic.Dictionary<string, object> real = fields["_toType"] as System.Collections.Generic.Dictionary<string, object>;
    if (real == null || (string)real["sqliteType"] != "real" || (string)real["encoding"] != "ieee754-be")
      throw new InvalidOperationException("NATIVE_SOURCE_REAL_BITS_MISSING");
    System.Collections.Generic.Dictionary<string, object> invalidUtf8 = fields["_id"] as System.Collections.Generic.Dictionary<string, object>;
    if (invalidUtf8 == null || (string)invalidUtf8["encoding"] != "base64" ||
        (string)invalidUtf8["data"] != Convert.ToBase64String(new byte[] { 0xff, 0x41 }))
      throw new InvalidOperationException("NATIVE_SOURCE_INVALID_UTF8_NOT_PRESERVED");
    System.Collections.Generic.Dictionary<string, object> nulText = fields["_createdTime"] as System.Collections.Generic.Dictionary<string, object>;
    if (nulText == null || (string)nulText["encoding"] != "base64" ||
        (string)nulText["data"] != Convert.ToBase64String(new byte[] { 0x41, 0x00, 0x42 }))
      throw new InvalidOperationException("NATIVE_SOURCE_NUL_TEXT_NOT_PRESERVED");
    System.Collections.Generic.Dictionary<string, object> blob = fields["_deliveredTime"] as System.Collections.Generic.Dictionary<string, object>;
    if (blob == null || (string)blob["sqliteType"] != "blob" ||
        (string)blob["data"] != Convert.ToBase64String(new byte[] { 0x00, 0xff, 0x42 }))
      throw new InvalidOperationException("NATIVE_SOURCE_BLOB_NOT_PRESERVED");
  }

  static void AssertNativeCatalogPager(Sqlite3Mc reader) {
    string snapshotDigest = new string('a', 64);
    bool hasMore; string digest;
    string[] rows = reader.ReadNativeCatalogPage(1, snapshotDigest, out hasMore, out digest);
    string firstDigest = digest;
    if (rows.Length < 10 || rows.Length > 1000 || !hasMore || digest == null || digest.Length != 64)
      throw new InvalidOperationException("NATIVE_CATALOG_FIRST_PAGE_INVALID");
    string[] expectedTables = new string[] { "_chat", "_chatOption", "_contact", "_profile", "_profileMappedId", "_groupChat", "_room", "_square", "_squareChat", "_squareMember", "_squareThread", "_squareBot", "_buddyDetail", "_buddyStatusBar", "_message_sticker", "_stickerProductNew", "_sticker_history", "_sticonProduct", "_sticon_mapping" };
    foreach (string table in expectedTables) {
      bool found = false;
      foreach (string row in rows) if (row.Contains("\"tableName\":\"" + table + "\"")) { found = true; break; }
      if (!found) throw new InvalidOperationException("NATIVE_CATALOG_TABLE_NOT_EMITTED");
    }
    bool pkKey = false, rowIdKey = false;
    foreach (string row in rows) {
      if (row.Contains("\"recordKey\":\"pk:")) pkKey = true;
      if (row.Contains("\"recordKey\":\"rowid:" + snapshotDigest + ":")) rowIdKey = true;
    }
    if (!pkKey || !rowIdKey) throw new InvalidOperationException("NATIVE_CATALOG_RECORD_KEY_INVALID");
    bool badAckRejected = false;
    try { reader.AckNativeCatalogPage(1, new string('0', 64)); }
    catch (InvalidOperationException error) { badAckRejected = error.Message == "SOURCE_CATALOG_ACK_INVALID"; }
    if (!badAckRejected) throw new InvalidOperationException("NATIVE_CATALOG_BAD_ACK_ACCEPTED");
    bool pageAdvanceRejected = false;
    try { reader.ReadNativeCatalogPage(2, snapshotDigest, out hasMore, out digest); }
    catch (InvalidOperationException error) { pageAdvanceRejected = error.Message == "SOURCE_CATALOG_PAGE_INVALID"; }
    if (!pageAdvanceRejected) throw new InvalidOperationException("NATIVE_CATALOG_ADVANCED_BEFORE_ACK");
    reader.AckNativeCatalogPage(1, firstDigest);
    string[] terminal = reader.ReadNativeCatalogPage(2, snapshotDigest, out hasMore, out digest);
    if (terminal.Length != 0 || hasMore || digest == null || digest.Length != 64)
      throw new InvalidOperationException("NATIVE_CATALOG_TERMINAL_PAGE_INVALID");
    reader.AckNativeCatalogPage(2, digest);
  }

  static System.Collections.Generic.List<string> ReadAllDirectoryPages(Sqlite3Mc reader, out int pages) {
    System.Collections.Generic.List<string> all = new System.Collections.Generic.List<string>();
    pages = 0;
    bool hasMore = true;
    while (hasMore) {
      string digest;
      string[] rows = reader.ReadNativeDirectoryPage(pages + 1, out hasMore, out digest);
      int bytes = 0;
      foreach (string row in rows) bytes += Encoding.UTF8.GetByteCount(row);
      if (rows.Length > 500 || bytes > 700 * 1024 || (rows.Length == 0 && hasMore) || digest == null || digest.Length != 64)
        throw new InvalidOperationException("NATIVE_DIRECTORY_PAGE_BOUNDS_INVALID");
      all.AddRange(rows);
      reader.AckNativeDirectoryPage(pages + 1, digest);
      pages++;
    }
    return all;
  }

  static string FindDirectoryRow(System.Collections.Generic.List<string> rows, string kind, string idField, string id) {
    string needle = "{\"kind\":\"" + kind + "\",\"" + idField + "\":\"" + id + "\",";
    foreach (string row in rows) if (row.StartsWith(needle, StringComparison.Ordinal)) return row;
    throw new InvalidOperationException("NATIVE_DIRECTORY_ROW_MISSING_" + kind + "_" + id);
  }

  static void RequireDirectoryRow(string row, params string[] fragments) {
    foreach (string fragment in fragments)
      if (!row.Contains(fragment)) throw new InvalidOperationException("NATIVE_DIRECTORY_ROW_MISMATCH:" + fragment);
  }

  // A schema whose _contact lacks nickname/type/status columns (the shared fixture) must still
  // yield names instead of failing the pass.
  static void AssertNativeDirectoryDegradedSchema(Sqlite3Mc reader) {
    int pages;
    System.Collections.Generic.List<string> rows = ReadAllDirectoryPages(reader, out pages);
    RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "fixture-contact"),
      "\"displayName\":\"Fixture Contact\"", "\"nickname\":null", "\"type\":null", "\"status\":null");
    FindDirectoryRow(rows, "conversation", "chatId", "fixture-chat");
  }

  // Newer LINE builds keep names in _targetProfileDetail.profileName / _friendDetail.user.overriddenName; the legacy
  // columns are NULL there. Nickname wins; malformed, oversized or non-string JSON falls back to the legacy columns.
  static void AssertNativeDirectoryJsonNames(string root, byte[] key) {
    string database = Path.Combine(root, "directory-json.edb");
    Sqlite3Mc writer = Sqlite3Mc.OpenFixtureWriter(database, key);
    try {
      writer.CreateFixtureJsonContactTables();
      writer.Dispose();
      writer = null;
      int pages;
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(database, key)) {
        System.Collections.Generic.List<string> rows = ReadAllDirectoryPages(reader, out pages);
        RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "j-nick"), "\"displayName\":\"JSON Profile\"", "\"nickname\":\"JSON Nick\"");
        RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "j-nick"), "\"picturePath\":\"/p\"");
        RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "j-profile"), "\"displayName\":\"JSON Profile2\"", "\"nickname\":null");
        RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "j-bad"), "\"displayName\":\"Legacy Name\"", "\"nickname\":\"Legacy Nick\"");
        RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "j-legacy"), "\"displayName\":\"Old Name\"", "\"nickname\":\"Old Nick\"");
        RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "j-nonstring"), "\"displayName\":\"Fallback Name\"", "\"nickname\":null");
        RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "j-big"), "\"displayName\":\"Big Legacy\"", "\"nickname\":null");
        RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "j-empty"), "\"displayName\":null", "\"nickname\":null");
        RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "j-nick"), "\"title\":\"JSON Nick\"");
        RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "j-profile"), "\"title\":\"JSON Profile2\"");
        RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "j-bad"), "\"title\":\"Legacy Nick\"");
        RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "j-legacy"), "\"title\":\"Old Nick\"");
        RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "j-nonstring"), "\"title\":\"Fallback Name\"");
        RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "j-big"), "\"title\":\"Big Legacy\"");
        RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "j-empty"), "\"title\":null");
      }
    } finally { if (writer != null) writer.Dispose(); }
  }

  static void AssertNativeDirectoryPass(string root, byte[] key) {
    string database = Path.Combine(root, "directory.edb");
    Sqlite3Mc writer = Sqlite3Mc.OpenFixtureWriter(database, key);
    try {
      writer.CreateFixtureDirectoryTables(1300, 700);
      writer.Dispose();
      writer = Sqlite3Mc.OpenFixtureWriter(database, key);
      writer.TouchFixtureWalWithoutChangingRows();
      int pages;
      System.Collections.Generic.List<string> rows;
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(database, key)) {
        bool hasMore; string digest;
        // A schema without _unreadCount reports unsupported (never throws) and the directory pass still works afterwards.
        bool unreadSupported;
        System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, long>> noUnread = reader.ReadChatUnreadCounts(out unreadSupported);
        if (unreadSupported || noUnread.Count != 0) throw new InvalidOperationException("UNREAD_MISSING_COLUMN_SUPPORTED");
        string[] first = reader.ReadNativeDirectoryPage(1, out hasMore, out digest);
        if (first.Length != 500 || !hasMore) throw new InvalidOperationException("NATIVE_DIRECTORY_FIRST_PAGE_INVALID");
        bool badAck = false;
        try { reader.AckNativeDirectoryPage(1, new string('0', 64)); }
        catch (InvalidOperationException error) { badAck = error.Message == "SOURCE_DIRECTORY_ACK_INVALID"; }
        if (!badAck) throw new InvalidOperationException("NATIVE_DIRECTORY_BAD_ACK_ACCEPTED");
        bool advanced = false;
        try { reader.ReadNativeDirectoryPage(2, out hasMore, out digest); }
        catch (InvalidOperationException error) { advanced = error.Message == "SOURCE_DIRECTORY_PAGE_INVALID"; }
        if (!advanced) throw new InvalidOperationException("NATIVE_DIRECTORY_ADVANCED_BEFORE_ACK");
      }
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(database, key)) {
        rows = ReadAllDirectoryPages(reader, out pages);
      }
      // 1304 usable contacts (empty and NULL _mid skipped) + 711 chats, 500 rows per page.
      if (rows.Count != 2015 || pages != 5) throw new InvalidOperationException("NATIVE_DIRECTORY_COUNT_MISMATCH:" + rows.Count + ":" + pages);
      bool sawConversation = false;
      foreach (string row in rows) {
        if (row.StartsWith("{\"kind\":\"conversation\"", StringComparison.Ordinal)) sawConversation = true;
        else if (sawConversation) throw new InvalidOperationException("NATIVE_DIRECTORY_ORDER_INVALID");
        if (row.Contains("secret status") || row.Contains("0900000000")) throw new InvalidOperationException("NATIVE_DIRECTORY_EXTRA_FIELD_LEAKED");
      }
      RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "u-nick"),
        "\"displayName\":\"Real Name\"", "\"nickname\":\"張襄君\"", "\"type\":0", "\"status\":1");
      RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "u-nick"), "\"picturePath\":\"/fixture-picture\"");
      RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "u-plain"), "\"displayName\":\"Plain Name\"", "\"nickname\":null");
      RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "u-nameless"), "\"displayName\":null", "\"nickname\":null", "\"status\":2");
      RequireDirectoryRow(FindDirectoryRow(rows, "contact", "mid", "u-long"), "\"displayName\":\"" + new string('L', 256) + "\"", "\"nickname\":\"" + new string('N', 256) + "\"");
      foreach (string row in rows) if (row.Contains("\"mid\":\"\"")) throw new InvalidOperationException("NATIVE_DIRECTORY_EMPTY_MID_EMITTED");
      RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "u-nick"), "\"chatType\":\"direct\"", "\"title\":\"張襄君\"", "\"midType\":0");
      RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "u-plain"), "\"title\":\"Plain Name\"");
      RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "u-nameless"), "\"title\":null");
      RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "u-unknown"), "\"chatType\":\"direct\"", "\"title\":null");
      RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "g-1"), "\"chatType\":\"group\"", "\"title\":\"Group One\"", "\"picturePath\":\"/group-fixture-picture\"");
      RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "g-long-picture"), "\"picturePath\":\"/" + new string('p', 256) + "\"");
      RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "g-oversized-picture"), "\"picturePath\":null");
      RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "sq-chat"), "\"chatType\":\"community\"", "\"title\":\"Square Chat\"", "\"communityId\":\"sq-1\"", "\"picturePath\":\"squareobs-hash-fixture12345678\"");
      RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "th-1"), "\"chatType\":\"thread\"", "\"parentChatId\":\"sq-chat\"", "· thread");
      RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "room-1"), "\"chatType\":\"room\"");
      RequireDirectoryRow(FindDirectoryRow(rows, "conversation", "chatId", "odd-1"), "\"chatType\":\"room\"", "\"midType\":null");
      // A later pass (new reader session) sees a renamed nickname even though no message changed.
      writer.UpdateFixtureContactNickname("u-plain", "Pal");
      using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(database, key)) {
        System.Collections.Generic.List<string> again = ReadAllDirectoryPages(reader, out pages);
        RequireDirectoryRow(FindDirectoryRow(again, "contact", "mid", "u-plain"), "\"nickname\":\"Pal\"");
        RequireDirectoryRow(FindDirectoryRow(again, "conversation", "chatId", "u-plain"), "\"title\":\"Pal\"");
      }
    } finally { if (writer != null) writer.Dispose(); }
  }

  static void AssertNativeDirectoryBridgeWire() {
    const string requestId = "0123456789abcdef0123456789abcdef";
    string contact = "{\"kind\":\"contact\",\"mid\":\"u-1\",\"displayName\":\"A\",\"nickname\":null,\"type\":0,\"status\":1}";
    string[][] pages = new string[][] { new string[] { contact }, new string[0] };
    bool[] more = new bool[] { true, false };
    string[] frames = ExternalReaderBridge.FixtureRunDirectoryWire(requestId, pages, more, 0);
    if (frames.Length != 2 || !frames[0].Contains("\"type\":\"directory_page\"") || !frames[0].Contains("\"pageNumber\":1") ||
        !frames[0].Contains("\"rows\":[" + contact + "]") || !frames[0].Contains("\"hasMore\":true") ||
        !frames[1].Contains("\"type\":\"directory_page\"") || !frames[1].Contains("\"rows\":[]") || !frames[1].Contains("\"hasMore\":false"))
      throw new InvalidOperationException("NATIVE_DIRECTORY_BRIDGE_WIRE_MISMATCH");
    string[] badAck = ExternalReaderBridge.FixtureRunDirectoryWire(requestId, pages, more, 1);
    if (badAck.Length != 1) throw new InvalidOperationException("NATIVE_DIRECTORY_BRIDGE_BAD_ACK_ADVANCED");
  }

  static void AssertNativeCatalogBridgeWire() {
    const string requestId = "0123456789abcdef0123456789abcdef";
    const string snapshotDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    string rawRow = "{\"tableName\":\"_fixture\",\"recordKey\":\"pk:[1]\",\"nativePayload\":{\"format\":1,\"table\":\"_fixture\"}}";
    string[][] pages = new string[][] { new string[] { rawRow }, new string[0] };
    bool[] more = new bool[] { true, false };
    string[] frames = ExternalReaderBridge.FixtureRunCatalogWire(requestId, snapshotDigest, pages, more, 0, false);
    if (frames.Length != 2 || !frames[0].Contains("\"requestId\":\"" + requestId + "\"") ||
        !frames[0].Contains("\"sequence\":1") || !frames[0].Contains("\"pageNumber\":1") ||
        !frames[0].Contains("\"rows\":[" + rawRow + "]") || !frames[0].Contains("\"hasMore\":true") ||
        !frames[1].Contains("\"sequence\":2") || !frames[1].Contains("\"pageNumber\":2") ||
        !frames[1].Contains("\"rows\":[]") || !frames[1].Contains("\"hasMore\":false"))
      throw new InvalidOperationException("NATIVE_CATALOG_BRIDGE_WIRE_MISMATCH");
    string[] badAck = ExternalReaderBridge.FixtureRunCatalogWire(requestId, snapshotDigest, pages, more, 1, false);
    if (badAck.Length != 1 || !badAck[0].Contains("\"pageNumber\":1"))
      throw new InvalidOperationException("NATIVE_CATALOG_BRIDGE_BAD_ACK_ADVANCED");
    string[] cancelled = ExternalReaderBridge.FixtureRunCatalogWire(requestId, snapshotDigest, pages, more, 0, true);
    if (cancelled.Length != 0) throw new InvalidOperationException("NATIVE_CATALOG_BRIDGE_CANCEL_EMITTED");
  }

  static bool ContainsProperty(string[] rows, string id, string property) {
    string row = FindRowByMessageId(rows, id);
    return row != null && row.Contains("\"" + property + "\":");
  }

  static string ExtractMessageId(string row) {
    const string prefix = "\"nativeMessageId\":\"";
    int start = row.IndexOf(prefix, StringComparison.Ordinal);
    if (start < 0) throw new InvalidOperationException("FIXTURE_NATIVE_MESSAGE_ID_MISSING");
    start += prefix.Length;
    int end = row.IndexOf('"', start);
    if (end < 0) throw new InvalidOperationException("FIXTURE_NATIVE_MESSAGE_ID_INVALID");
    return row.Substring(start, end - start);
  }

  static string FindRowByMessageId(string[] rows, string id) {
    foreach (string row in rows) if (row.Contains("\"nativeMessageId\":\"" + id + "\"")) return row;
    return null;
  }

  static bool HasTitleLength(string[] rows, string id, int expectedLength) {
    string row = FindRowByMessageId(rows, id);
    const string marker = "\"conversationTitle\":\"";
    if (row == null) return false;
    int start = row.IndexOf(marker, StringComparison.Ordinal);
    if (start < 0) return false;
    start += marker.Length;
    int end = row.IndexOf('"', start);
    return end >= 0 && end - start == expectedLength;
  }

  static int Probe(string database, bool zeroKey) {
    byte[] probeKey = Encoding.ASCII.GetBytes(zeroKey ? "00000000000000000000000000000000" : "0123456789abcdef0123456789abcdef");
    try {
      using (Sqlite3Mc reader = Sqlite3Mc.OpenFixtureProbe(database, probeKey)) {
        string[] rows = reader.ReadFixtureMessageOrder(100);
        Console.Out.WriteLine("PROBE_OK|" + reader.DiagnosticSummary + "|rows=" + rows.Length.ToString());
        foreach (string row in rows) Console.Out.WriteLine("ROW\t" + row);
      }
      return 0;
    } catch (SqliteDiagnosticException error) {
      Console.Out.WriteLine("PROBE_FAIL|" + error.Summary);
      return 10;
    } catch (Exception error) {
      Console.Out.WriteLine("PROBE_FAIL|unknown|0|0|" + error.GetType().Name);
      return 11;
    } finally { Array.Clear(probeKey, 0, probeKey.Length); }
  }

  static void AssertOrder(string[] actual, string[] expected) {
    if (actual.Length != expected.Length) throw new InvalidOperationException("FIXTURE_ORDER_MISMATCH");
    for (int i = 0; i < actual.Length; i++) if (actual[i] != expected[i]) throw new InvalidOperationException("FIXTURE_ORDER_MISMATCH");
  }
  static string WithoutNativePayload(string row) {
    if (row == null) return null;
    int position = row.IndexOf(",\"nativePayload\":", StringComparison.Ordinal);
    return position < 0 ? row : row.Substring(0, position) + "}";
  }
  static bool SameProjection(string left, string right) { return WithoutNativePayload(left) == WithoutNativePayload(right); }
  static void AssertSameProjectionOrder(string[] actual, string[] expected) {
    if (actual.Length != expected.Length) throw new InvalidOperationException("FIXTURE_ORDER_MISMATCH");
    for (int i = 0; i < actual.Length; i++) if (!SameProjection(actual[i], expected[i])) throw new InvalidOperationException("FIXTURE_ORDER_MISMATCH");
  }

  static void AssertMessageOrder(string[] actual, string[] expected, bool hasMore) {
    if (hasMore || actual.Length != expected.Length) throw new InvalidOperationException("OPTIONAL_SQUARE_MEMBER_PAGE_ORDER_MISMATCH");
    for (int i = 0; i < actual.Length; i++)
      if (ExtractMessageId(actual[i]) != expected[i]) throw new InvalidOperationException("OPTIONAL_SQUARE_MEMBER_PAGE_ORDER_MISMATCH");
  }

  static void AssertScanProgress(System.Collections.Generic.List<string> progress) {
    foreach (string phase in new string[] { "count", "page_read" }) {
      long previous = -1; int count = 0;
      foreach (string item in progress) {
        string[] parts = item.Split('|');
        if (parts.Length != 2 || parts[0] != phase) continue;
        long current = Int64.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture);
        if (current <= previous) throw new InvalidOperationException("SCAN_PROGRESS_NOT_MONOTONIC");
        previous = current; count++;
      }
      if (count == 0) throw new InvalidOperationException("SCAN_PROGRESS_MISSING");
    }
  }

  static void AssertSourceUnchanged(string database, string wal, byte[] databaseBefore, byte[] walBefore) {
    if (!Equal(databaseBefore, Hash(database)) || !Equal(walBefore, Hash(wal))) throw new InvalidOperationException("READONLY_SOURCE_CHANGED");
  }

  static string CopyFixtureSnapshot(string root, string database, string wal) {
    const long maxSnapshotFileBytes = 32L * 1024 * 1024;
    byte[] databaseHash = Hash(database);
    byte[] walHash = Hash(wal);
    string snapshotDirectory = Path.Combine(root, "private-first-import");
    Directory.CreateDirectory(snapshotDirectory);
    string snapshotDatabase = Path.Combine(snapshotDirectory, "messages.edb");
    CopyBoundedFixtureFile(database, snapshotDatabase, maxSnapshotFileBytes);
    CopyBoundedFixtureFile(wal, snapshotDatabase + "-wal", maxSnapshotFileBytes);
    AssertSourceUnchanged(database, wal, databaseHash, walHash);
    return snapshotDatabase;
  }

  static void CopyBoundedFixtureFile(string source, string destination, long maxBytes) {
    FileAttributes attributes = File.GetAttributes(source);
    if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("FIXTURE_SOURCE_REPARSE");
    FileInfo before = new FileInfo(source);
    if (before.Length < 1 || before.Length > maxBytes) throw new InvalidOperationException("FIXTURE_SNAPSHOT_LIMIT");
    using (FileStream input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
    using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
      byte[] buffer = new byte[1024 * 1024];
      long copied = 0;
      int count;
      while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
        copied += count;
        if (copied > maxBytes) throw new InvalidOperationException("FIXTURE_SNAPSHOT_LIMIT");
        output.Write(buffer, 0, count);
      }
      Array.Clear(buffer, 0, buffer.Length);
      if (copied != before.Length) throw new InvalidOperationException("FIXTURE_SNAPSHOT_CHANGED");
    }
    FileInfo after = new FileInfo(source);
    if (after.Length != before.Length || after.LastWriteTimeUtc != before.LastWriteTimeUtc) throw new InvalidOperationException("FIXTURE_SNAPSHOT_CHANGED");
  }

  static byte[] Hash(string path) {
    using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
    using (SHA256 hash = SHA256.Create()) return hash.ComputeHash(stream);
  }

  static bool Equal(byte[] left, byte[] right) {
    if (left.Length != right.Length) return false;
    int difference = 0;
    for (int i = 0; i < left.Length; i++) difference |= left[i] ^ right[i];
    return difference == 0;
  }
}
