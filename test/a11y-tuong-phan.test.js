/**
 * TEST — tương phản WCAG AA của NÚT CHÍNH (V-13660), đọc thẳng `public/styles.css`.
 *
 * Vì sao có file này ngoài e2e f13: e2e chỉ chạy khi có Chrome; bộ này chạy trong `npm test` (mọi CI), nên ai đổi
 * màu nút chính xuống dưới ngưỡng thì đỏ ngay. Lỗi gốc (đo e2e f13, 10/10/2026): gradient cũ `#4f8cff → #3b6fe0`
 * cho chữ trắng chỉ 3.22:1 ở điểm sáng.
 *
 * Kiểm: MỌI điểm màu của gradient `.btn.primary` với chữ `#fff` đạt ≥ 4.5:1 (chữ nút 14–15px không phải "chữ lớn"),
 * và vẫn ≥ 4.5:1 khi hover làm sáng 7% (`filter: brightness(1.07)`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './imagelab-helpers.js';

const lin = (v) => {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const bright = (rgb, f) => rgb.map((v) => Math.min(255, Math.round(v * f)));

test('nút chính: chữ trắng ≥ 4.5:1 ở MỌI điểm màu gradient, kể cả khi hover sáng 7%', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const rule = css.match(/^\.btn\.primary \{([^}]*)\}/m);
  assert.ok(rule, 'tìm thấy luật .btn.primary');
  const stops = rule[1].match(/#[0-9a-f]{6}\b/gi) || [];
  assert.ok(stops.length >= 2, `gradient có ≥ 2 điểm màu dạng #rrggbb (nhận ${stops.join(', ')}) — đừng dùng var() ở đây để test đo được`);
  assert.match(rule[1], /color:\s*#fff\b/, 'chữ nút chính là #fff');
  const hover = css.match(/^\.btn\.primary:hover \{[^}]*brightness\(([\d.]+)\)/m);
  const f = hover ? Number(hover[1]) : 1;
  for (const s of stops) {
    const r = ratio([255, 255, 255], hex(s));
    const rh = ratio([255, 255, 255], bright(hex(s), f));
    assert.ok(r >= 4.5, `${s}: ${r.toFixed(2)}:1 < 4.5:1`);
    assert.ok(rh >= 4.5, `${s} khi hover x${f}: ${rh.toFixed(2)}:1 < 4.5:1`);
  }
});

test('công thức tương phản đúng với giá trị chuẩn (trắng/đen = 21:1; #4f8cff = 3.22:1 — màu cũ bị loại)', () => {
  assert.equal(ratio([255, 255, 255], [0, 0, 0]).toFixed(1), '21.0');
  assert.equal(ratio([255, 255, 255], hex('#4f8cff')).toFixed(2), '3.22');
});
