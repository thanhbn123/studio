/**
 * TEST HỒI QUY VÒNG 4 — thoả 3 điều kiện của phản biện vòng 2 + N-3/N-4/N-6/N-7.
 *
 *   N-5 (điều kiện 1)  `RENDER_PROVIDER=http`: KHÔNG tin ảnh/applied do remote khai —
 *                      hash y hệt ⇒ không OK; pixel vùng bảo vệ đổi ⇒ TỪ CHỐI lưu;
 *                      không giải mã được ⇒ `protected_pixels_verified = false` + cảnh báo.
 *   N-1 (điều kiện 2)  toạ độ NULL/rác KHÔNG bao giờ bị coi là 0 (fail-closed).
 *   N-2 (điều kiện 3)  job phải mang `error_code = RENDER_NO_OPS` khi 0 op được vẽ.
 *   N-4                `only_region_ids` toàn id không khớp ⇒ 409, không render tất cả.
 *   N-7                bớt dương tính giả (đơn vị `%` viết liền chữ Hán; "một chiếc").
 *
 * Chạy offline: provider thật chạy nội bộ, riêng N-5 dùng provider GIẢ kế thừa
 * `RenderProvider` (không cần mạng) để mô phỏng remote `evil`/`liar`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';

import { createStore } from '../src/store/index.js';
import { createImageStorage } from '../src/imagelab/storage.js';
import { createTranslator } from '../src/imagelab/translate/index.js';
import { createRenderProvider, decodePng, encodePng, sha256, toRgba } from '../src/imagelab/render/index.js';
import { RenderProvider, RENDER_STATUS } from '../src/imagelab/render/provider.js';
import { verifyProtectedPixels } from '../src/imagelab/render/verify.js';
import { intersectBoxWithImage, strictCoordinate } from '../src/imagelab/geometry.js';
import { ImageTranslationPipeline, RENDER_NO_OPS } from '../src/imagelab/pipeline.js';
import { enforceTranslationGuardrails, unitsIn } from '../src/imagelab/translate/guardrails.js';
import { TRANSLATE_STATUS } from '../src/imagelab/translate/lines.js';
import { silent } from './helpers.js';
import {
  cookie,
  countChangedPixels,
  fakeOcrProvider,
  imagelabConfig,
  j,
  makeTestImage,
  postJson,
  startImagelabApp,
  tmpDir,
  waitJob,
} from './imagelab-helpers.js';

const SID = 'round4SessionAAAA111';
const RED = [255, 0, 0, 255];

/* ───────────────────────── N-1: toạ độ nghiêm ngặt ───────────────────────── */

describe('VÒNG 4 · N-1 — toạ độ NULL/rác không bao giờ thành 0', () => {
  test('intersectBoxWithImage: mọi giá trị không phải số ⇒ null (không dời về gốc 0)', () => {
    for (const bad of [null, undefined, '', '   ', [], {}, false, true, NaN, Infinity, -Infinity, 'abc']) {
      assert.equal(strictCoordinate(bad), null, `strictCoordinate(${JSON.stringify(bad)}) phải là null`);
      assert.equal(
        intersectBoxWithImage({ x: bad, y: 0, w: 10, h: 10 }, 100, 100),
        null,
        `hộp có x=${JSON.stringify(bad)} phải bị TỪ CHỐI, không được coi là x=0`,
      );
    }
  });

  test('chuỗi SỐ vẫn được chấp nhận (không siết quá tay)', () => {
    assert.deepEqual(intersectBoxWithImage({ x: '12', y: '3', w: '10', h: '10' }, 100, 100), {
      x: 12,
      y: 3,
      w: 10,
      h: 10,
    });
  });

  test('hộp bảo vệ có x = NULL: hộp được cứu từ box_normalized nên vùng giao vẫn bị chặn', async () => {
    const W = 320;
    const H = 320;
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const storage = createImageStorage(config, { logger: silent });
    const pipeline = new ImageTranslationPipeline({
      config,
      logger: silent,
      store,
      storage,
      ocrProvider: fakeOcrProvider({ regions: [], isMock: true }),
      translator: createTranslator(config, { logger: silent }),
      renderProvider: createRenderProvider(config, { logger: silent }),
    });
    const jobId = await store.createJob({ sessionId: SID, kind: 'image_translation' });
    const image = makeTestImage({ width: W, height: H, fills: [{ box: { x: 200, y: 100, w: 100, h: 40 }, rgba: RED }] });
    const ing = await pipeline.ingest(jobId, { image, sessionId: SID });
    // Vùng nhãn hiệu có box x = NULL (DB hỏng) nhưng box_normalized còn đúng.
    await store.saveOcrRegions(jobId, ing.asset_id, [
      {
        id: 'r1',
        box: { x: null, y: 100, w: 100, h: 40 },
        box_normalized: { x: 200 / W, y: 100 / H, w: 100 / W, h: 40 / H },
        text: '品牌旗舰店',
        lang: 'zh-Hans',
        confidence: 0.97,
        kind: 'brand',
        kind_reason: '',
        translatable: false,
        source: 'ocr',
      },
      {
        id: 'r2',
        box: { x: 150, y: 100, w: 120, h: 40 }, // giao vị trí THẬT của nhãn hiệu
        box_normalized: { x: 150 / W, y: 100 / H, w: 120 / W, h: 40 / H },
        text: '纯棉短袖T恤',
        lang: 'zh-Hans',
        confidence: 0.93,
        kind: 'descriptive',
        kind_reason: '',
        translatable: true,
        source: 'ocr',
      },
    ]);
    await store.saveTranslationLines(jobId, [
      { region_id: 'r1', text_original: '品牌旗舰店', text_vi: '', status: 'SKIPPED_BRAND', provenance: 'none', confidence: 0, violations: [], notes: '', edited_by_user: false, edited_at: null },
      { region_id: 'r2', text_original: '纯棉短袖T恤', text_vi: 'Ao thun cotton', status: 'TRANSLATED', provenance: 'ai', confidence: 0.9, violations: [], notes: '', edited_by_user: false, edited_at: null },
    ]);

    await assert.rejects(
      () => pipeline.renderApproved(jobId, { sessionId: SID }),
      (err) => err.code === 'IMAGELAB_NO_LINES' && /BOX_OVERLAPS_PROTECTED: r1 \(brand\)/.test(err.message),
      'op giao vị trí THẬT của nhãn hiệu phải bị chặn (hộp cứu từ box_normalized)',
    );
    // Không có ảnh render nào được lưu ⇒ pixel nhãn hiệu chắc chắn nguyên vẹn.
    assert.deepEqual(await store.listImageAssets(jobId, { role: 'rendered' }), []);
    await store.close();
  });

  test('hộp bảo vệ hỏng CẢ box lẫn box_normalized ⇒ chặn MỌI op (fail-closed), có BAD_BOX_COORDINATE', async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const storage = createImageStorage(config, { logger: silent });
    const pipeline = new ImageTranslationPipeline({
      config,
      logger: silent,
      store,
      storage,
      ocrProvider: fakeOcrProvider({ regions: [], isMock: true }),
      translator: createTranslator(config, { logger: silent }),
      renderProvider: createRenderProvider(config, { logger: silent }),
    });
    const jobId = await store.createJob({ sessionId: SID, kind: 'image_translation' });
    const ing = await pipeline.ingest(jobId, { image: makeTestImage({ width: 320, height: 320 }), sessionId: SID });
    await store.saveOcrRegions(jobId, ing.asset_id, [
      { id: 'r1', box: { x: null, y: null, w: null, h: null }, text: '品牌旗舰店', lang: 'zh-Hans', confidence: 0.9, kind: 'brand', kind_reason: '', translatable: false, source: 'ocr' },
      { id: 'r2', box: { x: 20, y: 220, w: 120, h: 30 }, text: '纯棉纯色', lang: 'zh-Hans', confidence: 0.9, kind: 'descriptive', kind_reason: '', translatable: true, source: 'ocr' },
      // r3 cũng mất toạ độ, nhưng CÓ dòng dịch hợp lệ ⇒ phải vào skipped với BAD_BOX_COORDINATE
      { id: 'r3', box: { x: '', y: 240, w: 100, h: 30 }, text: '纯棉透气', lang: 'zh-Hans', confidence: 0.9, kind: 'descriptive', kind_reason: '', translatable: true, source: 'ocr' },
    ]);
    await store.saveTranslationLines(jobId, [
      { region_id: 'r1', text_original: '品牌旗舰店', text_vi: '', status: 'SKIPPED_BRAND', provenance: 'none', confidence: 0, violations: [], notes: '', edited_by_user: false, edited_at: null },
      { region_id: 'r2', text_original: '纯棉纯色', text_vi: 'Cotton mau tron', status: 'TRANSLATED', provenance: 'ai', confidence: 0.9, violations: [], notes: '', edited_by_user: false, edited_at: null },
      { region_id: 'r3', text_original: '纯棉透气', text_vi: 'Cotton thoang khi', status: 'TRANSLATED', provenance: 'ai', confidence: 0.9, violations: [], notes: '', edited_by_user: false, edited_at: null },
    ]);

    await assert.rejects(
      () => pipeline.renderApproved(jobId, { sessionId: SID }),
      (err) => err.code === 'IMAGELAB_NO_LINES'
        && /r1 \(brand, hộp không hợp lệ — fail-closed\)/.test(err.message)
        && /BAD_BOX_COORDINATE/.test(err.message),
      'không xác định được hộp bảo vệ ⇒ không dựng op nào; vùng có toạ độ rác cũng bị bỏ kèm lý do',
    );
    await store.close();
  });
});

/* ─────────── N-5: engine không tin ảnh/applied do provider khai ─────────── */

/** Provider GIẢ mô phỏng remote `liar`/`evil` (không cần mạng). */
class FakeRemoteRenderProvider extends RenderProvider {
  constructor(remote) {
    super({ name: 'fake-remote', model: 'fake', isMock: false, configured: true, limits: { maxPixels: 16_000_000 } });
    this.remote = remote;
  }

  async renderImpl({ image, ops }) {
    return this.remote({ image, ops });
  }
}

const tinyImage = (fills = []) => makeTestImage({ width: 64, height: 64, fills });
/** Pixel RAW (RGBA) của một PNG 64×64 — để dựng ảnh giả "remote trả về" đúng cách. */
const rgbaOf = (png) => toRgba(decodePng(png));
const pngFromRgba = (rgba) => encodePng({ width: 64, height: 64, channels: 4, data: rgba });
/** Xoá trắng một hộp trong ảnh RGBA — mô phỏng remote "vẽ lại cả ảnh". */
const eraseBoxIn = (rgba, box) => {
  const out = Buffer.from(rgba);
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      const i = (y * 64 + x) * 4;
      out[i] = 255;
      out[i + 1] = 255;
      out[i + 2] = 255;
      out[i + 3] = 255;
    }
  }
  return out;
};
const PROTECTED_BOX = { x: 8, y: 8, w: 48, h: 16 };
const SAFE_BOX = { x: 8, y: 40, w: 48, h: 16 };
const opOn = (box, regionId = 'r2') => ({ region_id: regionId, box, action: 'erase_and_draw', text: 'AB', style: {} });

describe('VÒNG 4 · N-5 — không tin provider (nhất là http)', () => {
  test('verifyProtectedPixels: 0 pixel đổi ⇒ verified true; có pixel đổi ⇒ PROTECTED_PIXELS_CHANGED', () => {
    const original = tinyImage([{ box: PROTECTED_BOX, rgba: RED }]);
    const untouched = verifyProtectedPixels({ originalBuffer: original, outputBuffer: original, protectedBoxes: [PROTECTED_BOX] });
    assert.equal(untouched.verified, true);

    const changedImage = tinyImage([]); // nền trắng: hộp đỏ đã biến mất
    const changed = verifyProtectedPixels({ originalBuffer: original, outputBuffer: changedImage, protectedBoxes: [PROTECTED_BOX] });
    assert.equal(changed.verified, false);
    assert.equal(changed.reason, 'PROTECTED_PIXELS_CHANGED');
    assert.ok(changed.changed[0].changed > 0);
  });

  test('remote kiểu "liar" (trả ảnh Y HỆT nhưng khai đã áp dụng) ⇒ PARTIAL + NO_OPS, không OK', async () => {
    const image = tinyImage([{ box: PROTECTED_BOX, rgba: RED }]);
    const provider = new FakeRemoteRenderProvider(({ image: img }) => ({
      status: RENDER_STATUS.OK,
      output: { buffer: Buffer.from(img.buffer), mime: 'image/png', width: 64, height: 64, sha256: sha256(img.buffer) },
      applied: [{ region_id: 'r2', box: SAFE_BOX }], // khai khống
      skipped: [],
      warnings: ['server giả chế độ liar'],
    }));

    const res = await provider.render({
      image: { buffer: image, mime: 'image/png' },
      ops: [opOn(SAFE_BOX)],
      options: { protected_boxes: [{ region_id: 'r1', box: PROTECTED_BOX }] },
    });

    assert.notEqual(res.status, 'OK', 'không vẽ gì thì không được báo OK');
    assert.equal(res.status, 'PARTIAL');
    assert.equal(res.error_code, 'NO_OPS');
    assert.deepEqual(res.applied, [], 'lời khai `applied` bị bỏ vì sha256 ảnh trả về trùng ảnh gốc');
    assert.equal(res.output.sha256, sha256(image));
    assert.match(res.warnings.join(' '), /Y HỆT ảnh gốc/);
    assert.match(res.warnings.join(' '), /KHÔNG tính là đã vẽ/);
  });

  test('remote kiểu "evil" (xoá pixel vùng bảo vệ) ⇒ FAILED + PROTECTED_PIXELS_CHANGED, KHÔNG trả ảnh', async () => {
    const image = tinyImage([{ box: PROTECTED_BOX, rgba: RED }]);
    const provider = new FakeRemoteRenderProvider(({ image: img }) => {
      // remote "vẽ lại cả ảnh": xoá luôn vùng nhãn hiệu rồi trả PNG mới
      const poisoned = pngFromRgba(eraseBoxIn(rgbaOf(img.buffer), PROTECTED_BOX));
      return {
        status: RENDER_STATUS.OK,
        output: { buffer: poisoned, mime: 'image/png', width: 64, height: 64, sha256: sha256(poisoned) },
        applied: [{ region_id: 'r2', box: SAFE_BOX }],
        skipped: [],
        warnings: ['server giả chế độ evil'],
      };
    });

    const res = await provider.render({
      image: { buffer: image, mime: 'image/png' },
      ops: [opOn(SAFE_BOX)],
      options: { protected_boxes: [{ region_id: 'r1', box: PROTECTED_BOX }] },
    });

    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'PROTECTED_PIXELS_CHANGED');
    assert.equal(res.output, null, 'TUYỆT ĐỐI không trả ảnh đã làm hỏng vùng bảo vệ');
    assert.equal(res.protected_pixels_verified, false);
    assert.match(res.error_message, /KHÔNG giữ nguyên vùng bảo vệ|TỪ CHỐI lưu/);
  });

  test('ảnh trả về là JPEG (không kiểm được pixel) ⇒ protected_pixels_verified = false + cảnh báo, KHÔNG OK', async () => {
    const image = tinyImage([{ box: PROTECTED_BOX, rgba: RED }]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
    const provider = new FakeRemoteRenderProvider(() => ({
      status: RENDER_STATUS.OK,
      output: { buffer: jpeg, mime: 'image/jpeg', width: 64, height: 64, sha256: sha256(jpeg) },
      applied: [{ region_id: 'r2', box: SAFE_BOX }],
      skipped: [],
      warnings: [],
    }));

    const res = await provider.render({
      image: { buffer: image, mime: 'image/png' },
      ops: [opOn(SAFE_BOX)],
      options: { protected_boxes: [{ region_id: 'r1', box: PROTECTED_BOX }] },
    });

    assert.equal(res.protected_pixels_verified, false, 'không được coi như đã kiểm');
    assert.equal(res.status, 'PARTIAL');
    assert.equal(res.error_code, 'PROTECTED_PIXELS_UNVERIFIED');
    assert.match(res.warnings.join(' '), /KHÔNG kiểm chứng được pixel vùng bảo vệ/);
  });

  test('khai `applied` nhiều hơn số op đã gửi ⇒ cảnh báo + hạ trạng thái, chỉ giữ đúng số op', async () => {
    const image = tinyImage([]);
    const provider = new FakeRemoteRenderProvider(({ image: img }) => {
      // đổi 1 pixel TRONG hộp op để ảnh KHÁC gốc và thật sự "có vẽ" (nếu không sẽ rơi vào
      // nhánh N-8a `NO_OPS`), nhưng vẫn khai thừa số op đã áp dụng.
      const data = rgbaOf(img.buffer);
      const i = ((SAFE_BOX.y + 1) * 64 + SAFE_BOX.x + 1) * 4;
      data[i] = 1;
      const buf = pngFromRgba(data);
      return {
        status: RENDER_STATUS.OK,
        output: { buffer: buf, mime: 'image/png', width: 64, height: 64, sha256: sha256(buf) },
        applied: [
          { region_id: 'r2', box: SAFE_BOX },
          { region_id: 'r3', box: SAFE_BOX },
          { region_id: 'r4', box: SAFE_BOX },
        ],
        skipped: [],
        warnings: [],
      };
    });

    const res = await provider.render({
      image: { buffer: image, mime: 'image/png' },
      ops: [opOn(SAFE_BOX)],
      options: { protected_boxes: [{ region_id: 'r1', box: PROTECTED_BOX }] },
    });

    assert.equal(res.applied.length, 1, 'chỉ tin đúng số op đã gửi');
    assert.equal(res.status, 'PARTIAL');
    assert.equal(res.error_code, 'RENDER_APPLIED_MISMATCH');
    assert.match(res.warnings.join(' '), /không tin phần khai thêm/);
  });
});

/* ─────────────────── N-2: job nói thật khi 0 op được vẽ ─────────────────── */

describe('VÒNG 4 · N-2 — job.error_code = RENDER_NO_OPS khi không vẽ được vùng nào', () => {
  test('API thật: op bị NO_GLYPH ⇒ job succeeded nhưng error_code = RENDER_NO_OPS', async () => {
    // Fixture RIÊNG: đúng MỘT vùng mô tả ⇒ mọi op đều bị NO_GLYPH thì không vùng nào được vẽ.
    const fx = path.join(tmpDir('round4-noops-'), 'fixture.json');
    fs.writeFileSync(fx, JSON.stringify({
      is_mock: true,
      width: 320,
      height: 320,
      regions: [{ text: '纯棉短袖T恤', box: { x: 40, y: 100, w: 200, h: 40 }, confidence: 0.93, lang: 'zh-Hans' }],
    }));
    const ctx = await startImagelabApp({ configOverrides: { OCR_MOCK_FIXTURE: fx } });
    try {
      const buf = makeTestImage({ width: 320, height: 320, fills: [{ box: { x: 40, y: 100, w: 200, h: 40 }, rgba: RED }] });
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', { image: { base64: buf.toString('base64') } }, SID));
      const st = await waitJob(ctx.base, created.job_id, SID);
      assert.equal(st.lines.length, 1);
      // Bản dịch chứa emoji → font bitmap không có glyph ⇒ op bị bỏ, 0 vùng được vẽ.
      const put = await fetch(`${ctx.base}/api/imagelab/jobs/${created.job_id}/lines`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...cookie(SID) },
        body: JSON.stringify({ edits: [{ region_id: st.lines[0].region_id, text_vi: 'Áo thun 😀', action: 'edit' }] }),
      });
      assert.equal(put.status, 200);
      const rr = await postJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/render`, {}, SID);
      if (rr.status === 409) {
        await postJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/render`, { force: true }, SID);
      }
      const done = await waitJob(ctx.base, created.job_id, SID, { tries: 200 });

      assert.equal(done.job.status, 'succeeded', 'ảnh mới vẫn được lưu nên job succeeded');
      assert.equal(done.job.error_code, RENDER_NO_OPS, 'nhưng job PHẢI mang mã lỗi nói thật');
      assert.equal(done.render_summary.status, 'PARTIAL');
      assert.deepEqual(done.render_summary.applied, []);
    } finally {
      await ctx.close();
    }
  });
});

/* ─────────────── N-4: only_region_ids rác ⇒ 409, không render tất cả ─────────────── */

describe('VÒNG 4 · N-4 — `only_region_ids` fail-closed', () => {
  test('toàn id không khớp ⇒ 409 UNKNOWN_REGION_IDS (trước đây 202 và render TẤT CẢ)', async () => {
    const ctx = await startImagelabApp();
    try {
      const buf = makeTestImage({ width: 320, height: 320, fills: [{ box: { x: 40, y: 100, w: 200, h: 40 }, rgba: RED }] });
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', { image: { base64: buf.toString('base64') } }, SID));
      await waitJob(ctx.base, created.job_id, SID);

      const res = await postJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/render`, {
        only_region_ids: [null, 1, {}, 'khong-ton-tai'],
      }, SID);
      assert.equal(res.status, 409);
      const body = await j(res);
      assert.equal(body.error.code, 'UNKNOWN_REGION_IDS');
      assert.ok(Array.isArray(body.error.details?.unknown_region_ids));
      assert.ok(body.error.details.unknown_region_ids.includes('khong-ton-tai'));

      // Không được âm thầm render: job vẫn ở trạng thái chờ duyệt, chưa có ảnh render.
      const after = await j(await fetch(`${ctx.base}/api/imagelab/jobs/${created.job_id}`, { headers: cookie(SID) }));
      assert.deepEqual(after.rendered, []);
    } finally {
      await ctx.close();
    }
  });
});

/* ──────────────────── N-6/N-7: guardrail bớt lọt, bớt oan ──────────────────── */

describe('VÒNG 4 · N-6/N-7 — guardrail', () => {
  const check = (original, vi) => enforceTranslationGuardrails(
    { region_id: 'r1', text_original: original, text_vi: vi, status: TRANSLATE_STATUS.TRANSLATED },
    { region: { kind: 'descriptive', translatable: true } },
  );

  test('N-7a: chữ Hán viết LIỀN số + `%` không còn bị tố oan', () => {
    assert.deepEqual([...unitsIn('纯棉100%T恤')], ['%']);
    for (const [original, vi] of [
      ['纯棉100%T恤', 'Áo thun cotton 100%'],
      ['含棉95%的T恤', 'Chất liệu cotton 95%'],
      ['纯棉12个月T恤', 'Áo thun cotton 12 tháng'],
    ]) {
      const out = check(original, vi);
      assert.deepEqual(out.violations, [], `“${vi}” bị bắt oan: ${out.violations.join(' | ')}`);
    }
  });

  test('N-7b: mạo từ "một chiếc" KHÔNG còn bị coi là số liệu', () => {
    for (const vi of ['Một chiếc áo thun cotton', 'Chiếc áo thun cotton', 'Áo thun cotton một màu', 'Áo thun cotton hai lớp']) {
      assert.deepEqual(check('纯棉T恤', vi).violations, [], `“${vi}” bị bắt oan`);
    }
    // nhưng số CÓ CHỮ SỐ không có trong gốc thì vẫn bắt
    assert.match(check('纯棉T恤', 'Áo thun cotton 1 chiếc').violations.join(' '), /Số liệu/);
  });

  test('N-6: tiếng Việt KHÔNG DẤU vẫn bị bắt (từ khoá + số viết bằng chữ)', () => {
    const out = check('纯棉T恤', 'Ao thun cotton bao hanh mot nam');
    assert.equal(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW);
    assert.match(out.violations.join(' | '), /bao hanh/i);
    assert.match(out.violations.join(' | '), /Số liệu/);
  });

  test('N-6: `№` đứng một mình bị bắt là số liệu', () => {
    const out = check('纯棉T恤', 'Áo thun cotton № hậu mãi');
    assert.equal(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW);
    assert.match(out.violations.join(' | '), /№/);
  });

  test('N-7a: F-08a (tiền tệ bằng chữ) vẫn bắt được sau khi bỏ danh từ đếm', () => {
    const out = check('纯棉T恤', 'Áo thun cotton một trăm hai mươi nghìn đồng');
    assert.equal(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW);
    assert.match(out.violations.join(' '), /120000/);
  });
});
