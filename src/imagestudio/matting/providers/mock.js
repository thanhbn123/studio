/**
 * Provider `mock` — KHÔNG tách nền thật (hợp đồng §3.1, E1).
 *
 * Vì sao vẫn có: cho phép E3/E5 chạy hết luồng pipeline MVP-03 mà không cần
 * thuật toán thật. Nhưng nó PHẢI tự khai `is_mock = true`, trả mask GIẢ CỐ ĐỊNH,
 * và nói thẳng trong `warnings` rằng ảnh ra chỉ là BẢN SAO ảnh vào (không có pixel
 * nền nào bị tách) — luật "không bịa".
 *
 * Vẫn giữ luật PNG: nền trong suốt chỉ có nghĩa với PNG nên đầu vào khác PNG bị
 * từ chối `UNSUPPORTED_IMAGE` (giống `purejs`), không trả bừa một ảnh JPEG.
 */

import { Buffer } from 'node:buffer';
import { MattingProvider } from '../provider.js';
import { MattingError, MATTING_CODES } from '../errors.js';
import { MATTING_STATUS } from '../result.js';
import { clampBox, detectImageMime, probeImage } from '../../../imagelab/render/image.js';
import { sha256 } from '../../../imagelab/render/png.js';

/** Mask GIẢ CỐ ĐỊNH của provider mock (không đo từ ảnh nào). */
export const MOCK_MASK = Object.freeze({
  coverage: 0.5,
  background_ratio: 0.5,
  uniformity: 1,
  seed_colors: 1,
});

export class MockMattingProvider extends MattingProvider {
  constructor({ model = 'mock/khong-tach-that', limits, logger } = {}) {
    super({ name: 'mock', model, isMock: true, configured: true, limits, logger });
  }

  async removeBackgroundImpl({ image }) {
    const buffer = image.buffer;
    const mime = detectImageMime(buffer) ?? image.mime ?? null;
    if (mime !== 'image/png') {
      throw new MattingError(
        MATTING_CODES.UNSUPPORTED_IMAGE,
        `Provider "mock" chỉ nhận PNG (nhận ${mime ?? 'không rõ định dạng'}) vì nền trong suốt cần kênh alpha.`,
        { mime },
      );
    }
    const copy = Buffer.from(buffer); // BẢN SAO y nguyên — mock không sửa pixel nào
    const info = probeImage(copy) ?? await this.probe({ buffer: copy });
    const dims = { width: info?.width ?? null, height: info?.height ?? null };
    return {
      status: MATTING_STATUS.OK,
      output: {
        buffer: copy,
        mime: 'image/png',
        width: dims.width,
        height: dims.height,
        sha256: sha256(copy),
      },
      mask: { ...MOCK_MASK },
      kept_bbox: clampBox({ x: 0, y: 0, w: dims.width ?? 0, h: dims.height ?? 0 }, dims),
      warnings: [
        'Provider mock: KHÔNG tách nền thật — ảnh ra là BẢN SAO y nguyên ảnh vào (alpha không đổi).',
        `Provider mock: mask là số GIẢ CỐ ĐỊNH (nền ${MOCK_MASK.background_ratio * 100}%), không đo từ ảnh nào.`,
        'Provider mock: kept_bbox là toàn khung ảnh vì không có vùng nào thật sự bị tách.',
      ],
    };
  }
}

export default MockMattingProvider;
