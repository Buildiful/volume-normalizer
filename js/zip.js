/** ZIP STORE writer: no compression (audio is already compressed / WAV chunks large).
 * Uses Blob segments, Zip32 + UTF-8 flags. No dependency or data upload.
 */
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let n = i; for (let b = 0; b < 8; b++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : (n >>> 1); table[i] = n >>> 0; }
export function crcStart() { return 0xffffffff; }
export function crcUpdate(crc, bytes) { for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8); return crc >>> 0; }
export function crcFinish(crc) { return (crc ^ 0xffffffff) >>> 0; }
const encoder = new TextEncoder();
const u16 = (v, n, value) => v.setUint16(n, value, true);
const u32 = (v, n, value) => v.setUint32(n, value >>> 0, true);
export class ZipArchive {
  constructor() { this.parts = []; this.central = []; this.offset = 0; }
  add(filename, parts, bytes, crc) {
    if (bytes > 0xffffffff || this.offset > 0xffffffff) throw new Error('ZIP exceeds 4 GB. Choose a destination folder instead.');
    if (this.central.length >= 65535) throw new Error('ZIP file count limit reached.');
    const name = encoder.encode(filename.replace(/\\/g, '/'));
    if (name.length > 65535) throw new Error('Filename too long for ZIP.');
    const local = new Uint8Array(30 + name.length);
    const d = new DataView(local.buffer);
    u32(d, 0, 0x04034b50); u16(d, 4, 20); u16(d, 6, 0x0800); u16(d, 8, 0);
    u32(d, 14, crc); u32(d, 18, bytes); u32(d, 22, bytes); u16(d, 26, name.length);
    local.set(name, 30);
    const location = this.offset;
    this.parts.push(local, ...parts);
    this.offset += local.length + bytes;
    this.central.push({ name, crc, bytes, location });
  }
  finish() {
    const centralStart = this.offset;
    for (const entry of this.central) {
      const chunk = new Uint8Array(46 + entry.name.length);
      const d = new DataView(chunk.buffer);
      u32(d, 0, 0x02014b50); u16(d, 4, 20); u16(d, 6, 20); u16(d, 8, 0x0800);
      u32(d, 16, entry.crc); u32(d, 20, entry.bytes); u32(d, 24, entry.bytes);
      u16(d, 28, entry.name.length); u32(d, 42, entry.location);
      chunk.set(entry.name, 46);
      this.parts.push(chunk); this.offset += chunk.length;
    }
    if (this.offset > 0xffffffff) throw new Error('ZIP exceeds 4 GB. Choose a destination folder instead.');
    const end = new Uint8Array(22); const d = new DataView(end.buffer);
    u32(d, 0, 0x06054b50); u16(d, 8, this.central.length); u16(d, 10, this.central.length);
    u32(d, 12, this.offset - centralStart); u32(d, 16, centralStart);
    this.parts.push(end);
    return new Blob(this.parts, { type: 'application/zip' });
  }
}
