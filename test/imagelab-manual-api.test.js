/**
 * IL-08 — TEST TẦNG HTTP `PUT /api/imagelab/jobs/:id/regions` (hợp đồng §11.1 + §11.2).
 *
 * Server THẬT trên 127.0.0.1 (như `test/imagelab-api.test.js`), provider chạy offline
 * (OCR mock fixture, translator mock, render purejs) — không cần mạng, không cần API key.
 *
 * Vì sao phủ ở tầng này chứ không chỉ ở pipeline: đây là bề mặt UI gọi vào, nơi mã lỗi
 * (400/409/413/503), `rejected[].index`, usage_event và dấu vết evidence phải ĐÚNG như
 * hợp đồng — sai một mã là UI hiện sai việc cho người dùng.
 *
 * Hai luật dễ vi phạm nhất được đo trực tiếp:
 *   - KHÔNG ghi `usage_event OCR_DETECT` cho vùng nhập tay (không có OCR nào chạy);
 *   - 409 `MANUAL_EDITS_WOULD_BE_LOST` phải KHÔNG làm mất dữ liệu cũ (fail-closed).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { sha256 } from '../src/imagelab/render/index.js';
import { j, cookie, postJson, putJson, startImagelabApp, waitJob, headphones } from './imagelab-helpers.js';

const SID_A = 'il08SessionAAAAAAA1';
const SID_B = 'il08SessionBBBBBBB2';
const MISSING = '00000000-0000-0000-0000-000000000000';

const BRAND_TEXT = '品牌旗舰店'; // classifyRegion ⇒ brand ⇒ KHOÁ
const DESC_TEXT = '纯棉短袖T恤'; // ⇒ descriptive ⇒ được dịch
const EDIT_VI = 'Bản sửa tay của người dùng — KHÔNG được mất';

const jobUrl = (id) => `/api/imagelab/jobs/${id}`;
const getJob = async (base, id, sid) => j(await fetch(`${base}${jobUrl(id)}`, { headers: cookie(sid) }));
const usageCount = (rows, op) => rows.filter((e) => e.operation === op).length;

/**
 * Trần rate limit nâng cao cho cả file: luật rate limit có test RIÊNG
 * (`imagelab-ratelimit.test.js`); ở đây nhiều request liên tiếp trên cùng một session sẽ
 * chạm trần mặc định (10/phút) và làm test đỏ vì lý do KHÔNG liên quan tới IL-08.
 */
const RL = { RATE_LIMIT_MAX_JOBS: '1000' };

describe('IL-08 API — luồng lưu vùng nhập tay (server thật)', () => {
  let ctx;
  const flow = {};

  before(async () => {
    ctx = await startImagelabApp({ configOverrides: RL });
  });
  after(async () => {
    await ctx.close();
  });

  test('chuẩn bị: tạo job từ ảnh fixture → awaiting_review; ghi lại mốc usage + hash ảnh gốc trên đĩa', async () => {
    const buf = headphones();
    const res = await postJson(ctx.base, '/api/imagelab/jobs', {
      image: { base64: buf.toString('base64'), filename: 'tai-nghe.png' },
    }, SID_A);
    assert.equal(res.status, 202);
    const created = await j(res);
    flow.jobId = created.job_id;
    flow.assetId = created.asset_id;

    const d = await waitJob(ctx.base, flow.jobId, SID_A);
    assert.equal(d.job.status, 'awaiting_review', 'job OCR mock phải sẵn sàng để người dùng nhập tay');

    // Mốc để đo HIỆU SỐ usage (POST /jobs đã ghi 1 OCR_DETECT cho lần OCR mock).
    flow.usageBefore = await ctx.store.listUsage(flow.jobId);
    assert.equal(usageCount(flow.usageBefore, 'OCR_DETECT'), 1, 'lần OCR mock đầu tiên phải có đúng 1 event');

    // Ảnh gốc: hash THẲNG TRÊN ĐĨA (không qua HTTP) để chứng minh bất biến về sau.
    const asset = await ctx.store.getImageAsset(flow.assetId);
    assert.ok(asset.storage_path, 'store phải trả storage_path cho test (route HTTP thì không)');
    flow.originalPath = ctx.storage.resolveAssetPath(asset).file;
    flow.originalSha = sha256(fs.readFileSync(flow.originalPath));
    assert.equal(flow.originalSha, sha256(buf), 'ảnh gốc lưu đúng bytes đã tải lên');
  });

  test('PUT .../regions → 200: brand KHOÁ, mô tả được dịch, hộp tràn bị CẮT, rejected đủ mọi vùng bỏ kèm index', async () => {
    const regions = [
      { box: { x: 10, y: 10, w: 100, h: 30 }, text: BRAND_TEXT, kind: 'brand' }, // index 0 — nhận
      { box: { x: 10, y: 60, w: 120, h: 30 }, text: '   ' }, // index 1 — TEXT_EMPTY
      { box: { x: 10, y: 100, w: 120, h: 30 }, text: DESC_TEXT }, // index 2 — nhận
      { box: { x: 900, y: 900, w: 50, h: 50 }, text: '外景' }, // index 3 — BOX_OUTSIDE_IMAGE
      { box: { x: 300, y: 150, w: 100, h: 30 }, text: DESC_TEXT }, // index 4 — tràn phải, phải bị CẮT
    ];
    const res = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, { regions }, SID_A);
    assert.equal(res.status, 200);
    const body = await j(res);

    assert.equal(body.job_id, flow.jobId);
    assert.equal(body.status, 'awaiting_review');
    assert.ok(Array.isArray(body.warnings));

    // ── vùng đã lưu: nguồn = người dùng, đúng 3 vùng hợp lệ ────────────────
    assert.equal(body.regions.length, 3);
    assert.deepEqual(body.regions.map((r) => r.source), ['user', 'user', 'user']);
    assert.deepEqual(body.regions.map((r) => r.kind), ['brand', 'descriptive', 'descriptive']);
    assert.deepEqual(body.regions.map((r) => r.translatable), [false, true, true]);
    assert.match(body.regions[0].id, /^u\d+$/, 'id do server gán dạng u…');
    assert.equal(body.regions[0].box.w, 100, 'hộp nằm trong ảnh phải giữ nguyên');

    // ── hộp tràn phải: lưu ĐÚNG phần giao với khung ảnh (320 rộng), KHÔNG nới rộng ──
    const clipped = body.regions.find((r) => r.box.x === 300);
    assert.ok(clipped, 'vùng tràn biên vẫn phải được nhận (đã cắt)');
    assert.deepEqual(clipped.box, { x: 300, y: 150, w: 20, h: 30 }, 'phải lưu hộp ĐÃ CẮT, không giữ w=100');
    assert.ok(
      body.warnings.some((w) => w.includes('cắt')),
      `phải cảnh báo rõ hộp đã bị cắt, nhận: ${JSON.stringify(body.warnings)}`,
    );

    // ── rejected: ĐỦ mọi vùng bị bỏ, index 0-based đúng vị trí client gửi ──
    assert.deepEqual(body.rejected.map((r) => r.index), [1, 3]);
    assert.deepEqual(body.rejected.map((r) => r.code), ['TEXT_EMPTY', 'BOX_OUTSIDE_IMAGE']);
    for (const r of body.rejected) {
      assert.equal(typeof r.reason, 'string');
      assert.ok(r.reason.startsWith(r.code), `reason phải có tiền tố mã (${r.code}), nhận: ${r.reason}`);
    }

    // ── dòng dịch: brand bị khoá thật, mô tả được dịch thật ───────────────
    const brandLine = body.lines.find((l) => l.region_id === body.regions[0].id);
    const descLine = body.lines.find((l) => l.region_id === body.regions[1].id);
    assert.equal(brandLine.status, 'SKIPPED_BRAND', 'vùng nhãn hiệu vẫn bị KHOÁ như khi OCR đọc ra');
    assert.equal(brandLine.text_vi, '', 'vùng nhãn hiệu KHÔNG được có chữ Việt');
    assert.ok(descLine.text_vi.length > 0, 'vùng mô tả phải được dịch');
    assert.notEqual(descLine.status, 'SKIPPED_BRAND');

    flow.regionIds = body.regions.map((r) => r.id);
  });

  test('sau khi lưu: job awaiting_review, finished_at = null, có dấu vết manual_regions/nguồn user', async () => {
    const d = await getJob(ctx.base, flow.jobId, SID_A);
    assert.equal(d.job.status, 'awaiting_review');
    assert.equal(d.job.stage, 'awaiting_review');
    assert.equal(d.job.finished_at, null, 'chờ duyệt thì chưa finished');
    assert.equal(d.regions.length, 3, 'GET job phải thấy đúng vùng vừa lưu');
    assert.ok(d.regions.every((r) => r.source === 'user'));

    const job = await ctx.store.getJob(flow.jobId);
    assert.equal(job.content_meta.imagelab.manual_regions, true);
    assert.equal(job.content_meta.imagelab.regions_source, 'user');
    assert.ok(!JSON.stringify(job).includes('LIVE_VERIFIED'), 'job nhập tay KHÔNG BAO GIỜ là LIVE_VERIFIED');
  });

  test('KHÔNG ghi usage_event OCR_DETECT cho vùng nhập tay (đo hiệu số); TRANSLATION thì có', async () => {
    const after = await ctx.store.listUsage(flow.jobId);

    assert.equal(
      usageCount(after, 'OCR_DETECT'),
      usageCount(flow.usageBefore, 'OCR_DETECT'),
      'nhập tay KHÔNG chạy OCR nên KHÔNG được ghi thêm OCR_DETECT',
    );
    assert.equal(usageCount(after, 'OCR_DETECT'), 1, 'chỉ có đúng 1 event OCR của lần POST /jobs');
    assert.equal(
      usageCount(after, 'TRANSLATION'),
      usageCount(flow.usageBefore, 'TRANSLATION') + 1,
      'có gọi dịch thật thì phải ghi TRANSLATION',
    );
    const manualOcr = after.filter(
      (e) => e.operation === 'OCR_DETECT' && String(e.meta || '').includes('manual_regions'),
    );
    assert.equal(manualOcr.length, 0, 'không event OCR nào được gắn dấu vết nhập tay (làm vậy là BỊA usage)');

    const translation = after.filter((e) => e.operation === 'TRANSLATION').pop();
    assert.ok(String(translation.meta || '').includes('manual_regions'), 'event dịch phải ghi rõ nguồn vùng là người dùng');
  });

  test('evidence: extraction_method có manual-regions, verification = MANUAL_INPUT, KHÔNG LIVE_VERIFIED', async () => {
    const rows = await ctx.store.getEvidence(flow.jobId);
    const manual = rows.find((r) => String(r.extraction_method).includes('manual-regions'));
    assert.ok(
      manual,
      `phải có bản ghi evidence cho lần nhập tay, nhận: ${JSON.stringify(rows.map((r) => r.extraction_method))}`,
    );
    assert.equal(manual.verification, 'MANUAL_INPUT');
    assert.equal(manual.extraction_method, 'upload+render+manual-regions');
    assert.ok(rows.every((r) => r.verification !== 'LIVE_VERIFIED'), 'nhập tay KHÔNG BAO GIỜ là LIVE_VERIFIED');
    assert.ok(rows.every((r) => r.verification === 'MANUAL_INPUT'));
  });

  test('mất bản sửa tay: sửa 1 dòng rồi PUT .../regions không xác nhận ⇒ 409 và dữ liệu cũ CÒN NGUYÊN', async () => {
    const edit = await putJson(ctx.base, `${jobUrl(flow.jobId)}/lines`, {
      edits: [{ region_id: flow.regionIds[1], action: 'edit', text_vi: EDIT_VI }],
    }, SID_A);
    assert.equal(edit.status, 200);
    const editedLines = (await j(edit)).lines;
    const editedLine = editedLines.find((l) => l.region_id === flow.regionIds[1]);
    assert.equal(editedLine.edited_by_user, true, 'sửa tay phải được đánh dấu');
    assert.equal(editedLine.text_vi, EDIT_VI);

    const before = await getJob(ctx.base, flow.jobId, SID_A);

    const res = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, {
      regions: [{ box: { x: 5, y: 5, w: 50, h: 20 }, text: DESC_TEXT }],
    }, SID_A);
    assert.equal(res.status, 409);
    const body = await j(res);
    assert.equal(body.error.code, 'MANUAL_EDITS_WOULD_BE_LOST');
    assert.ok(body.error.message.length > 0, 'phải nói rõ vì sao chặn');
    assert.ok(!body.error.message.includes(ctx.config.imagelab.dir), 'không được lộ đường dẫn nội bộ');

    const after = await getJob(ctx.base, flow.jobId, SID_A);
    assert.deepEqual(after.regions, before.regions, 'vùng cũ phải còn nguyên (fail-closed)');
    assert.deepEqual(after.lines, before.lines, 'dòng đã sửa tay phải còn nguyên');
    assert.equal(after.lines.find((l) => l.region_id === flow.regionIds[1]).text_vi, EDIT_VI);
    assert.equal(after.job.status, before.job.status, '409 không được đổi trạng thái job');
    flow.editedRegionId = flow.regionIds[1];
  });

  test('confirm_replace_edited: true ⇒ 200 và bản sửa tay bị THAY (đúng thiết kế, có cảnh báo)', async () => {
    const res = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, {
      regions: [{ box: { x: 5, y: 5, w: 50, h: 20 }, text: DESC_TEXT }],
      confirm_replace_edited: true,
    }, SID_A);
    assert.equal(res.status, 200);
    const body = await j(res);

    assert.equal(body.regions.length, 1, 'replace mặc định = true ⇒ thay toàn bộ');
    assert.equal(body.lines.length, 1);
    assert.equal(body.lines[0].edited_by_user, false, 'bản sửa tay cũ đã bị thay');
    assert.notEqual(body.lines[0].text_vi, EDIT_VI);
    assert.equal(body.regions[0].source, 'user');
    assert.ok(
      body.warnings.some((w) => /sửa tay/i.test(w)),
      `phải cảnh báo rõ đã mất bản sửa tay, nhận: ${JSON.stringify(body.warnings)}`,
    );

    const d = await getJob(ctx.base, flow.jobId, SID_A);
    assert.equal(d.job.status, 'awaiting_review');
    assert.equal(d.job.finished_at, null);
    flow.regionIds = body.regions.map((r) => r.id);
  });

  test('replace: false ⇒ GHI THÊM vùng (id không đụng id cũ) và GIỮ dòng đã sửa tay', async () => {
    const before = await getJob(ctx.base, flow.jobId, SID_A);
    const keptId = before.lines[0].region_id;

    const edit = await putJson(ctx.base, `${jobUrl(flow.jobId)}/lines`, {
      edits: [{ region_id: keptId, action: 'edit', text_vi: EDIT_VI }],
    }, SID_A);
    assert.equal(edit.status, 200);
    assert.equal((await j(edit)).lines.find((l) => l.region_id === keptId).edited_by_user, true);

    const res = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, {
      regions: [{ box: { x: 100, y: 100, w: 60, h: 25 }, text: BRAND_TEXT, kind: 'brand' }],
      replace: false,
    }, SID_A);
    assert.equal(res.status, 200);
    const body = await j(res);

    assert.equal(body.regions.length, before.regions.length + 1, 'phải ghi THÊM, không thay');
    assert.equal(new Set(body.regions.map((r) => r.id)).size, body.regions.length, 'id phải duy nhất');
    const added = body.regions.find((r) => r.text === BRAND_TEXT);
    assert.ok(added, 'vùng mới phải được lưu');
    assert.ok(!before.regions.some((r) => r.id === added.id), 'id mới KHÔNG được đụng id cũ');

    const kept = body.lines.find((l) => l.region_id === keptId);
    assert.equal(kept.edited_by_user, true, 'ghi thêm KHÔNG được làm mất bản sửa tay');
    assert.equal(kept.text_vi, EDIT_VI);

    const addedLine = body.lines.find((l) => l.region_id === added.id);
    assert.equal(addedLine.status, 'SKIPPED_BRAND', 'vùng nhãn hiệu thêm sau vẫn bị KHOÁ');
    assert.equal(addedLine.text_vi, '');
    assert.equal(body.status, 'awaiting_review');
  });

  test('sau khi lưu ⇒ POST .../render chạy được (202 → succeeded); ảnh gốc BẤT BIẾN trên đĩa', async () => {
    const res = await postJson(ctx.base, `${jobUrl(flow.jobId)}/render`, { force: true }, SID_A);
    const accepted = await j(res);
    assert.equal(res.status, 202, `render phải nhận job nhập tay, nhận ${res.status}: ${JSON.stringify(accepted)}`);
    assert.equal(accepted.job_id, flow.jobId);

    const done = await waitJob(ctx.base, flow.jobId, SID_A);
    assert.equal(done.job.status, 'succeeded');
    assert.equal(done.job.stage, 'done');
    assert.ok(done.rendered.length >= 1, 'phải có ảnh render');

    // Ảnh gốc: hash trên đĩa TRƯỚC = SAU, và vẫn đúng bytes người dùng tải lên.
    const asset = await ctx.store.getImageAsset(flow.assetId);
    assert.equal(ctx.storage.resolveAssetPath(asset).file, flow.originalPath);
    assert.equal(sha256(fs.readFileSync(flow.originalPath)), flow.originalSha, 'ảnh gốc trên đĩa KHÔNG được đổi');
    assert.equal(flow.originalSha, sha256(headphones()));
    assert.equal(done.asset.sha256, flow.originalSha);
  });
});

describe('IL-08 API — validate & quyền sở hữu (server thật)', () => {
  let ctx;
  const flow = {};

  before(async () => {
    ctx = await startImagelabApp({ configOverrides: RL });
    const res = await postJson(ctx.base, '/api/imagelab/jobs', {
      image: { base64: headphones().toString('base64') },
    }, SID_A);
    const created = await j(res);
    flow.jobId = created.job_id;
    await waitJob(ctx.base, flow.jobId, SID_A);
  });
  after(async () => {
    await ctx.close();
  });

  test('400 NO_REGIONS: mảng rỗng / không phải mảng / thiếu hẳn trường regions', async () => {
    const cases = [[], 'khong-phai-mang', {}, null, { regions: {} }, { regions: null }, { regions: 0 }];
    for (const body of cases) {
      const res = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, body, SID_A);
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} lẽ ra 400, nhận ${res.status}`);
      assert.equal((await j(res)).error.code, 'NO_REGIONS');
    }
  });

  test('404: session khác gọi job của người khác (IDOR) — không xác nhận job tồn tại', async () => {
    const res = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, {
      regions: [{ box: { x: 1, y: 1, w: 10, h: 10 }, text: DESC_TEXT }],
    }, SID_B);
    assert.equal(res.status, 404);
    assert.equal((await j(res)).error.code, 'JOB_NOT_FOUND');

    // Session A vẫn dùng được bình thường ⇒ 404 trên là do quyền sở hữu.
    const ok = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, {
      regions: [{ box: { x: 1, y: 1, w: 10, h: 10 }, text: DESC_TEXT }],
    }, SID_A);
    assert.equal(ok.status, 200);
  });

  test('id client trùng/ký tự lạ ⇒ server gán id mới, KHÔNG mất vùng nào', async () => {
    const res = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, {
      regions: [
        { id: 'dup', box: { x: 10, y: 10, w: 40, h: 20 }, text: DESC_TEXT },
        { id: 'dup', box: { x: 60, y: 10, w: 40, h: 20 }, text: BRAND_TEXT, kind: 'brand' },
        { id: '<img src=x onerror=alert(1)>', box: { x: 110, y: 10, w: 40, h: 20 }, text: DESC_TEXT },
      ],
    }, SID_A);
    assert.equal(res.status, 200);
    const body = await j(res);

    assert.equal(body.regions.length, 3, 'KHÔNG được mất vùng chỉ vì id trùng/ký tự lạ');
    const ids = body.regions.map((r) => r.id);
    assert.equal(new Set(ids).size, 3, `id phải duy nhất, nhận ${JSON.stringify(ids)}`);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/, `id phải an toàn cho DB/render, nhận ${id}`);
    assert.equal(body.lines.length, 3);
    assert.ok(body.regions.every((r) => r.source === 'user'));
  });

  test('409 IMAGELAB_NO_ORIGINAL: job chưa có ảnh gốc ⇒ chặn, KHÔNG đánh job failed', async () => {
    const jobId = await ctx.store.createJob({ sessionId: SID_A, kind: 'image_translation' });
    const res = await putJson(ctx.base, `${jobUrl(jobId)}/regions`, {
      regions: [{ box: { x: 1, y: 1, w: 10, h: 10 }, text: DESC_TEXT }],
    }, SID_A);
    assert.equal(res.status, 409);
    const body = await j(res);
    assert.equal(body.error.code, 'IMAGELAB_NO_ORIGINAL');
    assert.ok(body.error.message.length > 0);

    const job = await ctx.store.getJob(jobId);
    assert.equal(job.status, 'queued', 'lỗi tiền điều kiện KHÔNG được đánh job failed');
    assert.equal((await ctx.store.listOcrRegions(jobId)).length, 0, 'không được ghi gì khi chưa có ảnh gốc');
  });

  test('job không tồn tại / id sai định dạng ⇒ 404 / 400', async () => {
    const missing = await putJson(ctx.base, `${jobUrl(MISSING)}/regions`, {
      regions: [{ box: { x: 1, y: 1, w: 10, h: 10 }, text: DESC_TEXT }],
    }, SID_A);
    assert.equal(missing.status, 404);

    const bad = await putJson(ctx.base, `${jobUrl('ab')}/regions`, {
      regions: [{ box: { x: 1, y: 1, w: 10, h: 10 }, text: DESC_TEXT }],
    }, SID_A);
    assert.equal(bad.status, 400);
  });
});

describe('IL-08 API — 413 TOO_MANY_REGIONS theo trần cấu hình', () => {
  let ctx;
  const flow = {};

  before(async () => {
    ctx = await startImagelabApp({ configOverrides: { ...RL, IMAGELAB_MAX_REGIONS: '2' } });
    const res = await postJson(ctx.base, '/api/imagelab/jobs', {
      image: { base64: headphones().toString('base64') },
    }, SID_A);
    flow.jobId = (await j(res)).job_id;
    await waitJob(ctx.base, flow.jobId, SID_A);
  });
  after(async () => {
    await ctx.close();
  });

  test('gửi quá `maxRegions` ⇒ 413 TRƯỚC khi chuẩn hoá (không ghi gì vào job)', async () => {
    const regions = [1, 2, 3].map((n) => ({ box: { x: n * 10, y: 10, w: 40, h: 20 }, text: DESC_TEXT }));
    const before = await getJob(ctx.base, flow.jobId, SID_A);

    const res = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, { regions }, SID_A);
    assert.equal(res.status, 413);
    const body = await j(res);
    assert.equal(body.error.code, 'TOO_MANY_REGIONS');
    assert.match(body.error.message, /2/, 'thông báo phải nêu trần thật');

    const after = await getJob(ctx.base, flow.jobId, SID_A);
    assert.deepEqual(after.regions, before.regions, '413 KHÔNG được đụng dữ liệu job');
    assert.deepEqual(after.lines, before.lines);
  });

  test('đúng bằng trần ⇒ nhận; vượt trần chỉ 1 vùng cũng bị chặn', async () => {
    const two = [1, 2].map((n) => ({ box: { x: n * 10, y: 10, w: 40, h: 20 }, text: DESC_TEXT }));
    const ok = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, { regions: two }, SID_A);
    assert.equal(ok.status, 200);
    assert.equal((await j(ok)).regions.length, 2);

    const three = [...two, { box: { x: 90, y: 10, w: 40, h: 20 }, text: DESC_TEXT }];
    const over = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, { regions: three }, SID_A);
    assert.equal(over.status, 413);
  });

  test('ghi thêm vượt trần ⇒ 200 nhưng vùng thừa vào `rejected` với TOO_MANY_REGIONS (không cắt im lặng)', async () => {
    // Job đang có 2 vùng (bằng trần). Ghi thêm 1 vùng ⇒ cap còn 0 chỗ.
    const res = await putJson(ctx.base, `${jobUrl(flow.jobId)}/regions`, {
      regions: [{ box: { x: 200, y: 200, w: 40, h: 20 }, text: DESC_TEXT }],
      replace: false,
    }, SID_A);
    assert.equal(res.status, 200);
    const body = await j(res);

    assert.equal(body.regions.length, 2, 'không được vượt trần: vùng cũ giữ nguyên, vùng mới bị bỏ');
    assert.deepEqual(body.rejected.map((r) => r.index), [0]);
    assert.equal(body.rejected[0].code, 'TOO_MANY_REGIONS');
    assert.ok(body.rejected[0].reason.startsWith('TOO_MANY_REGIONS'));
    assert.equal(body.lines.length, 2);
  });
});

describe('IL-08 API — 503 khi ImageLab bị tắt', () => {
  test('IMAGELAB_ENABLED=false ⇒ PUT .../regions trả 503 IMAGELAB_UNAVAILABLE kèm lý do thật', async () => {
    const ctx = await startImagelabApp({ configOverrides: { ...RL, IMAGELAB_ENABLED: 'false' } });
    try {
      const res = await putJson(ctx.base, `${jobUrl(MISSING)}/regions`, {
        regions: [{ box: { x: 1, y: 1, w: 10, h: 10 }, text: DESC_TEXT }],
      }, SID_A);
      assert.equal(res.status, 503);
      const body = await j(res);
      assert.equal(body.error.code, 'IMAGELAB_UNAVAILABLE');
      assert.ok(body.error.message.length > 0, 'phải nói rõ LÝ DO');
      assert.ok(!body.error.message.includes('/Users/'), 'không được lộ đường dẫn tuyệt đối');
    } finally {
      await ctx.close();
    }
  });
});

describe('IL-08 API — hạn mức request của route nhập vùng', () => {
  test('vượt RATE_LIMIT_MAX_JOBS ⇒ 429 RATE_LIMITED (không phải 5xx)', async () => {
    const ctx = await startImagelabApp({ configOverrides: { RATE_LIMIT_MAX_JOBS: '1' } });
    try {
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: headphones().toString('base64') },
      }, SID_A));
      const body = { regions: [{ box: { x: 1, y: 1, w: 10, h: 10 }, text: DESC_TEXT }] };

      // IL08-01(a): job ĐANG chạy thì route nhập vùng trả 409 (chống OCR ghi đè vùng tay),
      // nên phải chờ OCR xong trước khi đo hạn mức — mục đích của test này là RATE LIMIT.
      await waitJob(ctx.base, created.job_id, SID_A);

      // Bucket của route regions là key RIÊNG (`imagelab-regions:<sid>`) nên lượt đầu vẫn qua.
      const first = await putJson(ctx.base, `${jobUrl(created.job_id)}/regions`, body, SID_A);
      assert.equal(first.status, 200);

      const second = await putJson(ctx.base, `${jobUrl(created.job_id)}/regions`, body, SID_A);
      assert.equal(second.status, 429);
      assert.equal((await j(second)).error.code, 'RATE_LIMITED');
    } finally {
      await ctx.close();
    }
  });
});
