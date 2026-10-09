/**
 * TEST MVP-06 · X1 — MANIFEST TỰ KHAI + ĐÓNG GÓI (`src/exports/manifest.js`, `bundle.js`).
 *
 * Ba luật §0 của hợp đồng được kiểm bằng HÀNH VI THẬT (store SQLite in-memory + file asset
 * thật trên đĩa trong thư mục tạm):
 *   1. Gói tự khai: providers / mock_steps / verification / warnings / missing / audio.
 *      KHÔNG BAO GIỜ có `LIVE_VERIFIED` nếu chưa chứng minh đã gọi dịch vụ thật; cảnh báo
 *      của job KHÔNG bị giấu.
 *   2. Không bịa nội dung: job rỗng vẫn ra gói hợp lệ, `missing[]` nói rõ TỪNG mục, KHÔNG
 *      tạo file rỗng giả/placeholder.
 *   3. Ảnh gốc bất biến: sha256 của MỌI file trên đĩa trước/sau khi xuất y hệt; không file mới.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { createStore } from '../src/store/index.js';
import { createImageStorage } from '../src/imagelab/storage.js';
import {
  buildExportBundle,
  bundleFilename,
  collectJobWarnings,
  crc32,
  ExportError,
  inspectZip,
  manifestFor,
  sanitizeFilename,
  verificationFor,
} from '../src/exports/index.js';
import { imagelabConfig } from './imagelab-helpers.js';
import { silent } from './helpers.js';
import {
  readZipEntries,
  seedJob,
  sha256Hex,
  snapshotTree,
  tinyPng,
  zipJson,
} from './export-helpers.js';

const SID = 'exportBundleSessionAAA1';
const WARNING_1 = 'CẢNH BÁO THẬT: OCR đọc thiếu chữ ở vùng giá';
const WARNING_2 = 'CẢNH BÁO THẬT: ảnh gốc mờ, chữ nhỏ khó đọc';

/** Nội dung MVP-01 đã lưu — đủ trường để `noi-dung.txt` in ra nhiều mục. */
const CONTENT = {
  product_name: 'Tai nghe chụp tai X1',
  headline: 'Tai nghe chụp tai giảm giá sốc',
  short_description: 'Mô tả ngắn có dấu tiếng Việt.',
  selling_points: ['Điểm bán 1', 'Điểm bán 2'],
  detailed_description: 'Mô tả chi tiết.',
  facebook_caption: 'Caption Facebook',
  tiktok_caption: 'Caption TikTok',
  marketplace_description: 'Mô tả sàn TMĐT',
  hashtags: ['#tainghe', '#giare'],
  seo: { title: 'SEO', meta_description: 'Meta', keywords: ['tai nghe'] },
};

const LINE = (i) => ({
  region_id: `r-${i}`,
  text_original: `原文 ${i}`,
  text_vi: `Bản dịch ${i}`,
  status: 'translated',
  confidence: 0.9,
  provenance: 'mock-translator',
  edited_by_user: false,
  violations: [],
  notes: '',
});

describe('MVP-06 · manifest tự khai + bất biến asset', () => {
  let ctx;
  let full;
  let dir;

  before(async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const storage = createImageStorage(config, { logger: silent });
    ctx = { config, store, storage };
    dir = config.imagelab.dir;

    full = await seedJob(ctx, {
      sid: SID,
      kind: 'image_translation',
      productName: 'Tai nghe chụp tai X1',
      content: CONTENT,
      contentMeta: {
        imagelab: {
          mock_steps: ['ocr', 'translate'],
          warnings: [WARNING_1],
          ocr: { provider: 'mock', model: 'mock-ocr-1', is_mock: true },
          translate: { provider: 'mock', model: 'mock-translate-1', is_mock: true },
          render: { provider: 'purejs', model: 'purejs-1', is_mock: false },
        },
      },
      evidence: { verification: 'MOCK_VERIFIED', warnings: [WARNING_2] },
      originals: 1,
      rendered: 1,
      videos: 1,
      lines: [LINE(1), LINE(2), LINE(3)],
      regions: [
        { region_key: 'r-1', kind: 'price', text: '12.5', translatable: true, lang: 'zh-Hans', box: { x: 1, y: 2, w: 3, h: 4 } },
      ],
      usage: [
        { operation: 'OCR_DETECT', provider: 'mock', model: 'mock-ocr-1', inputUnits: 100, outputUnits: 1, estimatedCost: 0.0001, meta: { is_mock: true } },
        { operation: 'TRANSLATION', provider: 'mock', model: 'mock-translate-1', inputUnits: 3, outputUnits: 3, estimatedCost: 0.0002, meta: { is_mock: true } },
      ],
      evidenceRows: [
        { connector: '1688', extractionMethod: 'html-inline-json', verification: 'MOCK_VERIFIED', httpStatus: 200, bytes: 1234, visionProvider: 'mock', contentProvider: 'mock' },
      ],
    });
  });

  test('gói job ĐỦ THỨ: đúng cấu trúc entry + ZIP tự kiểm + nội dung đọc lại khớp', async () => {
    const before = snapshotTree(dir);
    const bundle = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: full.jobId, now: new Date('2026-10-07T10:20:30Z') });

    assert.deepEqual(bundle.entries, [
      'MANIFEST.json',
      'noi-dung/noi-dung.json',
      'noi-dung/noi-dung.txt',
      'anh/anh-goc-1.png',
      'anh/anh-tao-1.png',
      'video/video-1.gif',
      'bang-chung/usage.json',
      'bang-chung/evidence.json',
    ]);
    assert.equal(bundle.verified, true, 'gói phải qua được bộ đọc độc lập inspectZip');
    assert.equal(bundle.bytes, bundle.buffer.length);
    assert.match(bundle.filename, /^[A-Za-z0-9._-]+\.zip$/);

    const check = inspectZip(bundle.buffer);
    assert.equal(check.valid, true, check.errors.join(' · '));
    assert.deepEqual(check.entries.map((e) => e.name), bundle.entries);
    for (const entry of check.entries) {
      assert.equal(entry.crc32, crc32(readZipEntries(bundle.buffer).get(entry.name).data), `CRC32 của ${entry.name}`);
    }

    // Nội dung từng file PHẢI là dữ liệu đã lưu, không phải bản viết lại.
    const zip = readZipEntries(bundle.buffer);
    assert.deepEqual(zipJson(zip, 'MANIFEST.json'), JSON.parse(JSON.stringify(bundle.manifest)));
    assert.deepEqual(zipJson(zip, 'noi-dung/noi-dung.json'), CONTENT);
    const txt = zip.get('noi-dung/noi-dung.txt').data.toString('utf8');
    assert.match(txt, /Tai nghe chụp tai giảm giá sốc/);
    assert.match(txt, /Bản dịch 1/);
    assert.match(txt, /Bản dịch 3/);
    assert.match(txt, /KHÔNG có tiếng/, 'file cho người đọc phải nói thật chuyện video không tiếng');
    assert.match(txt, /provider GIẢ/, 'file cho người đọc phải nói thật các bước chạy mock');
    assert.equal(zipJson(zip, 'bang-chung/usage.json').count, 2);
    assert.equal(zipJson(zip, 'bang-chung/evidence.json').count, 1);

    // Gói chỉ chứa byte đã đọc — KHÔNG kèm session_id của người dùng.
    assert.ok(!bundle.buffer.includes(Buffer.from(SID, 'utf8')), 'gói KHÔNG được chứa session_id');
    const usage = zipJson(zip, 'bang-chung/usage.json');
    assert.ok(usage.events.every((e) => !('session_id' in e)), 'usage.json phải lược session_id');

    // Bất biến: KHÔNG file nào trên đĩa bị sửa/không file mới nào được tạo.
    assert.deepEqual(snapshotTree(dir), before, 'xuất gói không được sửa/tạo file trên đĩa');
  });

  test('manifest có ĐỦ mục hợp đồng §2 và số liệu khớp dữ liệu đã lưu', async () => {
    const bundle = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: full.jobId, now: new Date('2026-10-07T10:20:30Z') });
    const m = bundle.manifest;

    for (const key of ['generated_at', 'job', 'providers', 'mock_steps', 'verification', 'audio', 'counts', 'warnings', 'missing', 'original_sha256', 'entries', 'files', 'tool']) {
      assert.ok(key in m, `manifest thiếu mục bắt buộc "${key}"`);
    }
    assert.deepEqual(
      { id: m.job.id, kind: m.job.kind, status: m.job.status },
      { id: full.jobId, kind: 'image_translation', status: 'succeeded' },
    );
    assert.ok(m.job.created_at, 'job.created_at phải có thật từ store');
    assert.equal(m.generated_at, '2026-10-07T10:20:30.000Z');
    assert.equal(m.tool.name.includes('Gói xuất bản'), true);

    // mock_steps đọc từ meta asset (ảnh render mock + encoder video mock).
    // ⚠️ Hai nguồn còn lại của hợp đồng (`content_meta.imagelab.mock_steps`, `usage_events`)
    // đang BỊ BỎ QUA — xem test "TODO(mã nguồn sai)" ở dưới.
    for (const step of ['render', 'video_encode']) {
      assert.ok(m.mock_steps.includes(step), `mock_steps phải có "${step}", nhận ${JSON.stringify(m.mock_steps)}`);
    }
    // providers: chỉ dấu vết ĐÃ LƯU, không suy từ cấu hình đang chạy.
    assert.equal(m.providers.imagelab.ocr.name, 'mock');
    assert.equal(m.providers.imagelab.ocr.is_mock, true);
    assert.equal(m.providers.imagelab.render.name, 'purejs');
    assert.equal(m.providers.extraction.http_status, 200);
    assert.ok(m.providers.usage.some((u) => u.operation === 'OCR_DETECT' && u.events === 1));

    assert.deepEqual(
      m.counts,
      { assets: 3, images: 1, videos: 1, lines: 3, usage: 2 },
      'counts đếm theo DỮ LIỆU ĐÃ LƯU (assets/images/videos/lines/usage)',
    );
    assert.equal(m.verification, 'MOCK_VERIFIED');
    assert.equal(m.verification_detail.live_service_called, false, 'job này chưa hề gọi dịch vụ thật');
    assert.equal(m.audio, null);
    assert.equal(m.no_audio, true);
    assert.match(m.audio_note, /KHÔNG có tiếng/);
    // D6 (phản biện Gói xuất bản, LOW): `entries` phải KỂ CẢ `MANIFEST.json` (file luôn có trong
    // gói) — trước đây thiếu nên bản kê khai không khớp danh sách entry thật của ZIP.
    assert.deepEqual(m.entries, bundle.entries, 'manifest.entries = danh sách entry THẬT trong ZIP (kể cả MANIFEST.json)');
    assert.ok(m.entries.includes('MANIFEST.json'), 'phải kể chính MANIFEST.json');
    assert.equal(m.files.length, m.entries.length, 'files kê ĐỦ file trong gói (kể cả MANIFEST.json)');
    assert.deepEqual(bundle.warnings, m.warnings, 'warnings trả về phải là MỘT nguồn với manifest');
    assert.deepEqual(bundle.missing, m.missing);

    // Job đầy đủ ⇒ KHÔNG thiếu mục nào.
    assert.deepEqual(m.missing, [], `job đủ thứ không được khai thiếu: ${m.missing.join(' · ')}`);
    assert.equal(JSON.parse(JSON.stringify(m)).job.id, full.jobId, 'manifest phải JSON.stringify được ngay');
  });

  /* ── MÃ NGUỒN SAI (đã báo cáo, KHÔNG tự sửa `src/**`) ─────────────────────────────
   * Hợp đồng §0.1: "MANIFEST.json ghi rõ: **mọi bước dùng provider giả** (`mock_steps`)".
   * `src/exports/manifest.js` mô tả `mockStepsFor(job, assets, usage)` gom từ content_meta
   * (`imagelab.mock_steps`), từ meta asset VÀ từ `usage_events.meta.is_mock` (dòng 208-235),
   * nhưng `manifestFor()` (dòng 370) chỉ dùng `mockStepsFromAssets(assetList)` —
   * `mockStepsFor` không được gọi ở đâu, và `bundle.js` cũng KHÔNG truyền `extra.mock_steps`.
   *
   * Hệ quả THẬT: job MVP-02 chạy OCR + dịch bằng provider giả (dấu vết nằm ở
   * `content_meta.imagelab.mock_steps` + `usage_events.meta.is_mock`, còn meta ảnh render chỉ
   * có `is_mock` của bước render) ⇒ MANIFEST.json chỉ khai `render`, giấu `ocr`/`translate`.
   * API `/api/exports/jobs/:id/manifest` dùng CHÍNH manifest này nên UI cũng in
   * "Máy chủ khai KHÔNG có bước nào dùng dữ liệu giả" khi danh sách rỗng.
   *
   * Test này khẳng định HÀNH VI ĐÚNG (theo hợp đồng) nên ĐANG ĐỎ. Đánh dấu `todo` để bộ test
   * vẫn 0 fail; khi `src/exports/**` được sửa, nó chuyển thành pass.
   */
  test('MANIFEST.json kể ĐỦ bước mock từ content_meta + usage_events', async () => {
      const seeded = await seedJob(ctx, {
        sid: SID,
        kind: 'image_translation',
        content: CONTENT,
        // Dấu vết mock CHỈ nằm ở content_meta + usage_events (đúng như pipeline MVP-02 ghi).
        contentMeta: { imagelab: { mock_steps: ['ocr', 'translate'] } },
        originals: 1,
        rendered: 1,
        renderedMock: false,
        usage: [
          { operation: 'OCR_DETECT', provider: 'mock', model: 'mock-ocr', meta: { is_mock: true } },
          { operation: 'TRANSLATION', provider: 'mock', model: 'mock-translate', meta: { is_mock: true } },
          { operation: 'IMAGE_RENDER', provider: 'purejs', model: 'purejs-1', meta: { is_mock: false } },
        ],
        id: '00000000-0000-4000-8000-0000000000ab',
      });
      const bundle = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: seeded.jobId });
      assert.deepEqual(
        bundle.manifest.mock_steps,
        ['ocr', 'translate'],
        `MANIFEST.json phải khai ĐỦ bước chạy provider giả, nhận ${JSON.stringify(bundle.manifest.mock_steps)}`,
      );
      // Bản kê khai nằm TRONG gói cũng phải nói thật (một nguồn sự thật).
      const zip = readZipEntries(bundle.buffer);
      assert.deepEqual(zipJson(zip, 'MANIFEST.json').mock_steps, ['ocr', 'translate']);

      // Kịch bản PHỔ BIẾN NHẤT của chế độ offline: MVP-01 sinh nội dung bằng provider GIẢ.
      const mvp01 = await seedJob(ctx, {
        sid: SID,
        kind: 'content',
        content: CONTENT,
        contentMeta: { provider: 'mock', model: 'mock-1', is_mock: true },
        originals: 0,
        usage: [{ operation: 'CONTENT_GENERATE', provider: 'mock', model: 'mock-1', meta: { is_mock: true } }],
        id: '00000000-0000-4000-8000-0000000000ac',
      });
      const mvp01Bundle = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: mvp01.jobId });
      assert.deepEqual(
        mvp01Bundle.manifest.mock_steps,
        ['content'],
        `job MVP-01 có content_meta.is_mock=true phải khai bước "content", nhận ${JSON.stringify(mvp01Bundle.manifest.mock_steps)}`,
      );
    });

  test('providers.usage[].is_mock phải đúng với chính dòng usage nó chứa', async () => {
      const seeded = await seedJob(ctx, {
        sid: SID,
        kind: 'content',
        content: CONTENT,
        usage: [{ operation: 'CONTENT_GENERATE', provider: 'mock', model: 'mock-1' }],
        id: '00000000-0000-4000-8000-0000000000ad',
      });
      const bundle = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: seeded.jobId });
      const row = bundle.manifest.providers.usage.find((u) => u.operation === 'CONTENT_GENERATE');
      assert.equal(row.provider, 'mock');
      assert.equal(row.is_mock, true, 'dòng usage có provider "mock" KHÔNG được khai is_mock: false');
    });

  test('cảnh báo của job KHÔNG bị giấu (content_meta + meta asset + evidence)', async () => {
    const seeded = await seedJob(ctx, {
      sid: SID,
      kind: 'image_generation',
      content: CONTENT,
      contentMeta: { imagestudio: { warnings: [WARNING_1], failures: [{ code: 'RETOUCH_SKIPPED', message: 'bỏ qua retouch' }] } },
      evidence: { warnings: [WARNING_2] },
      originals: 1,
      rendered: 1,
      assetWarnings: ['CẢNH BÁO THẬT: asset bị cắt viền'],
      usage: [{ operation: 'IMAGE_RENDER', provider: 'purejs', model: 'purejs-1', meta: { is_mock: false } }],
      evidenceRows: [{ connector: '1688', extractionMethod: 'html-inline-json', verification: 'MANUAL_INPUT', blockedReason: 'nguồn chặn bot', httpStatus: 403 }],
    });
    const bundle = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: seeded.jobId });
    const all = bundle.manifest.warnings.join('\n');
    assert.ok(all.includes(WARNING_1), 'cảnh báo trong content_meta phải có trong manifest');
    assert.ok(all.includes(WARNING_2), 'cảnh báo trong job.evidence phải có trong manifest');
    assert.ok(all.includes('CẢNH BÁO THẬT: asset bị cắt viền'), 'cảnh báo trong meta asset phải có trong manifest');
    assert.ok(all.includes('RETOUCH_SKIPPED'), 'thất bại từng bước phải được kê');
    assert.ok(all.includes('nguồn chặn bot'), 'lý do nguồn bị chặn phải được kê');

    // Bản .txt KHÔNG được "đẹp hơn" manifest: phải nói số cảnh báo.
    const zip = readZipEntries(bundle.buffer);
    const txt = zip.get('noi-dung/noi-dung.txt').data.toString('utf8');
    assert.match(txt, new RegExp(`Job có ${bundle.manifest.warnings.length} cảnh báo`));
  });
});

/* ═══════════════════════ job RỖNG — không bịa nội dung ═══════════════════════ */

describe('MVP-06 · job RỖNG ⇒ gói hợp lệ + missing nói rõ TỪNG mục', () => {
  let ctx;
  let empty;
  let dir;

  before(async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const storage = createImageStorage(config, { logger: silent });
    ctx = { config, store, storage };
    dir = config.imagelab.dir;
    empty = await seedJob(ctx, { sid: SID, kind: 'content', content: null, originals: 0 });
  });

  test('không có file giả: chỉ MANIFEST.json + 2 file bằng chứng (đều có nội dung thật)', async () => {
    const before = snapshotTree(dir);
    const bundle = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: empty.jobId });
    assert.deepEqual(bundle.entries, ['MANIFEST.json', 'bang-chung/usage.json', 'bang-chung/evidence.json']);
    assert.equal(bundle.verified, true);
    const check = inspectZip(bundle.buffer);
    assert.equal(check.valid, true, check.errors.join(' · '));
    assert.ok(check.entries.every((e) => e.size > 0), 'KHÔNG được tạo file rỗng giả (0 byte)');
    assert.deepEqual(snapshotTree(dir), before, 'job rỗng cũng không được ghi gì lên đĩa');
  });

  test('missing[] nói rõ TỪNG mục còn thiếu (không được rỗng, không câu chung chung)', async () => {
    const bundle = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: empty.jobId });
    const missing = bundle.missing;
    assert.ok(missing.length >= 5, `missing phải kể từng mục, nhận ${JSON.stringify(missing)}`);
    for (const needle of ['noi-dung/', 'anh/', 'anh/anh-goc-*', 'bang-chung/usage.json', 'bang-chung/evidence.json', 'video/']) {
      assert.ok(missing.some((m) => m.includes(needle)), `missing phải có mục "${needle}", nhận ${JSON.stringify(missing)}`);
    }
    assert.deepEqual(bundle.manifest.missing, missing);
    assert.ok(!bundle.entries.some((e) => /^(noi-dung|anh|video)\//.test(e)), 'không được có entry giả cho phần thiếu');
  });

  test('job tạo ảnh chưa có ảnh nào ⇒ nói thẳng "chưa có asset rendered"', async () => {
    const seeded = await seedJob(ctx, { sid: SID, kind: 'image_generation', originals: 1, rendered: 0, id: null });
    const bundle = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: seeded.jobId });
    assert.ok(bundle.missing.some((m) => m.includes('anh/anh-tao-*.png')), bundle.missing.join(' · '));
    assert.ok(bundle.entries.includes('anh/anh-goc-1.png'), 'ảnh gốc vẫn phải vào gói');
  });
});

/* ═══════════════════ nhãn kiểm chứng + filename làm sạch ═══════════════════ */

describe('MVP-06 · nhãn kiểm chứng — KHÔNG BAO GIỜ LIVE_VERIFIED khi chưa gọi dịch vụ thật', () => {
  test('dấu vết ghi LIVE_VERIFIED nhưng transport KHÔNG phải http ⇒ gói KHÔNG giữ nhãn', () => {
    const job = { id: 'j1', kind: 'content', product_master: { extraction: { transport: 'html-inline-json' } } };
    const { label, detail } = verificationFor(job, [{ verification: 'LIVE_VERIFIED', extraction_method: 'html-inline-json', http_status: 200 }], []);
    assert.equal(label, null, 'thiếu căn cứ gọi dịch vụ thật ⇒ phải bỏ nhãn LIVE');
    assert.equal(detail.live_service_called, false);
    assert.equal(detail.recorded_level, 'LIVE_VERIFIED');
    assert.ok(detail.notes.some((n) => n.includes('KHÔNG đủ căn cứ')), detail.notes.join(' · '));

    // Các transport KHÁC http mà hệ thống thật có thể ghi (fixture, fetcher giả, không tải được).
    for (const transport of ['unknown', 'none', 'mock', 'fixture', 'manual']) {
      const other = verificationFor({ id: 'j1b', kind: 'content', product_master: { extraction: { transport } } }, [{ verification: 'LIVE_VERIFIED' }], []);
      assert.equal(other.label, null, `transport=${transport} KHÔNG được giữ nhãn LIVE_VERIFIED`);
    }
  });

  /* ── MÃ NGUỒN SAI (đã báo cáo, KHÔNG tự sửa `src/**`) ─────────────────────────────
   * Hợp đồng §0.1 + chính `src/exports/manifest.js` (dòng 17-19): "chỉ giữ LIVE_VERIFIED /
   * AUTHENTICATED_LIVE_VERIFIED khi dấu vết đã lưu CHỨNG MINH lần trích xuất đi bằng
   * transport `http`. Nghi ngờ ⇒ trả `null`". Cổng chuẩn của repo cũng vậy:
   * `src/jobs/pipeline.js:48` — `if (transport !== 'http') return 'MOCK_VERIFIED'`, kể cả khi
   * transport THIẾU (`ex.transport || 'unknown'`).
   *
   * Nhưng `verificationFor()` (manifest.js:261) chỉ bỏ nhãn khi
   * `transport !== null && transport !== 'http'` ⇒ khi dấu vết KHÔNG có transport (job không
   * lưu `product_master`, hoặc nhãn đến từ `jobs.evidence`) thì gói vẫn khẳng định
   * `AUTHENTICATED_LIVE_VERIFIED` — đúng kiểu "gói đẹp" mà luật §0.1 cấm (fail-open).
   */
  test('thiếu hẳn transport ⇒ KHÔNG được khẳng định LIVE_VERIFIED', () => {
      const noTransport = verificationFor({ id: 'j2', kind: 'content' }, [{ verification: 'AUTHENTICATED_LIVE_VERIFIED' }], []);
      assert.equal(noTransport.label, null, `thiếu transport ⇒ phải bỏ nhãn, nhận ${JSON.stringify(noTransport.label)}`);
      assert.equal(noTransport.detail.live_service_called, false);

      const fromJobEvidence = verificationFor({ id: 'j2b', kind: 'content', evidence: { verification: 'LIVE_VERIFIED' } }, [], []);
      assert.equal(fromJobEvidence.label, null, 'nhãn đến từ jobs.evidence mà không có transport cũng phải bị bỏ');
    });

  test('transport = http ⇒ giữ nhãn, nhưng vẫn cảnh báo nếu có bước chạy mock', () => {
    const job = { id: 'j3', kind: 'content', product_master: { extraction: { transport: 'http' } } };
    const live = verificationFor(job, [{ verification: 'LIVE_VERIFIED', extraction_method: 'http-fetch', http_status: 200 }], []);
    assert.equal(live.label, 'LIVE_VERIFIED');
    assert.equal(live.detail.live_service_called, true);

    const withMock = verificationFor(job, [{ verification: 'LIVE_VERIFIED' }], ['content', 'render']);
    assert.equal(withMock.label, 'LIVE_VERIFIED');
    assert.equal(withMock.detail.contains_mock, true);
    assert.ok(withMock.detail.notes.some((n) => n.includes('provider GIẢ')), withMock.detail.notes.join(' · '));
  });

  test('gói của job MOCK không chứa chuỗi LIVE_VERIFIED ở bất kỳ đâu', async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const storage = createImageStorage(config, { logger: silent });
    const seeded = await seedJob({ store, storage }, {
      sid: SID,
      kind: 'image_translation',
      content: CONTENT,
      evidence: { verification: 'MOCK_VERIFIED' },
      rendered: 1,
      usage: [{ operation: 'CONTENT_GENERATE', provider: 'mock', model: 'mock-1', meta: { is_mock: true } }],
      evidenceRows: [{ connector: '1688', extractionMethod: 'html-inline-json', verification: 'MOCK_VERIFIED' }],
    });
    const bundle = await buildExportBundle({ store, storage, jobId: seeded.jobId });
    assert.ok(!bundle.buffer.includes(Buffer.from('LIVE_VERIFIED', 'utf8')), 'gói mock KHÔNG được chứa nhãn LIVE_VERIFIED');
    assert.equal(bundle.manifest.verification, 'MOCK_VERIFIED');
  });

  test('job chưa ghi bằng chứng ⇒ verification = null + nói rõ lý do (không im lặng)', () => {
    const { label, detail } = verificationFor({ id: 'j4', kind: 'content' }, [], []);
    assert.equal(label, null);
    assert.equal(detail.source, 'none');
    assert.ok(detail.notes.some((n) => n.includes('chưa ghi bằng chứng')));
  });
});

describe('MVP-06 · filename tải về đã được LÀM SẠCH ký tự lạ', () => {
  const AT = new Date('2026-10-07T10:20:30Z');

  test('tên chuẩn: <kind>-<jobId ngắn>-<YYYYMMDD-HHmm>.zip', () => {
    const name = bundleFilename({ kind: 'video_generation', id: 'abcdef12-3456-7890-abcd-ef1234567890' }, AT);
    assert.match(name, /^video_generation-abcdef12-\d{8}-\d{4}\.zip$/);
    // Job không có id ⇒ vẫn ra tên file dùng được (id dự phòng bị cắt còn 8 ký tự).
    assert.match(bundleFilename({ kind: 'content', id: null }, AT), /^content-khong-ro-\d{8}-\d{4}\.zip$/);
  });

  test('jobId/kind chứa ký tự lạ (path traversal, thẻ HTML) ⇒ tên file an toàn', () => {
    const hostile = bundleFilename({ kind: '../../<script>alert(1)</script> ảnh', id: '../../etc/passwd' }, AT);
    assert.match(hostile, /^[A-Za-z0-9._-]+\.zip$/, `tên file phải chỉ còn ký tự an toàn, nhận ${hostile}`);
    assert.ok(!hostile.includes('/') && !hostile.includes('\\') && !hostile.includes('<') && !hostile.includes('..'), hostile);
    assert.equal(sanitizeFilename('CON'), '_CON');
    assert.equal(sanitizeFilename('...'), 'goi-xuat-ban');
    // 'Đ' không tách được bằng NFD nên đi qua nhánh /đ/gi (thay bằng 'd' THƯỜNG) — tên vẫn an toàn.
    assert.equal(sanitizeFilename('Đậm Đà — Nội Dung!'), 'dam-da-Noi-Dung');
    assert.match(sanitizeFilename('Đậm Đà — Nội Dung!'), /^[A-Za-z0-9._-]+$/);
  });

  test('gói thật dùng đúng tên file đã làm sạch và Content-Disposition lấy từ đó', async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const storage = createImageStorage(config, { logger: silent });
    const seeded = await seedJob({ store, storage }, { sid: SID, kind: 'image_generation', content: CONTENT, rendered: 1 });
    const bundle = await buildExportBundle({ store, storage, jobId: seeded.jobId, now: AT });
    assert.match(bundle.filename, /^image_generation-[A-Za-z0-9_-]{8}-\d{8}-\d{4}\.zip$/);
    assert.equal(bundle.manifest.filename, bundle.filename);
  });
});

/* ═══════════════════ lỗi đầu vào + manifestFor trực tiếp ═══════════════════ */

describe('MVP-06 · lỗi và đầu vào', () => {
  let ctx;
  let jobId;

  before(async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const storage = createImageStorage(config, { logger: silent });
    ctx = { config, store, storage };
    ({ jobId } = await seedJob(ctx, { sid: SID, kind: 'content', content: CONTENT }));
  });

  test('jobId rác ⇒ ExportError JOB_NOT_FOUND (không lộ đường dẫn đĩa)', async () => {
    const missingId = '00000000-0000-4000-8000-000000000000';
    await assert.rejects(
      buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: missingId }),
      (err) => {
        assert.ok(err instanceof ExportError, `phải là ExportError, nhận ${err?.name}`);
        assert.equal(err.code, 'JOB_NOT_FOUND');
        assert.ok(!err.message.includes(ctx.config.imagelab.dir), 'message lỗi KHÔNG được chứa đường dẫn đĩa');
        return true;
      },
    );
  });

  test('thiếu store/storage/jobId ⇒ BAD_INPUT', async () => {
    await assert.rejects(buildExportBundle({ storage: ctx.storage, jobId }), (e) => e.code === 'BAD_INPUT');
    await assert.rejects(buildExportBundle({ store: ctx.store, jobId }), (e) => e.code === 'BAD_INPUT');
    await assert.rejects(buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: '   ' }), (e) => e.code === 'BAD_INPUT');
  });

  test('manifestFor cần job đã hydrate; job rỗng vẫn ra manifest hợp lệ', () => {
    assert.throws(() => manifestFor({}), (e) => e instanceof ExportError && e.code === 'BAD_INPUT');
    const m = manifestFor({ job: { id: 'j9', kind: 'content', status: 'queued' } });
    assert.deepEqual(m.counts, { assets: 0, images: 0, videos: 0, lines: 0, usage: 0 });
    assert.deepEqual(m.entries, []);
    assert.ok(m.missing.length >= 3, 'job rỗng vẫn phải khai thiếu cái gì');
    assert.equal(m.verification, null);
  });

  test('asset có file MẤT trên đĩa ⇒ gói vẫn ra, missing + warning nói rõ (không bịa file)', async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const storage = createImageStorage(config, { logger: silent });
    const seeded = await seedJob({ store, storage }, { sid: SID, kind: 'image_translation', content: CONTENT, originals: 1, rendered: 1 });
    // Xoá file ảnh gốc trên đĩa (mô phỏng asset mồ côi) — KHÔNG đụng DB.
    const gone = seeded.assets.originals[0];
    const abs = path.join(config.imagelab.dir, gone.storage_path);
    const savedBytes = fs.readFileSync(abs);
    fs.rmSync(abs);
    const bundle = await buildExportBundle({ store, storage, jobId: seeded.jobId });
    assert.ok(!bundle.entries.includes('anh/anh-goc-1.png'), 'file mất thì KHÔNG được bịa entry');
    assert.ok(bundle.missing.some((m) => m.includes(gone.id) || m.includes('anh-goc')), bundle.missing.join(' · '));
    assert.ok(bundle.warnings.some((w) => w.includes(gone.id)), 'phải có cảnh báo nói rõ asset nào không đóng gói được');
    assert.equal(bundle.manifest.counts.assets, 2, 'counts vẫn đếm hàng trong DB (2 asset đã lưu)');
    assert.equal(inspectZip(bundle.buffer).valid, true);
    assert.ok(savedBytes.includes(0x89), 'ảnh gốc là PNG thật (dữ liệu test)');
  });

  test('collectJobWarnings gộp nhưng KHÔNG bỏ cảnh báo nào (chỉ khử trùng lặp)', () => {
    const out = collectJobWarnings(
      { content_meta: { error: 'hết quota', imagelab: { warnings: ['W1', 'W1', 'W2'] }, videostudio: { violations: ['V1'] } }, error_message: 'job đổ', error_code: 'X' },
      [{ meta: { warnings: ['W3'] } }],
      [{ blocked_reason: 'bị chặn' }],
    );
    assert.deepEqual(out, ['Sinh nội dung thất bại: hết quota', 'W1', 'W2', 'V1', 'Nguồn bị chặn khi trích xuất: bị chặn', 'Job kết thúc với lỗi (X): job đổ', 'W3']);
  });

  test('storage chỉ được ĐỌC: không gọi save/delete trong lúc xuất gói', async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const real = createImageStorage(config, { logger: silent });
    const calls = [];
    const spy = {
      read: async (asset) => {
        calls.push(['read', asset.id]);
        return real.read(asset);
      },
      save: async () => {
        calls.push(['save']);
        throw new Error('xuất gói KHÔNG được ghi file');
      },
      delete: async () => {
        calls.push(['delete']);
        throw new Error('xuất gói KHÔNG được xoá file');
      },
    };
    const seeded = await seedJob({ store, storage: real }, { sid: SID, kind: 'image_translation', content: CONTENT, originals: 2, rendered: 1 });
    const bundle = await buildExportBundle({ store, storage: spy, jobId: seeded.jobId });
    assert.deepEqual(calls.map((c) => c[0]), ['read', 'read', 'read'], 'chỉ được gọi read, đúng số asset');
    assert.equal(bundle.entries.filter((e) => e.startsWith('anh/anh-goc-')).length, 2);
    assert.equal(sha256Hex(tinyPng([200, 30, 40, 255])), seeded.assets.originals[0].sha256, 'ảnh gốc gieo vào phải khớp sha256 trong DB');
  });
});

/* ═══════════ D1/D5/D6 (vòng sửa phản biện) — gói tự khai, manifest rời, tên entry ═══════════ */

describe('MVP-06 · D1/D5/D6 — bản .txt nói thật, đường CHỈ-manifest, tên entry', () => {
  let ctx;
  before(async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const storage = createImageStorage(config, { logger: silent });
    ctx = { config, store, storage };
  });

  test('D1: job MVP-01 chạy provider GIẢ ⇒ `noi-dung.txt` PHẢI có dòng cảnh báo mock', async () => {
    const seeded = await seedJob(ctx, {
      sid: SID,
      kind: 'content',
      content: CONTENT,
      contentMeta: { provider: 'mock', model: 'mock-1', is_mock: true },
      usage: [{ operation: 'CONTENT_GENERATE', provider: 'mock', model: 'mock-1', meta: { is_mock: true } }],
      id: '00000000-0000-4000-8000-0000000000b1',
    });
    const bundle = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: seeded.jobId });
    assert.deepEqual(bundle.manifest.mock_steps, ['content'], 'manifest phải khai bước "content"');
    const zip = readZipEntries(bundle.buffer);
    const txt = zip.get('noi-dung/noi-dung.txt').data.toString('utf8');
    assert.match(txt, /provider GIẢ \(mock\): content/, 'bản .txt phải có CÙNG cảnh báo mock như manifest');
  });

  test('D5: `buildExportManifest` KHÔNG tạo ZIP và cho ra CÙNG bản kê khai', async () => {
    const seeded = await seedJob(ctx, {
      sid: SID,
      kind: 'content',
      content: CONTENT,
      originals: 1,
      rendered: 1,
      id: '00000000-0000-4000-8000-0000000000b2',
    });
    const mod = await import('../src/exports/index.js');
    assert.equal(typeof mod.buildExportManifest, 'function', 'X1 phải export `buildExportManifest`');

    const t0 = Date.now();
    const only = await mod.buildExportManifest({ store: ctx.store, storage: ctx.storage, jobId: seeded.jobId });
    const msManifest = Date.now() - t0;
    assert.equal(only.zipped, false, 'đường chỉ-manifest KHÔNG được nén ZIP');
    assert.equal(only.buffer, null, 'KHÔNG giữ buffer ZIP');
    assert.ok(only.entries.includes('MANIFEST.json'), 'entries có MANIFEST.json (D6)');

    const t1 = Date.now();
    const full = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: seeded.jobId });
    const msBundle = Date.now() - t1;
    assert.ok(Buffer.isBuffer(full.buffer) && full.buffer.length > 0, 'đường bundle vẫn tạo ZIP thật');

    const drop = ({ generated_at: _g, ...rest }) => rest;
    assert.deepEqual(drop(only.manifest), drop(full.manifest), 'hai đường phải là MỘT nguồn sự thật');
    assert.ok(msManifest <= msBundle + 50, `chỉ-manifest phải không chậm hơn bundle (${msManifest}ms vs ${msBundle}ms)`);
  });

  test('D6: `manifest.entries` kể cả MANIFEST.json và `files` cùng độ dài', async () => {
    const seeded = await seedJob(ctx, {
      sid: SID,
      kind: 'content',
      content: CONTENT,
      originals: 1,
      id: '00000000-0000-4000-8000-0000000000b3',
    });
    const bundle = await buildExportBundle({ store: ctx.store, storage: ctx.storage, jobId: seeded.jobId });
    assert.deepEqual(bundle.manifest.entries, bundle.entries, 'entries của manifest == entries thật của ZIP');
    assert.ok(bundle.manifest.entries.includes('MANIFEST.json'));
    assert.equal(bundle.manifest.files.length, bundle.manifest.entries.length);
    assert.equal(bundle.manifest.files[0].path, 'MANIFEST.json');
  });

  test('D6: `createZip` TỪ CHỐI tên entry chứa CR/LF (BAD_ENTRY_NAME)', async () => {
    const mod = await import('../src/exports/index.js');
    for (const bad of ['anh/x\r\ny.png', 'a\nb.txt', 'x\ry']) {
      assert.throws(
        () => mod.createZip({ entries: [{ name: bad, data: Buffer.from('x') }] }),
        (err) => err?.code === 'BAD_ENTRY_NAME',
        `tên ${JSON.stringify(bad)} phải bị từ chối với BAD_ENTRY_NAME`,
      );
    }
    assert.ok(mod.EXPORT_CODES.BAD_ENTRY_NAME, 'mã lỗi phải được khai trong EXPORT_CODES');
  });

  test('D6: thiếu `storage` ⇒ lỗi BAD_INPUT nói rõ storage (route map thành 503)', async () => {
    const seeded = await seedJob(ctx, {
      sid: SID,
      kind: 'content',
      content: CONTENT,
      id: '00000000-0000-4000-8000-0000000000b4',
    });
    await assert.rejects(
      () => buildExportBundle({ store: ctx.store, storage: null, jobId: seeded.jobId }),
      (err) => err?.code === 'BAD_INPUT' && /storage/i.test(String(err?.message ?? '')),
    );
  });
});
