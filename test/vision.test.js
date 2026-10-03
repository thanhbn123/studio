/**
 * G07 — TEST VISION PROVIDER (dùng VisionProvider THẬT + AI provider GIẢ).
 *
 * Vì sao cần file test riêng: bộ test API dùng VisionProvider giả, nên nó **không thể**
 * phát hiện lỗi nằm trong chính VisionProvider thật. Đã xảy ra đúng như vậy: ảnh thủ công
 * (data URL) không bao giờ tới được Vision, mà toàn bộ test vẫn xanh — chỉ có
 * `tools/live-probe.mjs` chạy trên dữ liệu thật mới lộ ra.
 *
 * Luật rút ra: tầng nào có logic riêng thì phải có test chạy chính tầng đó.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VisionProvider, enforceVisionGuardrails, emptyVisionAnalysis, VisionError } from '../src/vision/vision-provider.js';
import { MockProvider } from '../src/ai/provider.js';
import { testConfig, silent, fixtureBuffer } from './helpers.js';

const analysis = {
  product_type: 'tai nghe chụp tai',
  visible_features: ['vành đen', 'đệm tai màu xanh dương'],
  visible_text: [],
  colors: ['đen', 'xanh dương'],
  likely_use_cases: ['nghe nhạc'],
  uncertain_claims: [],
};

const makeVision = (responses, config = testConfig()) =>
  new VisionProvider({
    provider: new MockProvider({ responses }),
    maxImages: config.vision.maxImages,
    logger: silent,
    config,
  });

const dataUrl = (name) => `data:image/png;base64,${fixtureBuffer(name).toString('base64')}`;

describe('G07 — VisionProvider nhận ảnh', () => {
  test('REGRESSION: ảnh data URL (người dùng tải lên) PHẢI tới được Vision', async () => {
    const vp = makeVision([JSON.stringify(analysis)]);
    const r = await vp.analyzeImages([{ url: dataUrl('headphones.png') }]);

    assert.equal(r.status, 'OK', `ảnh data URL bị bỏ qua: ${r.warnings.join(' | ')}`);
    assert.equal(r.used, 1, 'phải dùng đúng 1 ảnh');
    assert.equal(r.skipped, 0);
    assert.equal(r.analysis.product_type, 'tai nghe chụp tai');
  });

  test('ảnh base64 thuần cũng nhận', async () => {
    const vp = makeVision([JSON.stringify(analysis)]);
    const r = await vp.analyzeImages([{ base64: fixtureBuffer('headphones.png').toString('base64') }]);
    assert.equal(r.used, 1);
  });

  test('dữ liệu không phải ảnh bị từ chối (kiểm magic bytes)', async () => {
    const vp = makeVision([JSON.stringify(analysis)]);
    const r = await vp.analyzeImages([{ base64: Buffer.from('<html>khong phai anh</html>').toString('base64') }]);
    assert.equal(r.used, 0);
    assert.equal(r.status, 'NO_IMAGES');
    assert.ok(r.warnings.some((w) => /magic bytes|không phải ảnh/i.test(w)));
  });

  test('ảnh lỗi không làm hỏng ảnh tốt còn lại', async () => {
    const vp = makeVision([JSON.stringify(analysis)]);
    const r = await vp.analyzeImages([
      { base64: Buffer.from('rác không phải ảnh').toString('base64') },
      { url: dataUrl('headphones.png') },
    ]);
    assert.equal(r.used, 1, 'ảnh tốt vẫn phải được dùng');
    assert.equal(r.skipped, 1);
  });

  test('tôn trọng giới hạn số ảnh', async () => {
    const cfg = testConfig({ VISION_MAX_IMAGES: '2' });
    const vp = makeVision([JSON.stringify(analysis)], cfg);
    const r = await vp.analyzeImages([
      { url: dataUrl('headphones.png') },
      { url: dataUrl('headphones.png') },
      { url: dataUrl('headphones.png') },
    ]);
    assert.equal(r.used, 2, 'chỉ gửi tối đa VISION_MAX_IMAGES ảnh');
  });

  test('không có ảnh nào → NO_IMAGES, không gọi model', async () => {
    const vp = makeVision([]);
    const r = await vp.analyzeImages([]);
    assert.equal(r.status, 'NO_IMAGES');
    assert.equal(r.used, 0);
  });

  test('model trả JSON hỏng → VisionError', async () => {
    const vp = makeVision(['không phải JSON']);
    await assert.rejects(
      () => vp.analyzeImages([{ url: dataUrl('headphones.png') }]),
      (e) => e instanceof VisionError && e.code === 'VISION_BAD_JSON',
    );
  });

  test('JSON bọc trong ``` vẫn parse được', async () => {
    const vp = makeVision(['```json\n' + JSON.stringify(analysis) + '\n```']);
    const r = await vp.analyzeImages([{ url: dataUrl('headphones.png') }]);
    assert.equal(r.analysis.product_type, 'tai nghe chụp tai');
  });
});

describe('G07 — guardrails chống bịa của Vision', () => {
  test('khẳng định thiếu bằng chứng bị CHUYỂN sang uncertain_claims', () => {
    const { analysis: out, moved } = enforceVisionGuardrails({
      product_type: 'tai nghe',
      visible_features: [
        'vành đen', // nhìn thấy thật
        'chống nước IP68', // bịa
        'dung lượng pin 5000mAh', // bịa
        'da thật cao cấp', // bịa
        'đạt chứng nhận ISO 9001', // bịa
      ],
      visible_text: [],
      colors: ['đen'],
      likely_use_cases: [],
      uncertain_claims: [],
    });

    assert.deepEqual(out.visible_features, ['vành đen'], 'chỉ giữ đặc điểm có thật');
    assert.equal(moved.length, 4);
    for (const m of moved) assert.ok(out.uncertain_claims.some((u) => u.includes(m)));
    assert.ok(out.uncertain_claims.every((u) => /Cần xác minh/.test(u)));
  });

  test('khẳng định CÓ chữ trong ảnh thì được GIỮ LẠI', () => {
    const text = 'chống nước IP68';
    const { analysis: out, moved } = enforceVisionGuardrails({
      product_type: 'đồng hồ',
      visible_features: [text],
      visible_text: [text], // ảnh có chữ này → có bằng chứng
      colors: [],
      likely_use_cases: [],
      uncertain_claims: [],
    });
    assert.deepEqual(out.visible_features, [text]);
    assert.equal(moved.length, 0);
  });

  test('đầu vào rác → trả về phân tích rỗng, không ném lỗi', () => {
    const { analysis: a } = enforceVisionGuardrails(null);
    assert.deepEqual(a, emptyVisionAnalysis());
    const { analysis: b } = enforceVisionGuardrails({ visible_features: 'không phải mảng' });
    assert.deepEqual(b.visible_features, []);
  });

  test('cắt bớt số lượng để không phình dữ liệu', () => {
    const { analysis: out } = enforceVisionGuardrails({
      product_type: 'x',
      visible_features: Array.from({ length: 50 }, (_, i) => `đặc điểm ${i}`),
      visible_text: [],
      colors: Array.from({ length: 50 }, (_, i) => `màu ${i}`),
      likely_use_cases: [],
      uncertain_claims: [],
    });
    assert.ok(out.visible_features.length <= 12);
    assert.ok(out.colors.length <= 10);
  });
});

describe('G07 — prompt cấm rõ ràng', () => {
  test('prompt gửi model có nêu các thuộc tính bị cấm đoán', async () => {
    const vp = makeVision([JSON.stringify(analysis)]);
    await vp.analyzeImages([{ url: dataUrl('headphones.png') }]);
    const sent = vp.provider.calls[0].messages.map((m) => m.text).join('\n');
    for (const term of ['chất liệu', 'dung lượng', 'công suất', 'chống nước', 'chứng nhận', 'bảo hành', 'nguồn gốc', 'giá']) {
      assert.ok(sent.includes(term), `prompt thiếu lệnh cấm đoán "${term}"`);
    }
    assert.match(sent, /uncertain_claims/);
  });
});
