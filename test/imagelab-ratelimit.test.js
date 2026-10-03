/**
 * MVP-02 — RATE LIMIT CHO CÁC ROUTE DÙNG NHIỀU TÀI NGUYÊN.
 *
 * Agent test vòng trước đã ghi rõ đây là mục CHƯA phủ: route `/api/imagelab/*` có gọi
 * `rateLimiters.jobs` nhưng chưa có test nào khẳng định nó thật sự chặn. File này khoá lại.
 *
 * Hạ `RATE_LIMIT_MAX_JOBS` xuống 2 để test nhanh và tất định (không phải bắn 11 request thật).
 *
 * ⚠️ LƯU Ý ĐÃ TRẢ GIÁ: `sessionId()` (src/http/server.js) chỉ nhận cookie `sid` khớp
 * `/^[A-Za-z0-9_-]{16,64}$/`; sid NGẮN HƠN 16 ký tự sẽ bị server CẤP SID MỚI cho mỗi request,
 * khiến job tạo ở request này không đọc được ở request sau (404 "không tìm thấy job"). Vì vậy
 * mọi sid trong file này đều ≥ 16 ký tự.
 *
 * Ảnh dùng fixture `headphones.png` (320×320) — ảnh 8×8 quá nhỏ nên vùng chữ của fixture OCR
 * bị cắt hết, job sẽ dừng ở `IMAGELAB_NO_LINES` (409) chứ không tới bước render.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  cookie,
  headphones,
  j,
  postJson,
  startImagelabApp,
  waitJob,
} from './imagelab-helpers.js';

const SID_A = 'rateLimitSessionAAAA'; // 20 ký tự — hợp lệ
const SID_B = 'rateLimitSessionBBBB';

describe('MVP-02 · rate limit route imagelab', () => {
  test('vượt hạn mức POST /render → 429 RATE_LIMITED (không 5xx)', async () => {
    const ctx = await startImagelabApp({ configOverrides: { RATE_LIMIT_MAX_JOBS: '2' } });
    try {
      const png = headphones();
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: png.toString('base64'), filename: 'tai-nghe.png' },
      }, SID_A));
      await waitJob(ctx.base, created.job_id, SID_A, { until: (d) => d?.job?.status === 'awaiting_review' });

      const codes = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await postJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/render`, {}, SID_A);
        codes.push(res.status);
        if (res.status === 429) {
          const body = await j(res);
          assert.equal(body.error.code, 'RATE_LIMITED');
        }
      }

      assert.deepEqual(codes.slice(0, 2), [202, 202], `2 request đầu phải được nhận, nhận ${codes.join(',')}`);
      assert.equal(codes[2], 429, `request thứ 3 phải bị chặn 429, nhận ${codes[2]}`);
      for (const code of codes) assert.ok(code < 500, 'không được có 5xx khi vượt hạn mức');
    } finally {
      await ctx.close();
    }
  });

  test('session KHÁC có hạn mức RIÊNG, không bị liên đới', async () => {
    const ctx = await startImagelabApp({ configOverrides: { RATE_LIMIT_MAX_JOBS: '1' } });
    try {
      const png = headphones();
      const mk = async (sid) => {
        const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
          image: { base64: png.toString('base64'), filename: 'tai-nghe.png' },
        }, sid));
        await waitJob(ctx.base, created.job_id, sid, { until: (d) => d?.job?.status === 'awaiting_review' });
        return created.job_id;
      };

      const jobA = await mk(SID_A);
      const jobB = await mk(SID_B);

      const a1 = await postJson(ctx.base, `/api/imagelab/jobs/${jobA}/render`, {}, SID_A);
      const a2 = await postJson(ctx.base, `/api/imagelab/jobs/${jobA}/render`, {}, SID_A);
      const b1 = await postJson(ctx.base, `/api/imagelab/jobs/${jobB}/render`, {}, SID_B);

      assert.equal(a1.status, 202, 'session A: request đầu được nhận');
      assert.equal(a2.status, 429, 'session A: request thứ hai đã vượt hạn mức 1');
      assert.equal(b1.status, 202, 'session B phải có hạn mức RIÊNG, không bị A làm liên đới');

      // b1 mới là "nhận việc" (202) — phải CHỜ job chạy xong rồi mới kiểm ảnh.
      const doneB = await waitJob(ctx.base, jobB, SID_B, { tries: 200, delay: 50 });
      assert.ok(['succeeded', 'failed'].includes(doneB.job.status), `job B phải kết thúc, nhận ${doneB.job.status}`);
      assert.equal(doneB.rendered.length, 1);
      assert.equal(doneB.asset.role, 'original');
    } finally {
      await ctx.close();
    }
  });
});
