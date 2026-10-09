/**
 * MIGRATION CỘT TIỀN TRÊN POSTGRESQL — ĐƯỜNG `real` → `double precision` PHẢI CÓ TEST (F2).
 *
 * Vì sao file này tồn tại (đo được ở vòng phản biện PR #28): **tắt hẳn `#widenMoneyColumns()`
 * thì 29/29 test PostgreSQL cũ vẫn xanh** — không test nào khẳng định `data_type` của cột tiền.
 * Đường migration chỉ được chứng minh bằng tay. Hệ quả: một bản vá làm hỏng migration (hoặc
 * migration im lặng bỏ qua schema khác `public`) sẽ đi qua CI mà không ai biết, trong khi trên
 * production tiền tiếp tục là `float4` ⇒ **ví chạy miễn phí** (10.000 trừ 0,0004 ⇒ số dư 10000).
 *
 * Ba ca, đều dựng DB THẬT bằng DDL (không mock):
 *   1. DB dựng bằng **schema CŨ** (4 cột tiền `REAL`) nằm ở schema **KHÔNG phải `public`**
 *      (search_path khác — đúng ca F1) ⇒ `init()` phải nới **cả 4 cột** thành `double precision`,
 *      dữ liệu cũ giữ nguyên, và cột mới THẬT SỰ giữ 6 chữ số thập phân.
 *   2. Còn cột tiền `real` **trong schema app đang dùng** mà `ALTER` thất bại ⇒ `init()` phải
 *      **NÉM `MONEY_COLUMNS_NOT_WIDENED`** (fail-closed, nêu tên cột) — KHÔNG được warn rồi chạy
 *      tiếp. Ca này chặn `ALTER` bằng một cột SINH của PostgreSQL: lỗi THẬT ở tầng DB, không mock
 *      (thay cho ca "app không phải chủ bảng" — cùng hệ quả: `real` không nới được mà app vẫn chạy).
 *   3. Còn cột tiền `real` ở schema **NGOÀI `search_path`** ⇒ app không đọc tới nên vẫn boot,
 *      nhưng `/api/health` phải nói `money_schema_ok: false` + lý do (không im lặng).
 *
 * Tự BỎ QUA khi thiếu `DATABASE_URL` (giống các file `pg-*.test.js` khác). Mỗi ca dùng SCHEMA
 * RIÊNG theo `RUN_TAG` và **XOÁ SẠCH** trong `finally` — DB PostgreSQL là DB dùng chung.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  Store, createDriver, createStore, MONEY_COLUMNS, MONEY_COLUMNS_NOT_WIDENED, SCHEMA_PATH,
} from '../src/store/index.js';
import { PostgresDriver } from '../src/store/postgres-driver.js';
import { createApp } from '../src/app.js';
import { hasPg, skipNoPg, pgConfig, silent, RUN_TAG } from './pg-helpers.js';

const BASE_URL = process.env.DATABASE_URL;

/** Tên schema RIÊNG cho từng ca (chữ thường, không ký tự lạ — định danh SQL hợp lệ). */
const schemaName = (label) => `pgtmoney_${label}_${RUN_TAG.replace(/[^a-z0-9]/gi, '_')}`.toLowerCase();

/** URL trỏ vào một schema: `search_path` đặt ở TẦNG KẾT NỐI (mọi kết nối trong pool đều thấy). */
const urlForSchema = (schema) => {
  const u = new URL(BASE_URL);
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
};

const quoted = (name) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * DDL "DB dựng bởi bản CŨ": `schema.sql` hiện tại nhưng **4 cột TIỀN để `REAL`**.
 *
 * Cố ý KHÔNG chép tay một file schema cũ vào `test/fixtures`: bản chép tay sẽ lệch khỏi
 * `schema.sql` thật mà không ai biết. Ở đây suy ra từ chính `schema.sql` đang chạy, và có
 * chốt chặn: nếu 4 cột KHÔNG thật sự thành `REAL` thì test ĐỎ ngay (không xanh oan).
 */
function oldSchemaSql() {
  let sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  for (const { column } of MONEY_COLUMNS) {
    sql = sql.replace(new RegExp(`(\\b${column}\\s+)DOUBLE PRECISION`, 'gi'), '$1REAL');
  }
  for (const { table, column } of MONEY_COLUMNS) {
    assert.match(
      sql,
      new RegExp(`\\b${column}\\s+REAL\\b`, 'i'),
      `DDL "cũ" phải khai ${table}.${column} là REAL — nếu không, test này không đo được migration`,
    );
  }
  return sql;
}

/* ───────────────────────── hạ tầng schema dùng chung ───────────────────────── */

const openDriver = async (url) => {
  const driver = new PostgresDriver({ url });
  await driver.connect();
  return driver;
};

/** Chạy `fn` với MỘT schema mới (đã có DDL) và DỌN SẠCH dù `fn` ném. */
async function withSchema(label, ddl, fn) {
  const schema = schemaName(label);
  const admin = await openDriver(BASE_URL);
  try {
    await admin.run(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`);
    await admin.run(`CREATE SCHEMA ${quoted(schema)}`);
  } finally {
    await admin.close();
  }
  const inside = await openDriver(urlForSchema(schema));
  try {
    await inside.exec(ddl);
  } finally {
    await inside.close();
  }
  try {
    return await fn(schema);
  } finally {
    await dropSchema(schema);
  }
}

async function dropSchema(schema) {
  const admin = await openDriver(BASE_URL).catch(() => null);
  if (!admin) return;
  try {
    await admin.run(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`);
  } finally {
    await admin.close();
  }
}

/** `data_type` của ĐÚNG 4 cột tiền (đọc thẳng `information_schema` — không tin hàm nội bộ). */
async function moneyDataTypes(driver, schema) {
  const out = {};
  for (const { table, column } of MONEY_COLUMNS) {
    const row = await driver.get(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
      [schema, table, column],
    );
    out[`${table}.${column}`] = row ? String(row.data_type).toLowerCase() : null;
  }
  return out;
}

const ALL_WIDENED = Object.freeze(
  Object.fromEntries(MONEY_COLUMNS.map(({ table, column }) => [`${table}.${column}`, 'double precision'])),
);
const ALL_REAL = Object.freeze(
  Object.fromEntries(MONEY_COLUMNS.map(({ table, column }) => [`${table}.${column}`, 'real'])),
);

/**
 * Chặn `ALTER COLUMN … TYPE` bằng ĐÚNG cơ chế của PostgreSQL: cột được dùng bởi một cột SINH
 * ⇒ `ERROR: cannot alter type of a column used by a generated column`.
 */
const blockWidening = (driver, table, column, probe) => driver.run(
  `ALTER TABLE ${quoted(table)} ADD COLUMN ${quoted(probe)} NUMERIC GENERATED ALWAYS AS (${quoted(column)} * 2) STORED`,
);

/* ─────────────────────────────────── test ─────────────────────────────────── */

describe('Migration cột TIỀN trên PostgreSQL thật (F2)', () => {
  const straySchemas = new Set();

  after(async () => {
    // Lưới an toàn: ca nào chết giữa đường vẫn không để rác lại DB dùng chung.
    if (!hasPg) return;
    for (const schema of straySchemas) await dropSchema(schema).catch(() => {});
  });

  test('DB dựng bằng schema CŨ (4 cột real) ở schema KHÁC `public` ⇒ init() nới CẢ 4 CỘT', { skip: skipNoPg }, async () => {
    await withSchema('old', oldSchemaSql(), async (schema) => {
      // Dòng sổ CŨ ghi bằng `float4` (đúng thứ DB đang chạy có): nạp 10.000 rồi trừ 0,0004.
      const userId = `${RUN_TAG}-money-old`;
      const seed = await openDriver(urlForSchema(schema));
      const stamp = new Date().toISOString();
      const insert = (seq, amount, balanceAfter, reason) => seed.run(
        `INSERT INTO wallet_ledger (id, user_id, seq, amount, reason, balance_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), userId, seq, amount, reason, balanceAfter, stamp],
      );
      try {
        await insert(1, 10000, 10000, 'grant');
        await insert(2, -0.0004, 10000, 'job_hold');
        assert.deepEqual(await moneyDataTypes(seed, schema), ALL_REAL,
          'DB dựng bằng DDL "cũ" phải THẬT SỰ có 4 cột real — nếu không, test này vô nghĩa');
      } finally {
        await seed.close();
      }

      const store = await createStore(pgConfig({ DATABASE_URL: urlForSchema(schema) }), silent);
      try {
        // Đúng schema đang dùng (search_path khác `public` — ca F1 của phản biện).
        const cs = await store.driver.get('SELECT current_schema() AS s');
        assert.equal(cs.s, schema, 'search_path của kết nối phải là schema riêng của test');

        assert.deepEqual(await moneyDataTypes(store.driver, schema), ALL_WIDENED,
          'init() phải nới ĐỦ 4 cột tiền — kể cả khi bảng KHÔNG nằm trong schema `public`');

        const status = store.moneySchemaStatus();
        assert.equal(status.checked, true, 'PostgreSQL: trạng thái phải là ĐÃ KIỂM');
        assert.equal(status.ok, true, `không được còn cột tiền real (nhận: ${JSON.stringify(status.not_widened)})`);

        // Dữ liệu CŨ không bị migration sửa; và cột đã nới THẬT SỰ giữ 6 chữ số thập phân.
        const row = await store.driver.get(
          'SELECT balance_after FROM wallet_ledger WHERE user_id = ? AND seq = ?', [userId, 1],
        );
        assert.equal(Number(row.balance_after), 10000, 'migration chỉ đổi KIỂU CỘT, không được đụng dữ liệu cũ');
        const sum = await store.driver.get('SELECT SUM(amount) AS total FROM wallet_ledger WHERE user_id = ?', [userId]);
        assert.equal(Math.round(Number(sum.total) * 1e6) / 1e6, 9999.9996,
          'trên float4 tổng này là 10000 (khoản thu bị nuốt) — trên double precision phải là 9999.9996');

        // IDEMPOTENT: init() lần hai (store mới) không lỗi và không đổi kiểu lần nữa.
        const second = await createStore(pgConfig({ DATABASE_URL: urlForSchema(schema) }), silent);
        try {
          assert.deepEqual(await moneyDataTypes(second.driver, schema), ALL_WIDENED);
          assert.equal(second.moneySchemaStatus().ok, true);
        } finally {
          await second.close();
        }
      } finally {
        await store.close();
      }
    });
  });

  test('cột TIỀN bị hạ cấp NGƯỢC về real trên DB đã nâng cấp ⇒ init() nới LẠI (không cần dựng lại DB)', { skip: skipNoPg }, async () => {
    await withSchema('revert', fs.readFileSync(SCHEMA_PATH, 'utf8'), async (schema) => {
      // DB "mới" (double precision) → diễn tập/rollback đổi NGƯỢC đúng MỘT cột về `real`.
      const raw = await openDriver(urlForSchema(schema));
      try {
        await raw.run('ALTER TABLE pricing ALTER COLUMN unit_price TYPE REAL');
        const before = await moneyDataTypes(raw, schema);
        assert.equal(before['pricing.unit_price'], 'real', 'ca này chỉ có nghĩa khi cột THẬT SỰ đang là real');
        assert.equal(before['wallet_ledger.amount'], 'double precision', 'các cột khác vẫn phải là double precision');
      } finally {
        await raw.close();
      }

      const store = await createStore(pgConfig({ DATABASE_URL: urlForSchema(schema) }), silent);
      try {
        assert.deepEqual(await moneyDataTypes(store.driver, schema), ALL_WIDENED,
          'init() phải nới LẠI cột bị hạ cấp — không được coi "DB đã nâng cấp rồi" là xong');
        assert.equal(store.moneySchemaStatus().ok, true);
      } finally {
        await store.close();
      }
    });
  });

  test('còn cột TIỀN real trong schema ĐANG DÙNG ⇒ init() NÉM MONEY_COLUMNS_NOT_WIDENED', { skip: skipNoPg }, async () => {
    await withSchema('fail', oldSchemaSql(), async (schema) => {
      const blocker = await openDriver(urlForSchema(schema));
      try {
        await blockWidening(blocker, 'wallet_ledger', 'amount', 'probe_amount');
      } finally {
        await blocker.close();
      }

      const config = pgConfig({ DATABASE_URL: urlForSchema(schema) });
      // Dựng Store TRỰC TIẾP (không `createStore`) để còn `close()` được pool sau khi `init()` ném.
      const store = new Store({ driver: createDriver(config, silent), logger: silent, config });
      let caught = null;
      try {
        await store.init();
      } catch (err) {
        caught = err;
      } finally {
        await store.close();
      }

      assert.ok(caught, 'init() PHẢI ném — warn rồi chạy tiếp với float4 chính là lỗi F1');
      assert.equal(caught.code, MONEY_COLUMNS_NOT_WIDENED, `mã lỗi phải là ${MONEY_COLUMNS_NOT_WIDENED}, nhận ${caught.code}`);
      assert.match(caught.message, /wallet_ledger\.amount/, 'thông điệp phải NÊU TÊN cột tiền chưa nới được');
      assert.equal(caught.details?.columns?.[0]?.visible, true, 'cột nằm trong search_path ⇒ phải bị coi là CHẶN BOOT');
      assert.equal(store.moneySchemaStatus().ok, false, 'trạng thái sau lỗi phải là CHƯA ĐẠT');

      // Ba cột còn lại VẪN được nới — chặn ở cột nào thì nói đúng cột đó, không bỏ cuộc cả loạt.
      const driver = await openDriver(urlForSchema(schema));
      try {
        const types = await moneyDataTypes(driver, schema);
        assert.equal(types['wallet_ledger.amount'], 'real', 'cột bị chặn phải vẫn là real (ALTER đã thất bại thật)');
        for (const key of Object.keys(ALL_WIDENED)) {
          if (key === 'wallet_ledger.amount') continue;
          assert.equal(types[key], 'double precision', `${key} phải được nới dù cột khác thất bại`);
        }
      } finally {
        await driver.close();
      }
    });
  });

  test('cột TIỀN real NGOÀI search_path ⇒ app vẫn boot nhưng /api/health nói money_schema_ok:false', { skip: skipNoPg }, async () => {
    const stray = schemaName('stray');
    straySchemas.add(stray);
    try {
      await withSchema('act', fs.readFileSync(SCHEMA_PATH, 'utf8'), async (active) => {
        // Schema "mồ côi": bảng tiền kiểu CŨ và KHÔNG nới được (cột sinh) — ngoài search_path.
        await withSchema('stray', oldSchemaSql(), async (created) => {
          assert.equal(created, stray);
          const blocker = await openDriver(urlForSchema(stray));
          try {
            await blockWidening(blocker, 'wallet_ledger', 'amount', 'probe_amount');
          } finally {
            await blocker.close();
          }

          const config = pgConfig({ DATABASE_URL: urlForSchema(active) });
          const store = await createStore(config, silent);
          let app = null;
          try {
            const status = store.moneySchemaStatus();
            assert.equal(status.checked, true);
            assert.equal(status.ok, false, 'còn cột tiền real ở schema khác ⇒ KHÔNG được báo là đạt');
            assert.match(String(status.reason), new RegExp(`${stray}\\.wallet_ledger\\.amount`),
              'lý do phải nêu tên cột + schema còn real');

            app = await createApp({ config, logger: silent, store, connectors: [] });
            await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
            const base = `http://127.0.0.1:${app.server.address().port}`;
            const res = await fetch(`${base}/api/health`);
            assert.equal(res.status, 200, 'app vẫn phục vụ (cột ngoài search_path không chặn boot)');
            const body = await res.json();
            assert.equal(body.money_schema_ok, false, '/api/health phải nói money_schema_ok:false');
            assert.match(String(body.money_schema_reason), /wallet_ledger\.amount/, 'health phải kèm lý do nêu tên cột');
            assert.equal(body.money_schema.checked, true);
            // DB dùng chung: có thể còn schema "mồ côi" của lần chạy khác ⇒ khẳng định THEO TÊN,
            // KHÔNG khẳng định vị trí 0.
            assert.ok(
              body.money_schema.not_widened.some((c) => c.schema === stray && c.table === 'wallet_ledger' && c.column === 'amount'),
              `not_widened phải chứa ${stray}.wallet_ledger.amount — nhận ${JSON.stringify(body.money_schema.not_widened)}`,
            );
          } finally {
            if (app) await app.close();
            await store.close();
          }
        });

        // Đối chứng: DỌN schema mồ côi rồi `init()` lại ⇒ không còn cột tiền `real` nào thì trạng
        // thái phải ĐẠT. Đây cũng là bằng chứng "quét MỌI schema" đúng: chính schema NGOÀI
        // `search_path` làm cờ chuyển từ false sang true.
        const cleanStore = await createStore(pgConfig({ DATABASE_URL: urlForSchema(active) }), silent);
        try {
          assert.equal(cleanStore.moneySchemaStatus().ok, true,
            `dọn hết cột real ⇒ phải ĐẠT (nhận: ${JSON.stringify(cleanStore.moneySchemaStatus().not_widened)})`);
          assert.equal(cleanStore.moneySchemaStatus().reason, null);
        } finally {
          await cleanStore.close();
        }
      });
    } finally {
      straySchemas.delete(stray);
      await dropSchema(stray).catch(() => {});
    }
  });
});
