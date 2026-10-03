/**
 * TEST API — lỗi API, G10/G11/G12/G13, bảo mật tầng HTTP.
 *
 * Dựng app THẬT (server thật, SQLite in-memory) nhưng thay connector và AI bằng
 * bản giả, nên test không cần mạng và không cần API key.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { ProductSourceConnector } from '../src/sources/base-connector.js';
import { createEmptyMaster, STATUS, addWarning, recomputeEvidence } from '../src/product-master.js';
import { fakeContentEngine, fakeVisionProvider, testConfig, silent, fixtureBuffer } from './helpers.js';
import { createStore, JOB_STATUS } from '../src/store/index.js';

/** Connector giả điều khiển được kết quả trả về. */
function makeConnector(mode = 'ok') {
  return class FakeConnector extends ProductSourceConnector {
    static source = '1688';
    static displayName = 'FakeConnector';
    async fetchProduct() {
      return { html: '<html></html>', status: 200, finalUrl: this.homeUrl(), redirects: [], bytes: 10, method: 'fake' };
    }
    normalize(raw, master) {
      if (mode === 'blocked') {
        master.extraction.blocked_reason = 'Anti-bot challenge phát hiện: x5secdata (giả lập)';
        this.markLoginRequired(master, 'Bị chặn (giả lập)');
        return master;
      }
      master.title_original = 'Sản phẩm giả lập';
      master.title_original_status = STATUS.FOUND;
      master.images.push({ url: 'https://cbu01.alicdn.com/a.jpg', type: 'cover', status: STATUS.FOUND, provenance: 'source' });
      master.attributes.push({ name: 'Chất liệu', value: 'vải', status: STATUS.FOUND, provenance: 'source' });
      master.price = { raw: '12.5', currency: 'CNY', status: STATUS.FOUND, kind: 'fixed', tiers: [] };
      master.store = { name: 'Nhà máy giả lập', id: '1', url: '', status: STATUS.FOUND };
      return master;
    }
  };
}

async function buildApp({ connectorMode = 'ok', useRealContent = true } = {}) {
  const config = testConfig();
  const store = await createStore(config, silent);
  const app = await createApp({
    config,
    logger: silent,
    store,
    connectors: [makeConnector(connectorMode)],
    visionProvider: fakeVisionProvider(),
    contentEngine: useRealContent ? fakeContentEngine() : { providerName: 'none', model: '', configured: false, translate: async () => ({ skipped: true }), generate: async () => { throw new Error('không có AI'); } },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, store };
}

const j = async (res) => {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { __raw: t };
  }
};

/** Chờ job tới trạng thái kết thúc. */
async function waitJob(base, id, { tries = 60, delay = 60 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const r = await fetch(`${base}/api/jobs/${id}`);
    const d = await j(r);
    if (!['queued', 'running'].includes(d.status)) return d;
    await new Promise((rr) => setTimeout(rr, delay));
  }
  throw new Error('job không kết thúc kịp');
}

describe('API — health & config', () => {
  let ctx;
  before(async () => {
    ctx = await buildApp();
  });
  after(async () => {
    await ctx.app.close();
  });

  test('GET /api/health → ok + dialect', async () => {
    const d = await j(await fetch(`${ctx.base}/api/health`));
    assert.equal(d.status, 'ok');
    assert.equal(d.db.ok, true);
    assert.equal(d.db.dialect, 'sqlite');
    assert.deepEqual(d.connectors.map((c) => c.source), ['1688']);
  });

  test('GET /api/config trả phong cách, độ dài, provider, giới hạn', async () => {
    const d = await j(await fetch(`${ctx.base}/api/config`));
    assert.equal(d.styles.length, 6);
    assert.equal(d.lengths.length, 3);
    assert.equal(d.defaults.style, 'ban-hang');
    assert.equal(d.defaults.length, 'vua');
    assert.equal(d.providers.content.configured, true);
    assert.ok(d.limits.max_upload_bytes > 0);
    // KHÔNG được lộ API key ra ngoài
    assert.ok(!JSON.stringify(d).includes('api_key'));
    assert.ok(!JSON.stringify(d).includes('sk-'));
  });

  test('mọi response đều có header bảo mật', async () => {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
  });
});

describe('API — G01 detect + bảo mật', () => {
  let ctx;
  before(async () => {
    ctx = await buildApp();
  });
  after(async () => {
    await ctx.app.close();
  });

  const post = (body) =>
    fetch(`${ctx.base}/api/detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('link hợp lệ → 200', async () => {
    const d = await j(await post({ url: 'https://detail.1688.com/offer/552160420012.html' }));
    assert.equal(d.source, '1688');
    assert.equal(d.source_product_id, '552160420012');
  });

  test('tên miền lạ → 400 UNSUPPORTED_SOURCE', async () => {
    const res = await post({ url: 'https://www.amazon.com/dp/B1' });
    assert.equal(res.status, 400);
    assert.equal((await j(res)).error.code, 'UNSUPPORTED_SOURCE');
  });

  test('URL nội bộ → 4xx, KHÔNG được fetch', async () => {
    for (const url of ['http://127.0.0.1:8080/x', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
      const res = await post({ url });
      assert.ok(res.status >= 400, `${url} lẽ ra phải bị từ chối`);
      const b = await j(res);
      assert.ok(b.error.code, 'phải có mã lỗi');
    }
  });

  test('thiếu url → 400 MISSING_URL', async () => {
    const res = await post({});
    assert.equal(res.status, 400);
    assert.equal((await j(res)).error.code, 'MISSING_URL');
  });

  test('JSON hỏng → 400 BAD_JSON', async () => {
    const res = await fetch(`${ctx.base}/api/detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{khong-phai-json',
    });
    assert.equal(res.status, 400);
    assert.equal((await j(res)).error.code, 'BAD_JSON');
  });

  test('lỗi 500 không lộ stack hay chi tiết nội bộ', async () => {
    const res = await fetch(`${ctx.base}/api/jobs/khong-ton-tai-1234`);
    assert.equal(res.status, 404);
    const b = await j(res);
    assert.ok(!('stack' in (b.error || {})));
    assert.ok(!b.error.message.includes('/Users/'), 'không được lộ đường dẫn hệ thống');
  });
});

describe('API — G01/G11/G12/G13 vòng đời job', () => {
  let ctx;
  before(async () => {
    ctx = await buildApp();
  });
  after(async () => {
    await ctx.app.close();
  });

  test('A. link bị chặn → needs_manual + bằng chứng đầy đủ', async () => {
    // Phải dùng connector BỊ CHẶN, nếu không job sẽ thành công và test này vô nghĩa.
    const blocked = await buildApp({ connectorMode: 'blocked' });
    try {
      const res = await fetch(`${blocked.base}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://detail.1688.com/offer/552160420012.html' }),
      });
      assert.equal(res.status, 202);
      const { job_id } = await j(res);

      const d = await waitJob(blocked.base, job_id);
      assert.equal(d.status, JOB_STATUS.NEEDS_MANUAL);
      assert.ok(d.evidence.rows.length >= 8, 'phải có bảng bằng chứng');
      assert.ok(d.evidence.verification, 'phải có mức kiểm chứng');
      assert.equal(d.evidence.login_required, true);
      assert.ok(d.evidence.blocked_reason.length > 0);
      assert.ok(d.product_master.extraction.blocked_reason.length > 0);
      // Không được có nội dung nào được sinh ra khi chưa có dữ liệu
      assert.equal(d.content, null);
      assert.equal(d.product_name, '');
    } finally {
      await blocked.app.close();
    }
  });

  test('B. luồng bình thường → succeeded + nội dung + usage', async () => {
    const app2 = await buildApp({ connectorMode: 'ok' });
    try {
      const res = await fetch(`${app2.base}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://detail.1688.com/offer/552160420012.html', style: 'cao-cap', length: 'chi-tiet' }),
      });
      const { job_id } = await j(res);
      const d = await waitJob(app2.base, job_id);

      assert.equal(d.status, JOB_STATUS.SUCCEEDED);
      assert.equal(d.style, 'cao-cap');
      assert.equal(d.length, 'chi-tiet');
      assert.ok(d.content.product_name, 'phải có nội dung');
      assert.ok(d.vision, 'phải có kết quả vision');
      assert.ok(d.knowledge, 'phải có knowledge');
      assert.ok(d.evidence.rows.length >= 8);
      assert.ok(d.usage_summary.events >= 1, 'phải ghi usage_event');

      // G13: đủ 4 loại operation
      const usage = await j(await fetch(`${app2.base}/api/jobs/${job_id}/usage`));
      const ops = usage.events.map((e) => e.operation);
      assert.ok(ops.includes('SOURCE_EXTRACT'));
      assert.ok(ops.includes('VISION_ANALYSIS'));
      assert.ok(ops.includes('TRANSLATION'));
      assert.ok(ops.includes('CONTENT_GENERATE'));
      for (const e of usage.events) {
        assert.ok(e.operation && e.created_at, 'usage_event phải có operation + created_at');
        assert.equal(typeof e.estimated_cost, 'number');
      }
    } finally {
      await app2.app.close();
    }
  });

  test('C. G11 fallback: dữ liệu thủ công vẫn sinh được nội dung', async () => {
    const app3 = await buildApp({ connectorMode: 'blocked' });
    try {
      const png = fixtureBuffer('headphones.png').toString('base64');
      const res = await fetch(`${app3.base}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: 'https://detail.1688.com/offer/552160420012.html',
          manual: { title: 'Tai nghe chụp tai', notes: 'Dùng cho học tập', images: [`data:image/png;base64,${png}`] },
        }),
      });
      assert.equal(res.status, 202);
      const { job_id } = await j(res);
      const d = await waitJob(app3.base, job_id);

      assert.equal(d.status, JOB_STATUS.SUCCEEDED, 'thủ công phải chạy được dù connector bị chặn');
      assert.equal(d.input_mode, 'link+manual');
      assert.ok(d.product_master.images.length >= 1);
      assert.ok(d.content.product_name);
      // Ảnh thủ công phải tới được bước Vision
      assert.ok(d.vision && d.vision.used >= 1, 'ảnh data: phải được đưa vào Vision');
    } finally {
      await app3.app.close();
    }
  });

  test('D. chỉ dữ liệu thủ công, không có link → vẫn chạy', async () => {
    const app4 = await buildApp({ connectorMode: 'blocked' });
    try {
      const res = await fetch(`${app4.base}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manual: { title: 'Sản phẩm nhập tay', notes: 'Ghi chú' } }),
      });
      const { job_id } = await j(res);
      const d = await waitJob(app4.base, job_id);
      assert.equal(d.status, JOB_STATUS.SUCCEEDED);
      assert.equal(d.input_mode, 'manual');
      assert.equal(d.source, 'manual');
    } finally {
      await app4.app.close();
    }
  });

  test('thiếu cả url lẫn manual → 400', async () => {
    const res = await fetch(`${ctx.base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal((await j(res)).error.code, 'MISSING_INPUT');
  });

  test('nguồn không hỗ trợ → 400 ngay, không tạo job', async () => {
    const res = await fetch(`${ctx.base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shopee.vn/x' }),
    });
    assert.equal(res.status, 400);
  });

  test('G12: lịch sử chỉ trả job của CHÍNH session', async () => {
    const a = await fetch(`${ctx.base}/api/jobs`, { headers: { cookie: 'sid=sessionAAAAAAA1111' } });
    const ja = await j(a);
    const b = await fetch(`${ctx.base}/api/jobs`, { headers: { cookie: 'sid=sessionBBBBBBB2222' } });
    const jb = await j(b);
    assert.ok(ja.total >= 0 && jb.total >= 0);
    for (const item of ja.items) assert.equal(item.session_id, undefined, 'không lộ session của người khác');
    // scope=all xem được toàn bộ
    const all = await j(await fetch(`${ctx.base}/api/jobs?scope=all`, { headers: { cookie: 'sid=sessionAAAAAAA1111' } }));
    assert.ok(all.total >= ja.total);
  });

  test('job không tồn tại → 404', async () => {
    const res = await fetch(`${ctx.base}/api/jobs/00000000-0000-0000-0000-000000000000`);
    assert.equal(res.status, 404);
  });

  test('mã job không hợp lệ → 400', async () => {
    const res = await fetch(`${ctx.base}/api/jobs/ab`);
    assert.equal(res.status, 400);
  });
});

describe('API — G10 sửa / sinh lại nội dung', () => {
  let ctx;
  let jobId;
  before(async () => {
    ctx = await buildApp({ connectorMode: 'ok' });
    const res = await fetch(`${ctx.base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://detail.1688.com/offer/552160420012.html' }),
    });
    jobId = (await j(res)).job_id;
    await waitJob(ctx.base, jobId);
  });
  after(async () => {
    await ctx.app.close();
  });

  test('PUT content lưu bản sửa và đánh dấu edited_by_user', async () => {
    const res = await fetch(`${ctx.base}/api/jobs/${jobId}/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product_name: 'Tên do người dùng sửa', selling_points: ['A', 'B'] }),
    });
    assert.equal(res.status, 200);
    const d = await j(res);
    assert.equal(d.content.product_name, 'Tên do người dùng sửa');
    assert.deepEqual(d.content.selling_points, ['A', 'B']);
    assert.equal(d.content_meta.edited_by_user, true);
  });

  test('sửa nội dung KHÔNG được phá các trường khác', async () => {
    const d = await j(await fetch(`${ctx.base}/api/jobs/${jobId}`));
    assert.ok(d.content.headline, 'headline phải còn');
    assert.ok(d.content.seo.title, 'seo phải còn');
  });

  test('regenerate đổi phong cách và chạy lại', async () => {
    const res = await fetch(`${ctx.base}/api/jobs/${jobId}/regenerate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ style: 'seo', length: 'ngan' }),
    });
    assert.equal(res.status, 202);
    const d = await waitJob(ctx.base, jobId);
    assert.equal(d.style, 'seo');
    assert.equal(d.length, 'ngan');
    assert.equal(d.status, JOB_STATUS.SUCCEEDED);
  });
});

describe('API — G11 upload ảnh: kiểm MIME thật, không tin client', () => {
  let ctx;
  before(async () => {
    ctx = await buildApp();
  });
  after(async () => {
    await ctx.app.close();
  });

  const upload = (images) =>
    fetch(`${ctx.base}/api/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images }),
    });

  test('ảnh PNG hợp lệ → 201', async () => {
    const b64 = fixtureBuffer('headphones.png').toString('base64');
    const res = await upload([{ filename: 'a.png', base64: b64 }]);
    assert.equal(res.status, 201);
    const d = await j(res);
    assert.equal(d.count, 1);
    assert.equal(d.uploads[0].mime, 'image/png', 'MIME phải suy từ magic bytes');
  });

  test('file KHÔNG phải ảnh → 415 dù khai là image/png', async () => {
    const evil = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    const res = await upload([{ filename: 'evil.png', mime: 'image/png', base64: evil }]);
    assert.equal(res.status, 415);
    assert.equal((await j(res)).error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('danh sách rỗng → 400', async () => {
    assert.equal((await upload([])).status, 400);
  });

  test('quá nhiều ảnh → 413', async () => {
    const b64 = fixtureBuffer('headphones.png').toString('base64');
    const many = Array.from({ length: 50 }, () => ({ base64: b64 }));
    assert.equal((await upload(many)).status, 413);
  });
});

describe('API — rate limit & routing', () => {
  test('vượt hạn mức tạo job → 429', async () => {
    const config = testConfig({ RATE_LIMIT_MAX_JOBS: '2', RATE_LIMIT_WINDOW_MS: '60000' });
    const store = await createStore(config, silent);
    const app = await createApp({
      config,
      logger: silent,
      store,
      connectors: [makeConnector('ok')],
      visionProvider: fakeVisionProvider(),
      contentEngine: fakeContentEngine(),
    });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    try {
      const body = JSON.stringify({ url: 'https://detail.1688.com/offer/552160420012.html' });
      const h = { 'content-type': 'application/json', cookie: 'sid=ratelimitsession01' };
      const codes = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: h, body });
        codes.push(res.status);
      }
      assert.ok(codes.includes(429), `lẽ ra phải có 429, nhận được ${codes.join(',')}`);
    } finally {
      await app.close();
    }
  });

  test('đường dẫn lạ → 404; sai method → 405', async () => {
    const ctx = await buildApp();
    try {
      assert.equal((await fetch(`${ctx.base}/api/khong-ton-tai`)).status, 404);
      assert.equal((await fetch(`${ctx.base}/api/health`, { method: 'POST' })).status, 405);
    } finally {
      await ctx.app.close();
    }
  });

  test('phục vụ trang chủ và chặn path traversal', async () => {
    const ctx = await buildApp();
    try {
      const home = await fetch(`${ctx.base}/`);
      assert.equal(home.status, 200);
      const html = await home.text();
      assert.match(html, /VIP Product Studio/);
      assert.match(html, /<div id="app"|id="app"/);

      // Nhãn nút do app.js render phía client — kiểm ở file JS, không phải HTML.
      const jsRes = await fetch(`${ctx.base}/app.js`);
      assert.equal(jsRes.status, 200);
      const js = await jsRes.text();
      assert.match(js, /PHÂN TÍCH SẢN PHẨM/);
      assert.match(js, /Dán link sản phẩm Taobao \/ 1688 \/ Pinduoduo/);

      const css = await fetch(`${ctx.base}/styles.css`);
      assert.equal(css.status, 200);

      // Path traversal phải bị chặn (403/404), tuyệt đối không trả nội dung file hệ thống
      for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
        const res = await fetch(`${ctx.base}${p}`);
        assert.ok(res.status >= 400, `${p} lẽ ra phải bị chặn, nhận ${res.status}`);
        const text = await res.text();
        assert.ok(!text.includes('vip-product-studio'), 'không được trả nội dung ngoài thư mục public');
      }
    } finally {
      await ctx.app.close();
    }
  });
});
