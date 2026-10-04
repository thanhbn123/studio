/**
 * Tiện ích cho test tầng UI MVP-03 (`public/app.js`, tab “Tạo ảnh”) — KHÔNG mở trình duyệt.
 *
 * Cách làm giống `test/imagelab-ui-helpers.js`: TRÍCH ĐÚNG mã hàm từ `public/app.js`
 * (không chép lại tay) rồi biên dịch trong Node với `state` và các hàm phụ thuộc được bơm vào.
 * Nếu UI đổi cấu trúc, `loadUiFunction` NÉM LỖI RÕ RÀNG — im lặng bỏ qua là kiểu thất bại bị cấm.
 *
 * File này không có hậu tố `.test.js` nên `node --test test/*.test.js` không chạy nó.
 */

import { loadUiConst, loadUiConstValue, loadUiFunction, esc } from './imagelab-ui-helpers.js';

/** `state` MVP-03 tối thiểu, đúng hình dạng `state.is` của app (không cần DOM). */
export function makeIsState({ config = null, is = {} } = {}) {
  return {
    config,
    is: {
      jobId: null,
      job: null,
      poll: null,
      pollCount: 0,
      loading: null,
      pending: null,
      busy: false,
      error: null,
      templates: null,
      limits: null,
      mattingProvider: null,
      providers: null,
      templatesLoading: false,
      templatesError: null,
      overlayBlocked: null,
      dirtyPaint: false,
      options: {
        template: 'trang',
        remove_background: true,
        retouch: { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 },
        overlay_text: '',
      },
      ...is,
    },
  };
}

/** `/api/config` giả với khối `imagestudio` (đúng field hợp đồng §3.6). */
export function isConfigBlock(overrides = {}) {
  return {
    imagelab: { limits: { max_image_bytes: 8 * 1024 * 1024, max_pixels: 16_000_000, allowed_image_mime: ['image/png'] } },
    imagestudio: {
      available: true,
      reason: null,
      enabled: true,
      templates: [],
      retouch_limits: null,
      matting: { name: 'purejs', is_mock: false, configured: true },
      retouch: { name: 'purejs', is_mock: false, configured: true },
      ...overrides,
    },
  };
}

/**
 * Nạp TOÀN BỘ hàm render THẬT của tab “Tạo ảnh” + các hàm phụ thuộc (cũng là hàm thật).
 * @param {object} state state do `makeIsState()` dựng
 */
export function loadIsUi(state) {
  const IS_STATUS_LABEL = loadUiConst('IS_STATUS_LABEL');
  const IS_STAGE_LABEL = loadUiConst('IS_STAGE_LABEL');
  const IS_STAGE_ORDER = loadUiConstValue('IS_STAGE_ORDER');
  const IS_STAGE_STEPS = loadUiConstValue('IS_STAGE_STEPS');
  const IS_PARAM_LABEL = loadUiConst('IS_PARAM_LABEL');
  const IS_PARAM_ORDER = loadUiConstValue('IS_PARAM_ORDER');
  const IS_SYNTHETIC_NOTE = loadUiConstValue('IS_SYNTHETIC_NOTE');
  const IS_OVERLAY_CLAIM_NOTE = loadUiConstValue('IS_OVERLAY_CLAIM_NOTE');
  const IS_MATTING_FAIL_TEXT = loadUiConst('IS_MATTING_FAIL_TEXT');
  const IS_ERROR_HINT = loadUiConst('IS_ERROR_HINT');

  const isNumText = loadUiFunction('isNumText', {});
  const isNumPlain = loadUiFunction('isNumPlain', {});
  const isViolationText = loadUiFunction('isViolationText', {});
  const isEffectiveValue = loadUiFunction('isEffectiveValue', {});
  const isJobRunning = loadUiFunction('isJobRunning', {});
  const isMaskItems = loadUiFunction('isMaskItems', { isNumPlain });
  const isLimits = loadUiFunction('isLimits', { state });
  const isLimitFor = loadUiFunction('isLimitFor', { isLimits });
  const isParamValue = loadUiFunction('isParamValue', { state });
  const isJobOptions = loadUiFunction('isJobOptions', { state, IS_PARAM_ORDER });
  const isErrorText = loadUiFunction('isErrorText', { IS_ERROR_HINT });

  const ilProviderBadge = loadUiFunction('ilProviderBadge', { esc });
  const isProviderBadges = loadUiFunction('isProviderBadges', { state, ilProviderBadge });
  const isMockNotice = loadUiFunction('isMockNotice', { state, esc });
  const isLimitsNotice = loadUiFunction('isLimitsNotice', { IS_PARAM_ORDER, isLimitFor, esc, IS_PARAM_LABEL });
  const isHeaderPanel = loadUiFunction('isHeaderPanel', {
    state,
    esc,
    isProviderBadges,
    isMockNotice,
    isLimitsNotice,
    IS_SYNTHETIC_NOTE,
  });
  const isUnavailablePanel = loadUiFunction('isUnavailablePanel', { state, esc });
  const isErrorBox = loadUiFunction('isErrorBox', { state, esc });

  const renderIsUpload = loadUiFunction('renderIsUpload', { state, esc });
  const renderIsTemplates = loadUiFunction('renderIsTemplates', { state, esc });
  const renderIsParam = loadUiFunction('renderIsParam', {
    IS_PARAM_LABEL,
    isLimitFor,
    isParamValue,
    esc,
    isNumText,
    state,
  });
  const renderIsOverlayBlocked = loadUiFunction('renderIsOverlayBlocked', { state, esc, IS_OVERLAY_CLAIM_NOTE });
  const renderIsCompare = loadUiFunction('renderIsCompare', { esc, IS_SYNTHETIC_NOTE });
  const renderIsSteps = loadUiFunction('renderIsSteps', { IS_STAGE_ORDER, IS_STAGE_STEPS, esc });
  const renderIsWarnings = loadUiFunction('renderIsWarnings', {
    state,
    esc,
    IS_MATTING_FAIL_TEXT,
    IS_PARAM_LABEL,
    IS_SYNTHETIC_NOTE,
    IS_OVERLAY_CLAIM_NOTE,
    isMaskItems,
    isNumPlain,
    isLimitFor,
    isNumText,
    isEffectiveValue,
    isViolationText,
  });
  const renderIsOptions = loadUiFunction('renderIsOptions', {
    state,
    esc,
    isJobRunning,
    renderIsTemplates,
    renderIsParam,
    IS_PARAM_ORDER,
    IS_SYNTHETIC_NOTE,
    IS_OVERLAY_CLAIM_NOTE,
  });
  const renderIsJob = loadUiFunction('renderIsJob', {
    state,
    esc,
    isJobRunning,
    IS_STATUS_LABEL,
    IS_STAGE_LABEL,
    renderIsSteps,
    renderIsCompare,
    renderIsOptions,
    renderIsWarnings,
  });
  const renderImagestudioBody = loadUiFunction('renderImagestudioBody', {
    state,
    isHeaderPanel,
    renderIsJob,
    renderIsUpload,
    renderIsOptions,
    renderIsOverlayBlocked,
    isErrorBox,
  });

  /* Khói báo "không có DOM": nếu hàm trích ra không chạy được với state rỗng thì UI đã đổi. */
  for (const [name, fn] of Object.entries({ renderImagestudioBody, renderIsJob, renderIsOptions })) {
    if (typeof fn !== 'function') throw new Error(`public/app.js: ${name} không phải hàm sau khi trích.`);
  }
  if (typeof renderImagestudioBody() !== 'string') throw new Error('public/app.js: renderImagestudioBody không trả về chuỗi HTML.');

  return {
    IS_STATUS_LABEL,
    IS_STAGE_LABEL,
    IS_STAGE_ORDER,
    IS_STAGE_STEPS,
    IS_PARAM_LABEL,
    IS_PARAM_ORDER,
    IS_SYNTHETIC_NOTE,
    IS_OVERLAY_CLAIM_NOTE,
    IS_MATTING_FAIL_TEXT,
    isNumText,
    isNumPlain,
    isViolationText,
    isEffectiveValue,
    isJobRunning,
    isMaskItems,
    isLimits,
    isLimitFor,
    isParamValue,
    isJobOptions,
    isErrorText,
    ilProviderBadge,
    isProviderBadges,
    isMockNotice,
    isLimitsNotice,
    isHeaderPanel,
    isUnavailablePanel,
    isErrorBox,
    renderIsUpload,
    renderIsTemplates,
    renderIsParam,
    renderIsOverlayBlocked,
    renderIsCompare,
    renderIsSteps,
    renderIsWarnings,
    renderIsOptions,
    renderIsJob,
    renderImagestudioBody,
  };
}

export { esc };
