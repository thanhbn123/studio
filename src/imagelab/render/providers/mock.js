/**
 * Provider `mock` — KHÔNG đổi pixel (hợp đồng 4.3).
 *
 * Vì sao vẫn hữu ích: cho phép chạy hết pipeline MVP-02 (OCR → dịch → duyệt → render)
 * mà không cần provider ảnh thật. Nhưng nó PHẢI tự khai `is_mock = true` và phải nói rõ
 * rằng `applied` chỉ là "ghi nhận op", không chứng minh đã vẽ — luật 1: không bịa.
 */

import { Buffer } from 'node:buffer';
import { RenderProvider, RENDER_STATUS } from '../provider.js';
import { RenderError, RENDER_CODES } from '../errors.js';
import { detectImageMime, probeImage } from '../image.js';
import { sha256 } from '../png.js';

export class MockRenderProvider extends RenderProvider {
  constructor({ model = 'mock', limits, logger } = {}) {
    super({ name: 'mock', model, isMock: true, configured: true, limits, logger });
  }

  async renderImpl({ image, ops, opsSkipped }) {
    if (!image.buffer || image.buffer.length === 0) {
      throw new RenderError(RENDER_CODES.BAD_INPUT, 'Thiếu dữ liệu ảnh để render (provider mock).');
    }
    const copy = Buffer.from(image.buffer); // bản sao y nguyên — không sửa pixel nào
    const info = probeImage(copy);
    const mime = info?.mime ?? detectImageMime(copy) ?? image.mime ?? 'application/octet-stream';
    const applied = ops.map((op) => ({
      region_id: op.region_id,
      action: op.action,
      box: op.box,
      ...(op.text ? { text: op.text } : {}),
    }));
    return {
      status: opsSkipped.length > 0 ? RENDER_STATUS.PARTIAL : RENDER_STATUS.OK,
      output: {
        buffer: copy,
        mime,
        width: info?.width ?? null,
        height: info?.height ?? null,
        sha256: sha256(copy),
      },
      applied,
      skipped: [],
      unsupported_glyphs: [],
      warnings: [
        'Provider mock: pixel KHÔNG đổi — output là bản sao y nguyên ảnh gốc; `applied` chỉ ghi nhận op.',
        'Provider mock: không phân tích glyph nên `unsupported_glyphs` luôn rỗng.',
      ],
    };
  }
}

export default MockRenderProvider;
