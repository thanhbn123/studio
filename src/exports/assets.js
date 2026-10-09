/**
 * Phân loại + đặt tên asset cho GÓI XUẤT BẢN.
 *
 * Gói có ba nhóm file theo hợp đồng §2 — và mỗi nhóm lấy tên từ ĐÚNG một nguồn sự thật:
 *
 *   · `original`  → `anh/anh-goc-<n>.<ext>`   (mọi asset role 'original')
 *   · ảnh render  → `anh/anh-tao-<n>.png`     (asset role 'rendered' là ẢNH)
 *   · video render→ `video/video-<n>.gif`     (asset role 'rendered' là VIDEO — MVP-04)
 *
 * Phân biệt ảnh – video KHÔNG đoán theo cảm giác: dấu vết mạnh nhất là `meta.kind`
 * (`'video_generation'` do VideoStudio ghi), sau đó tới MIME (`video/*`, `image/gif`,
 * `video/mp4`) và phần mở rộng trên đĩa. Ở bản này chỉ VideoStudio sinh GIF/MP4 (MVP-02
 * và MVP-03 đều ghi PNG — xem `src/imagelab/render/png.js`, `src/imagestudio/compose`).
 *
 * Phần mở rộng ghi ra tên file LUÔN lấy từ dữ liệu THẬT (storage_path / mime). Không bao
 * giờ đổi đuôi file này thành đuôi khác: `anh-tao-1.png` chứa JPEG là nói dối và làm công
 * cụ ngoài mở sai. Khi dữ liệu không đủ để biết đuôi, ta dùng đuôi trung tính (`bin`) và
 * ghi một cảnh báo — không bịa.
 */

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** Nhóm file trong gói. */
export const ASSET_GROUPS = Object.freeze({ ORIGINAL: 'original', IMAGE: 'image', VIDEO: 'video' });

/** Dấu vết `meta.kind` của VideoStudio (nguồn: `src/videostudio/pipeline.js`). */
const VIDEOSTUDIO_KIND = 'video_generation';

/** Đuôi file suy từ MIME khi `storage_path` không có (ảnh do provider trả về). */
const MIME_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
});

/** Đuôi mặc định theo nhóm khi KHÔNG suy được gì (kèm cảnh báo, không im lặng). */
const FALLBACK_EXT = Object.freeze({ original: 'bin', image: 'png', video: 'gif' });

/** Thứ tự chuẩn của các bước mock khi báo cáo (khớp cách `src/http/routes.js` trình bày). */
const MOCK_STEP_ORDER = Object.freeze(['ocr', 'translate', 'render', 'matting', 'compose', 'retouch', 'content', 'video_plan', 'video_render', 'video_encode']);

const EXT_RE = /^[A-Za-z0-9]{1,8}$/;

/** Băm sha256 (hex) — dùng để CHỨNG MINH ảnh gốc không đổi sau khi xuất (luật §0.3). */
export function sha256Hex(buffer) {
  const hash = createHash('sha256');
  if (typeof buffer === 'string') hash.update(buffer, 'utf8');
  else if (Buffer.isBuffer(buffer)) hash.update(buffer);
  else if (buffer instanceof Uint8Array) hash.update(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  else throw new TypeError('sha256Hex chỉ nhận Buffer, Uint8Array hoặc string.');
  return hash.digest('hex');
}

/** `meta` của asset, luôn là object (dữ liệu DB có thể là null). */
export function assetMeta(asset) {
  return asset && typeof asset.meta === 'object' && asset.meta !== null ? asset.meta : {};
}

/** Đuôi file ghi trên `storage_path` (đã hạ chữ thường), hoặc '' nếu không đọc được. */
export function extFromStoragePath(asset) {
  const raw = typeof asset?.storage_path === 'string' ? asset.storage_path.trim() : '';
  if (!raw) return '';
  const dot = raw.lastIndexOf('.');
  if (dot < 0 || dot === raw.length - 1) return '';
  const ext = raw.slice(dot + 1).toLowerCase();
  return EXT_RE.test(ext) ? ext : '';
}

/** MIME đã hạ chữ thường. */
function mimeOf(asset) {
  return typeof asset?.mime === 'string' ? asset.mime.trim().toLowerCase() : '';
}

/**
 * Phân loại một asset vào một trong ba nhóm của gói.
 * @returns {'original'|'image'|'video'}
 */
export function classifyAsset(asset) {
  if (!asset || asset.role === 'original') return ASSET_GROUPS.ORIGINAL;
  const meta = assetMeta(asset);
  const mime = mimeOf(asset);
  const ext = extFromStoragePath(asset);

  // 1. Dấu vết mạnh nhất: VideoStudio tự khai `meta.kind`.
  if (meta.kind === VIDEOSTUDIO_KIND) return ASSET_GROUPS.VIDEO;
  // 2. MIME video tường minh.
  if (mime.startsWith('video/')) return ASSET_GROUPS.VIDEO;
  // 3. GIF/MP4: ở repo này chỉ VideoStudio sinh ra chúng (MVP-02/03 đều ghi PNG).
  if (mime === 'image/gif' || mime === 'video/mp4' || ext === 'gif' || ext === 'mp4') return ASSET_GROUPS.VIDEO;
  // 4. Còn lại: ảnh đã tạo (MVP-02 vẽ chữ, MVP-03 ghép nền).
  return ASSET_GROUPS.IMAGE;
}

/**
 * Đuôi file THẬT của asset + cờ cho biết có phải suy đoán không.
 * @returns {{ext: string, guessed: boolean, reason: string|null}}
 */
export function assetExtension(asset, group = classifyAsset(asset)) {
  const fromPath = extFromStoragePath(asset);
  if (fromPath) return { ext: fromPath, guessed: false, reason: null };
  const fromMime = MIME_EXT[mimeOf(asset)];
  if (fromMime) return { ext: fromMime, guessed: false, reason: null };
  return {
    ext: FALLBACK_EXT[group] || 'bin',
    guessed: true,
    reason: `Không xác định được phần mở rộng thật (mime=${JSON.stringify(asset?.mime || '')}, storage_path=${JSON.stringify(asset?.storage_path || '')}) — dùng đuôi trung tính ".${FALLBACK_EXT[group] || 'bin'}" và KHÔNG khẳng định đó là định dạng gì.`,
  };
}

/**
 * Tên entry trong ZIP cho một asset.
 *
 * @param {object} asset
 * @param {number} index số thứ tự 1-based TRONG NHÓM của nó
 * @returns {{name: string, group: string, ext: string, guessed: boolean, warning: string|null, deviates_from_contract: boolean}}
 */
export function assetEntryName(asset, index) {
  const group = classifyAsset(asset);
  const { ext, guessed, reason } = assetExtension(asset, group);
  const n = Number.isInteger(index) && index > 0 ? index : 1;
  const dir = group === ASSET_GROUPS.ORIGINAL ? 'anh' : group === ASSET_GROUPS.IMAGE ? 'anh' : 'video';
  const stem = group === ASSET_GROUPS.ORIGINAL ? 'anh-goc' : group === ASSET_GROUPS.IMAGE ? 'anh-tao' : 'video';
  // Hợp đồng §2 ghi `anh-tao-<n>.png` và `video-<n>.gif`. Giữ ĐÚNG đuôi thật; lệch hợp đồng
  // thì nói ra (cảnh báo) chứ không đổi đuôi file để "cho giống hợp đồng".
  const expected = group === ASSET_GROUPS.IMAGE ? 'png' : group === ASSET_GROUPS.VIDEO ? 'gif' : null;
  const deviates = expected !== null && ext !== expected;
  const warning = guessed
    ? reason
    : deviates
      ? `Asset ${asset?.id || '(không rõ id)'} có định dạng thật ".${ext}" (không phải ".${expected}" như tên gợi ý trong hợp đồng) — gói giữ ĐÚNG đuôi thật để không nói dối về định dạng.`
      : null;
  return { name: `${dir}/${stem}-${n}.${ext}`, group, ext, guessed, warning, deviates_from_contract: deviates };
}

/**
 * Các bước đã chạy bằng provider GIẢ, đọc từ DẤU VẾT ĐÃ LƯU trên asset — không suy từ cấu
 * hình đang chạy. Cùng tinh thần với `collectMockSteps` của `src/http/routes.js`.
 *
 * @returns {string[]} tên bước, đã khử trùng lặp và sắp theo thứ tự chuẩn
 */
export function mockStepsFromAssets(assets = []) {
  const steps = new Set();
  for (const asset of Array.isArray(assets) ? assets : []) {
    const meta = assetMeta(asset);
    if (meta.ocr?.is_mock) steps.add('ocr');
    if (meta.translate?.is_mock) steps.add('translate');
    if (meta.matting?.is_mock) steps.add('matting');
    if (meta.retouch?.is_mock) steps.add('retouch');
    if (meta.generator?.encoder_is_mock) steps.add('video_encode');
    if (meta.generator?.renderer_is_mock) steps.add('video_render');
    // `meta.is_mock` trần = provider render (MVP-02) hoặc encoder (MVP-04).
    if (meta.is_mock) steps.add(meta.kind === VIDEOSTUDIO_KIND ? 'video_encode' : 'render');
  }
  return orderMockSteps(steps);
}

/** Sắp tên bước mock theo thứ tự chuẩn, phần lạ đẩy về cuối (không bỏ sót). */
export function orderMockSteps(steps) {
  const set = steps instanceof Set ? steps : new Set(Array.isArray(steps) ? steps : []);
  const known = MOCK_STEP_ORDER.filter((s) => set.has(s));
  const extra = [...set].filter((s) => !MOCK_STEP_ORDER.includes(s)).sort();
  return [...known, ...extra];
}

/**
 * Cảnh báo CÓ THẬT đã lưu trong meta của asset (không tự sinh thêm, không bỏ bớt).
 * @returns {string[]}
 */
export function warningsFromAssets(assets = []) {
  const out = [];
  for (const asset of Array.isArray(assets) ? assets : []) {
    const meta = assetMeta(asset);
    for (const source of [meta.warnings, meta.ocr?.warnings, meta.matting?.warnings, meta.violations]) {
      for (const w of Array.isArray(source) ? source : []) {
        if (w === null || w === undefined || w === '') continue;
        out.push(typeof w === 'string' ? w : JSON.stringify(w));
      }
    }
  }
  return dedupeStrings(out);
}

/** Khử trùng lặp nhưng GIỮ NGUYÊN thứ tự xuất hiện (và giữ mọi cảnh báo khác nhau). */
export function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(values) ? values : []) {
    const s = typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export default classifyAsset;
