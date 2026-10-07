/**
 * DANH MỤC ĐÓNG BĂNG của MVP-04 phần offline (V1).
 *
 * Ba preset và ba danh mục dưới đây là **hợp đồng 2.1** — KHÔNG được đổi số (kích thước,
 * fps, trần giây) vì V2 (mã hoá GIF), V4 (API) và V5 (UI) đều đọc thẳng từ đây.
 *
 * File thuần: không I/O, không mạng, không đọc file.
 */

/**
 * Preset khung hình video. `synthetic: false` = dựng từ ẢNH NGƯỜI DÙNG TẢI LÊN,
 * không phải nền mô phỏng (khác `synthetic: true` của MVP-03).
 */
export const VIDEO_PRESETS = Object.freeze([
  Object.freeze({ id: 'doc-9x16', label: 'Dọc 9:16 (TikTok/Reels)', width: 720, height: 1280, fps: 12, max_seconds: 30, synthetic: false }),
  Object.freeze({ id: 'vuong-1x1', label: 'Vuông 1:1 (Feed)', width: 900, height: 900, fps: 12, max_seconds: 30, synthetic: false }),
  Object.freeze({ id: 'ngang-16x9', label: 'Ngang 16:9 (YouTube)', width: 1280, height: 720, fps: 12, max_seconds: 30, synthetic: false }),
]);

/** Chuyển cảnh hợp lệ (`cut` = cắt thẳng, `fade` = mờ dần). */
export const TRANSITIONS = Object.freeze(['cut', 'fade']);

/** Hiệu ứng chuyển động chậm trong một cảnh (V2 nội suy theo khung). */
export const MOTIONS = Object.freeze(['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right']);

/** Cách đưa ảnh vào khung — `pad` (thêm viền) hoặc `crop` (cắt bớt). KHÔNG có chế độ kéo giãn. */
export const FIT_MODES = Object.freeze(['pad', 'crop']);

/** Thời lượng mặc định của một cảnh khi người gọi không nói gì (3 giây). */
export const DEFAULT_SCENE_MS = 3000;

/**
 * SÀN thời lượng mỗi cảnh (0,25 giây = 3 khung ở 12 fps).
 * Vì sao có sàn: cảnh ngắn hơn một khung sẽ **không hiện** khung nào; sàn 250 ms còn giữ được
 * tính chất "thời lượng là bội của 250 ms ⇒ số khung làm tròn theo từng cảnh trùng với làm tròn
 * theo mốc tích luỹ" (xem `index.js`), nên kịch bản vừa khớp tổng vừa khớp từng cảnh.
 */
export const DEFAULT_MIN_MS = 250;

/** Thời gian mờ dần mặc định cho chuyển cảnh `fade` (300 ms). */
export const DEFAULT_FADE_MS = 300;

/** Màu viền mặc định khi `fit = 'pad'` (đen — giữ nguyên cảm giác khung hình). */
export const DEFAULT_PAD_COLOR = '#000000';

/** Cỡ chữ mặc định (hệ số phóng của font bitmap MVP-02) khi người gọi không nêu. */
export const DEFAULT_TEXT_SIZE = 24;

/** Trần cỡ chữ — trùng trần `MAX_FONT_SIZE` của `layoutText` (MVP-02). */
export const MAX_TEXT_SIZE = 64;

/**
 * Tìm preset theo id (chuỗi) hoặc theo đối tượng có `id`.
 *
 * Nhận đối tượng `{ id }` cũng CHỈ tra theo id rồi trả về preset CHUẨN của hợp đồng — KHÔNG bao
 * giờ tin kích thước/fps do người gọi tự khai (đổi số là phá hợp đồng với V2/V4/V5).
 *
 * @returns {Readonly<object>|null}
 */
export function findPreset(value) {
  if (value && typeof value === 'object') {
    const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : null;
    return id ? VIDEO_PRESETS.find((preset) => preset.id === id) ?? null : null;
  }
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  if (!id) return null;
  return VIDEO_PRESETS.find((preset) => preset.id === id) ?? null;
}

export default VIDEO_PRESETS;
