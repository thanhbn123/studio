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
    // `null` ⇒ tự dựng ảnh mẫu 800×800 khớp ĐÚNG hộp của fixture OCR mock, để bản demo
    // là thứ mở ra XEM ĐƯỢC (chữ Việt nằm gọn trong hộp, không bị cắt).
    image: null,
    regions: null,
    out: 'data/imagelab-demo/rendered.png',
    side: 'data/imagelab-demo/truoc-sau.png',
    db: ':memory:',
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--image') args.image = argv[++i];
    else if (a === '--regions') args.regions = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--side-by-side') args.side = argv[++i];
    else if (a === '--no-side-by-side') args.side = null;
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') {
      console.log('node tools/imagelab-demo.mjs [--image <png>] [--regions <vung.json>] [--out <png>] [--side-by-side <png>] [--db <path|:memory:>] [--verbose]');
      console.log('  (không có --image   ⇒ tự dựng ảnh mẫu 800×800 khớp hộp của fixture OCR mock)');
      console.log('  (có --regions       ⇒ BỎ QUA OCR, dùng vùng chữ do người dùng nhập — cách dùng ảnh THẬT)');
      process.exit(0);
    }
  }
  return args;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const line = (n = 68) => console.log('─'.repeat(n));
const tag = (ok) => (ok ? '✓' : '✗');

/**
 * Dựng ảnh mẫu 800×800 với các ô xám đúng vị trí hộp chữ của fixture OCR mock.
 *
 * TRUNG THỰC: đây là ảnh MÔ PHỎNG do máy sinh (nền xám + ô xám), KHÔNG phải ảnh sản phẩm thật,
 * và các ô xám KHÔNG phải chữ Trung thật (bộ render nội bộ không có glyph chữ Hán). Mục đích
 * duy nhất: để mắt người xem được chữ Việt do MVP-02 vẽ vào đúng hộp.
 */
function buildDemoCanvas(fixture, { width = 800, height = 800 } = {}) {
  const data = Buffer.alloc(width * height * 4);
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  // Nền sáng + vài dải màu nhạt cho dễ nhìn (không mang ý nghĩa sản phẩm).
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const band = Math.floor(y / 100) % 2 === 0 ? 4 : 0;
      put(x, y, [246 - band, 246 - band, 248 - band]);
    }
  }
  const boxes = Array.isArray(fixture?.regions) ? fixture.regions.map((r) => r.box).filter(Boolean) : [];
  for (const box of boxes) {
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let x = box.x; x < box.x + box.w; x += 1) {
        const border = x <= box.x + 1 || x >= box.x + box.w - 2 || y <= box.y + 1 || y >= box.y + box.h - 2;
        put(x, y, border ? [150, 150, 155] : [214, 214, 216]);
      }
    }
  }
  return { width, height, data, channels: 4, boxCount: boxes.length };
}

/** Ghép ảnh gốc | ảnh kết quả thành một PNG để mở MỘT file là thấy trước/sau. */
function composeSideBySide({ original, rendered, toRgba, divider = 6, dividerColor = [255, 80, 80] }) {
  if (!toRgba) throw new Error('thiếu hàm toRgba để giải mã pixel');
  if (original.width !== rendered.width || original.height !== rendered.height) return null;
  const { width: w, height: h } = original;
  const outW = w * 2 + divider;
  const data = Buffer.alloc(outW * h * 4);
  const before = toRgba(original);
  const after = toRgba(rendered);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const src = (y * w + x) * 4;
      const left = (y * outW + x) * 4;
      const right = (y * outW + divider + w + x) * 4;
      before.copy(data, left, src, src + 4);
      after.copy(data, right, src, src + 4);
    }
    for (let d = 0; d < divider; d += 1) {
      const i = (y * outW + w + d) * 4;
      data[i] = dividerColor[0];
      data[i + 1] = dividerColor[1];
      data[i + 2] = dividerColor[2];
      data[i + 3] = 255;
    }
  }
  return { width: outW, height: h, data, channels: 4 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const imagePath = args.image ? path.resolve(ROOT, args.image) : null;
  const outPath = path.resolve(ROOT, args.out);

  if (imagePath && !fs.existsSync(imagePath)) {
    console.error(`Không thấy ảnh: ${imagePath}`);
    console.error('Gợi ý: bỏ `--image` để tự dựng ảnh mẫu 800×800, hoặc sinh ảnh bằng');
    console.error('      node tools/make-test-image.mjs <đường-dẫn.png>  rồi truyền --image.');
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

  // ── Ảnh vào: ảnh người dùng truyền, hoặc ảnh MẪU tự sinh khớp hộp của fixture OCR mock ──
  let originalBuffer;
  let imageLabel;
  if (imagePath) {
    originalBuffer = fs.readFileSync(imagePath);
    imageLabel = `${path.relative(ROOT, imagePath)} (${originalBuffer.length} byte)`;
  } else {
    const fixturePath = path.resolve(ROOT, config.ocr?.mockFixture || 'src/imagelab/ocr/fixtures/mock-regions.json');
    let fixture = null;
    try {
      fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    } catch {
      fixture = null;
    }
    const canvas = buildDemoCanvas(fixture);
    originalBuffer = modules.render.encodePng(canvas);
    imageLabel =
      `ảnh MẪU TỰ SINH ${canvas.width}×${canvas.height} (nền xám + ${canvas.boxCount} ô mô phỏng vùng chữ) ` +
      `— KHÔNG phải ảnh sản phẩm thật, ô xám KHÔNG phải chữ Trung thật (bộ render nội bộ không có glyph Hán)`;
  }
  const originalHashBefore = sha256(originalBuffer);

  line();
  console.log('MVP-02 — DỊCH ẢNH TRUNG → VIỆT (chạy offline, không dịch vụ trả tiền)');
  line();
  console.log(`Ảnh vào     : ${imageLabel}`);
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
    image: { buffer: originalBuffer, mime: 'image/png', filename: imagePath ? path.basename(imagePath) : 'anh-mau-800x800.png' },
    sessionId,
    options: {},
  });
  console.log(`\n[1] Nạp ảnh   → asset ${ingest.asset_id} · ${ingest.width}×${ingest.height}px`);

  /* ── 2. Vùng chữ + dịch ────────────────────────────────────────────────
   * Hai đường, cùng một kết quả phía sau:
   *   · mặc định      → OCR (provider theo `OCR_PROVIDER`; mặc định là mock);
   *   · `--regions`   → vùng do NGƯỜI DÙNG nhập (IL-08) ⇒ **bỏ qua OCR hoàn toàn**.
   * Đường thứ hai là cách dùng được tính năng trên ẢNH THẬT ngay hôm nay, khi chưa cắm
   * dịch vụ OCR trả tiền (mock trả hộp của fixture, không liên quan tới ảnh của anh). */
  let manualNote = '';
  if (args.regions) {
    const regionsPath = path.resolve(ROOT, args.regions);
    if (!fs.existsSync(regionsPath)) {
      console.error(`Không thấy file vùng chữ: ${regionsPath}`);
      process.exit(2);
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(regionsPath, 'utf8'));
    } catch (err) {
      console.error(`File vùng chữ không phải JSON hợp lệ: ${err.message}`);
      process.exit(2);
    }
    const list = Array.isArray(parsed) ? parsed : parsed?.regions;
    if (!Array.isArray(list) || list.length === 0) {
      console.error('File vùng chữ phải là mảng [{box:{x,y,w,h}, text, kind?}] (hoặc {"regions": [...]}).');
      process.exit(2);
    }
    // IL08-01(a): đường này CỐ Ý không xếp lượt OCR nào vào hàng đợi, nên phải nói rõ
    // `ocrPending: false` — mặc định của pipeline là coi job `queued` như đang chờ OCR.
    const manual = await pipeline.setManualRegions(jobId, { sessionId, regions: list, replace: true, ocrPending: false });
    manualNote = `người dùng nhập${args.regions ? ` (${path.relative(ROOT, regionsPath)})` : ''}`;
    if ((manual.rejected || []).length > 0) {
      console.log(`\n[2] Vùng chữ  → ${manual.rejected.length} vùng bị TỪ CHỐI (nói thẳng, không im lặng):`);
      for (const r of manual.rejected) console.log(`      · chỉ số ${r.index}: ${r.reason}`);
    }
  } else {
    await pipeline.runOcr(jobId, { sessionId, options: {} });
  }
  const regions = await store.listOcrRegions(jobId);
  const linesAfterOcr = await store.listTranslationLines(jobId);

  console.log(
    manualNote
      ? `\n[2] Vùng chữ  → ${regions.length} vùng do ${manualNote} — ĐÃ BỎ QUA OCR`
      : `\n[2] OCR       → ${regions.length} vùng chữ (provider: ${ocrProvider.name}${ocrProvider.isMock ? ' — MOCK' : ''})`,
  );
  for (const r of regions) {
    const lock = r.translatable ? '  ' : '🔒';
    const src = r.source === 'user' ? 'người dùng' : 'ocr';
    console.log(`    ${lock} ${String(r.region_key || r.id).padEnd(4)} [${String(r.kind).padEnd(13)}] (${src}) ${r.text_original}`);
  }

  const skipped = linesAfterOcr.filter((l) => String(l.status || '').startsWith('SKIPPED'));
  const needReview = linesAfterOcr.filter((l) => l.status === 'NEEDS_REVIEW');
  console.log(`    Dịch được: ${linesAfterOcr.length - skipped.length - needReview.length} · Khoá (nhãn hiệu/chứng nhận/giá): ${skipped.length} · Cần người duyệt: ${needReview.length}`);
  for (const l of skipped) console.log(`    🔒 ${l.region_id}: ${l.notes || l.status}`);

  /* ── 3. Người dùng duyệt ───────────────────────────────────────────────
   * Demo mô phỏng ĐÚNG việc một người duyệt thật sẽ làm:
   *   · dòng dịch được  → chấp nhận;
   *   · dòng còn "cần người duyệt" (vd chuỗi chỉ có số/ký hiệu, không có gì để dịch)
   *     → BỎ QUA có chủ đích (`skip` ⇒ SKIPPED_BY_USER), thay vì ép `force` cả job.
   * Nhờ vậy đường chạy bình thường không cần `force` — còn nếu vẫn còn NEEDS_REVIEW thì
   * cổng duyệt PHẢI chặn (demo in ra và mới force, có ghi vết). */
  const edits = linesAfterOcr
    .filter((l) => l.status === 'TRANSLATED' || l.status === 'GLOSSARY')
    .map((l) => ({ region_id: l.region_id, action: 'accept', text_vi: l.text_vi }));
  const skippedByUser = needReview.map((l) => ({ region_id: l.region_id, action: 'skip' }));
  const review = modules.translate.applyReviewEdits(linesAfterOcr, [...edits, ...skippedByUser], { allowBrandOverride: false });
  await store.updateTranslationLines(jobId, review.lines);
  console.log(`\n[3] Duyệt     → ${edits.length} dòng chấp nhận · ${skippedByUser.length} dòng người duyệt BỎ QUA · ${review.rejected.length} dòng bị TỪ CHỐI`);
  for (const l of skippedByUser) console.log(`    ⏭  ${l.region_id}: người duyệt bỏ qua (không có nội dung để dịch)`);
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
  const originalHashAfter = imagePath ? sha256(fs.readFileSync(imagePath)) : originalHashBefore;
  const originalOnDisk = await storage.read((await store.listImageAssets(jobId, { role: 'original' }))[0]);
  const renderedBuffer = await storage.read(asset);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderedBuffer);

  // Ảnh TRƯỚC | SAU trong MỘT file để mắt người xem được ngay (không cần mở hai file).
  let sidePathWritten = null;
  if (args.side) {
    try {
      const sidePath = path.resolve(ROOT, args.side);
      const side = composeSideBySide({
        original: modules.render.decodePng(originalBuffer),
        rendered: modules.render.decodePng(renderedBuffer),
        toRgba: modules.render.toRgba,
      });
      if (side) {
        fs.mkdirSync(path.dirname(sidePath), { recursive: true });
        fs.writeFileSync(sidePath, modules.render.encodePng(side));
        sidePathWritten = sidePath;
      }
    } catch (err) {
      console.log(`   (không ghép được ảnh trước/sau: ${String(err?.message || err).slice(0, 80)})`);
    }
  }

  line();
  console.log('BẰNG CHỨNG ĐO ĐƯỢC');
  line();
  console.log(`${tag(originalHashAfter === originalHashBefore)} Ảnh gốc không đổi sau toàn bộ luồng: ${originalHashAfter}`);
  console.log(`${tag(sha256(originalOnDisk) === originalHashBefore)} Bản lưu của ảnh gốc không đổi: ${sha256(originalOnDisk)}`);
  console.log(`${tag(asset.parent_id === ingest.asset_id)} Ảnh render trỏ về ảnh gốc   : parent_id=${asset.parent_id}`);
  console.log(`${tag(sha256(renderedBuffer) !== originalHashBefore)} Ảnh render là bản MỚI khác gốc: ${sha256(renderedBuffer)}`);
  console.log(`   Ảnh kết quả   : ${path.relative(ROOT, outPath)} (${renderedBuffer.length} byte, ${asset.width}×${asset.height})`);
  if (sidePathWritten) {
    console.log(`   Ảnh TRƯỚC|SAU  : ${path.relative(ROOT, sidePathWritten)}  ← mở file này để NHÌN bằng mắt`);
  }

  /* ── 6. Usage thật đọc lại từ DB ────────────────────────────────────── */
  const usage = await store.listUsage(jobId);
  const summary = await store.usageSummary(jobId);
  console.log('\nUSAGE_EVENT (đọc lại từ DB)');
  for (const u of usage) {
    console.log(`   ${String(u.operation).padEnd(16)} provider=${String(u.provider || '').padEnd(10)} in=${String(u.input_units).padStart(8)} out=${String(u.output_units).padStart(6)} cost=${u.estimated_cost}`);
  }
  console.log(`   Tổng: ${summary.events} event · ${summary.input_units} input · ${summary.output_units} output · ${summary.estimated_cost} ${config.cost?.currency || 'USD'}`);

  const mockSteps = [];
  // Chỉ liệt kê OCR khi OCR THẬT SỰ chạy: dùng `--regions` thì bước OCR bị bỏ qua hoàn toàn,
  // ghi vào đây là nói sai về việc đã làm.
  if (!args.regions && ocrProvider.isMock) mockSteps.push('OCR_DETECT');
  if (renderProvider.isMock) mockSteps.push('IMAGE_RENDER');
  if (translator?.isMock) mockSteps.push('TRANSLATION');

  line();
  console.log(
    mockSteps.length
      ? `NHÃN KIỂM CHỨNG: MOCK_VERIFIED — các bước dùng provider giả: ${mockSteps.join(', ')}.`
      : 'NHÃN KIỂM CHỨNG: ảnh do người dùng tải lên (MANUAL_INPUT); không bước nào dùng provider giả.',
  );
  if (args.regions) {
    console.log('Vùng chữ do NGƯỜI DÙNG nhập ⇒ KHÔNG có bước OCR nào chạy (không ghi usage_event OCR_DETECT).');
  }
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
