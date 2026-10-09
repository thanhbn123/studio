/**
 * Tiện ích cho test tầng UI khối “Gói xuất bản (.zip)” (`public/app.js`, hợp đồng §4).
 *
 * Cách làm giống `test/imagestudio-ui-helpers.js`: TRÍCH ĐÚNG mã hàm/const từ `public/app.js`
 * (không chép lại tay) rồi biên dịch trong Node với `state`, `app` (giả) và các hàm phụ thuộc
 * được bơm vào. UI đổi cấu trúc ⇒ `loadUiFunction` NÉM LỖI RÕ RÀNG, không im lặng bỏ qua.
 *
 * `esc` được trích THẬT từ `public/app.js` (không phải bản chép) để khẳng định escape XSS
 * đúng bằng hàm mà trình duyệt sẽ chạy.
 *
 * File này KHÔNG có hậu tố `.test.js` nên `node --test test/*.test.js` không chạy nó.
 */

import { loadUiConst, loadUiConstValue, loadUiFunction } from './imagelab-ui-helpers.js';

/** `esc()` THẬT của UI. */
export const escReal = () => loadUiFunction('esc', {});

/** `state` tối thiểu đúng hình dạng app (không cần DOM). */
export function makeUiState({ config = {}, job = null, il = {}, is = {}, vs = {} } = {}) {
  return {
    view: 'home',
    config,
    job,
    poll: null,
    il: { jobId: null, job: null, poll: null, pending: null, busy: false, error: null, ...il },
    is: { jobId: null, job: null, poll: null, loading: null, pending: null, busy: false, error: null, templates: [], templatesLoading: false, templatesError: null, ...is },
    vs: { jobId: null, job: null, poll: null, presets: [], presetsLoading: false, presetsError: null, busy: false, error: null, ...vs },
  };
}

/**
 * Nạp TOÀN BỘ hằng + hàm THẬT của khối “Gói xuất bản”.
 * @param {object} state state do `makeUiState()` dựng
 * @param {{document?: object}} [opts] `document` giả cho `exportPaintError`
 */
export function loadExportUi(state, { document: doc = null } = {}) {
  const esc = escReal();
  const EXPORT_ERROR_HINT = loadUiConst('EXPORT_ERROR_HINT');
  const consts = {
    EXPORT_BUTTON_LABEL: loadUiConstValue('EXPORT_BUTTON_LABEL'),
    EXPORT_MANIFEST_LABEL: loadUiConstValue('EXPORT_MANIFEST_LABEL'),
    EXPORT_HONEST_LINE: loadUiConstValue('EXPORT_HONEST_LINE'),
    EXPORT_RUNNING_LINE: loadUiConstValue('EXPORT_RUNNING_LINE'),
    EXPORT_NO_ID_LINE: loadUiConstValue('EXPORT_NO_ID_LINE'),
    EXPORT_UNCONFIGURED_LINE: loadUiConstValue('EXPORT_UNCONFIGURED_LINE'),
    EXPORT_NOT_MANIFEST_LINE: loadUiConstValue('EXPORT_NOT_MANIFEST_LINE'),
    EXPORT_FALLBACK_LINE: loadUiConstValue('EXPORT_FALLBACK_LINE'),
    EXPORT_ERROR_HINT,
  };

  const exportBundleUrl = loadUiFunction('exportBundleUrl', {});
  const exportManifestUrl = loadUiFunction('exportManifestUrl', {});
  const exportErrorText = loadUiFunction('exportErrorText', { EXPORT_ERROR_HINT, EXPORT_NOT_MANIFEST_LINE: consts.EXPORT_NOT_MANIFEST_LINE });
  const exportScalarText = loadUiFunction('exportScalarText', {});
  const exportList = loadUiFunction('exportList', { exportScalarText });
  const exportUnion = loadUiFunction('exportUnion', { exportList });
  const exportVerificationLabel = loadUiFunction('exportVerificationLabel', {});
  const exportVerificationText = loadUiFunction('exportVerificationText', { exportScalarText });
  const exportBlockHtml = loadUiFunction('exportBlockHtml', { esc });
  const exportManifestHtml = loadUiFunction('exportManifestHtml', {
    esc,
    exportScalarText,
    exportList,
    exportUnion,
    exportVerificationLabel,
    exportVerificationText,
    exportBlockHtml,
  });
  const exportPanelHtml = loadUiFunction('exportPanelHtml', { state, esc, exportBundleUrl, ...consts });
  const exportDownloadName = loadUiFunction('exportDownloadName', {});
  const exportPaintError = loadUiFunction('exportPaintError', {
    document: doc,
    esc,
    exportErrorText,
    exportBundleUrl,
    EXPORT_FALLBACK_LINE: consts.EXPORT_FALLBACK_LINE,
  });

  // Chạy thử với dữ liệu rỗng: hàm trích ra phải chạy được, không chỉ biên dịch được.
  if (typeof exportPanelHtml(null, 'succeeded', {}) !== 'string') throw new Error('public/app.js: exportPanelHtml không trả về chuỗi HTML.');
  if (typeof exportManifestHtml({}) !== 'string') throw new Error('public/app.js: exportManifestHtml không trả về chuỗi HTML.');

  return {
    esc,
    ...consts,
    exportBundleUrl,
    exportManifestUrl,
    exportErrorText,
    exportScalarText,
    exportList,
    exportUnion,
    exportVerificationLabel,
    exportVerificationText,
    exportBlockHtml,
    exportManifestHtml,
    exportPanelHtml,
    exportDownloadName,
    exportPaintError,
  };
}

/** `app` giả: chỉ cần `innerHTML` để soi HTML mà màn hình THẬT vẽ ra. */
export function makeAppStub() {
  return { innerHTML: '' };
}

/**
 * DOM giả tối thiểu cho 2 handler bấm nút (`downloadExportBundle`, `openExportManifest`):
 * panel lỗi, panel bản kê khai, thẻ `<a download>` và `body.appendChild`.
 * Trả về cả `log` để test soi ĐÚNG thứ đã xảy ra (đã bấm tải chưa, href là gì…).
 */
export function makeDomStub() {
  const log = { clicks: [], appended: [], removed: 0, toasts: [] };
  const errorBox = { innerHTML: '' };
  const manifestBox = { innerHTML: '', hidden: true };
  const document = {
    querySelector(sel) {
      if (sel === '[data-export-error]') return errorBox;
      if (sel === '[data-export-manifest]') return manifestBox;
      return null;
    },
    createElement(tag) {
      const el = {
        tag,
        href: '',
        download: '',
        rel: '',
        hidden: false,
        click: () => log.clicks.push({ href: el.href, download: el.download }),
        remove: () => { log.removed += 1; },
      };
      return el;
    },
    body: { appendChild: (el) => log.appended.push(el) },
  };
  return { document, errorBox, manifestBox, log, toast: (msg) => log.toasts.push(msg) };
}

/**
 * Nạp 2 handler THẬT của khối “Gói xuất bản”: `downloadExportBundle`, `openExportManifest`.
 * Mọi hàm phụ thuộc đều là hàm THẬT của UI (qua `loadExportUi`); chỉ `api`, `toast` và DOM
 * là giả — đúng những thứ trình duyệt cung cấp.
 * @param {object} state
 * @param {object} dom kết quả `makeDomStub()`
 * @param {(url: string, opts?: object) => Promise<any>} api hàm gọi API giả (test tự ghi lại lời gọi)
 */
export function loadExportActions(state, dom, api) {
  const ui = loadExportUi(state, { document: dom.document });
  const shared = {
    document: dom.document,
    api,
    esc: ui.esc,
    exportManifestUrl: ui.exportManifestUrl,
    exportPaintError: ui.exportPaintError,
    EXPORT_NO_ID_LINE: ui.EXPORT_NO_ID_LINE,
    EXPORT_NOT_MANIFEST_LINE: ui.EXPORT_NOT_MANIFEST_LINE,
  };
  const downloadExportBundle = loadUiFunction('downloadExportBundle', {
    ...shared,
    toast: dom.toast,
    exportBundleUrl: ui.exportBundleUrl,
    exportDownloadName: ui.exportDownloadName,
  }, { async: true });
  const openExportManifest = loadUiFunction('openExportManifest', {
    ...shared,
    exportManifestHtml: ui.exportManifestHtml,
  }, { async: true });
  return { ...ui, downloadExportBundle, openExportManifest };
}

/**
 * Nạp 4 hàm render MÀN JOB thật (MVP-01..04) với các khối phụ thuộc KHÔNG liên quan được
 * thay bằng stub — đúng cách `loadRenderIlJob` của `imagelab-ui-helpers.js` đang làm.
 * Khối “Gói xuất bản” (`exportPanelHtml`) là hàm THẬT: đó chính là thứ được kiểm.
 */
export function loadExportScreens(state, app, exportPanelHtml) {
  const esc = escReal();
  // `STATUS_LABEL` là object nhiều dòng, `SOURCE_LABEL` khai MỘT dòng.
  const STATUS_LABEL = loadUiConst('STATUS_LABEL');
  const SOURCE_LABEL = loadUiConstValue('SOURCE_LABEL');
  const noop = () => {};

  const renderJob = loadUiFunction('renderJob', {
    state,
    app,
    esc,
    SOURCE_LABEL,
    STATUS_LABEL,
    exportPanelHtml,
    renderProgress: () => '<div data-stub="progress"></div>',
    renderNeedsManual: () => '<div data-stub="manual"></div>',
    renderResult: () => '<div data-stub="result"></div>',
    wireEditForm: noop,
    wireManualForm: noop,
  });

  const renderImagelab = loadUiFunction('renderImagelab', {
    state,
    app,
    esc,
    exportPanelHtml,
    stopPolling: noop,
    ilProviderBadge: loadUiFunction('ilProviderBadge', { esc }),
    ilMockNotice: () => '',
    renderIlJob: (panel) => `<div data-stub="iljob">${panel}</div>`,
    renderIlUpload: () => '<div data-stub="ilupload"></div>',
    authHintHtml: () => '',
    paintIlError: noop,
  });

  const renderImagestudio = loadUiFunction('renderImagestudio', {
    state,
    app,
    exportPanelHtml,
    stopPolling: noop,
    stopIlPolling: noop,
    renderImagestudioBody: (panel) => `<div data-stub="isbody">${panel}</div>`,
    authHintHtml: () => '',
    loadImagestudioTemplates: noop,
  });

  const vsRenderPage = loadUiFunction('vsRenderPage', {
    state,
    app,
    exportPanelHtml,
    stopPolling: noop,
    stopIlPolling: noop,
    stopIsPolling: noop,
    vsRenderBody: (panel) => `<div data-stub="vsbody">${panel}</div>`,
    authHintHtml: () => '',
    vsPresets: () => [{ id: 'gif-ngan', label: 'GIF ngắn' }],
    loadVideoPresets: noop,
  });

  return { renderJob, renderImagelab, renderImagestudio, vsRenderPage };
}
