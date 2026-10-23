using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

internal static class FixedBackupFixtureHarness {
  static int Main() {
    string root = Path.Combine(Path.GetTempPath(), "linejs-fixed-backup-" + Guid.NewGuid().ToString("N"));
    string database = Path.Combine(root, "messages.edb"), privateDirectory = Path.Combine(root, "private");
    byte[] key = Encoding.ASCII.GetBytes("0123456789abcdef0123456789abcdef");
    Sqlite3Mc writer = null; LineEncryptedSnapshot.Capture capture = null;
    try {
      Directory.CreateDirectory(root);
      writer = Sqlite3Mc.OpenFixtureWriter(database, key); writer.CreateFixtureWal(); writer.CreateFixtureBackupPayload(8 * 1024 * 1024);
      List<string> progress = new List<string>();
      LineEncryptedSnapshot.Limits limits = new LineEncryptedSnapshot.Limits {
        MaxDatabaseBytes = 5L * 1024 * 1024 * 1024, MaxWalBytes = 512L * 1024 * 1024,
        MaxSnapshotBytes = 5632L * 1024 * 1024, ReadChunkBytes = 64 * 1024,
      };
      string replacementDirectory = Path.Combine(root, "replacement-private");
      string replacementCandidate = Path.Combine(root, "replacement-candidate.edb");
      string displacedPath = Path.Combine(root, "displaced-placeholder.edb");
      byte[] replacementBytes = Encoding.ASCII.GetBytes("replacement-sentinel");
      File.WriteAllBytes(replacementCandidate, replacementBytes);
      bool replacementInstalled = false;
      bool replacementFailureReported = false;
      Sqlite3Mc.TestBeforeBackupDestinationOpen = delegate() {
        try {
          File.Move(Path.Combine(replacementDirectory, "snapshot.edb"), displacedPath);
          File.Move(replacementCandidate, Path.Combine(replacementDirectory, "snapshot.edb"));
          replacementInstalled = true;
        } catch (IOException) { }
      };
      LineEncryptedSnapshot.Capture replacementCapture = null;
      try {
        replacementCapture = LineEncryptedSnapshot.CaptureFixed(database, replacementDirectory, key, limits, CancellationToken.None,
          "fixture-own-mid", delegate(string path) {
            using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(path, key)) {
              if (!reader.VerifyOfficialSchemaAndMid("fixture-own-mid", CancellationToken.None)) throw new InvalidOperationException("FIXTURE_REPLACEMENT_MID_MISMATCH");
            }
          }, delegate(long copied, long total) { });
      } catch (InvalidOperationException error) { replacementFailureReported = error.Message == "snapshot_ownership_lost"; }
      finally { Sqlite3Mc.TestBeforeBackupDestinationOpen = null; }
      if (replacementCapture != null) { replacementCapture.Cleanup(true); replacementCapture = null; }
      bool candidatePreserved = File.Exists(replacementCandidate) && Encoding.ASCII.GetString(File.ReadAllBytes(replacementCandidate)) == "replacement-sentinel";
      Array.Clear(replacementBytes, 0, replacementBytes.Length);
      bool replacementGuardPassed = !replacementInstalled && candidatePreserved && !Directory.Exists(replacementDirectory) && !replacementFailureReported;
      if (candidatePreserved) File.Delete(replacementCandidate);
      Sqlite3Mc.TestBackupAfterBatch = delegate() { writer.UpdateFixtureBackupMarker(); };
      capture = LineEncryptedSnapshot.CaptureFixed(database, privateDirectory, key, limits, CancellationToken.None,
        "fixture-own-mid", delegate(string path) {
          using (Sqlite3Mc reader = Sqlite3Mc.OpenReadOnly(path, key)) {
            if (!reader.VerifyOfficialSchemaAndMid("fixture-own-mid", CancellationToken.None)) throw new InvalidOperationException("FIXTURE_SNAPSHOT_MID_MISMATCH");
          }
        }, delegate(long copied, long total) { progress.Add(copied.ToString() + "/" + total.ToString()); });
      if (Sqlite3Mc.TestBackupAfterBatch != null) throw new InvalidOperationException("FIXTURE_BACKUP_DID_NOT_MUTATE");
      if (capture.WalPath != null || capture.WalBytes != 0 || capture.WalSha256 != null) throw new InvalidOperationException("FIXTURE_COPY_WAL_NOT_COLLAPSED");
      byte[] wrongKey = Encoding.ASCII.GetBytes("abcdef0123456789abcdef0123456789");
      try {
        if (!LineEncryptedPageValidator.FirstPageValid(capture.DatabasePath, key) || LineEncryptedPageValidator.FirstPageValid(capture.DatabasePath, wrongKey))
          throw new InvalidOperationException("FIXTURE_COPY_ENCRYPTION_INVALID");
      } finally { Array.Clear(wrongKey, 0, wrongKey.Length); }
      using (Sqlite3Mc snapshot = Sqlite3Mc.OpenReadOnly(capture.DatabasePath, key)) {
        if (snapshot.ReadFixtureBackupMarker() != "before" || snapshot.ReadFixtureMessageOrder(100).Length != 4)
          throw new InvalidOperationException("FIXTURE_COPY_NOT_FIXED");
      }
      if (writer.ReadFixtureBackupMarker() != "after" || writer.ReadFixtureMessageOrder(100).Length != 5)
        throw new InvalidOperationException("FIXTURE_SOURCE_DID_NOT_ADVANCE");
      long previous = -1, totalBytes = -1;
      foreach (string item in progress) {
        string[] parts = item.Split('/'); long copied = Int64.Parse(parts[0]), total = Int64.Parse(parts[1]);
        if (copied <= previous || total < copied || (totalBytes >= 0 && total != totalBytes)) throw new InvalidOperationException("FIXTURE_COPY_PROGRESS_INVALID");
        previous = copied; totalBytes = total;
      }
      if (progress.Count < 2 || previous != totalBytes) throw new InvalidOperationException("FIXTURE_COPY_PROGRESS_INCOMPLETE");
      capture.Cleanup(true); capture = null;
      if (Directory.Exists(privateDirectory)) throw new InvalidOperationException("FIXTURE_COPY_OWNER_NOT_CLEANED");
      string cancelDirectory = Path.Combine(root, "cancel-private");
      bool canceled = false;
      string unknownSidecar = Path.Combine(cancelDirectory, "snapshot.edb-wal");
      byte[] unknownSidecarBytes = Encoding.ASCII.GetBytes("unowned-sidecar-sentinel");
      bool cancelCleanupRejectedUnknown = false;
      using (CancellationTokenSource cancellation = new CancellationTokenSource()) {
        Sqlite3Mc.TestBackupAfterBatch = delegate() { File.WriteAllBytes(unknownSidecar, unknownSidecarBytes); cancellation.Cancel(); };
        try {
          LineEncryptedSnapshot.CaptureFixed(database, cancelDirectory, key, limits, cancellation.Token,
            "fixture-own-mid", delegate(string path) { throw new InvalidOperationException("FIXTURE_CANCELED_COPY_PUBLISHED"); },
            delegate(long copied, long total) { });
        } catch (OperationCanceledException) { canceled = true; }
          catch (InvalidOperationException error) { cancelCleanupRejectedUnknown = error.Message == "snapshot_ownership_lost"; }
      }
      bool unknownSidecarPreserved = File.Exists(unknownSidecar) && Encoding.ASCII.GetString(File.ReadAllBytes(unknownSidecar)) == "unowned-sidecar-sentinel";
      bool canceledOwnedArtifactsCleaned = !File.Exists(Path.Combine(cancelDirectory, "snapshot.edb")) && !File.Exists(Path.Combine(cancelDirectory, "snapshot.owner"));
      bool cancelCleanupCorrect = !canceled && cancelCleanupRejectedUnknown && unknownSidecarPreserved && canceledOwnedArtifactsCleaned && Directory.Exists(cancelDirectory);
      Array.Clear(unknownSidecarBytes, 0, unknownSidecarBytes.Length);
      Sqlite3Mc.TestBackupAfterBatch = null;
      writer.TouchFixtureWalWithoutChangingRows();
      string limitedDirectory = Path.Combine(root, "limited-private");
      LineEncryptedSnapshot.Limits limited = new LineEncryptedSnapshot.Limits {
        MaxDatabaseBytes = limits.MaxDatabaseBytes, MaxWalBytes = 1, MaxSnapshotBytes = limits.MaxSnapshotBytes, ReadChunkBytes = limits.ReadChunkBytes,
      };
      bool limitRejected = false;
      try {
        LineEncryptedSnapshot.CaptureFixed(database, limitedDirectory, key, limited, CancellationToken.None,
          "fixture-own-mid", delegate(string path) { throw new InvalidOperationException("FIXTURE_LIMITED_COPY_PUBLISHED"); },
          delegate(long copied, long total) { });
      } catch (InvalidOperationException error) { limitRejected = error.Message == "snapshot_size_limit"; }
      if (!limitRejected || Directory.Exists(limitedDirectory)) throw new InvalidOperationException("FIXTURE_LIMIT_CLEANUP_FAILED");
      bool busyBounded = VerifyBoundedBackupFailure(database, Path.Combine(root, "busy-private"), key, limits, 5);
      bool lockedBounded = VerifyBoundedBackupFailure(database, Path.Combine(root, "locked-private"), key, limits, 6);
      if (!replacementGuardPassed || !cancelCleanupCorrect || !busyBounded || !lockedBounded)
        throw new InvalidOperationException("FIXTURE_SECURITY_GUARDS_FAILED|replacement=" + replacementGuardPassed.ToString() +
          "|unknownSidecar=" + cancelCleanupCorrect.ToString() + "|busy=" + busyBounded.ToString() + "|locked=" + lockedBounded.ToString());
      Console.WriteLine("PASS|replacement=blocked|progressUpdates=" + progress.Count.ToString() + "|sourceRows=5|snapshotRows=4|cancel=unknown-preserved|limit=clean|busy=bounded|locked=bounded");
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine("FIXED_BACKUP:" + error.GetType().Name + ":" + error.Message); return 1;
    } finally {
      Sqlite3Mc.TestBeforeBackupDestinationOpen = null;
      Sqlite3Mc.TestBackupAfterBatch = null;
      if (capture != null) try { capture.Cleanup(true); } catch { }
      if (writer != null) writer.Dispose();
      Array.Clear(key, 0, key.Length);
      try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
    }
  }

  static bool VerifyBoundedBackupFailure(string database, string destination, byte[] key, LineEncryptedSnapshot.Limits limits, int busyState) {
    bool published = false, bounded = false, sourceReleased = false;
    int progressHeartbeats = 0;
    long timestamp = System.Diagnostics.Stopwatch.GetTimestamp();
    Sqlite3Mc.TestBackupStepOverride = delegate(IntPtr backup, int pages) { return busyState; };
    Sqlite3Mc.TestBackupTimestamp = delegate() { timestamp += System.Diagnostics.Stopwatch.Frequency * 40L; return timestamp; };
    try {
      LineEncryptedSnapshot.CaptureFixed(database, destination, key, limits, CancellationToken.None,
        "fixture-own-mid", delegate(string path) { published = true; }, delegate(long copied, long total) { progressHeartbeats++; });
    } catch (InvalidOperationException error) { bounded = error.Message == "snapshot_backup_no_progress"; }
    finally { Sqlite3Mc.TestBackupStepOverride = null; Sqlite3Mc.TestBackupTimestamp = null; }
    try {
      using (Sqlite3Mc writer = Sqlite3Mc.OpenFixtureWriter(database, key)) writer.TouchFixtureWalWithoutChangingRows();
      sourceReleased = true;
    } catch { }
    return bounded && progressHeartbeats > 1 && !published && sourceReleased && !Directory.Exists(destination);
  }
}
