/**
 * TEST — THỨ TỰ VẾT phải ổn định khi nhiều sự kiện rơi CÙNG MỘT MILI-GIÂY.
 *
 * Lỗi đo được (10/10/2026): `test/topup-api.test.js` "TỪ CHỐI ⇒ …" hỏng chập chờn ~1/33 lượt vì
 * `listTopupEvents` xếp theo `created_at, id`. Sự kiện "tạo" và "từ chối" của một yêu cầu thỉnh thoảng
 * có cùng `created_at` (độ phân giải 1 ms), khi đó thứ tự rơi vào UUID ngẫu nhiên ⇒ sự kiện cuối có
 * thể là "pending" ⇒ màn vết hiện SAI thứ tự. Đây là LẦN THỨ HAI cùng kiểu (lần đầu: `wallet_ledger`,
 * sửa bằng cột `seq`) ⇒ theo CLAUDE.md §12.2 đổi cấu trúc: `topup_events.seq` tăng dần theo yêu cầu.
 * `publish_logs` cùng nguy cơ ⇒ xếp theo cột `attempt` vốn đã tăng dần.
 *
 * Cách ép lỗi lộ ra MỖI lần (không trông vào may rủi): ghim `Date` về một mốc cố định để mọi
 * `nowIso()` trả cùng một chuỗi, rồi lặp 40 lần — trên mã cũ xác suất cả 40 lần đều đúng thứ tự
 * là (1/2)^40.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/store/index.js';
import { testConfig, silent } from './helpers.js';

const FIXED = Date.parse('2026-10-10T02:00:00.000Z');
const RealDate = globalThis.Date;

function freezeClock() {
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [FIXED]));
    }

    static now() {
      return FIXED;
    }
  }
  globalThis.Date = FrozenDate;
}

function thawClock() {
  globalThis.Date = RealDate;
}

describe('Thứ tự vết khi cùng mili-giây (topup_events, publish_logs)', () => {
  let store;
  before(async () => {
    store = await createStore(testConfig({}), silent);
    await store.init?.();
  });
  after(async () => {
    thawClock();
    await store?.close?.();
  });

  test('topup_events: "tạo" luôn đứng trước "từ chối"/"xác nhận" dù cùng created_at — 40 lần liên tiếp', async () => {
    freezeClock();
    try {
      for (let i = 0; i < 40; i += 1) {
        const req = await store.createTopupRequest({ userId: `u-order-${i}`, amountVnd: 100000, reference: `REF-${i}`, credits: 1, rateVndPerCredit: 100000 });
        const decided = await store.decideTopupRequest(req.id, { toStatus: i % 2 ? 'rejected' : 'confirmed', actorUserId: 'admin', reason: 'thử thứ tự' });
        assert.ok(decided, `lượt ${i}: chuyển trạng thái được`);
        const events = await store.listTopupEvents(req.id);
        assert.equal(events.length, 2, `lượt ${i}: đúng 2 sự kiện`);
        assert.equal(events[0].created_at, events[1].created_at, `lượt ${i}: hai sự kiện CÙNG created_at (đồng hồ đã ghim)`);
        assert.deepEqual(events.map((e) => e.to_status), ['pending', i % 2 ? 'rejected' : 'confirmed'], `lượt ${i}: thứ tự vết đúng trình tự xảy ra`);
        assert.deepEqual(events.map((e) => e.seq), [1, 2], `lượt ${i}: seq tăng dần trong phạm vi MỘT yêu cầu`);
      }
    } finally {
      thawClock();
    }
  });

  test('topup_events: seq đếm RIÊNG theo từng yêu cầu (yêu cầu khác không làm nhảy số)', async () => {
    const a = await store.createTopupRequest({ userId: 'u-seq-a', amountVnd: 100000, reference: 'SEQ-A', credits: 1, rateVndPerCredit: 100000 });
    const b = await store.createTopupRequest({ userId: 'u-seq-b', amountVnd: 100000, reference: 'SEQ-B', credits: 1, rateVndPerCredit: 100000 });
    await store.decideTopupRequest(a.id, { toStatus: 'rejected', actorUserId: 'admin', reason: 'x' });
    assert.deepEqual((await store.listTopupEvents(a.id)).map((e) => e.seq), [1, 2]);
    assert.deepEqual((await store.listTopupEvents(b.id)).map((e) => e.seq), [1]);
  });

  test('publish_logs: xếp theo attempt khi cùng created_at — 40 lượt ghi đảo id', async () => {
    freezeClock();
    try {
      const itemId = 'item-order-1';
      for (let attempt = 1; attempt <= 40; attempt += 1) {
        await store.appendPublishLog({ itemId, attempt, provider: 'dry-run', channel: 'facebook_page', status: 'FAILED', errorCode: 'X', errorMessage: `lượt ${attempt}` });
      }
      const logs = await store.listPublishLogs(itemId, { limit: 100 });
      assert.equal(logs.length, 40);
      assert.ok(logs.every((l) => l.created_at === logs[0].created_at), 'mọi dòng cùng created_at (đồng hồ đã ghim)');
      assert.deepEqual(logs.map((l) => Number(l.attempt)), Array.from({ length: 40 }, (_, k) => k + 1), 'thứ tự = thứ tự attempt, không phụ thuộc UUID');
    } finally {
      thawClock();
    }
  });
});
