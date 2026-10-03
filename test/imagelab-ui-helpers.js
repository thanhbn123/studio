/**
 * Tiện ích cho test tầng UI (public/app.js) — KHÔNG mở trình duyệt.
 *
 * Cách làm: trích ĐÚNG hàm `renderIlWarnings` từ `public/app.js` rồi biên dịch nó
 * trong Node với ba phụ thuộc `esc`, `IL_SKIP_REASON`, `IL_KIND_LABEL`. Nhờ vậy test
 * chạy trên mã UI THẬT (không phải bản chép lại), mà không cần DOM.
 *
 * File này không có hậu tố `.test.js` nên `node --test test/*.test.js` không chạy nó.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './imagelab-helpers.js';

/** Escape tối thiểu giống `esc()` của UI (đủ để assert nội dung, không cần đúng byte). */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Biên dịch hàm thật `renderIlWarnings(data)` từ public/app.js.
 * Ném lỗi rõ ràng nếu không trích được — im lặng bỏ qua là kiểu thất bại bị cấm.
 */
export function loadRenderIlWarnings() {
  const file = path.join(ROOT, 'public', 'app.js');
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('function renderIlWarnings(');
  if (start < 0) throw new Error('public/app.js: không tìm thấy hàm renderIlWarnings — UI đã đổi cấu trúc?');
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error('public/app.js: không xác định được điểm kết thúc renderIlWarnings.');
  const body = src.slice(start, end + 3);
  const fn = new Function('esc', 'IL_SKIP_REASON', 'IL_KIND_LABEL', `${body}\nreturn renderIlWarnings;`)(esc, {}, {});
  if (typeof fn !== 'function') throw new Error('public/app.js: renderIlWarnings không biên dịch được.');
  const smoke = fn({});
  if (typeof smoke !== 'string') throw new Error('public/app.js: renderIlWarnings không trả về chuỗi HTML.');
  return fn;
}

export { esc };
