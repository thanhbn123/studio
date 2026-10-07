/**
 * Tiện ích cho test tầng UI MVP-04 (tab “Video” của `public/app.js`) — KHÔNG mở trình duyệt.
 *
 * Cách làm giống `test/imagestudio-ui-helpers.js`: TRÍCH ĐÚNG mã hàm từ `public/app.js`
 * (không chép lại tay) rồi biên dịch trong Node với `state` + các hàm phụ thuộc được bơm vào.
 * UI đổi cấu trúc ⇒ `loadUiFunction` NÉM LỖI RÕ RÀNG (im lặng bỏ qua là kiểu thất bại bị cấm).
 *
 * File này không có hậu tố `.test.js` nên `node --test test/*.test.js` không chạy nó.
 */

import { loadUiConst, loadUiConstValue, loadUiFunction, esc } from './imagelab-ui-helpers.js';

/** `state` MVP-04 tối thiểu, đúng hình dạng `state.vs` của app (không cần DOM). */
export function makeVsState({ config = null, vs = {} } = {}) {
  return {
    config,
    vs: {
      jobId: null,
      job: null,
      poll: null,
      pollCount: 0,
      loading: null,
      busy: false,
      error: null,
      presets: null,
      encoder: null,
      limits: null,
      presetsLoading: false,
      presetsError: null,
      scenes: [],
      fileErrors: [],
      pendingFiles: false,
      preset: null,
      fit: 'pad',
      textBlocked: null,
      dirtyPaint: false,
      ...vs,
    },
  };
}

/** Khối `videostudio` của `/api/config` (đúng field §2.4) — preset chỉ id+label như server trả. */
export function vsConfigBlock(overrides = {}) {
  return {
    available: true,
    reason: null,
    enabled: true,
    presets: [
      { id: 'doc-9x16', label: 'Dọc 9:16 (TikTok/Reels)' },
      { id: 'vuong-1x1', label: 'Vuông 1:1 (Feed)' },
      { id: 'ngang-16x9', label: 'Ngang 16:9 (YouTube)' },
    ],
    encoder: { name: 'purejs', is_mock: false, configured: true },
    audio: false,
    ...overrides,
  };
}

/** Preset THẬT của `GET /api/videostudio/presets` (đủ width/height/fps/max_seconds). */
export const VS_TEST_PRESETS = Object.freeze([
  { id: 'doc-9x16', label: 'Dọc 9:16 (TikTok/Reels)', width: 720, height: 1280, fps: 12, max_seconds: 30, synthetic: false },
  { id: 'vuong-1x1', label: 'Vuông 1:1 (Feed)', width: 900, height: 900, fps: 12, max_seconds: 30, synthetic: false },
  { id: 'ngang-16x9', label: 'Ngang 16:9 (YouTube)', width: 1280, height: 720, fps: 12, max_seconds: 30, synthetic: false },
]);

/**
 * Nạp TOÀN BỘ hàm render THẬT của tab “Video” + các hàm phụ thuộc (cũng là hàm thật).
 * @param {object} state state do `makeVsState()` dựng
 */
export function loadVsUi(state) {
  // ── Hằng số THẬT của UI ──
  const VS_STATUS_LABEL = loadUiConst('VS_STATUS_LABEL');
  const VS_STAGE_LABEL = loadUiConst('VS_STAGE_LABEL');
  const VS_STAGE_ORDER = loadUiConstValue('VS_STAGE_ORDER');
  const VS_STAGE_STEPS = loadUiConstValue('VS_STAGE_STEPS');
  const VS_NO_AUDIO_LABEL = loadUiConstValue('VS_NO_AUDIO_LABEL');
  const VS_NO_AUDIO_NOTE = loadUiConstValue('VS_NO_AUDIO_NOTE');
  const VS_FIT_NOTE = loadUiConstValue('VS_FIT_NOTE');
  const VS_TEXT_CLAIM_NOTE = loadUiConstValue('VS_TEXT_CLAIM_NOTE');
  const VS_ERROR_HINT = loadUiConst('VS_ERROR_HINT');
  const VS_SERVER_MAX_SCENES = loadUiConstValue('VS_SERVER_MAX_SCENES');
  const VS_SERVER_MAX_TEXTS = loadUiConstValue('VS_SERVER_MAX_TEXTS');
  const VS_SERVER_TEXT_MAX = loadUiConstValue('VS_SERVER_TEXT_MAX');
  const CREDIT_HONEST_NOTE = loadUiConstValue('CREDIT_HONEST_NOTE');
  const CREDIT_TOPUP_HINT = loadUiConstValue('CREDIT_TOPUP_HINT');

  // ── Hàm dùng chung của MVP-03/MVP-05 mà tab Video gọi lại ──
  const isViolationText = loadUiFunction('isViolationText', {});
  const isErrorViolations = loadUiFunction('isErrorViolations', { isViolationText });
  const fmtAmount = loadUiFunction('fmtAmount', {});
  const creditShortfall = loadUiFunction('creditShortfall', { state });
  const creditShortfallText = loadUiFunction('creditShortfallText', { creditShortfall, fmtAmount });
  const creditAlertBox = loadUiFunction('creditAlertBox', {
    esc,
    CREDIT_HONEST_NOTE,
    CREDIT_TOPUP_HINT,
  });
  const creditShortfallHtml = loadUiFunction('creditShortfallHtml', { creditAlertBox, creditShortfallText });

  // ── Đọc preset / tham số ──
  const vsPresets = loadUiFunction('vsPresets', { state });
  const vsPresetById = loadUiFunction('vsPresetById', { vsPresets });
  const vsCurrentPreset = loadUiFunction('vsCurrentPreset', { vsPresetById, vsPresets, state });
  const vsMaxSeconds = loadUiFunction('vsMaxSeconds', { vsCurrentPreset });
  const vsMaxScenes = loadUiFunction('vsMaxScenes', { state });
  const vsMaxImageBytes = loadUiFunction('vsMaxImageBytes', { state });
  const vsPresetDetail = loadUiFunction('vsPresetDetail', {});
  const vsNum = loadUiFunction('vsNum', {});
  const vsClampSeconds = loadUiFunction('vsClampSeconds', { vsMaxSeconds });
  const vsSceneSeconds = loadUiFunction('vsSceneSeconds', { vsClampSeconds });
  const vsTotalSeconds = loadUiFunction('vsTotalSeconds', { state, vsSceneSeconds });
  const vsTotalMs = loadUiFunction('vsTotalMs', { vsTotalSeconds });
  const vsHasImages = loadUiFunction('vsHasImages', { state });
  const vsCanCreate = loadUiFunction('vsCanCreate', { vsHasImages, vsCurrentPreset, state });
  const vsMoveScene = loadUiFunction('vsMoveScene', { state });
  const vsRemoveScene = loadUiFunction('vsRemoveScene', { state });
  const vsSetSceneSeconds = loadUiFunction('vsSetSceneSeconds', { state, vsClampSeconds });

  // ── Đọc dữ liệu job ──
  const vsOutputAsset = loadUiFunction('vsOutputAsset', {});
  const vsSourceAsset = loadUiFunction('vsSourceAsset', { vsOutputAsset });
  const vsAudio = loadUiFunction('vsAudio', { vsOutputAsset });
  const vsEncoder = loadUiFunction('vsEncoder', { vsOutputAsset, state });
  const vsErrorViolations = loadUiFunction('vsErrorViolations', { isErrorViolations });
  const vsTextBlockedFromError = loadUiFunction('vsTextBlockedFromError', { vsErrorViolations });
  const vsErrorText = loadUiFunction('vsErrorText', { VS_ERROR_HINT, creditShortfallText });
  const vsJobRunning = loadUiFunction('vsJobRunning', {});

  // ── Tham số gửi lên API ──
  const vsTextsForServer = loadUiFunction('vsTextsForServer', { VS_SERVER_TEXT_MAX, VS_SERVER_MAX_TEXTS });
  const vsJobOptions = loadUiFunction('vsJobOptions', {
    state,
    vsCurrentPreset,
    vsSceneSeconds,
    vsTextsForServer,
    VS_SERVER_MAX_SCENES,
    VS_SERVER_TEXT_MAX,
  });
  const vsServerSupportsManyImages = loadUiFunction('vsServerSupportsManyImages', {});
  const vsUnsentSceneIndexes = loadUiFunction('vsUnsentSceneIndexes', { vsServerSupportsManyImages });
  const vsMultiImageNotice = loadUiFunction('vsMultiImageNotice', { vsUnsentSceneIndexes, esc });
  const vsJobBody = loadUiFunction('vsJobBody', { state, vsJobOptions });

  // ── Khối render ──
  const vsProviderBadges = loadUiFunction('vsProviderBadges', { vsEncoder, vsAudio, esc, state });
  const vsMockNotice = loadUiFunction('vsMockNotice', { vsEncoder, esc, state });
  const vsPresetsNotice = loadUiFunction('vsPresetsNotice', { vsPresets, state, esc });
  const vsHeaderPanel = loadUiFunction('vsHeaderPanel', {
    state,
    vsCurrentPreset,
    esc,
    VS_FIT_NOTE,
    vsProviderBadges,
    vsPresetDetail,
    vsMockNotice,
  });
  const vsUnavailablePanel = loadUiFunction('vsUnavailablePanel', { state, esc });
  const vsErrorBox = loadUiFunction('vsErrorBox', { state, esc, vsErrorText, creditShortfallHtml });
  const vsTextBlockedPanel = loadUiFunction('vsTextBlockedPanel', { state, esc, VS_TEXT_CLAIM_NOTE });
  const vsFileErrorsHtml = loadUiFunction('vsFileErrorsHtml', { state, esc });
  const vsRenderUpload = loadUiFunction('vsRenderUpload', {
    state,
    vsMaxImageBytes,
    vsMaxScenes,
    VS_SERVER_MAX_SCENES,
    esc,
    vsServerSupportsManyImages,
    vsFileErrorsHtml,
  });
  const vsTotalHtml = loadUiFunction('vsTotalHtml', {
    state,
    vsTotalSeconds,
    vsMaxSeconds,
    vsCurrentPreset,
    esc,
    vsNum,
  });
  const vsRenderScenes = loadUiFunction('vsRenderScenes', {
    state,
    vsMaxSeconds,
    vsUnsentSceneIndexes,
    vsSceneSeconds,
    esc,
    vsNum,
    vsMultiImageNotice,
    vsTotalHtml,
  });
  const vsRenderOptions = loadUiFunction('vsRenderOptions', {
    vsPresets,
    vsCurrentPreset,
    state,
    vsJobRunning,
    vsCanCreate,
    esc,
    vsPresetDetail,
    vsPresetsNotice,
    VS_FIT_NOTE,
  });
  const vsRenderSteps = loadUiFunction('vsRenderSteps', { VS_STAGE_ORDER, VS_STAGE_STEPS, esc });
  const vsStageText = loadUiFunction('vsStageText', { VS_STAGE_LABEL, VS_STAGE_ORDER });
  const vsAudioNotice = loadUiFunction('vsAudioNotice', { vsAudio, esc, VS_NO_AUDIO_LABEL, VS_NO_AUDIO_NOTE });
  const vsRenderResult = loadUiFunction('vsRenderResult', {
    vsOutputAsset,
    vsSourceAsset,
    vsEncoder,
    esc,
    vsNum,
    vsAudioNotice,
  });
  const vsFitNotes = loadUiFunction('vsFitNotes', { state, vsCurrentPreset });
  const vsDurationNotes = loadUiFunction('vsDurationNotes', { vsTotalMs, vsMaxSeconds, state, vsNum });
  const vsSceneCountNote = loadUiFunction('vsSceneCountNote', { state });
  const vsRenderWarnings = loadUiFunction('vsRenderWarnings', {
    vsAudio,
    vsEncoder,
    vsOutputAsset,
    vsFitNotes,
    vsDurationNotes,
    vsSceneCountNote,
    vsErrorText,
    isViolationText,
    esc,
    VS_NO_AUDIO_LABEL,
    VS_NO_AUDIO_NOTE,
    VS_ERROR_HINT,
  });
  const vsRenderJob = loadUiFunction('vsRenderJob', {
    state,
    vsJobRunning,
    esc,
    VS_STATUS_LABEL,
    vsStageText,
    vsRenderSteps,
    VS_STAGE_LABEL,
    VS_ERROR_HINT,
    vsRenderResult,
    vsRenderWarnings,
    vsRenderScenes,
    vsRenderOptions,
  });
  const vsRenderBody = loadUiFunction('vsRenderBody', {
    state,
    vsHeaderPanel,
    vsUnavailablePanel,
    vsErrorBox,
    vsRenderJob,
    vsRenderUpload,
    vsRenderScenes,
    vsRenderOptions,
    vsTextBlockedPanel,
  });

  /* Khói báo "không có DOM": hàm trích ra phải chạy được với state rỗng. */
  if (typeof vsRenderBody() !== 'string') throw new Error('public/app.js: vsRenderBody không trả về chuỗi HTML.');
  if (typeof vsRenderJob() !== 'string') throw new Error('public/app.js: vsRenderJob không trả về chuỗi HTML.');

  return {
    VS_STATUS_LABEL,
    VS_STAGE_LABEL,
    VS_STAGE_ORDER,
    VS_STAGE_STEPS,
    VS_NO_AUDIO_LABEL,
    VS_NO_AUDIO_NOTE,
    VS_FIT_NOTE,
    VS_TEXT_CLAIM_NOTE,
    VS_ERROR_HINT,
    VS_SERVER_MAX_SCENES,
    VS_SERVER_MAX_TEXTS,
    VS_SERVER_TEXT_MAX,
    isViolationText,
    isErrorViolations,
    fmtAmount,
    creditShortfall,
    creditShortfallText,
    creditShortfallHtml,
    vsPresets,
    vsPresetById,
    vsCurrentPreset,
    vsMaxSeconds,
    vsMaxScenes,
    vsMaxImageBytes,
    vsPresetDetail,
    vsNum,
    vsClampSeconds,
    vsSceneSeconds,
    vsTotalSeconds,
    vsTotalMs,
    vsHasImages,
    vsCanCreate,
    vsMoveScene,
    vsRemoveScene,
    vsSetSceneSeconds,
    vsOutputAsset,
    vsSourceAsset,
    vsAudio,
    vsEncoder,
    vsErrorViolations,
    vsTextBlockedFromError,
    vsErrorText,
    vsJobRunning,
    vsTextsForServer,
    vsJobOptions,
    vsServerSupportsManyImages,
    vsUnsentSceneIndexes,
    vsMultiImageNotice,
    vsJobBody,
    vsProviderBadges,
    vsMockNotice,
    vsPresetsNotice,
    vsHeaderPanel,
    vsUnavailablePanel,
    vsErrorBox,
    vsTextBlockedPanel,
    vsFileErrorsHtml,
    vsRenderUpload,
    vsTotalHtml,
    vsRenderScenes,
    vsRenderOptions,
    vsRenderSteps,
    vsStageText,
    vsAudioNotice,
    vsRenderResult,
    vsFitNotes,
    vsDurationNotes,
    vsSceneCountNote,
    vsRenderWarnings,
    vsRenderJob,
    vsRenderBody,
  };
}

export { esc };
