// src/shared/qa-evidence-runtime-images.ts
// Self-contained PNG/JPEG/WebP header decoders used to validate screenshot
// artifacts without any image dependency. Public surface re-exported by
// qa-evidence-runtime.ts.

import * as fs from 'fs';
import { inflateSync } from 'zlib';

import { sha256Bytes } from './core';
import type { DecodedImageInfo } from './types';

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePng(buffer: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(signature)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let ihdr = false;
  let iend = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) return null;
    const type = buffer.subarray(offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([type, data])) !== expectedCrc) return null;
    const name = type.toString('ascii');
    if (!ihdr && name !== 'IHDR') return null;
    if (name === 'IHDR') {
      if (ihdr || length !== 13) return null;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
      if (!width || !height || width > 20_000 || height > 100_000) return null;
      ihdr = true;
    } else if (name === 'IDAT') {
      if (!ihdr || iend) return null;
      compressed.push(data);
    } else if (name === 'IEND') {
      if (length !== 0 || !ihdr || compressed.length === 0) return null;
      iend = true;
      offset += 12;
      break;
    }
    offset += 12 + length;
  }
  if (!ihdr || !iend || offset !== buffer.length || interlace !== 0) return null;
  const channels = colorType === 0 ? 1
    : colorType === 2 ? 3
      : colorType === 3 ? 1
        : colorType === 4 ? 2
          : colorType === 6 ? 4
            : 0;
  if (!channels || ![1, 2, 4, 8, 16].includes(bitDepth)) return null;
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  const expectedBytes = (rowBytes + 1) * height;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > 512 * 1024 * 1024) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes + 1 });
  } catch {
    return null;
  }
  if (raw.length !== expectedBytes) return null;
  for (let row = 0; row < height; row += 1) {
    if (raw[row * (rowBytes + 1)]! > 4) return null;
  }
  return { width, height };
}

function decodeJpeg(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 12
    || buffer[0] !== 0xff
    || buffer[1] !== 0xd8
    || buffer[buffer.length - 2] !== 0xff
    || buffer[buffer.length - 1] !== 0xd9) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length - 2) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = buffer[offset + 1]!;
    while (marker === 0xff && offset + 2 < buffer.length) {
      offset += 1;
      marker = buffer[offset + 1]!;
    }
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    const sof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (sof) {
      if (length < 8) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function decodeWebp(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30
    || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
    || buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
    || buffer.readUInt32LE(4) + 8 > buffer.length) return null;
  const kind = buffer.subarray(12, 16).toString('ascii');
  if (kind === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { width, height };
  }
  if (kind === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === 'VP8L' && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

export function decodeImageFile(filePath: string): DecodedImageInfo | null {
  let buffer: Buffer;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 12 || stat.size > 256 * 1024 * 1024) return null;
    buffer = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  const decoded = decodePng(buffer);
  if (decoded) return { format: 'png', ...decoded, contentHash: sha256Bytes(buffer) };
  const jpeg = decodeJpeg(buffer);
  if (jpeg) return { format: 'jpeg', ...jpeg, contentHash: sha256Bytes(buffer) };
  const webp = decodeWebp(buffer);
  if (webp) return { format: 'webp', ...webp, contentHash: sha256Bytes(buffer) };
  return null;
}
