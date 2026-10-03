/**
 * TEST HỒI QUY VÒNG 5 — vá nốt điều kiện cuối của phản biện độc lập (vòng 3).
 *
 *   N-1 (store)  `src/store/index.js#toNum` từng dùng `Number(...)` nên CHUỖI KHOẢNG TRẮNG
 *                thành `0` và `'0x10'` thành `16` ⇒ hộp vùng nhãn hiệu bị hiểu sai thành
 *                hộp "ảo" ở gốc toạ độ ⇒ PIXEL NHÃN HIỆU BỊ XOÁ THẬT (2800/4000) mà `skipped`
 *                vẫn nói "không xoá". Test này khoá lại: mọi toạ độ rác đọc từ DB phải là `null`.
 *   N-8          hậu kiểm ảnh do provider `http` trả về không được chỉ dựa vào hash:
 *                (a) remote trả PNG CÙNG PIXEL KHÁC BYTE (thêm chunk tEXt) mà khai `applied`
 *                    ⇒ phải là `PARTIAL` + `NO_OPS`, KHÔNG được báo `OK`;
 *                (b) remote chỉ đổi 1 pixel NGOÀI hộp của op ⇒ cũng không được báo `OK`;
 *                (c) ảnh trả về SAI KÍCH THƯỚC (kể cả khi job không có vùng bảo vệ nào)
 *                    ⇒ TỪ CHỐI lưu, `error_code = RENDER_SIZE_MISMATCH`.
 *   N-9          đơn vị bịa: `500克 → "500 tấn"` phải bị bắt.
 *   N-10         so khớp bỏ dấu không được sinh dương tính giả trên tiếng Việt CÓ DẤU.
 *   N-11         `only_region_ids: []` (mảng rỗng) KHÔNG được âm thầm render tất cả.
 *
 * Chạy offline hoàn toàn: provider thật chạy nội bộ; riêng N-8 dùng provider GIẢ kế thừa
 * `RenderProvider` để mô phỏng một service render ở xa.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';

import { createStore } from '../src/store/index.js';
import { RenderProvider } from '../src/imagelab/render/provider.js';
import { decodePng, encodePng, toRgba } from '../src/imagelab/render/index.js';
import { enforceTranslationGuardrails } from '../src/imagelab/translate/guardrails.js';
import { TRANSLATE_STATUS } from '../src/imagelab/translate/lines.js';
import { silent } from './helpers.js';
import {
  cookie,
  headphones,
  imagelabConfig,
  j,
  makeTestImage,
  postJson,
  startImagelabApp,
  waitJob,
} from './imagelab-helpers.js';

const SID = 'round5SessionBBBB222';

/* ───────────────── N-1 (store): toạ độ rác không được hoá thành 0 ───────────────── */

describe('VÒNG 5 · N-1 (store) — toạ độ rác đọc từ DB phải là null, KHÔNG phải 0', () => {
  test('x = "  ", "0x10", "", "abc", NULL ⇒ listOcrRegions trả null (không 0/16)', async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const jobId = await store.createJob({ sessionId: SID, source: 'imagelab', kind: 'image_translation' });

    const poisons = ['  ', '0x10', '', 'abc', null];
    for (let i = 0; i < poisons.length; i += 1) {
      await store.driver.run(
        `INSERT INTO ocr_regions (id, job_id, asset_id, region_key, x, y, w, h,
           x_norm, y_norm, w_norm, h_norm, text_original, lang, confidence, kind, kind_reason,
           translatable, source, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          `p${i}`, jobId, 'asset-1', `r${i}`, poisons[i], 100, 100, 40,
          0.6, 0.3, 0.3, 0.12, '品牌旗舰店', 'zh-Hans', 0.9, 'brand', 'nhãn hiệu', 0, 'ocr',
          new Date().toISOString(),
        ],
      );
    }

    const regions = await store.listOcrRegions(jobId);
    assert.equal(regions.length, poisons.length);
    for (const r of regions) {
      assert.equal(
        r.box.x,
        null,
        `toạ độ rác ${JSON.stringify(poisons[Number(String(r.region_key).slice(1))])} phải là null, nhận ${JSON.stringify(r.box.x)}`,
      );
      assert.notEqual(r.box.x, 0, 'KHÔNG được hoá chuỗi khoảng trắng thành 0 (fail-open ⇒ xoá nhãn hiệu)');
      assert.notEqual(r.box.x, 16, "KHÔNG được hiểu '0x10' là số hex");
    }

    // Chuỗi SỐ hợp lệ vẫn phải đọc được (không siết quá tay).
    await store.driver.run(
      `INSERT INTO ocr_regions (id, job_id, asset_id, region_key, x, y, w, h,
         x_norm, y_norm, w_norm, h_norm, text_original, lang, confidence, kind, kind_reason,
         translatable, source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        'ok1', jobId, 'asset-1', 'r9', '12', '3', '10', '10',
        0.1, 0.05, 0.1, 0.1, '纯棉T恤', 'zh-Hans', 0.9, 'descriptive', '', 1, 'ocr',
        new Date().toISOString(),
      ],
    );
    const withOk = await store.listOcrRegions(jobId);
    const ok = withOk.find((r) => r.id === 'r9' || r.region_key === 'r9');
    assert.deepEqual(ok.box, { x: 12, y: 3, w: 10, h: 10 }, 'chuỗi số hợp lệ phải được chấp nhận');

    await store.close();
  });
});

/* ───────────── N-8: hậu kiểm ảnh remote (không tin hash/applied) ───────────── */

const W = 64;
const H = 64;

class FakeRemoteRenderProvider extends RenderProvider {
  constructor(remote) {
    super({ name: 'fake-remote', model: 'fake', isMock: false, configured: true, limits: { maxPixels: 16_000_000 } });
    this.remote = remote;
  }

  async renderImpl({ image, ops }) {
    return this.remote({ image, ops });
  }
}

const tinyImage = (fills = []) => makeTestImage({ width: W, height: H, fills });
const rgbaOf = (png) => toRgba(decodePng(png));
const pngFromRgba = (rgba) => encodePng({ width: W, height: H, channels: 4, data: rgba });
const OP_BOX = { x: 8, y: 40, w: 48, h: 16 };
const opOn = (box) => ({ region_id: 'r2', box, action: 'erase_and_draw', text: 'AB', style: {} });

/** Thêm chunk `tEXt` vào PNG: PIXEL y hệt, BYTE khác — đúng ca "re-encode" của phản biện. */
function withTextChunk(png, text = 'fake-remote-reencoded') {
  const data = Buffer.concat([Buffer.from('Comment\u0000', 'latin1'), Buffer.from(text, 'latin1')]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return Buffer.concat([png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12)]);
}

describe('VÒNG 5 · N-8 — hậu kiểm ảnh provider http trả về', () => {
  test('(a) CÙNG pixel nhưng KHÁC byte + khai `applied` ⇒ PARTIAL + NO_OPS, không OK', async () => {
    const image = tinyImage();
    const provider = new FakeRemoteRenderProvider(({ image: img }) => {
      const reencoded = withTextChunk(Buffer.from(img.buffer));
      assert.notEqual(
        reencoded.equals(img.buffer),
        true,
        'tiền đề của test: byte phải KHÁC ảnh gốc (thêm chunk tEXt)',
      );
      return {
        status: 'OK',
        output: { buffer: reencoded, mime: 'image/png', width: W, height: H },
        applied: [{ region_id: 'r2', box: OP_BOX }], // khai khống: không pixel nào đổi
        skipped: [],
        warnings: ['server giả chế độ reencode-chunk'],
      };
    });

    const res = await provider.render({ image: { buffer: image, mime: 'image/png' }, ops: [opOn(OP_BOX)] });

    assert.notEqual(res.status, 'OK', 'hash khác mà pixel không đổi thì KHÔNG được báo OK');
    assert.equal(res.status, 'PARTIAL');
    assert.equal(res.error_code, 'NO_OPS');
    assert.deepEqual(res.applied, [], 'không tin `applied` khi hộp op không đổi pixel');
    assert.match(res.warnings.join(' '), /KHÔNG có pixel nào thay đổi|không đổi/);
  });

  test('(b) chỉ đổi 1 pixel NGOÀI hộp op ⇒ vẫn không được báo OK', async () => {
    const image = tinyImage();
    const provider = new FakeRemoteRenderProvider(({ image: img }) => {
      const data = Buffer.from(rgbaOf(img.buffer));
      // Pixel ở góc xa, KHÔNG thuộc hộp op nào ⇒ "stray pixel".
      data[0] = data[0] === 255 ? 0 : 255;
      const buf = pngFromRgba(data);
      return {
        status: 'OK',
        output: { buffer: buf, mime: 'image/png', width: W, height: H },
        applied: [{ region_id: 'r2', box: OP_BOX }],
        skipped: [],
        warnings: ['server giả chế độ stray-pixel'],
      };
    });

    const res = await provider.render({ image: { buffer: image, mime: 'image/png' }, ops: [opOn(OP_BOX)] });

    assert.notEqual(res.status, 'OK');
    assert.equal(res.error_code, 'NO_OPS');
    assert.deepEqual(res.applied, []);
  });

  test('(c) ảnh SAI KÍCH THƯỚC, job KHÔNG có vùng bảo vệ ⇒ từ chối lưu (RENDER_SIZE_MISMATCH)', async () => {
    const image = tinyImage();
    const provider = new FakeRemoteRenderProvider(() => {
      const small = encodePng({ width: 16, height: 16, channels: 4, data: Buffer.alloc(16 * 16 * 4, 255) });
      return {
        status: 'OK',
        output: { buffer: small, mime: 'image/png', width: 16, height: 16 },
        applied: [{ region_id: 'r2', box: OP_BOX }],
        skipped: [],
        warnings: ['server giả chế độ nobrand-small'],
      };
    });

    const res = await provider.render({
      image: { buffer: image, mime: 'image/png' },
      ops: [opOn(OP_BOX)],
      options: { protected_boxes: [] }, // KHÔNG có vùng bảo vệ — vẫn phải kiểm kích thước
    });

    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'RENDER_SIZE_MISMATCH');
    assert.equal(res.output, null, 'ảnh sai kích thước KHÔNG được trả về để lưu');
  });
});

/* ───────────────────────── N-9 / N-10: guardrail dịch ───────────────────────── */

const REGION = { kind: 'descriptive', translatable: true };

const check = (textOriginal, textVi) => enforceTranslationGuardrails(
  {
    region_id: 'r1',
    text_original: textOriginal,
    text_vi: textVi,
    status: TRANSLATE_STATUS.TRANSLATED,
    provenance: 'ai',
    confidence: 0.9,
    violations: [],
    notes: '',
    edited_by_user: false,
    edited_at: null,
  },
  { region: REGION },
);

describe('VÒNG 5 · N-9 — đơn vị bịa phải bị bắt', () => {
  test('500克 → "500 tấn" (đổi đơn vị) bị bắt', () => {
    const { violations } = check('纯棉T恤 500克', 'Áo thun cotton 500 tấn');
    assert.ok(violations.length > 0, 'đổi gram thành tấn là bịa số liệu, phải bắt');
  });

  test('100cm → "100 m" (đổi đơn vị) bị bắt', () => {
    const { violations } = check('纯棉T恤 100cm', 'Áo thun cotton 100 m');
    assert.ok(violations.length > 0, 'đổi cm thành m là bịa số liệu, phải bắt');
  });

  test('500克 → "500 gram" (dịch đúng) KHÔNG bị bắt oan', () => {
    const { violations } = check('纯棉T恤 500克', 'Áo thun cotton 500 gram');
    assert.deepEqual(violations, [], 'dịch đúng đơn vị thì không được tố oan');
  });
});

describe('VÒNG 5 · N-10 — so khớp bỏ dấu KHÔNG được sinh dương tính giả', () => {
  const mustStayClean = [
    // [chữ gốc, bản dịch] — tiếng Việt CÓ DẤU, chỉ *trông giống* từ khoá sau khi bỏ dấu.
    ['纯棉T恤', 'Chỉnh hàng cho đẹp'],
    ['纯棉T恤', 'Đất chuẩn bị trồng cây'],
    ['纯棉T恤', 'Tột nhất là bền'],
    ['纯棉T恤', 'Áo dài tay'],
    ['纯棉T恤', 'Đồng phục công ty'],
    // N-7: `%` và "một chiếc" không phải bịa.
    ['纯棉100%T恤', 'Áo thun cotton 100%'],
    ['纯棉T恤', 'Một chiếc áo thun cotton'],
  ];

  for (const [src, vi] of mustStayClean) {
    test(`"${vi}" KHÔNG bị tố oan`, () => {
      const { violations } = check(src, vi);
      assert.deepEqual(violations, [], `câu sạch bị tố oan: ${violations.join(' | ')}`);
    });
  }

  test('nhưng tiếng Việt KHÔNG DẤU vẫn phải bị bắt', () => {
    const { violations } = check('纯棉T恤', 'Ao thun bao hanh 12 thang');
    assert.ok(violations.length > 0, '"bao hanh 12 thang" (không dấu) vẫn là khẳng định bịa');
  });
});

/* ───────────── N-11: `only_region_ids` rỗng không được render tất cả ───────────── */

describe('VÒNG 5 · N-11 — `only_region_ids` rỗng / rác phải fail-closed', () => {
  test('mảng RỖNG ⇒ 400 EMPTY_REGION_IDS (không âm thầm render tất cả)', async () => {
    const ctx = await startImagelabApp();
    try {
      const buf = headphones();
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: buf.toString('base64'), filename: 'tai-nghe.png' },
      }, SID));
      await waitJob(ctx.base, created.job_id, SID, { until: (d) => d?.job?.status === 'awaiting_review' });

      const res = await postJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/render`, { only_region_ids: [] }, SID);
      assert.equal(res.status, 400, 'mảng rỗng phải bị từ chối, không được render tất cả');
      assert.equal((await j(res)).error.code, 'EMPTY_REGION_IDS');

      const detail = await j(await fetch(`${ctx.base}/api/imagelab/jobs/${created.job_id}`, { headers: cookie(SID) }));
      assert.equal(detail.rendered.length, 0, 'không được sinh ảnh nào khi yêu cầu rỗng');
    } finally {
      await ctx.close();
    }
  });

  test('toàn id KHÔNG khớp ⇒ 409 UNKNOWN_REGION_IDS', async () => {
    const ctx = await startImagelabApp();
    try {
      const buf = headphones();
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: buf.toString('base64'), filename: 'tai-nghe.png' },
      }, SID));
      await waitJob(ctx.base, created.job_id, SID, { until: (d) => d?.job?.status === 'awaiting_review' });

      const res = await postJson(
        ctx.base,
        `/api/imagelab/jobs/${created.job_id}/render`,
        { only_region_ids: ['khong-co-vung-nay'] },
        SID,
      );
      assert.equal(res.status, 409);
      assert.equal((await j(res)).error.code, 'UNKNOWN_REGION_IDS');
    } finally {
      await ctx.close();
    }
  });
});
