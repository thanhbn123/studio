/**
 * TEST TÍNH TRUNG THỰC CỦA NHÃN KIỂM CHỨNG (MOCK vs LIVE) + các lỗi verifier tìm ra.
 *
 * Vì sao file này tồn tại: verifier độc lập đã dựng lại được một ca mà **dữ liệu hoàn toàn
 * từ fixture, không mở socket nào, lại được ghi là `LIVE_VERIFIED`**. Đó đúng là kiểu hỏng
 * "thứ dùng để kiểm chứng lại tự nó không trung thực": nhãn dùng để phân biệt mock với thật
 * lại chính là thứ nói dối.
 *
 * Luật được khoá ở đây: **mức kiểm chứng do NGUỒN GỐC DỮ LIỆU quyết định**, không phải do
 * "có lấy được field hay không".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { determineVerificationLevel } from '../src/jobs/pipeline.js';
import { Pipeline } from '../src/jobs/pipeline.js';
import { createStore } from '../src/store/index.js';
import { ConnectorRegistry } from '../src/sources/registry.js';
import { ProductSourceConnector } from '../src/sources/base-connector.js';
import { createEmptyMaster, STATUS, evidenceTable } from '../src/product-master.js';
import { testConfig, silent, fakeContentEngine, fakeVisionProvider, fixture } from './helpers.js';
import { Router, HttpError } from '../src/http/server.js';

/** Master "trông như thật" nhưng đến từ fixture. */
const fixtureMaster = (over = {}) => {
  const m = createEmptyMaster({ source: 'taobao', sourceUrl: 'https://x/y' });
  m.title_original = 'Sản phẩm từ fixture';
  m.title_original_status = STATUS.FOUND;
  m.images.push({ url: 'https://img.alicdn.com/a.jpg', type: 'cover', status: STATUS.FOUND, provenance: 'source' });
  m.extraction.method = 'ssr-ice-app-context';
  m.extraction.connector = 'Taobao';
  m.extraction.transport = 'unknown'; // fetcher giả không gắn 'http'
  return { ...m, ...over };
};

describe('Nhãn kiểm chứng — nguồn gốc quyết định, không phải "có field"', () => {
  test('REGRESSION: dữ liệu từ FIXTURE không bao giờ được là LIVE_VERIFIED', () => {
    const m = fixtureMaster();
    const level = determineVerificationLevel(m);
    assert.equal(level, 'MOCK_VERIFIED');
    assert.notEqual(level, 'LIVE_VERIFIED');
  });

  test('dữ liệu THẬT qua mạng + có dữ liệu → LIVE_VERIFIED', () => {
    const m = fixtureMaster();
    m.extraction.transport = 'http';
    assert.equal(determineVerificationLevel(m), 'LIVE_VERIFIED');
  });

  test('có session đăng nhập → AUTHENTICATED_LIVE_VERIFIED', () => {
    const m = fixtureMaster();
    m.extraction.transport = 'http';
    m.extraction.used_session = true;
    assert.equal(determineVerificationLevel(m), 'AUTHENTICATED_LIVE_VERIFIED');
  });

  test('người dùng tự nhập → MANUAL_INPUT (không phải LIVE, cũng không phải MOCK)', () => {
    const m = createEmptyMaster({ source: 'manual' });
    m.title_original = 'Người dùng tự gõ';
    m.title_original_status = STATUS.FOUND;
    m.extraction.transport = 'manual';
    assert.equal(determineVerificationLevel(m), 'MANUAL_INPUT');
  });

  test('tải thật nhưng không lấy được gì → BLOCKED', () => {
    const m = createEmptyMaster({ source: 'pinduoduo' });
    m.extraction.transport = 'http';
    m.extraction.login_required = true;
    assert.equal(determineVerificationLevel(m), 'BLOCKED');
  });

  test('nguồn không hỗ trợ → UNSUPPORTED (trước đây ghi nhầm thành BLOCKED)', () => {
    const m = createEmptyMaster({ source: '' });
    m.extraction.transport = 'none';
    m.extraction.error_code = 'UNSUPPORTED_SOURCE';
    assert.equal(determineVerificationLevel(m), 'UNSUPPORTED');
  });

  test('không có transport → MOCK_VERIFIED (mặc định phải là phía AN TOÀN)', () => {
    assert.equal(determineVerificationLevel(createEmptyMaster()), 'MOCK_VERIFIED');
    assert.equal(determineVerificationLevel(null), 'MOCK_VERIFIED');
  });
});

describe('REGRESSION: chạy Pipeline THẬT với connector giả — nhãn phải là MOCK', () => {
  /** Connector đọc fixture, KHÔNG mở socket (fetcher giả không gắn transport). */
  const FixtureConnector = (html) =>
    class extends ProductSourceConnector {
      static source = '1688';
      static displayName = 'FixtureConnector';
      async fetchProduct() {
        return { html, status: 200, finalUrl: this.homeUrl(), redirects: [], bytes: html.length, method: 'http-get' };
      }
      normalize(raw, master) {
        master.title_original = 'Sản phẩm thật trong fixture';
        master.title_original_status = STATUS.FOUND;
        master.images.push({ url: 'https://cbu01.alicdn.com/a.jpg', type: 'cover', status: STATUS.FOUND, provenance: 'source' });
        master.price = { raw: '12.5', currency: 'CNY', status: STATUS.FOUND, kind: 'fixed', tiers: [] };
        return master;
      }
    };

  const buildPipeline = async () => {
    const config = testConfig();
    const store = await createStore(config, silent);
    const registry = new ConnectorRegistry({ config, logger: silent });
    registry.registerAll([FixtureConnector(fixture('1688-offer-real-structure.html'))]);
    const pipeline = new Pipeline({
      config,
      logger: silent,
      store,
      registry,
      visionProvider: fakeVisionProvider(),
      contentEngine: fakeContentEngine(),
    });
    return { store, pipeline, config };
  };

  test('job đọc từ fixture: bằng chứng trong DB phải là MOCK_VERIFIED', async () => {
    const { store, pipeline } = await buildPipeline();
    try {
      const jobId = await store.createJob({ sessionId: 'v', source: '1688', sourceUrl: 'https://detail.1688.com/offer/1.html' });
      const out = await pipeline.run(jobId, { url: 'https://detail.1688.com/offer/1.html', sessionId: 'v' });
      const job = await store.getJob(jobId);

      assert.equal(out.status, 'succeeded');
      assert.equal(
        job.evidence.verification,
        'MOCK_VERIFIED',
        'dữ liệu fixture KHÔNG được gắn nhãn LIVE_VERIFIED',
      );
      // Cột trong bảng extraction_evidence cũng phải khớp blob JSON — không được lệch nhau.
      const rows = await store.getEvidence(jobId);
      assert.equal(rows[0].verification, 'MOCK_VERIFIED');
      assert.equal(rows[0].verification, job.evidence.verification);
    } finally {
      await store.close();
    }
  });

  test('job chỉ có dữ liệu NGƯỜI DÙNG nhập: phải là MANUAL_INPUT', async () => {
    const { store, pipeline } = await buildPipeline();
    try {
      const jobId = await store.createJob({ sessionId: 'v', source: 'manual', inputMode: 'manual' });
      await pipeline.run(jobId, {
        manual: { title: 'Người dùng tự nhập tên', notes: 'Ghi chú tự nhập' },
        sessionId: 'v',
      });
      const job = await store.getJob(jobId);
      assert.equal(job.evidence.verification, 'MANUAL_INPUT');
      const rows = await store.getEvidence(jobId);
      assert.equal(rows[0].verification, 'MANUAL_INPUT');
    } finally {
      await store.close();
    }
  });
});

describe('REGRESSION: bằng chứng không được mâu thuẫn với chính nó', () => {
  test('page bị chặn: field_status và evidenceTable phải CÙNG nói một điều', () => {
    const m = createEmptyMaster({ source: 'pinduoduo' });
    m.extraction.transport = 'http';
    m.extraction.login_required = true;
    for (const k of ['images', 'videos', 'variants', 'attributes', 'title_original', 'description_original', 'price', 'store']) {
      m.extraction.field_status[k] = STATUS.LOGIN_REQUIRED;
    }
    m.price.status = STATUS.LOGIN_REQUIRED;
    m.store.status = STATUS.LOGIN_REQUIRED;
    m.title_original_status = STATUS.LOGIN_REQUIRED;
    m.description_original_status = STATUS.LOGIN_REQUIRED;
    const rows = evidenceTable(m).rows;
    assert.ok(rows.every((r) => r.status === STATUS.LOGIN_REQUIRED), JSON.stringify(rows));
  });

  test('ảnh có status KHÁC FOUND không được đếm là "FOUND"', () => {
    const m = createEmptyMaster({ source: '1688' });
    m.images.push({ url: 'https://x/a.jpg', type: 'cover', status: STATUS.LOGIN_REQUIRED, provenance: 'source' });
    const ev = evidenceTable(m);
    const imgRow = ev.rows.find((r) => r.label === 'Ảnh');
    assert.equal(imgRow.status, STATUS.LOGIN_REQUIRED);
    assert.match(imgRow.detail, /^0 FOUND/, 'chi tiết phải đếm theo status, không theo độ dài mảng');
    assert.equal(ev.summary.images_found, 0);
  });

  test('nguồn không hỗ trợ: title_original_status và field_status phải thống nhất', () => {
    const m = createEmptyMaster({ source: '' });
    m.title_original_status = STATUS.UNSUPPORTED;
    m.extraction.field_status = { title_original: STATUS.UNSUPPORTED };
    const { recomputeEvidence } = { recomputeEvidence: null };
    // recomputeEvidence được kiểm gián tiếp qua evidenceTable
    const row = evidenceTable(m).rows.find((r) => r.label === 'Tiêu đề gốc');
    assert.equal(row.status, STATUS.UNSUPPORTED);
  });
});

describe('REGRESSION: router không được trả 500 vì %-mã-hoá hỏng', () => {
  test('decodeURIComponent lỗi → HttpError 400, không phải URIError', () => {
    const r = new Router();
    r.get('/api/jobs/:id', () => 'ok');
    assert.throws(
      () => r.match('GET', '/api/jobs/%E0%A4%A'),
      (e) => e instanceof HttpError && e.status === 400 && e.code === 'BAD_ENCODING',
    );
  });

  test('đường dẫn bình thường vẫn khớp', () => {
    const r = new Router();
    r.get('/api/jobs/:id', () => 'ok');
    assert.equal(r.match('GET', '/api/jobs/abc-123').handler(), 'ok');
  });
});
