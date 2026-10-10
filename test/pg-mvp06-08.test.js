/**
 * TEST — PostgreSQL THẬT cho các bảng của MVP-06 / MVP-07 / MVP-08
 *   `topup_requests`, `topup_events`, `publish_items`, `publish_logs`, `marketplace_listings`, `marketplace_events`.
 *
 * Luật §25 của VERIFICATION.md: bảng mới phải được đo trên PostgreSQL thật, và hành vi phải GIỐNG
 * SQLite trên CÙNG dữ liệu. Bỏ qua có kiểm soát khi không có `DATABASE_URL` (như mọi `test/pg-*.test.js`).
 *
 * Phủ:
 *   1. Kiểu cột tiền/credit là `double precision` (không phải `real` — bài học §25); cột `seq` có mặt;
 *      các UNIQUE index chống trùng thật sự tồn tại trên PostgreSQL.
 *   2. NGUYÊN TỬ (luật #2 MVP-06): ghi vết hỏng giữa chừng ⇒ yêu cầu nạp KHÔNG được tạo / KHÔNG đổi
 *      trạng thái — trên CẢ HAI dialect. (Lỗi tìm thấy 10/10/2026: trên PostgreSQL `#inTransaction` mở
 *      transaction ở một kết nối nhưng các lệnh lại chạy qua pool ở kết nối khác ⇒ mất nguyên tử.)
 *   3. Tiền vào ví đúng MỘT lần: hai lượt XÁC NHẬN đua nhau ⇒ 1 dòng sổ, run_key `topup:<id>`.
 *   4. Trùng `reference` của cùng người ⇒ `TOPUP_REFERENCE_DUPLICATE` (đường lỗi 23505 của PostgreSQL).
 *   5. MVP-08: tạo listing đua nhau cùng run_key ⇒ 1 bản ghi (ON CONFLICT DO NOTHING); hai lượt claim
 *      đua nhau ⇒ đúng một lượt thắng; JSON tiếng Việt lồng nhau giữ nguyên; vá có điều kiện `fromStatus`.
 *   6. MVP-07: hai lượt claim bài đăng đua nhau ⇒ đúng một lượt thắng.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createStore } from '../src/store/index.js';
import { createBillingService } from '../src/billing/index.js';
import { createTopupService } from '../src/billing/topup.js';
import { hasPg, skipNoPg, pgConfig, sqliteConfig, silent, RUN_TAG, newUserId, newJobId, purgeRunRows } from './pg-helpers.js';

/** Dọn các bảng MVP-06/07/08 của RIÊNG lần chạy này (mọi id đều mang tiền tố RUN_TAG). */
async function purgeNewTables(store) {
  const like = `${RUN_TAG}-%`;
  for (const sql of [
    'DELETE FROM topup_events WHERE request_id IN (SELECT id FROM topup_requests WHERE user_id LIKE ?)',
    'DELETE FROM topup_requests WHERE user_id LIKE ?',
    'DELETE FROM marketplace_events WHERE listing_id IN (SELECT id FROM marketplace_listings WHERE user_id LIKE ?)',
    'DELETE FROM marketplace_listings WHERE user_id LIKE ?',
    'DELETE FROM publish_logs WHERE item_id IN (SELECT id FROM publish_items WHERE user_id LIKE ?)',
    'DELETE FROM publish_items WHERE user_id LIKE ?',
  ]) {
    await store.driver.run(sql, [like]).catch(() => {});
  }
  await purgeRunRows(store);
}

/** Mở hai store — PostgreSQL thật và SQLite in-memory — để so CÙNG kịch bản trên hai dialect. */
async function openBoth() {
  const pg = await createStore(pgConfig(), silent);
  assert.equal(pg.dialect, 'postgres', 'phải thật sự chạy trên PostgreSQL');
  const lite = await createStore(sqliteConfig(), silent);
  return { pg, lite };
}

describe('PostgreSQL — bảng MVP-06/07/08: kiểu cột, index chống trùng', { skip: skipNoPg }, () => {
  let pg;
  before(async () => {
    if (!hasPg) return;
    pg = await createStore(pgConfig(), silent);
  });
  after(async () => {
    if (!pg) return;
    await purgeNewTables(pg);
    await pg.close();
  });

  test('cột credit/tỷ giá của topup_requests là double precision (KHÔNG phải real); topup_events.seq & marketplace_events.seq có mặt', async () => {
    const rows = await pg.driver.all(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name IN ('topup_requests','topup_events','marketplace_events','marketplace_listings','publish_items','publish_logs')`,
    );
    const col = (t, c) => rows.find((r) => r.table_name === t && r.column_name === c)?.data_type ?? null;
    assert.equal(col('topup_requests', 'credits'), 'double precision');
    assert.equal(col('topup_requests', 'rate_vnd_per_credit'), 'double precision');
    assert.equal(col('topup_requests', 'amount_vnd'), 'integer');
    assert.equal(col('topup_events', 'seq'), 'integer');
    assert.equal(col('marketplace_events', 'seq'), 'integer');
    for (const t of ['topup_requests', 'topup_events', 'marketplace_listings', 'marketplace_events', 'publish_items', 'publish_logs']) {
      assert.ok(rows.some((r) => r.table_name === t), `bảng ${t} tồn tại trên PostgreSQL`);
    }
    const real = rows.filter((r) => r.data_type === 'real');
    assert.deepEqual(real, [], `không cột nào của 6 bảng mới là real (float4): ${JSON.stringify(real)}`);
  });

  test('UNIQUE index chống trùng có thật trên PostgreSQL (tạo SAU migration)', async () => {
    const idx = await pg.driver.all(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()`);
    const def = (n) => idx.find((i) => i.indexname === n)?.indexdef || '';
    assert.match(def('uniq_topup_requests_reference'), /UNIQUE/);
    assert.match(def('uniq_wallet_ledger_topup_run'), /UNIQUE/);
    assert.match(def('uniq_marketplace_listings_run'), /UNIQUE.*\(job_id, channel, run_key\)/);
    assert.ok(def('idx_topup_events_request_seq'), 'index (request_id, seq) của topup_events');
  });

  test('init() chạy LẠI lần hai trên DB đã có ⇒ không lỗi, không đổi kiểu cột (idempotent)', async () => {
    const again = await createStore(pgConfig(), silent);
    await again.init?.();
    const t = await again.driver.get(
      `SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'topup_requests' AND column_name = 'credits'`,
    );
    assert.equal(t.data_type, 'double precision');
    await again.close();
  });
});

describe('MVP-06 — NGUYÊN TỬ: vết hỏng giữa chừng thì KHÔNG để lại yêu cầu / trạng thái mồ côi (hai dialect)', { skip: skipNoPg }, () => {
  let pg;
  let lite;
  before(async () => {
    if (!hasPg) return;
    ({ pg, lite } = await openBoth());
  });
  after(async () => {
    if (pg) {
      await purgeNewTables(pg);
      await pg.close();
    }
    await lite?.close();
  });

  for (const dialect of ['sqlite', 'postgres']) {
    test(`${dialect}: appendTopupEvent ném lỗi khi TẠO ⇒ không có dòng topup_requests nào`, async () => {
      const store = dialect === 'postgres' ? pg : lite;
      const uid = newUserId('atom-create');
      const original = store.appendTopupEvent;
      store.appendTopupEvent = async () => { throw new Error('vết hỏng giữa chừng (giả lập)'); };
      try {
        await assert.rejects(store.createTopupRequest({ userId: uid, amountVnd: 100000, reference: `A-${randomUUID()}`, credits: 1, rateVndPerCredit: 100000 }), /vết hỏng/);
      } finally {
        store.appendTopupEvent = original;
      }
      const n = await store.countTopupRequests({ userId: uid });
      assert.equal(n, 0, `${dialect}: yêu cầu KHÔNG được tồn tại khi vết tạo không ghi được (nhận ${n})`);
    });

    test(`${dialect}: appendTopupEvent ném lỗi khi TỪ CHỐI ⇒ trạng thái VẪN pending, vết chỉ có 1 dòng`, async () => {
      const store = dialect === 'postgres' ? pg : lite;
      const uid = newUserId('atom-decide');
      const req = await store.createTopupRequest({ userId: uid, amountVnd: 100000, reference: `D-${randomUUID()}`, credits: 1, rateVndPerCredit: 100000 });
      const original = store.appendTopupEvent;
      store.appendTopupEvent = async () => { throw new Error('vết hỏng giữa chừng (giả lập)'); };
      try {
        await assert.rejects(store.decideTopupRequest(req.id, { toStatus: 'rejected', actorUserId: 'admin', reason: 'x' }), /vết hỏng/);
      } finally {
        store.appendTopupEvent = original;
      }
      assert.equal((await store.getTopupRequest(req.id)).status, 'pending', `${dialect}: không có vết thì KHÔNG được đổi trạng thái`);
      assert.equal((await store.listTopupEvents(req.id)).length, 1);
    });
  }
});

describe('MVP-06 trên PostgreSQL — tiền vào ví đúng MỘT lần, chống khai trùng, thứ tự vết', { skip: skipNoPg }, () => {
  let store;
  let topup;
  before(async () => {
    if (!hasPg) return;
    const config = pgConfig();
    store = await createStore(config, silent);
    const billing = createBillingService(config, { store, logger: silent });
    topup = createTopupService(config, { store, billing, logger: silent });
  });
  after(async () => {
    if (!store) return;
    await purgeNewTables(store);
    await store.close();
  });

  test('hai lượt XÁC NHẬN đua nhau ⇒ một 200 + một TOPUP_ALREADY_DECIDED, ĐÚNG 1 dòng sổ run_key topup:<id>', async () => {
    const uid = newUserId('race');
    const req = await topup.createRequest({ userId: uid, amountVnd: 260000, reference: `R-${randomUUID().slice(0, 8)}` });
    assert.equal((await store.listLedger({ userId: uid, limit: 50 })).length, 0, 'tạo yêu cầu KHÔNG đụng ví');
    const results = await Promise.allSettled([
      topup.confirm({ requestId: req.id, actorId: 'admin-1' }),
      topup.confirm({ requestId: req.id, actorId: 'admin-2' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, `đúng một lượt thắng: ${JSON.stringify(results.map((r) => r.status))}`);
    assert.equal(bad[0].reason.code, 'TOPUP_ALREADY_DECIDED');
    const rows = await store.listLedger({ userId: uid, limit: 50 });
    assert.equal(rows.length, 1, 'ĐÚNG MỘT dòng sổ');
    assert.equal(rows[0].run_key, `topup:${req.id}`);
    assert.equal(await store.ledgerBalance(uid), 10, '260.000 / 26.000 = 10 credit');
    const fresh = await store.getTopupRequest(req.id);
    assert.equal(fresh.status, 'confirmed');
    assert.equal(fresh.rate_vnd_per_credit, 26000, 'tỷ giá ghi lại lúc duyệt');
    assert.equal(fresh.ledger_entry_id, rows[0].id);
    assert.deepEqual((await store.listTopupEvents(req.id)).map((e) => [e.seq, e.to_status]), [[1, 'pending'], [2, 'confirmed']]);
  });

  test('trùng reference của CÙNG người ⇒ TOPUP_REFERENCE_DUPLICATE (đường 23505), người khác cùng mã ⇒ được', async () => {
    const uid = newUserId('dup');
    const ref = `DUP-${randomUUID().slice(0, 8)}`;
    await topup.createRequest({ userId: uid, amountVnd: 100000, reference: ref });
    await assert.rejects(topup.createRequest({ userId: uid, amountVnd: 100000, reference: ref }), (e) => e.code === 'TOPUP_REFERENCE_DUPLICATE');
    assert.equal(await store.countTopupRequests({ userId: uid }), 1, 'không có bản ghi thứ hai');
    const other = await topup.createRequest({ userId: newUserId('dup2'), amountVnd: 100000, reference: ref });
    assert.equal(other.status, 'pending');
  });

  test('trần số dư BILLING_MAX_BALANCE trên PostgreSQL ⇒ AMOUNT_TOO_LARGE, yêu cầu VẪN pending, 0 dòng sổ', async () => {
    const config = pgConfig({ BILLING_MAX_BALANCE: '5' });
    const billing = createBillingService(config, { store, logger: silent });
    const t2 = createTopupService(config, { store, billing, logger: silent });
    const uid = newUserId('cap');
    const req = await t2.createRequest({ userId: uid, amountVnd: 260000, reference: `CAP-${randomUUID().slice(0, 8)}` });
    await assert.rejects(t2.confirm({ requestId: req.id, actorId: 'admin' }), (e) => e.code === 'AMOUNT_TOO_LARGE');
    assert.equal((await store.getTopupRequest(req.id)).status, 'pending');
    assert.equal((await store.listLedger({ userId: uid, limit: 10 })).length, 0);
  });
});

describe('MVP-08 trên PostgreSQL — idempotency + cổng claim + JSON', { skip: skipNoPg }, () => {
  let store;
  before(async () => {
    if (!hasPg) return;
    store = await createStore(pgConfig(), silent);
  });
  after(async () => {
    if (!store) return;
    await purgeNewTables(store);
    await store.close();
  });

  const base = (uid, jid, extra = {}) => ({
    jobId: jid, userId: uid, channel: 'dry-run', status: 'pending_review', runKey: `${jid}#dry-run`,
    input: { title: 'Tai nghe “không dây” — ổn định', nested: { gia: 199000, anh: ['https://a/1.jpg'] } },
    payload: { dry_run: true, previews: { shopee: { item_name: 'Tai nghe' } } },
    issues: [{ field: 'variants', code: 'UNMAPPED', severity: 'warn', message: 'Biến thể chưa ánh xạ' }],
    unmapped: [{ field: 'logistic_info', reason: 'cần đọc từ sàn' }],
    ...extra,
  });

  test('hai lượt tạo đua nhau cùng (job, kênh, run_key) ⇒ ĐÚNG 1 bản ghi, lượt kia nhận bản cũ idempotent', async () => {
    const uid = newUserId('mk');
    const jid = newJobId('mk');
    const [a, b] = await Promise.all([store.createMarketplaceListing(base(uid, jid)), store.createMarketplaceListing(base(uid, jid))]);
    assert.equal(a.id, b.id, 'cùng một listing');
    assert.equal([a.idempotent, b.idempotent].filter(Boolean).length, 1, 'đúng một lượt là idempotent');
    assert.equal(await store.countMarketplaceListings({ jobId: jid }), 1);
  });

  test('JSON tiếng Việt lồng nhau giữ NGUYÊN qua PostgreSQL (payload, input, issues, unmapped)', async () => {
    const uid = newUserId('mkjson');
    const jid = newJobId('mkjson');
    const l = await store.createMarketplaceListing(base(uid, jid));
    const back = await store.getMarketplaceListing(l.id);
    assert.equal(back.input.title, 'Tai nghe “không dây” — ổn định');
    assert.deepEqual(back.input.nested, { gia: 199000, anh: ['https://a/1.jpg'] });
    assert.equal(back.payload.previews.shopee.item_name, 'Tai nghe');
    assert.equal(back.issues[0].message, 'Biến thể chưa ánh xạ');
    assert.equal(back.unmapped[0].field, 'logistic_info');
    assert.equal(back.is_mock, false);
    assert.equal(back.attempts, 0);
  });

  test('cổng claim: chưa duyệt ⇒ null; đã duyệt + hai lượt claim đua nhau ⇒ ĐÚNG một lượt thắng; trần attempts', async () => {
    const uid = newUserId('mkclaim');
    const jid = newJobId('mkclaim');
    const l = await store.createMarketplaceListing(base(uid, jid));
    assert.equal(await store.claimMarketplaceListing(l.id, { maxAttempts: 3 }), null, 'pending_review KHÔNG claim được');
    const ok = await store.updateMarketplaceListing(l.id, { status: 'approved', approved_by: 'admin' }, { fromStatus: 'pending_review' });
    assert.equal(ok.status, 'approved');
    assert.equal(await store.updateMarketplaceListing(l.id, { status: 'rejected' }, { fromStatus: 'pending_review' }), null, 'fromStatus sai ⇒ không vá');
    const [c1, c2] = await Promise.all([store.claimMarketplaceListing(l.id, { maxAttempts: 3 }), store.claimMarketplaceListing(l.id, { maxAttempts: 3 })]);
    assert.equal([c1, c2].filter(Boolean).length, 1, 'đúng một lượt claim thắng');
    const won = c1 || c2;
    assert.equal(won.status, 'publishing');
    assert.equal(won.attempts, 1);
    await store.updateMarketplaceListing(l.id, { status: 'failed', error_code: 'MARKETPLACE_ERROR' }, { fromStatus: 'publishing' });
    assert.ok(await store.claimMarketplaceListing(l.id, { maxAttempts: 2 }), 'failed + dưới trần ⇒ thử lại được');
    await store.updateMarketplaceListing(l.id, { status: 'failed' }, { fromStatus: 'publishing' });
    assert.equal(await store.claimMarketplaceListing(l.id, { maxAttempts: 2 }), null, 'chạm trần attempts ⇒ không claim nữa');
  });

  test('marketplace_events: seq tăng dần, đọc đúng thứ tự', async () => {
    const uid = newUserId('mkev');
    const l = await store.createMarketplaceListing(base(uid, newJobId('mkev')));
    for (const kind of ['created', 'approved', 'publish_started', 'published']) {
      await store.appendMarketplaceEvent({ listingId: l.id, kind, actorUserId: uid, detail: { k: kind } });
    }
    const ev = await store.listMarketplaceEvents(l.id);
    assert.deepEqual(ev.map((e) => [Number(e.seq), e.kind]), [[1, 'created'], [2, 'approved'], [3, 'publish_started'], [4, 'published']]);
    assert.deepEqual(ev[3].detail, { k: 'published' });
  });
});

describe('MVP-07 trên PostgreSQL — cổng claim bài đăng', { skip: skipNoPg }, () => {
  let store;
  before(async () => {
    if (!hasPg) return;
    store = await createStore(pgConfig(), silent);
  });
  after(async () => {
    if (!store) return;
    await purgeNewTables(store);
    await store.close();
  });

  test('bài nháp KHÔNG claim được; bài đã duyệt + hai lượt claim đua nhau ⇒ đúng một lượt thắng', async () => {
    const uid = newUserId('pub');
    const item = await store.createPublishItem({ jobId: newJobId('pub'), userId: uid, text: 'Bài thử “tiếng Việt”', status: 'draft' });
    assert.equal(await store.claimPublishItem(item.id), null, 'draft KHÔNG claim được');
    await store.driver.run("UPDATE publish_items SET status = 'approved' WHERE id = ?", [item.id]);
    const [a, b] = await Promise.all([store.claimPublishItem(item.id), store.claimPublishItem(item.id)]);
    assert.equal([a, b].filter(Boolean).length, 1, 'đúng một lượt thắng');
    assert.equal((a || b).status, 'publishing');
    assert.equal((await store.getPublishItem(item.id)).text, 'Bài thử “tiếng Việt”');
  });
});
