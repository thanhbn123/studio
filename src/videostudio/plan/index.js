/**
 * V1 — KỊCH BẢN VIDEO (`src/videostudio/plan/**`, hợp đồng MVP-04 §2.1).
 *
 * Cổng vào DUY NHẤT của tầng này. Hợp đồng đóng băng — export đúng những tên sau:
 *   VIDEO_PRESETS, VideoError, buildVideoPlan, planFrameCount, TRANSITIONS, MOTIONS, FIT_MODES
 *
 * Export thêm (tiện cho V2/V3/V4/V5 và test, KHÔNG thay thế tên nào ở trên):
 *   VIDEO_CODES, VIDEO_AUDIO_WARNING, findPreset, collectClaimViolations, hasClaimViolations,
 *   resolveEvidenceText, clientEvidenceKeysIn, CLAIM_VIOLATION_RULES, EVIDENCE_TEXT_KEYS,
 *   CLIENT_EVIDENCE_KEYS, fitImageInFrame, normalizeSceneTexts, readTextValue, TEXT_ALIGNS,
 *   TEXT_ANIMATIONS, DEFAULT_TEXT_COLOR.
 *
 * Ba luật riêng của MVP-04 được giữ NGAY Ở TẦNG NÀY:
 *  1. **Không bóp méo ảnh**: `fit` chỉ có `pad`/`crop`, `fit_box` do `fitImageInFrame` tính bằng
 *     MỘT hệ số phóng cho cả hai trục; `fit` lạ ⇒ `BAD_FIT` (không đoán, không kéo giãn).
 *  2. **Không có tiếng thì phải NÓI RÕ**: mọi plan đều mở đầu `warnings` bằng `VIDEO_AUDIO_WARNING`
 *     và mang `audio = null` (thuộc tính KHÔNG đếm được khi duyệt khoá/serialize, để giữ nguyên
 *     hình dạng `VideoPlan` đã đóng băng của hợp đồng).
 *  3. **Chống bịa**: `collectClaimViolations` là phần *chuẩn bị*; nếu người gọi truyền
 *     `options.evidence` (bằng chứng do SERVER gom từ dữ liệu đã lưu — KHÔNG phải từ request)
 *     thì mọi câu chữ vi phạm bị chặn: mặc định NÉM `VIDEO_TEXT_UNSUPPORTED_CLAIM`
 *     (V3/V4 map thành 422), hoặc bỏ chữ + cảnh báo nếu `options.strict_claims === false`.
 *
 * Hàm THUẦN: không I/O, không mạng, không đọc file.
 */

import { strictCoordinate } from '../../imagelab/geometry.js';
import { VideoError, VIDEO_CODES } from './errors.js';
import {
  DEFAULT_FADE_MS,
  DEFAULT_MIN_MS,
  DEFAULT_PAD_COLOR,
  DEFAULT_SCENE_MS,
  FIT_MODES,
  MOTIONS,
  TRANSITIONS,
  VIDEO_PRESETS,
  findPreset,
} from './presets.js';
import { fitImageInFrame, isHexColor, normalizeHexColor } from './fit.js';
import { normalizeSceneTexts, readTextValue } from './texts.js';
import { collectClaimViolations } from './claims.js';

export { VideoError, VIDEO_CODES } from './errors.js';
export {
  VIDEO_PRESETS,
  TRANSITIONS,
  MOTIONS,
  FIT_MODES,
  findPreset,
  DEFAULT_MIN_MS,
  DEFAULT_SCENE_MS,
  DEFAULT_FADE_MS,
  DEFAULT_PAD_COLOR,
} from './presets.js';
export { fitImageInFrame, normalizeHexColor, isHexColor } from './fit.js';
export {
  normalizeSceneTexts,
  readTextValue,
  TEXT_ALIGNS,
  TEXT_ANIMATIONS,
  DEFAULT_TEXT_COLOR,
} from './texts.js';
export {
  collectClaimViolations,
  hasClaimViolations,
  resolveEvidenceText,
  clientEvidenceKeysIn,
  CLAIM_VIOLATION_RULES,
  EVIDENCE_TEXT_KEYS,
  CLIENT_EVIDENCE_KEYS,
} from './claims.js';

/**
 * Lời cảnh báo BẮT BUỘC của MVP-04 phần offline (§0 luật 2): GIF/chuỗi khung không có tiếng.
 * V3/V4/V5 dùng đúng chuỗi này để UI không giấu sự thật.
 */
export const VIDEO_AUDIO_WARNING =
  'Video KHÔNG có tiếng: bản offline (GIF/chuỗi khung) không sinh âm thanh — video không có tiếng, không phải bản hoàn chỉnh để đăng ngay.';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Bỏ cảnh báo trùng nhưng giữ nguyên thứ tự xuất hiện. */
function dedupeWarnings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || item === '' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Đọc kích thước ảnh nguồn của một cảnh — thiếu/không hợp lệ ⇒ `BAD_SOURCE` (fail-closed). */
function readSceneSource(scene, index) {
  const source = scene.source && typeof scene.source === 'object' ? scene.source : {};
  const image = scene.image && typeof scene.image === 'object' ? scene.image : {};
  const width = strictCoordinate(
    source.width ?? source.w ?? scene.source_width ?? scene.width ?? image.width,
  );
  const height = strictCoordinate(
    source.height ?? source.h ?? scene.source_height ?? scene.height ?? image.height,
  );
  if (width === null || height === null || !(width > 0) || !(height > 0)) {
    throw new VideoError(
      VIDEO_CODES.BAD_SOURCE,
      `Cảnh #${index}: thiếu kích thước ảnh nguồn (source.width/source.height) — không tính được khung ghép.`,
      { index, source: { width: width ?? null, height: height ?? null } },
    );
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/**
 * Chế độ ghép ảnh: chỉ `pad`/`crop`. Giá trị lạ ⇒ `BAD_FIT` — vì đoán sai ở đây là BÓP MÉO ảnh.
 */
function resolveFit(value, index) {
  if (value === undefined || value === null || value === '') return 'pad';
  const fit = String(value).trim().toLowerCase();
  if (FIT_MODES.includes(fit)) return fit;
  throw new VideoError(
    VIDEO_CODES.BAD_FIT,
    `Cảnh #${index}: chế độ ghép ảnh “${String(value)}” không hợp lệ — chỉ nhận ${FIT_MODES.join('/')} (KHÔNG bao giờ kéo giãn ảnh).`,
    { index, fit: value, available: [...FIT_MODES] },
  );
}

/** Hiệu ứng chuyển động: giá trị lạ ⇒ `none` + cảnh báo (bỏ hiệu ứng an toàn hơn đoán). */
function resolveMotion(value, index, warnings) {
  if (value === undefined || value === null || value === '') return 'none';
  const motion = String(value).trim().toLowerCase();
  if (MOTIONS.includes(motion)) return motion;
  warnings.push(`Cảnh #${index}: hiệu ứng “${String(value)}” không có trong danh mục — dùng “none”.`);
  return 'none';
}

/** Chuyển cảnh vào: giá trị lạ ⇒ `cut` + cảnh báo. */
function resolveTransition(value, index, warnings) {
  if (value === undefined || value === null || value === '') return 'cut';
  const transition = String(value).trim().toLowerCase();
  if (TRANSITIONS.includes(transition)) return transition;
  warnings.push(`Cảnh #${index}: chuyển cảnh “${String(value)}” không hợp lệ — dùng “cut”.`);
  return 'cut';
}

/** Màu viền: chỉ nhận `#RRGGBB`; giá trị lạ ⇒ màu mặc định + cảnh báo. */
function resolvePadColor(value, index, warnings) {
  if (value === undefined || value === null || value === '') return DEFAULT_PAD_COLOR;
  const color = normalizeHexColor(value, DEFAULT_PAD_COLOR);
  if (!isHexColor(value)) {
    warnings.push(`Cảnh #${index}: màu viền “${String(value)}” không phải #RRGGBB — dùng ${DEFAULT_PAD_COLOR}.`);
  }
  return color;
}

/**
 * Thời lượng một cảnh: làm tròn về ms, kẹp trong `[min_ms, preset.max_seconds*1000]`.
 * Sàn hiệu dụng luôn ≥ 1 khung để cảnh không biến mất khỏi video.
 */
function readSceneDuration(scene, index, { defaultMs, minMs, maxMs, fps, warnings }) {
  const oneFrameMs = Math.ceil(1000 / fps);
  const raw = strictCoordinate(scene.duration_ms ?? scene.duration ?? scene.ms);
  let duration = raw === null ? defaultMs : Math.round(raw);
  if (raw === null) {
    warnings.push(`Cảnh #${index}: thiếu thời lượng hợp lệ — dùng mặc định ${defaultMs}ms.`);
  }
  const sceneMin = strictCoordinate(scene.min_ms);
  const low = Math.max(
    1,
    oneFrameMs,
    Math.min(maxMs, sceneMin !== null && sceneMin > 0 ? Math.round(sceneMin) : Math.max(0, Math.round(minMs))),
  );
  if (duration < low) {
    warnings.push(`Cảnh #${index}: thời lượng ${duration}ms dưới sàn ${low}ms — nâng lên ${low}ms.`);
    duration = low;
  }
  if (duration > maxMs) {
    warnings.push(`Cảnh #${index}: thời lượng ${duration}ms vượt trần một cảnh ${maxMs}ms — kẹp còn ${maxMs}ms.`);
    duration = maxMs;
  }
  return duration;
}

/**
 * Lọc chữ thiếu bằng chứng (luật 3). Chỉ chạy khi người gọi ĐÃ truyền bằng chứng của server.
 * @returns {Array} danh sách chữ được phép giữ (nguyên bản, chưa chuẩn hoá)
 */
function filterUnsupportedTexts(rawTexts, { sceneIndex, evidence, strictClaims, warnings }) {
  if (rawTexts === undefined || rawTexts === null) return [];
  const list = Array.isArray(rawTexts) ? rawTexts : [rawTexts];
  const kept = [];
  for (const item of list) {
    const text = readTextValue(item);
    if (text.trim() === '') {
      kept.push(item); // để `normalizeSceneTexts` báo "chữ rỗng" và bỏ
      continue;
    }
    const violations = collectClaimViolations(text, { evidence });
    if (violations.length === 0) {
      kept.push(item);
      continue;
    }
    if (strictClaims) {
      throw new VideoError(
        VIDEO_CODES.VIDEO_TEXT_UNSUPPORTED_CLAIM,
        `Cảnh #${sceneIndex}: chữ “${text}” chưa có bằng chứng trong dữ liệu đã lưu — KHÔNG vẽ (mục 0 luật 3).`,
        { scene: sceneIndex, text, violations },
      );
    }
    warnings.push(
      `Cảnh #${sceneIndex}: bỏ chữ “${text}” vì thiếu bằng chứng (${violations
        .map((violation) => violation.message)
        .join(' | ')}) — không vẽ trên video.`,
    );
  }
  return kept;
}

/**
 * Dựng `VideoPlan` từ danh sách cảnh.
 *
 * @param {object} params
 * @param {Array<object>} params.scenes mỗi cảnh: `{ asset_id?, source:{width,height}, duration_ms?,
 *        min_ms?, fit?, pad_color?, transition_in?, transition_ms?, motion?, texts? }`
 * @param {string|{id:string}} params.preset id preset (hoặc `{ id }`) — chỉ tra theo id
 * @param {object} [params.options]
 *        `fit`, `pad_color`, `motion`, `transition_in`, `default_duration_ms`, `min_ms`,
 *        `texts` (chữ dùng chung cho cảnh không tự khai), `evidence` (BẰNG CHỨNG DO SERVER GOM —
 *        có mặt khoá này là bật kiểm chống bịa), `guard_claims`, `strict_claims` (mặc định true).
 * @returns {object} `VideoPlan` đúng field của hợp đồng §2.1
 */
export function buildVideoPlan({ scenes, preset, options } = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const warnings = [VIDEO_AUDIO_WARNING];

  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new VideoError(VIDEO_CODES.NO_SCENES, 'Video cần ít nhất MỘT cảnh — `scenes` đang rỗng.', {
      received: Array.isArray(scenes) ? 0 : typeof scenes,
    });
  }

  const presetObj = findPreset(preset);
  if (!presetObj) {
    throw new VideoError(
      VIDEO_CODES.UNKNOWN_PRESET,
      `Preset “${preset === undefined || preset === null ? 'undefined' : String(preset)}” không có trong danh mục — không đoán tỉ lệ khung.`,
      {
        preset: preset && typeof preset === 'object' ? preset.id ?? null : preset ?? null,
        available: VIDEO_PRESETS.map((item) => item.id),
      },
    );
  }

  const { width, height, fps, max_seconds: maxSeconds } = presetObj;
  const maxSceneMs = maxSeconds * 1000;
  const defaultMs = Math.max(1, Math.round(strictCoordinate(opts.default_duration_ms) ?? DEFAULT_SCENE_MS));
  const minMs = Math.max(1, Math.round(strictCoordinate(opts.min_ms) ?? DEFAULT_MIN_MS));
  const globalFit = opts.fit; // fit của cảnh thắng fit chung

  // ── Chống bịa: bằng chứng CHỈ nhận từ tham số do server truyền ───────────────────────────
  const hasEvidence = Object.prototype.hasOwnProperty.call(opts, 'evidence');
  const guardClaims = hasEvidence || opts.guard_claims === true;
  const strictClaims = opts.strict_claims !== false;
  if (!guardClaims) {
    warnings.push(
      'Chưa có bằng chứng đã lưu (`options.evidence`) nên CHƯA kiểm chống bịa cho chữ trên video — pipeline PHẢI gọi `collectClaimViolations` trước khi vẽ (mục 0 luật 3).',
    );
  }
  const evidence = hasEvidence ? opts.evidence : undefined;

  // ── Bước 1: đọc từng cảnh (chưa cắt trần, chưa tính khung) ───────────────────────────────
  const prepared = [];
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index] && typeof scenes[index] === 'object' ? scenes[index] : {};
    const source = readSceneSource(scene, index);
    const fit = resolveFit(scene.fit ?? globalFit, index);
    const padColor = resolvePadColor(scene.pad_color ?? opts.pad_color, index, warnings);
    const geom = fitImageInFrame({
      source_width: source.width,
      source_height: source.height,
      width,
      height,
      fit,
    });
    // Nói RÕ ảnh bị pad hay crop (V5 hiển thị mọi cảnh báo, §2.5).
    if (fit === 'pad' && (geom.fit_box.w < width || geom.fit_box.h < height)) {
      warnings.push(
        `Cảnh #${index}: ảnh ${source.width}×${source.height} được pad (thêm viền ${padColor}) vào khung ${width}×${height} — không kéo giãn.`,
      );
    } else if (fit === 'crop' && Math.abs(source.width / source.height - width / height) > 1e-9) {
      warnings.push(
        `Cảnh #${index}: ảnh ${source.width}×${source.height} được crop (cắt bớt) để phủ kín khung ${width}×${height} — không kéo giãn.`,
      );
    }
    const assetId = scene.asset_id ?? scene.assetId ?? null;
    const durationMs = readSceneDuration(scene, index, {
      defaultMs,
      minMs,
      maxMs: maxSceneMs,
      fps,
      warnings,
    });
    const rawTexts =
      scene.texts !== undefined ? scene.texts : scene.text !== undefined ? [scene.text] : opts.texts;
    const texts = guardClaims
      ? filterUnsupportedTexts(rawTexts, { sceneIndex: index, evidence, strictClaims, warnings })
      : rawTexts;
    prepared.push({
      index,
      asset_id: assetId === null || assetId === undefined ? null : String(assetId),
      source,
      fit,
      geom,
      pad_color: padColor,
      transition_in: resolveTransition(scene.transition_in ?? opts.transition_in, index, warnings),
      transition_ms: strictCoordinate(scene.transition_ms ?? opts.transition_ms),
      motion: resolveMotion(scene.motion ?? opts.motion, index, warnings),
      min_ms: (() => {
        const sceneMin = strictCoordinate(scene.min_ms);
        return sceneMin !== null && sceneMin > 0 ? Math.round(sceneMin) : minMs;
      })(),
      duration_ms: durationMs,
      raw_texts: texts,
    });
  }

  // ── Bước 2: CẮT cho vừa trần thời lượng (không bao giờ vượt trần) ────────────────────────
  const requestedMs = prepared.reduce((sum, item) => sum + item.duration_ms, 0);
  let kept = prepared;
  if (requestedMs > maxSceneMs) {
    const cutMs = requestedMs - maxSceneMs;
    let budget = maxSceneMs;
    let dropped = 0;
    let trimmedFrom = null;
    kept = [];
    for (const item of prepared) {
      if (budget <= 0) {
        dropped += 1;
        continue;
      }
      if (item.duration_ms <= budget) {
        budget -= item.duration_ms;
        kept.push(item);
        continue;
      }
      const floorMs = Math.max(1, Math.ceil(1000 / fps), Math.min(item.duration_ms, item.min_ms));
      if (budget >= floorMs) {
        trimmedFrom = { index: item.index, from: item.duration_ms, to: budget };
        kept.push({ ...item, duration_ms: budget });
        budget = 0;
      } else {
        dropped += 1;
      }
    }
    if (kept.length === 0) {
      // Không cảnh nào vừa ngân sách (trần quá nhỏ so với sàn) — giữ ĐÚNG một cảnh ở mức trần.
      kept = [{ ...prepared[0], duration_ms: Math.max(1, maxSceneMs) }];
      dropped = prepared.length - 1;
      trimmedFrom = { index: prepared[0].index, from: prepared[0].duration_ms, to: maxSceneMs };
    }
    const detail =
      trimmedFrom && dropped === 0
        ? `cảnh #${trimmedFrom.index} rút ${trimmedFrom.from}ms → ${trimmedFrom.to}ms`
        : dropped > 0
          ? `bỏ ${dropped} cảnh cuối${trimmedFrom ? `, cảnh #${trimmedFrom.index} rút ${trimmedFrom.from}ms → ${trimmedFrom.to}ms` : ''}`
          : 'rút ngắn các cảnh cuối';
    warnings.push(
      `Tổng thời lượng yêu cầu ${requestedMs}ms vượt trần ${maxSceneMs}ms của preset “${presetObj.id}” — đã cắt ${cutMs}ms (${detail}). Video không bao giờ dài quá trần.`,
    );
  }

  // ── Bước 3: số khung — làm tròn theo MỐC TÍCH LUỸ để tổng khung luôn khớp thời lượng ─────
  const durations = kept.map((item) => item.duration_ms);
  const frames = [];
  let cumulativeMs = 0;
  let cumulativeFrames = 0;
  for (const duration of durations) {
    cumulativeMs += duration;
    const upto = Math.round((cumulativeMs / 1000) * fps);
    frames.push(upto - cumulativeFrames);
    cumulativeFrames = upto;
  }
  const durationMs = cumulativeMs; // == sum(scenes[].duration_ms)
  const frameCount = cumulativeFrames; // == round(duration_ms/1000*fps) và == sum(scenes[].frames)

  const mismatched = [];
  durations.forEach((duration, i) => {
    const expected = Math.round((duration / 1000) * fps);
    if (frames[i] !== expected) mismatched.push(`#${kept[i].index} (${frames[i]} ≠ ${expected})`);
  });
  if (mismatched.length > 0) {
    warnings.push(
      `Làm tròn khung theo mốc tích luỹ để tổng khung khớp thời lượng: cảnh ${mismatched.join(', ')} lệch ±1 khung so với làm tròn riêng lẻ.`,
    );
  }

  // ── Bước 4: dựng cảnh cuối cùng (chữ kẹp theo thời lượng THẬT sau khi cắt) ──────────────
  const outScenes = [];
  let startMs = 0;
  for (let i = 0; i < kept.length; i += 1) {
    const item = kept[i];
    const sceneDuration = durations[i];
    const transitionIn = item.transition_in;
    let transitionMs = 0;
    if (transitionIn === 'fade') {
      const requested = item.transition_ms;
      transitionMs = clamp(
        requested === null ? DEFAULT_FADE_MS : Math.round(requested),
        1,
        sceneDuration,
      );
    }
    const texts = normalizeSceneTexts({
      texts: item.raw_texts,
      width,
      height,
      duration_ms: sceneDuration,
      scene_index: item.index,
      warnings,
    });
    outScenes.push({
      index: i,
      start_ms: startMs,
      end_ms: startMs + sceneDuration,
      frames: frames[i],
      duration_ms: sceneDuration,
      asset_id: item.asset_id,
      source: { width: item.source.width, height: item.source.height },
      fit: item.fit,
      fit_box: { ...item.geom.fit_box },
      pad_color: item.pad_color,
      transition_in: transitionIn,
      transition_ms: transitionMs,
      motion: item.motion,
      texts,
    });
    startMs += sceneDuration;
  }

  const plan = {
    preset_id: presetObj.id,
    width,
    height,
    fps,
    frame_count: frameCount,
    duration_ms: durationMs,
    loop: 0,
    scenes: outScenes,
    warnings: dedupeWarnings(warnings),
    synthetic: false,
  };
  // §0 luật 2: mọi kết quả MVP-04 mang `audio: null`. Field này KHÔNG được đếm khi duyệt khoá /
  // serialize để giữ nguyên hình dạng `VideoPlan` đã đóng băng ở §2.1 (V3 ghi `meta.audio = null`).
  Object.defineProperty(plan, 'audio', { value: null, enumerable: false, writable: true, configurable: true });
  return plan;
}

/**
 * Số khung của một plan — dùng để ghi usage (`VIDEO_RENDER`, `VIDEO_ENCODE`).
 * Fail-closed: plan hỏng (thiếu/khung không phải số, tổng khung các cảnh lệch `frame_count`) ⇒ `BAD_PLAN`.
 *
 * @param {object} plan `VideoPlan`
 * @returns {number}
 */
export function planFrameCount(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new VideoError(VIDEO_CODES.BAD_PLAN, '`planFrameCount` cần một VideoPlan — nhận được giá trị không phải đối tượng.', {
      received: plan === null ? 'null' : typeof plan,
    });
  }

  const rawFrames = strictCoordinate(plan.frame_count);
  let frameCount = rawFrames !== null && rawFrames >= 0 ? Math.round(rawFrames) : null;
  if (frameCount === null) {
    // Plan cũ/thiếu field: suy từ `duration_ms` × `fps` nếu có đủ — KHÔNG bịa số khác.
    const durationMs = strictCoordinate(plan.duration_ms);
    const fps = strictCoordinate(plan.fps);
    if (durationMs !== null && durationMs >= 0 && fps !== null && fps > 0) {
      frameCount = Math.round((durationMs / 1000) * fps);
    }
  }
  if (frameCount === null || !Number.isFinite(frameCount) || frameCount < 0) {
    throw new VideoError(
      VIDEO_CODES.BAD_PLAN,
      'Plan thiếu `frame_count` hợp lệ và cũng không suy được từ `duration_ms` × `fps` — không ghi usage bằng số đoán.',
      { frame_count: plan.frame_count ?? null, duration_ms: plan.duration_ms ?? null, fps: plan.fps ?? null },
    );
  }

  if (Array.isArray(plan.scenes) && plan.scenes.length > 0) {
    let sum = 0;
    let complete = true;
    for (const scene of plan.scenes) {
      const value = strictCoordinate(scene?.frames);
      if (value === null || value < 0) {
        complete = false;
        break;
      }
      sum += Math.round(value);
    }
    if (complete && sum !== frameCount) {
      throw new VideoError(
        VIDEO_CODES.BAD_PLAN,
        `Plan hỏng: tổng khung của scenes (${sum}) ≠ frame_count (${frameCount}) — không ghi usage bằng số lệch.`,
        { frame_count: frameCount, scenes_frames: sum },
      );
    }
  }

  return frameCount;
}

export default buildVideoPlan;
