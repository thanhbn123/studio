/**
 * GÓI XUẤT BẢN (Export bundle) — mặt tiền của `src/exports/**` (X1).
 *
 * Hợp đồng §2 chốt đúng bảy thứ dưới đây; X2 (route) và X3 (UI) chỉ cần import từ file này:
 *
 * ```js
 * import { buildExportBundle, manifestFor, ExportError } from '../exports/index.js';
 *
 * // Route tải gói (X2):
 * const bundle = await buildExportBundle({ store: app.store, storage: app.storage, jobId, logger });
 * res.writeHead(200, {
 *   'Content-Type': 'application/zip',
 *   'Content-Disposition': `attachment; filename="${bundle.filename}"`,
 *   'Cache-Control': 'private, no-store',
 *   'X-Content-Type-Options': 'nosniff',
 * });
 * res.end(bundle.buffer);
 *
 * // Route xem manifest (X2) — KHÔNG cần đọc đĩa:
 * const job = await app.store.getJob(jobId);
 * if (!job) throw new ExportError('JOB_NOT_FOUND', '...');           // ⇒ 404
 * const manifest = manifestFor({
 *   job,
 *   assets: await app.store.listImageAssets(jobId),
 *   lines: await app.store.listTranslationLines(jobId),
 *   usage: await app.store.listUsage(jobId),
 *   evidence: await app.store.getEvidence(jobId),
 * });
 * ```
 *
 * Hợp đồng dữ liệu cho X2/X3 (ĐÓNG BĂNG trong sprint này):
 *
 *  · `buildExportBundle()` trả `{ buffer, filename, bytes, entries, manifest, warnings,
 *    missing, files, verified }`.
 *      - `entries`: MẢNG TÊN file trong ZIP, theo đúng thứ tự trong gói
 *        (`MANIFEST.json` đầu tiên).
 *      - `warnings`/`missing`: bản sao của `manifest.warnings` / `manifest.missing`
 *        (một nguồn sự thật duy nhất — đừng tự gộp lại).
 *      - `verified: true` = gói đã được ĐỌC LẠI bằng `inspectZip` và khớp tên + CRC32.
 *  · `manifestFor()` trả object thuần (JSON.stringify được ngay), tối thiểu có:
 *    `generated_at, job{id,kind,status,...}, providers, mock_steps, verification,
 *     verification_detail, audio, audio_note, counts{assets,images,videos,lines,usage},
 *     warnings, missing, original_sha256, entries, files, provenance, tool`.
 *      - `verification`: CHUỖI nhãn đã ghi (`MOCK_VERIFIED`/`MANUAL_INPUT`/…) hoặc `null`
 *        khi job chưa ghi bằng chứng nào. `verification_detail.live_service_called` nói rõ
 *        có thật sự gọi dịch vụ thật hay không (chỉ `true` khi transport = `http`).
 *      - `audio`: LUÔN `null` ở bản offline này (video không tiếng); `audio_note` giải thích.
 *  · Lỗi: `ExportError` có `.code` — X2 map: `JOB_NOT_FOUND` ⇒ 404, `BAD_INPUT` ⇒ 400,
 *    còn lại ⇒ 500. `ExportError` KHÔNG chứa đường dẫn đĩa.
 *  · Tên entry trong gói (hợp đồng §2):
 *      `MANIFEST.json`,
 *      `noi-dung/noi-dung.json`, `noi-dung/noi-dung.txt`,
 *      `anh/anh-goc-<n>.<ext>`, `anh/anh-tao-<n>.png`, `video/video-<n>.gif`,
 *      `bang-chung/usage.json`, `bang-chung/evidence.json`.
 *    Mục nào KHÔNG có dữ liệu thật thì KHÔNG có file (không tạo file rỗng giả) và được
 *    liệt kê trong `missing[]`.
 */

export { ExportError, EXPORT_CODES } from './errors.js';
export { crc32, crc32Bitwise } from './crc32.js';
export { createZip, normalizeZipName, ZIP_FLAG_UTF8, DEFAULT_DEFLATE_LEVEL } from './create-zip.js';
export { inspectZip, INSPECT_MAX_ENTRY_BYTES } from './inspect-zip.js';
export {
  manifestFor,
  bundleFilename,
  sanitizeFilename,
  stampFor,
  providersFor,
  verificationFor,
  normalizeVerificationLevel,
  isLiveClaim,
  collectJobWarnings,
  mockStepsFor,
  mockStepsFromProviders,
  usableMockSteps,
  UNKNOWN_MOCK_STEP,
  MANIFEST_VERSION,
  TOOL,
} from './manifest.js';
export { buildExportBundle, buildExportManifest, DEFAULT_MAX_TOTAL_BYTES } from './bundle.js';
// R6: trần kích thước gói + cổng giới hạn số lượt dựng gói đồng thời (X2 đọc env rồi áp ở route).
export {
  DEFAULT_MAX_BUNDLE_BYTES,
  DEFAULT_MAX_CONCURRENT_BUNDLES,
  DEFAULT_MAX_QUEUED_BUNDLES,
  DEFAULT_MAX_WAIT_MS,
  resolveExportLimits,
  createExportGate,
} from './limits.js';
export { renderHumanText } from './text.js';
export {
  ASSET_GROUPS,
  classifyAsset,
  assetEntryName,
  assetExtension,
  mockStepsFromAssets,
  sha256Hex,
} from './assets.js';
