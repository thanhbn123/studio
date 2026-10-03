/**
 * MVP-02 — CHỨNG MINH CHẠY THẬT (offline, không gọi dịch vụ trả tiền).
 *
 * Chạy trọn luồng Dịch ảnh trên một ảnh PNG thật, bằng store THẬT (SQLite) và
 * pipeline THẬT, rồi in ra bằng chứng đo được:
 *
 *   - sha256 ảnh gốc TRƯỚC và SAU toàn bộ luồng  → chứng minh ảnh gốc bất biến
 *   - danh sách vùng chữ + loại (mô tả / nhãn hiệu / chứng nhận / giá)
 *   - bảng duyệt: dòng nào dịch được, dòng nào bị KHOÁ và vì sao
 *   - usage_event thật đọc lại từ DB (OCR_DETECT, TRANSLATION, IMAGE_RENDER)
 *   - nhãn kiểm chứng trung thực: MOCK_VERIFIED nếu có bước dùng provider mock
 *
 * Cách chạy:
 *   node tools/imagelab-demo.mjs                       # ảnh fixture 320x320
 *   node tools/imagelab-demo.mjs --image path/to.png   # ảnh của anh
 *   node tools/imagelab-demo.mjs --out /tmp/ket-qua.png
 *
 * Công cụ này KHÔNG chứng minh OCR thật: provider mặc định là `mock` (fixture JSON).
 * Muốn đo OCR thật thì phải cắm provider thật qua biến môi trường OCR_PROVIDER.
 * Nói thẳng như vậy để không ai đọc nhầm thành "đã nghiệm thu bằng dữ liệu thật".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function parseArgs(argv) {
  const args = {
    image: 'test/fixtures/headphones.png',
    out: 'data/imagelab-demo/rendered.png',
    db: ':memory:',
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--image') args.image = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') {
      console.log('node tools/imagelab-demo.mjs [--image <png>] [--out <png>] [--db <path|:memory:>] [--verbose]');
      process.exit(0);
    }
  }
  return args;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const line = (n = 68) => console.log('─'.repeat(n));
const tag = (ok) => (ok ? '✓' : '✗');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const imagePath = path.resolve(ROOT, args.image);
  const outPath = path.resolve(ROOT, args.out);

  if (!fs.existsSync(imagePath)) {
    console.error(`Không thấy ảnh: ${imagePath}`);
    console.error('Gợi ý: sinh ảnh mẫu bằng  node tools/make-test-image.mjs <đường-dẫn.png>  rồi truyền --image.');
    console.error('(Image Docker runtime cố ý không chứa test/, nên ảnh mẫu phải sinh tại chỗ.)');
    process.exit(2);
  }

  // Mặc định offline: OCR mock (fixture), render purejs (tự viết), AI mock.
  process.env.OCR_PROVIDER ||= 'mock';
  process.env.RENDER_PROVIDER ||= 'purejs';
  process.env.AI_PROVIDER ||= 'mock';
  process.env.TRANSLATE_PROVIDER ||= 'mock';
  process.env.LOG_LEVEL ||= 'warn';
  process.env.SQLITE_PATH = args.db;

  const { loadConfig } = await import('../src/config.js');
  const { createLogger } = await import('../src/logger.js');
  const { createStore } = await import('../src/store/index.js');

  let modules;
  try {
    modules = {
      storage: await import('../src/imagelab/storage.js'),
      ocr: await import('../src/imagelab/ocr/index.js'),
      translate: await import('../src/imagelab/translate/index.js'),
      render: await import('../src/imagelab/render/index.js'),
      pipeline: await import('../src/imagelab/pipeline.js'),
    };
  } catch (err) {
    console.error('Không nạp được module MVP-02 — tính năng chưa được cài đặt đủ.');
    console.error(String(err?.message || err));
    process.exit(3);
  }

  const config = loadConfig();
  // Log của tầng dưới chỉ hiện khi --verbose, để phần bằng chứng không bị lẫn JSON log.
  const logger = createLogger({ level: args.verbose ? 'info' : 'error' });

  const originalBuffer = fs.readFileSync(imagePath);
  const originalHashBefore = sha256(originalBuffer);

  line();
  console.log('MVP-02 — DỊCH ẢNH TRUNG → VIỆT (chạy offline, không dịch vụ trả tiền)');
  line();
  console.log(`Ảnh vào     : ${path.relative(ROOT, imagePath)} (${originalBuffer.length} byte)`);
  console.log(`sha256 vào  : ${originalHashBefore}`);

  const store = await createStore(config, logger);
  const storage = modules.storage.createImageStorage(config, { logger });
  const ocrProvider = modules.ocr.createOcrProvider(config, { logger });
  const renderProvider = modules.render.createRenderProvider(config, { logger });
  const translator = modules.translate.createTranslator(config, { logger });
  const pipeline = new modules.pipeline.ImageTranslationPipeline({
    config, logger, store, storage, ocrProvider, translator, renderProvider,
  });

  const sessionId = 'demo-session';
  const jobId = await store.createJob({
    sessionId,
    source: 'imagelab',
    inputMode: 'upload',
    kind: 'image_translation',
  });

  /* ── 1. Nạp ảnh ─────────────────────────────────────────────────────── */
  const ingest = await pipeline.ingest(jobId, {
    image: { buffer: originalBuffer, mime: 'image/png', filename: path.basename(imagePath) },
    sessionId,
    options: {},
  });
  console.log(`\n[1] Nạp ảnh   → asset ${ingest.asset_id} · ${ingest.width}×${ingest.height}px`);

  /* ── 2. OCR + dịch ──────────────────────────────────────────────────── */
  const ocrRun = await pipeline.runOcr(jobId, { sessionId, options: {} });
  const regions = await store.listOcrRegions(jobId);
  const linesAfterOcr = await store.listTranslationLines(jobId);

  console.log(`\n[2] OCR       → ${regions.length} vùng chữ (provider: ${ocrProvider.name}${ocrProvider.isMock ? ' — MOCK' : ''})`);
  for (const r of regions) {
    const lock = r.translatable ? '  ' : '🔒';
    console.log(`    ${lock} ${String(r.region_key || r.id).padEnd(4)} [${String(r.kind).padEnd(13)}] ${r.text_original}`);
  }

  const skipped = linesAfterOcr.filter((l) => String(l.status || '').startsWith('SKIPPED'));
  const needReview = linesAfterOcr.filter((l) => l.status === 'NEEDS_REVIEW');
  console.log(`    Dịch được: ${linesAfterOcr.length - skipped.length - needReview.length} · Khoá (nhãn hiệu/chứng nhận/giá): ${skipped.length} · Cần người duyệt: ${needReview.length}`);
  for (const l of skipped) console.log(`    🔒 ${l.region_id}: ${l.notes || l.status}`);

  /* ── 3. Người dùng duyệt (demo: chấp nhận mọi dòng dịch được) ───────── */
  const edits = linesAfterOcr
    .filter((l) => l.status === 'TRANSLATED' || l.status === 'GLOSSARY')
    .map((l) => ({ region_id: l.region_id, action: 'accept', text_vi: l.text_vi }));
  const review = modules.translate.applyReviewEdits(linesAfterOcr, edits, { allowBrandOverride: false });
  await store.updateTranslationLines(jobId, review.lines);
  console.log(`\n[3] Duyệt     → ${edits.length} dòng chấp nhận · ${review.rejected.length} dòng bị TỪ CHỐI`);
  for (const r of review.rejected) console.log(`    ✗ ${r.region_id}: ${r.reason}`);

  /* ── 4. Render ──────────────────────────────────────────────────────── */
  // Cổng duyệt: nếu còn dòng NEEDS_REVIEW chưa được người duyệt, pipeline PHẢI từ chối.
  // Demo chứng minh cổng đó hoạt động thật, rồi mới force một cách có ghi vết.
  let forced = false;
  let rendered;
  try {
    rendered = await pipeline.renderApproved(jobId, { sessionId });
  } catch (err) {
    if (err?.code !== 'REVIEW_REQUIRED') throw err;
    forced = true;
    console.log(`\n[4] Render    → BỊ CHẶN bởi cổng duyệt: ${err.message}`);
    console.log('    (đúng thiết kế — pipeline không tự render khi còn dòng cần người duyệt)');
    rendered = await pipeline.renderApproved(jobId, { sessionId, force: true });
  }
  const asset = rendered.asset;
  const renderResult = rendered.render || {};
  const policySkipped = rendered.skipped || [];

  console.log(`\n[4] Render    → ${renderResult.status || '?'} (provider: ${renderProvider.name}${renderProvider.isMock ? ' — MOCK' : ''}${forced ? ' · ĐÃ FORCE' : ''})`);
  console.log(`    Đã áp dụng : ${(renderResult.applied || []).length} vùng`);
  console.log(`    Bỏ qua     : ${policySkipped.length} vùng`);
  for (const s of policySkipped) console.log(`      · ${s.region_id || '?'}: ${s.reason}`);
  if ((renderResult.unsupported_glyphs || []).length) {
    console.log(`    Glyph thiếu: ${renderResult.unsupported_glyphs.join(' ')}`);
  }

  /* ── 5. Bằng chứng: ảnh gốc bất biến ────────────────────────────────── */
  const originalHashAfter = sha256(fs.readFileSync(imagePath));
  const originalOnDisk = await storage.read((await store.listImageAssets(jobId, { role: 'original' }))[0]);
  const renderedBuffer = await storage.read(asset);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderedBuffer);

  line();
  console.log('BẰNG CHỨNG ĐO ĐƯỢC');
  line();
  console.log(`${tag(originalHashAfter === originalHashBefore)} Ảnh gốc trên đĩa không đổi : ${originalHashAfter}`);
  console.log(`${tag(sha256(originalOnDisk) === originalHashBefore)} Bản lưu của ảnh gốc không đổi: ${sha256(originalOnDisk)}`);
  console.log(`${tag(asset.parent_id === ingest.asset_id)} Ảnh render trỏ về ảnh gốc   : parent_id=${asset.parent_id}`);
  console.log(`${tag(sha256(renderedBuffer) !== originalHashBefore)} Ảnh render là bản MỚI khác gốc: ${sha256(renderedBuffer)}`);
  console.log(`   Ảnh kết quả: ${path.relative(ROOT, outPath)} (${renderedBuffer.length} byte, ${asset.width}×${asset.height})`);

  /* ── 6. Usage thật đọc lại từ DB ────────────────────────────────────── */
  const usage = await store.listUsage(jobId);
  const summary = await store.usageSummary(jobId);
  console.log('\nUSAGE_EVENT (đọc lại từ DB)');
  for (const u of usage) {
    console.log(`   ${String(u.operation).padEnd(16)} provider=${String(u.provider || '').padEnd(10)} in=${String(u.input_units).padStart(8)} out=${String(u.output_units).padStart(6)} cost=${u.estimated_cost}`);
  }
  console.log(`   Tổng: ${summary.events} event · ${summary.input_units} input · ${summary.output_units} output · ${summary.estimated_cost} ${config.cost?.currency || 'USD'}`);

  const mockSteps = [];
  if (ocrProvider.isMock) mockSteps.push('OCR_DETECT');
  if (renderProvider.isMock) mockSteps.push('IMAGE_RENDER');
  if (translator?.isMock) mockSteps.push('TRANSLATION');

  line();
  console.log(
    mockSteps.length
      ? `NHÃN KIỂM CHỨNG: MOCK_VERIFIED — các bước dùng provider giả: ${mockSteps.join(', ')}.`
      : 'NHÃN KIỂM CHỨNG: ảnh do người dùng tải lên (MANUAL_INPUT); không bước nào dùng provider giả.',
  );
  console.log('Đây KHÔNG phải nghiệm thu bằng dữ liệu thật: OCR thật cần cắm provider qua OCR_PROVIDER.');
  line();

  const job = await store.getJob(jobId);
  console.log(`Trạng thái job: ${job.status} · stage=${job.stage} · error_code=${job.error_code || 'không có'}`);

  await store.close();
}

main().catch((err) => {
  console.error('\nChứng minh thất bại:', err?.message || err);
  if (err?.code) console.error('error_code:', err.code);
  if (err?.stack && process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
