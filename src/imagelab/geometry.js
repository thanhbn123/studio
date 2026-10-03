/**
 * HÌNH HỌC HỘP PIXEL — MỘT chỗ duy nhất (bổ sung vòng 3 sau lỗ hổng H-1).
 *
 * Vì sao có file này: trước đây repo có BA bản kẹp hộp khác nhau —
 * `src/imagelab/ocr/normalize.js`, `src/imagelab/pipeline.js#clampBox` và
 * `src/imagelab/render/image.js#clampBox`. Hai bản đầu **dời gốc nhưng giữ nguyên w/h**
 * nên hộp bị NỚI RỘNG khi toạ độ âm:
 *
 *   hộp thật { x: -30, w: 240 } trên ảnh rộng 320  →  phần thật sự nằm trong ảnh là
 *   x ∈ [0, 210)  ⇒  kẹp ĐÚNG phải là { x: 0, w: 210 }, KHÔNG phải { x: 0, w: 240 }.
 *
 * Hệ quả của bản sai: vùng mô tả HỢP LỆ bị `BOX_OVERLAPS_PROTECTED` chặn oan (chữ Trung
 * không được dịch dù đáng được dịch) và `box_normalized` lưu DB cũng sai.
 *
 * Luật của file: kẹp hộp = **GIAO** của hộp với khung ảnh `[0,width) × [0,height)`,
 * cắt bớt `w`/`h` tương ứng; giao rỗng ⇒ trả `null`. Hàm thuần, không đọc file/mạng.
 */

/**
 * Đọc một TOẠ ĐỘ pixel một cách NGHIÊM NGẶT (N-1, vòng 4).
 *
 * Vì sao không dùng `Number(v)`: `Number(null) === 0`, `Number('') === 0`, `Number([]) === 0`,
 * `Number(false) === 0` — nên toạ độ NULL/rác bị **âm thầm** biến thành 0 (fail-OPEN), hộp
 * bảo vệ "ảo" xuất hiện ở gốc toạ độ và luật #3 bị vi phạm trở lại.
 *
 * Luật: chỉ nhận số hữu hạn thật, hoặc CHUỖI có nội dung số. Mọi thứ khác (null, undefined,
 * '', khoảng trắng, boolean, mảng, object, NaN, ±Infinity) ⇒ `null` = "không có toạ độ".
 *
 * @returns {number|null}
 */
export function strictCoordinate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Giao của một hộp với khung ảnh.
 *
 * @param {{x:number,y:number,w:number,h:number}} box hộp đã làm tròn về số nguyên
 * @param {number} width  chiều rộng ảnh (không hợp lệ ⇒ KHÔNG kẹp theo trục đó)
 * @param {number} height chiều cao ảnh (không hợp lệ ⇒ KHÔNG kẹp theo trục đó)
 * @returns {{x:number,y:number,w:number,h:number}|null} `null` nếu hộp không hợp lệ hoặc giao rỗng
 */
export function intersectBoxWithImage(box, width, height) {
  if (!box || typeof box !== 'object') return null;
  const x = strictCoordinate(box.x);
  const y = strictCoordinate(box.y);
  const w = strictCoordinate(box.w ?? box.width);
  const h = strictCoordinate(box.h ?? box.height);
  if (x === null || y === null || w === null || h === null) return null;
  if (!(w > 0) || !(h > 0)) return null;

  const wNum = strictCoordinate(width);
  const hNum = strictCoordinate(height);
  const clampX = wNum !== null && wNum > 0;
  const clampY = hNum !== null && hNum > 0;

  const x0 = clampX ? Math.max(0, Math.min(x, wNum)) : x;
  const x1 = clampX ? Math.max(0, Math.min(x + w, wNum)) : x + w;
  const y0 = clampY ? Math.max(0, Math.min(y, hNum)) : y;
  const y1 = clampY ? Math.max(0, Math.min(y + h, hNum)) : y + h;

  if (!(x1 > x0) || !(y1 > y0)) return null; // giao rỗng ⇒ không còn diện tích
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Hai hộp pixel có GIAO nhau (diện tích chung > 0) hay không.
 * Chạm cạnh KHÔNG tính là giao — hai vùng chữ xếp sát nhau vẫn được vẽ bình thường.
 */
export function boxesIntersect(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export default intersectBoxWithImage;
