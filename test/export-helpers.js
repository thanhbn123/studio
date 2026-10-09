/**
 * Tiện ích dùng chung cho bộ test MVP-06 “Gói xuất bản (.zip)”.
 *
 * Nguyên tắc giống các helper khác của repo: KHÔNG cần mạng, KHÔNG cần API key.
 *  - `startExportApp()` dựng app THẬT (server thật, SQLite in-memory) như `imagelab-helpers.js`.
 *  - `snapshotTree()` băm sha256 MỌI file trong một cây thư mục để chứng minh bất biến asset.
 *  - `readZipEntries()` là bộ đọc ZIP viết TAY trong test (không dùng `createZip` cũng không
 *    dùng `inspectZip`) — nhờ vậy nội dung từng entry được kiểm bằng một đường độc lập nữa.
 *  - `makeRepoCopy()` sao chép repo sang thư mục tạm (có thể XOÁ `src/exports`) để mô phỏng
 *    “module export không nạp được” trong một tiến trình con thật.
 *
 * File này KHÔNG có hậu tố `.test.js` nên `node --test test/*.test.js` không chạy nó.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { ROOT, startImagelabApp, tmpDir, j, cookie } from './imagelab-helpers.js';

export { ROOT, tmpDir, j, cookie };

/* ───────────────────────── băm + ảnh chụp cây thư mục ───────────────────────── */

/** sha256 hex của Buffer/chuỗi. */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Băm sha256 MỌI file trong một cây thư mục (đệ quy) → `{ 'rel/path': sha256 }`.
 * Dùng để khẳng định “xuất gói KHÔNG sửa/không tạo file nào trên đĩa”.
 */
export function snapshotTree(dir) {
  const out = Object.create(null);
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) out[path.relative(dir, full).split(path.sep).join('/')] = sha256Hex(fs.readFileSync(full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/* ───────────────────────── đọc ZIP bằng tay (đường độc lập) ───────────────────────── */

const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/**
 * Đọc một buffer ZIP thành `Map<tên, {name, method, crc32, size, data, flags}>`.
 * KHÔNG import `src/exports/**`: chỉ parse central directory + local header rồi tự
 * `inflateRawSync`, nên nếu bộ ghi ZIP sai thì hàm này cũng lộ ra.
 */
export function readZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 22 - 0xffff); p -= 1) {
    if (buf.readUInt32LE(p) === SIG_EOCD && p + 22 + buf.readUInt16LE(p + 20) === buf.length) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new Error('readZipEntries: không tìm thấy EOCD.');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`readZipEntries: sai chữ ký central ở offset ${p}.`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(local + 26);
    const localExtraLen = buf.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body);
    out.set(name, { name, method, crc32: crc, size: uncompSize, data, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** JSON của một entry trong ZIP (ném lỗi rõ ràng nếu thiếu). */
export function zipJson(entries, name) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`ZIP thiếu entry ${name} (đang có: ${[...entries.keys()].join(', ')})`);
  return JSON.parse(entry.data.toString('utf8'));
}

/* ───────────────────────── app THẬT cho test API ───────────────────────── */

/**
 * App thật + SQLite in-memory, rate limit nới rộng để test nghiệp vụ không vướng 429
 * (test 429 dùng app riêng với trần thấp).
 */
export async function startExportApp({ configOverrides = {}, ...rest } = {}) {
  return startImagelabApp({
    configOverrides: {
      RATE_LIMIT_MAX_JOBS: '5000',
      RATE_LIMIT_MAX_REQUESTS: '50000',
      ...configOverrides,
    },
    ...rest,
  });
}

/* ───────────────────── dữ liệu job: ghi thẳng vào store THẬT ───────────────────── */

/** UUID tất định (không phụ thuộc thời gian) để test lặp lại byte-for-byte. */
export function fakeUuid(seed) {
  const h = sha256Hex(`vps-export-${seed}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** PNG RGBA 8×8 tất định (đủ để `probeImage`/storage coi là ảnh thật). */
export function tinyPng(color = [200, 30, 40, 255]) {
  // PNG viết tay: signature + IHDR + IDAT (zlib) + IEND, mỗi chunk kèm CRC32 (node:zlib).
  const width = 8;
  const height = 8;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0; // filter none
    for (let x = 0; x < width; x += 1) {
      const i = y * (1 + width * 4) + 1 + x * 4;
      raw[i] = color[0];
      raw[i + 1] = color[1];
      raw[i + 2] = color[2];
      raw[i + 3] = color[3] ?? 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32Fallback(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** CRC32 dự phòng cho Node cũ không có `zlib.crc32` (Node < 20.15). */
function crc32Fallback(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** GIF 1×1 tất định (đủ để nhận là video theo `meta.kind`/mime/ext). */
export function tinyGif() {
  return Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
}

/**
 * Gieo một job THẬT vào store + ghi file asset THẬT qua `storage.save` (chỉ đọc về sau).
 *
 * @returns {Promise<{jobId: string, assets: object, originalPath: string|null}>}
 */
export async function seedJob(ctx, {
  sid = 'exportSessionAAAAAAAA1',
  userId = null,
  kind = 'content',
  status = 'succeeded',
  stage = 'done',
  productName = 'Tai nghe chụp tai thử nghiệm',
  content = null,
  contentMeta = null,
  evidence = null,
  originals = 1,
  rendered = 0,
  videos = 0,
  lines = [],
  regions = [],
  usage = [],
  evidenceRows = [],
  assetWarnings = [],
  renderedMock = true,
  id = null,
} = {}) {
  const jobId = id || fakeUuid(`job-${sid}-${kind}`);
  await ctx.store.createJob({
    id: jobId,
    sessionId: sid,
    userId,
    kind,
    source: '1688',
    sourceUrl: 'https://detail.1688.com/offer/1.html',
    canonicalUrl: 'https://detail.1688.com/offer/1.html',
    sourceProductId: '1',
  });
  await ctx.store.updateJob(jobId, {
    status,
    stage,
    product_name: productName,
    content,
    content_meta: contentMeta,
    evidence,
  });

  const made = { originals: [], rendered: [], videos: [] };
  const write = async (group, role, buffer, mime, ext, meta, extra = {}) => {
    const assetId = fakeUuid(`asset-${jobId}-${group}-${made[group].length}`);
    const saved = await ctx.storage.save({ jobId, assetId, ext, mime, buffer });
    await ctx.store.createImageAsset({
      id: assetId,
      jobId,
      sessionId: sid,
      userId,
      role,
      mime,
      bytes: saved.bytes,
      width: extra.width ?? 8,
      height: extra.height ?? 8,
      sha256: saved.sha256,
      storagePath: saved.storage_path,
      source: role === 'original' ? 'upload' : 'render',
      meta,
    });
    const row = { id: assetId, role, mime, bytes: saved.bytes, sha256: saved.sha256, storage_path: saved.storage_path, meta };
    made[group].push(row);
    return saved;
  };

  for (let i = 0; i < originals; i += 1) {
    await write('originals', 'original', tinyPng([200, 30 + i, 40, 255]), 'image/png', 'png', { warnings: assetWarnings });
  }
  for (let i = 0; i < rendered; i += 1) {
    await write('rendered', 'rendered', tinyPng([10, 120 + i, 60, 255]), 'image/png', 'png', {
      kind,
      is_mock: renderedMock,
      provider: 'purejs',
      warnings: assetWarnings,
    });
  }
  for (let i = 0; i < videos; i += 1) {
    await write('videos', 'rendered', tinyGif(), 'image/gif', 'gif', {
      kind: 'video_generation',
      is_mock: true,
      audio: null,
      generator: { encoder_is_mock: true },
    });
  }
  if (lines.length) await ctx.store.saveTranslationLines(jobId, lines);
  if (regions.length) await ctx.store.saveOcrRegions(jobId, made.originals[0]?.id || null, regions);
  for (const row of usage) await ctx.store.recordUsage({ jobId, sessionId: sid, ...row });
  for (const row of evidenceRows) await ctx.store.recordEvidence({ jobId, ...row });

  return { jobId, assets: made };
}

/* ───────────────────── bản sao repo để mô phỏng module hỏng ───────────────────── */

/**
 * Sao chép repo sang thư mục tạm: `src/` + `public/` + `package.json`, `node_modules` là
 * symlink. `dropExports: true` XOÁ `src/exports/**` — đúng cảnh “X1 chưa có mặt”.
 */
export function makeRepoCopy({ dropExports = true } = {}) {
  const dir = tmpDir('vps-export-repo-');
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  if (dropExports) fs.rmSync(path.join(dir, 'src', 'exports'), { recursive: true, force: true });
  return dir;
}

/** Mã nguồn bootstrap chạy TRONG bản sao repo: in ra `PORT=` và `JOB=` rồi giữ tiến trình. */
export const BOOTSTRAP_SOURCE = `
import { loadConfig } from './src/config.js';
import { createLogger } from './src/logger.js';
import { createApp } from './src/app.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DB_DRIVER: 'sqlite',
  SQLITE_PATH: ':memory:',
  LOG_LEVEL: 'silent',
  AI_PROVIDER: 'mock',
  IMAGELAB_DIR: process.env.BOOT_IMAGELAB_DIR,
});
const app = await createApp({ config, logger: createLogger({ level: 'silent' }) });
const jobId = await app.store.createJob({ id: process.env.BOOT_JOB_ID, sessionId: process.env.BOOT_SID, kind: 'content' });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
console.log('PORT=' + app.server.address().port);
console.log('JOB=' + jobId);
process.on('SIGTERM', () => { app.close().then(() => process.exit(0)); });
`;

/** Thư mục tạm ngoài repo cho file .zip (đúng luật “không ghi vào cây mã nguồn”). */
export function outDir(prefix = 'vps-export-out-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
