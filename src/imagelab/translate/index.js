/**
 * C2 — DỊCH & DUYỆT (MVP-02).
 *
 * Hợp đồng: `docs/MVP-02-CONTRACT.md` §4.2. File này là mặt tiền duy nhất mà C4/C5 được import:
 *
 *   Translator                    — provider dịch (mock | ai | none)
 *   createTranslator(config, …)   — dựng Translator từ config.translate (kế thừa config.ai)
 *   applyReviewEdits(…)           — bảng duyệt: accept | edit | skip
 *   enforceTranslationGuardrails(…)— 4 luật guardrail, vi phạm ⇒ NEEDS_REVIEW
 *   GLOSSARY / NEVER_TRANSLATE    — từ điển thuật ngữ + mẫu chữ cấm dịch
 *
 * NĂM LUẬT ĐƯỢC GIỮ Ở ĐÂY:
 *   1. Không bịa: mọi chữ Việt đều truy được về AI, từ điển, hoặc người dùng (`provenance`);
 *      provider mock tự khai `is_mock = true`.
 *   2. (không thuộc phạm vi C2 — ảnh gốc do C3/C4 giữ)
 *   3. Vùng `translatable === false` KHÔNG BAO GIỜ được gọi AI: trả thẳng SKIPPED_* với `text_vi = ''`.
 *   4. Fail-closed: thiếu provider ⇒ NOT_CONFIGURED; lỗi provider ⇒ FAILED + error_code (không ném ra ngoài).
 *   5. Không thêm dependency; comment tiếng Việt, định danh tiếng Anh.
 */

import { createProvider } from '../../ai/provider.js';
import { redact } from '../../logger.js';
import { classifyForbiddenText, GLOSSARY, NEVER_TRANSLATE } from './glossary.js';
import { buildDictionary, normalizeGlossaryExtra, translateWithDictionary } from './dictionary.js';
import { translateWithProvider } from './ai.js';
import { enforceTranslationGuardrails } from './guardrails.js';
import { applyReviewEdits } from './review.js';
import {
  clampConfidence,
  createFailedLine,
  createLine,
  createSkippedLine,
  LINE_FIELDS,
  MAX_LINE_CHARS,
  PROVENANCE,
  RENDERABLE_STATUSES,
  SKIP_REASONS,
  SKIPPED_STATUSES,
  TRANSLATE_STATUS,
  TRANSLATE_STATUS_LIST,
} from './lines.js';

export {
  applyReviewEdits,
  clampConfidence,
  enforceTranslationGuardrails,
  GLOSSARY,
  LINE_FIELDS,
  MAX_LINE_CHARS,
  NEVER_TRANSLATE,
  PROVENANCE,
  RENDERABLE_STATUSES,
  SKIP_REASONS,
  SKIPPED_STATUSES,
  TRANSLATE_STATUS,
  TRANSLATE_STATUS_LIST,
};

/** Trạng thái cấp kết quả (đóng băng theo §4.2). */
export const TRANSLATE_RESULT_STATUS = Object.freeze({
  OK: 'OK',
  NO_LINES: 'NO_LINES',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  FAILED: 'FAILED',
});

/** Các loại vùng TUYỆT ĐỐI không được dịch (luật số 3). */
const PROTECTED_KINDS = Object.freeze(['brand', 'certification', 'price', 'unknown']);

/** Độ tin cậy ước lượng cho bản dịch AI không kèm confidence (có ghi rõ trong tài liệu). */
const AI_DEFAULT_CONFIDENCE = 0.7;

function kindOf(region) {
  const k = String(region?.kind ?? '').toLowerCase();
  return PROTECTED_KINDS.includes(k) ? k : 'unknown';
}

/**
 * Vùng này có được phép dịch không? Fail-closed:
 * loại đã biết là nhãn hiệu/chứng nhận/giá/không rõ ⇒ KHÔNG, bất kể cờ `translatable`.
 */
function isTranslatableRegion(region) {
  const kind = String(region?.kind ?? '').toLowerCase();
  if (PROTECTED_KINDS.includes(kind)) return false;
  if (typeof region?.translatable === 'boolean') return region.translatable;
  return kind === 'descriptive' || kind === '';
}

function regionIdOf(region, index) {
  const id = region?.id ?? region?.region_id;
  if (id === undefined || id === null || id === '') return `r${index + 1}`;
  return String(id);
}

/** Bỏ khoảng trắng + dấu câu hai đầu để so khớp nguyên cụm với từ điển. */
function normalizeForLookup(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/^[，。、；：！？·\-—]+|[，。、；：！？·\-—]+$/g, '');
}

/**
 * Khớp CHÍNH XÁC một mục từ điển (glossary_extra của người dùng được ưu tiên hơn GLOSSARY).
 * Chỉ dùng để cứu vùng mà provider bỏ sót — không dùng để đoán cả câu.
 */
function exactGlossaryMatch(text, glossaryExtra) {
  const key = normalizeForLookup(text);
  if (!key) return null;
  for (const [zh, vi] of normalizeGlossaryExtra(glossaryExtra)) {
    if (zh === key && vi) return vi;
  }
  return GLOSSARY.get(key) || null;
}

/**
 * Đọc khối cấu hình dịch: `config.translate`, thiếu thì kế thừa khối `config.ai`
 * (đúng như C1 mô tả trong hợp đồng §4.1). `provider: 'ai'` = dùng provider thật ở khối `ai`.
 */
export function resolveTranslateConfig(config = {}) {
  const t = config && typeof config.translate === 'object' && config.translate !== null ? config.translate : {};
  const ai = config && typeof config.ai === 'object' && config.ai !== null ? config.ai : {};

  const declared = String(t.provider ?? '').trim().toLowerCase();
  const inherited = declared === '' ? String(ai.provider ?? '').trim().toLowerCase() : declared;

  let mode = 'none';
  let provider = '';
  if (inherited === 'mock') {
    mode = 'mock';
    provider = 'mock';
  } else if (inherited === '' || inherited === 'none') {
    mode = 'none';
  } else {
    mode = 'ai';
    provider = inherited === 'ai' ? String(ai.provider ?? 'deepseek').trim().toLowerCase() : inherited;
  }

  return {
    mode,
    provider,
    apiKey: t.apiKey || ai.apiKey || '',
    baseUrl: t.baseUrl || ai.baseUrl || '',
    model: t.model || ai.model || '',
    timeoutMs: Number.isFinite(Number(t.timeoutMs))
      ? Number(t.timeoutMs)
      : Number.isFinite(Number(ai.timeoutMs))
        ? Number(ai.timeoutMs)
        : 120000,
  };
}

/**
 * Provider dịch chữ trên ảnh.
 * `translateRegions` KHÔNG BAO GIỜ ném lỗi ra ngoài — mọi lỗi thành `status: 'FAILED'` + `error_code`.
 */
export class Translator {
  #mode;
  #transport;
  #logger;
  #config;
  #maxLineChars;

  constructor({ mode, transport = null, aiProvider = null, logger, config = {}, maxLineChars = MAX_LINE_CHARS } = {}) {
    const resolvedTransport = transport ?? aiProvider ?? null;
    this.#mode = mode ?? (resolvedTransport ? 'ai' : 'none');
    this.#transport = resolvedTransport;
    this.#logger = logger;
    this.#config = config;
    this.#maxLineChars = Number.isFinite(Number(maxLineChars)) ? Number(maxLineChars) : MAX_LINE_CHARS;
  }

  /** 'mock' | 'ai' | 'none' — luôn nói thật về đường đi đang dùng. */
  get name() {
    if (this.#mode === 'mock') return 'mock';
    if (this.#transport && this.#transport.name === 'mock') return 'mock';
    if (this.#transport) return 'ai';
    return 'none';
  }

  get model() {
    if (this.#transport?.model) return String(this.#transport.model);
    return this.#mode === 'mock' ? 'mock-1' : '';
  }

  /** Provider giả PHẢI tự khai — kể cả khi transport được bơm vào là MockProvider. */
  get isMock() {
    return this.#mode === 'mock' || this.#transport?.name === 'mock';
  }

  get configured() {
    if (this.#mode === 'mock') return true;
    if (this.#mode === 'none') return false;
    return Boolean(this.#transport) && this.#transport.configured !== false;
  }

  /** Chế độ cấu hình ('mock' | 'ai' | 'none') — tiện cho log/health, không thuộc hợp đồng bắt buộc. */
  get mode() {
    return this.#mode;
  }

  /** Khung TranslateResult — mọi nhánh trả về đều đi qua đây để không lệch field. */
  #result(patch = {}) {
    return {
      status: patch.status ?? TRANSLATE_RESULT_STATUS.OK,
      provider: this.name,
      model: this.model,
      is_mock: Boolean(this.isMock),
      lines: Array.isArray(patch.lines) ? patch.lines : [],
      warnings: Array.isArray(patch.warnings) ? patch.warnings : [],
      usage: patch.usage ?? null,
      error_code: patch.error_code ?? null,
      error_message: patch.error_message ?? null,
    };
  }

  /**
   * Dịch danh sách Region.
   * @param {Array} regions Region[] (C1 sinh)
   * @param {{context?: string, glossaryExtra?: object}} [options]
   * @returns {Promise<object>} TranslateResult
   */
  async translateRegions(regions, { context = '', glossaryExtra = {} } = {}) {
    const list = Array.isArray(regions) ? regions.filter((r) => r && typeof r === 'object') : [];
    if (list.length === 0) {
      return this.#result({
        status: TRANSLATE_RESULT_STATUS.NO_LINES,
        lines: [],
        warnings: ['Không có vùng chữ nào để dịch (đầu vào rỗng).'],
      });
    }

    const warnings = [];
    const slots = new Array(list.length);
    const pending = [];
    const skipCounts = { brand: 0, certification: 0, price: 0, unknown: 0, empty: 0, forbidden: 0 };

    list.forEach((region, index) => {
      const regionId = regionIdOf(region, index);
      const shaped = { ...region, id: regionId };

      // LUẬT 3: vùng không được phép dịch ⇒ không bao giờ chạm tới provider.
      if (!isTranslatableRegion(region)) {
        slots[index] = createSkippedLine(shaped);
        skipCounts[kindOf(region)] += 1;
        return;
      }

      const text = String(region.text ?? '').trim();
      if (!text) {
        slots[index] = createLine(shaped, {
          text_original: '',
          text_vi: '',
          status: TRANSLATE_STATUS.NEEDS_REVIEW,
          provenance: PROVENANCE.NONE,
          confidence: 0,
          violations: ['Vùng được đánh dấu cần dịch nhưng không có chữ gốc — không thể dịch.'],
          notes: 'Chữ gốc rỗng: kiểm tra lại bước OCR trước khi duyệt.',
        });
        skipCounts.empty += 1;
        return;
      }

      // Mẫu chữ CẤM dịch (nhãn hiệu/chứng nhận/giá/mã model) ⇒ bỏ qua, không gọi AI.
      const forbidden = classifyForbiddenText(text);
      if (forbidden) {
        slots[index] = createSkippedLine(shaped, { status: forbidden.status, notes: forbidden.reason });
        skipCounts.forbidden += 1;
        return;
      }

      pending.push({ index, region, regionId, text });
    });

    if (skipCounts.brand + skipCounts.certification + skipCounts.price + skipCounts.unknown > 0) {
      warnings.push(
        `${skipCounts.brand + skipCounts.certification + skipCounts.price + skipCounts.unknown} vùng không được dịch (nhãn hiệu/chứng nhận/giá/không rõ loại) — lý do ghi ở từng dòng.`,
      );
    }
    if (skipCounts.forbidden > 0) {
      warnings.push(`${skipCounts.forbidden} vùng chứa mẫu chữ cấm dịch — đã bỏ qua, không gửi cho provider.`);
    }

    // Không có vùng nào cần dịch ⇒ KHÔNG gọi AI, không tốn usage.
    if (pending.length === 0) {
      warnings.push('Không có vùng nào cần dịch — không gọi provider, không tốn usage.');
      return this.#result({
        status: TRANSLATE_RESULT_STATUS.OK,
        lines: this.#finalize(slots, list),
        warnings,
      });
    }

    // Fail-closed: thiếu provider/thiếu key ⇒ NOT_CONFIGURED, không gọi gì cả.
    if (!this.configured) {
      const message = 'Chưa cấu hình provider dịch (provider = none hoặc thiếu API key).';
      for (const item of pending) {
        slots[item.index] = createFailedLine({ ...item.region, id: item.regionId }, {
          notes: message,
          errorCode: 'TRANSLATE_NOT_CONFIGURED',
        });
      }
      this.#logger?.warn?.('imagelab.translate.not_configured', { mode: this.#mode });
      return this.#result({
        status: TRANSLATE_RESULT_STATUS.NOT_CONFIGURED,
        lines: this.#finalize(slots, list),
        warnings: [...warnings, message],
        error_code: 'TRANSLATE_NOT_CONFIGURED',
        error_message: message,
      });
    }

    if (this.#mode === 'mock') {
      const dictionary = buildDictionary(glossaryExtra);
      for (const item of pending) {
        slots[item.index] = this.#mockLine(item, glossaryExtra, dictionary);
      }
      warnings.push('Provider mock: bản dịch ghép cơ học từ từ điển, không gọi mạng, không tốn usage.');
      return this.#result({
        status: TRANSLATE_RESULT_STATUS.OK,
        lines: this.#finalize(slots, list),
        warnings,
      });
    }

    return this.#translateWithAi({ list, slots, pending, context, glossaryExtra, warnings });
  }

  /** Nhánh AI — bọc try/catch để lỗi provider không bao giờ ném ra ngoài. */
  async #translateWithAi({ list, slots, pending, context, glossaryExtra, warnings }) {
    const inputUnits = pending.reduce((sum, item) => sum + item.text.length, 0);
    try {
      const dictionary = buildDictionary(glossaryExtra);
      const { byRegion, model, ignored, calls } = await translateWithProvider({
        provider: this.#transport,
        items: pending.map((item) => ({ region_id: item.regionId, text: item.text })),
        context,
        dictionary,
        logger: this.#logger,
        maxLineChars: this.#maxLineChars,
      });

      let outputUnits = 0;
      let missing = 0;
      let rescued = 0;
      for (const item of pending) {
        const got = byRegion.get(item.regionId);
        const aiText = typeof got?.text_vi === 'string' ? got.text_vi : '';
        let textVi = aiText;
        let status = TRANSLATE_STATUS.TRANSLATED;
        let provenance = PROVENANCE.AI;
        let notes = '';
        let confidence = clampConfidence(got?.confidence, AI_DEFAULT_CONFIDENCE);

        if (!textVi) {
          // Provider bỏ sót vùng này. Nếu chữ gốc khớp CHÍNH XÁC một mục từ điển thì dùng
          // từ điển (bản dịch vẫn truy được nguồn) thay vì đẩy NEEDS_REVIEW vô ích.
          const fromGlossary = exactGlossaryMatch(item.text, glossaryExtra);
          if (fromGlossary) {
            textVi = fromGlossary;
            status = TRANSLATE_STATUS.GLOSSARY;
            provenance = PROVENANCE.GLOSSARY;
            confidence = 0.9;
            notes = 'Provider không trả bản dịch cho vùng này — lấy từ từ điển thuật ngữ.';
            rescued += 1;
          } else {
            status = TRANSLATE_STATUS.NEEDS_REVIEW;
            provenance = PROVENANCE.NONE;
            confidence = 0;
            notes = 'Provider không trả về bản dịch cho vùng này.';
            missing += 1;
          }
        }

        outputUnits += textVi.length;
        slots[item.index] = createLine({ ...item.region, id: item.regionId }, {
          text_original: item.text,
          text_vi: textVi,
          status,
          provenance,
          confidence,
          notes,
        });
      }

      if (ignored?.length) {
        warnings.push(`Provider trả về ${ignored.length} region_id không có trong yêu cầu — đã bỏ qua.`);
      }
      if (rescued > 0) {
        warnings.push(`${rescued} vùng provider bỏ sót đã lấy từ từ điển thuật ngữ (provenance = glossary).`);
      }
      if (missing > 0) {
        warnings.push(`${missing} vùng không được provider trả bản dịch — chuyển NEEDS_REVIEW.`);
      }

      const lines = this.#finalize(slots, list);
      this.#logger?.info?.('imagelab.translate.done', {
        lines: lines.length,
        calls,
        model,
        input_units: inputUnits,
      });

      return this.#result({
        status: TRANSLATE_RESULT_STATUS.OK,
        lines,
        warnings,
        usage: { input_units: inputUnits, output_units: outputUnits },
      });
    } catch (err) {
      const code = String(err?.code || 'TRANSLATE_PROVIDER_ERROR');
      // Không log/không trả secret: redact trước khi đưa thông điệp lỗi ra ngoài.
      const message = redact(String(err?.message || 'Provider dịch lỗi không xác định.'));
      this.#logger?.warn?.('imagelab.translate.failed', { code });
      for (const item of pending) {
        slots[item.index] = createFailedLine({ ...item.region, id: item.regionId }, {
          notes: message,
          errorCode: code,
        });
      }
      return this.#result({
        status: TRANSLATE_RESULT_STATUS.FAILED,
        lines: this.#finalize(slots, list),
        warnings: [...warnings, `Provider dịch lỗi (${code}) — các vùng cần dịch đều ở trạng thái FAILED.`],
        error_code: code,
        error_message: message,
      });
    }
  }

  /** Bản dịch MOCK: từ điển + ghép cơ học, phần không biết thì GIỮ NGUYÊN (guardrail sẽ bắt CHƯA DỊCH). */
  #mockLine(item, glossaryExtra, dictionary) {
    const res = translateWithDictionary(item.text, glossaryExtra, dictionary);
    const textVi = res.text_vi;
    const matchedNote = res.matched.length
      ? `Khớp từ điển: ${res.matched
          .slice(0, 6)
          .map(([zh, vi]) => `${zh}→${vi || '(bỏ)'}`)
          .join('; ')}.`
      : 'Từ điển không khớp thuật ngữ nào.';
    const leftNote = res.untranslated.length
      ? ` Còn ${res.untranslated.length} ký tự chưa có trong từ điển: ${res.untranslated.slice(0, 8).join('')}.`
      : '';

    return createLine({ ...item.region, id: item.regionId }, {
      text_original: item.text,
      text_vi: textVi,
      status: textVi ? TRANSLATE_STATUS.GLOSSARY : TRANSLATE_STATUS.NEEDS_REVIEW,
      provenance: textVi ? PROVENANCE.GLOSSARY : PROVENANCE.NONE,
      confidence: textVi ? (res.exact ? 0.9 : 0.5) : 0,
      notes: `Bản dịch mock (không gọi mạng). ${matchedNote}${leftNote}`.trim(),
    });
  }

  /**
   * Chạy guardrail cho MỌI dòng rồi trả về mảng đúng thứ tự vùng vào.
   * Dòng nào chưa có (lỗi lập trình) thì sinh dòng NEEDS_REVIEW — không bao giờ trả undefined.
   */
  #finalize(slots, list) {
    return slots.map((line, index) => {
      if (!line) {
        return createSkippedLine(
          { ...list[index], id: regionIdOf(list[index], index) },
          {
            status: TRANSLATE_STATUS.NEEDS_REVIEW,
            notes: 'Không sinh được dòng dịch cho vùng này — cần người duyệt.',
          },
        );
      }
      return enforceTranslationGuardrails(line, { region: list[index] }).line;
    });
  }
}

/**
 * Dựng Translator từ config.
 * @param {object} config config đầy đủ (hoặc đã có khối `translate`)
 * @param {{logger?: object, aiProvider?: object}} [options] `aiProvider` để test bơm provider giả.
 */
export function createTranslator(config = {}, { logger, aiProvider } = {}) {
  const cfg = resolveTranslateConfig(config);
  let mode = cfg.mode;
  let transport = aiProvider ?? null;

  if (!transport && mode === 'ai') {
    try {
      transport = createProvider(
        {
          provider: cfg.provider,
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          timeoutMs: cfg.timeoutMs,
        },
        { logger },
      );
    } catch (err) {
      // Provider không hợp lệ ⇒ fail-closed về 'none' (NOT_CONFIGURED), không làm sập boot.
      logger?.warn?.('imagelab.translate.provider_invalid', { provider: cfg.provider, code: err?.code || 'UNKNOWN' });
      transport = null;
      mode = 'none';
    }
  }

  return new Translator({ mode, transport, logger, config });
}

export default createTranslator;
