/**
 * C2 — Nhánh provider AI cho dịch chữ trên ảnh.
 *
 * Nguyên tắc (luật số 1 — KHÔNG BỊA):
 *   - Prompt là một FACT SHEET ĐÓNG: model chỉ được dịch đúng những gì có trong `text_original`,
 *     cấm thêm/bớt thông tin, cấm đổi số liệu, cấm thêm khẳng định (bảo hành, chống nước…).
 *   - Hợp đồng đầu ra: DUY NHẤT JSON `{ "lines": [{ "region_id": "...", "text_vi": "..." }] }`.
 *   - Provider lỗi/JSON hỏng ⇒ ném `AiError` để tầng trên trả `status: 'FAILED'` (không ném ra ngoài).
 *   - Không log API key, không log body (dùng `logger.debug` với dữ liệu đã lược).
 */

import { AiError, extractJson } from '../../ai/provider.js';
import { sanitizeText } from '../../security/sanitize.js';
import { MAX_LINE_CHARS } from './lines.js';

/** Trần ký tự chữ gốc gửi trong MỘT lượt gọi — vượt thì cắt thành nhiều lượt. */
const MAX_CHARS_PER_CALL = 6000;
/** Trần số vùng trong một lượt gọi. */
const MAX_ITEMS_PER_CALL = 40;

export const TRANSLATE_SYSTEM_PROMPT = `Bạn là công cụ DỊCH CHỮ TRÊN ẢNH sản phẩm thương mại điện tử, từ tiếng Trung sang tiếng Việt.

LUẬT BẮT BUỘC (không được vi phạm vì bất kỳ lý do gì):
1. CHỈ dịch đúng nội dung có trong "text_original". KHÔNG thêm thông tin, KHÔNG bớt thông tin, KHÔNG suy diễn.
2. KHÔNG đổi bất kỳ con số, đơn vị, ký hiệu nào (100ml, 5000mAh, 12V… phải giữ nguyên số và đơn vị).
3. KHÔNG thêm các khẳng định không có trong bản gốc: bảo hành, chứng nhận, chống nước, chính hãng,
   số 1, tốt nhất, cao cấp nhất, an toàn tuyệt đối, cam kết, giảm giá…
4. KHÔNG dịch nhãn hiệu, tên thương hiệu, mã sản phẩm, ký hiệu ®/™/©, hay nội dung chứng nhận.
   Nếu vùng nào thuộc nhóm đó thì trả "text_vi": "".
5. Không chắc nghĩa thì trả "text_vi": "" — thà để người duyệt còn hơn đoán.
6. Giữ nguyên tên riêng, mã hiệu, và các từ viết tắt tiếng Anh có trong bản gốc.
7. Tiếng Việt tự nhiên, ngắn gọn, phù hợp chữ in trên ảnh sản phẩm; tối đa ${MAX_LINE_CHARS} ký tự.

ĐỊNH DẠNG TRẢ VỀ: DUY NHẤT một object JSON, không thêm chữ nào khác:
{"lines":[{"region_id":"r1","text_vi":"..."}]}
Mỗi region_id trong yêu cầu phải xuất hiện đúng một lần. Không giải thích, không markdown.`;

/**
 * Gom các thuật ngữ từ điển THỰC SỰ xuất hiện trong chữ gốc để gợi ý cách dịch.
 * Chỉ gửi thuật ngữ liên quan — gửi cả từ điển sẽ mời model thêm thông tin không có trong ảnh.
 */
export function collectGlossaryHints(texts, dictionary, { maxHints = 80 } = {}) {
  const hints = [];
  const seen = new Set();
  for (const [zh, vi] of dictionary) {
    if (!zh || !vi || seen.has(zh)) continue;
    if (texts.some((t) => t.includes(zh))) {
      seen.add(zh);
      hints.push([zh, vi]);
      if (hints.length >= maxHints) break;
    }
  }
  return hints;
}

/** Dựng messages cho một lượt gọi. */
export function buildTranslateMessages({ items, context = '', hints = [] }) {
  const glossaryBlock = hints.length
    ? [
        'BẢNG THUẬT NGỮ CHUẨN (chỉ dùng khi từ gốc tương ứng CÓ trong text_original;',
        'tuyệt đối không thêm thuật ngữ nào không xuất hiện trong bản gốc):',
        ...hints.map(([zh, vi]) => `- ${zh} = ${vi}`),
      ].join('\n')
    : '(không có thuật ngữ nào khớp — dịch sát nghĩa, không thêm gì)';

  const listBlock = items
    .map((it) => `- region_id: ${it.region_id}\n  text_original: ${it.text}`)
    .join('\n');

  const userText = [
    context ? `NGỮ CẢNH ẢNH (chỉ để hiểu nghĩa, KHÔNG được đưa vào bản dịch): ${sanitizeText(context, { maxLength: 500 })}` : '',
    glossaryBlock,
    '',
    'DANH SÁCH VÙNG CẦN DỊCH:',
    listBlock,
    '',
    'Trả về JSON đúng định dạng đã quy định.',
  ]
    .filter((s) => s !== '')
    .join('\n');

  return [
    { role: 'system', text: TRANSLATE_SYSTEM_PROMPT },
    { role: 'user', text: userText },
  ];
}

/** Chia lô theo trần ký tự/số vùng để một ảnh nhiều chữ vẫn dịch được. */
export function chunkItems(items, { maxChars = MAX_CHARS_PER_CALL, maxItems = MAX_ITEMS_PER_CALL } = {}) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const len = String(item.text ?? '').length;
    if (current.length > 0 && (current.length >= maxItems || chars + len > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Gọi provider cho toàn bộ vùng cần dịch.
 * @returns {Promise<{byRegion: Map<string,{text_vi:string, confidence:number|null}>, usage: object|null, model: string, calls: number, ignored: string[]}>}
 * @throws {AiError} khi provider lỗi hoặc trả JSON sai hợp đồng.
 */
export async function translateWithProvider({
  provider,
  items,
  context = '',
  dictionary,
  logger,
  maxLineChars = MAX_LINE_CHARS,
} = {}) {
  if (!provider || typeof provider.chat !== 'function') {
    throw new AiError('TRANSLATE_NO_PROVIDER', 'Chưa có provider AI để dịch.');
  }

  const byRegion = new Map();
  const ignored = [];
  let usage = null;
  let model = provider.model || '';
  let calls = 0;

  for (const chunk of chunkItems(items)) {
    const hints = collectGlossaryHints(
      chunk.map((it) => it.text),
      dictionary,
    );
    const res = await provider.chat(buildTranslateMessages({ items: chunk, context, hints }), {
      jsonMode: true,
      maxTokens: 2048,
      temperature: 0.2,
    });
    calls += 1;
    model = res?.model || model;
    if (res?.usage) {
      usage = {
        prompt_tokens: (usage?.prompt_tokens ?? 0) + (res.usage.prompt_tokens ?? 0),
        completion_tokens: (usage?.completion_tokens ?? 0) + (res.usage.completion_tokens ?? 0),
      };
    }

    const parsed = extractJson(res?.content);
    const rawLines = Array.isArray(parsed) ? parsed : parsed?.lines;
    if (!Array.isArray(rawLines)) {
      throw new AiError('TRANSLATE_BAD_JSON', 'Provider dịch không trả về JSON dạng {"lines":[...]}.', {
        preview: String(res?.content ?? '').slice(0, 200),
      });
    }

    const known = new Set(chunk.map((it) => it.region_id));
    for (const entry of rawLines) {
      const regionId = String(entry?.region_id ?? '').trim();
      if (!regionId) continue;
      if (!known.has(regionId)) {
        if (!ignored.includes(regionId)) ignored.push(regionId);
        continue;
      }
      const textVi = sanitizeText(entry?.text_vi, { maxLength: maxLineChars });
      const confidence = Number.isFinite(Number(entry?.confidence)) ? Number(entry.confidence) : null;
      byRegion.set(regionId, { text_vi: textVi, confidence });
    }

    logger?.debug?.('imagelab.translate.ai_call', { items: chunk.length, returned: rawLines.length });
  }

  return { byRegion, usage, model, calls, ignored };
}

export default translateWithProvider;
