/**
 * Tiện ích cho test tầng UI (public/app.js) — KHÔNG mở trình duyệt.
 *
 * Cách làm: TRÍCH ĐÚNG mã hàm từ `public/app.js` rồi biên dịch trong Node với các phụ thuộc
 * được bơm vào. Nhờ vậy test chạy trên mã UI THẬT (không phải bản chép lại tay), mà không cần DOM.
 *
 * Nếu `public/app.js` đổi cấu trúc (đổi tên hàm, đổi cách viết), hàm trích sẽ NÉM LỖI RÕ RÀNG
 * — im lặng bỏ qua là kiểu thất bại bị cấm trong dự án này.
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

const APP_PATH = () => path.join(ROOT, 'public', 'app.js');

function readApp() {
  return fs.readFileSync(APP_PATH(), 'utf8');
}

/**
 * Cắt mã của một hàm khai báo kiểu `function ten(...) { ... }` (khớp `\n}\n` đầu tiên).
 * `async: true` để giữ cả từ khoá `async` — thiếu nó thì thân hàm chứa `await` sẽ không
 * biên dịch được (xem `saveIlManualRegions` của IL-08).
 */
function sliceFunction(src, name, { async = false } = {}) {
  const marker = `${async ? 'async ' : ''}function ${name}(`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`public/app.js: không tìm thấy hàm ${name} — UI đã đổi cấu trúc?`);
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`public/app.js: không xác định được điểm kết thúc hàm ${name}.`);
  return src.slice(start, end + 3);
}

/** Cắt mã của một khai báo `const ten = ...;` trên MỘT dòng (hằng số, hàm mũi tên ngắn). */
function sliceConst(src, name) {
  const marker = `const ${name} = `;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`public/app.js: không tìm thấy const ${name} — UI đã đổi cấu trúc?`);
  const end = src.indexOf(';\n', start);
  if (end < 0) throw new Error(`public/app.js: không xác định được điểm kết thúc const ${name}.`);
  return src.slice(start, end + 2);
}

/** Cắt mã của một object literal `const ten = { ... };`. */
function sliceObject(src, name) {
  const start = src.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`public/app.js: không tìm thấy object ${name}.`);
  const end = src.indexOf('\n};', start);
  if (end < 0) throw new Error(`public/app.js: không xác định được điểm kết thúc object ${name}.`);
  return src.slice(start, end + 3);
}

const evalSnippet = (code, exportName) => new Function(`${code}\nreturn ${exportName};`)();

/**
 * Biên dịch một hàm UI thật với các phụ thuộc bơm vào.
 * @param {string} name tên hàm trong public/app.js
 * @param {object} deps map tên → giá trị (esc, hằng số, hàm phụ thuộc, state…)
 * @param {{style?: 'function'|'const', async?: boolean}} [opts] `async: true` cho `async function`
 *
 * `async: true` cắt NGUYÊN cả từ khoá `async` rồi khai báo hàm async bên trong `Function`.
 * (Không dùng `AsyncFunction` làm constructor ngoài: nó trả Promise, nên hàm trích ra sẽ là
 * Promise chứ không phải hàm — test cần gọi được hàm async đó một cách đồng bộ.)
 */
export function loadUiFunction(name, deps = {}, { style = 'function', async = false } = {}) {
  const src = readApp();
  const body = style === 'const' ? sliceConst(src, name) : sliceFunction(src, name, { async });
  const names = Object.keys(deps);
  const values = Object.values(deps);
  let fn;
  try {
    fn = new Function(...names, `${body}\nreturn ${name};`)(...values);
  } catch (err) {
    throw new Error(`public/app.js: không biên dịch được ${name}: ${err.message}`);
  }
  if (typeof fn !== 'function') throw new Error(`public/app.js: ${name} không phải hàm sau khi biên dịch.`);
  return fn;
}

/** Lấy một object/hằng số thật từ public/app.js (bảng nhãn, bảng gợi ý lỗi, Set…). */
export function loadUiConst(name) {
  const src = readApp();
  return evalSnippet(sliceObject(src, name), name);
}

/** Lấy một hằng khai báo MỘT DÒNG thật (`const X = [...]` / `= new Set(...)` / mũi tên ngắn). */
export function loadUiConstValue(name) {
  const src = readApp();
  return evalSnippet(sliceConst(src, name), name);
}

/** Bộ hằng số + hàm phụ trợ mà các hàm UI imagelab cần. */
export function uiDeps(extra = {}) {
  const src = readApp();
  const IL_KIND_LABEL = loadUiConst('IL_KIND_LABEL');
  const IL_LINE_STATUS = loadUiConst('IL_LINE_STATUS');
  const IL_LOCKED_KINDS = evalSnippet(sliceConst(src, 'IL_LOCKED_KINDS'), 'IL_LOCKED_KINDS');
  const IL_LOCKED_STATUSES = evalSnippet(sliceConst(src, 'IL_LOCKED_STATUSES'), 'IL_LOCKED_STATUSES');
  const ilLocked = loadUiFunction('ilLocked', { IL_LOCKED_KINDS, IL_LOCKED_STATUSES }, { style: 'const' });
  return {
    esc,
    IL_KIND_LABEL,
    IL_LINE_STATUS,
    IL_LOCKED_KINDS,
    IL_LOCKED_STATUSES,
    ilLocked,
    IL_ERROR_HINT: loadUiConst('IL_ERROR_HINT'),
    ...extra,
  };
}

/** Hàm `renderIlWarnings(data)` thật (dùng ở test F-03 và test UI). */
export function loadRenderIlWarnings() {
  const deps = uiDeps();
  const src = readApp();
  const IL_SKIP_REASON = evalSnippet(sliceObject(src, 'IL_SKIP_REASON'), 'IL_SKIP_REASON');
  const fn = loadUiFunction('renderIlWarnings', {
    esc: deps.esc,
    IL_SKIP_REASON,
    IL_KIND_LABEL: deps.IL_KIND_LABEL,
  });
  const smoke = fn({});
  if (typeof smoke !== 'string') throw new Error('public/app.js: renderIlWarnings không trả về chuỗi HTML.');
  return fn;
}

/* ═════════════════════ IL-08 — nhập vùng chữ bằng tay (§11.3) ═════════════════════
 *
 * Toàn bộ chuỗi hàm THẬT của khối "Nhập vùng chữ bằng tay". Test KHÔNG chép lại mã UI:
 * mọi hàm đều được cắt từ `public/app.js` và biên dịch với `state` do test dựng.
 */

/** `state` imagelab tối thiểu đúng hình dạng `state.il` của app (không cần DOM). */
export function makeIlState({ job = null, manual = {}, il = {} } = {}) {
  return {
    config: null,
    il: {
      jobId: null,
      job,
      overrides: new Set(),
      lastSave: null,
      renderBlocked: null,
      manual: {
        open: null,
        rows: null,
        touched: false,
        busy: false,
        error: null,
        notice: null,
        warnings: [],
        rejected: null,
        conflict: null,
        dirtyPaint: false,
        ...manual,
      },
      ...il,
    },
  };
}

/** Chuỗi hàm THẬT mà khối nhập tay dựa vào (`ilManualOpen/Rows/Payload`, giới hạn vùng…). */
export function loadIlManualDeps(state) {
  const IL_KIND_LABEL = loadUiConst('IL_KIND_LABEL');
  const IL_MANUAL_KINDS = loadUiConstValue('IL_MANUAL_KINDS');
  const ilNumText = loadUiFunction('ilNumText', {}, { style: 'const' });
  const ilOcrMockTrace = loadUiFunction('ilOcrMockTrace', {});
  const ilManualDefaultOpen = loadUiFunction('ilManualDefaultOpen', { ilOcrMockTrace });
  const ilManualOpen = loadUiFunction('ilManualOpen', { state, ilManualDefaultOpen });
  const ilManualRows = loadUiFunction('ilManualRows', { state, ilNumText });
  const ilMaxRegions = loadUiFunction('ilMaxRegions', { state });
  const ilManualPayload = loadUiFunction('ilManualPayload', { IL_MANUAL_KINDS });
  return {
    IL_KIND_LABEL,
    IL_MANUAL_KINDS,
    ilNumText,
    ilOcrMockTrace,
    ilManualDefaultOpen,
    ilManualOpen,
    ilManualRows,
    ilMaxRegions,
    ilManualPayload,
  };
}

/** `renderIlManual(data)` THẬT — bảng nhập vùng chữ bằng tay. */
export function loadRenderIlManual(state) {
  const deps = loadIlManualDeps(state);
  return loadUiFunction('renderIlManual', { state, esc, ...deps });
}

/** `renderIlJob()` THẬT, với khối nhập tay THẬT; các khối khác (ảnh/duyệt) bơm rỗng. */
export function loadRenderIlJob(state) {
  const deps = loadIlManualDeps(state);
  const renderIlManual = loadUiFunction('renderIlManual', { state, esc, ...deps });
  return loadUiFunction('renderIlJob', {
    state,
    esc,
    IL_STAGE_LABEL: loadUiConst('IL_STAGE_LABEL'),
    IL_STATUS_LABEL: loadUiConst('IL_STATUS_LABEL'),
    IL_STAGE_ORDER: loadUiConstValue('IL_STAGE_ORDER'),
    renderIlSteps: () => '',
    renderIlCompare: () => '',
    renderIlReview: () => '',
    renderIlNoLines: () => '',
    renderIlManual, // THẬT — đây là thứ test (d) kiểm
    renderIlWarnings: () => '',
  });
}

/**
 * `saveIlManualRegions(confirmReplace)` THẬT (hàm async) + bản ghi lời gọi API.
 * Trả về `{ save, apiCalls, renders, toasts }` để test kiểm ĐÚNG body gửi lên.
 */
export function loadSaveIlManualRegions(state, { apiResult = null, apiError = null } = {}) {
  const deps = loadIlManualDeps(state);
  const ilErrorText = loadUiFunction('ilErrorText', { IL_ERROR_HINT: loadUiConst('IL_ERROR_HINT') });
  const apiCalls = [];
  const renders = [];
  const toasts = [];
  const api = async (url, opts = {}) => {
    apiCalls.push({ url, opts });
    if (apiError) throw apiError;
    return apiResult ?? { regions: [], lines: [], rejected: [], warnings: [] };
  };
  const save = loadUiFunction(
    'saveIlManualRegions',
    {
      state,
      esc,
      api,
      toast: (msg) => toasts.push(msg),
      renderImagelab: () => renders.push(state.il.job),
      ilErrorText,
      ilManualPayload: deps.ilManualPayload,
      ilManualRows: deps.ilManualRows,
      ilMaxRegions: deps.ilMaxRegions,
    },
    { async: true },
  );
  return { save, apiCalls, renders, toasts, ilErrorText };
}

export { esc };
