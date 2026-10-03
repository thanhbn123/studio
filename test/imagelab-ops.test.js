/**
 * MVP-02 — CHUẨN HOÁ `RenderOp` (`src/imagelab/render/ops.js`).
 *
 * Luật của dự án: op hỏng KHÔNG được làm sập cả ảnh — nó vào `skipped` kèm lý do máy đọc được,
 * các op còn lại vẫn chạy, và **không bao giờ đoán bừa nội dung chữ**.
 *
 * Vì sao đáng test riêng: đây là cửa vào của mọi lệnh vẽ/xoá pixel. Nếu nó nhận op rác rồi
 * "đoán" thành lệnh hợp lệ, hậu quả là xoá nhầm vùng ảnh — đúng loại lỗi mà phản biện từng bắt.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOps, RENDER_ACTIONS, actionNeedsText } from '../src/imagelab/render/ops.js';

describe('MVP-02 ops · normalizeOps — op hỏng vào `skipped`, không làm sập cả ảnh', () => {
  test('ops rỗng/không phải mảng ⇒ không có op nào, lý do rõ', () => {
    assert.deepEqual(normalizeOps(undefined), { ops: [], skipped: [] });
    assert.deepEqual(normalizeOps(null), { ops: [], skipped: [] });
    const notArray = normalizeOps('khong-phai-mang');
    assert.equal(notArray.ops.length, 0);
    assert.deepEqual(notArray.skipped, [{ region_id: '*', reason: 'BAD_OPS' }]);
  });

  test('phần tử rác (null, số, chuỗi) ⇒ BAD_OP, các op tốt vẫn chạy', () => {
    const { ops, skipped } = normalizeOps([
      null,
      42,
      'op-rac',
      { region_id: 'r1', action: 'erase', box: { x: 0, y: 0, w: 10, h: 10 } },
    ]);

    assert.equal(ops.length, 1, 'op hợp lệ phải được giữ');
    assert.equal(ops[0].region_id, 'r1');
    assert.deepEqual(skipped.map((s) => s.reason), ['BAD_OP', 'BAD_OP', 'BAD_OP']);
    assert.deepEqual(skipped.map((s) => s.region_id), ['op_0', 'op_1', 'op_2'], 'thiếu region_id thì đánh số theo vị trí');
  });

  test('action không hợp lệ ⇒ UNSUPPORTED_ACTION (không suy diễn thành lệnh khác)', () => {
    const { ops, skipped } = normalizeOps([
      { region_id: 'r1', action: 'xoa-het-anh', box: { x: 0, y: 0, w: 5, h: 5 } },
      { region_id: 'r2', action: 'DRAW_TEXT', text: 'AB', box: { x: 0, y: 0, w: 5, h: 5 } },
    ]);

    assert.equal(ops.length, 1, 'chỉ op có action hợp lệ được giữ');
    assert.equal(ops[0].region_id, 'r2');
    assert.equal(ops[0].action, 'draw_text', 'action được chuẩn hoá về chữ thường');
    assert.deepEqual(skipped, [{ region_id: 'r1', reason: 'UNSUPPORTED_ACTION' }]);
  });

  test('cần chữ mà chữ RỖNG/toàn khoảng trắng ⇒ NO_TEXT (không vẽ ô trống)', () => {
    for (const text of ['', '   ', '\n\t', undefined, null]) {
      const { ops, skipped } = normalizeOps([{ region_id: 'r1', action: 'draw_text', text, box: { x: 0, y: 0, w: 5, h: 5 } }]);
      assert.equal(ops.length, 0, `text=${JSON.stringify(text)} không được thành op`);
      assert.deepEqual(skipped, [{ region_id: 'r1', reason: 'NO_TEXT' }]);
    }
  });

  test('bỏ trống action ⇒ suy ra: có chữ thì erase_and_draw, không chữ thì erase', () => {
    const withText = normalizeOps([{ region_id: 'r1', text: 'Áo thun' }]);
    assert.equal(withText.ops[0].action, 'erase_and_draw');
    const withoutText = normalizeOps([{ region_id: 'r2' }]);
    assert.equal(withoutText.ops[0].action, 'erase');
    assert.equal(withoutText.skipped.length, 0);
  });

  test('box thiếu/sai kiểu ⇒ box = null (để tầng dưới bỏ qua, KHÔNG đoán toạ độ)', () => {
    const { ops } = normalizeOps([
      { region_id: 'r1', action: 'erase' },
      { region_id: 'r2', action: 'erase', box: 'khong-phai-hop' },
      { region_id: 'r3', action: 'erase', box: { x: 1, y: 2, w: 3, h: 4 } },
    ]);
    assert.equal(ops[0].box, null);
    assert.equal(ops[1].box, null);
    assert.deepEqual(ops[2].box, { x: 1, y: 2, w: 3, h: 4 });
  });

  test('region_id rỗng/toàn khoảng trắng ⇒ đánh số theo vị trí (không nhận id rác vào log)', () => {
    const { ops } = normalizeOps([
      { region_id: '   ', action: 'erase' },
      { region_id: 123, action: 'erase' },
    ]);
    assert.deepEqual(ops.map((o) => o.region_id), ['op_0', 'op_1']);
  });

  test('style không phải object ⇒ {} (không truyền rác xuống tầng vẽ)', () => {
    const { ops } = normalizeOps([
      { region_id: 'r1', action: 'draw_text', text: 'AB', style: 'mau-do' },
      { region_id: 'r2', action: 'draw_text', text: 'CD', style: { color: [0, 0, 0] } },
    ]);
    assert.deepEqual(ops[0].style, {});
    assert.deepEqual(ops[1].style, { color: [0, 0, 0] });
  });

  test('giữ nguyên thứ tự và chỉ số gốc để map ngược về vùng', () => {
    const { ops } = normalizeOps([
      { region_id: 'r1', action: 'erase' },
      null,
      { region_id: 'r3', action: 'erase' },
    ]);
    assert.deepEqual(ops.map((o) => [o.region_id, o.index]), [['r1', 0], ['r3', 2]]);
  });

  test('hằng số action đóng băng + actionNeedsText đúng', () => {
    assert.deepEqual([...RENDER_ACTIONS], ['erase', 'draw_text', 'erase_and_draw']);
    assert.equal(actionNeedsText('erase'), false);
    assert.equal(actionNeedsText('draw_text'), true);
    assert.equal(actionNeedsText('erase_and_draw'), true);
  });
});
