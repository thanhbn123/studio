/**
 * MVP-05 (A2) — tiện ích TIỀN TỆ cho ví credit.
 *
 * Vì sao cần lớp này: credit là số thực (`REAL`) nên `0.1 + 0.2 !== 0.3`. Nếu ghi
 * thẳng số float vào `wallet_ledger.balance_after` thì chỉ sau vài chục dòng sổ,
 * "số dư = tổng sổ" sẽ lệch nhau ở chữ số thứ 16 và không còn đối soát được nữa
 * (luật #2 của hợp đồng MVP-05). Vì vậy MỌI con số đi vào sổ đều được làm tròn về
 * `MONEY_DECIMALS` chữ số thập phân TRƯỚC khi ghi, và `balance_after` luôn được tính
 * từ số dư đọc trong sổ + khoản chênh đã làm tròn.
 *
 * 6 chữ số thập phân là quá đủ: đơn giá nhỏ nhất của MVP-01/02/03 là 0.0004
 * (`config.cost.OCR_DETECT`) — vẫn còn 2 chữ số dự phòng phía sau.
 */

/** Số chữ số thập phân của credit (1 credit = 1 đơn vị `config.billing.currency`). */
export const MONEY_DECIMALS = 6;

const SCALE = 10 ** MONEY_DECIMALS;

/** Sai số cho phép khi so sánh tiền: nhỏ hơn 1 đơn vị nhỏ nhất (1e-6). */
export const MONEY_EPSILON = 1 / SCALE;

/**
 * Chuỗi số THẬP PHÂN hợp lệ — cùng luật với `toNum` của `src/store/index.js`:
 * KHÔNG nhận `''`, `'  '`, `'0x10'`, `'1e'`, `'12abc'`.
 */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Đọc một giá trị tiền từ DB/JSON một cách NGHIÊM NGẶT; trả `null` nếu là rác.
 *
 * Không dùng `Number(value)` trực tiếp: `Number('  ') === 0`, `Number([]) === 0`,
 * `Number(null) === 0` — rác sẽ bị biến thành "0 credit", tức là MIỄN PHÍ. Với ví
 * credit, đoán sai theo hướng đó là mất tiền thật.
 */
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !DECIMAL_RE.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Làm tròn về `MONEY_DECIMALS` chữ số thập phân (half away from zero).
 * Giá trị không hữu hạn ⇒ 0 (mọi lời gọi đều phải kiểm tra hợp lệ TRƯỚC khi tới đây).
 */
export function roundMoney(value) {
  const n = toFiniteNumber(value);
  if (n === null) return 0;
  const scaled = n * SCALE;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  const out = rounded / SCALE;
  return Object.is(out, -0) ? 0 : out; // chuẩn hoá -0 → 0 để JSON/hiển thị không lạ
}

/**
 * PB-06 (vòng 2) — TRẦN credit cho MỘT thao tác cấp/điều chỉnh.
 *
 * `grant(1e308)` trước đây: `roundMoney(1e308)` ⇒ `Infinity` ⇒ tầng store đọc bằng
 * `toNum` (chỉ nhận số hữu hạn) ⇒ ghi dòng `amount = 0` mà API vẫn trả 201 ⇒ sổ có một
 * dòng "đã nạp 0 credit" trong khi admin tin là đã nạp. Trần này chặn cả tràn số lẫn
 * giá trị vô lý; giá trị hiệu lực lấy từ `config.billing.maxAmount`.
 */
export const DEFAULT_MAX_AMOUNT = 1e9;

/**
 * Chuẩn hoá một khoản tiền ĐỂ GHI SỔ — nghiêm ngặt, KHÔNG bao giờ trả `Infinity`/`NaN`.
 *
 * @param {unknown} value
 * @param {{max?: number, allowZero?: boolean}} [options]
 * @returns {{ok: true, value: number} | {ok: false, code: string, reason: string, amount: unknown}}
 */
export function normalizeAmount(value, { max = DEFAULT_MAX_AMOUNT, allowZero = false } = {}) {
  const raw = toFiniteNumber(value);
  if (raw === null) {
    return { ok: false, code: 'INVALID_AMOUNT', reason: 'không phải số hữu hạn', amount: value ?? null };
  }
  const rounded = roundMoney(raw);
  if (!Number.isFinite(rounded)) {
    return { ok: false, code: 'INVALID_AMOUNT', reason: 'tràn số khi làm tròn', amount: raw };
  }
  const cap = toFiniteNumber(max);
  if (cap !== null && Math.abs(rounded) > cap) {
    return { ok: false, code: 'AMOUNT_TOO_LARGE', reason: `vượt trần ${cap}`, amount: raw, max: cap };
  }
  if (!allowZero && rounded === 0) {
    return { ok: false, code: 'INVALID_AMOUNT', reason: 'số tiền bằng 0', amount: raw };
  }
  return { ok: true, value: rounded };
}

/** Cộng nhiều khoản tiền rồi mới làm tròn (tránh sai số tích luỹ khi cộng dồn). */
export function sumMoney(values) {
  let total = 0;
  for (const value of values ?? []) {
    const n = toFiniteNumber(value);
    if (n !== null) total += n;
  }
  return roundMoney(total);
}
