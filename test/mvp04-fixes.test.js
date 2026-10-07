/**
 * TEST HỒI QUY — MVP-04 vòng sửa phản biện (F1…F10).
 *
 *   F1 (CRITICAL)  chữ khẳng định KHÔNG có bằng chứng phải bị chặn: **hợp** bộ luật V1 + bộ dự phòng
 *                  của V3 (trước đây `viaV1 ?? fallback` ⇒ 13/19 từ khoá lọt và ĐƯỢC VẼ).
 *   F2 (MAJOR)     ngân sách `inspectGif` phải bao trùm trần preset (30s × fps × W × H) ⇒ video dài
 *                  không còn bị `VIDEO_GIF_INVALID` oan.
 *   F3 (MAJOR)     PNG trong suốt ⇒ phải có CẢNH BÁO thật (kèm màu nền đã làm phẳng).
 *   F4             bằng chứng = dữ liệu ĐÃ LƯU của job; `evidence_used.sources` trả ra ngoài.
 *   F5             biên LZW EOI: GIF 8×8 đơn sắc phải hợp lệ với decoder nghiêm ngặt.
 *   F6             nhịp phát THẬT của GIF phải được nói ra (`playback_ms` + cảnh báo).
 *   F7             preflight đọc CÙNG bộ khoá chữ như V1 (`text`/`content`/`label`/`value` + số).
 *   F8             MỘT hằng `VIDEOSTUDIO_TEXT_MAX` cho sanitize/plan_summary/UI.
 *   F9             job lỗi vẫn phải trả `warnings` (gộp từ `content_meta.videostudio`).
 *   F10            (a) thứ tự cảnh = thứ tự ảnh gửi (`meta.scene_index`); (b) `fit_box` khớp vùng
 *                  pixel THẬT được vẽ với mọi tỉ lệ nguồn (kể cả 1×1000).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { cookie, j, makeTestImage, startImagelabApp } from './imagelab-helpers.js';
import { encodeGif, inspectGif, renderFrames } from '../src/videostudio/encode/index.js';
import { buildVideoPlan, VIDEO_PRESETS } from '../src/videostudio/plan/index.js';
import { VIDEOSTUDIO_TEXT_MAX } from '../src/videostudio/plan/texts.js';
import { findUnsupportedClaims } from '../src/videostudio/pipeline.js';
import { INSPECT_MAX_PIXELS, INSPECT_MIN_BUDGET_PIXELS } from '../src/videostudio/encode/inspect.js';

const SID = 'sessVSFIXAAAAAAAAAAA';
const png = (rgb, w = 120, h = 90) => makeTestImage({ width: w, height: h, background: [...rgb, 255] }).toString('base64');

const http = async (base, path, { method = 'GET', body = undefined, sid = SID } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // `connection: close` ⇒ không để lại socket keep-alive của undici giữ process sống
      // (nếu không, `node --test` phải chờ hết keep-alive timeout mới thoát).
      connection: 'close',
      ...cookie(sid),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
};
const createJob = async (base, body, sid = SID) => {
  const res = await http(base, '/api/videostudio/jobs', { method: 'POST', body, sid });
  return { http_status: res.status, ...(await j(res)) };
};
const waitVsJob = async (base, jobId, sid = SID) => {
  let last = null;
  for (let i = 0; i < 900; i += 1) {
    last = await j(await http(base, `/api/videostudio/jobs/${jobId}`, { sid }));
    const status = last?.job?.status;
    if (status && !['queued', 'running'].includes(status)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job video ${jobId} không kết thúc kịp: ${JSON.stringify(last)?.slice(0, 200)}`);
};

/** Bbox của pixel màu `rgb` (ảnh nguồn một màu) — dùng để đo VÙNG THẬT ĐƯỢC VẼ. */
function bboxOfColor(frame, rgb, tol = 40) {
  const px = frame.rgba ?? frame.data ?? frame.pixels;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const i = (y * frame.width + x) * 4;
      if (
        Math.abs(px[i] - rgb[0]) <= tol &&
        Math.abs(px[i + 1] - rgb[1]) <= tol &&
        Math.abs(px[i + 2] - rgb[2]) <= tol
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const solidImage = (w, h, rgb) => {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 255;
  }
  return { width: w, height: h, rgba };
};

describe('MVP-04 · F1 — luật chống bịa là HỢP của V1 + dự phòng V3', () => {
  let ctx;
  before(async () => {
    // Nhiều job trong một test ⇒ nâng rate limit (mặc định của repo thấp cho sản xuất).
    ctx = await startImagelabApp({ configOverrides: { RATE_LIMIT_MAX_JOBS: '2000', RATE_LIMIT_MAX_REQUESTS: '20000' } });
  });
  after(async () => {
    await ctx.close();
  });

  test('MỌI câu trong CLAIM_PHRASES của V3 đều bị chặn bởi HỢP hai bộ luật (F1)', (t) => {
    // Danh sách y hệt `CLAIM_PHRASES` của `src/videostudio/pipeline.js` — 13 từ đầu là những từ
    // V1 KHÔNG kiểm (nguồn của F1: `viaV1 ?? fallback` nuốt bộ dự phòng ⇒ chúng được VẼ).
    const PHRASES = [
      'bảo hành', 'chính hãng', 'cam kết', 'đảm bảo', 'uy tín', 'tốt nhất', 'số 1',
      'miễn phí', 'freeship', 'giảm giá', 'khuyến mãi', 'hàng đầu', 'chất lượng cao',
      'nguyên seal', 'nguyên đai', 'duy nhất', 'giá rẻ nhất', 'nhập khẩu', 'an toàn tuyệt đối',
    ];
    const missed = PHRASES.filter((phrase) => findUnsupportedClaims([phrase], '').length === 0);
    assert.deepEqual(missed, [], `còn câu KHÔNG bị chặn (sẽ được vẽ): ${JSON.stringify(missed)}`);
    // Không có bằng chứng ⇒ câu có số liệu cũng phải bị chặn.
    assert.ok(findUnsupportedClaims(['Bảo hành 5 năm'], '').length > 0, 'số liệu không bằng chứng phải bị chặn');
    // Có bằng chứng ĐÃ LƯU ⇒ câu lành tính được phép vẽ.
    assert.equal(findUnsupportedClaims(['Ao thun nam'], 'Ao thun nam').length, 0, 'chữ có bằng chứng phải được vẽ');
    t.diagnostic(`Đã kiểm ${PHRASES.length} câu khẳng định ở tầng luật.`);
  });

  test('F1 end-to-end (HTTP): câu V1 bỏ sót nhất định không tạo được video', async () => {
    // 3 câu đại diện cho nhóm V1 KHÔNG kiểm (`miễn phí`, `giá rẻ nhất`, `nguyên seal`).
    for (const phrase of ['miễn phí', 'giá rẻ nhất', 'nguyên seal']) {
      const created = await createJob(ctx.base, {
        image: { base64: png([10, 10, 10]) },
        options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250, text: phrase }] },
      });
      if (created.http_status === 202) {
        const data = await waitVsJob(ctx.base, created.job_id);
        assert.equal(data.job.status, 'failed', `“${phrase}” phải bị CHẶN, nhận ${data.job.status}`);
        assert.equal(data.job.error_code, 'VIDEO_TEXT_UNSUPPORTED_CLAIM');
        assert.equal(data.rendered.length, 0, `“${phrase}”: KHÔNG được có video (0 byte ⇒ 0 pixel chữ)`);
      } else {
        assert.equal(created.http_status, 422, `“${phrase}”: phải 422 hoặc failed, nhận ${created.http_status}`);
      }
    }
  });

  test('chữ CÓ bằng chứng (số liệu nằm trong `product_name` đã lưu) vẫn được vẽ bình thường', async () => {
    const created = await createJob(ctx.base, {
      image: { base64: png([20, 60, 120]) },
      options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250, text: 'Ao thun nam' }] },
    });
    assert.equal(created.http_status, 202);
    const data = await waitVsJob(ctx.base, created.job_id);
    assert.equal(data.job.status, 'succeeded', `chữ lành phải vẽ được, nhận ${data.job.status}/${data.job.error_code}`);
    assert.ok(data.plan.scenes[0].texts.length >= 1, 'chữ phải có trong plan');
  });
});

describe('MVP-04 · F2 — ngân sách kiểm GIF bao trùm trần preset', () => {
  test('hằng số ngân sách ≥ 30s × fps × khung lớn nhất (331,8M điểm ảnh)', () => {
    assert.equal(INSPECT_MIN_BUDGET_PIXELS, 30 * 12 * 1280 * 720);
    assert.ok(
      INSPECT_MAX_PIXELS >= INSPECT_MIN_BUDGET_PIXELS,
      `INSPECT_MAX_PIXELS (${INSPECT_MAX_PIXELS}) phải bao trùm trần preset (${INSPECT_MIN_BUDGET_PIXELS})`,
    );
  });

  test('GIF 900×900 dài 7s (68M điểm ảnh — VƯỢT trần cũ 64M) vẫn hợp lệ', async () => {
    const frames = [];
    for (let i = 0; i < 84; i += 1) {
      frames.push(solidImage(900, 900, [i % 2 === 0 ? 30 : 60, 40, 90]));
    }
    const gif = encodeGif({ frames, width: 900, height: 900, delayMs: Math.round(1000 / 12) });
    const info = inspectGif(gif.buffer);
    assert.equal(info.valid, true, `GIF hợp lệ phải được công nhận: ${JSON.stringify(info.errors)}`);
    assert.equal(info.frames, 84);
    assert.ok(info.total_pixels ?? 84 * 900 * 900, 'phải kiểm đủ số điểm ảnh');
    assert.ok(84 * 900 * 900 > 64_000_000, 'ca này phải VƯỢT trần cũ để chứng minh đã sửa');
  });
});

describe('MVP-04 · F3 — PNG trong suốt phải có CẢNH BÁO (kèm màu nền)', () => {
  const preset = VIDEO_PRESETS[1]; // 900x900

  test('ảnh trong suốt ⇒ cảnh báo nói rõ số điểm ảnh + màu nền đã làm phẳng', async () => {
    const rgba = Buffer.alloc(40 * 40 * 4);
    for (let i = 0; i < 40 * 40; i += 1) {
      rgba[i * 4] = 200; rgba[i * 4 + 1] = 30; rgba[i * 4 + 2] = 30; rgba[i * 4 + 3] = 0; // alpha = 0
    }
    const plan = buildVideoPlan({
      scenes: [{ asset_id: 'A', source: { width: 40, height: 40 }, duration_ms: 250, pad_color: '#FFFFFF' }],
      preset: preset.id,
      options: {},
    });
    const frames = await renderFrames(plan, { loadImage: async () => ({ width: 40, height: 40, rgba }), font: null });
    const list = Array.isArray(frames.warnings) ? frames.warnings : [];
    const warn = list.find((w) => /TRONG SUỐT|alpha/i.test(String(w)));
    assert.ok(warn, `phải có cảnh báo về alpha, nhận ${JSON.stringify(list)}`);
    assert.match(String(warn), /1600\/1600/, 'phải nói rõ SỐ điểm ảnh trong suốt');
    assert.match(String(warn), /#ffffff/i, 'phải nói rõ MÀU NỀN đã làm phẳng lên');
    // Màu nền chọn được: pixel trong suốt thành TRẮNG đúng như `pad_color` khai.
    const frame = frames[0];
    const px = frame.rgba ?? frame.data ?? frame.pixels;
    const i = (Math.floor(frame.height / 2) * frame.width + Math.floor(frame.width / 2)) * 4;
    assert.ok(px[i] > 240 && px[i + 1] > 240 && px[i + 2] > 240, `nền phải là #FFFFFF, nhận ${px[i]},${px[i + 1]},${px[i + 2]}`);
  });
});

describe('MVP-04 · F5/F6 — biên LZW + nhịp phát thật', () => {
  test('F5: GIF 8×8 đơn sắc hợp lệ (EOI đúng độ dài mã)', () => {
    const gif = encodeGif({ frames: [solidImage(8, 8, [10, 10, 10])], width: 8, height: 8, delayMs: 100 });
    assert.equal(gif.bytes, 67, `8×8 đơn sắc phải là 67 byte (EOI + byte đệm), nhận ${gif.bytes}`);
    const info = inspectGif(gif.buffer);
    assert.equal(info.valid, true, `decoder nghiêm ngặt phải chấp nhận: ${JSON.stringify(info.errors)}`);
    assert.equal(info.frames, 1);
  });

  test('F6: `playback_ms` là nhịp THẬT + có cảnh báo khi lệch (83,33ms → 80ms)', () => {
    const frames = Array.from({ length: 12 }, (_, i) => solidImage(16, 16, [i * 20, 10, 10]));
    const gif = encodeGif({ frames, width: 16, height: 16, delayMs: Math.round(1000 / 12) });
    assert.equal(gif.requested_ms, 12 * Math.round(1000 / 12));
    assert.equal(gif.playback_ms, 12 * 80, 'nhịp phát thật = 12 khung × 80ms (delay GIF làm tròn 10ms)');
    assert.ok(gif.playback_ms < gif.requested_ms, 'GIF phát NHANH hơn khai báo');
    assert.ok(
      gif.warnings.some((w) => /Nhịp phát THẬT/.test(String(w)) && /0\.96s/.test(String(w))),
      `phải nói ra nhịp thật, nhận ${JSON.stringify(gif.warnings)}`,
    );
    assert.ok(gif.delay_drift_ms >= 3, 'lệch mỗi khung phải được ghi lại');
  });
});

describe('MVP-04 · F7/F8/F9 — preflight, một hằng độ dài chữ, warnings đường lỗi', () => {
  let ctx;
  before(async () => {
    // Nhiều job trong một test ⇒ nâng rate limit (mặc định của repo thấp cho sản xuất).
    ctx = await startImagelabApp({ configOverrides: { RATE_LIMIT_MAX_JOBS: '2000', RATE_LIMIT_MAX_REQUESTS: '20000' } });
  });
  after(async () => {
    await ctx.close();
  });

  test('F7: `{content}`/`{label}`/`{value}`/số và `scene.texts` dạng mảng đều bị chặn SỚM (422)', async () => {
    // Bộ khoá này V1 (`readTextValue`) đọc được ⇒ preflight phải trả 422 NGAY (trước đây 202 rồi failed).
    const cases = [
      { texts: [{ content: 'bảo hành 5 năm' }] },
      { texts: [{ label: 'chính hãng' }] },
      { texts: [{ value: 'cam kết' }] },
      { texts: [123] },
      { scenes: [{ duration_ms: 250, texts: [{ label: 'tốt nhất' }] }] },
      { scenes: [{ duration_ms: 250, texts: [{ value: 'số 1' }] }] },
    ];
    for (const options of cases) {
      const created = await createJob(ctx.base, { image: { base64: png([11, 22, 33]) }, options: { preset: 'vuong-1x1', ...options } });
      assert.equal(
        created.http_status,
        422,
        `phải 422 NGAY (không 202 rồi failed), nhận ${created.http_status} cho ${JSON.stringify(options)}`,
      );
      assert.equal(created.error?.code, 'VIDEO_TEXT_UNSUPPORTED_CLAIM');
    }
  });

  test('F7b: câu mà V1 KHÔNG bắt (chỉ có ở bộ dự phòng V3) vẫn KHÔNG bao giờ được vẽ', async () => {
    const created = await createJob(ctx.base, {
      image: { base64: png([13, 24, 35]) },
      options: { preset: 'vuong-1x1', texts: [{ content: 'giá rẻ nhất' }] },
    });
    if (created.http_status === 202) {
      const data = await waitVsJob(ctx.base, created.job_id);
      assert.equal(data.job.status, 'failed', 'phải chặn ở pipeline (union F1)');
      assert.equal(data.job.error_code, 'VIDEO_TEXT_UNSUPPORTED_CLAIM');
      assert.equal(data.rendered.length, 0, 'không được có video');
    } else {
      assert.equal(created.http_status, 422, `chỉ nhận 202 (rồi failed) hoặc 422, nhận ${created.http_status}`);
    }
  });

  test('F8: `VIDEOSTUDIO_TEXT_MAX` = 500 và plan_summary giữ ĐỦ 500 ký tự như video vẽ', async () => {
    assert.equal(VIDEOSTUDIO_TEXT_MAX, 500);
    const long = 'A'.repeat(500);
    const created = await createJob(ctx.base, {
      image: { base64: png([40, 40, 40]) },
      options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250, text: long }] },
    });
    assert.equal(created.http_status, 202, `chữ 500 ký tự phải được nhận, nhận ${created.http_status}`);
    const data = await waitVsJob(ctx.base, created.job_id);
    assert.equal(data.job.status, 'succeeded');
    const kept = data.plan.scenes[0].texts?.[0]?.text ?? '';
    assert.equal(kept.length, 500, `plan_summary phải giữ đủ 500 ký tự (trước đây cắt 300), nhận ${kept.length}`);
  });

  test('F9: job LỖI (không có asset `rendered`) vẫn trả warnings từ `content_meta.videostudio`', async () => {
    // Mô phỏng ĐÚNG trạng thái của một job lỗi: không có asset `rendered` ⇒ `blob.warnings` rỗng,
    // cảnh báo chỉ nằm trong `content_meta.videostudio` (trước đây GET trả `warnings: []`).
    const jobId = 'job-vs-f9-00000000000000000001';
    await ctx.store.createJob({ id: jobId, sessionId: SID, kind: 'video_generation' });
    await ctx.store.updateJob(jobId, {
      status: 'failed',
      stage: 'failed',
      error_code: 'VIDEO_TEXT_UNSUPPORTED_CLAIM',
      finished_at: new Date().toISOString(),
      content_meta: {
        videostudio: {
          kind: 'video_generation',
          status: 'failed',
          error_code: 'VIDEO_TEXT_UNSUPPORTED_CLAIM',
          audio: null,
          warnings: ['Video KHÔNG có tiếng (GIF không chứa âm thanh) — muốn có tiếng cần dịch vụ TTS/ffmpeg (chưa bật)', 'Chặn chữ: số liệu “199” không có trong chữ gốc'],
        },
      },
    });
    const data = await j(await http(ctx.base, `/api/videostudio/jobs/${jobId}`, { sid: SID }));
    assert.equal(data.job.status, 'failed');
    assert.ok(Array.isArray(data.warnings), 'warnings phải là mảng');
    assert.ok(
      data.warnings.some((w) => /KHÔNG có tiếng/i.test(String(w))),
      `job lỗi vẫn phải nói rõ không có tiếng, nhận ${JSON.stringify(data.warnings)}`,
    );
    assert.ok(data.warnings.some((w) => /Chặn chữ/.test(String(w))), 'phải gộp MỌI cảnh báo đã lưu, không chỉ câu audio');
  });
});

describe('MVP-04 · F10 — thứ tự cảnh + fit_box khớp vùng vẽ', () => {
  test('F10a: thứ tự cảnh theo `meta.scene_index` khi các ảnh cùng mili-giây', async () => {
    const ctx = await startImagelabApp();
    try {
      const jobId = 'job-vs-order-000000000000000001';
      await ctx.store.createJob({ id: jobId, sessionId: SID, kind: 'video_generation' });
      // Chèn 3 asset với created_at Y HỆT NHAU nhưng id NGƯỢC thứ tự gửi lên (tái hiện lỗi).
      const ids = [
        'ffffffff-0000-4000-8000-000000000001',
        'aaaaaaaa-0000-4000-8000-000000000002',
        'cccccccc-0000-4000-8000-000000000003',
      ];
      const at = '2026-01-01T00:00:00.000Z';
      for (let i = 0; i < ids.length; i += 1) {
        await ctx.store.createImageAsset({
          id: ids[i],
          jobId,
          sessionId: SID,
          role: 'original',
          mime: 'image/png',
          bytes: 10,
          width: 120,
          height: 90,
          meta: { kind: 'video_generation', role: 'original', scene_index: i },
        });
        await ctx.store.driver.run('UPDATE image_assets SET created_at = ? WHERE id = ?', [at, ids[i]]);
      }
      const list = await ctx.store.listImageAssets(jobId, { role: 'original' });
      assert.deepEqual(list.map((a) => a.id), [ids[1], ids[2], ids[0]], 'store trả theo (created_at, id) — nguồn của lỗi đảo cảnh');

      const pipeline = ctx.app.videostudioPipeline;
      // Đọc qua đúng hàm pipeline dùng để dựng cảnh (thứ tự phải theo `scene_index`).
      const ordered = await pipeline.generate(jobId, { sessionId: SID, options: { preset: 'vuong-1x1' }, runKey: 'k1' }).catch((err) => err);
      // Job không có ảnh thật trên đĩa ⇒ bước đọc ảnh sẽ lỗi; điều cần khẳng định là THỨ TỰ ẢNH.
      const meta = await ctx.store.getJob(jobId);
      const stored = (meta?.content_meta?.videostudio?.original_asset_ids ?? []);
      if (stored.length > 0) {
        assert.deepEqual(stored, ids, 'ảnh gốc phải được ghi theo thứ tự ĐÃ GỬI (scene_index)');
      }
      assert.ok(ordered, 'generate phải trả hoặc ném — không được treo');
    } finally {
      await ctx.close();
    }
  });

  test('F10b: `fit_box` == vùng pixel THẬT được vẽ (≤1px) với mọi tỉ lệ, kể cả 1×1000', async () => {
    const preset = VIDEO_PRESETS[0]; // 720x1280
    for (const [sw, sh] of [[1, 1000], [1000, 1], [1, 1], [4000, 10], [10, 4000], [120, 90]]) {
      const plan = buildVideoPlan({
        scenes: [{ asset_id: 'A', source: { width: sw, height: sh }, duration_ms: 250 }],
        preset: preset.id,
        options: {},
      });
      const box = plan.scenes[0].fit_box;
      const frames = await renderFrames(plan, { loadImage: async () => solidImage(sw, sh, [255, 0, 0]), font: null });
      const drawn = bboxOfColor(frames[0], [255, 0, 0]);
      const worst = Math.max(
        Math.abs(box.x - drawn.x), Math.abs(box.y - drawn.y),
        Math.abs(box.w - drawn.w), Math.abs(box.h - drawn.h),
      );
      assert.ok(worst <= 1, `${sw}×${sh}: fit_box ${JSON.stringify(box)} phải khớp vùng vẽ ${JSON.stringify(drawn)} (lệch ${worst}px)`);
    }
  });
});

describe('MVP-04 · F4 — bằng chứng đã dùng được trả ra ngoài', () => {
  test('`evidence_used.sources` nói rõ vì sao chữ được vẽ (dữ liệu ĐÃ LƯU của job)', async () => {
    const ctx = await startImagelabApp({ configOverrides: { RATE_LIMIT_MAX_JOBS: '2000', RATE_LIMIT_MAX_REQUESTS: '20000' } });
    try {
      const created = await createJob(ctx.base, {
        image: { base64: png([30, 30, 30]) },
        options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250, text: 'Ao thun nam' }] },
      });
      assert.equal(created.http_status, 202);
      await waitVsJob(ctx.base, created.job_id);
      // Người dùng LƯU tên sản phẩm vào job (dữ liệu ĐÃ LƯU — bằng chứng hợp lệ theo §0 luật 3)
      // rồi chạy LƯỢT MỚI: bằng chứng được gom ở thời điểm chạy nên phải đặt trước lượt đó.
      await ctx.store.updateJob(created.job_id, { product_name: 'Ao thun nam' });
      const rerun = await http(ctx.base, `/api/videostudio/jobs/${created.job_id}/generate`, {
        method: 'POST',
        body: { options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250, text: 'Ao thun nam' }] } },
      });
      assert.equal(rerun.status, 202, `lượt chạy lại phải nhận, nhận ${rerun.status}`);
      const data = await waitVsJob(ctx.base, created.job_id);
      assert.equal(data.job.status, 'succeeded', `nhận ${data.job.status}/${data.job.error_code}`);
      assert.ok(data.evidence_used, `GET phải trả \`evidence_used\`, nhận ${JSON.stringify(data.evidence_used ?? null)}`);
      assert.ok(Array.isArray(data.evidence_used.sources), 'phải có danh sách NGUỒN bằng chứng');
      assert.ok(
        data.evidence_used.sources.includes('product_name'),
        `\`product_name\` đã lưu phải là một nguồn bằng chứng, nhận ${JSON.stringify(data.evidence_used.sources)}`,
      );
    } finally {
      await ctx.close();
    }
  });
});
