'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32Update(buf, crc) {
  let c = crc ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date: day };
}

/**
 * 极简 ZIP 打包器（store 方式 + ZIP64 支持），无第三方依赖。
 */
class ZipWriter {
  constructor(outPath) {
    this.fd = fs.openSync(outPath, 'w');
    this.offset = 0;
    this.entries = [];
    this.closed = false;
  }

  _write(buf) {
    fs.writeSync(this.fd, buf, 0, buf.length, this.offset);
    this.offset += buf.length;
  }

  async addFile(filePath, nameInZip) {
    const stat = fs.statSync(filePath);
    const name = Buffer.from(nameInZip || path.basename(filePath), 'utf8');
    const { time, date } = dosDateTime(stat.mtime);

    // 第一遍：计算 CRC32
    let crc = 0;
    const rs = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    for await (const chunk of rs) {
      crc = crc32Update(chunk, crc);
    }
    const size = stat.size;

    const needsZip64 = size >= 0xffffffff || this.offset >= 0xffffffff;
    const extra = needsZip64 ? this._zip64Extra(size, size) : Buffer.alloc(0);

    const localOffset = this.offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(needsZip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(needsZip64 ? 0xffffffff : size, 18);
    local.writeUInt32LE(needsZip64 ? 0xffffffff : size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);

    this._write(local);
    this._write(name);
    if (extra.length) this._write(extra);

    // 第二遍：写入文件内容
    const ws = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    for await (const chunk of ws) {
      this._write(chunk);
    }

    this.entries.push({ name, crc, size, localOffset, needsZip64, time, date, method: 0 });
    return { size, crc };
  }

  _zip64Extra(uncompressed, compressed) {
    const extra = Buffer.alloc(20);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(uncompressed), 4);
    extra.writeBigUInt64LE(BigInt(compressed), 12);
    return extra;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const cdStart = this.offset;
    for (const e of this.entries) {
      const extra = e.needsZip64
        ? (() => {
            const b = Buffer.alloc(24);
            b.writeUInt16LE(0x0001, 0);
            b.writeUInt16LE(20, 2);
            b.writeBigUInt64LE(BigInt(e.size), 4);
            b.writeBigUInt64LE(BigInt(e.size), 12);
            b.writeBigUInt64LE(BigInt(e.localOffset), 20);
            return b;
          })()
        : Buffer.alloc(0);
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(e.needsZip64 ? 45 : 20, 6);
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(e.method, 10);
      head.writeUInt16LE(e.time, 12);
      head.writeUInt16LE(e.date, 14);
      head.writeUInt32LE(e.crc >>> 0, 16);
      head.writeUInt32LE(e.needsZip64 ? 0xffffffff : e.size, 20);
      head.writeUInt32LE(e.needsZip64 ? 0xffffffff : e.size, 24);
      head.writeUInt16LE(e.name.length, 28);
      head.writeUInt16LE(extra.length, 30);
      head.writeUInt16LE(0, 32);
      head.writeUInt16LE(0, 34);
      head.writeUInt16LE(0, 36);
      head.writeUInt32LE(0, 38);
      head.writeUInt32LE(e.needsZip64 ? 0xffffffff : e.localOffset, 42);
      this._write(head);
      this._write(e.name);
      if (extra.length) this._write(extra);
    }
    const cdSize = this.offset - cdStart;

    const needsZip64 = this.entries.length >= 0xffff || cdStart >= 0xffffffff || cdSize >= 0xffffffff;
    if (needsZip64) {
      const z64 = Buffer.alloc(56);
      z64.writeUInt32LE(0x06064b50, 0);
      z64.writeBigUInt64LE(BigInt(this.entries.length), 8);
      z64.writeBigUInt64LE(BigInt(this.entries.length), 16);
      z64.writeBigUInt64LE(BigInt(cdSize), 24);
      z64.writeBigUInt64LE(BigInt(cdStart), 32);
      this._write(z64);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(this.offset), 8);
      locator.writeUInt32LE(1, 16);
      this._write(locator);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(Math.min(this.entries.length, 0xffff), 8);
    eocd.writeUInt16LE(Math.min(this.entries.length, 0xffff), 10);
    eocd.writeUInt32LE(Math.min(cdSize, 0xffffffff), 12);
    eocd.writeUInt32LE(Math.min(cdStart, 0xffffffff), 16);
    eocd.writeUInt16LE(0, 20);
    this._write(eocd);

    fs.closeSync(this.fd);
  }
}

/** 把若干文件打包成 zip */
async function zipFiles(files, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const zw = new ZipWriter(outPath);
  try {
    for (const f of files) {
      if (!fs.existsSync(f.path)) continue;
      await zw.addFile(f.path, f.name);
    }
  } finally {
    zw.close();
  }
  return { path: outPath, size: fs.statSync(outPath).size, entries: zw.entries.length };
}

module.exports = { ZipWriter, zipFiles, crc32Update };
