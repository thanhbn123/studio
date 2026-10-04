/**
 * NGƯỠNG RETOUCH + hàm kẹp tham số (hợp đồng §3.4, E1).
 *
 * `RETOUCH_LIMITS` là hợp đồng ĐÓNG BĂNG: mỗi tham số là BIÊN ĐỘ tối đa, giá trị hiệu lực
 * nằm trong `[-limit, +limit]`. Vượt ngưỡng ⇒ **KẸP** lại và ghi tên vào `clamped[]`
 * (KHÔNG từ chối âm thầm, KHÔNG bỏ qua). Giá trị không phải số hữu hạn, hoặc tên tham số
 * không nhận ra ⇒ vào `rejected[]` và coi như không truyền.
 *
 * E3 có `clampRetouchParams` riêng trong `pipeline.js` theo hợp đồng §3.3; hàm ở đây là
 * BẢN DÙNG CHUNG cùng ngữ nghĩa để hai nơi không lệch nhau (E3 có thể import lại).
 */

/** Ngưỡng kẹp ĐÓNG BĂNG (hợp đồng §3.4). */
export const RETOUCH_LIMITS = Object.freeze({
  brightness: 0.25,
  contrast: 0.25,
  saturation: 0.30,
  sharpen: 0.5,
});

/** Tên 4 tham số hợp lệ, theo thứ tự báo cáo (đóng băng). */
export const RETOUCH_PARAM_NAMES = Object.freeze(['brightness', 'contrast', 'saturation', 'sharpen']);

/** Tham số hiệu lực khi không truyền gì (0 = không đổi). */
export function zeroRetouchParams() {
  return { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 };
}

/** Chuẩn hoá bảng ngưỡng: chỉ nhận số hữu hạn > 0, thiếu/sai ⇒ lấy `RETOUCH_LIMITS`. */
function normalizeLimits(limits) {
  const src = limits && typeof limits === 'object' ? limits : {};
  const out = {};
  for (const name of RETOUCH_PARAM_NAMES) {
    const n = Number(src[name]);
    out[name] = Number.isFinite(n) && n > 0 ? n : RETOUCH_LIMITS[name];
  }
  return out;
}

/**
 * Kẹp tham số retouch vào ngưỡng.
 *
 * @param {object} params `{ brightness?, contrast?, saturation?, sharpen? }` (số thực, dương = tăng)
 * @param {object} [limits] bảng ngưỡng (mặc định `RETOUCH_LIMITS`)
 * @returns {{params:{brightness:number,contrast:number,saturation:number,sharpen:number},
 *            clamped:string[], rejected:string[]}}
 */
export function clampRetouchParams(params, limits = RETOUCH_LIMITS) {
  const bounds = normalizeLimits(limits);
  const raw = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const effective = zeroRetouchParams();
  const clamped = [];
  const rejected = [];

  // (1) Bốn tham số hợp lệ, theo thứ tự đóng băng ⇒ kết quả cũ hữu định (deterministic).
  for (const name of RETOUCH_PARAM_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(raw, name)) continue;
    const value = raw[name];
    if (value === undefined) continue; // không truyền ⇒ bỏ qua, KHÔNG coi là rác
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // Không phải số hữu hạn (chuỗi/boolean/null/NaN/±Infinity/object) ⇒ coi như không truyền.
      rejected.push(name);
      continue;
    }
    const limit = bounds[name];
    if (value > limit) {
      effective[name] = limit;
      clamped.push(name);
    } else if (value < -limit) {
      effective[name] = -limit;
      clamped.push(name);
    } else {
      effective[name] = value === 0 ? 0 : value; // -0 ⇒ 0
    }
  }

  // (2) Tham số LẠ (không nhận ra) cũng phải lộ ra, không được im lặng bỏ qua.
  for (const key of Object.keys(raw)) {
    if (RETOUCH_PARAM_NAMES.includes(key)) continue;
    if (raw[key] === undefined) continue;
    rejected.push(key);
  }

  return { params: effective, clamped, rejected };
}

export default RETOUCH_LIMITS;
