/**
 * TEST MVP-06 · X2 — API GÓI XUẤT BẢN (`src/http/routes.js`), hợp đồng §3.
 *
 * App THẬT + server thật trên 127.0.0.1 + SQLite in-memory (như `test/imagelab-api.test.js`).
 * Phủ: 2 route mới, header nhị phân, ZIP đọc lại được, IDOR (session khác / tài khoản khác /
 * không cookie ⇒ 404, chính chủ ⇒ 200), 404 job không tồn tại, 400 id rác,
 * `/api/config.exports`, 503 `EXPORT_UNAVAILABLE` khi THIẾU HẲN `src/exports/**` (tiến trình
 * con chạy trên bản sao repo đã xoá module — server vẫn sống), và 429 khi vượt trần rate limit.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { inspectZip } from '../src/exports/index.js';
import {
  BOOTSTRAP_SOURCE,
  cookie,
  j,
  makeRepoCopy,
  readZipEntries,
  seedJob,
  startExportApp,
  tmpDir,
  zipJson,
} from './export-helpers.js';
import { register } from './mvp05-helpers.js';

const SID_A = 'exportApiSessionAAAAAA1';
const SID_B = 'exportApiSessionBBBBBB2';
const UNKNOWN_JOB = '00000000-0000-4000-8000-00000000dead';

const CONTENT = { product_name: 'Sản phẩm API', headline: 'Tiêu đề API', selling_points: ['a', 'b'], hashtags: ['#api'] };

/* ══════════════════ 2 route mới + quyền sở hữu ══════════════════ */

describe('MVP-06 API — /api/exports/jobs/:id/{bundle,manifest}', () => {
  let ctx;
  let seeded;

  before(async () => {
    ctx = await startExportApp();
    seeded = await seedJob(ctx, {
      sid: SID_A,
      kind: 'image_translation',
      productName: 'Sản phẩm API',
      content: CONTENT,
      contentMeta: { imagelab: { mock_steps: ['ocr'], warnings: ['cảnh báo API'] } },
      originals: 1,
      rendered: 1,
      lines: [{ region_id: 'r-1', text_original: '原文', text_vi: 'Bản dịch', status: 'translated' }],
      usage: [{ operation: 'OCR_DETECT', provider: 'mock', model: 'mock-ocr', meta: { is_mock: true } }],
      evidenceRows: [{ connector: '1688', extractionMethod: 'html-inline-json', verification: 'MOCK_VERIFIED', httpStatus: 200 }],
    });
  });

  after(async () => {
    await ctx.close();
  });

  test('GET bundle ⇒ 200 application/zip, đính kèm, no-store, ZIP mở được', async () => {
    const res = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/bundle`, { headers: cookie(SID_A) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition') || '', /^attachment; filename="[^"]+\.zip"$/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Number(res.headers.get('content-length')) > 0);

    const buffer = Buffer.from(await res.arrayBuffer());
    assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK', 'magic bytes phải là PK');
    const check = inspectZip(buffer);
    assert.equal(check.valid, true, check.errors.join(' · '));
    assert.deepEqual(check.entries.map((e) => e.name), [
      'MANIFEST.json',
      'noi-dung/noi-dung.json',
      'noi-dung/noi-dung.txt',
      'anh/anh-goc-1.png',
      'anh/anh-tao-1.png',
      'bang-chung/usage.json',
      'bang-chung/evidence.json',
    ]);
    // Thân tải về phải là ĐÚNG gói mà X1 dựng (không cắt, không bọc base64).
    const zip = readZipEntries(buffer);
    assert.equal(zipJson(zip, 'MANIFEST.json').job.id, seeded.jobId);
    assert.equal(zip.get('anh/anh-goc-1.png').data.subarray(0, 4).toString('hex'), '89504e47', 'ảnh gốc PNG phải nguyên vẹn');
    assert.ok(!buffer.includes(Buffer.from(SID_A, 'utf8')), 'gói không được lộ session_id');
  });

  test('GET manifest ⇒ 200 {manifest, warnings, missing}, KHÔNG lộ storage_path/session_id', async () => {
    const res = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/manifest`, { headers: cookie(SID_A) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await j(res);
    assert.deepEqual(Object.keys(body).sort(), ['manifest', 'missing', 'warnings']);
    assert.equal(body.manifest.job.id, seeded.jobId);
    assert.equal(body.manifest.verification, 'MOCK_VERIFIED');
    assert.equal(body.manifest.audio, null);
    assert.deepEqual(body.warnings, body.manifest.warnings);
    assert.deepEqual(body.missing, body.manifest.missing);
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('storage_path'), 'manifest KHÔNG được lộ storage_path');
    assert.ok(!raw.includes(SID_A), 'manifest KHÔNG được lộ session_id');
    assert.ok(!raw.includes(ctx.config.imagelab.dir), 'manifest KHÔNG được lộ đường dẫn nội bộ');
  });

  test('manifest API và MANIFEST.json trong gói là MỘT nguồn sự thật', async () => {
    const [manifestRes, bundleRes] = await Promise.all([
      fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/manifest`, { headers: cookie(SID_A) }),
      fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/bundle`, { headers: cookie(SID_A) }),
    ]);
    const api = await j(manifestRes);
    const zip = readZipEntries(Buffer.from(await bundleRes.arrayBuffer()));
    const fromZip = zipJson(zip, 'MANIFEST.json');
    // `generated_at` là thời điểm dựng gói nên hai lần gọi khác nhau vài ms — bỏ qua đúng field đó.
    assert.ok(api.manifest.generated_at && fromZip.generated_at);
    const drop = ({ generated_at: _ignored, ...rest }) => rest;
    assert.deepEqual(drop(fromZip), drop(api.manifest), 'bản kê khai trong gói và qua API phải là MỘT nguồn');
    assert.deepEqual(fromZip.missing, api.missing);
    assert.deepEqual(fromZip.warnings, api.warnings);
  });

  test('IDOR: session KHÁC ⇒ 404; không khai cookie ⇒ 404; chính chủ ⇒ 200', async () => {
    const other = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/bundle`, { headers: cookie(SID_B) });
    assert.equal(other.status, 404);
    assert.equal((await j(other)).error.code, 'JOB_NOT_FOUND');

    const anonymous = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/bundle`);
    assert.equal(anonymous.status, 404, 'không khai session ⇒ không được coi là chủ gói');
    assert.equal((await j(anonymous)).error.code, 'JOB_NOT_FOUND');

    const otherManifest = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/manifest`, { headers: cookie(SID_B) });
    assert.equal(otherManifest.status, 404);

    // ĐỐI CHỨNG: chính chủ vẫn tải được ⇒ 404 ở trên là do quyền, không phải route hỏng.
    const owner = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/manifest`, { headers: cookie(SID_A) });
    assert.equal(owner.status, 200);
  });

  test('IDOR theo TÀI KHOẢN: chủ job ⇒ 200, tài khoản khác ⇒ 404, chỉ có sid ⇒ 404', async () => {
    const a = await register(ctx.base, { email: 'export-chu-a@example.com' });
    const b = await register(ctx.base, { email: 'export-chu-b@example.com' });
    assert.equal(a.res.status, 201);
    assert.equal(b.res.status, 201);
    const userId = a.body.user.id;

    const own = await seedJob(ctx, {
      sid: SID_A,
      kind: 'content',
      userId,
      content: CONTENT,
      originals: 1,
      id: '11111111-2222-4333-8444-555555555501',
    });
    const jarHeader = (jar) => ({ cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') });

    const byOther = await fetch(`${ctx.base}/api/exports/jobs/${own.jobId}/bundle`, { headers: jarHeader(b.jar) });
    assert.equal(byOther.status, 404, 'tài khoản khác KHÔNG được tải gói của chủ job');
    assert.equal((await j(byOther)).error.code, 'JOB_NOT_FOUND');

    const bySidOnly = await fetch(`${ctx.base}/api/exports/jobs/${own.jobId}/bundle`, { headers: cookie(SID_A) });
    assert.equal(bySidOnly.status, 404, 'job của TÀI KHOẢN: chỉ có cookie sid (không đăng nhập) vẫn là khác chủ');

    const byOwner = await fetch(`${ctx.base}/api/exports/jobs/${own.jobId}/bundle`, { headers: jarHeader(a.jar) });
    assert.equal(byOwner.status, 200, 'chính chủ phải tải được');
    assert.equal(inspectZip(Buffer.from(await byOwner.arrayBuffer())).valid, true);
  });

  test('job không tồn tại ⇒ 404; id rác ⇒ 400 BAD_JOB_ID', async () => {
    const notFound = await fetch(`${ctx.base}/api/exports/jobs/${UNKNOWN_JOB}/bundle`, { headers: cookie(SID_A) });
    assert.equal(notFound.status, 404);
    assert.equal((await j(notFound)).error.code, 'JOB_NOT_FOUND');

    const bad = await fetch(`${ctx.base}/api/exports/jobs/khong-phai-uuid!!/bundle`, { headers: cookie(SID_A) });
    assert.equal(bad.status, 400);
    assert.equal((await j(bad)).error.code, 'BAD_JOB_ID');

    const badManifest = await fetch(`${ctx.base}/api/exports/jobs/%%%/manifest`, { headers: cookie(SID_A) });
    assert.equal(badManifest.status, 400);
  });

  test('/api/config khai exports = {available, formats:[zip]}', async () => {
    const res = await fetch(`${ctx.base}/api/config`, { headers: cookie(SID_A) });
    assert.equal(res.status, 200);
    const body = await j(res);
    assert.deepEqual(body.exports, { available: true, formats: ['zip'] });
  });
});

/* ══════════════════ 503 khi module export không nạp được ══════════════════ */

describe('MVP-06 API — 503 EXPORT_UNAVAILABLE (thiếu module) và server VẪN SỐNG', () => {
  test('công tắc tường minh `exportsUnavailableReason` ⇒ 503 + /api/health vẫn 200', async () => {
    const ctx = await startExportApp();
    try {
      const seeded = await seedJob(ctx, { sid: SID_A, kind: 'content', content: CONTENT, originals: 1 });
      ctx.app.exportsUnavailableReason = 'Khối gói xuất bản chưa được nạp trên máy chủ này (test mô phỏng).';

      const res = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/bundle`, { headers: cookie(SID_A) });
      assert.equal(res.status, 503);
      const body = await j(res);
      assert.equal(body.error.code, 'EXPORT_UNAVAILABLE');
      assert.match(body.error.message, /chưa được nạp/);

      const manifest = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/manifest`, { headers: cookie(SID_A) });
      assert.equal(manifest.status, 503);

      // Server vẫn phục vụ bình thường — tính năng thiếu KHÔNG được làm chết MVP khác.
      const health = await fetch(`${ctx.base}/api/health`);
      assert.equal(health.status, 200);
      assert.equal((await j(health)).status, 'ok');
      const other = await fetch(`${ctx.base}/api/jobs/${seeded.jobId}`, { headers: cookie(SID_A) });
      assert.equal(other.status, 200, 'route job MVP-01 vẫn chạy');
      const cfg = await j(await fetch(`${ctx.base}/api/config`));
      assert.deepEqual(cfg.exports, { available: false, formats: ['zip'] });
    } finally {
      await ctx.close();
    }
  });

  test('BẢN SAO REPO ĐÃ XOÁ `src/exports/**` ⇒ 503 thật, server vẫn sống', async () => {
    const repo = makeRepoCopy({ dropExports: true });
    assert.equal(fs.existsSync(path.join(repo, 'src', 'exports')), false, 'bản sao phải KHÔNG còn src/exports');
    // Script bootstrap phải có TRƯỚC khi spawn.
    fs.writeFileSync(path.join(repo, '_boot.mjs'), BOOTSTRAP_SOURCE);
    const jobId = '99999999-8888-4777-8666-555555555501';
    const child = spawn(process.execPath, [path.join(repo, '_boot.mjs')], {
      cwd: repo,
      env: {
        ...process.env,
        DATABASE_URL: '',
        BOOT_JOB_ID: jobId,
        BOOT_SID: SID_A,
        BOOT_IMAGELAB_DIR: tmpDir('vps-export-child-'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });

    try {
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`tiến trình con không khởi động kịp.\nstdout=${stdout}\nstderr=${stderr}`)), 30000);
        const check = () => {
          const port = /PORT=(\d+)/.exec(stdout);
          const job = /JOB=([0-9a-f-]{36})/.exec(stdout);
          if (port && job) {
            clearTimeout(timer);
            resolve({ base: `http://127.0.0.1:${port[1]}`, jobId: job[1] });
          }
        };
        child.stdout.on('data', check);
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`tiến trình con thoát sớm (code=${code}).\nstderr=${stderr}`)); });
        check();
      });

      const res = await fetch(`${ready.base}/api/exports/jobs/${ready.jobId}/bundle`, { headers: cookie(SID_A) });
      assert.equal(res.status, 503, 'thiếu module ⇒ 503, KHÔNG được trả gói rỗng giả');
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      assert.equal((await j(res)).error.code, 'EXPORT_UNAVAILABLE');

      const health = await fetch(`${ready.base}/api/health`);
      assert.equal(health.status, 200);
      assert.equal((await j(health)).status, 'ok', 'server phải VẪN SỐNG khi module export hỏng');

      const cfg = await j(await fetch(`${ready.base}/api/config`));
      assert.deepEqual(cfg.exports, { available: false, formats: ['zip'] });
      // Các route cũ vẫn phục vụ (không bị import hỏng kéo sập cả router).
      assert.equal((await fetch(`${ready.base}/api/jobs/${ready.jobId}`, { headers: cookie(SID_A) })).status, 200);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const hard = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
        child.on('exit', () => { clearTimeout(hard); resolve(); });
      });
    }
  });
});

/* ══════════════════ rate limit ══════════════════ */

describe('MVP-06 API — rate limit dùng chung bucket `export:${sid}`', () => {
  test('vượt trần ⇒ 429 RATE_LIMITED (và không phải 404/500)', async () => {
    const ctx = await startExportApp({ configOverrides: { RATE_LIMIT_MAX_JOBS: '3' } });
    try {
      const sid = 'exportRateLimitSession1';
      const seeded = await seedJob(ctx, { sid, kind: 'content', content: CONTENT, originals: 1 });
      const statuses = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/manifest`, { headers: cookie(sid) });
        statuses.push(res.status);
        if (res.status === 429) {
          const body = await j(res);
          assert.equal(body.error.code, 'RATE_LIMITED');
          assert.ok(Number(res.headers.get('retry-after')) > 0 || body.error.retry_after_ms > 0, 'phải nói khi nào thử lại được');
        }
      }
      assert.deepEqual(statuses, [200, 200, 200, 429], `3 lượt đầu phải qua, lượt 4 bị chặn — nhận ${statuses}`);
    } finally {
      await ctx.close();
    }
  });
});

/* ═══════════ D4/D5 (vòng sửa phản biện) — job không chủ, manifest không nén ZIP ═══════════ */

describe('MVP-06 API · D4/D5 — quyền sở hữu và đường manifest rời', () => {
  test('D4: job KHÔNG có chủ (không user_id, không session_id) ⇒ 404, không mở gói cho người lạ', async () => {
    const ctx = await startExportApp();
    try {
      const jobId = '00000000-0000-4000-8000-0000000000c1';
      // Job "mồ côi": không `user_id` và không `session_id` (dữ liệu cũ/nhập tay).
      await ctx.store.createJob({ id: jobId, sessionId: null, kind: 'content' });
      await ctx.store.updateJob(jobId, { session_id: null, user_id: null });
      await ctx.store.driver.run('UPDATE jobs SET session_id = NULL, user_id = NULL WHERE id = ?', [jobId]);

      for (const path of ['bundle', 'manifest']) {
        const res = await fetch(`${ctx.base}/api/exports/jobs/${jobId}/${path}`);
        assert.equal(res.status, 404, `/${path} của job không chủ phải 404, nhận ${res.status}`);
        assert.equal((await j(res)).error.code, 'JOB_NOT_FOUND');
        const withCookie = await fetch(`${ctx.base}/api/exports/jobs/${jobId}/${path}`, { headers: cookie(SID_A) });
        assert.equal(withCookie.status, 404, `kể cả có cookie lạ ⇒ vẫn 404 cho /${path}`);
      }
    } finally {
      await ctx.close();
    }
  });

  test('D5: `/manifest` KHÔNG dựng ZIP (nhanh hơn hẳn) và vẫn là một nguồn với gói', async () => {
    const ctx = await startExportApp();
    try {
      const seeded = await seedJob(ctx, { sid: SID_A, kind: 'content', content: CONTENT, originals: 1, rendered: 1 });
      const t0 = Date.now();
      const manifestRes = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/manifest`, { headers: cookie(SID_A) });
      const msManifest = Date.now() - t0;
      assert.equal(manifestRes.status, 200);
      const api = await j(manifestRes);
      assert.equal(typeof api.manifest, 'object');

      const t1 = Date.now();
      const bundleRes = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/bundle`, { headers: cookie(SID_A) });
      const msBundle = Date.now() - t1;
      assert.equal(bundleRes.status, 200);
      const zip = readZipEntries(Buffer.from(await bundleRes.arrayBuffer()));
      const fromZip = zipJson(zip, 'MANIFEST.json');
      const drop = ({ generated_at: _g, ...rest }) => rest;
      assert.deepEqual(drop(fromZip), drop(api.manifest), 'manifest rời và MANIFEST.json phải là MỘT nguồn');
      assert.ok(msManifest <= msBundle + 100, `manifest rời không được chậm hơn bundle (${msManifest}ms vs ${msBundle}ms)`);
    } finally {
      await ctx.close();
    }
  });
});
