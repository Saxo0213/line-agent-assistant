using System;
using System.IO;
using System.Security.Cryptography;

// Pure encrypted page-1 validation ported from the pinned v3.1.0 locator.
// This code reads bytes only and must run before SQLite is opened.
internal static class LineEncryptedPageValidator {
  static readonly byte[] Padding = new byte[] {
    0x28,0xbf,0x4e,0x5e,0x4e,0x75,0x8a,0x41,0x64,0x00,0x4e,0x56,0xff,0xfa,0x01,0x08,
    0x2e,0x2e,0x00,0xb6,0xd0,0x68,0x3e,0x80,0x2f,0x0c,0xa9,0xfe,0x64,0x53,0x69,0x7a
  };
  internal static bool FirstPageValid(string database, byte[] passphrase) {
    string ignored;
    return FirstPageValid(database, passphrase, out ignored);
  }

  internal static bool FirstPageValid(string database, byte[] passphrase, out string failureStage) {
    failureStage = "source_read";
    if (passphrase == null || passphrase.Length != 32) return false;
    byte[] page = new byte[4096];
    try {
      using (FileStream stream = new FileStream(database, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
        int offset = 0;
        while (offset < page.Length) {
          int read = stream.Read(page, offset, page.Length - offset);
          if (read <= 0) return false;
          offset += read;
        }
      }
      return FirstPageValid(page, passphrase, out failureStage);
    } catch { return false; }
    finally { Array.Clear(page, 0, page.Length); }
  }

  internal static bool FirstPageValid(byte[] page, byte[] passphrase) {
    string ignored;
    return FirstPageValid(page, passphrase, out ignored);
  }

  internal static bool FirstPageValid(byte[] page, byte[] passphrase, out string failureStage) {
    failureStage = "input";
    if (page == null || page.Length < 4096 || passphrase == null || passphrase.Length != 32) return false;
    byte[] ownerSeed = (byte[])Padding.Clone();
    byte[] padded = new byte[32];
    byte[] owner = null;
    byte[] combined = null;
    byte[] baseKey = null;
    byte[] aesKeyMaterial = null;
    byte[] aesKey = null;
    byte[] iv = null;
    byte[] payload = null;
    byte[] plaintext = null;
    try {
      Buffer.BlockCopy(passphrase, 0, padded, 0, 32);
      for (int i = 0; i < 51; i++) ReplaceWithMd5(ref ownerSeed);
      owner = (byte[])padded.Clone();
      for (int i = 0; i < 20; i++) {
        byte[] rc4Key = new byte[ownerSeed.Length];
        for (int n = 0; n < rc4Key.Length; n++) rc4Key[n] = (byte)(ownerSeed[n] ^ i);
        byte[] transformed = Rc4(rc4Key, owner);
        Array.Clear(rc4Key, 0, rc4Key.Length);
        Array.Clear(owner, 0, owner.Length);
        owner = transformed;
      }
      combined = new byte[padded.Length + owner.Length];
      Buffer.BlockCopy(padded, 0, combined, 0, padded.Length);
      Buffer.BlockCopy(owner, 0, combined, padded.Length, owner.Length);
      baseKey = combined;
      combined = null;
      for (int i = 0; i < 51; i++) ReplaceWithMd5(ref baseKey);

      failureStage = "clear_header";
      if (page[21] != 64 || page[22] != 32 || page[23] != 32) return false;
      payload = new byte[page.Length - 16];
      Buffer.BlockCopy(page, 8, payload, 0, 8);
      Buffer.BlockCopy(page, 24, payload, 8, page.Length - 24);
      byte[] keyInput = new byte[baseKey.Length + 8];
      Buffer.BlockCopy(baseKey, 0, keyInput, 0, baseKey.Length);
      keyInput[baseKey.Length] = 1;
      keyInput[baseKey.Length + 4] = (byte)'s';
      keyInput[baseKey.Length + 5] = (byte)'A';
      keyInput[baseKey.Length + 6] = (byte)'l';
      keyInput[baseKey.Length + 7] = (byte)'T';
      aesKeyMaterial = Md5(keyInput);
      Array.Clear(keyInput, 0, keyInput.Length);
      aesKey = new byte[16]; Buffer.BlockCopy(aesKeyMaterial, 0, aesKey, 0, aesKey.Length);
      iv = PageIv(1);
      using (Aes aes = Aes.Create()) {
        aes.Mode = CipherMode.CBC; aes.Padding = PaddingMode.None; aes.Key = aesKey; aes.IV = iv;
        using (ICryptoTransform decryptor = aes.CreateDecryptor()) plaintext = decryptor.TransformFinalBlock(payload, 0, payload.Length);
      }
      failureStage = "header_decrypt";
      for (int i = 0; i < 8; i++) if (plaintext[i] != page[16 + i]) return false;
      bool valid = plaintext[84] == 5 || plaintext[84] == 13;
      uint schemaFormat = ((uint)plaintext[40] << 24) | ((uint)plaintext[41] << 16) | ((uint)plaintext[42] << 8) | plaintext[43];
      failureStage = "page_shape";
      valid = valid && (schemaFormat == 1 || schemaFormat == 2 || schemaFormat == 3);
      if (!valid) failureStage = "page_shape";
      if (valid) failureStage = "valid";
      return valid;
    } catch { failureStage = "crypto"; return false; }
    finally {
      Clear(ownerSeed); Clear(padded); Clear(owner); Clear(combined); Clear(baseKey);
      Clear(aesKeyMaterial); Clear(aesKey); Clear(iv); Clear(payload); Clear(plaintext);
    }
  }

  static byte[] PageIv(int pageNumber) {
    ulong seed = (ulong)(pageNumber + 1); byte[] words = new byte[16];
    for (int i = 0; i < 4; i++) {
      seed = (40692UL * seed) % 2147483399UL;
      words[i * 4] = (byte)seed; words[i * 4 + 1] = (byte)(seed >> 8);
      words[i * 4 + 2] = (byte)(seed >> 16); words[i * 4 + 3] = (byte)(seed >> 24);
    }
    try { return Md5(words); } finally { Array.Clear(words, 0, words.Length); }
  }

  static byte[] Rc4(byte[] key, byte[] data) {
    byte[] state = new byte[256], output = new byte[data.Length];
    for (int i = 0; i < 256; i++) state[i] = (byte)i;
    int j = 0;
    for (int i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.Length]) & 255; byte t = state[i]; state[i] = state[j]; state[j] = t; }
    int x = 0; j = 0;
    for (int n = 0; n < data.Length; n++) { x = (x + 1) & 255; j = (j + state[x]) & 255; byte t = state[x]; state[x] = state[j]; state[j] = t; output[n] = (byte)(data[n] ^ state[(state[x] + state[j]) & 255]); }
    Array.Clear(state, 0, state.Length); return output;
  }
  static byte[] Md5(byte[] value) { using (MD5 md5 = MD5.Create()) return md5.ComputeHash(value); }
  static void ReplaceWithMd5(ref byte[] value) { byte[] next = Md5(value); Array.Clear(value, 0, value.Length); value = next; }
  static void Clear(byte[] value) { if (value != null) Array.Clear(value, 0, value.Length); }
}
