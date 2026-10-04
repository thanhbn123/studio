/**
 * IL-08 — TEST ĐƠN VỊ `normalizeManualRegions` (hợp đồng §11.2 luật 1..5, 10).
 *
 * Vì sao cần lớp test này: hàm thuần là chốt chặn cuối cùng giữa dữ liệu NGƯỜI DÙNG gõ tay
 * (không đáng tin) và DB/render. Hai lỗi nguy hiểm nhất mà nó phải chặn:
 *   1. toạ độ rác (`null` / `'  '` / `NaN` / `Infinity` / boolean / mảng) bị `Number()` hoá
 *      thành `0` ⇒ hộp "ảo" ở gốc toạ độ ⇒ vùng khác bị chặn oan / pixel bị xoá nhầm;
 *   2. hộp tràn biên bị NỚI RỘNG thay vì CẮT theo giao với khung ảnh.
 *
 * Bất biến của hợp đồng 3.2 được khẳng định xuyên suốt: `translatable === (kind === 'descriptive')`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { REGION_KINDS } from '../src/imagelab/ocr/classify.js';
import { MANUAL_DEFAULT_CONFIDENCE, MANUAL_REJECT_CODES, normalizeManualRegions } from '../src/imagelab/manual-regions.js';

const IMG = { width: 320, height: 320 };
const box = (over = {}) => ({ x: 10, y: 20, w: 100, h: 30, ...over });
const region = (over = {}) => ({ box: box(), text: '纯棉短袖T恤', ...over });
const run = (list, opts = {}) => normalizeManualRegions(list, { ...IMG, ...opts });

/** Mã lý do duy nhất của một vùng bị bỏ (mã nằm ở `code`, câu tiếng Việt ở `reason`). */
const codes = (result) => result.rejected.map((r) => r.code);

describe('IL-08 · normalizeManualRegions — text rỗng/toàn khoảng trắng ⇒ TEXT_EMPTY (không im lặng bỏ)', () => {
  const empties = ['', '   ', '\n\t ', null, undefined, {}, [], false];

  test('mọi dạng chữ rỗng đều vào `rejected` kèm code TEXT_EMPTY và index', () => {
    for (const text of empties) {
      const res = run([region({ text })]);
      assert.equal(res.regions.length, 0, `text=${JSON.stringify(text)} không được nhận`);
      assert.equal(res.rejected.length, 1, `text=${JSON.stringify(text)} phải để lại vết`);
      assert.deepEqual(codes(res), [MANUAL_REJECT_CODES.TEXT_EMPTY]);
      assert.equal(res.rejected[0].index, 0, 'index phải là vị trí 0-based trong mảng client gửi');
      assert.ok(
        res.rejected[0].reason.startsWith('TEXT_EMPTY'),
        `reason phải có tiền tố mã để máy grep được, nhận: ${res.rejected[0].reason}`,
      );
    }
  });

  test('vùng rác KHÔNG chiếm chỗ: các vùng hợp lệ khác vẫn được nhận nguyên vẹn', () => {
    const res = run([region({ text: '   ' }), region({ box: box({ x: 50 }) })]);
    assert.equal(res.regions.length, 1);
    assert.equal(res.regions[0].box.x, 50);
    assert.deepEqual(res.rejected.map((r) => r.index), [0]);
  });

  test('vùng không phải object ⇒ NOT_OBJECT, index vẫn đúng', () => {
    const res = run([null, 'chuỗi', 42, region()]);
    assert.deepEqual(codes(res), ['NOT_OBJECT', 'NOT_OBJECT', 'NOT_OBJECT']);
    assert.deepEqual(res.rejected.map((r) => r.index), [0, 1, 2]);
    assert.equal(res.regions.length, 1, 'vùng hợp lệ ở cuối mảng vẫn phải được nhận');
  });
});

describe('IL-08 · normalizeManualRegions — toạ độ rác ⇒ BAD_BOX, TUYỆT ĐỐI không hoá thành 0', () => {
  const garbage = [null, undefined, NaN, Infinity, -Infinity, true, false, [], {}, '  ', 'abc', '12px'];

  test('rác ở BẤT KỲ toạ độ nào (x/y/w/h) đều bị từ chối, không vùng nào lọt qua', () => {
    for (const field of ['x', 'y', 'w', 'h']) {
      for (const value of garbage) {
        const res = run([region({ box: box({ [field]: value }) })]);
        assert.equal(res.regions.length, 0, `${field}=${JSON.stringify(value)} KHÔNG được nhận thành vùng`);
        assert.deepEqual(codes(res), [MANUAL_REJECT_CODES.BAD_BOX], `${field}=${JSON.stringify(value)} phải là BAD_BOX`);
        // Không được có hộp "0 hoá" nào lọt ra ngoài (đây là hệ quả nguy hiểm của `Number(null) === 0`).
        assert.ok(!JSON.stringify(res.regions).includes('"x":0'), 'không được sinh vùng ở gốc toạ độ từ rác');
      }
    }
  });

  test('`box` thiếu/sai định dạng ⇒ BAD_BOX (kể cả mảng và chuỗi)', () => {
    for (const bad of [undefined, null, [], 'box', 42, true]) {
      const res = run([region({ box: bad })]);
      assert.equal(res.regions.length, 0, `box=${JSON.stringify(bad)} không được nhận`);
      assert.deepEqual(codes(res), [MANUAL_REJECT_CODES.BAD_BOX]);
    }
  });

  test('w/h <= 0 hoặc nhỏ hơn 1 pixel sau làm tròn ⇒ BAD_BOX', () => {
    for (const bad of [{ w: 0 }, { h: 0 }, { w: -5 }, { h: -1 }, { w: 0.4 }, { h: 0.2 }]) {
      const res = run([region({ box: box(bad) })]);
      assert.equal(res.regions.length, 0, `${JSON.stringify(bad)} không được nhận`);
      assert.deepEqual(codes(res), [MANUAL_REJECT_CODES.BAD_BOX]);
    }
  });

  test('toạ độ 0 HỢP LỆ vẫn được nhận — chặn rác không có nghĩa là chặn số 0', () => {
    const res = run([region({ box: { x: 0, y: 0, w: 10, h: 10 } })]);
    assert.equal(res.regions.length, 1);
    assert.deepEqual(res.regions[0].box, { x: 0, y: 0, w: 10, h: 10 });
  });
});

describe('IL-08 · normalizeManualRegions — hộp ngoài ảnh bị từ chối, hộp tràn biên bị CẮT (không nới rộng)', () => {
  test('hộp nằm hoàn toàn ngoài khung ảnh ⇒ BOX_OUTSIDE_IMAGE', () => {
    const res = run([region({ box: { x: 400, y: 400, w: 50, h: 50 } })]);
    assert.equal(res.regions.length, 0);
    assert.deepEqual(codes(res), [MANUAL_REJECT_CODES.BOX_OUTSIDE_IMAGE]);
  });

  test('hộp chỉ CHẠM biên (giao rỗng) ⇒ BOX_OUTSIDE_IMAGE, không sinh vùng 0 diện tích', () => {
    for (const b of [{ x: 320, y: 0, w: 10, h: 10 }, { x: 0, y: 320, w: 10, h: 10 }]) {
      const res = run([region({ box: b })]);
      assert.equal(res.regions.length, 0, `${JSON.stringify(b)} chạm biên nên không có diện tích`);
      assert.deepEqual(codes(res), [MANUAL_REJECT_CODES.BOX_OUTSIDE_IMAGE]);
    }
  });

  test('hộp tràn trái: ghi lại ĐÚNG phần GIAO, KHÔNG giữ w cũ (không nới rộng)', () => {
    // Ví dụ đóng băng của `geometry.js`: hộp {-30, w:240} trên ảnh rộng 320 ⇒ phần thật là 210.
    const res = run([region({ box: { x: -30, y: 10, w: 240, h: 20 } })]);
    assert.equal(res.regions.length, 1);
    assert.deepEqual(res.regions[0].box, { x: 0, y: 10, w: 210, h: 20 });
    assert.notEqual(res.regions[0].box.w, 240, 'KHÔNG được giữ w tràn ra ngoài ảnh');
    assert.equal(res.regions[0].box_normalized.w, Number((210 / 320).toFixed(6)));
  });

  test('hộp tràn trên + phải: cắt cả hai trục và ghi lại hộp đã cắt', () => {
    const res = run([region({ box: { x: 300, y: -10, w: 100, h: 100 } })]);
    assert.deepEqual(res.regions[0].box, { x: 300, y: 0, w: 20, h: 90 });
  });

  test('hộp bị cắt thì phải có CẢNH BÁO nói rõ (không im lặng sửa dữ liệu người dùng)', () => {
    const res = run([region({ box: { x: -30, y: 10, w: 240, h: 20 } })]);
    assert.ok(
      res.warnings.some((w) => w.includes('cắt')),
      `phải có cảnh báo kể rõ hộp đã bị cắt, nhận: ${JSON.stringify(res.warnings)}`,
    );
  });
});

describe('IL-08 · normalizeManualRegions — kind: client khai hợp lệ thì dùng, không thì classifyRegion', () => {
  test('kind hợp lệ được TÔN TRỌNG (kể cả khi ngược với nội dung chữ)', () => {
    const res = run([region({ text: '纯棉短袖T恤', kind: 'brand' })]);
    assert.equal(res.regions[0].kind, 'brand');
    assert.equal(res.regions[0].translatable, false, 'vùng brand KHÔNG được dịch');
  });

  test('kind thiếu/không hợp lệ ⇒ rơi về classifyRegion(text)', () => {
    const cases = [
      ['纯棉短袖T恤', undefined, 'descriptive'],
      ['品牌旗舰店', 'khong-co-loai-nay', 'brand'],
      ['ISO9001认证', 42, 'certification'],
      ['¥199', null, 'price'],
      ['包邮', {}, 'unknown'],
    ];
    for (const [text, kind, expected] of cases) {
      const res = run([region({ text, kind })]);
      assert.equal(res.regions.length, 1, `text=${text} phải được nhận`);
      assert.equal(res.regions[0].kind, expected, `text=${text} kind=${JSON.stringify(kind)}`);
      assert.equal(res.regions[0].translatable, expected === 'descriptive');
    }
  });

  test('BẤT BIẾN: translatable === (kind === "descriptive") trên mọi tổ hợp đầu vào', () => {
    const inputs = [
      region({ text: '纯棉短袖T恤', kind: 'descriptive' }),
      region({ text: '品牌旗舰店', kind: 'brand' }),
      region({ text: 'ISO9001', kind: 'certification' }),
      region({ text: '¥199', kind: 'price' }),
      region({ text: '包邮', kind: 'unknown' }),
      region({ text: '品牌旗舰店' }), // tự phân loại
      region({ text: 'ABC', kind: 'la-loai' }),
      region({ text: '纯棉', kind: 'descriptive' }),
    ];
    const res = run(inputs);
    assert.equal(res.regions.length, inputs.length);
    for (const r of res.regions) {
      assert.ok(REGION_KINDS.includes(r.kind), `kind lạ lọt ra ngoài: ${r.kind}`);
      assert.equal(r.translatable, r.kind === 'descriptive', `vùng ${r.id} phá bất biến translatable`);
    }
  });
});

describe('IL-08 · normalizeManualRegions — confidence mặc định 1, clamp 0..1; source = user', () => {
  test('thiếu/rác ⇒ mặc định 1 (người dùng tự nhập, không phải máy đoán)', () => {
    for (const value of [undefined, null, NaN, '   ', true, [], {}]) {
      const res = run([region({ confidence: value })]);
      assert.equal(res.regions[0].confidence, MANUAL_DEFAULT_CONFIDENCE, `confidence=${JSON.stringify(value)}`);
    }
  });

  test('giá trị ngoài 0..1 bị kẹp; 0 và 1 giữ nguyên', () => {
    const cases = [[2, 1], [1.5, 1], [-3, 0], [0, 0], [1, 1], ['0.5', 0.5], [0.25, 0.25]];
    for (const [value, expected] of cases) {
      const res = run([region({ confidence: value })]);
      assert.equal(res.regions[0].confidence, expected, `confidence=${JSON.stringify(value)}`);
    }
  });

  test('mọi vùng nhập tay đều có source = "user"', () => {
    const res = run([region(), region({ text: '品牌旗舰店' })]);
    assert.deepEqual(res.regions.map((r) => r.source), ['user', 'user']);
  });

  test('lang suy từ chữ: có chữ Hán ⇒ zh; thuần ASCII ⇒ und', () => {
    const res = run([region({ text: '纯棉' }), region({ text: 'ABC-123' })]);
    assert.deepEqual(res.regions.map((r) => r.lang), ['zh', 'und']);
  });
});

describe('IL-08 · normalizeManualRegions — id u1..uN; id client trùng/ký tự lạ KHÔNG làm mất vùng', () => {
  test('không gửi id ⇒ server gán u1..uN theo thứ tự', () => {
    const res = run([region(), region(), region()]);
    assert.deepEqual(res.regions.map((r) => r.id), ['u1', 'u2', 'u3']);
  });

  test('id client trùng nhau ⇒ chỉ giữ cái đầu, cái sau được gán id mới (không mất vùng)', () => {
    const res = run([region({ id: 'dup' }), region({ id: 'dup' }), region({ id: 'dup' })]);
    assert.equal(res.regions.length, 3, 'KHÔNG được bỏ vùng chỉ vì id trùng');
    assert.deepEqual(res.regions.map((r) => r.id), ['dup', 'u1', 'u2']);
    assert.equal(new Set(res.regions.map((r) => r.id)).size, 3, 'id phải duy nhất');
    assert.ok(res.warnings.some((w) => w.includes('dup')), 'phải nói rõ vì sao id bị đổi');
  });

  test('id chứa ký tự lạ (XSS, khoảng trắng, quá dài, không phải chuỗi) ⇒ server gán id mới an toàn', () => {
    const weird = ['<img src=x onerror=alert(1)>', 'a b', 'x'.repeat(80), '', 42, {}, ['u1']];
    const res = run(weird.map((id) => region({ id })));
    assert.equal(res.regions.length, weird.length, 'KHÔNG được mất vùng nào');
    for (const r of res.regions) {
      assert.match(r.id, /^[A-Za-z0-9_-]{1,64}$/, `id phải an toàn cho DB/render, nhận ${r.id}`);
    }
    assert.equal(new Set(res.regions.map((r) => r.id)).size, weird.length);
  });

  test('chế độ ghi thêm: id mới KHÔNG đụng id đã dùng của job', () => {
    const res = run([region(), region()], { usedIds: ['u1', 'u2', 'u3'] });
    assert.deepEqual(res.regions.map((r) => r.id), ['u4', 'u5']);
  });

  test('id client trùng với id đã dùng của job ⇒ server gán id mới', () => {
    const res = run([region({ id: 'u1' })], { usedIds: ['u1'] });
    assert.equal(res.regions.length, 1);
    assert.notEqual(res.regions[0].id, 'u1');
  });
});

describe('IL-08 · normalizeManualRegions — trần maxRegions ⇒ TOO_MANY_REGIONS (mọi vùng vượt đều có vết)', () => {
  test('vượt trần: giữ đúng `maxRegions` vùng đầu, phần sau vào rejected kèm index', () => {
    const res = run([region(), region(), region(), region()], { maxRegions: 2 });
    assert.equal(res.regions.length, 2);
    assert.deepEqual(res.rejected.map((r) => r.index), [2, 3]);
    assert.deepEqual(codes(res), [MANUAL_REJECT_CODES.TOO_MANY_REGIONS, MANUAL_REJECT_CODES.TOO_MANY_REGIONS]);
    assert.ok(res.rejected.every((r) => r.reason.startsWith('TOO_MANY_REGIONS')));
  });

  test('maxRegions = 0 nghĩa là HẾT CHỖ (khác `null`/`undefined` = không giới hạn)', () => {
    const zero = run([region(), region()], { maxRegions: 0 });
    assert.equal(zero.regions.length, 0);
    assert.deepEqual(codes(zero), [MANUAL_REJECT_CODES.TOO_MANY_REGIONS, MANUAL_REJECT_CODES.TOO_MANY_REGIONS]);

    for (const unlimited of [undefined, null, '  ']) {
      const res = run([region(), region()], { maxRegions: unlimited });
      assert.equal(res.regions.length, 2, `maxRegions=${JSON.stringify(unlimited)} phải là không giới hạn`);
    }
  });

  test('vùng rác KHÔNG chiếm chỗ trong trần: 1 rác + 2 hợp lệ với maxRegions 1', () => {
    const res = run([region({ text: ' ' }), region(), region()], { maxRegions: 1 });
    assert.equal(res.regions.length, 1);
    assert.deepEqual(res.rejected.map((r) => [r.index, r.code]), [[0, 'TEXT_EMPTY'], [2, 'TOO_MANY_REGIONS']]);
  });
});

describe('IL-08 · normalizeManualRegions — dữ liệu biên khác', () => {
  test('ảnh gốc thiếu kích thước ⇒ fail-closed: bỏ TOÀN BỘ vùng kèm NO_IMAGE_SIZE', () => {
    for (const dims of [{}, { width: 0, height: 0 }, { width: -10, height: 320 }, { width: 320, height: NaN }]) {
      const res = normalizeManualRegions([region(), region()], dims);
      assert.equal(res.regions.length, 0, `dims=${JSON.stringify(dims)} không được nhận vùng nào`);
      assert.deepEqual(codes(res), [MANUAL_REJECT_CODES.NO_IMAGE_SIZE, MANUAL_REJECT_CODES.NO_IMAGE_SIZE]);
    }
  });

  test('đầu vào không phải mảng ⇒ không có vùng nào + cảnh báo (không ném lỗi)', () => {
    for (const bad of [null, undefined, 'abc', 42, {}]) {
      const res = normalizeManualRegions(bad, IMG);
      assert.deepEqual(res.regions, []);
      assert.ok(Array.isArray(res.rejected));
      assert.ok(res.warnings.length >= 1, 'phải nói rõ vì sao không có vùng nào');
    }
  });

  test('chữ quá dài bị cắt theo trần 500 ký tự và vẫn giữ được vùng', () => {
    const long = '中'.repeat(600);
    const res = run([region({ text: long })]);
    assert.equal(res.regions.length, 1);
    const text = res.regions[0].text;
    assert.ok(text.startsWith('中'.repeat(500)), 'phải giữ 500 ký tự đầu');
    assert.ok(text.length <= 501, `độ dài sau làm sạch phải quanh trần 500, nhận ${text.length}`);
    assert.ok(text.includes('…'), 'phần bị cắt phải có dấu hiệu');
  });

  test('ký tự điều khiển bị loại khỏi chữ người dùng nhập', () => {
    const res = run([region({ text: '纯\u0000棉\u001b[31m' })]);
    assert.equal(res.regions[0].text, '纯棉[31m');
  });
});
