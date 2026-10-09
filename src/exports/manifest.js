/**
 * `manifestFor` — BẢN KÊ KHAI của gói xuất bản (hợp đồng §0 luật 1 + §2).
 *
 * Ba câu hỏi mà `MANIFEST.json` PHẢI trả lời được, và cách file này trả lời:
 *
 *  1. "Cái gì là THẬT, cái gì là GIẢ?"  → `providers` (dấu vết provider lúc chạy) +
 *     `mock_steps` (bước đã chạy bằng provider giả) + `verification` (nhãn kiểm chứng ĐÃ GHI).
 *     TUYỆT ĐỐI không suy từ cấu hình đang chạy: khởi động lại máy chủ với provider thật trên
 *     cùng DB thì job cũ vẫn phải khai MOCK.
 *  2. "Cái gì KHÔNG có trong gói?"      → `missing[]` (lý do cụ thể cho từng mục).
 *  3. "Job đã cảnh báo những gì?"       → `warnings[]` gộp từ mọi dấu vết đã lưu, KHÔNG giấu.
 *
 * Quy ước `counts` đếm theo DỮ LIỆU ĐÃ LƯU của job (hàng trong store), còn `entries`/`files`
 * liệt kê thứ THẬT SỰ nằm trong ZIP. Hai con số này khác nhau khi file trên đĩa đã mất —
 * khi đó `missing[]` + `warnings[]` nói rõ file nào bị bỏ.
 *
 * Nhãn kiểm chứng: chỉ giữ `LIVE_VERIFIED`/`AUTHENTICATED_LIVE_VERIFIED` khi dấu vết đã lưu
 * chứng minh lần trích xuất đi bằng transport `http`. Nghi ngờ ⇒ trả `null` + ghi lý do
 * trong `verification_detail.notes` (thà thiếu nhãn còn hơn nhận đã kiểm chứng bằng dịch vụ thật).
 *
 * VÒNG VÁ R1/R2/R5 (phản biện vòng 2 — `docs/EXPORT-REVIEW.md` §6.2):
 *  · R1 — `mock_steps` đối chiếu với CHÍNH `providers` sẽ in ra ⇒ không bao giờ có
 *    `providers.*.is_mock = true` mà `mock_steps` rỗng; bí bước cụ thể ⇒ ghi `"unknown"` + cảnh báo.
 *  · R2 — nhãn kiểm chứng được CHUẨN HOÁ (trim + HOA, nhận object qua `.level`) TRƯỚC khi xét cổng
 *    ⇒ `'live_verified'`/`'LIVE_VERIFIED '`/`{level:…}` không còn lọt qua cổng bằng chứng.
 *  · R5 — `mock_steps` có phần tử nhưng không đọc được tên (`[null]`) KHÔNG bị coi là "không có
 *    bước giả": ghi `"unknown"` thay vì rỗng.
 */

import { ExportError, EXPORT_CODES } from './errors.js';
import {
  ASSET_GROUPS,
  classifyAsset,
  dedupeStrings,
  mockStepsFromAssets,
  orderMockSteps,
  warningsFromAssets,
} from './assets.js';

/** Phiên bản cấu trúc manifest — tăng khi đổi field theo cách không tương thích ngược. */
export const MANIFEST_VERSION = 1;

/** Tên + phiên bản công cụ tạo gói (khớp `version` trong package.json). */
export const TOOL = Object.freeze({ name: 'vip-product-studio — Gói xuất bản', version: '0.1.0' });

/** Nhãn kiểm chứng nằm trong `VERIFICATION_LEVELS` của store. */
export const LIVE_LEVELS = Object.freeze(['LIVE_VERIFIED', 'AUTHENTICATED_LIVE_VERIFIED']);

/* ───────────────────────── tên file gói ───────────────────────── */

/**
 * Làm sạch một chuỗi để dùng làm tên file: bỏ dấu tiếng Việt, bỏ ký tự lạ, chống
 * tên rỗng/tên đặc biệt của Windows.
 *
 * @param {*} value
 * @param {string} [fallback] dùng khi sau khi làm sạch không còn gì
 * @returns {string}
 */
export function sanitizeFilename(value, fallback = 'goi-xuat-ban') {
  const raw = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  let name = raw
    .normalize('NFD')
    // Bỏ dấu thanh/dấu mũ (tiếng Việt) để tên file an toàn trên mọi hệ tệp.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80);
  if (!name) name = fallback;
  // Tên dành riêng của Windows (CON, PRN, AUX, NUL, COM1..9, LPT1..9) — thêm tiền tố.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `_${name}`;
  return name;
}

/** `YYYYMMDD-HHmm` theo GIỜ ĐỊA PHƯƠNG (cùng múi giờ với dấu thời gian trong ZIP). */
export function stampFor(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Tên file tải về: `<kind>-<jobId ngắn>-<YYYYMMDD-HHmm>.zip`, đã làm sạch ký tự lạ.
 * @param {object} job
 * @param {Date} [date]
 */
export function bundleFilename(job, date = new Date()) {
  const kind = sanitizeFilename(job?.kind, 'job');
  const id = sanitizeFilename(job?.id, 'khong-ro-id').slice(0, 8);
  return `${kind}-${id}-${stampFor(date)}.zip`;
}

/* ───────────────────────── dấu vết provider ───────────────────────── */

/** JSON trong DB có thể là chuỗi (SQLite) hoặc object (PG jsonb). */
function parseMaybeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const asArray = (v) => (Array.isArray(v) ? v : []);

/** Ảnh chụp một provider đã lưu: `{name, model, is_mock, status}` (null nếu không có dấu vết). */
function providerRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const name = rec.provider ?? rec.name ?? null;
  const model = rec.model ?? null;
  const isMock = rec.is_mock ?? null;
  const status = rec.status ?? null;
  if (name === null && model === null && isMock === null && status === null) return null;
  return { name: name === undefined ? null : name, model: model === undefined ? null : model, is_mock: isMock === undefined ? null : isMock, status: status === undefined ? null : status };
}

/**
 * Provider của từng bước, đọc từ DẤU VẾT ĐÃ LƯU (`jobs.content_meta` + bảng `usage_events`).
 * Bước nào job chưa chạy tới ⇒ `null` (không bịa, không lấy cấu hình đang chạy).
 */
export function providersFor(job, usage = [], evidence = []) {
  const meta = job?.content_meta && typeof job.content_meta === 'object' ? job.content_meta : {};
  const il = meta.imagelab && typeof meta.imagelab === 'object' ? meta.imagelab : {};
  const is = meta.imagestudio && typeof meta.imagestudio === 'object' ? meta.imagestudio : {};
  const vs = meta.videostudio && typeof meta.videostudio === 'object' ? meta.videostudio : {};
  const latest = asArray(evidence)[0] || null;

  // MVP-01: `content_meta` CHÍNH LÀ `gen.meta` (provider/model/is_mock nằm ở cấp cao nhất).
  const contentProvider = meta.provider ?? null;
  const contentIsMock = meta.is_mock === true || String(contentProvider ?? '').trim().toLowerCase() === 'mock';
  const content = meta.provider || meta.model
    ? {
        name: contentProvider,
        model: meta.model ?? null,
        // R1 (phản biện vòng 2, LOW): provider tên `mock` ⇒ bước này CHẠY BẰNG PROVIDER GIẢ, kể cả
        // khi dấu vết thiếu cờ `is_mock` — ĐÚNG luật D2 đang áp cho từng dòng `usage_events`
        // (`provider === 'mock'` ⇒ `is_mock: true`). Trước đây nhánh content chỉ đọc `meta.is_mock`
        // nên cùng một job có thể khai `providers.content.name = "mock"` mà `is_mock: null`.
        is_mock: contentIsMock ? true : (meta.is_mock ?? null),
        style: meta.style ?? null,
        length: meta.length ?? null,
        generated_at: meta.generated_at ?? null,
      }
    : null;

  // Tổng hợp `usage_events`: bằng chứng bước nào THẬT SỰ đã chạy (kèm cờ mock đã ghi).
  const byOperation = new Map();
  for (const row of asArray(usage)) {
    if (!row || typeof row !== 'object') continue;
    const rowMeta = parseMaybeJson(row.meta) || {};
    const rowIsMock = rowMeta.is_mock === true || String(row.provider ?? '').toLowerCase() === 'mock';
    const key = `${row.operation ?? ''}\u0000${row.provider ?? ''}\u0000${row.model ?? ''}\u0000${rowIsMock ? '1' : '0'}`;
    const prev = byOperation.get(key);
    if (prev) prev.events += 1;
    else {
      byOperation.set(key, {
        operation: row.operation ?? null,
        provider: row.provider ?? null,
        model: row.model ?? null,
        // D2 (HIGH — manifest khai SAI): `is_mock` phải theo CHÍNH dòng usage này. Trước đây chỉ
        // đọc `meta.is_mock` ⇒ dòng `provider: "mock"` (không có meta) bị khai `is_mock: false`,
        // trong khi `mockStepsFor` coi provider `mock` LÀ mock ⇒ hai chỗ trong cùng gói nói lệch.
        is_mock: rowMeta.is_mock === true || String(row.provider ?? '').toLowerCase() === 'mock',
        events: 1,
      });
    }
  }

  return {
    content,
    // Ảnh chụp provider của lần trích xuất (do pipeline ghi vào extraction_evidence).
    extraction: latest
      ? {
          connector: latest.connector ?? null,
          extraction_method: latest.extraction_method ?? null,
          http_status: latest.http_status ?? null,
          vision_provider: latest.vision_provider || null,
          content_provider: latest.content_provider || null,
        }
      : null,
    imagelab: {
      ocr: providerRecord(il.ocr),
      translate: providerRecord(il.translate),
      render: providerRecord(il.render),
    },
    imagestudio: {
      matting: providerRecord(is.providers?.matting),
      retouch: providerRecord(is.providers?.retouch),
      template: is.template ?? null,
    },
    videostudio: {
      encoder: providerRecord(vs.providers?.encoder),
      preset: vs.preset ?? null,
    },
    usage: [...byOperation.values()],
  };
}

/* ───────────────────────── bước chạy bằng provider GIẢ ───────────────────────── */

/**
 * Ánh xạ `usage_events.operation` → tên bước trong `mock_steps`.
 * Dùng để bắt được cả những bước mà meta asset không nhắc tới (nguồn, vision, dựng khung…).
 */
const OPERATION_STEP = Object.freeze({
  SOURCE_EXTRACT: 'source_extract',
  VISION_ANALYSIS: 'vision',
  TRANSLATION: 'translate',
  CONTENT_GENERATE: 'content',
  CONTENT_REPAIR: 'content',
  OCR_DETECT: 'ocr',
  IMAGE_RENDER: 'render',
  IMAGE_MATTING: 'matting',
  IMAGE_COMPOSE: 'compose',
  IMAGE_RETOUCH: 'retouch',
  VIDEO_RENDER: 'video_render',
  VIDEO_ENCODE: 'video_encode',
});

/** Tên bước dùng khi có dấu vết MOCK nhưng KHÔNG đọc được bước cụ thể nào (R1/R5). */
export const UNKNOWN_MOCK_STEP = 'unknown';

/**
 * Tách một giá trị `mock_steps` ĐÃ LƯU thành phần DÙNG ĐƯỢC và phần dị dạng — R5
 * (phản biện vòng 2, LOW): mảng `[null]`/`[""]`/`[{}]` là CÓ dấu vết mock nhưng không đọc được
 * tên bước. Coi nó như "không có bước giả" chính là để bản kê khai tự mâu thuẫn.
 *
 * Chấp nhận: mảng chuỗi, một chuỗi đơn (dữ liệu cũ ghi thiếu mảng), object có `.step`/`.name`.
 *
 * @returns {{steps: string[], unusable: number, present: boolean}}
 *          `present` = trường có mặt trong dấu vết; `unusable` = số phần tử không đọc được.
 */
export function usableMockSteps(raw) {
  const steps = [];
  let unusable = 0;
  const take = (value) => {
    if (typeof value === 'string') {
      const text = value.trim();
      if (text) steps.push(text);
      else unusable += 1;
      return;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const named = [value.step, value.name, value.id].find((v) => typeof v === 'string' && v.trim());
      if (named) steps.push(named.trim());
      else unusable += 1;
      return;
    }
    unusable += 1;
  };
  if (Array.isArray(raw)) {
    for (const value of raw) take(value);
    return { steps, unusable, present: true };
  }
  if (typeof raw === 'string') {
    if (!raw.trim()) return { steps, unusable, present: false };
    take(raw);
    return { steps, unusable, present: true };
  }
  if (raw && typeof raw === 'object') {
    take(raw);
    return { steps, unusable, present: true };
  }
  return { steps, unusable, present: false };
}

/**
 * Bước MOCK suy TRỰC TIẾP từ `providers` của bản kê khai — CHỐT CHẶN CUỐI của R1: nếu bất kỳ
 * chỗ nào trong `providers` khai `is_mock === true` thì `mock_steps` KHÔNG được rỗng. Không suy
 * ra được bước cụ thể ⇒ trả cờ `unknown` để tầng gọi ghi `"unknown"` + chú thích (không im lặng).
 *
 * @param {object} providers kết quả `providersFor()`
 * @returns {{steps: string[], unknown: boolean}}
 */
export function mockStepsFromProviders(providers) {
  const steps = new Set();
  let hasMockFlag = false;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'is_mock' && value === true) hasMockFlag = true;
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(providers);

  if (providers?.content?.is_mock === true) steps.add('content');
  if (providers?.imagelab?.ocr?.is_mock === true) steps.add('ocr');
  if (providers?.imagelab?.translate?.is_mock === true) steps.add('translate');
  if (providers?.imagelab?.render?.is_mock === true) steps.add('render');
  if (providers?.imagestudio?.matting?.is_mock === true) steps.add('matting');
  if (providers?.imagestudio?.retouch?.is_mock === true) steps.add('retouch');
  if (providers?.videostudio?.encoder?.is_mock === true) steps.add('video_encode');
  for (const row of asArray(providers?.usage)) {
    if (row?.is_mock !== true) continue;
    const step = OPERATION_STEP[row?.operation] || String(row?.operation ?? '').toLowerCase();
    if (step) steps.add(step);
  }
  return { steps: [...steps], unknown: hasMockFlag && steps.size === 0 };
}

/**
 * Các bước đã chạy bằng provider GIẢ, gom từ MỌI dấu vết ĐÃ LƯU:
 *   · `content_meta.imagelab.mock_steps` (pipeline MVP-02 ghi lúc chạy);
 *   · `content_meta.imagelab.{ocr,translate,render}.is_mock` (R1 — pipeline MVP-02 ghi cùng lúc
 *     với `mock_steps`, nhưng DB cũ/sửa tay có thể chỉ có một trong hai);
 *   · `content_meta.is_mock` + provider tên `mock` (MVP-01: `content_meta` chính là `gen.meta`);
 *   · `content_meta.imagestudio.providers.*.is_mock`, `content_meta.videostudio.providers.encoder.is_mock`;
 *   · `meta.*.is_mock` trên từng asset (MVP-02/03/04);
 *   · `usage_events.meta.is_mock` + provider tên `mock` (bằng chứng bước đó đã chạy);
 *   · CHỐT CHẶN: đối chiếu với chính `providers` mà bản kê khai sẽ in ra ⇒ không bao giờ có
 *     chuyện `providers.*.is_mock = true` mà `mock_steps` rỗng (khi bí ⇒ `"unknown"`).
 *
 * KHÔNG suy từ cấu hình đang chạy: bật provider thật rồi đọc lại job cũ vẫn phải ra MOCK.
 */
export function mockStepsFor(job, assets = [], usage = [], evidence = []) {
  const steps = new Set(mockStepsFromAssets(assets));
  const meta = job?.content_meta && typeof job.content_meta === 'object' ? job.content_meta : {};
  const il = meta.imagelab && typeof meta.imagelab === 'object' ? meta.imagelab : {};

  // R5: `[null]`/`[""]` vẫn là DẤU VẾT mock ⇒ không được lặng lẽ bỏ qua rồi khai "không có bước giả".
  const ilSteps = usableMockSteps(il.mock_steps);
  for (const s of ilSteps.steps) steps.add(s);
  if (ilSteps.present && ilSteps.steps.length === 0 && ilSteps.unusable > 0) steps.add(UNKNOWN_MOCK_STEP);

  // R1: đọc cả ba cờ `is_mock` lồng trong `content_meta.imagelab.*` — đúng những field mà
  // `providersFor()` in ra ở `providers.imagelab.{ocr,translate,render}`.
  if (il.ocr?.is_mock) steps.add('ocr');
  if (il.translate?.is_mock) steps.add('translate');
  if (il.render?.is_mock) steps.add('render');

  if (meta.is_mock === true || String(meta.provider ?? '').trim().toLowerCase() === 'mock') steps.add('content');
  if (meta.imagestudio?.providers?.matting?.is_mock) steps.add('matting');
  if (meta.imagestudio?.providers?.retouch?.is_mock) steps.add('retouch');
  if (meta.videostudio?.providers?.encoder?.is_mock) steps.add('video_encode');

  for (const row of asArray(usage)) {
    const rowMeta = parseMaybeJson(row?.meta) || {};
    const provider = String(row?.provider || '').toLowerCase();
    const isMock = rowMeta.is_mock === true || provider === 'mock';
    if (!isMock) continue;
    const step = OPERATION_STEP[row?.operation] || String(row?.operation || '').toLowerCase();
    if (step) steps.add(step);
  }

  // CHỐT CHẶN R1: hai mục của cùng một bản kê khai không bao giờ được nói ngược nhau.
  const fromProviders = mockStepsFromProviders(providersFor(job, usage, evidence));
  for (const s of fromProviders.steps) steps.add(s);
  if (fromProviders.unknown) steps.add(UNKNOWN_MOCK_STEP);

  return orderMockSteps(steps);
}

/* ───────────────────────── nhãn kiểm chứng ───────────────────────── */

/** Tập mức kiểm chứng đã đóng băng của store (`VERIFICATION_LEVELS`) + hai mức LIVE. */
export const KNOWN_LEVELS = Object.freeze([
  ...LIVE_LEVELS,
  'MOCK_VERIFIED',
  'MANUAL_INPUT',
  'BLOCKED',
  'UNSUPPORTED',
]);

/**
 * Chuẩn hoá nhãn kiểm chứng ĐÃ GHI về CHUỖI chuẩn (trim + HOA) — R2 (phản biện vòng 2, LOW).
 *
 * Trước đây cổng chỉ so khớp CHÍNH XÁC nên `'live_verified'` (chữ thường), `'LIVE_VERIFIED '`
 * (dấu cách cuối) hay object `{level:'LIVE_VERIFIED'}` đều LỌT qua cổng "chỉ giữ LIVE khi có
 * `transport === 'http'`" ⇒ gói khẳng định đã kiểm chứng bằng dịch vụ thật mà không có bằng chứng.
 * Giá trị không phải chuỗi/không đọc được mức ⇒ coi như KHÔNG có nhãn + ghi `reason`.
 *
 * @param {*} raw giá trị `verification` đã lưu
 * @returns {{level: string|null, raw: *, reason: string|null}}
 */
export function normalizeVerificationLevel(raw) {
  if (raw === null || raw === undefined || raw === '') return { level: null, raw: raw ?? null, reason: null };
  if (typeof raw === 'string') {
    const level = raw.trim().toUpperCase();
    return level
      ? { level, raw, reason: null }
      : { level: null, raw, reason: 'Nhãn kiểm chứng chỉ có khoảng trắng ⇒ coi như KHÔNG có nhãn.' };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of ['level', 'label', 'status', 'verification']) {
      const value = raw[key];
      if (typeof value === 'string' && value.trim()) {
        return {
          level: value.trim().toUpperCase(),
          raw,
          reason: `Nhãn kiểm chứng được lưu dưới dạng OBJECT (đã đọc \`${key}\`) — bản kê khai chỉ nhận CHUỖI nên gói chuẩn hoá về chuỗi TRƯỚC khi xét cổng bằng chứng.`,
        };
      }
    }
    return { level: null, raw, reason: 'Nhãn kiểm chứng là OBJECT nhưng KHÔNG có `level`/`label`/`status` dạng chuỗi ⇒ coi như KHÔNG có nhãn.' };
  }
  return {
    level: null,
    raw,
    reason: `Nhãn kiểm chứng có kiểu dữ liệu lạ (${Array.isArray(raw) ? 'array' : typeof raw}) ⇒ coi như KHÔNG có nhãn.`,
  };
}

/** Nhãn (đã chuẩn hoá) có phải KHẲNG ĐỊNH "đã kiểm chứng bằng dịch vụ thật" hay không. */
export function isLiveClaim(level) {
  return typeof level === 'string' && /LIVE/.test(level.toUpperCase());
}

/**
 * Nhãn kiểm chứng của job + phần giải thích. Quy tắc bất khả xâm phạm (hợp đồng §0.1):
 * KHÔNG BAO GIỜ khẳng định `LIVE_VERIFIED` nếu dấu vết không chứng minh đã gọi dịch vụ thật.
 *
 * @returns {{label: string|null, detail: object}}
 */
export function verificationFor(job, evidence = [], mockSteps = []) {
  const rows = asArray(evidence);
  const latest = rows[0] || null; // `store.getEvidence` sắp `created_at DESC`
  const fromJobEvidence = job?.evidence?.verification || null;
  const recordedRaw = latest?.verification ?? fromJobEvidence ?? null;
  // "Có bản ghi" ≠ "đọc được mức": `0`/`false` vẫn là CÓ ghi (đừng nói "job chưa ghi bằng chứng").
  const hasRecorded = recordedRaw !== null && recordedRaw !== undefined && recordedRaw !== '';
  // R2: CHUẨN HOÁ trước khi xét cổng. `recorded` = chuỗi chuẩn (dùng cho mọi phép so khớp),
  // `recorded_level` trong detail giữ NGUYÊN BẢN đã lưu để còn truy vết.
  const normalized = normalizeVerificationLevel(recordedRaw);
  const recorded = normalized.level;
  const recordedLevels = dedupeStrings(rows.map((r) => normalizeVerificationLevel(r?.verification).level).filter(Boolean));

  const transport = job?.product_master?.extraction?.transport ?? null;
  const extractionMethod = latest?.extraction_method || job?.evidence?.extraction_method || '';
  const liveServiceCalled = transport === 'http';
  const mock = orderMockSteps(mockSteps);

  const notes = [];
  if (normalized.reason) notes.push(normalized.reason);
  // D3: mức ĐÚNG khi không đủ căn cứ LIVE — theo cổng chuẩn của repo (`transport === 'manual'` ⇒
  // `MANUAL_INPUT`, còn lại ⇒ `MOCK_VERIFIED`; xem `determineVerificationLevel` ở `src/jobs/pipeline.js`).
  const downgradedLevel = transport === 'manual' ? 'MANUAL_INPUT' : 'MOCK_VERIFIED';
  let label = recorded;

  // D3 (MEDIUM — fail-open) + R2 (LOW — cổng so khớp CHÍNH XÁC): nhãn LIVE chỉ được GIỮ khi dấu
  // vết CHỨNG MINH có `transport === 'http'`. Nhãn đã chuẩn hoá nên `live_verified`,
  // `LIVE_VERIFIED ` (dấu cách) hay object `{level:…}` đều đi qua CHÍNH cổng này.
  if (label && isLiveClaim(label) && transport !== 'http') {
    notes.push(
      transport === null
        ? `Dấu vết ghi nhãn "${label}" nhưng KHÔNG có transport của lần trích xuất (thiếu bằng chứng đã gọi dịch vụ thật) ⇒ gói KHÔNG giữ nhãn này. Mức đúng: ${downgradedLevel}.`
        : `Dấu vết ghi nhãn "${label}" nhưng transport của lần trích xuất là ${JSON.stringify(transport)} — KHÔNG đủ căn cứ khẳng định đã gọi dịch vụ thật ⇒ gói KHÔNG giữ nhãn này. Mức đúng: ${downgradedLevel}.`,
    );
    // Hợp đồng §0.1 + test đã nghiệm thu: NGHI NGỜ ⇒ trả `null` (gói KHÔNG tự gán nhãn thay),
    // nhưng ghi rõ MỨC ĐÚNG vào `verification_detail` để người đọc biết phải hiểu thế nào.
    label = null;
  }
  if (label && isLiveClaim(label) && mock.length > 0) {
    notes.push(
      `Job có nguồn trích xuất THẬT (transport "http") nhưng vẫn có bước chạy provider GIẢ: ${mock.join(', ')} — phần dữ liệu của các bước đó KHÔNG phải kết quả của dịch vụ thật.`,
    );
  }
  if (recorded && !KNOWN_LEVELS.includes(recorded)) {
    notes.push(`Nhãn "${recorded}" không nằm trong tập mức kiểm chứng đã đóng băng của store — gói giữ NGUYÊN VĂN nhãn đã lưu nhưng KHÔNG coi đó là một mức chuẩn.`);
  }
  if (!hasRecorded) {
    notes.push('Job chưa ghi bằng chứng trích xuất nào (bảng extraction_evidence rỗng, jobs.evidence chưa có `verification`) ⇒ không có nhãn kiểm chứng để khai.');
  }

  return {
    label: label || null,
    detail: {
      label: label || null,
      // Nguyên bản đã lưu (có thể là object/giá trị lạ nếu DB bị sửa tay) + bản đã chuẩn hoá.
      recorded_level: recordedRaw,
      recorded_level_normalized: recorded,
      recorded_levels: recordedLevels,
      source: latest ? 'extraction_evidence' : fromJobEvidence ? 'jobs.evidence' : 'none',
      connector: latest?.connector ?? null,
      extraction_method: extractionMethod || null,
      http_status: latest?.http_status ?? null,
      transport,
      live_service_called: liveServiceCalled,
      // D3: mức ĐÚNG theo cổng chuẩn của repo khi nhãn LIVE bị bỏ (null nếu gói vẫn giữ nhãn).
      suggested_level: label ? null : (recorded ? downgradedLevel : null),
      contains_mock: mock.length > 0,
      mock_steps: mock,
      notes,
    },
  };
}

/* ───────────────────────── cảnh báo ───────────────────────── */

/**
 * Gộp MỌI cảnh báo đã lưu của job: `content_meta` từng khối, meta từng asset, bằng chứng
 * trích xuất, lỗi job. Không tự sinh cảnh báo mới, không bỏ cảnh báo nào (chỉ khử trùng lặp).
 */
export function collectJobWarnings(job, assets = [], evidence = [], extraWarnings = []) {
  const meta = job?.content_meta && typeof job.content_meta === 'object' ? job.content_meta : {};
  const il = meta.imagelab && typeof meta.imagelab === 'object' ? meta.imagelab : {};
  const is = meta.imagestudio && typeof meta.imagestudio === 'object' ? meta.imagestudio : {};
  const vs = meta.videostudio && typeof meta.videostudio === 'object' ? meta.videostudio : {};

  const out = [];
  const pushList = (source) => {
    for (const w of asArray(source)) {
      if (w === null || w === undefined || w === '') continue;
      out.push(typeof w === 'string' ? w : JSON.stringify(w));
    }
  };

  // MVP-01: lỗi sinh nội dung được lưu ngay trên content_meta.
  if (meta.error) out.push(`Sinh nội dung thất bại: ${String(meta.error)}`);
  pushList(il.warnings);
  pushList(il.ocr?.warnings);
  pushList(il.translate?.warnings);
  pushList(il.render?.warnings);
  pushList(is.warnings);
  for (const f of asArray(is.failures)) {
    if (f && typeof f === 'object' && (f.message || f.code)) out.push(`Bước tạo ảnh thất bại (${f.code || 'không rõ mã'}): ${f.message || ''}`.trim());
    else if (typeof f === 'string' && f) out.push(f);
  }
  pushList(vs.warnings);
  pushList(vs.violations);
  pushList(job?.evidence?.warnings);
  pushList(job?.evidence?.guardrails?.warnings);
  pushList(job?.product_master?.extraction?.warnings);
  for (const row of asArray(evidence)) {
    if (row?.blocked_reason) out.push(`Nguồn bị chặn khi trích xuất: ${String(row.blocked_reason)}`);
  }
  if (job?.error_message) out.push(`Job kết thúc với lỗi (${job.error_code || 'không rõ mã'}): ${job.error_message}`);
  pushList(warningsFromAssets(assets));
  pushList(extraWarnings);

  return dedupeStrings(out);
}

/* ───────────────────────── manifest ───────────────────────── */

/**
 * Dựng `MANIFEST.json`.
 *
 * @param {object} params
 * @param {object} params.job job đã hydrate (`store.getJob`)
 * @param {Array} [params.assets] `store.listImageAssets(jobId)`
 * @param {Array} [params.lines] `store.listTranslationLines(jobId)`
 * @param {Array} [params.usage] `store.listUsage(jobId)`
 * @param {Array} [params.evidence] `store.getEvidence(jobId)`
 * @param {object} [params.extra] dữ liệu CHỈ `buildExportBundle` biết: `{ entries, files,
 *        original_sha256, warnings, missing, regions, filename, generated_at, audio,
 *        counts_note }`. Bỏ trống thì manifest vẫn đúng cho phần dữ liệu store.
 * @returns {object} manifest (đối tượng thuần, `JSON.stringify` được ngay)
 */
export function manifestFor({ job, assets = [], lines = [], usage = [], evidence = [], extra = null } = {}) {
  if (!job || typeof job !== 'object' || !job.id) {
    throw new ExportError(EXPORT_CODES.BAD_INPUT, 'manifestFor cần `job` đã hydrate (có `job.id`) — không có job thì không có gì để kê khai.');
  }
  const assetList = asArray(assets);
  const lineList = asArray(lines);
  const usageList = asArray(usage);
  const evidenceList = asArray(evidence);
  const ex = extra && typeof extra === 'object' ? extra : {};

  const originals = assetList.filter((a) => classifyAsset(a) === ASSET_GROUPS.ORIGINAL);
  const images = assetList.filter((a) => classifyAsset(a) === ASSET_GROUPS.IMAGE);
  const videos = assetList.filter((a) => classifyAsset(a) === ASSET_GROUPS.VIDEO);
  // D1 (phản biện Gói xuất bản, HIGH — §0 luật 1 “gói phải tự khai”): gom bước MOCK từ MỌI dấu vết
  // ĐÃ LƯU, không chỉ từ meta asset. Trước đây chỉ dùng `mockStepsFromAssets` ⇒ job MVP-01/02 chạy
  // provider GIẢ (`content_meta.is_mock`, `content_meta.imagelab.mock_steps`, `usage_events.provider
  // = 'mock'`) vẫn khai `mock_steps: []` — gói GIẤU bước dùng dữ liệu giả, và UI in câu sai
  // “Máy chủ khai KHÔNG có bước nào dùng dữ liệu giả”.
  // R1/R5: `mockStepsFor` đọc thêm cờ `is_mock` lồng trong `content_meta.imagelab.*`, đối chiếu
  // với chính `providers` sẽ in ra, và KHÔNG bỏ qua dấu vết `mock_steps` dị dạng (`[null]`…).
  const extraMock = usableMockSteps(ex.mock_steps);
  const mockSteps = orderMockSteps(new Set([
    ...mockStepsFor(job, assetList, usageList, evidenceList),
    ...mockStepsFromAssets(assetList),
    ...extraMock.steps,
    ...(extraMock.present && extraMock.steps.length === 0 && extraMock.unusable > 0 ? [UNKNOWN_MOCK_STEP] : []),
  ]));
  const { label: verification, detail: verificationDetail } = verificationFor(job, evidenceList, mockSteps);

  // Tiếng: bản offline KHÔNG có tiếng. Chỉ trả object khi có provider THẬT SỰ khai dữ liệu tiếng.
  const audioDeclared = videos.map((a) => (a?.meta && typeof a.meta === 'object' ? a.meta.audio : undefined)).find((v) => v !== null && v !== undefined) ?? null;
  const noAudio = videos.length > 0 && videos.every((a) => !a?.meta || a.meta.audio === null || a.meta.audio === undefined);
  const audioNote =
    videos.length === 0
      ? 'Job không có video nên gói không có phần tiếng (audio).'
      : audioDeclared
        ? 'Có dấu vết dữ liệu tiếng do provider khai — xem nội dung bên dưới.'
        : 'Video của job KHÔNG có tiếng (bản offline chỉ mã hoá hình ảnh) — `audio: null` là SỰ THẬT, không phải thiếu dữ liệu.';

  // `packaged` = danh sách entry THẬT SỰ có trong ZIP (chỉ `buildExportBundle` biết).
  const packaged = Array.isArray(ex.entries) ? new Set(ex.entries) : null;
  const hasEntry = (predicate) => (packaged ? [...packaged].some(predicate) : null);

  const warnings = collectJobWarnings(job, assetList, evidenceList, ex.warnings);
  // R1/R5: `"unknown"` là lời khai THẬT "có dấu vết provider giả nhưng không đọc được bước nào" —
  // phải kèm chú thích, không được để người đọc tự đoán.
  if (mockSteps.includes(UNKNOWN_MOCK_STEP)) {
    warnings.push(
      'Dấu vết của job có bước chạy provider GIẢ nhưng KHÔNG đọc được tên bước nào (thiếu/dị dạng ở `content_meta.imagelab.mock_steps` hoặc `usage_events`) ⇒ `mock_steps` ghi "unknown" thay vì để rỗng — gói KHÔNG khẳng định là không có bước giả.',
    );
  }
  const missing = [];
  const extraMissing = asArray(ex.missing).map((m) => (typeof m === 'string' ? m : JSON.stringify(m)));
  missing.push(...extraMissing);

  const hasContentData = Boolean(job.content && typeof job.content === 'object' && Object.keys(job.content).length > 0);
  const hasLineData = lineList.length > 0 || asArray(ex.regions).length > 0;
  const noiDungPackaged = hasEntry((n) => n.startsWith('noi-dung/'));
  if (noiDungPackaged === false) {
    missing.push('noi-dung/ — job không có nội dung văn bản nào để đóng gói (jobs.content rỗng và không có dòng dịch/vùng OCR nào).');
  } else if (noiDungPackaged === null && !hasContentData && !hasLineData) {
    missing.push('noi-dung/noi-dung.json — job chưa có nội dung đã sinh (jobs.content = null) và cũng chưa có bản dịch/vùng OCR nào.');
  }
  if (noiDungPackaged === true && !hasContentData && hasLineData) {
    missing.push('noi-dung/noi-dung.json KHÔNG chứa nội dung MVP-01 (job không sinh nội dung) — file chỉ chứa bản dịch/vùng OCR đã lưu.');
  }

  const anhPackaged = hasEntry((n) => n.startsWith('anh/'));
  if (anhPackaged === false) {
    missing.push(
      assetList.length === 0
        ? 'anh/ — job không có asset ảnh nào (image_assets rỗng).'
        : `anh/ — job có ${assetList.length} asset trong DB nhưng KHÔNG file nào đọc được từ đĩa (xem cảnh báo).`,
    );
  } else if (anhPackaged === null && assetList.length === 0) {
    missing.push('anh/ — job không có asset ảnh nào (image_assets rỗng).');
  }
  if (images.length === 0 && job.kind === 'image_generation') {
    missing.push('anh/anh-tao-*.png — job tạo ảnh nhưng chưa có asset `rendered` nào (job chưa chạy xong hoặc đã thất bại).');
  }

  const videoPackaged = hasEntry((n) => n.startsWith('video/'));
  if (videoPackaged === false) {
    missing.push(
      videos.length === 0
        ? (job.kind === 'video_generation'
            ? 'video/ — job tạo video nhưng chưa có asset video `rendered` nào (job chưa mã hoá xong hoặc đã thất bại).'
            : 'video/ — job này không tạo video.')
        : `video/ — job có ${videos.length} asset video trong DB nhưng KHÔNG file nào đọc được từ đĩa (xem cảnh báo).`,
    );
  } else if (videoPackaged === null && videos.length === 0) {
    missing.push(job.kind === 'video_generation' ? 'video/ — job tạo video nhưng chưa có asset video nào.' : 'video/ — job này không tạo video.');
  }

  if (usageList.length === 0) missing.push('bang-chung/usage.json — job chưa ghi dòng `usage_events` nào (file vẫn có, phần `events` rỗng).');
  if (evidenceList.length === 0) missing.push('bang-chung/evidence.json — job chưa ghi bản ghi `extraction_evidence` nào (file vẫn có, phần `extraction_evidence` rỗng).');
  if (originals.length === 0) missing.push('anh/anh-goc-* — job không có ảnh gốc nào (chưa tải ảnh lên hoặc nguồn không trả ảnh).');

  // `original_sha256`: bundle truyền bản ĐÃ TÍNH LẠI từ đĩa; gọi trực tiếp thì lấy từ DB
  // (kèm `verified: false` để nói rõ "chưa đối chiếu lại trong lần xuất này").
  const originalSha256 = Array.isArray(ex.original_sha256) && ex.original_sha256.length > 0
    ? ex.original_sha256
    : originals.map((a) => ({
        asset_id: a.id,
        entry: null,
        sha256: a.sha256 || null,
        db_sha256: a.sha256 || null,
        match: null,
        bytes: Number.isFinite(Number(a.bytes)) ? Number(a.bytes) : null,
        verified: false,
      }));

  const manifest = {
    manifest_version: MANIFEST_VERSION,
    generated_at: typeof ex.generated_at === 'string' && ex.generated_at ? ex.generated_at : new Date().toISOString(),
    filename: typeof ex.filename === 'string' && ex.filename ? ex.filename : bundleFilename(job),
    job: {
      id: job.id,
      kind: job.kind || 'content',
      status: job.status || null,
      stage: job.stage ?? null,
      product_name: job.product_name || null,
      source: job.source || null,
      source_url: job.source_url || null,
      created_at: job.created_at ?? null,
      updated_at: job.updated_at ?? null,
      finished_at: job.finished_at ?? null,
      error_code: job.error_code ?? null,
      error_message: job.error_message ?? null,
    },
    providers: providersFor(job, usageList, evidenceList),
    mock_steps: mockSteps,
    verification,
    verification_detail: verificationDetail,
    audio: audioDeclared || null,
    audio_note: audioNote,
    no_audio: noAudio,
    counts: {
      assets: assetList.length,
      images: images.length,
      videos: videos.length,
      lines: lineList.length,
      usage: usageList.length,
    },
    warnings,
    missing,
    original_sha256: originalSha256,
    entries: Array.isArray(ex.entries) ? [...ex.entries] : [],
    files: Array.isArray(ex.files) ? ex.files : [],
    provenance: {
      providers: 'jobs.content_meta (dấu vết ghi lúc chạy) + bảng usage_events',
      verification: 'bảng extraction_evidence (mới nhất) + jobs.evidence',
      counts: 'số hàng đã lưu của job trong store (assets/lines/usage)',
      entries_files: 'file THẬT SỰ có trong ZIP (đọc từ đĩa qua storage, chỉ ĐỌC)',
      warnings: 'gộp từ content_meta từng khối + meta từng asset + bằng chứng trích xuất',
    },
    tool: { ...TOOL },
  };

  return manifest;
}

export default manifestFor;
