/**
 * TEST HỒI QUY ĐỘC LẬP — F-02 (MAJOR) và F-06 (MINOR) sau phản biện.
 *
 * F-02: `allow_brand_override: true` phải có tác dụng THẬT lên ảnh — nhưng CHỈ khi
 *       dòng có VẾT (`edited_by_user = true` + `provenance = 'user'` + `text_vi` khác rỗng).
 *       Không có vết ⇒ không vẽ, dù DB có chữ.
 * F-06: dòng `NEEDS_REVIEW` (kể cả `edited_by_user = true`) vẫn chặn render bằng 409 khi
 *       không `force`; `action: 'skip'` ⇒ `SKIPPED_BY_USER`, không chặn render, và luôn
 *       xuất hiện trong `skipped` kèm lý do.
 *
 * Mọi khẳng định đều kiểm bằng PIXEL thật tải từ `/api/imagelab/assets/:id/file`
 * (không tin `applied`/`skipped` tự khai).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  countChangedPixels,
  cookie,
  headphones,
  j,
  postJson,
  putJson,
  startImagelabApp,
  waitJob,
} from './imagelab-helpers.js';
import { loadRenderIlWarnings } from './imagelab-ui-helpers.js';

let ctx;
let sidSeq = 0;
const nextSid = () => `f02Session${String((sidSeq += 1)).padStart(4, '0')}AAAA`;

describe('MVP-02 F-02 · override nhãn hiệu: chỉ vẽ khi có VẾT', () => {
  before(async () => {
    ctx = await startImagelabApp();
  });
  after(async () => {
    await ctx.close();
  });

  /** Tạo job mới tới trạng thái chờ duyệt; trả về { sid, jobId, data }. */
  async function newJob() {
    const sid = nextSid();
    const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
      image: { base64: headphones().toString('base64'), filename: 'tai-nghe.png' },
    }, sid));
    const data = await waitJob(ctx.base, created.job_id, sid);
    assert.equal(data.job.status, 'awaiting_review');
    return { sid, jobId: created.job_id, data };
  }

  const brandOf = (data) => data.regions.find((r) => r.kind === 'brand');
  const descriptiveOf = (data) => data.regions.find((r) => r.kind === 'descriptive');

  /** Tải ảnh render mới nhất của job và trả về buffer. */
  async function renderedBytes(data, sid) {
    const last = (data.rendered || [])[data.rendered.length - 1];
    assert.ok(last, 'phải có ảnh render');
    const res = await fetch(`${ctx.base}/api/imagelab/assets/${last.id}/file`, { headers: cookie(sid) });
    assert.equal(res.status, 200);
    return Buffer.from(await res.arrayBuffer());
  }

  test('mặc định (KHÔNG override): vùng nhãn hiệu không bị vẽ, 0 pixel đổi', async () => {
    const { sid, jobId, data } = await newJob();
    const brand = brandOf(data);
    assert.ok(brand, 'fixture phải có vùng nhãn hiệu');

    const res = await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid);
    assert.equal(res.status, 202);
    const done = await waitJob(ctx.base, jobId, sid);
    assert.equal(done.job.status, 'succeeded');

    const bytes = await renderedBytes(done, sid);
    const diff = countChangedPixels(headphones(), bytes, brand.box);
    assert.equal(diff.changed, 0, `vùng nhãn hiệu bị đổi ${diff.changed} pixel: ${JSON.stringify(diff.first)}`);
    assert.ok(
      !done.render_summary.applied.some((a) => a.region_id === brand.id),
      'nhãn hiệu không được nằm trong danh sách đã vẽ',
    );
    assert.match(
      String(done.render_summary.skipped.find((s) => s.region_id === brand.id)?.reason),
      /nhãn hiệu/i,
      'phải nói rõ vì sao không vẽ',
    );
    assert.deepEqual(done.render_summary.overrides, [], 'không override thì không có vết override');
  });

  test('override CÓ VẾT qua API: vùng nhãn hiệu ĐƯỢC vẽ + ghi asset.meta.overrides + warning', async () => {
    const { sid, jobId, data } = await newJob();
    const brand = brandOf(data);
    const descriptive = descriptiveOf(data);

    const put = await putJson(ctx.base, `/api/imagelab/jobs/${jobId}/lines`, {
      allow_brand_override: true,
      edits: [
        { region_id: brand.id, text_vi: 'Thuong hieu ABC', action: 'edit' },
        { region_id: descriptive.id, text_vi: 'Ao thun cotton', action: 'edit' },
      ],
    }, sid);
    assert.equal(put.status, 200);
    const putBody = await j(put);
    assert.deepEqual(putBody.rejected, [], `không được từ chối khi đã bật override: ${JSON.stringify(putBody.rejected)}`);
    const editedBrand = putBody.lines.find((l) => l.region_id === brand.id);
    assert.equal(editedBrand.status, 'USER_EDITED');
    assert.equal(editedBrand.provenance, 'user');
    assert.equal(editedBrand.edited_by_user, true);
    assert.ok(editedBrand.edited_at, 'phải có vết thời điểm');
    assert.deepEqual(editedBrand.violations, []);

    const res = await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid);
    assert.equal(res.status, 202);
    const done = await waitJob(ctx.base, jobId, sid);
    assert.equal(done.job.status, 'succeeded');

    const bytes = await renderedBytes(done, sid);
    const diff = countChangedPixels(headphones(), bytes, brand.box);
    assert.ok(diff.changed > 0, 'override có vết PHẢI được vẽ lên ảnh');

    const applied = done.render_summary.applied.find((a) => a.region_id === brand.id);
    assert.ok(applied, 'vùng override phải nằm trong applied');
    assert.equal(applied.override, true, 'applied phải mang cờ override');
    assert.equal(done.render_summary.overrides.length, 1);
    assert.equal(done.render_summary.overrides[0].region_id, brand.id);
    assert.equal(done.render_summary.overrides[0].kind, 'brand');
    assert.ok(done.render_summary.overrides[0].edited_at, 'vết override phải có thời điểm');
    assert.ok(
      done.render_summary.warnings.some((w) => /ĐÃ BỊ THAY CHỮ/.test(w)),
      'phải có warning nói rõ vùng nhãn hiệu đã bị thay chữ',
    );

    // UI thật phải hiện khối cảnh báo override.
    const html = loadRenderIlWarnings()(done);
    assert.match(html, /ĐÃ BỊ THAY CHỮ/, 'UI phải hiện cảnh báo override có vết');
    assert.match(html, new RegExp(brand.id));
  });

  test('KHÔNG bật override: chỉnh sửa vùng nhãn hiệu bị TỪ CHỐI, không có vết ⇒ không vẽ', async () => {
    const { sid, jobId, data } = await newJob();
    const brand = brandOf(data);

    const put = await putJson(ctx.base, `/api/imagelab/jobs/${jobId}/lines`, {
      edits: [{ region_id: brand.id, text_vi: 'Thuong hieu ABC', action: 'edit' }],
    }, sid);
    assert.equal(put.status, 200);
    const putBody = await j(put);
    assert.equal(putBody.rejected.length, 1, 'phải từ chối khi chưa bật allow_brand_override');
    assert.equal(putBody.rejected[0].region_id, brand.id);
    assert.match(String(putBody.rejected[0].reason), /nhãn hiệu/i);

    const after = await waitJob(ctx.base, jobId, sid);
    const line = after.lines.find((l) => l.region_id === brand.id);
    assert.equal(line.text_vi, '', 'DB phải giữ nguyên chữ rỗng');
    assert.equal(line.edited_by_user, false, 'không được có vết người dùng');
    assert.equal(line.status, 'SKIPPED_BRAND');

    const res = await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid);
    assert.equal(res.status, 202);
    const done = await waitJob(ctx.base, jobId, sid);
    const bytes = await renderedBytes(done, sid);
    assert.equal(countChangedPixels(headphones(), bytes, brand.box).changed, 0, 'không có vết thì không được vẽ');
    assert.deepEqual(done.render_summary.overrides, []);
  });

  test('DB có chữ nhưng KHÔNG có vết (edited_by_user=false / provenance=ai) ⇒ không vẽ', async () => {
    const { sid, jobId, data } = await newJob();
    const brand = brandOf(data);
    const descriptive = descriptiveOf(data);

    await ctx.store.updateTranslationLines(jobId, [
      { region_id: brand.id, text_original: brand.text, text_vi: 'Thuong hieu ABC', status: 'USER_EDITED', provenance: 'ai', confidence: 0.9, violations: [], notes: '', edited_by_user: false, edited_at: null },
      { region_id: descriptive.id, text_original: descriptive.text, text_vi: 'Ao thun cotton', status: 'TRANSLATED', provenance: 'ai', confidence: 0.9, violations: [], notes: '', edited_by_user: false, edited_at: null },
    ]);

    const res = await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid);
    assert.equal(res.status, 202);
    const done = await waitJob(ctx.base, jobId, sid);
    assert.equal(done.job.status, 'succeeded');
    const bytes = await renderedBytes(done, sid);
    assert.equal(countChangedPixels(headphones(), bytes, brand.box).changed, 0, 'chữ trong DB mà không có vết thì KHÔNG được vẽ');
    assert.ok(!done.render_summary.applied.some((a) => a.region_id === brand.id));
    assert.deepEqual(done.render_summary.overrides, []);
  });

  test('DB có VẾT nhưng text_vi rỗng ⇒ không vẽ, không ghi override', async () => {
    const { sid, jobId, data } = await newJob();
    const brand = brandOf(data);
    await ctx.store.updateTranslationLines(jobId, [
      { region_id: brand.id, text_original: brand.text, text_vi: '', status: 'USER_EDITED', provenance: 'user', confidence: 0.9, violations: [], notes: '', edited_by_user: true, edited_at: '2026-10-03T00:00:00.000Z' },
    ]);

    const res = await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid);
    assert.equal(res.status, 202);
    const done = await waitJob(ctx.base, jobId, sid);
    const bytes = await renderedBytes(done, sid);
    assert.equal(countChangedPixels(headphones(), bytes, brand.box).changed, 0);
    assert.deepEqual(done.render_summary.overrides, [], 'không vẽ thì không được ghi vết override');
  });
});

describe('MVP-02 F-06 · cổng 409 và SKIPPED_BY_USER', () => {
  before(async () => {
    ctx = await startImagelabApp();
  });
  after(async () => {
    await ctx.close();
  });

  async function newJob() {
    const sid = nextSid();
    const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
      image: { base64: headphones().toString('base64') },
    }, sid));
    const data = await waitJob(ctx.base, created.job_id, sid);
    return { sid, jobId: created.job_id, data };
  }

  const descriptiveOf = (data) => data.regions.filter((r) => r.kind === 'descriptive');

  async function renderedBytes(data, sid) {
    const last = (data.rendered || [])[data.rendered.length - 1];
    const res = await fetch(`${ctx.base}/api/imagelab/assets/${last.id}/file`, { headers: cookie(sid) });
    return Buffer.from(await res.arrayBuffer());
  }

  test("action = skip → SKIPPED_BY_USER, KHÔNG chặn render, vào `skipped` kèm lý do, 0 pixel vẽ ở vùng đó", async () => {
    const { sid, jobId, data } = await newJob();
    const [skipRegion] = descriptiveOf(data);

    const put = await putJson(ctx.base, `/api/imagelab/jobs/${jobId}/lines`, {
      edits: [{ region_id: skipRegion.id, action: 'skip' }],
    }, sid);
    assert.equal(put.status, 200);
    const line = (await j(put)).lines.find((l) => l.region_id === skipRegion.id);
    assert.equal(line.status, 'SKIPPED_BY_USER');
    assert.equal(line.text_vi, '');
    assert.equal(line.edited_by_user, true);
    assert.equal(line.provenance, 'user');
    assert.deepEqual(line.violations, [], 'bỏ qua theo ý người dùng KHÔNG phải vi phạm guardrail');
    assert.match(String(line.notes), /bỏ qua/i);

    const res = await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid);
    assert.equal(res.status, 202, 'SKIPPED_BY_USER không được chặn render');
    const done = await waitJob(ctx.base, jobId, sid);
    assert.equal(done.job.status, 'succeeded');

    const skipped = done.render_summary.skipped.find((s) => s.region_id === skipRegion.id);
    assert.ok(skipped, 'dòng bị bỏ qua phải xuất hiện trong skipped');
    assert.match(String(skipped.reason), /bỏ qua/i);

    const bytes = await renderedBytes(done, sid);
    assert.equal(countChangedPixels(headphones(), bytes, skipRegion.box).changed, 0, 'không được vẽ chữ vào vùng đã bỏ qua');
  });

  test('NEEDS_REVIEW (kể cả edited_by_user = true) → 409 khi không force; force → không vẽ dòng đó', async () => {
    const { sid, jobId, data } = await newJob();
    const [target, other] = descriptiveOf(data);

    await ctx.store.updateTranslationLines(jobId, [
      { region_id: target.id, text_original: target.text, text_vi: 'Chữ bịa 12 tháng', status: 'NEEDS_REVIEW', provenance: 'user', confidence: 0.5, violations: ['Số liệu “12” không có trong chữ gốc.'], notes: 'người dùng sửa nhưng vẫn vi phạm', edited_by_user: true, edited_at: '2026-10-03T00:00:00.000Z' },
    ]);

    const gate = await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid);
    assert.equal(gate.status, 409, 'edited_by_user = true KHÔNG được miễn cổng 409');
    const gateBody = await j(gate);
    assert.equal(gateBody.error.code, 'REVIEW_REQUIRED');
    assert.deepEqual(gateBody.error.details.pending_region_ids, [target.id]);

    const forced = await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, { force: true }, sid);
    assert.equal(forced.status, 202);
    const done = await waitJob(ctx.base, jobId, sid);
    assert.equal(done.job.status, 'succeeded');

    const skipped = done.render_summary.skipped.find((s) => s.region_id === target.id);
    assert.ok(skipped, 'dòng NEEDS_REVIEW phải vào skipped');
    assert.match(String(skipped.reason), /CHƯA được duyệt/);
    assert.match(String(done.render_summary.forced), /KHÔNG được vẽ/);
    assert.ok(!done.render_summary.applied.some((a) => a.region_id === target.id));

    const bytes = await renderedBytes(done, sid);
    assert.equal(countChangedPixels(headphones(), bytes, target.box).changed, 0, 'chữ bị guardrail chặn KHÔNG được vẽ');
    assert.ok(countChangedPixels(headphones(), bytes, other.box).changed > 0, 'dòng hợp lệ khác vẫn phải được vẽ');
  });

  test('KHÔNG kẹt luồng: người dùng sửa dòng NEEDS_REVIEW cho sạch → USER_EDITED → render 202', async () => {
    const { sid, jobId, data } = await newJob();
    const [target] = descriptiveOf(data);
    await ctx.store.updateTranslationLines(jobId, [
      { region_id: target.id, text_original: target.text, text_vi: 'Chữ bịa 12 tháng', status: 'NEEDS_REVIEW', provenance: 'user', confidence: 0.5, violations: ['vi phạm'], notes: '', edited_by_user: true, edited_at: '2026-10-03T00:00:00.000Z' },
    ]);
    assert.equal((await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid)).status, 409);

    const put = await putJson(ctx.base, `/api/imagelab/jobs/${jobId}/lines`, {
      edits: [{ region_id: target.id, text_vi: 'Áo thun cotton thoáng mát', action: 'edit' }],
    }, sid);
    assert.equal(put.status, 200);
    const fixed = (await j(put)).lines.find((l) => l.region_id === target.id);
    assert.equal(fixed.status, 'USER_EDITED');
    assert.deepEqual(fixed.violations, []);

    const res = await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid);
    assert.equal(res.status, 202, 'sửa sạch vi phạm phải thoát được cổng 409');
    const done = await waitJob(ctx.base, jobId, sid);
    assert.equal(done.job.status, 'succeeded');
    const bytes = await renderedBytes(done, sid);
    assert.ok(countChangedPixels(headphones(), bytes, target.box).changed > 0, 'chữ đã sạch phải được vẽ');
  });

  test('accept KHÔNG xoá cờ NEEDS_REVIEW (409 vẫn còn) — đường thoát là edit sạch hoặc skip', async () => {
    const { sid, jobId, data } = await newJob();
    const [target] = descriptiveOf(data);
    await ctx.store.updateTranslationLines(jobId, [
      { region_id: target.id, text_original: target.text, text_vi: 'Chữ bịa 12 tháng', status: 'NEEDS_REVIEW', provenance: 'ai', confidence: 0.5, violations: ['vi phạm'], notes: '', edited_by_user: false, edited_at: null },
    ]);

    const acc = await putJson(ctx.base, `/api/imagelab/jobs/${jobId}/lines`, {
      edits: [{ region_id: target.id, action: 'accept' }],
    }, sid);
    assert.equal(acc.status, 200);
    const afterAccept = (await j(acc)).lines.find((l) => l.region_id === target.id);
    assert.equal(afterAccept.status, 'NEEDS_REVIEW', 'accept chỉ xác nhận, không xoá cờ cần duyệt');
    assert.equal((await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid)).status, 409);

    const skip = await putJson(ctx.base, `/api/imagelab/jobs/${jobId}/lines`, {
      edits: [{ region_id: target.id, action: 'skip' }],
    }, sid);
    assert.equal((await j(skip)).lines.find((l) => l.region_id === target.id).status, 'SKIPPED_BY_USER');
    assert.equal((await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid)).status, 202);
    const done = await waitJob(ctx.base, jobId, sid);
    assert.equal(done.job.status, 'succeeded');
  });

  test('mọi dòng vẽ được đều bị bỏ qua → render 202 nhưng job FAILED IMAGELAB_NO_LINES, không có ảnh giả', async () => {
    const { sid, jobId, data } = await newJob();
    const drawable = descriptiveOf(data);
    assert.ok(drawable.length >= 1);
    const put = await putJson(ctx.base, `/api/imagelab/jobs/${jobId}/lines`, {
      edits: drawable.map((r) => ({ region_id: r.id, action: 'skip' })),
    }, sid);
    assert.equal(put.status, 200);

    const res = await postJson(ctx.base, `/api/imagelab/jobs/${jobId}/render`, {}, sid);
    assert.equal(res.status, 202);
    const done = await waitJob(ctx.base, jobId, sid);
    assert.equal(done.job.status, 'failed');
    assert.equal(done.job.error_code, 'IMAGELAB_NO_LINES');
    assert.ok(done.job.finished_at, 'job phải kết thúc, không treo');
    assert.deepEqual(done.rendered, [], 'KHÔNG được lưu ảnh rỗng giả');
    assert.match(String(done.job.error_message), /Không có dòng nào đủ điều kiện render/);
  });
});
