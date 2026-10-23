import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const iconRoot = path.join(root, 'apps', 'desktop', 'assets', 'icons');
const requiredSizes = [16, 32, 48, 64, 128, 256];

function pngChunks(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
  }
  return chunks;
}

function assertRgbaPngHasVisiblePixels(bytes, expectedSize) {
  const chunks = pngChunks(bytes);
  const header = chunks.find((chunk) => chunk.type === 'IHDR')?.data;
  assert.ok(header, 'PNG must contain IHDR');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  assert.equal(width, expectedSize);
  assert.equal(height, expectedSize);
  assert.equal(header[8], 8, 'PNG must use 8-bit channels');
  assert.equal(header[9], 6, 'PNG must use RGBA pixels');
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  const filtered = inflateSync(compressed);
  const stride = width * 4;
  let previous = Buffer.alloc(stride);
  let visible = false;
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const filter = filtered[rowIndex * (stride + 1)];
    const row = Buffer.from(filtered.subarray(rowIndex * (stride + 1) + 1, (rowIndex + 1) * (stride + 1)));
    for (let index = 0; index < stride; index += 1) {
      const left = index >= 4 ? row[index - 4] : 0;
      const up = previous[index];
      const upperLeft = index >= 4 ? previous[index - 4] : 0;
      if (filter === 1) row[index] = (row[index] + left) & 255;
      else if (filter === 2) row[index] = (row[index] + up) & 255;
      else if (filter === 3) row[index] = (row[index] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upperLeft;
        const nearest = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upperLeft)
          ? left : Math.abs(p - up) <= Math.abs(p - upperLeft) ? up : upperLeft;
        row[index] = (row[index] + nearest) & 255;
      } else assert.equal(filter, 0, `unsupported PNG filter ${filter}`);
    }
    for (let alpha = 3; alpha < stride; alpha += 4) visible ||= row[alpha] > 0;
    previous = row;
  }
  assert.ok(visible, 'PNG must contain non-transparent pixels');
}

function icoImages(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    const width = bytes[offset] || 256;
    const height = bytes[offset + 1] || 256;
    const length = bytes.readUInt32LE(offset + 8);
    const imageOffset = bytes.readUInt32LE(offset + 12);
    return { width, height, bytes: bytes.subarray(imageOffset, imageOffset + length) };
  });
}

test('ships normalized spring PNG and multi-size ICO assets', async () => {
  const png = await readFile(path.join(iconRoot, 'line-agent-spring.png'));
  assertRgbaPngHasVisiblePixels(png, 512);
  const images = icoImages(await readFile(path.join(iconRoot, 'line-agent-spring.ico')));
  assert.deepEqual(images.map((image) => image.width).sort((a, b) => a - b), requiredSizes);
  for (const image of images) {
    assert.equal(image.width, image.height);
    assertRgbaPngHasVisiblePixels(image.bytes, image.width);
  }
});

test('maps the selected spring theme into the Windows package', async () => {
  const builder = await readFile(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.match(builder, /^\s*icon: apps\/desktop\/assets\/icons\/line-agent-spring\.ico\s*$/m);
});
