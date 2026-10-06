/**
 * MVP-05 (A2) — chuẩn hoá dòng `wallet_ledger` / `pricing` do store trả về.
 *
 * Hợp đồng §2.1 đặt tên cột theo snake_case (`balance_after`, `job_id`, `unit_price`);
 * store hiện có thói quen hydrate sang snake_case cho `jobs` / `image_assets`
 * (xem `#hydrateJob` trong `src/store/index.js`). Vì A3 có thể trả về nguyên dòng SQL
 * hoặc object đã hydrate (camelCase), lớp này GIỮ NGUYÊN mọi field nhận được và chỉ
 * BỔ SUNG tên chuẩn nếu thiếu. Nhờ vậy:
 *   - tầng route/UI luôn đọc được `row.balance_after`, `row.job_id`, `row.created_at`;
 *   - không field nào của store bị mất hay bị đổi tên (không phá ai).
 */

import { roundMoney, toFiniteNumber } from './money.js';

/**
 * `meta` trong DB là TEXT (JSON) hoặc jsonb. Chấp nhận cả 3 dạng: object sẵn,
 * chuỗi JSON, null/rỗng. Chuỗi không parse được ⇒ trả nguyên chuỗi (giữ dấu vết
 * dữ liệu bẩn thay vì âm thầm nuốt).
 */
export function parseMeta(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Chuẩn hoá MỘT dòng sổ. `null`/rác ⇒ trả nguyên giá trị đầu vào. */
export function normalizeLedgerRow(row) {
  if (!row || typeof row !== 'object') return row ?? null;
  const out = { ...row };
  out.user_id = firstDefined(out.user_id, out.userId);
  out.job_id = firstDefined(out.job_id, out.jobId) ?? null;
  out.operation = firstDefined(out.operation) ?? null;
  // `amount`/`balance_after` được LÀM TRÒN về 6 chữ số ngay tại BIÊN của tầng billing:
  // store (A3) cộng thẳng `balanceBefore + amount` trên REAL nên giá trị lưu trong DB có
  // thể là 1.2000000000000002. Để nguyên thì `balance()` (đã làm tròn) và `balance_after`
  // (chưa làm tròn) sẽ kể hai câu chuyện khác nhau về CÙNG một ví.
  out.balance_after = roundMoney(firstDefined(out.balance_after, out.balanceAfter));
  out.amount = roundMoney(out.amount);
  if (typeof out.currency !== 'string' || !out.currency.trim()) out.currency = 'USD';
  if (out.meta !== undefined) out.meta = parseMeta(out.meta);
  out.created_at = firstDefined(out.created_at, out.createdAt) ?? null;
  return out;
}

/** Chuẩn hoá danh sách dòng sổ; đầu vào không phải mảng ⇒ `[]` (fail-safe cho route). */
export function normalizeLedgerRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => normalizeLedgerRow(row));
}

/** Chuẩn hoá MỘT dòng bảng giá. */
export function normalizePricingRow(row) {
  if (!row || typeof row !== 'object') return null;
  const out = { ...row };
  out.operation = String(firstDefined(out.operation) ?? '').trim();
  out.unit_price = toFiniteNumber(firstDefined(out.unit_price, out.unitPrice));
  if (typeof out.currency !== 'string' || !out.currency.trim()) out.currency = 'USD';
  out.note = firstDefined(out.note) ?? null;
  out.updated_at = firstDefined(out.updated_at, out.updatedAt) ?? null;
  return out;
}
