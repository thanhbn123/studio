/**
 * C2 — Bảng duyệt: áp chỉnh sửa của người dùng lên từng dòng.
 *
 * Luật số 3 của hợp đồng: nhãn hiệu / chứng nhận / giá KHÔNG BAO GIỜ bị dịch — chỉ người dùng
 * mới được override (`allowBrandOverride === true`), và override PHẢI để lại vết.
 *
 * Dòng do người dùng sửa vẫn phải chạy lại `enforceTranslationGuardrails`: người dùng gõ
 * "Bảo hành 12 tháng" vào một vùng không hề nói điều đó thì hệ thống vẫn phải cảnh báo.
 */

import { MAX_LINE_CHARS, PROVENANCE, TRANSLATE_STATUS } from './lines.js';
import { enforceTranslationGuardrails } from './guardrails.js';

const VALID_ACTIONS = Object.freeze(['accept', 'edit', 'skip']);

const PROTECTED_LABELS = Object.freeze({
  brand: 'nhãn hiệu',
  certification: 'chứng nhận',
  price: 'giá',
});

/** Suy ra loại vùng được bảo vệ của một dòng (theo `kind` nếu có, không thì theo `status`). */
export function protectedKindOf(line) {
  const kind = String(line?.kind ?? '').toLowerCase();
  if (PROTECTED_LABELS[kind]) return kind;
  if (line?.status === TRANSLATE_STATUS.SKIPPED_BRAND) return 'brand';
  if (line?.status === TRANSLATE_STATUS.SKIPPED_CERTIFICATION) return 'certification';
  if (line?.status === TRANSLATE_STATUS.SKIPPED_PRICE) return 'price';
  return null;
}

function reasonForReject({ regionId, reason }) {
  return { region_id: regionId, reason };
}

/**
 * Áp danh sách chỉnh sửa của người duyệt lên các dòng đã dịch.
 *
 * @param {Array} lines TranslatedLine[]
 * @param {Array} edits [{region_id, text_vi, action: 'accept'|'edit'|'skip'}]
 * @param {{allowBrandOverride?: boolean, now?: () => Date}} [options]
 * @returns {{lines: Array, rejected: Array<{region_id:string, reason:string}>, warnings: string[]}}
 */
export function applyReviewEdits(lines, edits, { allowBrandOverride = false, now } = {}) {
  const clock = typeof now === 'function' ? now : () => new Date();
  const warnings = [];
  const rejected = [];

  if (!Array.isArray(lines)) {
    warnings.push('Danh sách dòng không hợp lệ — không có gì để duyệt.');
    return { lines: [], rejected, warnings };
  }

  const outLines = lines.map((line) => ({ ...(line || {}) }));
  const indexByRegion = new Map();
  outLines.forEach((line, idx) => {
    const key = line.region_id === undefined || line.region_id === null ? '' : String(line.region_id);
    if (key && !indexByRegion.has(key)) indexByRegion.set(key, idx);
  });

  if (!Array.isArray(edits)) {
    if (edits !== undefined && edits !== null) warnings.push('Danh sách chỉnh sửa không hợp lệ — bỏ qua toàn bộ.');
    return { lines: outLines, rejected, warnings };
  }

  let applied = 0;
  let skipped = 0;

  for (const raw of edits) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      rejected.push(reasonForReject({ regionId: '', reason: 'Chỉnh sửa không hợp lệ (không phải object).' }));
      continue;
    }

    const regionId = raw.region_id === undefined || raw.region_id === null ? '' : String(raw.region_id).trim();
    if (!regionId) {
      rejected.push(reasonForReject({ regionId: '', reason: 'Thiếu region_id.' }));
      continue;
    }

    const idx = indexByRegion.get(regionId);
    if (idx === undefined) {
      rejected.push(
        reasonForReject({ regionId, reason: `Không tìm thấy dòng nào có region_id = “${regionId}”.` }),
      );
      continue;
    }

    const action = String(raw.action ?? 'accept').trim().toLowerCase();
    if (!VALID_ACTIONS.includes(action)) {
      rejected.push(
        reasonForReject({
          regionId,
          reason: `action không hợp lệ (“${raw.action}”) — chỉ nhận accept | edit | skip.`,
        }),
      );
      continue;
    }

    const textVi = raw.text_vi === undefined || raw.text_vi === null ? '' : String(raw.text_vi);
    if (textVi.length > MAX_LINE_CHARS) {
      rejected.push(
        reasonForReject({
          regionId,
          reason: `Chữ Việt quá dài (${textVi.length} > ${MAX_LINE_CHARS} ký tự) — không áp dụng.`,
        }),
      );
      continue;
    }

    const line = outLines[idx];
    const protectedKind = protectedKindOf(line);

    // `accept` không đổi nội dung ⇒ không cần override, kể cả với vùng bị bảo vệ.
    if (action !== 'accept' && protectedKind && allowBrandOverride !== true) {
      rejected.push(
        reasonForReject({
          regionId,
          reason: `Vùng “${regionId}” là ${PROTECTED_LABELS[protectedKind]} — không được sửa/dịch khi chưa bật allow_brand_override.`,
        }),
      );
      continue;
    }

    if (action === 'accept') {
      if (textVi && textVi !== String(line.text_vi ?? '')) {
        warnings.push(
          `Bỏ qua text_vi gửi kèm action=accept cho “${regionId}” (muốn sửa thì dùng action=edit).`,
        );
      }
      if (Array.isArray(line.violations) && line.violations.length > 0) {
        warnings.push(`Dòng “${regionId}” vẫn còn vi phạm guardrail — giữ NEEDS_REVIEW để người duyệt xử lý.`);
      }
      continue;
    }

    if (action === 'skip') {
      // F-06 (sau phản biện): bỏ qua là quyết định CỦA NGƯỜI DÙNG ⇒ trạng thái riêng
      // `SKIPPED_BY_USER`, không phải `NEEDS_REVIEW` (guardrail chặn). Nhờ vậy dòng này
      // KHÔNG chặn cổng render 409, nhưng vẫn vào `skipped` khi render kèm lý do rõ ràng.
      const iso = clock().toISOString();
      const guarded = enforceTranslationGuardrails(
        {
          ...line,
          text_vi: '',
          status: TRANSLATE_STATUS.SKIPPED_BY_USER,
          provenance: PROVENANCE.USER,
          edited_by_user: true,
          edited_at: iso,
          notes: 'Người dùng chủ động bỏ qua dòng này — sẽ không render chữ Việt vào vùng (có ghi vết).',
          violations: [],
        },
        { region: raw.region ?? line.region },
      );
      outLines[idx] = { ...guarded.line, status: TRANSLATE_STATUS.SKIPPED_BY_USER };
      applied += 1;
      skipped += 1;
      continue;
    }

    // action === 'edit'
    const trimmed = textVi.trim();
    const iso = clock().toISOString();
    const notes = protectedKind
      ? `Người dùng GHI ĐÈ vùng ${PROTECTED_LABELS[protectedKind]} và sửa chữ Việt (allowBrandOverride = true).`
      : 'Người dùng sửa chữ Việt trong bảng duyệt.';
    const guarded = enforceTranslationGuardrails(
      {
        ...line,
        text_vi: trimmed,
        status: TRANSLATE_STATUS.USER_EDITED,
        provenance: PROVENANCE.USER,
        edited_by_user: true,
        edited_at: iso,
        notes,
        violations: [],
      },
      { region: raw.region ?? line.region },
    );
    outLines[idx] = guarded.line;
    applied += 1;

    if (protectedKind) {
      warnings.push(`Đã ghi đè vùng ${PROTECTED_LABELS[protectedKind]} “${regionId}” theo yêu cầu người dùng (có lưu vết).`);
    }
    if (guarded.violations.length > 0) {
      warnings.push(
        `Dòng “${regionId}” sau khi sửa vẫn vi phạm guardrail (${guarded.violations.length} lỗi) — chuyển NEEDS_REVIEW.`,
      );
    }
  }

  if (applied > 0) warnings.push(`Đã áp ${applied} chỉnh sửa${skipped > 0 ? ` (trong đó ${skipped} dòng bị bỏ qua)` : ''}.`);
  if (rejected.length > 0) warnings.push(`${rejected.length} chỉnh sửa bị từ chối — xem danh sách rejected.`);

  return { lines: outLines, rejected, warnings };
}

export default applyReviewEdits;
