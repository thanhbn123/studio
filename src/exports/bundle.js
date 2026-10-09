/**
 * `buildExportBundle` — đóng gói MỌI THỨ ĐÃ TẠO của một job thành một file ZIP.
 *
 * Luồng (đúng hợp đồng §2 và ba luật §0):
 *
 *   1. Đọc dữ liệu ĐÃ LƯU của job: `getJob`, `listImageAssets`, `listTranslationLines`,
 *      `listUsage`, `getEvidence`, `listOcrRegions`. Không đọc gì khác, không suy diễn.
 *   2. Đọc từng file asset qua `storage.read` — CHỈ ĐỌC. Không ghi, không sửa, không đổi tên
 *      trên đĩa (luật §0.3: `sha256` ảnh gốc trước/sau khi xuất phải y hệt).
 *   3. Dựng `MANIFEST.json` từ dữ liệu vừa đọc + `sha256` TỰ TÍNH của ảnh gốc để chứng minh
 *      bất biến, rồi mới ghi ZIP (manifest phải biết trước chính xác gói có file nào).
 *   4. Ghi ZIP bằng `createZip`, sau đó ĐỌC LẠI bằng `inspectZip` (bộ đọc độc lập) để chắc
 *      chắn gói phát ra cho người dùng là ZIP thật — sai thì ném lỗi, KHÔNG trả gói hỏng.
 *
 * Thiếu dữ liệu KHÔNG phải lỗi: job chưa có gì vẫn ra gói hợp lệ + `missing[]` nói rõ.
 * Lỗi thật (job không tồn tại, store hỏng, gói vượt trần) thì ném `ExportError` có `.code`.
 */

import { Buffer } from 'node:buffer';
import { ExportError, EXPORT_CODES } from './errors.js';
import { crc32 } from './crc32.js';
import { createZip } from './create-zip.js';
import { inspectZip } from './inspect-zip.js';
import {
  ASSET_GROUPS,
  assetEntryName,
  classifyAsset,
  mockStepsFromAssets,
  orderMockSteps,
  sha256Hex,
} from './assets.js';
import { bundleFilename, collectJobWarnings, manifestFor, mockStepsFor } from './manifest.js';
import { renderHumanText } from './text.js';
import { DEFAULT_MAX_BUNDLE_BYTES } from './limits.js';

/**
 * Trần tổng dữ liệu đóng gói (byte) — vượt ⇒ ném `BUNDLE_TOO_LARGE` thay vì ăn hết RAM.
 * R6 (phản biện vòng 2, MEDIUM): hạ từ 512 MiB xuống CÙNG mặc định với tầng dịch vụ
 * (`EXPORT_MAX_BUNDLE_BYTES`, 64 MiB) — 60 MB asset đo được ~+270 MB RSS (~4,5×), nên trần
 * 512 MiB cho phép một request cấp phát ~2 GB. Tầng route truyền trần đã cấu hình qua
 * `maxTotalBytes`; giá trị ở đây là mức chặn cuối cho người gọi trực tiếp module.
 */
export const DEFAULT_MAX_TOTAL_BYTES = DEFAULT_MAX_BUNDLE_BYTES;

/** Thứ tự nhóm asset trong ZIP cho dễ nhìn: ảnh gốc → ảnh tạo → video. */
const GROUP_RANK = Object.freeze({ [ASSET_GROUPS.ORIGINAL]: 0, [ASSET_GROUPS.IMAGE]: 1, [ASSET_GROUPS.VIDEO]: 2 });

/** Gọi một hàm store TUỲ CHỌN; thiếu hàm thì trả `[]` + ghi cảnh báo (không im lặng). */
async function optionalList(store, method, jobId, warnings, label) {
  if (typeof store?.[method] !== 'function') {
    warnings.push(`Store không có hàm \`${method}()\` — mục "${label}" không đóng gói được trong lần xuất này.`);
    return [];
  }
  const rows = await store[method](jobId);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Ép nội dung một entry về Buffer (không copy nếu đã là Buffer).
 * Nhận thêm `string` vì các file do gói TỰ SINH (MANIFEST.json, noi-dung.txt, usage.json…)
 * được dựng dưới dạng chuỗi UTF-8; file đọc từ đĩa luôn là Buffer/Uint8Array.
 */
function toBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new ExportError(EXPORT_CODES.INVALID_BUFFER, `Nội dung entry "${label}" không phải Buffer/Uint8Array/string.`, { label });
}

/** Bỏ `session_id` khỏi bản ghi usage khi đóng gói (gói không cần mã phiên của người dùng). */
function redactUsageRow(row) {
  if (!row || typeof row !== 'object') return row;
  const { session_id: _sessionId, ...rest } = row;
  return rest;
}

/**
 * Nội dung cho `noi-dung/noi-dung.json`.
 *  - Job MVP-01: chính `job.content` (NGUYÊN BẢN từ store).
 *  - Job ảnh (MVP-02): bản dịch + vùng OCR đã lưu, kèm câu nói rõ đây không phải nội dung MVP-01.
 *  - Không có gì: `null` ⇒ KHÔNG tạo file (luật §0.2).
 *
 * @returns {{json: object|string, forText: object|string|null}|null}
 */
function contentPayloadFor({ job, lines, regions }) {
  const content = job?.content;
  const hasObject = content && typeof content === 'object' && !Array.isArray(content) && Object.keys(content).length > 0;
  const hasString = typeof content === 'string' && content.trim() !== '';
  if (hasObject || hasString) return { json: content, forText: content };
  if (lines.length === 0 && regions.length === 0) return null;
  return {
    json: {
      job_id: job.id,
      kind: job.kind || 'content',
      source: 'store: listTranslationLines() + listOcrRegions()',
      note: 'Job này KHÔNG sinh nội dung bán hàng (MVP-01). File này chứa bản dịch chữ trên ảnh và vùng OCR ĐÃ LƯU của job — không có dữ liệu nào được thêm vào khi xuất gói.',
      translations: lines,
      ocr_regions: regions,
    },
    forText: null,
  };
}

/** Tổng hợp `usage_events` (chỉ cộng số đã lưu, không ước lượng thêm). */
function usageTotals(events) {
  let inputUnits = 0;
  let outputUnits = 0;
  let cost = 0;
  const currencies = new Set();
  for (const e of events) {
    if (Number.isFinite(Number(e?.input_units))) inputUnits += Number(e.input_units);
    if (Number.isFinite(Number(e?.output_units))) outputUnits += Number(e.output_units);
    if (Number.isFinite(Number(e?.estimated_cost))) cost += Number(e.estimated_cost);
    if (e?.currency) currencies.add(String(e.currency));
  }
  return {
    events: events.length,
    input_units: inputUnits,
    output_units: outputUnits,
    estimated_cost: Math.round(cost * 1e6) / 1e6,
    currency: currencies.size === 1 ? [...currencies][0] : null,
    currencies: [...currencies],
  };
}

/**
 * Xuất gói cho một job.
 *
 * @param {object} params
 * @param {object} params.store store đã dựng (`createStore`) — chỉ ĐỌC
 * @param {object} params.storage `app.storage` (ImageLab storage) — chỉ ĐỌC file asset
 * @param {string} params.jobId id job cần xuất
 * @param {object} [params.logger]
 * @param {Date} [params.now] mốc thời gian (tên file + `generated_at` + mtime trong ZIP)
 * @param {boolean} [params.verify] tự đọc lại ZIP bằng `inspectZip` trước khi trả (mặc định true)
 * @param {number} [params.maxTotalBytes] trần tổng dữ liệu đóng gói
 * @returns {Promise<{buffer: Buffer, filename: string, bytes: number, entries: string[],
 *   manifest: object, warnings: string[], missing: string[], files: Array, verified: boolean}>}
 * @throws {ExportError} `JOB_NOT_FOUND` | `BAD_INPUT` | `STORE_READ_FAILED` | `BUNDLE_TOO_LARGE` | `ZIP_SELF_CHECK_FAILED`
 */
/**
 * D5 (phản biện Gói xuất bản, MEDIUM) — CHỈ dựng bản kê khai, KHÔNG tạo ZIP.
 *
 * Dùng cho `GET /api/exports/jobs/:id/manifest`. Vẫn đọc dữ liệu đã lưu + băm ảnh gốc để
 * `manifest` qua API và `MANIFEST.json` trong gói là MỘT nguồn sự thật (hợp đồng §3), nhưng
 * KHÔNG nén, KHÔNG giữ buffer ⇒ rẻ hơn hẳn về CPU/RAM.
 *
 * @returns {Promise<{buffer:null, zipped:false, entries:string[], manifest:object, warnings:string[], missing:string[]}>}
 */
export async function buildExportManifest(params = {}) {
  return buildExportBundle({ ...params, zip: false });
}

export async function buildExportBundle({
  store,
  storage,
  jobId,
  logger = null,
  now = new Date(),
  verify = true,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  // D5 (phản biện Gói xuất bản, MEDIUM): `zip: false` ⇒ CHỈ dựng bản kê khai, KHÔNG nén ZIP.
  // Route `/manifest` dùng đường này: trước đây nó dựng cả gói rồi bỏ buffer ⇒ job 60 MB asset
  // tốn ~2,3s CPU và ~245 MB RSS cho một phản hồi 10 KB.
  zip = true,
} = {}) {
  /* ── 0. Kiểm đầu vào ────────────────────────────────────────────────── */
  if (!store || typeof store.getJob !== 'function' || typeof store.listImageAssets !== 'function') {
    throw new ExportError(EXPORT_CODES.BAD_INPUT, 'buildExportBundle cần `store` có `getJob()` và `listImageAssets()`.');
  }
  if (!storage || typeof storage.read !== 'function') {
    throw new ExportError(EXPORT_CODES.BAD_INPUT, 'buildExportBundle cần `storage` có `read()` (chỉ đọc file asset).');
  }
  const id = typeof jobId === 'string' ? jobId.trim() : '';
  if (!id) {
    throw new ExportError(EXPORT_CODES.BAD_INPUT, 'buildExportBundle cần `jobId` là chuỗi khác rỗng.', { jobId: String(jobId ?? '') });
  }
  const date = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const generatedAt = date.toISOString();
  const limit = Number.isFinite(Number(maxTotalBytes)) && Number(maxTotalBytes) > 0 ? Number(maxTotalBytes) : DEFAULT_MAX_TOTAL_BYTES;

  /* ── 1. Job ─────────────────────────────────────────────────────────── */
  let job;
  try {
    job = await store.getJob(id);
  } catch (err) {
    throw new ExportError(EXPORT_CODES.STORE_READ_FAILED, `Không đọc được job ${id} từ store: ${err?.message || err}`, { jobId: id, cause_code: err?.code || null });
  }
  if (!job) {
    throw new ExportError(EXPORT_CODES.JOB_NOT_FOUND, `Không tìm thấy job ${id} — không có gì để xuất.`, { jobId: id });
  }

  /* ── 2. Dữ liệu đã lưu (bốn nguồn LÕI: lỗi thật thì ném, không được coi là "job rỗng") ── */
  const softWarnings = [];
  let assets;
  let lines;
  let usage;
  let evidence;
  try {
    assets = await store.listImageAssets(id);
    lines = typeof store.listTranslationLines === 'function' ? await store.listTranslationLines(id) : [];
    usage = typeof store.listUsage === 'function' ? await store.listUsage(id) : [];
    evidence = typeof store.getEvidence === 'function' ? await store.getEvidence(id) : [];
  } catch (err) {
    throw new ExportError(EXPORT_CODES.STORE_READ_FAILED, `Không đọc được dữ liệu của job ${id}: ${err?.message || err}`, { jobId: id, cause_code: err?.code || null });
  }
  if (!Array.isArray(assets)) assets = [];
  if (!Array.isArray(lines)) lines = [];
  if (!Array.isArray(usage)) usage = [];
  if (!Array.isArray(evidence)) evidence = [];
  const regions = await optionalList(store, 'listOcrRegions', id, softWarnings, 'vùng OCR');

  const payloadEntries = []; // entry của ZIP, KHÔNG gồm MANIFEST.json (dựng sau)
  const files = []; // bản kê file thật trong gói: {path, bytes, sha256, source}
  const missing = [];
  const extraWarnings = [...softWarnings];
  const originalSha256 = [];
  let totalBytes = 0;

  const addEntry = (name, data, source, at = null) => {
    const buf = toBuffer(data, name);
    const record = { path: name, bytes: buf.length, sha256: sha256Hex(buf), source };
    if (Number.isInteger(at)) {
      payloadEntries.splice(at, 0, { name, data: buf });
      files.splice(at, 0, record);
    } else {
      payloadEntries.push({ name, data: buf });
      files.push(record);
    }
    totalBytes += buf.length;
    if (totalBytes > limit) {
      throw new ExportError(EXPORT_CODES.BUNDLE_TOO_LARGE, `Gói vượt trần ${limit} byte — từ chối xuất để không ăn hết bộ nhớ.`, { bytes: totalBytes, limit, jobId: id });
    }
  };

  /* ── 3. Nội dung văn bản: file JSON (nguyên bản từ store) ───────────── */
  const payload = contentPayloadFor({ job, lines, regions });
  if (payload !== null) {
    addEntry('noi-dung/noi-dung.json', `${JSON.stringify(payload.json, null, 2)}\n`, 'store: jobs.content | translation_lines | ocr_regions');
  }

  /* ── 4. Ảnh gốc + ảnh tạo + video (CHỈ ĐỌC) ─────────────────────────── */
  const ordered = [...assets].sort((a, b) => {
    const ra = GROUP_RANK[classifyAsset(a)] ?? 9;
    const rb = GROUP_RANK[classifyAsset(b)] ?? 9;
    if (ra !== rb) return ra - rb;
    return String(a?.created_at || '').localeCompare(String(b?.created_at || ''));
  });
  const counter = { [ASSET_GROUPS.ORIGINAL]: 0, [ASSET_GROUPS.IMAGE]: 0, [ASSET_GROUPS.VIDEO]: 0 };

  for (const asset of ordered) {
    const group = classifyAsset(asset);
    counter[group] += 1;
    const naming = assetEntryName(asset, counter[group]);
    if (naming.warning) extraWarnings.push(naming.warning);

    let data;
    try {
      data = await storage.read(asset);
    } catch (err) {
      const code = err?.code || err?.name || 'READ_FAILED';
      missing.push(`${naming.name} — KHÔNG đọc được file của asset ${asset.id} trên đĩa (${code}); gói không chứa file này.`);
      extraWarnings.push(`Asset ${asset.id} (${group}) không đưa được vào gói: ${code} — ${err?.message || 'không rõ lý do'}`);
      continue;
    }
    // `storage.read` PHẢI trả byte thật; trả thứ khác là hợp đồng storage bị vi phạm ⇒ nói thẳng.
    if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
      throw new ExportError(EXPORT_CODES.INVALID_BUFFER, `\`storage.read\` không trả về Buffer/Uint8Array cho asset ${asset.id}.`, { asset_id: asset.id });
    }
    const buf = toBuffer(data, naming.name);
    const sha = sha256Hex(buf);

    if (group === ASSET_GROUPS.ORIGINAL) {
      const dbSha = typeof asset.sha256 === 'string' && asset.sha256 ? asset.sha256 : null;
      originalSha256.push({
        asset_id: asset.id,
        entry: naming.name,
        sha256: sha,
        db_sha256: dbSha,
        match: dbSha ? dbSha === sha : null,
        bytes: buf.length,
        verified: true, // đã băm lại từ CHÍNH byte đọc trên đĩa trong lần xuất này
      });
      if (dbSha && dbSha !== sha) {
        extraWarnings.push(
          `sha256 của ảnh gốc ${asset.id} trên đĩa KHÁC giá trị đã lưu trong DB (đĩa ${sha.slice(0, 12)}… ≠ DB ${dbSha.slice(0, 12)}…) — gói ghi cả hai để đối chiếu; file trên đĩa KHÔNG bị sửa.`,
        );
      }
    } else if (Number.isFinite(Number(asset.bytes)) && Number(asset.bytes) !== buf.length) {
      extraWarnings.push(`Asset ${asset.id}: kích thước trên đĩa (${buf.length} byte) khác kích thước đã lưu trong DB (${asset.bytes} byte).`);
    }

    addEntry(naming.name, buf, `đĩa: ${group}`);
  }

  /* ── 5. Bằng chứng: usage + extraction_evidence ─────────────────────── */
  const usageEvents = usage.map(redactUsageRow);
  addEntry(
    'bang-chung/usage.json',
    `${JSON.stringify(
      {
        job_id: job.id,
        count: usageEvents.length,
        note: 'Bản ghi `usage_events` NGUYÊN BẢN của job (đã lược bỏ `session_id` khi xuất gói). `totals` do tính năng xuất gói cộng lại từ chính các dòng này.',
        totals: usageTotals(usageEvents),
        events: usageEvents,
      },
      null,
      2,
    )}\n`,
    'store: usage_events',
  );
  addEntry(
    'bang-chung/evidence.json',
    `${JSON.stringify(
      {
        job_id: job.id,
        count: evidence.length,
        note: '`extraction_evidence` NGUYÊN BẢN (mới nhất trước, tối đa 5 bản ghi như store trả) + `job_evidence` là bản tổng hợp đã lưu trên job (jobs.evidence).',
        extraction_evidence: evidence,
        job_evidence: job.evidence ?? null,
      },
      null,
      2,
    )}\n`,
    'store: extraction_evidence + jobs.evidence',
  );

  /* ── 6. Bản dễ đọc cho người: chèn NGAY SAU file .json ──────────────── */
  // Cảnh báo mức job đã gộp đủ (gồm cảnh báo phát sinh khi đọc đĩa) TRƯỚC khi in phần
  // "nói thật" ở cuối file .txt — bản .txt không được phép đẹp hơn MANIFEST.json.
  // D1: MỘT nguồn sự thật cho các bước mock — dùng cho cả bản .txt lẫn MANIFEST.json.
  // R1 (phản biện vòng 2, LOW): truyền cả `evidence` để `mockStepsFor` đối chiếu được với CHÍNH
  // `providers` mà bản kê khai in ra (không bao giờ có `is_mock=true` mà `mock_steps` rỗng).
  const mockStepsAll = orderMockSteps(new Set([
    ...mockStepsFor(job, assets, usage, evidence),
    ...mockStepsFromAssets(assets),
  ]));
  const warningsSoFar = collectJobWarnings(job, assets, evidence, extraWarnings);
  if (payload !== null) {
    const humanText = renderHumanText({
      job,
      content: payload.forText,
      lines,
      regions,
      warnings: warningsSoFar,
      // D1 (phản biện, HIGH): bản .txt phải kể CÙNG tập bước mock với MANIFEST.json — trước đây chỉ
      // lấy từ meta asset nên job MVP-01/02 (dấu vết ở `content_meta`/`usage_events`) in ra bản
      // "sạch" không một dòng cảnh báo, tức bản dễ đọc ĐẸP HƠN sự thật.
      mockSteps: mockStepsAll,
      hasVideo: assets.some((a) => classifyAsset(a) === ASSET_GROUPS.VIDEO),
    });
    if (humanText) {
      addEntry('noi-dung/noi-dung.txt', humanText, 'sinh từ dữ liệu đã lưu của job', 1);
    } else {
      missing.push('noi-dung/noi-dung.txt — dữ liệu đã lưu không có trường văn bản nào để in cho người đọc (file .json vẫn có).');
    }
  }

  /* ── 7. MANIFEST.json (dựng SAU cùng để biết chính xác gói có gì) ───── */
  const filename = bundleFilename(job, date);
  const manifest = manifestFor({
    job,
    assets,
    lines,
    usage,
    evidence,
    extra: {
      // D6: `entries` phải kể cả chính `MANIFEST.json` (file luôn có trong gói) — trước đây thiếu
      // nên bản kê khai không khớp danh sách entry thật của ZIP.
      entries: ['MANIFEST.json', ...payloadEntries.map((e) => e.name)],
      // `files` phải cùng độ dài với `entries` (D6) — bản thân MANIFEST.json không thể tự băm
      // chính nó, nên ghi `sha256: null` kèm lý do thay vì bịa một giá trị.
      files: [
        { path: 'MANIFEST.json', bytes: null, sha256: null, source: 'tự sinh khi đóng gói (không tự băm chính nó)' },
        ...files,
      ],
      original_sha256: originalSha256,
      warnings: extraWarnings,
      missing,
      regions,
      filename,
      generated_at: generatedAt,
      // D1: cùng tập mock đã dùng cho `noi-dung.txt` (khử trùng ở `manifestFor`).
      mock_steps: mockStepsAll,
    },
  });

  // Mọi entry đều là Buffer TRƯỚC khi vào ZIP: nhờ vậy bước tự kiểm so sánh được
  // `data.length` (BYTE) với `size` mà header khai — chuỗi tiếng Việt có số ký tự khác
  // số byte nên so bằng `.length` của chuỗi sẽ báo sai.
  const entryNames = ['MANIFEST.json', ...payloadEntries.map((e) => e.name)];
  const zipEntries = [
    { name: 'MANIFEST.json', data: toBuffer(`${JSON.stringify(manifest, null, 2)}\n`, 'MANIFEST.json') },
    ...payloadEntries,
  ];

  if (zip === false) {
    // D5: đường CHỈ-MANIFEST — không gọi `createZip`, không giữ buffer nén.
    logger?.info?.('exports.manifest_built', {
      job_id: id,
      kind: job.kind || 'content',
      entries: entryNames.length,
      assets: assets.length,
      missing: manifest.missing.length,
      warnings: manifest.warnings.length,
      mock_steps: manifest.mock_steps.length,
    });
    return {
      buffer: null,
      zipped: false,
      filename,
      bytes: null,
      entries: entryNames,
      manifest,
      warnings: manifest.warnings,
      missing: manifest.missing,
      generated_at: generatedAt,
    };
  }

  /* ── 8. Ghi ZIP + TỰ KIỂM bằng bộ đọc độc lập ───────────────────────── */
  const buffer = createZip({ entries: zipEntries, date });
  let verified = false;
  if (verify) {
    const check = inspectZip(buffer);
    const expected = zipEntries.map((e) => e.name);
    const namesOk = check.entries.length === expected.length && check.entries.every((e, i) => e.name === expected[i]);
    const crcOk = check.entries.every((e, i) => e.crc32 === crc32(zipEntries[i].data) && e.size === zipEntries[i].data.length);
    if (!check.valid || !namesOk || !crcOk) {
      throw new ExportError(
        EXPORT_CODES.ZIP_SELF_CHECK_FAILED,
        `ZIP vừa ghi không qua được bộ đọc độc lập: ${check.errors.join(' · ') || 'danh sách entry/CRC không khớp'}`,
        { jobId: id, errors: check.errors, entries: check.entries.length, expected: expected.length },
      );
    }
    verified = true;
  }

  logger?.info?.('exports.bundle_built', {
    job_id: id,
    kind: job.kind || 'content',
    entries: zipEntries.length,
    bytes: buffer.length,
    assets: assets.length,
    missing: manifest.missing.length,
    warnings: manifest.warnings.length,
    mock_steps: manifest.mock_steps.length,
    verified,
  });

  return {
    buffer,
    filename,
    bytes: buffer.length,
    entries: zipEntries.map((e) => e.name),
    manifest,
    warnings: manifest.warnings,
    missing: manifest.missing,
    files,
    verified,
  };
}

export default buildExportBundle;
