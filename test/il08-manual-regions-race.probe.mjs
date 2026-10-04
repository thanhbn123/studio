/**
 * IL-08 — PROBE (chạy tay): OCR đang chạy thì lưu vùng nhập tay ⇒ vùng của NGƯỜI DÙNG
 * bị job OCR xoá im lặng.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÁCH CHẠY:  node test/il08-manual-regions-race.probe.mjs
 * HIỆN TRẠNG : ✅ XANH — đã vá ở vòng 6 (IL08-01), xem ghi chú ngay dưới.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ SỬA KHẲNG ĐỊNH 1 (vòng 6, agent gộp): bản gốc khẳng định "lưu vùng trong lúc OCR
 * đang chạy ⇒ 200" — đó ĐÚNG LÀ hành vi mà bản vá IL08-01 phải chặn (nếu cho ghi thì
 * `runOcr` xong sẽ xoá vùng người dùng). Luật mới (hợp đồng §11.2 luật 11):
 * job `queued`/`running` ⇒ **409 `IMAGELAB_JOB_RUNNING`**, KHÔNG ghi gì.
 * Probe vì vậy kiểm HAI tầng của bản vá:
 *   (a) lưu trong lúc OCR chạy  ⇒ bị TỪ CHỐI 409 + không có gì bị ghi;
 *   (b) sau khi OCR xong, lưu vùng tay rồi cho OCR chạy LẠI ⇒ KHÔNG bị ghi đè + có cảnh báo.
 * Tính chất gốc vẫn được chứng minh: vùng người dùng KHÔNG BAO GIỜ bị OCR xoá im lặng.
 *
 * Vì sao đây là `.probe.mjs` chứ KHÔNG phải `.test.js`: `npm test` chạy `test/*.test.js` và
 * bắt buộc phải XANH. Đây là bằng chứng ĐỎ cần một bản sửa trong `src/**` (agent gộp quyết
 * định), nên nó được tách ra để không làm đỏ bộ test chuẩn — chạy tay để thấy thất bại.
 *
 * LỖI: `ImageTranslationPipeline.setManualRegions` (IL-08) không hề phối hợp với job OCR
 * đang nằm trong hàng đợi/đang chạy. Kịch bản người dùng THẬT (UI luôn hiện khối "Nhập vùng
 * chữ bằng tay", kể cả khi job đang `queued`/`running`):
 *
 *   1. Người dùng dán ảnh → POST /jobs → job `running` ở bước OCR (mock/remote còn đang chạy);
 *   2. Người dùng điền vùng chữ bằng tay rồi bấm LƯU → PUT .../regions → 200, job
 *      `awaiting_review`, vùng `source = 'user'` nằm trong DB;
 *   3. Job OCR chạy xong → `saveOcrRegions(...)` XOÁ SẠCH vùng người dùng, ghi vùng OCR,
 *      và `content_meta.imagelab.manual_regions` biến mất.
 *
 * Hậu quả: mất dữ liệu người dùng KHÔNG một lời cảnh báo — vi phạm luật #4 của hợp đồng
 * ("Fail-closed, không fail-im lặng") và làm tính năng IL-08 vô dụng đúng lúc cần nhất
 * (OCR mock chạy rất nhanh nhưng OCR thật thì chậm, người dùng sẽ nhập tay trong lúc chờ).
 *
 * Hướng sửa gợi ý (agent gộp chọn MỘT):
 *   (a) `runOcr`: trước khi `saveOcrRegions`, đọc lại job; nếu `content_meta.imagelab.manual_regions
 *       === true` (hoặc job đã `awaiting_review` do nhập tay) ⇒ DỪNG, không ghi đè, ghi vết;
 *   (b) `setManualRegions`: từ chối khi job đang `queued`/`running` bằng 409 có mã riêng
 *       (ví dụ `IMAGELAB_JOB_RUNNING`) + câu tiếng Việt, UI hiện "chờ OCR xong hãy nhập tay";
 *   (c) hàng đợi: cho PUT vùng nhập tay đi CÙNG hàng đợi của job để hai bên không chồng nhau.
 *
 * Probe này TẤT ĐỊNH (không phải race về thời gian): OCR bị GIỮ ở một cổng promise do test
 * mở, nên thứ tự "lưu vùng tay trước, OCR ghi sau" là chắc chắn.
 */

import { createStore } from '../src/store/index.js';
import { createImageStorage } from '../src/imagelab/storage.js';
import { createTranslator } from '../src/imagelab/translate/index.js';
import { createRenderProvider } from '../src/imagelab/render/index.js';
import { ImageTranslationPipeline } from '../src/imagelab/pipeline.js';
import { cleanupTmp, headphones, imagelabConfig } from './imagelab-helpers.js';
import { silent } from './helpers.js';

const SID = 'il08RaceProbeSessionA1';

/** OCR giả bị GIỮ ở cổng cho tới khi test mở — để thứ tự là chắc chắn, không phụ thuộc may rủi. */
function gatedOcrProvider() {
  let release;
  let markStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  return {
    release,
    started,
    provider: {
      name: 'gated-ocr',
      model: 'gated-1',
      isMock: true,
      configured: true,
      async detect() {
        markStarted();
        await gate;
        return {
          status: 'OK',
          provider: 'gated-ocr',
          model: 'gated-1',
          is_mock: true,
          regions: [{ text: '品牌旗舰店', box: { x: 10, y: 10, w: 100, h: 30 }, confidence: 0.9, lang: 'zh-Hans' }],
          dropped: [],
          warnings: [],
          usage: { input_units: 320 * 320, output_units: 1 },
          error_code: null,
          error_message: null,
        };
      },
    },
  };
}

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? '✅' : '❌'} ${message}`);
  if (!ok) failures.push(message);
};

const config = imagelabConfig();
const store = await createStore(config, silent);
const storage = createImageStorage(config, { logger: silent });
const gated = gatedOcrProvider();

const pipeline = new ImageTranslationPipeline({
  config,
  logger: silent,
  store,
  storage,
  ocrProvider: gated.provider,
  translator: createTranslator(config, { logger: silent }),
  renderProvider: createRenderProvider(config, { logger: silent }),
});

try {
  // 1. Người dùng dán ảnh; job bắt đầu OCR nhưng bị giữ ở cổng.
  const jobId = await store.createJob({ sessionId: SID, kind: 'image_translation' });
  await pipeline.ingest(jobId, { image: { base64: headphones().toString('base64') }, sessionId: SID });
  const ocrRun = pipeline.runOcr(jobId, { sessionId: SID }).catch((err) => ({ error: String(err?.message || err) }));
  await gated.started;

  // 2. Trong lúc OCR còn chạy, người dùng lưu vùng chữ bằng tay ⇒ PHẢI bị từ chối (IL08-01a).
  let rejected = null;
  try {
    await pipeline.setManualRegions(jobId, {
      sessionId: SID,
      regions: [{ box: { x: 5, y: 5, w: 50, h: 20 }, text: '纯棉短袖T恤' }],
    });
  } catch (err) {
    rejected = err;
  }
  check(
    rejected?.code === 'IMAGELAB_JOB_RUNNING',
    `lưu vùng trong lúc OCR đang chạy ⇒ 409 IMAGELAB_JOB_RUNNING (nhận: ${rejected ? rejected.code : 'KHÔNG lỗi — đã ghi!'})`,
  );
  const duringOcr = await store.listOcrRegions(jobId);
  check(duringOcr.length === 0, 'bị từ chối thì KHÔNG được ghi vùng nào vào DB');

  // 3. OCR chạy xong (bình thường — không có gì bị chặn oan).
  gated.release();
  await ocrRun;
  const afterOcr = await store.listOcrRegions(jobId);
  check(afterOcr.some((r) => r.source === 'ocr'), 'OCR xong bình thường ⇒ vùng OCR được ghi như cũ');

  // 4. Giờ job đã `awaiting_review`: lưu vùng nhập tay (luồng hợp lệ)…
  const manual = await pipeline.setManualRegions(jobId, {
    sessionId: SID,
    regions: [{ box: { x: 5, y: 5, w: 50, h: 20 }, text: '纯棉短袖T恤' }],
  });
  check(
    manual.regions.length === 1 && manual.regions[0].source === 'user',
    'job đã xong ⇒ lưu vùng nhập tay được (source = "user")',
  );

  // 5. …rồi cho OCR chạy LẠI (mô phỏng lần ghi OCR đến muộn / job chạy lại): tầng (b) phải
  //    chặn ghi đè và để lại vết, KHÔNG được xoá vùng người dùng.
  await pipeline.runOcr(jobId, { sessionId: SID });

  const after = await store.listOcrRegions(jobId);
  const job = await store.getJob(jobId);
  const userRegions = after.filter((r) => r.source === 'user');
  const guardWarn = (Array.isArray(job.content_meta?.imagelab?.warnings) ? job.content_meta.imagelab.warnings : [])
    .some((w) => /KHÔNG ghi đè/.test(String(w)));

  console.log('   vùng trong DB sau khi OCR chạy lại:', JSON.stringify(after.map((r) => [r.id, r.source, r.text])));
  console.log('   content_meta.imagelab:', JSON.stringify(job.content_meta?.imagelab?.manual_regions), job.status, job.stage);
  console.log('   có cảnh báo "KHÔNG ghi đè"?', guardWarn);

  // ── BA khẳng định của hành vi ĐÚNG ────────────────────────────────────────
  check(userRegions.length === 1, 'vùng NGƯỜI DÙNG nhập vẫn phải còn sau khi OCR chạy lại (hiện: ĐÃ MẤT)');
  check(
    job.content_meta?.imagelab?.manual_regions === true,
    'dấu vết manual_regions = true phải còn (hiện: bị OCR ghi đè mất)',
  );
  check(
    after.some((r) => r.text === '纯棉短袖T恤') && guardWarn,
    'chữ người dùng nhập phải còn trong DB + có cảnh báo "KHÔNG ghi đè"',
  );
} finally {
  cleanupTmp();
}

if (failures.length > 0) {
  console.error(`\n❌ PROBE ĐỎ — ${failures.length} khẳng định thất bại: job OCR vẫn ghi đè/xoá vùng nhập tay (im lặng).`);
  process.exit(1);
}
console.log('\n✅ PROBE XANH — vùng nhập tay không bị job OCR ghi đè (chặn lúc đang chạy + chặn lúc ghi).');
