/**
 * TEST — MVP-04 (vòng gộp): NHIỀU ẢNH ⇒ NHIỀU CẢNH chạy end-to-end qua HTTP thật, + các điểm lệch
 * đã được các agent báo (cảnh báo "không có tiếng" bị trùng, `plan_summary` thiếu chữ,
 * `limits` thiếu `max_scenes`, `last_run.run_key` null).
 *
 * Vì sao cần: V5 làm UI chọn nhiều ảnh nhưng chỉ gửi ẢNH ĐẦU ở `image` ⇒ video luôn chỉ có 1 cảnh
 * dù hợp đồng §2.5 hứa "nhiều ảnh ⇒ nhiều cảnh". Test này khoá lại đường thật:
 *   `POST /api/videostudio/jobs { image?, options.scenes[i].image }` ⇒ N ảnh gốc ⇒ plan N cảnh ⇒
 *   GIF có đúng số khung của N cảnh.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { cookie, j, makeTestImage, startImagelabApp } from './imagelab-helpers.js';
import { inspectGif } from '../src/videostudio/encode/index.js';

/** Ảnh PNG khác màu nhau ⇒ sha256 khác nhau (khử trùng theo byte, không theo tên). */
const png = (rgb) => makeTestImage({ width: 120, height: 90, background: [...rgb, 255] }).toString('base64');

const SID = 'sessVSGOPAAAAAAAAAAA';

/** Gọi HTTP thô (helper `request` của MVP-04 chưa có ⇒ tự gói, vẫn là HTTP THẬT). */
const http = async (base, path, { method = 'GET', body = undefined, sid = SID } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...cookie(sid) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
};

/** Tạo job: trả CẢ mã HTTP lẫn body (để khẳng định 202/400/413 như hợp đồng). */
const createJob = async (base, body, sid = SID) => {
  const res = await http(base, '/api/videostudio/jobs', { method: 'POST', body, sid });
  // ⚠️ body của 202 CÓ field `status` = trạng thái JOB ('queued') ⇒ mã HTTP phải để tên khác.
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
  throw new Error(`job video ${jobId} không kết thúc kịp: ${JSON.stringify(last)?.slice(0, 300)}`);
};

describe('MVP-04 · nhiều ảnh ⇒ nhiều cảnh (§2.5) + các điểm lệch đã báo', () => {
  let ctx;
  before(async () => {
    ctx = await startImagelabApp();
  });
  after(async () => {
    await ctx.close();
  });

  test('3 ẢNH (scenes[i].image) ⇒ plan 3 cảnh, asset_id mỗi cảnh khác nhau, GIF đủ khung', async () => {
    const [a, b, c] = [png([200, 30, 30]), png([30, 200, 30]), png([30, 30, 200])];
    const created = await createJob(ctx.base, {
      image: { base64: a, filename: 'a.png' },
      options: {
        preset: 'vuong-1x1',
        scenes: [
          { image: { base64: a, filename: 'a.png' }, duration_ms: 250, text: 'Ao thun nam' },
          { image: { base64: b, filename: 'b.png' }, duration_ms: 250, text: 'Chat cotton' },
          { image: { base64: c, filename: 'c.png' }, duration_ms: 250, text: 'Form rong' },
        ],
      },
    });
    assert.equal(created.http_status, 202, `phải nhận job (nhận ${created.http_status} ${JSON.stringify(created.error ?? '')})`);
    assert.equal(created.asset_ids.length, 3, `phải lưu ĐỦ 3 ảnh gốc, nhận ${JSON.stringify(created.asset_ids)}`);
    assert.equal(created.asset_id, created.asset_ids[0], '`asset_id` = ảnh ĐẦU (khoá đóng băng §2.4)');

    const data = await waitVsJob(ctx.base, created.job_id);
    assert.equal(data?.job?.status, 'succeeded', `job phải thành công, nhận ${data?.job?.status}/${data?.job?.error_code}`);
    assert.equal(data.plan.scene_count, 3, 'plan phải có ĐÚNG 3 cảnh (bằng số ảnh nhận được)');

    const ids = data.plan.scenes.map((s) => s.asset_id);
    assert.equal(new Set(ids).size, 3, `mỗi cảnh một ảnh khác nhau, nhận ${JSON.stringify(ids)}`);
    assert.deepEqual([...ids].sort(), [...created.asset_ids].sort(), 'asset_id của cảnh phải lấy từ ảnh ĐÃ LƯU');
    assert.deepEqual(
      data.plan.scenes.map((s) => s.duration_ms),
      [250, 250, 250],
      'thời lượng từng cảnh phải theo yêu cầu (kẹp theo luật của V1 nếu dưới sàn)',
    );

    // GIF THẬT: số khung = tổng thời lượng × fps (12) ⇒ 0,75s ⇒ 9 khung.
    const rendered = data.rendered[data.rendered.length - 1];
    assert.ok(rendered?.id, 'phải có asset `rendered` (GIF)');
    const fileRes = await fetch(`${ctx.base}/api/videostudio/assets/${rendered.id}/file`, { headers: cookie(SID) });
    assert.equal(fileRes.status, 200);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    const info = inspectGif(buf);
    assert.equal(info.valid, true, 'GIF phải hợp lệ theo bộ đọc ĐỘC LẬP');
    assert.equal(info.width, 900);
    assert.equal(info.height, 900);
    assert.equal(info.frames, data.plan.frame_count, `số khung GIF phải khớp plan (${info.frames} vs ${data.plan.frame_count})`);
    assert.equal(info.frames, 9, `3 cảnh × 250ms × 12fps = 9 khung, nhận ${info.frames}`);
    assert.equal(rendered.meta?.scene_count ?? data.plan.scene_count, 3);
  });

  test('ĐỐI CHỨNG NGƯỢC: 1 ảnh (chỉ `image`) ⇒ vẫn 1 cảnh như trước, không hồi quy', async () => {
    const created = await createJob(ctx.base, {
      image: { base64: png([10, 10, 10]), filename: 'one.png' },
      options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250 }] },
    });
    assert.equal(created.http_status, 202);
    assert.equal(created.asset_ids.length, 1);
    const data = await waitVsJob(ctx.base, created.job_id);
    assert.equal(data?.job?.status, 'succeeded');
    assert.equal(data.plan.scene_count, 1);
  });

  test('CHỈ `scenes[i].image` (không có `image` top-level) ⇒ vẫn nhận job', async () => {
    const created = await createJob(ctx.base, {
      options: {
        preset: 'vuong-1x1',
        scenes: [
          { image: { base64: png([120, 60, 20]) }, duration_ms: 250 },
          { image: { base64: png([20, 120, 60]) }, duration_ms: 250 },
        ],
      },
    });
    assert.equal(created.http_status, 202, `scenes-only phải chạy được, nhận ${created.http_status} ${JSON.stringify(created.error ?? '')}`);
    assert.equal(created.asset_ids.length, 2);
    const data = await waitVsJob(ctx.base, created.job_id);
    assert.equal(data?.job?.status, 'succeeded');
    assert.equal(data.plan.scene_count, 2);
  });

  test('KHÔNG có ảnh nào ⇒ 400 MISSING_IMAGE; ảnh TRÙNG byte ⇒ khử còn 1 cảnh; quá trần ⇒ 413', async () => {
    const missing = await createJob(ctx.base, { options: { preset: 'vuong-1x1' } });
    assert.equal(missing.http_status, 400);
    assert.equal(missing.error.code, 'MISSING_IMAGE');

    const dup = png([77, 77, 77]);
    const deduped = await createJob(ctx.base, {
      image: { base64: dup },
      options: {
        preset: 'vuong-1x1',
        scenes: [{ image: { base64: dup }, duration_ms: 250 }, { image: { base64: dup }, duration_ms: 250 }],
      },
    });
    assert.equal(deduped.http_status, 202);
    assert.equal(deduped.asset_ids.length, 1, 'ảnh trùng byte chỉ là MỘT cảnh');

    const many = await createJob(ctx.base, {
      image: { base64: png([1, 2, 3]) },
      options: { scenes: Array.from({ length: 30 }, () => ({ duration_ms: 250 })) },
    });
    assert.equal(many.http_status, 413);
    assert.equal(many.error.code, 'TOO_MANY_SCENES');
  });

  test('presets: `limits.max_scenes` có mặt (UI không phải đoán) + đúng giá trị chặn 413', async () => {
    const res = await j(await http(ctx.base, '/api/videostudio/presets'));
    assert.ok(Number.isInteger(res.limits?.max_scenes) && res.limits.max_scenes > 0, `limits.max_scenes phải có, nhận ${JSON.stringify(res.limits)}`);
    assert.equal(res.limits.max_scenes, 24, 'khớp trần đang chặn 413 TOO_MANY_SCENES');
  });

  test('cảnh báo "KHÔNG có tiếng" chỉ MỘT câu (V1 + V3 không còn phát trùng)', async () => {
    const created = await createJob(ctx.base, {
      image: { base64: png([9, 40, 90]) },
      options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250, text: 'Ao thun nam' }] },
    });
    const data = await waitVsJob(ctx.base, created.job_id);
    assert.equal(data?.job?.status, 'succeeded');
    const noAudio = (data.warnings ?? []).filter((w) => /KHÔNG có tiếng/i.test(String(w)));
    assert.equal(noAudio.length, 1, `đúng MỘT câu cảnh báo không tiếng, nhận ${JSON.stringify(noAudio)}`);
    assert.equal(new Set(data.warnings).size, data.warnings.length, 'danh sách cảnh báo không được trùng câu');
    assert.equal(data.audio, null, 'audio phải là null (§0 luật 2)');
    assert.equal(data.rendered[data.rendered.length - 1].meta?.audio, null, 'audio cũng phải null trong asset đã lưu');
  });

  test('mở lại job: `plan.scenes[].texts` giữ NỘI DUNG CHỮ đã vẽ + `last_run.run_key` có thật', async () => {
    const created = await createJob(ctx.base, {
      image: { base64: png([50, 90, 10]) },
      options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250, text: 'Ao thun nam', subtitle: 'Chat cotton' }] },
    });
    const data = await waitVsJob(ctx.base, created.job_id);
    assert.equal(data?.job?.status, 'succeeded');
    const texts = (data.plan.scenes[0].texts ?? []).map((t) => t.text);
    assert.deepEqual(texts, ['Ao thun nam', 'Chat cotton'], `ô chữ phải hiện lại được, nhận ${JSON.stringify(texts)}`);
    for (const t of data.plan.scenes[0].texts) {
      assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.size), 'mỗi đoạn chữ phải có vị trí/cỡ để dựng lại UI');
      assert.ok(!JSON.stringify(t).includes('base64') && !JSON.stringify(t).includes('/'), 'plan_summary KHÔNG được chứa dữ liệu nhạy cảm/đường dẫn');
    }
    assert.ok(typeof data.last_run?.run_key === 'string' && data.last_run.run_key.length > 0, `last_run.run_key phải có để đối chiếu sổ ví, nhận ${JSON.stringify(data.last_run?.run_key ?? null)}`);
  });
});
