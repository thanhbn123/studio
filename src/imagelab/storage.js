/**
 * ImageLab — lưu trữ ảnh trên đĩa (C4).
 *
 * Hợp đồng 4.4: đường dẫn = `<imagelab.dir>/<jobId>/<assetId>.<ext>`, ghi kiểu
 * NGUYÊN TỬ (file tạm `.tmp` + `rename`), và KHÔNG BAO GIỜ ghi ra ngoài
 * `imagelab.dir`.
 *
 * Vì sao phải siết `jobId`/`assetId` bằng regex: hai giá trị này đi thẳng vào
 * đường dẫn. Nếu nhận `../../etc/passwd` thì đây là lỗ hổng path traversal, không
 * phải chuyện nhỏ. Regex `/^[A-Za-z0-9_-]{1,64}$/` chỉ cho ký tự an toàn nên không
 * thể tạo ra `..`, `/`, `\`, NUL hay đường dẫn tuyệt đối.
 *
 * `read`/`exists`/`remove` nhận object `ImageAsset` (dùng `asset.storage_path`) và
 * cũng kiểm lại đường dẫn nằm trong thư mục gốc — phòng trường hợp đường dẫn trong
 * DB bị sửa tay thành `../../...`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Chỉ ký tự an toàn cho tên thư mục/tên file; tối đa 64 ký tự. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Phần mở rộng: chữ/số, tối đa 8 ký tự (png, jpg, webp, gif…). */
const EXT_RE = /^[A-Za-z0-9]{1,8}$/;

const MIME_TO_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

/** Lỗi có `code` rõ ràng để tầng trên (route) map sang HTTP mà không đoán. */
export class StorageError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Chuẩn hoá ext: bỏ dấu chấm đầu, chữ thường; thiếu thì suy từ mime. */
function normalizeExt(ext, mime = '') {
  let raw = String(ext ?? '').trim().replace(/^\.+/, '').toLowerCase();
  if (!raw && mime) raw = MIME_TO_EXT[String(mime).toLowerCase()] || '';
  if (!EXT_RE.test(raw)) {
    throw new StorageError('INVALID_EXT', `Phần mở rộng ảnh không hợp lệ: ${JSON.stringify(String(ext ?? ''))}`);
  }
  return raw;
}

function assertId(value, label) {
  const raw = typeof value === 'string' ? value : '';
  if (!ID_RE.test(raw)) {
    throw new StorageError(
      'INVALID_ID',
      `${label} không hợp lệ (chỉ cho phép [A-Za-z0-9_-] tối đa 64 ký tự — chống path traversal): ${JSON.stringify(String(value ?? '')).slice(0, 80)}`,
    );
  }
  return raw;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new StorageError('INVALID_BUFFER', 'buffer phải là Buffer/Uint8Array.');
}

/** Lấy giá trị thô của ảnh (node:crypto) — dùng chung cho pipeline. */
export function sha256(buffer) {
  return sha256Hex(toBuffer(buffer));
}

/**
 * @param {object} config cấu hình đã load (đọc `config.imagelab.dir`)
 * @param {{logger?: object}} [deps]
 */
export function createImageStorage(config, { logger } = {}) {
  const rootDir = path.resolve(String(config?.imagelab?.dir || './data/imagelab'));
  const log = logger?.child?.({ component: 'imagelab.storage' }) ?? logger;

  /** Chặn mọi đường dẫn rơi ra ngoài `rootDir`. */
  function assertInside(filePath, rawForMessage = filePath) {
    const resolved = path.resolve(filePath);
    if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) {
      throw new StorageError(
        'UNSAFE_PATH',
        `Đường dẫn nằm ngoài imagelab.dir (bị từ chối): ${String(rawForMessage).slice(0, 120)}`,
      );
    }
    return resolved;
  }

  function targetFor(jobId, assetId, ext, mime) {
    const jid = assertId(jobId, 'jobId');
    const aid = assertId(assetId, 'assetId');
    const e = normalizeExt(ext, mime);
    const dir = assertInside(path.join(rootDir, jid));
    const file = assertInside(path.join(dir, `${aid}.${e}`));
    return { jid, aid, ext: e, dir, file };
  }

  /**
   * Phân giải `asset.storage_path` (TƯƠNG ĐỐI trong imagelab.dir) thành đường dẫn tuyệt đối.
   * Từ chối: đường dẫn tuyệt đối, chuỗi có `..`, NUL, hoặc nhiều/ít hơn 2 đoạn.
   */
  function resolveAssetPath(asset) {
    let raw = '';
    if (typeof asset === 'string') raw = asset;
    else if (asset && typeof asset === 'object') raw = asset.storage_path ?? asset.storagePath ?? '';
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new StorageError('INVALID_PATH', 'Asset thiếu `storage_path` — không xác định được file cần đọc.');
    }
    const value = raw.trim();
    if (value.includes('\0')) {
      throw new StorageError('UNSAFE_PATH', 'storage_path chứa ký tự NUL — bị từ chối.');
    }

    // Đường dẫn tuyệt đối: chỉ chấp nhận nếu vẫn nằm trong thư mục gốc.
    let relative = value;
    if (path.isAbsolute(value)) {
      const resolved = assertInside(value, value);
      relative = path.relative(rootDir, resolved);
    }
    const segments = relative.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
    if (segments.length !== 2 || segments.includes('..')) {
      throw new StorageError(
        'UNSAFE_PATH',
        `storage_path không hợp lệ (phải là "<jobId>/<assetId>.<ext>"): ${value.slice(0, 120)}`,
      );
    }
    const [jidRaw, filename] = segments;
    const dot = filename.lastIndexOf('.');
    if (dot <= 0) {
      throw new StorageError('INVALID_PATH', `storage_path thiếu phần mở rộng: ${filename.slice(0, 80)}`);
    }
    const jid = assertId(jidRaw, 'jobId');
    const aid = assertId(filename.slice(0, dot), 'assetId');
    const file = assertInside(path.join(rootDir, jid, `${aid}.${normalizeExt(filename.slice(dot + 1))}`), value);
    return { jid, aid, file };
  }

  /**
   * Ghi ảnh mới. Trả `{ storage_path, bytes, sha256 }`.
   * Không bao giờ ghi đè file khác ngoài đường dẫn đã tính; ghi tạm rồi `rename`.
   */
  async function save({ jobId, assetId, ext, mime, buffer } = {}) {
    const { jid, aid, ext: e, dir, file } = targetFor(jobId, assetId, ext, mime);
    const data = toBuffer(buffer);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const tmp = path.join(dir, `.${aid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new StorageError('WRITE_FAILED', `Không ghi được ảnh ${jid}/${aid}.${e}: ${err.message}`);
    }

    const rel = path.posix.join(jid, `${aid}.${e}`);
    log?.debug?.('imagelab.storage.saved', { storage_path: rel, bytes: data.length });
    return { storage_path: rel, bytes: data.length, sha256: sha256Hex(data) };
  }

  /** Đọc ảnh của một ImageAsset. Ném `NOT_FOUND` nếu thiếu file. */
  async function read(asset) {
    const { file } = resolveAssetPath(asset);
    try {
      return await fs.readFile(file);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new StorageError('NOT_FOUND', 'Không tìm thấy file ảnh trên đĩa (asset có thể đã bị xoá).');
      }
      throw new StorageError('READ_FAILED', `Không đọc được file ảnh: ${err.message}`);
    }
  }

  async function exists(asset) {
    const { file } = resolveAssetPath(asset);
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  /** Xoá ảnh (idempotent — file đã mất vẫn coi là xong). */
  async function remove(asset) {
    const { file } = resolveAssetPath(asset);
    await fs.rm(file, { force: true });
  }

  return { save, read, exists, remove, dir: rootDir, resolveAssetPath };
}

export default createImageStorage;
