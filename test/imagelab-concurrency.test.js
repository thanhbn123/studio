/**
 * MVP-02 — HAI REQUEST RENDER ĐỒNG THỜI.
 *
 * Đây là một trong những mục "chưa đo" đã ghi ở `docs/VERIFICATION.md`: khi hai người/2 tab
 * bấm "Render ảnh" cùng lúc cho CÙNG một job thì chuyện gì xảy ra? Test này khoá lại những
 * điều PHẢI đúng, bất kể bên trong xử lý ra sao:
 *
 *   1. Không có HTTP 5xx (không được sập vì tranh chấp).
 *   2. ẢNH GỐC bất biến (sha256 trên đĩa y hệt trước/sau) — luật #2.
 *   3. Mỗi request được nhận (202) phải để lại ĐÚNG một asset `rendered` hợp lệ, có
 *      `parent_id` trỏ về ảnh gốc, file đọc được, `sha256` trong DB khớp byte trên đĩa.
 *   4. Job kết thúc ở trạng thái cuối (không treo `running`), và KHÔNG có asset rác.
 *
 * Test KHÔNG áp đặt "chỉ được tạo 1 ảnh": hai request là hai ý định riêng, tạo hai bản ghi là
 * chấp nhận được — điều không chấp nhận được là mất dữ liệu, ghi đè ảnh gốc, hay 5xx.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { decodePng, sha256 } from '../src/imagelab/render/index.js';
import {
  cookie,
  headphones,
  j,
  postJson,
  startImagelabApp,
  waitJob,
} from './imagelab-helpers.js';

const SID = 'concurrencySessionCCCC333';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

describe('MVP-02 · hai request render ĐỒNG THỜI trên cùng một job', () => {
  test('không 5xx, ảnh gốc bất biến, mỗi 202 để lại đúng 1 asset hợp lệ, job không treo', async () => {
    const ctx = await startImagelabApp();
    try {
      const buf = headphones();
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: buf.toString('base64'), filename: 'tai-nghe.png' },
      }, SID));
      await waitJob(ctx.base, created.job_id, SID, { until: (d) => d?.job?.status === 'awaiting_review' });

      const before = await j(await fetch(`${ctx.base}/api/imagelab/jobs/${created.job_id}`, { headers: cookie(SID) }));
      assert.equal(before.rendered.length, 0, 'chưa render thì chưa có ảnh nào');
      // Lưu ý: API CỐ Ý không trả `storage_path` (không lộ đường dẫn nội bộ) — muốn đọc file
      // thì lấy bản ghi ĐẦY ĐỦ từ store.
      const originalAsset = before.asset;
      assert.equal(originalAsset.storage_path, undefined, 'API không được lộ storage_path');
      const originalRow = await ctx.store.getImageAsset(originalAsset.id);
      const originalBytesBefore = await ctx.storage.read(originalRow);
      const originalHashBefore = sha(originalBytesBefore);

      // Bắn HAI request cùng lúc — không await từng cái.
      const [resA, resB] = await Promise.all([
        postJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/render`, {}, SID),
        postJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/render`, {}, SID),
      ]);
      const codes = [resA.status, resB.status];
      for (const code of codes) {
        assert.ok(code < 500, `không được có 5xx khi hai request tranh nhau (nhận ${code})`);
        assert.ok([202, 409].includes(code), `chỉ chấp nhận 202 (nhận việc) hoặc 409 (bị chặn), nhận ${code}`);
      }

      // Chờ job về trạng thái cuối (không được treo 'running').
      const done = await waitJob(ctx.base, created.job_id, SID, { tries: 200, delay: 50 });
      assert.ok(
        ['succeeded', 'failed', 'awaiting_review'].includes(done.job.status),
        `job phải ở trạng thái cuối, nhận ${done.job.status}`,
      );

      const accepted = codes.filter((c) => c === 202).length;
      const rendered = done.rendered || [];
      assert.equal(
        rendered.length,
        accepted,
        `${accepted} request được nhận (202) thì phải có đúng ${accepted} asset rendered, nhận ${rendered.length}`,
      );

      // Mỗi asset rendered: parent_id đúng, file đọc được, sha256 khớp byte trên đĩa.
      const renderedRows = await ctx.store.listImageAssets(created.job_id, { role: 'rendered' });
      assert.equal(renderedRows.length, rendered.length, 'store và API phải thấy cùng số ảnh render');
      for (const asset of rendered) {
        assert.equal(asset.role, 'rendered');
        assert.equal(asset.parent_id, originalAsset.id, 'ảnh render phải trỏ về ĐÚNG ảnh gốc');
        assert.notEqual(asset.id, originalAsset.id, 'ảnh render không được trùng id ảnh gốc');

        const row = renderedRows.find((r) => r.id === asset.id);
        assert.ok(row, 'ảnh render trong API phải có bản ghi tương ứng trong store');
        const bytes = await ctx.storage.read(row);
        assert.ok(bytes.length > 0, 'file ảnh render phải đọc được');
        assert.equal(sha(bytes), asset.sha256, 'sha256 trong DB phải khớp byte thật trên đĩa');
        const decoded = decodePng(bytes);
        assert.equal(decoded.width, asset.width);
        assert.equal(decoded.height, asset.height);
      }

      // LUẬT #2: ảnh gốc bất biến — cả trên đĩa lẫn trong DB.
      const originalBytesAfter = await ctx.storage.read(originalRow);
      assert.equal(sha(originalBytesAfter), originalHashBefore, 'ẢNH GỐC KHÔNG ĐƯỢC ĐỔI sau khi render đồng thời');
      const after = await j(await fetch(`${ctx.base}/api/imagelab/jobs/${created.job_id}`, { headers: cookie(SID) }));
      assert.equal(after.asset.sha256, originalAsset.sha256);
      assert.equal(after.asset.id, originalAsset.id);

      // Không có asset rác: tổng asset = 1 gốc + số ảnh render.
      const assets = await ctx.store.listImageAssets(created.job_id);
      assert.equal(assets.length, 1 + rendered.length);
      assert.equal(assets.filter((a) => a.role === 'original').length, 1, 'chỉ được có ĐÚNG MỘT ảnh gốc');
    } finally {
      await ctx.close();
    }
  });

  test('render đồng thời KHÔNG tạo usage_event trùng cho cùng một lần render', async () => {
    const ctx = await startImagelabApp();
    try {
      const buf = headphones();
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: buf.toString('base64'), filename: 'tai-nghe.png' },
      }, SID));
      await waitJob(ctx.base, created.job_id, SID, { until: (d) => d?.job?.status === 'awaiting_review' });

      const [resA, resB] = await Promise.all([
        postJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/render`, {}, SID),
        postJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/render`, {}, SID),
      ]);
      const accepted = [resA.status, resB.status].filter((c) => c === 202).length;
      await waitJob(ctx.base, created.job_id, SID, { tries: 200, delay: 50 });

      const usage = await ctx.store.listUsage(created.job_id);
      const renderEvents = usage.filter((u) => u.operation === 'IMAGE_RENDER');
      assert.equal(
        renderEvents.length,
        accepted,
        `${accepted} request render được nhận thì phải có đúng ${accepted} usage_event IMAGE_RENDER, nhận ${renderEvents.length}`,
      );
      // Ảnh gốc vẫn nguyên vẹn (kiểm lần hai ở ngữ cảnh usage).
      const original = (await ctx.store.listImageAssets(created.job_id, { role: 'original' }))[0];
      assert.equal(sha(await ctx.storage.read(original)), sha(buf), 'bản lưu ảnh gốc phải y hệt ảnh tải lên');
    } finally {
      await ctx.close();
    }
  });
});
