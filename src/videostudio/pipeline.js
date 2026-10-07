/**
 * MVP-04 (phần OFFLINE) — V3: PIPELINE VIDEO STUDIO.
 *
 *   ảnh người dùng → ingest (lưu ảnh gốc BẤT BIẾN, role `original`)
 *                  → generate: storing → planning → rendering → encoding → done|failed
 *
 * Ba luật riêng của MVP-04 (hợp đồng §0) chi phối file này:
 *  1. KHÔNG BÓP MÉO ẢNH: việc pad/crop do V1 quyết và ghi vào `plan.scenes[].fit`; pipeline
 *     KHÔNG được tự ý resize. Ảnh gốc trên đĩa được băm LẠI cuối mỗi lượt generate; lệch ⇒
 *     `ORIGINAL_MUTATED`, job `failed`, KHÔNG lưu video.
 *  2. KHÔNG CÓ TIẾNG THÌ PHẢI NÓI RÕ: mọi kết quả mang `audio: null` + cảnh báo nguyên văn
 *     `VIDEO_NO_AUDIO_WARNING` (GIF không chứa âm thanh) — không bao giờ quảng cáo là video
 *     hoàn chỉnh để đăng ngay.
 *  3. CHỐNG BỊA CHỮ: bằng chứng CHỈ lấy từ dữ liệu ĐÃ LƯU của job (`jobs.product_name`,
 *     vùng chữ trong `ocr_regions` — gồm vùng người dùng nhập tay, ghi chú trong
 *     `content_meta`). KHÔNG nhận `source_text`/`evidence` từ request. Vi phạm ⇒ KHÔNG mã hoá,
 *     `error_code = 'VIDEO_TEXT_UNSUPPORTED_CLAIM'`, job `failed` + `finished_at`, 0 byte video.
 *
 * Bốn nguyên tắc giống MVP-02/MVP-03:
 *  - Mọi lỗi có `code` máy đọc được (`VideoStudioError`).
 *  - Job lỗi luôn có `error_code` + `finished_at`; KHÔNG BAO GIỜ treo `running`.
 *  - Usage chỉ ghi cho bước THẬT SỰ chạy (`VIDEO_RENDER` khi đã dựng xong khung,
 *    `VIDEO_ENCODE` khi đã mã hoá + lưu được video).
 *  - Evidence luôn `MANUAL_INPUT`; hàm `videostudioVerification()` cố tình KHÔNG nhận tham số
 *    mức bằng chứng để không ai lỡ truyền `LIVE_VERIFIED` vào (luật #1 của dự án).
 *
 * NẠP PHÒNG THỦ V1/V2: `src/videostudio/plan/**` (V1) và `src/videostudio/encode/**` (V2) do
 * agent khác viết song song nên có thể CHƯA tồn tại lúc chạy. Cả hai được `import()` ĐỘNG;
 * thiếu module ⇒ `VideoStudioError('VIDEOSTUDIO_UNAVAILABLE')` — KHÔNG làm sập tiến trình.
 * Hai điểm BƠM `planModule`/`encodeModule` cho test/tầng gộp (mặc định null = nạp module thật).
 *
 * Hợp đồng dữ liệu cho V4/V5 (những gì file này ghi vào store):
 *  - `jobs.kind = 'video_generation'`, `jobs.status ∈ {queued, running, succeeded, failed}`,
 *    `jobs.stage ∈ VIDEOSTUDIO_STAGES`, kết thúc luôn có `finished_at`.
 *  - `jobs.content_meta.videostudio` = { kind, status, error_code, error_message, preset,
 *    preset_label, plan_summary, encode_summary, audio: null, warnings, violations,
 *    original_asset_ids, original_sha256, rendered_asset_id, output_sha256, providers,
 *    frames, duration_ms, updated_at }.
 *  - `image_assets` role `original` (bất biến) và role `rendered` (`parent_id` = ảnh gốc ĐẦU
 *    TIÊN, `meta.kind = 'video_generation'`, `meta.preset`, `meta.plan_summary`,
 *    `meta.encode_summary`, `meta.audio = null`, `meta.warnings`).
 */

import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_PRICING, JOB_STATUS, VERIFICATION_LEVELS } from '../store/index.js';
import { sniffImageMime } from '../security/sanitize.js';
import { decodePng, drawLayout, layoutText, loadFont, probeImage, toRgba } from '../imagelab/render/index.js';
// N1 (phản biện MVP-04 vòng 2): bộ dự phòng phải chuẩn hoá GIỐNG bộ của MVP-02, nếu không thì chữ
// không dấu / homoglyph / full-width / có ký tự vô hình sẽ LỌT và vẫn được vẽ lên video.
import { deaccent, normalizeForMatch } from '../imagelab/translate/guardrails.js';

/** Các bước của một job MVP-04 (hợp đồng §2.3 — ĐÓNG BĂNG, V4/V5 hiện tiến trình theo đây). */
export const VIDEOSTUDIO_STAGES = Object.freeze([
  'queued',
  'storing',
  'planning',
  'rendering',
  'encoding',
  'done',
  'failed',
]);

/** Loại job MVP-04 (`jobs.kind` đã có từ MVP-02, chỉ thêm giá trị — không cần migration). */
export const VIDEOSTUDIO_KIND = 'video_generation';

/** Dấu vết: connector + cách trích xuất + mức bằng chứng (KHÔNG BAO GIỜ LIVE_VERIFIED). */
export const VIDEOSTUDIO_CONNECTOR = 'videostudio';
export const VIDEOSTUDIO_EXTRACTION_METHOD = 'upload+video';
export const VIDEOSTUDIO_VERIFICATION = 'MANUAL_INPUT';

/** Hai operation usage của MVP-04 — giá MẶC ĐỊNH của repo nằm ở `store.DEFAULT_PRICING`. */
export const VIDEOSTUDIO_VIDEO_OPERATIONS = Object.freeze(['VIDEO_RENDER', 'VIDEO_ENCODE']);

/** `stage` nghĩa là "một lượt generate đang chạy" — dùng cho cổng chống chạy chồng. */
export const VIDEOSTUDIO_GENERATING_STAGES = Object.freeze(['storing', 'planning', 'rendering', 'encoding']);

/** Mã lỗi: thiếu module V1/V2 hoặc thiếu bộ mã hoá (V4 map thành 503). */
export const VIDEOSTUDIO_UNAVAILABLE = 'VIDEOSTUDIO_UNAVAILABLE';

/** Mã lỗi: chữ trên video có khẳng định/số liệu KHÔNG có bằng chứng (V4 map thành 422). */
export const VIDEO_TEXT_UNSUPPORTED_CLAIM = 'VIDEO_TEXT_UNSUPPORTED_CLAIM';

/**
 * Cảnh báo KHÔNG CÓ TIẾNG — nguyên văn theo hợp đồng §0 luật 2. Mọi kết quả (kể cả khi job
 * hỏng vì chữ thiếu bằng chứng) đều mang câu này: người dùng không bao giờ được tưởng là
 * video có tiếng.
 */
export const VIDEO_NO_AUDIO_WARNING =
  'Video KHÔNG có tiếng (GIF không chứa âm thanh) — muốn có tiếng cần dịch vụ TTS/ffmpeg (chưa bật)';

/**
 * Khử TRÙNG danh sách cảnh báo, giữ nguyên thứ tự xuất hiện.
 *
 * Vì sao cần: V1 (`VIDEO_AUDIO_WARNING`) và V3 (`VIDEO_NO_AUDIO_WARNING`) mỗi bên phát một câu
 * "không có tiếng" khác chữ ⇒ kết quả có HAI câu cùng nội dung, làm người dùng tưởng có hai vấn
 * đề. Câu của V3 (nói rõ hệ quả + cách khắc phục) được giữ lại, câu của V1 bị thay bằng chính câu
 * đó. Mọi cảnh báo khác cũng được khử trùng theo chuỗi đã chuẩn hoá.
 */
export function dedupeWarnings(list, { noAudioText = VIDEO_NO_AUDIO_WARNING } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    // Mọi biến thể "không có tiếng" (của V1 hoặc V3) quy về MỘT câu duy nhất.
    const normalized = /KHÔNG có tiếng|không chứa âm thanh|no audio/i.test(text) ? noAudioText : text;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  if (out.length === 0) out.push(noAudioText);
  return out;
}

/** Preset mặc định khi client không chọn (V1 có thể trả preset khác nếu hợp đồng đổi). */
export const VIDEOSTUDIO_DEFAULT_PRESET = 'doc-9x16';

/** Đường dẫn module V1/V2 (tương đối theo file này) — nạp ĐỘNG, thiếu ⇒ VIDEOSTUDIO_UNAVAILABLE. */
export const VIDEOSTUDIO_PLAN_SPECIFIER = './plan/index.js';
export const VIDEOSTUDIO_ENCODE_SPECIFIER = './encode/index.js';

/** MIME nhận cho ảnh gốc: engine offline chỉ giải mã PNG ⇒ nhận thêm định dạng khác là nói dối. */
const DEFAULT_ALLOWED_MIME = Object.freeze(['image/png']);

const MIME_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

const NEVER_LIVE = Object.freeze(new Set(['LIVE_VERIFIED', 'AUTHENTICATED_LIVE_VERIFIED']));

/** Chữ Hán/Nhật/Hàn trên video tiếng Việt = chưa dịch ⇒ chặn (luật chống bịa của MVP-03). */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * Từ ngữ "khẳng định" bị chặn khi KHÔNG có trong bằng chứng đã lưu. Danh sách này là bản dự
 * phòng của V3; V1 có thể có bộ kiểm riêng (xem `collectViolations`) — hai bộ chạy SONG SONG,
 * V1 chỉ có thể THÊM vi phạm, không bao giờ nới lỏng bộ dự phòng (fail-closed).
 */
const CLAIM_PHRASES = Object.freeze([
  'bảo hành',
  'chính hãng',
  'cam kết',
  'đảm bảo',
  'uy tín',
  'tốt nhất',
  'số 1',
  'miễn phí',
  'freeship',
  'giảm giá',
  'khuyến mãi',
  'hàng đầu',
  'chất lượng cao',
  'nguyên seal',
  'nguyên đai',
  'duy nhất',
  'giá rẻ nhất',
  'nhập khẩu',
  'an toàn tuyệt đối',
]);

/** Băm sha256 hex — dùng để chứng minh ẢNH GỐC BẤT BIẾN. */
export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Lỗi của tầng MVP-04 — LUÔN có `code` để V4 map sang HTTP mà không phải đoán chuỗi.
 * (Không tái dùng `ImageStudioError`/`ImageLabError` để ba hợp đồng không trộn vào nhau.)
 */
export class VideoStudioError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'VideoStudioError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Cổng chặn cứng: MVP-04 không bao giờ được ghi LIVE_VERIFIED (luật #1 của dự án). */
function videostudioVerification(level = VIDEOSTUDIO_VERIFICATION) {
  if (!VERIFICATION_LEVELS.includes(level)) {
    throw new VideoStudioError('INVALID_VERIFICATION', `Mức bằng chứng không hợp lệ: ${JSON.stringify(String(level))}`);
  }
  if (NEVER_LIVE.has(level)) {
    throw new VideoStudioError('LIVE_VERIFICATION_FORBIDDEN', 'MVP-04 KHÔNG BAO GIỜ được ghi LIVE_VERIFIED (luật #1).');
  }
  return level;
}

/* ══════════════════════ nạp module V1/V2 (phòng thủ) ══════════════════════ */

/**
 * Nạp MỘT module V1/V2 và bọc lỗi thành `VIDEOSTUDIO_UNAVAILABLE` — nhờ vậy V4 chỉ cần bắt
 * một mã lỗi duy nhất cho mọi ca "module anh em chưa có mặt".
 */
async function importVideostudioModule(label, specifier) {
  try {
    return await import(specifier);
  } catch (err) {
    throw new VideoStudioError(
      VIDEOSTUDIO_UNAVAILABLE,
      `Không nạp được module MVP-04 "${specifier}" (${label}) — tính năng video chưa sẵn sàng. Chi tiết ở log máy chủ.`,
      { module: specifier, label, cause_code: err?.code || null, cause_name: err?.name || 'Error' },
    );
  }
}

/**
 * Dùng cho V4/V5 (`GET /api/videostudio/presets`, `/api/config`): nạp module V1/V2 và trả
 * `{ plan, encode, reason }` — KHÔNG BAO GIỜ ném, để route không phải bọc try/catch riêng.
 */
export async function loadVideoStudioModules() {
  const out = { plan: null, encode: null, reason: null };
  try {
    out.plan = await import(VIDEOSTUDIO_PLAN_SPECIFIER);
  } catch {
    out.reason = `Không nạp được module MVP-04 "${VIDEOSTUDIO_PLAN_SPECIFIER}" (kịch bản/khung hình) — tính năng video bị tắt.`;
  }
  try {
    out.encode = await import(VIDEOSTUDIO_ENCODE_SPECIFIER);
  } catch {
    out.reason = out.reason
      ? `${out.reason} Đồng thời không nạp được "${VIDEOSTUDIO_ENCODE_SPECIFIER}" (mã hoá GIF).`
      : `Không nạp được module MVP-04 "${VIDEOSTUDIO_ENCODE_SPECIFIER}" (mã hoá GIF) — tính năng video bị tắt.`;
  }
  return out;
}

/* ══════════════════════════ tiện ích nội bộ ══════════════════════════ */

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Giải mã base64 nghiêm ngặt — `Buffer.from(x,'base64')` một mình sẽ bỏ qua rác. */
function decodeBase64Strict(raw, { label = 'ảnh', maxBytes = 0 } = {}) {
  const clean = String(raw).replace(/\s+/g, '');
  if (!clean) throw new VideoStudioError('INVALID_IMAGE', `${label} rỗng — không có dữ liệu ảnh.`);
  if (maxBytes > 0 && clean.length > Math.ceil((maxBytes * 4) / 3) + 8) {
    throw new VideoStudioError('IMAGE_TOO_LARGE', `Ảnh vượt giới hạn ${maxBytes} byte (chặn trước khi giải mã).`);
  }
  if (!BASE64_RE.test(clean)) {
    throw new VideoStudioError('INVALID_IMAGE', `${label} không phải chuỗi base64 hợp lệ.`);
  }
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function decodeDataUrlOrBase64(raw, opts) {
  const value = String(raw).trim();
  const match = /^data:([a-z0-9.+/-]+);base64,(.*)$/is.exec(value);
  if (match) {
    if (!/^image\//i.test(match[1])) {
      throw new VideoStudioError('INVALID_IMAGE', `Data URL không phải ảnh: ${match[1]}`);
    }
    return decodeBase64Strict(match[2], opts);
  }
  return decodeBase64Strict(value, opts);
}

/**
 * Nhận Buffer | Uint8Array | base64 | data URL | `{ base64|data_url|buffer|mime|filename }`.
 * KHÔNG tin `mime` client khai — magic bytes mới quyết (hợp đồng §2.4).
 */
function decodeImageInput(image, { maxBytes = 0 } = {}) {
  let buffer = null;
  let declaredMime = null;
  let filename = null;

  if (Buffer.isBuffer(image)) {
    buffer = image;
  } else if (image instanceof Uint8Array) {
    buffer = Buffer.from(image);
  } else if (typeof image === 'string') {
    buffer = decodeDataUrlOrBase64(image, { maxBytes });
  } else if (image && typeof image === 'object') {
    filename = image.filename ? String(image.filename).slice(0, 200) : null;
    declaredMime = typeof image.mime === 'string' ? image.mime.toLowerCase() : null;
    if (Buffer.isBuffer(image.buffer) || image.buffer instanceof Uint8Array || image.buffer instanceof ArrayBuffer) {
      buffer = Buffer.from(image.buffer);
    } else {
      const raw = image.base64 ?? image.data ?? image.data_url ?? image.dataUrl ?? null;
      if (typeof raw !== 'string') {
        throw new VideoStudioError('INVALID_IMAGE', 'Thiếu dữ liệu ảnh (`image.base64`).');
      }
      buffer = decodeDataUrlOrBase64(raw, { maxBytes });
    }
  } else {
    throw new VideoStudioError('INVALID_IMAGE', 'Dữ liệu ảnh không hợp lệ — cần Buffer hoặc { base64 }.');
  }

  if (!buffer || buffer.length === 0) throw new VideoStudioError('INVALID_IMAGE', 'Ảnh rỗng (0 byte).');
  if (maxBytes > 0 && buffer.length > maxBytes) {
    throw new VideoStudioError('IMAGE_TOO_LARGE', `Ảnh ${buffer.length} byte vượt giới hạn ${maxBytes} byte.`);
  }
  return { buffer, declaredMime, filename };
}

/** Kích thước THẬT của buffer (null nếu không đọc được header). */
function imageSize(buffer) {
  const probed = probeImage(buffer);
  if (!probed) return null;
  const width = Number(probed.width);
  const height = Number(probed.height);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width: Math.trunc(width), height: Math.trunc(height), mime: probed.mime || null }
    : null;
}

/** Số nguyên không âm (hoặc `null` khi đầu vào không phải số hữu hạn). */
function toInt(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Rút text bằng chứng từ một giá trị bất kỳ (chuỗi / mảng dòng). */
function textFrom(candidate) {
  if (typeof candidate === 'string') return candidate.trim();
  if (Array.isArray(candidate)) return candidate.filter((v) => typeof v === 'string' && v.trim() !== '').join('\n');
  return '';
}

/** Gỡ buffer khỏi kết quả encode để thứ trả ra/ghi DB luôn JSON-safe. */
function jsonSafe(value, depth = 0) {
  if (depth > 4) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[${value.length} byte]`;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => jsonSafe(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item, depth + 1);
    return out;
  }
  return String(value);
}

/** Chuẩn hoá danh sách vi phạm (V1 có thể trả chuỗi hoặc object) về dạng JSON-safe. */
function normalizeViolations(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) out.push({ rule: 'CLAIM', text, detail: text });
      continue;
    }
    if (typeof item === 'object') {
      const detail = String(item.reason ?? item.message ?? item.detail ?? item.rule ?? 'VI PHẠM').slice(0, 300);
      out.push({
        rule: String(item.rule ?? item.code ?? item.kind ?? 'CLAIM').slice(0, 60),
        text: String(item.text ?? item.claim ?? item.value ?? '').slice(0, 200),
        detail,
      });
    }
  }
  return out;
}

/**
 * Bộ kiểm DỰ PHÒNG của V3 (luật 3 §0): mỗi câu chữ định vẽ lên video phải được bằng chứng
 * ĐÃ LƯU của job đỡ. Ba luật con:
 *   · chữ Hán/Nhật/Hàn ⇒ `UNTRANSLATED_SCRIPT` (video tiếng Việt, chưa dịch thì không vẽ);
 *   · số liệu (12, 50%, 199.000đ…) ⇒ chuỗi số phải xuất hiện trong bằng chứng;
 *   · từ khẳng định (bảo hành, chính hãng…) ⇒ cụm từ phải xuất hiện trong bằng chứng.
 * Không có bằng chứng ⇒ MỌI khẳng định/số liệu bị chặn (fail-closed).
 */
export function fallbackViolations(texts, evidenceText) {
  /**
   * N1 — chuẩn hoá ĐÚNG như bộ của MVP-02 (`normalizeForMatch` = NFKC + khử homoglyph + biến thể
   * chính tả, rồi `deaccent` để bỏ dấu). Trước đây chỉ `toLowerCase().normalize('NFC').includes(...)`
   * nên các biến thể sau LỌT và vẫn được VẼ: "mien phi" (không dấu), "miễn phі" (homoglyph Cyrillic),
   * "ｍｉễｎ ｐｈí" (full-width), "miễn\nphí" (xuống dòng), "MIỄN PHÍ"…
   */
  const norm = (value) =>
    deaccent(normalizeForMatch(String(value ?? '')))
      .toLowerCase()
      .replace(/[\s\u00a0\u200b-\u200d\u2060]+/g, ' ') // gộp khoảng trắng + bỏ ký tự vô hình
      .trim();
  const haystack = ` ${norm(evidenceText)} `;
  const out = [];
  for (const text of texts) {
    const value = String(text ?? '').trim();
    if (!value) continue;
    if (CJK_RE.test(value)) {
      out.push({ rule: 'UNTRANSLATED_SCRIPT', text: value.slice(0, 200), detail: 'Chữ không phải tiếng Việt (Hán/Nhật/Hàn) — chưa dịch thì KHÔNG vẽ lên video.' });
    }
    const lower = norm(value);
    for (const match of lower.matchAll(/\d[\d.,]*/g)) {
      const digits = match[0].replace(/[.,]+$/, '');
      if (digits && !haystack.includes(digits)) {
        out.push({ rule: 'NUMERIC_CLAIM_UNSUPPORTED', text: value.slice(0, 200), detail: `Số liệu "${digits}" không có trong dữ liệu đã lưu của job.` });
      }
    }
    for (const phrase of CLAIM_PHRASES) {
      const needle = norm(phrase);
      if (needle && lower.includes(needle) && !haystack.includes(needle)) {
        out.push({ rule: 'CLAIM_WORD_UNSUPPORTED', text: value.slice(0, 200), detail: `Khẳng định "${phrase}" không có trong dữ liệu đã lưu của job.` });
      }
    }
  }
  return out;
}

/**
 * Gọi bộ kiểm của V1 (`collectClaimViolations(text, { evidence })` — chữ ký ĐÓNG BĂNG của
 * `src/videostudio/plan/claims.js`) cho TỪNG câu chữ. Trả `null` khi V1 KHÔNG có hàm này hoặc
 * hàm hỏng ở MỌI lần gọi (khi đó bộ dự phòng của V3 tiếp quản — fail-closed, không fail-open).
 */
function moduleViolations(planModule, texts, evidenceText) {
  const fn = planModule?.collectClaimViolations;
  if (typeof fn !== 'function') return null;
  const out = [];
  let ok = 0;
  for (const text of texts) {
    try {
      out.push(...normalizeViolations(fn(text, { evidence: evidenceText })));
      ok += 1;
    } catch {
      /* chữ ký khác ⇒ thử câu tiếp theo; nếu hỏng HẾT thì rơi về bộ dự phòng */
    }
  }
  return ok > 0 ? out : null;
}

/**
 * API KIỂM CHỐNG BỊA (dùng cho test + công cụ): trả MỌI vi phạm của HỢP hai bộ luật.
 * Không phải đường mới — chỉ mở đúng hàm `collectViolations` ở trên cho tầng test gọi được.
 */
export function findUnsupportedClaims(texts, evidenceText = '', planModule = null) {
  return collectViolations(planModule, Array.isArray(texts) ? texts : [texts], evidenceText);
}

/**
 * Gộp vi phạm: **HỢP CỦA HAI BỘ LUẬT** — luật của V1 (dùng lại guardrail MVP-02/03) VÀ bộ dự phòng
 * của V3. V1 chỉ có thể THÊM vi phạm, KHÔNG BAO GIỜ nới lỏng bộ dự phòng.
 *
 * ⚠️ F1 (phản biện MVP-04, CRITICAL): trước đây là `viaV1 ?? fallbackViolations(...)` — khi V1 trả
 * về (kể cả mảng RỖNG) thì bộ dự phòng KHÔNG BAO GIỜ chạy ⇒ 13/19 từ khoá trong `CLAIM_PHRASES`
 * của chính V3 (`đảm bảo`, `uy tín`, `miễn phí`, `freeship`, `giảm giá`, `khuyến mãi`, `hàng đầu`,
 * `chất lượng cao`, `nguyên seal`, `nguyên đai`, `duy nhất`, `giá rẻ nhất`, `nhập khẩu`) LỌT và
 * được VẼ lên video (đo được: 10 535 pixel chữ trắng, job `succeeded`) — vi phạm luật riêng #3.
 * Nay hai bộ chạy SONG SONG rồi hợp lại, khử trùng theo (rule, text, detail).
 */
function collectViolations(planModule, texts, evidenceText) {
  const viaV1 = moduleViolations(planModule, texts, evidenceText);
  const all = [...(viaV1 ?? []), ...fallbackViolations(texts, evidenceText)];
  const seen = new Set();
  const out = [];
  for (const item of all) {
    const key = `${item.rule}|${item.text}|${item.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Khoá chứa chữ sẽ vẽ trên video (V1 đọc `texts`/`text`; V3 gom rộng hơn cho tiêu đề/giá/CTA). */
const TEXT_KEYS = Object.freeze(['texts', 'text', 'title', 'subtitle', 'price', 'cta']);

/** Mọi mục chữ thô (string | object) của một nguồn tuỳ chọn — GIỮ NGUYÊN object cho V1. */
function rawTextItems(source) {
  const out = [];
  if (!source || typeof source !== 'object') return out;
  for (const key of TEXT_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) out.push(...value.filter((item) => item !== null && item !== undefined));
    else out.push(value);
  }
  return out;
}

/** Câu chữ của một mục (string hoặc `{ text|content }`) — rỗng nghĩa là không có gì để vẽ. */
function textValueOf(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const value = item.text ?? item.content ?? item.value ?? '';
    return typeof value === 'string' ? value.trim() : '';
  }
  return '';
}

/**
 * F8: trần độ dài chữ của `plan_summary` phải BẰNG trần mà video vẽ (route sanitize + V1).
 * Một nguồn số duy nhất — không để summary cắt ngắn hơn nội dung đã vẽ.
 */
const VIDEO_TEXT_MAX = 500;

/** Bản mô tả JSON-safe của `VideoPlan` — V4 trả thẳng trong `GET /api/videostudio/jobs/:id`. */
export function summarizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
  return {
    preset_id: plan.preset_id ?? null,
    width: toInt(plan.width),
    height: toInt(plan.height),
    fps: toInt(plan.fps),
    frame_count: toInt(plan.frame_count),
    duration_ms: toInt(plan.duration_ms),
    loop: toInt(plan.loop, 0),
    synthetic: plan.synthetic === true,
    scene_count: scenes.length,
    scenes: scenes.slice(0, 100).map((scene, index) => ({
      index: toInt(scene?.index, index),
      asset_id: scene?.asset_id ?? null,
      fit: scene?.fit ?? null,
      fit_box: jsonSafe(scene?.fit_box),
      duration_ms: toInt(scene?.duration_ms),
      start_ms: toInt(scene?.start_ms),
      end_ms: toInt(scene?.end_ms),
      transition_in: scene?.transition_in ?? null,
      transition_ms: toInt(scene?.transition_ms),
      motion: scene?.motion ?? null,
      text_count: Array.isArray(scene?.texts) ? scene.texts.length : 0,
      // NỘI DUNG CHỮ của cảnh (để mở lại job thì ô chữ KHÔNG trống). Chỉ những gì ĐÃ ĐƯỢC VẼ
      // hoặc đã bị chặn; không kèm gì nhạy cảm (không token, không đường dẫn, không base64).
      texts: Array.isArray(scene?.texts)
        ? scene.texts.slice(0, 20).map((t) => ({
          text: String(t?.text ?? '').slice(0, VIDEO_TEXT_MAX),
          x: toInt(t?.x, 0),
          y: toInt(t?.y, 0),
          size: toInt(t?.size, 0),
          align: t?.align ?? null,
          color: t?.color ?? null,
          start_ms: toInt(t?.start_ms, 0),
          end_ms: toInt(t?.end_ms, 0),
          animation: t?.animation ?? null,
        }))
        : [],
    })),
    warnings: Array.isArray(plan.warnings) ? plan.warnings.map(String).slice(0, 50) : [],
  };
}

/**
 * Rút `output` của `EncodeResult` (V2: `{ buffer, mime, ext, sha256, bytes }`) một cách CHỊU
 * ĐƯỢC: nhận cả dạng chuẩn của V2 lẫn dạng phẳng `{ buffer, mime }` (bản nháp hợp đồng cũ).
 * KHÔNG bao giờ tự bịa buffer: thiếu ⇒ `buffer: null`.
 */
export function encodeOutput(result) {
  const output = result?.output && typeof result.output === 'object' ? result.output : null;
  const raw = output?.buffer ?? result?.buffer ?? null;
  const buffer = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : null;
  return {
    buffer,
    mime: String(output?.mime ?? result?.mime ?? ''),
    ext: output?.ext ?? result?.ext ?? null,
    bytes: toInt(output?.bytes ?? result?.bytes, buffer ? buffer.length : 0),
    sha256: output?.sha256 ?? result?.sha256 ?? null,
  };
}

/** Bản mô tả JSON-safe của `EncodeResult` (KHÔNG chứa buffer video). */
export function summarizeEncode(result, { encoder = null, inspection = null, sha = null } = {}) {
  if (!result || typeof result !== 'object') return null;
  const out = encodeOutput(result);
  return {
    status: result.status ?? null,
    mime: out.mime,
    width: toInt(result.width),
    height: toInt(result.height),
    frames: toInt(result.frames),
    bytes: out.bytes,
    palette_size: toInt(result.palette_size),
    loop: toInt(result.loop, 0),
    is_mock: result.is_mock === true || result.isMock === true,
    provider: String(encoder?.name || result.provider || ''),
    sha256: sha ?? out.sha256 ?? (out.buffer ? sha256(out.buffer) : null),
    gif: inspection ? jsonSafe(inspection) : null,
    // F6: nhịp phát THẬT (tổng delay đã ghi vào GIF) — plan nói `duration_ms`, GIF phát
    // `playback_ms`; hai số phải cùng hiện để không có con số nào nói sai một mình.
    playback_ms: toInt(result.playback_ms, null),
    requested_ms: toInt(result.requested_ms, null),
    delay_drift_ms: toInt(result.delay_drift_ms, null),
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String).slice(0, 50) : [],
    error_code: result.error_code ?? null,
    elapsed_ms: toInt(result.elapsed_ms),
  };
}

/** Màu mực: nhận '#RGB'/'#RRGGBB'/[r,g,b(,a)] — mặc định trắng đục. */
function normalizeInk(color) {
  if (Array.isArray(color) && color.length >= 3) {
    const [r, g, b, a = 255] = color.map((v) => Math.max(0, Math.min(255, toInt(v, 255))));
    return [r, g, b, a];
  }
  if (typeof color === 'string') {
    const hex = color.trim().replace(/^#/, '');
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    if (/^[0-9a-fA-F]{6}$/.test(full)) {
      return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), 255];
    }
  }
  return [255, 255, 255, 255];
}

/** Font bitmap của MVP-02 — nạp MỘT lần cho cả tiến trình. */
const VIDEO_FONT = loadFont('5x7');

/**
 * `drawText` cấp cho V2 (`renderFrames(plan, { loadImage, drawText })`).
 *
 * Chấp nhận hai kiểu gọi để không phụ thuộc chữ ký chưa chốt của V2:
 *   (1) `drawText({ pixels, width, height, text, x, y, size, color, align, box, bold })`
 *   (2) `drawText(pixels, { ...opts, width, height })`
 * Trả `{ pixels, missing, lines }` — `pixels` là SỐ pixel mực đã vẽ (0 = không vẽ gì).
 */
export function drawTextOnFrame(pixelsOrOptions, maybeOptions, maybeMeta) {
  let pixels;
  let opts;
  if (Buffer.isBuffer(pixelsOrOptions) || pixelsOrOptions instanceof Uint8Array) {
    pixels = pixelsOrOptions;
    opts = { ...(maybeMeta && typeof maybeMeta === 'object' ? maybeMeta : {}), ...(maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {}) };
  } else {
    opts = pixelsOrOptions && typeof pixelsOrOptions === 'object' ? pixelsOrOptions : {};
    pixels = opts.pixels ?? opts.data ?? opts.buffer ?? null;
  }
  const width = toInt(opts.width, 0);
  const height = toInt(opts.height, 0);
  // V2 gọi `drawText(ctx)` với `ctx` = { pixels, width, height, text, spec, box, size, color, alpha }.
  const spec = opts.spec && typeof opts.spec === 'object' ? opts.spec : opts;
  const text = String(opts.text ?? spec.text ?? '');
  if (!pixels || width <= 0 || height <= 0 || !text.trim()) return { pixels: 0, missing: [], lines: [] };

  const size = Math.max(1, toInt(opts.size ?? spec.size ?? spec.font_size ?? spec.fontSize, 2));
  const alpha = Number.isFinite(Number(opts.alpha)) ? Math.max(0, Math.min(1, Number(opts.alpha))) : 1;
  const ink = normalizeInk(opts.color ?? spec.color);
  // Hiệu ứng `fade-in` của V2 truyền `alpha` ⇒ hạ độ trong suốt của mực, không bỏ qua.
  const color = [ink[0], ink[1], ink[2], Math.max(0, Math.min(255, Math.round(ink[3] * alpha)))];
  const chars = Array.from(text).length;
  const rawBox = opts.box ?? spec.box;
  const box = rawBox && typeof rawBox === 'object'
    ? { x: toInt(rawBox.x, 0), y: toInt(rawBox.y, 0), w: Math.max(1, toInt(rawBox.w ?? rawBox.width, 1)), h: Math.max(1, toInt(rawBox.h ?? rawBox.height, 1)) }
    : {
        x: toInt(spec.x, 0),
        y: toInt(spec.y, 0),
        w: Math.max(1, Math.min(width, chars * VIDEO_FONT.advance * size + 2)),
        h: Math.max(1, Math.min(height, 12 * size + 2)),
      };
  const layout = layoutText({
    text,
    box,
    font: VIDEO_FONT,
    options: {
      align: ['left', 'center', 'right'].includes(opts.align ?? spec.align) ? (opts.align ?? spec.align) : 'left',
      maxFontSize: size,
      padding: 0,
      lineGap: 1,
      bold: opts.bold === true || spec.bold === true,
    },
  });
  if (!layout || layout.lines.length === 0) return { pixels: 0, missing: [], lines: [], reason: layout?.reason ?? null };
  const drawn = drawLayout(pixels, layout, { width, height, font: VIDEO_FONT, color, bold: opts.bold === true || spec.bold === true });
  return { pixels: drawn?.pixels ?? 0, missing: Array.isArray(drawn?.missing) ? drawn.missing : [], lines: layout.lines };
}

/** Thu thập frame từ mảng HOẶC async iterable (hợp đồng §2.2 cho phép cả hai). */
async function collectFrames(source) {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (typeof source?.[Symbol.asyncIterator] === 'function') {
    const out = [];
    for await (const frame of source) out.push(frame);
    // Giữ cảnh báo mà V2 gắn trên iterable (F3) — nếu không thì chúng biến mất khi thu thành mảng.
    if (Array.isArray(source?.warnings) && out.length >= 0) {
      Object.defineProperty(out, 'warnings', { value: source.warnings, enumerable: false });
    }
    return out;
  }
  if (typeof source?.[Symbol.iterator] === 'function') return [...source];
  return [];
}

/**
 * Số khung mà plan ĐÒI (để đối chiếu với số khung V2 dựng ra): ưu tiên `frame_count`, rồi
 * `planFrameCount()` của V1 (bọc try/catch — hàm này NÉM `BAD_PLAN` khi plan hỏng), cuối cùng
 * suy từ `duration_ms × fps`. Không suy được ⇒ `null` (bỏ qua phép đối chiếu, không bịa số).
 */
function planFrames(planModule, plan) {
  const direct = toInt(plan?.frame_count, null);
  if (direct !== null) return direct;
  if (typeof planModule?.planFrameCount === 'function') {
    try {
      const counted = toInt(planModule.planFrameCount(plan), null);
      if (counted !== null) return counted;
    } catch {
      /* plan hỏng ⇒ thử suy từ thời lượng, KHÔNG bịa */
    }
  }
  const duration = toInt(plan?.duration_ms, null);
  const fps = toInt(plan?.fps, null);
  return duration !== null && fps !== null && fps > 0 ? Math.round((duration / 1000) * fps) : null;
}

/* ══════════════════════════════ PIPELINE ══════════════════════════════ */

export class VideoStudioPipeline {
  /**
   * `#inFlight` — khoá chống chạy chồng TRONG TIẾN TRÌNH cho `generate()` (cùng lý do như
   * MVP-03: hai lời gọi liên tiếp có thể cùng đọc thấy `queued` rồi cùng ghi hai video).
   */
  #inFlight = new Set();

  /** Cảnh báo `billing.disabled` chỉ ghi MỘT LẦN cho mỗi pipeline (không spam log). */
  #billingDisabledLogged = false;

  /** `run_key` của LƯỢT CHẠY đang chạy cho mỗi job (MVP-05 BR-07) — dùng cho usage/afterJob. */
  #runKeys = new Map();

  /** Promise nạp module V1/V2 (cache cả ca THẤT BẠI để không thử lại mỗi lượt). */
  #modulesPromise = null;

  constructor({
    config,
    logger,
    store,
    storage,
    encoder = null,
    billingService = null,
    billingHook = null,
    planModule = null,
    encodeModule = null,
  } = {}) {
    this.config = config ?? {};
    this.logger = logger;
    this.store = store;
    this.storage = storage;
    this.encoder = encoder || null;
    // MVP-05: dịch vụ ví credit + hook dùng chung với route (§3.4b). Cả hai `null`
    // ⇒ hook tính tiền bỏ qua hoàn toàn.
    this.billingService = billingService || null;
    this.billingHook = billingHook || null;
    // Điểm BƠM cho test/tầng gộp: mặc định null ⇒ `generate()` tự `import()` module thật.
    this.planModule = planModule || null;
    this.encodeModule = encodeModule || null;
  }

  /** Khối cấu hình dùng chung với MVP-02 (giới hạn ảnh). Thiếu khối → mặc định an toàn. */
  get imagelabConfig() {
    return this.config?.imagelab || {};
  }

  /** MIME nhận cho ảnh gốc — mặc định CHỈ PNG (engine offline chỉ giải mã PNG). */
  get allowedMime() {
    const configured = this.config?.videostudio?.allowedImageMime;
    return Array.isArray(configured) && configured.length > 0 ? configured.map((v) => String(v).toLowerCase()) : DEFAULT_ALLOWED_MIME;
  }

  /* ───────────────────────── tiện ích nội bộ ───────────────────────── */

  #log(jobId) {
    return this.logger?.child?.({ job_id: jobId }) ?? this.logger;
  }

  /** Ghi trạng thái job — lỗi ghi KHÔNG được làm sập tiến trình. */
  async #setJob(jobId, patch) {
    try {
      return await this.store.updateJob(jobId, patch);
    } catch (err) {
      this.logger?.error('videostudio.job_update_failed', { job_id: jobId, error_name: err?.name || 'Error', error_code: err?.code || null });
      return 0;
    }
  }

  /** Ghi usage_event — CHỈ gọi cho bước THẬT SỰ chạy; lỗi ghi chỉ ghi log. */
  async #usage(jobId, sessionId, operation, { provider = '', model = '', inputUnits = 0, outputUnits = 0, estimatedCost = 0, meta = null } = {}) {
    const int = (v) => Math.max(0, Math.trunc(Number(v) || 0));
    try {
      await this.store.recordUsage({
        jobId,
        runKey: this.#runKeys.get(String(jobId)) ?? null,
        sessionId,
        operation,
        provider: String(provider || ''),
        model: String(model || ''),
        inputUnits: int(inputUnits),
        outputUnits: int(outputUnits),
        estimatedCost: Number.isFinite(Number(estimatedCost)) ? Number(estimatedCost) : 0,
        currency: this.config?.cost?.currency || 'USD',
        meta,
      });
    } catch (err) {
      this.logger?.warn('videostudio.usage_record_failed', { job_id: jobId, operation, error_name: err?.name || 'Error' });
    }
  }

  /**
   * Ghi `extraction_evidence` cho job MVP-04. `verification` LUÔN `MANUAL_INPUT`
   * (ảnh do người dùng tải lên) — hàm không nhận tham số mức bằng chứng.
   */
  async #evidence(jobId, { bytes = 0, foundFields = [], missingFields = [], blockedReason = '', encoderName = '' } = {}) {
    try {
      await this.store.recordEvidence({
        jobId,
        connector: VIDEOSTUDIO_CONNECTOR,
        extractionMethod: VIDEOSTUDIO_EXTRACTION_METHOD,
        verification: videostudioVerification(),
        httpStatus: 200,
        bytes: Math.max(0, Math.trunc(Number(bytes) || 0)),
        loginRequired: false,
        blockedReason: String(blockedReason || '').slice(0, 1000),
        foundFields,
        missingFields,
        visionProvider: String(encoderName || ''),
        contentProvider: 'videostudio',
      });
    } catch (err) {
      this.logger?.warn('videostudio.evidence_record_failed', { job_id: jobId, error_name: err?.name || 'Error' });
    }
  }

  /** Ghi thêm meta cho một ImageAsset — best-effort, lỗi chỉ ghi log. */
  async #updateAssetMeta(jobId, assetId, meta) {
    if (typeof this.store?.updateImageAssetMeta !== 'function') return 0;
    try {
      return await this.store.updateImageAssetMeta(assetId, meta);
    } catch (err) {
      this.logger?.warn('videostudio.asset_meta_update_failed', { job_id: jobId, asset_id: assetId, error_name: err?.name || 'Error' });
      return 0;
    }
  }

  /** Nạp module V1/V2 (cache 1 lần) — thiếu module ⇒ `VIDEOSTUDIO_UNAVAILABLE`. */
  async #modules() {
    if (!this.#modulesPromise) {
      this.#modulesPromise = (async () => {
        const plan = this.planModule || (await importVideostudioModule('plan', VIDEOSTUDIO_PLAN_SPECIFIER));
        const encode = this.encodeModule || (await importVideostudioModule('encode', VIDEOSTUDIO_ENCODE_SPECIFIER));
        return { plan, encode };
      })();
    }
    return this.#modulesPromise;
  }

  /** Bộ mã hoá (V2) — thiếu hoặc chưa cấu hình ⇒ `VIDEOSTUDIO_UNAVAILABLE` (KHÔNG bịa video). */
  #requireEncoder() {
    const encoder = this.encoder;
    if (!encoder || typeof encoder.encode !== 'function') {
      throw new VideoStudioError(VIDEOSTUDIO_UNAVAILABLE, 'Chưa nạp được bộ mã hoá video (V2) — không thể tạo video.', {
        reason: 'ENCODER_NOT_CONFIGURED',
      });
    }
    if (encoder.configured === false) {
      throw new VideoStudioError(VIDEOSTUDIO_UNAVAILABLE, 'Bộ mã hoá video CHƯA được cấu hình — không thể tạo video.', {
        reason: 'ENCODER_NOT_CONFIGURED',
        encoder: encoder.name || '',
      });
    }
    return encoder;
  }

  /* ═════════════════ MVP-05 — HOOK TÍNH TIỀN (hợp đồng §3.4) ═════════════════
   *
   * LUẬT #1 — ẨN DANH KHÔNG BỊ PHÁ: job không có `user_id` đi thẳng vào thân `generate()`,
   * KHÔNG gọi một hàm billing nào (khách chưa đăng nhập vẫn dùng được video).
   *
   * LUẬT #2 — SỔ APPEND-ONLY + THEO LƯỢT: một lượt `generate()` của job có tài khoản là một
   * chu kỳ `billingHook.beforeJob` → `afterJob` (bên trong là `holdForJob`/`settleForJob`/
   * `refundForJob` của A2), quyết toán theo usage THẬT của ĐÚNG lượt đó (`run_key`).
   *
   * FAIL-CLOSED Ở ĐÚNG MỘT CHỖ: thiếu credit khi giữ tiền ⇒ ném `INSUFFICIENT_CREDIT` để
   * KHÔNG chạy job (V4 map thành 402). Lỗi billing khác chỉ ghi log mức warn.
   */

  #warnHook(step, jobId, err) {
    this.logger?.warn('billing.hook_failed', {
      job_id: jobId,
      step,
      error_name: err?.name || 'Error',
      error_code: err?.code || null,
      error_message: String(err?.message || err).slice(0, 300),
    });
  }

  /** Chi phí THẬT của LƯỢT CHẠY này = tổng `estimated_cost` của usage có cùng `run_key`. */
  async #actualCost(jobId) {
    try {
      const summary = await this.store?.usageSummary?.(jobId, { runKey: this.#runKeys.get(String(jobId)) ?? null });
      return Number(summary?.estimated_cost ?? 0);
    } catch (err) {
      this.#warnHook('usage_summary', jobId, err);
      return 0;
    }
  }

  /** Giữ tiền khi pipeline tự dựng với BillingService thô (test/demo) — không giữ hai lần. */
  async #holdDirect(billing, userId, jobId, operations) {
    if (typeof this.store?.listLedger === 'function') {
      const rows = await this.store.listLedger({ userId, jobId, limit: 200 });
      if (Array.isArray(rows) && rows.some((r) => r?.reason === 'job_hold')) return;
    }
    const estimate = await billing.estimate({ userId, operations });
    const row = await billing.holdForJob({ userId, jobId, estimate, operations });
    if (row?.run_key) this.#runKeys.set(String(jobId), row.run_key);
  }

  /** Kết thúc chu kỳ khi dùng BillingService thô — bỏ qua nếu job đã settle/refund. */
  async #closeDirect(billing, userId, jobId, { failed = false, actualCost = 0, runKey = null, reason = 'VIDEO_FAILED' } = {}) {
    let rows = [];
    if (typeof this.store?.listLedger === 'function') {
      rows = (await this.store.listLedger({ userId, jobId, limit: 200 })) || [];
    }
    if (rows.some((r) => r?.reason === 'job_settle' || r?.reason === 'job_refund')) return;
    if (failed) {
      if (!rows.some((r) => r?.reason === 'job_hold')) return; // chưa giữ gì ⇒ không có gì để hoàn
      await billing.refundForJob({ userId, jobId, reason, runKey });
      return;
    }
    await billing.settleForJob({ userId, jobId, actualCost, runKey });
  }

  /**
   * Bọc một lượt `generate()` bằng chu kỳ giữ tiền → chạy → quyết toán/hoàn tiền.
   *
   * Nguồn ví ưu tiên `billingHook` — CHÍNH object V4 gọi trong request (§3.4b): V4 đã giữ tiền
   * trước khi job chạy; hook tự ĐỌC SỔ THẬT theo `(jobId, run_key)` nên lần gọi ở đây KHÔNG
   * giữ thêm đồng nào. Nó là lưới an toàn cho đường không qua route (demo/tool).
   */
  async #withBilling(jobId, operations, run) {
    const hook = this.billingHook;
    const billing = this.billingService;
    if (!hook && !billing) {
      if (!this.#billingDisabledLogged) {
        this.#billingDisabledLogged = true;
        this.logger?.warn('billing.disabled', {
          reason: 'Không có billingService — hook tính tiền bị bỏ qua, job video vẫn chạy và không ai bị chặn.',
        });
      }
      return run();
    }

    let job = null;
    try {
      job = await this.store?.getJob?.(jobId);
    } catch (err) {
      this.#warnHook('read_job', jobId, err);
      return run();
    }
    const userId = job?.user_id || null;
    if (!userId) return run(); // ẩn danh ⇒ bỏ qua HOÀN TOÀN (luật #1)

    try {
      if (hook) {
        const began = await hook.beforeJob({
          userId,
          jobId,
          kind: job?.kind || VIDEOSTUDIO_KIND,
          sessionId: job?.session_id || '',
          operations,
        });
        const fromBegan = (began && began.run_key) || null;
        const fromHook = fromBegan
          ? null
          : (typeof hook.runKeyForJob === 'function' ? (await hook.runKeyForJob({ userId, jobId }))?.run_key : null);
        const runKey = this.#runKeys.get(String(jobId)) || fromBegan || fromHook || null;
        if (runKey) this.#runKeys.set(String(jobId), runKey);
      } else {
        await this.#holdDirect(billing, userId, jobId, operations);
      }
    } catch (err) {
      if (err?.code === 'INSUFFICIENT_CREDIT') throw err; // fail-closed có chủ ý (V4 map thành 402)
      this.#warnHook('before_job', jobId, err);
      return run();
    }

    let result;
    let failure = null;
    try {
      result = await run();
    } catch (err) {
      failure = err;
    }

    // Trạng thái THẬT lấy từ DB: `#failJob` đánh dấu failed mà KHÔNG ném lỗi.
    let status = failure ? JOB_STATUS.FAILED : (result?.status ?? null);
    if (!failure) {
      try {
        const fresh = await this.store?.getJob?.(jobId);
        status = fresh?.status ?? status;
      } catch {
        /* không đọc được trạng thái ⇒ dùng status pipeline trả về */
      }
    }
    const actualCost = await this.#actualCost(jobId);
    const runKey = this.#runKeys.get(String(jobId)) ?? null;

    try {
      if (hook) {
        await hook.afterJob({ userId, jobId, runKey, status: status || JOB_STATUS.SUCCEEDED, actualCost });
      } else {
        await this.#closeDirect(billing, userId, jobId, {
          failed: status === JOB_STATUS.FAILED,
          actualCost,
          runKey,
          reason: 'VIDEO_FAILED',
        });
      }
    } catch (err) {
      this.#warnHook('after_job', jobId, err);
    }

    this.#runKeys.delete(String(jobId));
    if (failure) throw failure;
    return result;
  }

  /**
   * Đánh dấu job thất bại kèm `error_code` + `finished_at` — KHÔNG BAO GIỜ treo `running`.
   * `extra` được gộp vào `content_meta.videostudio` để V4/V5 vẫn thấy chuyện gì đã xảy ra.
   */
  async #failJob(jobId, error, extra = null) {
    const code = String(error?.code || 'VIDEO_FAILED');
    const message = String(error?.message || 'Bước tạo video thất bại.').replace(/\s+/g, ' ').slice(0, 500);
    let fresh = null;
    try {
      fresh = await this.store?.getJob?.(jobId);
    } catch {
      fresh = null; // không đọc được job cũ ⇒ vẫn phải ghi trạng thái thất bại
    }
    await this.#setJob(jobId, {
      status: JOB_STATUS.FAILED,
      stage: 'failed',
      error_code: code,
      error_message: message,
      finished_at: new Date().toISOString(),
      content_meta: {
        ...(fresh?.content_meta || {}),
        videostudio: {
          ...(fresh?.content_meta?.videostudio || {}),
          kind: VIDEOSTUDIO_KIND,
          status: JOB_STATUS.FAILED,
          error_code: code,
          error_message: message,
          audio: null,
          ...(extra && typeof extra === 'object' ? extra : {}),
          updated_at: new Date().toISOString(),
        },
      },
    });
    return { code, message };
  }

  /** Ảnh gốc của job (role `original`) theo ĐÚNG thứ tự đã tải lên — mỗi ảnh là một cảnh. */
  /**
   * Ảnh gốc của job THEO ĐÚNG THỨ TỰ ĐÃ GỬI LÊN.
   *
   * F10 (agent test báo): `store.listImageAssets` sắp `created_at ASC, id ASC`; khi nhiều ảnh được
   * lưu trong CÙNG một mili-giây thì thứ tự rơi vào UUID NGẪU NHIÊN ⇒ cảnh bị ĐẢO so với thứ tự
   * người dùng chọn (đo được: tải `ffff…, aaaa…, cccc…` → plan ra `aaaa…, cccc…, ffff…`).
   * `ingest()` đã ghi `meta.scene_index` (0,1,2…) — dùng nó làm khoá sắp xếp CHÍNH; ảnh cũ không có
   * `scene_index` xếp sau, giữ nguyên thứ tự store trả về (ổn định, không bịa thứ tự).
   */
  async #originalAssets(jobId) {
    const list = await this.store.listImageAssets(jobId, { role: 'original' });
    if (!Array.isArray(list)) return [];
    return list
      .map((asset, position) => {
        const raw = asset?.meta && typeof asset.meta === 'object' ? asset.meta.scene_index : null;
        const index = Number.isFinite(Number(raw)) ? Number(raw) : null;
        return { asset, index, position };
      })
      .sort((a, b) => {
        if (a.index === null && b.index === null) return a.position - b.position;
        if (a.index === null) return 1; // ảnh cũ (không có scene_index) xuống cuối, thứ tự nội bộ giữ nguyên
        if (b.index === null) return -1;
        if (a.index !== b.index) return a.index - b.index;
        return a.position - b.position;
      })
      .map((entry) => entry.asset);
  }

  /**
   * "Text gốc của job" để chống bịa chữ (§0 luật 3) — CHỈ từ DỮ LIỆU ĐÃ LƯU:
   *   · `jobs.product_name`;
   *   · vùng chữ trong DB (`store.listOcrRegions`) — gồm vùng do NGƯỜI DÙNG nhập tay (`source='user'`);
   *   · ghi chú người dùng ĐÃ LƯU trong `content_meta` của job.
   *
   * ⚠️ KHÔNG nhận `source_text`/`evidence`/`notes` từ request: client vừa phát ngôn vừa tự cấp
   * bằng chứng là lỗ "bằng chứng vòng". Rỗng ⇒ KHÔNG có bằng chứng ⇒ chặn mọi khẳng định/số liệu.
   */
  async #evidenceText(jobId, job) {
    const parts = [];
    const sources = [];
    const usedRegions = [];

    const productName = String(job?.product_name ?? '').trim();
    if (productName) {
      parts.push(productName);
      sources.push('product_name');
    }

    let regions = [];
    try {
      regions = (await this.store.listOcrRegions(jobId)) || [];
    } catch (err) {
      this.logger?.warn('videostudio.ocr_regions_read_failed', { job_id: jobId, error_name: err?.name || 'Error' });
    }
    let sawOcr = false;
    let sawUser = false;
    for (const region of regions) {
      const text = String(region?.text ?? region?.text_original ?? '').trim();
      if (!text) continue;
      parts.push(text);
      const id = String(region?.region_key ?? region?.id ?? '');
      if (id) usedRegions.push(id);
      if (String(region?.source ?? '') === 'user') sawUser = true;
      else sawOcr = true;
    }
    if (sawOcr) sources.push('ocr_region');
    if (sawUser) sources.push('user_region');

    const meta = job?.content_meta && typeof job.content_meta === 'object' ? job.content_meta : {};
    let sawNotes = false;
    for (const holder of [meta.videostudio, meta.imagelab, meta.imagestudio]) {
      if (!holder || typeof holder !== 'object') continue;
      for (const key of ['notes', 'note', 'user_note', 'source_text']) {
        const text = textFrom(holder[key]);
        if (text) {
          parts.push(text);
          sawNotes = true;
        }
      }
    }
    if (sawNotes) sources.push('job_notes');

    const text = parts.join('\n');
    return { text, evidence_used: { sources, region_ids: usedRegions.slice(0, 50), chars: text.length } };
  }

  /* ══════════════════════════════ 1. INGEST ══════════════════════════════ */

  /**
   * Nhận một ảnh người dùng: sniff magic bytes, chặn theo `imagelab.maxImageBytes`/`maxPixels`,
   * dò kích thước + giải mã thử PNG, lưu file rồi ghi `image_assets` role `original`.
   *
   * Mỗi lời gọi THÊM MỘT cảnh (V5 cho kéo-thả nhiều ảnh ⇒ nhiều cảnh); ảnh đã lưu KHÔNG BAO GIỜ
   * bị sửa (mọi lượt generate chỉ đọc + băm lại).
   *
   * @returns {Promise<{asset_id:string, asset:object, width:number, height:number, sha256:string,
   *                    mime:string, bytes:number, scene_index:number, warnings:string[]}>}
   */
  async ingest(jobId, { image, sessionId, userId = null, options = {} } = {}) {
    if (!jobId) throw new VideoStudioError('INVALID_INPUT', 'Thiếu jobId.');
    if (!this.store) throw new VideoStudioError('NOT_CONFIGURED', 'Thiếu store — không ghi được DB.');
    if (!this.storage) throw new VideoStudioError('NOT_CONFIGURED', 'Thiếu storage — không lưu được ảnh.');

    const cfg = this.imagelabConfig;
    const maxBytes = Number(cfg.maxImageBytes) > 0 ? Number(cfg.maxImageBytes) : 0;
    const maxPixels = Number(cfg.maxPixels) > 0 ? Number(cfg.maxPixels) : 0;
    const log = this.#log(jobId);
    const warnings = [VIDEO_NO_AUDIO_WARNING];

    const job = await this.store.getJob(jobId);
    if (!job) throw new VideoStudioError('JOB_NOT_FOUND', `Không tìm thấy job ${jobId}.`);
    const sid = sessionId || job.session_id || '';
    const ownerId = userId || job.user_id || null;

    // 1. Giải mã + kiểm magic bytes (KHÔNG tin `mime` client khai).
    let buffer;
    let declaredMime;
    let filename;
    try {
      ({ buffer, declaredMime, filename } = decodeImageInput(image, { maxBytes }));
    } catch (err) {
      await this.#failJob(jobId, err, { warnings });
      throw err;
    }

    const mime = sniffImageMime(buffer);
    if (!mime || !this.allowedMime.includes(mime)) {
      const err = new VideoStudioError(
        'UNSUPPORTED_IMAGE',
        `Không nhận dạng được ảnh (magic bytes) hoặc định dạng không được phép${declaredMime ? ` (client khai ${declaredMime})` : ''}. MVP-04 chỉ nhận ${this.allowedMime.join(', ')} vì engine offline chỉ giải mã PNG.`,
        { mime: mime || null, declared_mime: declaredMime, allowed: [...this.allowedMime] },
      );
      await this.#failJob(jobId, err, { warnings });
      throw err;
    }

    // 2. Dò kích thước THẬT + GIẢI MÃ THỬ: ảnh không giải mã được thì không thể dựng video,
    //    phải từ chối NGAY (fail-closed) thay vì để job chết ở bước render.
    const size = imageSize(buffer);
    if (!size) {
      const err = new VideoStudioError('INVALID_IMAGE', 'Không đọc được kích thước ảnh từ header — ảnh hỏng hoặc header không hợp lệ.');
      await this.#failJob(jobId, err, { warnings });
      throw err;
    }
    const { width, height } = size;
    if (maxPixels > 0 && width * height > maxPixels) {
      const err = new VideoStudioError('PIXELS_EXCEEDED', `Ảnh ${width}×${height} = ${width * height} pixel vượt giới hạn ${maxPixels} pixel.`);
      await this.#failJob(jobId, err, { warnings });
      throw err;
    }
    try {
      toRgba(decodePng(buffer));
    } catch (err) {
      const wrapped = new VideoStudioError('INVALID_IMAGE', `Không giải mã được PNG (${err?.code || 'DECODE_FAILED'}): ${err?.message || err}`);
      await this.#failJob(jobId, wrapped, { warnings });
      throw wrapped;
    }

    // 3. Lưu file (nguyên tử) rồi ghi DB.
    await this.#setJob(jobId, {
      status: JOB_STATUS.RUNNING,
      stage: 'storing',
      error_code: null,
      error_message: null,
      finished_at: null,
    });

    const assetId = options?.assetId ? String(options.assetId) : randomUUID();
    const ext = MIME_EXT[mime] || 'png';
    const existing = await this.#originalAssets(jobId);
    const sceneIndex = existing.length;
    const meta = { kind: VIDEOSTUDIO_KIND, role: 'original', scene_index: sceneIndex };
    if (filename) meta.filename = filename;
    if (declaredMime && declaredMime !== mime) meta.declared_mime = declaredMime;

    // Ghi file CÓ THỂ hỏng (đĩa đầy/quyền/assetId sai định dạng) ⇒ phải đánh dấu job failed,
    // nếu không job sẽ treo `running` mãi mãi (luật: không bao giờ treo).
    let saved;
    try {
      saved = await this.storage.save({ jobId, assetId, ext, mime, buffer });
    } catch (err) {
      const wrapped = new VideoStudioError(String(err?.code || 'STORAGE_WRITE_FAILED'), `Không lưu được ảnh gốc: ${err?.message || err}`);
      await this.#failJob(jobId, wrapped, { warnings });
      throw wrapped;
    }
    try {
      await this.store.createImageAsset({
        id: assetId,
        jobId,
        sessionId: sid,
        // MVP-05 §2.2: đã đăng nhập ⇒ mọi asset mới gắn `user_id`; ẩn danh ⇒ null.
        userId: ownerId,
        role: 'original',
        parentId: null,
        mime,
        bytes: saved.bytes,
        width,
        height,
        sha256: saved.sha256,
        storagePath: saved.storage_path,
        source: 'upload',
        meta,
      });
    } catch (err) {
      // Ghi DB hỏng → dọn file vừa ghi để không để rác mồ côi.
      await this.storage.remove({ storage_path: saved.storage_path }).catch(() => {});
      await this.#failJob(jobId, err, { warnings });
      throw err;
    }

    const asset = await this.store.getImageAsset(assetId);

    // 4. Job kind: đường tạo video phải mang `video_generation`. Job do client tạo thiếu kind
    //    (mặc định 'content') ⇒ ĐẶT LẠI và ghi cảnh báo, không im lặng đổi dữ liệu.
    if (String(job.kind ?? '') !== VIDEOSTUDIO_KIND) {
      warnings.push(`Job kind "${job.kind || 'content'}" ⇒ đặt lại thành "${VIDEOSTUDIO_KIND}" cho luồng tạo video.`);
      await this.#setJob(jobId, { kind: VIDEOSTUDIO_KIND });
    }

    const originalIds = [...existing.map((a) => a.id), assetId];
    await this.#setJob(jobId, {
      status: JOB_STATUS.QUEUED,
      stage: 'queued',
      content_meta: {
        ...(job.content_meta || {}),
        videostudio: {
          ...(job.content_meta?.videostudio || {}),
          kind: VIDEOSTUDIO_KIND,
          status: JOB_STATUS.QUEUED,
          audio: null,
          original_asset_ids: originalIds,
          original_asset_id: originalIds[0],
          scene_count: originalIds.length,
          warnings,
          updated_at: new Date().toISOString(),
        },
      },
    });

    await this.#evidence(jobId, {
      bytes: saved.bytes,
      foundFields: ['image_asset:original', `kind:${VIDEOSTUDIO_KIND}`, `scenes:${originalIds.length}`],
      missingFields: ['image_asset:rendered'],
      encoderName: this.encoder?.name || '',
    });

    log?.info('videostudio.ingest_done', { asset_id: assetId, mime, bytes: saved.bytes, width, height, scene_index: sceneIndex });
    return { asset_id: assetId, asset, width, height, sha256: saved.sha256, mime, bytes: saved.bytes, scene_index: sceneIndex, warnings };
  }

  /* ══════════════════════════════ 2. GENERATE ══════════════════════════════ */

  /**
   * Chạy đúng trình tự stage: `storing → planning → rendering → encoding → done|failed`.
   *
   * Lỗi nào cũng để lại `error_code` + `finished_at` (job KHÔNG BAO GIỜ treo `running`) và
   * KHÔNG lưu video dở: chữ thiếu bằng chứng, plan hỏng, render hỏng, GIF không hợp lệ,
   * ảnh gốc bị đổi trên đĩa ⇒ 0 byte video.
   *
   * Hai lượt `generate()` chồng nhau trên cùng job ⇒ lượt sau bị chặn bằng
   * `VIDEOSTUDIO_JOB_RUNNING`; `force = true` là đường thoát có ý thức, và video cũ KHÔNG BAO
   * GIỜ bị ghi đè (mỗi lượt ghi thêm một asset `rendered` mới).
   *
   * @returns {Promise<{status:string, stage:string, error_code:string|null, asset:object|null,
   *                    plan:object|null, encode:object|null, frames:number, audio:null,
   *                    warnings:string[], duration_ms:number}>}
   */
  async generate(jobId, { sessionId, options = {}, runKey = null, force = false } = {}) {
    if (!jobId) throw new VideoStudioError('INVALID_INPUT', 'Thiếu jobId.');
    // Khoá TRONG TIẾN TRÌNH (xem `#inFlight`) — `force = true` là đường thoát duy nhất.
    if (this.#inFlight.has(String(jobId)) && !force) {
      throw new VideoStudioError(
        'VIDEOSTUDIO_JOB_RUNNING',
        `Job ${jobId} đang có một lượt tạo video chạy trong tiến trình này — chờ lượt đó xong, hoặc gọi lại với force = true.`,
        { job_id: String(jobId), hint: 'force=true' },
      );
    }
    // V4 đã gọi `billingHook.beforeJob` trong request (§3.4b) ⇒ dùng lại ĐÚNG `run_key` đó.
    if (runKey) this.#runKeys.set(String(jobId), String(runKey));
    this.#inFlight.add(String(jobId));
    try {
      return await this.#withBilling(jobId, [...VIDEOSTUDIO_VIDEO_OPERATIONS], () =>
        this.#generateLocked(jobId, { sessionId, options, force }));
    } finally {
      this.#inFlight.delete(String(jobId));
    }
  }

  /** Thân của `generate()` — chỉ gọi qua `generate()` để luôn đi kèm khoá chống chạy chồng. */
  async #generateLocked(jobId, { sessionId, options = {}, force = false } = {}) {
    const started = Date.now();
    if (!this.store) throw new VideoStudioError('NOT_CONFIGURED', 'Thiếu store — không ghi được DB.');
    if (!this.storage) throw new VideoStudioError('NOT_CONFIGURED', 'Thiếu storage — không đọc/ghi được ảnh.');

    const log = this.#log(jobId);
    const warnings = [VIDEO_NO_AUDIO_WARNING];
    /** Vi phạm chống bịa (rỗng = không có vi phạm) — V4/V5 hiện thẳng cho người dùng. */
    let violations = [];
    let evidenceUsed = null;

    const opts = options && typeof options === 'object' ? options : {};

    const job = await this.store.getJob(jobId);
    if (!job) throw new VideoStudioError('JOB_NOT_FOUND', `Không tìm thấy job ${jobId}.`);
    const sid = sessionId || job.session_id || '';

    // ── Cổng chống chạy chồng (tiền điều kiện — KHÔNG đụng trạng thái job) ─────
    if (!force && job.status === JOB_STATUS.RUNNING && VIDEOSTUDIO_GENERATING_STAGES.includes(String(job.stage))) {
      throw new VideoStudioError(
        'VIDEOSTUDIO_JOB_RUNNING',
        `Job đang chạy bước "${job.stage}" (status = running) — chờ bước này xong, hoặc gọi lại với force = true.`,
        { status: job.status, stage: job.stage ?? null, hint: 'force=true' },
      );
    }

    // ── Tiền điều kiện: module V1/V2 + bộ mã hoá + ảnh gốc ────────────────────
    // Thiếu module/bộ mã hoá cũng là "job không chạy được" ⇒ ghi `failed` + `error_code` +
    // `finished_at` (KHÔNG để job `queued` treo vô chủ) rồi mới ném ra cho V4 map 503.
    let modules;
    let encoder;
    try {
      modules = await this.#modules();
      encoder = this.#requireEncoder();
    } catch (err) {
      await this.#failJob(jobId, err, { warnings });
      throw err;
    }
    const originals = await this.#originalAssets(jobId);
    if (originals.length === 0) {
      const err = new VideoStudioError('VIDEOSTUDIO_NO_ASSET', 'Job chưa có ảnh gốc — phải gọi ingest() trước khi generate().');
      await this.#failJob(jobId, err, { warnings });
      throw err;
    }

    await this.#setJob(jobId, {
      status: JOB_STATUS.RUNNING,
      stage: 'storing',
      error_code: null,
      error_message: null,
      finished_at: null,
    });

    // ── Đọc ảnh gốc + chứng minh bất biến (băm TRƯỚC mọi thao tác) ────────────
    const originalHashes = new Map();
    for (const original of originals) {
      let buffer;
      try {
        buffer = await this.storage.read(original);
      } catch (err) {
        const wrapped = new VideoStudioError(String(err?.code || 'STORAGE_READ_FAILED'), `Không đọc được ảnh gốc ${original.id}: ${err?.message || err}`);
        await this.#failJob(jobId, wrapped, { warnings });
        throw wrapped;
      }
      const digest = sha256(buffer);
      if (original.sha256 && original.sha256 !== digest) {
        const err = new VideoStudioError(
          'ORIGINAL_HASH_MISMATCH',
          `Ảnh gốc trên đĩa KHÔNG khớp sha256 đã lưu (${digest.slice(0, 12)}… ≠ ${String(original.sha256).slice(0, 12)}…) — dừng để không tạo video từ dữ liệu hỏng.`,
          { asset_id: original.id },
        );
        await this.#failJob(jobId, err, { warnings });
        throw err;
      }
      originalHashes.set(original.id, digest);
    }
    const primaryOriginal = originals[0];

    /* ── (a) PLANNING — chống bịa chữ TRƯỚC khi tốn công dựng khung ─────────── */
    await this.#setJob(jobId, { stage: 'planning' });

    const evidence = await this.#evidenceText(jobId, job);
    evidenceUsed = evidence.evidence_used;
    // Nói THẲNG nếu client gửi kèm "bằng chứng": nó bị bỏ qua, không được dùng để biện minh.
    // Dùng ĐÚNG danh sách khoá của V1 (`clientEvidenceKeysIn`) để không lệch luật với V1/V4.
    const clientEvidence = [
      ...new Set([
        ...(typeof modules.plan.clientEvidenceKeysIn === 'function' ? modules.plan.clientEvidenceKeysIn(opts) : []),
        ...['source_text', 'evidence', 'evidence_text', 'ocr_text', 'notes', 'note'].filter((key) => opts[key] !== undefined && opts[key] !== null),
      ]),
    ];
    if (clientEvidence.length > 0) {
      warnings.push(
        `BỎ QUA bằng chứng do client tự khai (${clientEvidence.join(', ')}) — bằng chứng chỉ được lấy từ dữ liệu ĐÃ LƯU của job (tên sản phẩm, vùng chữ OCR/người dùng nhập, ghi chú đã lưu).`,
      );
    }

    const presetId = opts.preset ?? opts.preset_id ?? opts.ratio ?? VIDEOSTUDIO_DEFAULT_PRESET;
    const sceneOptions = Array.isArray(opts.scenes) ? opts.scenes : [];
    if (sceneOptions.length > originals.length) {
      warnings.push(`Client khai ${sceneOptions.length} cảnh nhưng job chỉ có ${originals.length} ảnh gốc — phần khai thừa bị bỏ qua (KHÔNG bịa cảnh).`);
    }
    // Chữ của từng cảnh: cảnh tự khai thì dùng của cảnh, không thì dùng chữ chung của request.
    // Danh sách này được TRUYỀN THẲNG cho V1 ⇒ thứ bị KIỂM chống bịa và thứ được VẼ là một.
    const globalItems = rawTextItems(opts);
    const itemLists = originals.map((asset, index) => {
      const raw = sceneOptions[index] && typeof sceneOptions[index] === 'object' ? sceneOptions[index] : {};
      const items = rawTextItems(raw);
      return items.length > 0 ? items : globalItems;
    });
    const requestedTexts = [...new Set(itemLists.flat().map(textValueOf).filter((text) => text !== ''))];
    // `asset_id` + kích thước ảnh LẤY TỪ DB, không bao giờ lấy từ request (chống tráo ảnh job khác).
    const scenes = originals.map((asset, index) => {
      const raw = sceneOptions[index] && typeof sceneOptions[index] === 'object' ? sceneOptions[index] : {};
      return {
        ...raw,
        index,
        asset_id: asset.id,
        source: { width: toInt(asset.width, 0), height: toInt(asset.height, 0) },
        texts: itemLists[index],
      };
    });

    violations = collectViolations(modules.plan, requestedTexts, evidence.text);
    if (violations.length > 0) {
      // LUẬT 3 (§0): KHÔNG vẽ, KHÔNG mã hoá ⇒ 0 byte video. Job `failed` + `finished_at` ngay.
      const err = new VideoStudioError(
        VIDEO_TEXT_UNSUPPORTED_CLAIM,
        `Chữ trên video có ${violations.length} khẳng định/số liệu KHÔNG có bằng chứng trong dữ liệu đã lưu của job — KHÔNG vẽ và KHÔNG mã hoá (0 byte video).`,
        { violations, evidence_used: evidenceUsed },
      );
      await this.#failJob(jobId, err, {
        warnings: [...warnings, ...violations.map((v) => `Chặn chữ: ${v.detail}`)],
        violations,
        evidence_used: evidenceUsed,
      });
      await this.#evidence(jobId, {
        bytes: 0,
        foundFields: ['image_asset:original', `scenes:${originals.length}`],
        missingFields: ['image_asset:rendered'],
        blockedReason: violations.map((v) => v.rule).join(', ').slice(0, 1000),
        encoderName: encoder.name || '',
      });
      log?.warn?.('videostudio.claim_blocked', { job_id: jobId, violations: violations.length });
      throw err;
    }

    let plan = null;
    try {
      // `evidence` là bằng chứng do SERVER gom từ dữ liệu ĐÃ LƯU ⇒ V1 tự kiểm lại lần nữa
      // (strict_claims mặc định true) — hai lớp kiểm, cùng một nguồn bằng chứng.
      plan = modules.plan.buildVideoPlan({
        scenes,
        preset: presetId,
        options: { ...opts, evidence: evidence.text, guard_claims: true },
      });
    } catch (err) {
      const code = String(err?.code || 'VIDEO_PLAN_FAILED');
      const wrapped = new VideoStudioError(code, `Không dựng được kịch bản video (${code}): ${err?.message || err}`, err?.details);
      await this.#failJob(jobId, wrapped, { warnings, evidence_used: evidenceUsed });
      await this.#evidence(jobId, { bytes: 0, foundFields: ['image_asset:original'], missingFields: ['image_asset:rendered'], blockedReason: code, encoderName: encoder.name || '' });
      throw wrapped;
    }
    if (!plan || typeof plan !== 'object') {
      const err = new VideoStudioError('VIDEO_PLAN_FAILED', 'V1 không trả về kế hoạch video (plan rỗng) — không mã hoá.');
      await this.#failJob(jobId, err, { warnings, evidence_used: evidenceUsed });
      throw err;
    }
    if (Array.isArray(plan.warnings)) warnings.push(...plan.warnings.map(String).slice(0, 20));

    const allFrames = await this.#renderFrames(modules, plan, jobId, warnings, encoder);
    const frameCount = allFrames.length;
    const expectedFrames = planFrames(modules.plan, plan);
    if (expectedFrames !== null && frameCount !== expectedFrames) {
      const err = new VideoStudioError(
        'VIDEO_FRAMES_MISMATCH',
        `Số khung dựng được (${frameCount}) KHÁC kế hoạch (${expectedFrames}) — không mã hoá (fail-closed).`,
        { frames: frameCount, expected: expectedFrames },
      );
      await this.#failJob(jobId, err, { warnings, evidence_used: evidenceUsed });
      throw err;
    }

    // Usage VIDEO_RENDER: chỉ ghi khi khung THẬT SỰ được dựng (input = số khung, output = 1).
    await this.#usage(jobId, sid, 'VIDEO_RENDER', {
      provider: encoder.name || 'videostudio',
      model: String(plan.preset_id || presetId),
      inputUnits: frameCount,
      outputUnits: 1,
      estimatedCost: Number.isFinite(Number(this.config?.cost?.VIDEO_RENDER)) ? Number(this.config.cost.VIDEO_RENDER) : DEFAULT_PRICING.VIDEO_RENDER,
      meta: { preset: plan.preset_id ?? presetId, frames: frameCount, fps: plan.fps ?? null, width: plan.width ?? null, height: plan.height ?? null, plan_warnings: Array.isArray(plan.warnings) ? plan.warnings.slice(0, 20) : [] },
    });

    /* ── (c) ENCODING ─────────────────────────────────────────────────────── */
    await this.#setJob(jobId, { stage: 'encoding' });
    let encoded = null;
    try {
      encoded = await encoder.encode({ plan, frames: allFrames, options: { ...opts, mime: encoder.mime || 'image/gif' } });
    } catch (err) {
      const wrapped = new VideoStudioError(String(err?.code || 'VIDEO_ENCODE_FAILED'), `Mã hoá video lỗi (${err?.code || 'VIDEO_ENCODE_FAILED'}): ${err?.message || err}`);
      await this.#failJob(jobId, wrapped, { warnings, evidence_used: evidenceUsed });
      await this.#evidence(jobId, { bytes: 0, foundFields: ['image_asset:original'], missingFields: ['image_asset:rendered'], blockedReason: wrapped.code, encoderName: encoder.name || '' });
      throw wrapped;
    }
    const encodedOut = encodeOutput(encoded);
    const videoBuffer = encodedOut.buffer;
    if (!encoded || String(encoded.status || 'OK').toUpperCase() === 'FAILED' || (encoded.error_code && !videoBuffer)) {
      // `VideoEncoder.encode` của V2 KHÔNG ném — nó trả `status: 'FAILED'` + `error_code`.
      const code = String(encoded?.error_code || 'VIDEO_ENCODE_FAILED');
      const err = new VideoStudioError(code, `Bộ mã hoá KHÔNG tạo được video (${code}): ${(encoded?.warnings || []).map(String).join(' | ') || 'không rõ lý do'}`, {
        status: encoded?.status ?? null,
        error_code: encoded?.error_code ?? null,
      });
      await this.#failJob(jobId, err, { warnings, evidence_used: evidenceUsed });
      await this.#evidence(jobId, { bytes: 0, foundFields: ['image_asset:original'], missingFields: ['image_asset:rendered'], blockedReason: code, encoderName: encoder.name || '' });
      throw err;
    }
    if (!videoBuffer || videoBuffer.length === 0) {
      const err = new VideoStudioError('VIDEO_EMPTY', 'Bộ mã hoá trả về 0 byte — KHÔNG lưu video rỗng (fail-closed).', { bytes: videoBuffer ? videoBuffer.length : 0 });
      await this.#failJob(jobId, err, { warnings, evidence_used: evidenceUsed });
      throw err;
    }
    if (Array.isArray(encoded.warnings)) warnings.push(...encoded.warnings.map(String).slice(0, 20));

    // KIỂM ĐỘC LẬP bằng `inspectGif` của V2 (hợp đồng §2.2): số khung/kích thước/loop phải khớp plan.
    let inspection = null;
    if (typeof modules.encode.inspectGif === 'function') {
      try {
        inspection = modules.encode.inspectGif(videoBuffer);
      } catch (err) {
        inspection = { valid: false, errors: [`inspectGif ném lỗi: ${err?.message || err}`] };
      }
      const gifFrames = toInt(inspection?.frames, null);
      const expectW = toInt(plan.width, null);
      const expectH = toInt(plan.height, null);
      const bad =
        inspection?.valid !== true
        || (gifFrames !== null && gifFrames !== frameCount)
        || (expectW !== null && toInt(inspection?.width, null) !== expectW)
        || (expectH !== null && toInt(inspection?.height, null) !== expectH);
      if (bad) {
        const err = new VideoStudioError(
          'VIDEO_GIF_INVALID',
          `GIF mã hoá ra KHÔNG hợp lệ hoặc lệch kế hoạch (${JSON.stringify(jsonSafe(inspection))}) — KHÔNG lưu (fail-closed).`,
          { inspection: jsonSafe(inspection), frames: frameCount, width: expectW, height: expectH },
        );
        await this.#failJob(jobId, err, { warnings, evidence_used: evidenceUsed });
        await this.#evidence(jobId, { bytes: 0, foundFields: ['image_asset:original'], missingFields: ['image_asset:rendered'], blockedReason: 'VIDEO_GIF_INVALID', encoderName: encoder.name || '' });
        throw err;
      }
    } else {
      warnings.push('V2 không xuất `inspectGif` — không kiểm độc lập được số khung/kích thước của GIF (hợp đồng §2.2 yêu cầu có).');
    }

    const outputSha = sha256(videoBuffer);

    // Bất biến #1: ẢNH GỐC BẤT BIẾN — đọc lại TẤT CẢ từ ĐĨA và băm so với lúc bắt đầu,
    // TRƯỚC khi lưu video (nếu ảnh gốc đã bị đổi thì không có kết quả nào đáng tin).
    for (const original of originals) {
      let after;
      try {
        after = await this.storage.read(original);
      } catch (err) {
        const wrapped = new VideoStudioError(String(err?.code || 'STORAGE_READ_FAILED'), `Không đọc lại được ảnh gốc để kiểm bất biến: ${err?.message || err}`);
        await this.#failJob(jobId, wrapped, { warnings, evidence_used: evidenceUsed });
        throw wrapped;
      }
      if (sha256(after) !== originalHashes.get(original.id)) {
        const err = new VideoStudioError('ORIGINAL_MUTATED', `Ảnh gốc ${original.id} đã BỊ ĐỔI trong lúc tạo video — dừng và không lưu video (luật #1).`, { asset_id: original.id });
        await this.#failJob(jobId, err, { warnings, evidence_used: evidenceUsed });
        throw err;
      }
    }

    /* ── (d) LƯU ASSET `rendered` ─────────────────────────────────────────── */
    const renderedId = randomUUID();
    const outMime = String(encodedOut.mime || encoded.mime || encoder.mime || 'image/gif');
    const outExt = MIME_EXT[outMime] || (outMime === 'video/mp4' ? 'mp4' : 'gif');
    const encodeSummary = summarizeEncode(
      { ...encoded, frames: toInt(encoded.frames, frameCount), width: toInt(encoded.width, plan.width), height: toInt(encoded.height, plan.height), bytes: videoBuffer.length },
      { encoder, inspection, sha: outputSha },
    );
    const meta = {
      kind: VIDEOSTUDIO_KIND,
      role: 'rendered',
      preset: {
        id: plan.preset_id ?? presetId,
        width: toInt(plan.width),
        height: toInt(plan.height),
        fps: toInt(plan.fps),
        duration_ms: toInt(plan.duration_ms),
        frame_count: frameCount,
      },
      plan_summary: summarizePlan(plan),
      encode_summary: encodeSummary,
      // LUẬT 2 (§0): video offline KHÔNG có tiếng — ghi thẳng vào asset, không chỉ ở log.
      audio: null,
      no_audio: true,
      parent_sha256: originalHashes.get(primaryOriginal.id) ?? null,
      original_asset_ids: originals.map((a) => a.id),
      scene_count: scenes.length,
      generator: {
        stages: ['planning', 'rendering', 'encoding'],
        preset_id: plan.preset_id ?? presetId,
        frames: frameCount,
        encoder: encoder.name || '',
        encoder_is_mock: Boolean(encoder.isMock),
      },
      evidence_used: evidenceUsed,
      violations: [],
      warnings: dedupeWarnings(warnings).slice(0, 50),
    };

    let saved;
    try {
      saved = await this.storage.save({ jobId, assetId: renderedId, ext: outExt, mime: outMime, buffer: videoBuffer });
    } catch (err) {
      const wrapped = new VideoStudioError(String(err?.code || 'STORAGE_WRITE_FAILED'), `Không lưu được video đã tạo: ${err?.message || err}`);
      await this.#failJob(jobId, wrapped, { warnings, evidence_used: evidenceUsed });
      throw wrapped;
    }
    try {
      await this.store.createImageAsset({
        id: renderedId,
        jobId,
        sessionId: sid,
        userId: job.user_id || null,
        role: 'rendered',
        // `parent_id` = ẢNH GỐC ĐẦU TIÊN (cảnh 1); mọi ảnh gốc nằm trong `meta.original_asset_ids`.
        parentId: primaryOriginal.id,
        mime: outMime,
        bytes: saved.bytes,
        width: toInt(plan.width),
        height: toInt(plan.height),
        sha256: saved.sha256,
        storagePath: saved.storage_path,
        source: 'generate',
        meta,
      });
    } catch (err) {
      await this.storage.remove({ storage_path: saved.storage_path }).catch(() => {});
      await this.#failJob(jobId, err, { warnings, evidence_used: evidenceUsed });
      throw err;
    }
    const rendered = await this.store.getImageAsset(renderedId);

    // Usage VIDEO_ENCODE: chỉ ghi khi video ĐÃ mã hoá + lưu được (input = số khung, output = số byte).
    await this.#usage(jobId, sid, 'VIDEO_ENCODE', {
      provider: encoder.name || 'videostudio',
      model: outMime,
      inputUnits: frameCount,
      outputUnits: saved.bytes,
      estimatedCost: Number.isFinite(Number(this.config?.cost?.VIDEO_ENCODE)) ? Number(this.config.cost.VIDEO_ENCODE) : DEFAULT_PRICING.VIDEO_ENCODE,
      meta: { mime: outMime, bytes: saved.bytes, frames: frameCount, palette_size: encodeSummary?.palette_size ?? null, is_mock: Boolean(encoder.isMock) },
    });

    // Dấu vết trên ẢNH GỐC (chỉ ghi meta DB — file ảnh gốc KHÔNG bị chạm).
    const freshOriginal = await this.store.getImageAsset(primaryOriginal.id);
    const prevTrace = freshOriginal?.meta?.videostudio && typeof freshOriginal.meta.videostudio === 'object' ? freshOriginal.meta.videostudio : {};
    const at = new Date().toISOString();
    const runs = (Array.isArray(prevTrace.runs) ? prevTrace.runs : []).slice(-4);
    runs.push({ rendered_id: renderedId, rendered_sha256: saved.sha256, at, preset: plan.preset_id ?? presetId, frames: frameCount, bytes: saved.bytes });
    await this.#updateAssetMeta(jobId, primaryOriginal.id, {
      videostudio: { ...prevTrace, rendered_id: renderedId, rendered_sha256: saved.sha256, at, runs },
    });

    /* ── (e) CHỐT TRẠNG THÁI ──────────────────────────────────────────────── */
    // §3 (vòng gộp): MỘT câu "không có tiếng" duy nhất dù V1 và V3 mỗi bên phát một câu khác chữ.
    const warningsFinal = dedupeWarnings(warnings);
    const planSummary = summarizePlan(plan);
    const finishedAt = new Date().toISOString();
    const freshJob = await this.store.getJob(jobId);
    await this.#setJob(jobId, {
      status: JOB_STATUS.SUCCEEDED,
      stage: 'done',
      error_code: null,
      error_message: null,
      finished_at: finishedAt,
      content_meta: {
        ...(freshJob?.content_meta || {}),
        videostudio: {
          ...(freshJob?.content_meta?.videostudio || {}),
          kind: VIDEOSTUDIO_KIND,
          status: JOB_STATUS.SUCCEEDED,
          error_code: null,
          error_message: null,
          preset: meta.preset,
          frames: frameCount,
          plan_summary: planSummary,
          encode_summary: encodeSummary,
          // LUẬT 2 (§0): KHÔNG BAO GIỜ có tiếng ở phần offline.
          audio: null,
          no_audio: true,
          warnings: warningsFinal.slice(0, 50),
          violations: [],
          evidence_used: evidenceUsed,
          original_asset_ids: originals.map((a) => a.id),
          original_asset_id: primaryOriginal.id,
          original_sha256: originalHashes.get(primaryOriginal.id) ?? null,
          original_sha256_all: Object.fromEntries(originalHashes),
          rendered_asset_id: renderedId,
          output_sha256: saved.sha256,
          output_bytes: saved.bytes,
          output_size: { width: toInt(plan.width), height: toInt(plan.height) },
          providers: { encoder: { name: encoder.name || '', is_mock: Boolean(encoder.isMock), configured: encoder.configured !== false } },
          // Vòng gộp: `run_key` của LƯỢT CHẠY này — UI/quản trị đối chiếu được với sổ ví MVP-05
          // (`GET /api/videostudio/jobs/:id → last_run.run_key`, trước đây luôn null).
          run_key: this.#runKeys.get(String(jobId)) || null,
          duration_ms: Date.now() - started,
          updated_at: finishedAt,
        },
      },
    });

    await this.#evidence(jobId, {
      bytes: saved.bytes,
      foundFields: ['image_asset:original', 'image_asset:rendered', `preset:${plan.preset_id ?? presetId}`, `frames:${frameCount}`, 'audio:none'],
      missingFields: [],
      blockedReason: '',
      encoderName: encoder.name || '',
    });

    log?.info('videostudio.generate_done', {
      status: JOB_STATUS.SUCCEEDED,
      preset: plan.preset_id ?? presetId,
      frames: frameCount,
      bytes: saved.bytes,
      rendered_id: renderedId,
      ms: Date.now() - started,
    });

    return {
      status: JOB_STATUS.SUCCEEDED,
      stage: 'done',
      error_code: null,
      error_message: null,
      asset: rendered,
      asset_id: renderedId,
      original_asset: primaryOriginal,
      original_sha256: originalHashes.get(primaryOriginal.id) ?? null,
      preset: meta.preset,
      plan,
      plan_summary: planSummary,
      encode: encodeSummary,
      frames: frameCount,
      frame_count: frameCount,
      // LUẬT 2 (§0): kết quả KHÔNG BAO GIỜ có tiếng.
      audio: null,
      no_audio: true,
      violations: [],
      evidence_used: evidenceUsed,
      warnings: warningsFinal,
      duration_ms: Date.now() - started,
    };
  }

  /**
   * Dựng khung hình qua V2 (`renderFrames`) với hai phụ thuộc do V3 cấp:
   *  - `loadImage(assetId)` → `{ asset_id, buffer, mime, width, height, data(RGBA) }` (ảnh gốc
   *    đọc từ đĩa qua `imagelab/storage.js`, giải mã PNG bằng engine MVP-02);
   *  - `drawText(...)` → `drawTextOnFrame` (font bitmap MVP-02).
   * Lỗi ở bước này ⇒ job `failed`, KHÔNG mã hoá, KHÔNG ghi usage `VIDEO_RENDER`.
   */
  async #renderFrames(modules, plan, jobId, warnings, encoder) {
    await this.#setJob(jobId, { stage: 'rendering' });
    if (typeof modules.encode.renderFrames !== 'function') {
      const err = new VideoStudioError(VIDEOSTUDIO_UNAVAILABLE, 'Module V2 không xuất `renderFrames` — không dựng được khung hình.', { module: VIDEOSTUDIO_ENCODE_SPECIFIER });
      await this.#failJob(jobId, err, { warnings });
      throw err;
    }
    const deps = {
      loadImage: async (assetId) => {
        const asset = await this.store.getImageAsset(String(assetId));
        if (!asset) throw new VideoStudioError('VIDEO_ASSET_NOT_FOUND', `Không tìm thấy ảnh gốc ${assetId} để dựng khung.`, { asset_id: String(assetId) });
        const buffer = await this.storage.read(asset);
        let data = null;
        try {
          data = toRgba(decodePng(buffer));
        } catch {
          data = null; // ảnh không giải mã được ⇒ để V2 tự fail-closed theo hợp đồng của nó
        }
        return { asset_id: asset.id, buffer, mime: asset.mime || 'image/png', width: toInt(asset.width), height: toInt(asset.height), data, rgba: data };
      },
      drawText: drawTextOnFrame,
      font: VIDEO_FONT,
      logger: this.logger,
    };

    let source = null;
    try {
      source = await modules.encode.renderFrames(plan, deps);
    } catch (err) {
      const code = String(err?.code || 'VIDEO_RENDER_FAILED');
      const wrapped = new VideoStudioError(code, `Dựng khung hình lỗi (${code}): ${err?.message || err}`, err?.details);
      await this.#failJob(jobId, wrapped, { warnings });
      await this.#evidence(jobId, { bytes: 0, foundFields: ['image_asset:original'], missingFields: ['image_asset:rendered'], blockedReason: code, encoderName: encoder?.name || '' });
      throw wrapped;
    }
    const frames = await collectFrames(source);
    // F3: `renderFrames` gắn cảnh báo THẬT của bước vẽ (alpha bị làm phẳng, ô chữ quá nhỏ, glyph
    // thiếu, pad_color sai…) vào mảng/iterable — phải đẩy lên `warnings` của job, không được nuốt.
    const frameWarnings = Array.isArray(source?.warnings)
      ? source.warnings
      : (Array.isArray(frames?.warnings) ? frames.warnings : []);
    if (frameWarnings.length > 0) warnings.push(...frameWarnings.map(String).slice(0, 20));
    if (frames.length === 0) {
      const err = new VideoStudioError('VIDEO_NO_FRAMES', 'V2 không dựng được khung nào — không mã hoá (fail-closed).');
      await this.#failJob(jobId, err, { warnings });
      throw err;
    }
    return frames;
  }
}

export default VideoStudioPipeline;
