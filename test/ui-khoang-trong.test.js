/**
 * TEST — các khoảng trống UI của `docs/UI-HANDOVER.md` §5 (mục 4, 5, 6) ở MỨC HÀM, trên mã THẬT của
 * `public/app.js` (trích bằng `loadUiFunction`, như mọi `test/*-ui.test.js`). Phần đo trên trình duyệt
 * thật nằm ở `tools/e2e/run.mjs` luồng f9–f11.
 *
 *   mục 5 — "Xem bản kê khai" không bị đóng khi vòng poll vẽ lại màn job: `exportPanelHtml` vẽ lại
 *           bản kê khai đã mở từ `state.exportManifest` (CHỈ cho đúng job đó).
 *   mục 6 — lọc Lịch sử: `historyFilterItems` (thuần) — không phân biệt hoa thường, bỏ dấu tiếng Việt,
 *           lọc theo trạng thái; `historyFilterBarHtml` nói rõ phạm vi khi máy chủ có nhiều job hơn trang đã tải.
 *   mục 4 — khoá bấm hai lần đặt trong `onGlobalClick` (không trích được vì gắn DOM) ⇒ kiểm CẤU TRÚC mã.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './imagelab-helpers.js';
import { loadUiFunction, loadUiConst, loadUiConstValue } from './imagelab-ui-helpers.js';

const XSS = '"><img src=x onerror=alert(1)>';
const esc = loadUiFunction('esc');
const STATUS_LABEL = loadUiConst('STATUS_LABEL');

function exportPanel(state) {
  const consts = {};
  for (const name of ['EXPORT_HONEST_LINE', 'EXPORT_RUNNING_LINE', 'EXPORT_NO_ID_LINE', 'EXPORT_UNCONFIGURED_LINE', 'EXPORT_BUTTON_LABEL', 'EXPORT_MANIFEST_LABEL']) {
    consts[name] = loadUiConstValue(name);
  }
  const exportBundleUrl = loadUiFunction('exportBundleUrl');
  return loadUiFunction('exportPanelHtml', { state, esc, exportBundleUrl, ...consts });
}

describe('UI §5 mục 5 — bản kê khai đã mở được vẽ lại sau mỗi lần poll', () => {
  test('state.exportManifest cùng job ⇒ khối KHÔNG hidden và chứa đúng HTML đã dựng', () => {
    const state = { config: {}, exportManifest: { jobId: 'job-1', html: '<ul class="m"><li>đã escape</li></ul>' } };
    const html = exportPanel(state)('job-1', 'running', { kind: 'content' });
    assert.match(html, /<div data-export-manifest><ul class="m"><li>đã escape<\/li><\/ul><\/div>/);
    assert.doesNotMatch(html, /data-export-manifest hidden/);
  });

  test('bản kê khai của job KHÁC ⇒ không hiện (không rò dữ liệu job này sang job kia)', () => {
    const state = { config: {}, exportManifest: { jobId: 'job-1', html: '<p>của job 1</p>' } };
    const html = exportPanel(state)('job-2', 'succeeded', {});
    assert.match(html, /<div data-export-manifest hidden><\/div>/);
    assert.doesNotMatch(html, /của job 1/);
  });

  test('không có gì đã mở / state cũ thiếu trường ⇒ hành vi như trước (khối ẩn)', () => {
    assert.match(exportPanel({ config: {} })('job-1', 'succeeded', {}), /data-export-manifest hidden/);
    assert.match(exportPanel({ config: {}, exportManifest: { jobId: 'job-1', html: null } })('job-1', 'succeeded', {}), /data-export-manifest hidden/);
    assert.match(exportPanel({ config: {}, exportManifest: { jobId: '', html: '<p>x</p>' } })('', 'succeeded', {}), /data-export-manifest hidden/);
  });

  test('handler `exportmanifest` lưu HTML do exportManifestHtml dựng (đã escape), không lưu dữ liệu thô', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const i = src.indexOf('exportmanifest: () =>');
    assert.ok(i > 0, 'có handler exportmanifest');
    const block = src.slice(i, src.indexOf('}),', i) + 3);
    assert.match(block, /state\.exportManifest = r\?\.ok \? \{ jobId: id, html: exportManifestHtml\(r\.data\) \} : null/);
  });
});

describe('UI §5 mục 6 — lọc Lịch sử', () => {
  const historyFilterItems = loadUiFunction('historyFilterItems');
  const items = [
    { id: 'a1', product_name: 'Tai nghe CHỤP tai không dây', source: '1688', source_url: 'https://detail.1688.com/offer/1.html', status: 'succeeded' },
    { id: 'b2', product_name: 'Ốp lưng điện thoại', source: 'taobao', source_url: 'https://item.taobao.com/x', status: 'failed' },
    { id: 'c3', product_name: '', source: 'pinduoduo', source_url: 'https://mobile.yangkeduo.com/goods.html?id=9', status: 'needs_manual' },
  ];

  test('không bộ lọc ⇒ trả đủ, giữ thứ tự', () => {
    assert.deepEqual(historyFilterItems(items, {}).map((x) => x.id), ['a1', 'b2', 'c3']);
  });

  test('không phân biệt hoa thường và BỎ DẤU tiếng Việt: "chup tai" khớp "CHỤP tai", "op lung" khớp "Ốp lưng", "dien thoai" khớp "điện thoại"', () => {
    assert.deepEqual(historyFilterItems(items, { q: 'chup tai' }).map((x) => x.id), ['a1']);
    assert.deepEqual(historyFilterItems(items, { q: 'op lung' }).map((x) => x.id), ['b2']);
    assert.deepEqual(historyFilterItems(items, { q: 'DIEN THOAI' }).map((x) => x.id), ['b2']);
  });

  test('khớp cả link nguồn, tên nguồn và mã job', () => {
    assert.deepEqual(historyFilterItems(items, { q: 'yangkeduo' }).map((x) => x.id), ['c3']);
    assert.deepEqual(historyFilterItems(items, { q: 'taobao' }).map((x) => x.id), ['b2']);
    assert.deepEqual(historyFilterItems(items, { q: 'c3' }).map((x) => x.id), ['c3']);
  });

  test('lọc trạng thái + chữ cùng lúc; không khớp ⇒ mảng rỗng; đầu vào hỏng ⇒ mảng rỗng, không ném', () => {
    assert.deepEqual(historyFilterItems(items, { status: 'failed' }).map((x) => x.id), ['b2']);
    assert.deepEqual(historyFilterItems(items, { q: 'tai', status: 'failed' }), []);
    assert.deepEqual(historyFilterItems(null, { q: 'x' }), []);
    assert.deepEqual(historyFilterItems([null, {}], { q: '' }).length, 2);
  });

  test('thanh lọc: mỗi ô có nhãn, trạng thái dịch tiếng Việt, escape XSS, nói rõ phạm vi khi máy chủ có nhiều job hơn', () => {
    const historyFilterBarHtml = loadUiFunction('historyFilterBarHtml', { esc, STATUS_LABEL });
    const html = historyFilterBarHtml(items, { q: XSS, status: 'failed' }, 250);
    assert.match(html, /<label[^>]*for="hist-q"/);
    assert.match(html, /<label[^>]*for="hist-status"/);
    assert.equal(html.includes('<img'), false);
    assert.match(html, /value="failed" selected/);
    assert.match(html, /Máy chủ có 250 job — chỉ lọc trong 3 job mới nhất đã tải\./);
    assert.doesNotMatch(historyFilterBarHtml(items, { q: '', status: '' }, 3), /Máy chủ có/);
  });
});

describe('UI §5 mục 4 — khoá bấm hai lần đặt MỘT chỗ trong onGlobalClick', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const start = src.indexOf('function onGlobalClick(');
  const body = src.slice(start, src.indexOf('\n}\n', start));

  test('lượt bấm trùng (action + đối tượng) bị bỏ qua khi lượt trước còn chạy; nhả khoá bằng finally (không nuốt lỗi)', () => {
    assert.match(body, /if \(CLICK_INFLIGHT\.has\(key\)\) \{/);
    assert.match(body, /ret\.finally\(\(\) => \{\s*CLICK_INFLIGHT\.delete\(key\);/);
    assert.doesNotMatch(body, /ret\.catch\(/, 'không được .catch() nuốt lỗi của handler');
  });

  test('khoá theo cả đối tượng: hai bài khác nhau bấm song song vẫn được', () => {
    const clickInflightKey = loadUiFunction('clickInflightKey');
    assert.notEqual(clickInflightKey('pubpublish', { dataset: { id: 'p1' } }), clickInflightKey('pubpublish', { dataset: { id: 'p2' } }));
    assert.equal(clickInflightKey('exportbundle', { dataset: { exportId: 'j1' } }), 'exportbundle:j1');
    assert.equal(clickInflightKey('home', {}), 'home:');
  });
});
