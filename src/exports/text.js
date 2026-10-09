/**
 * Dựng `noi-dung/noi-dung.txt` — bản DỄ ĐỌC CHO NGƯỜI của gói xuất bản.
 *
 * Nguyên tắc (luật §0.2 "không bịa nội dung"):
 *   · chỉ in ra dữ liệu ĐÃ LƯU của job (nội dung MVP-01, dòng dịch/vùng OCR của MVP-02);
 *   · mục nào không có thì BỎ QUA (không in tiêu đề rỗng, không chèn "đang cập nhật");
 *   · cuối file nói THẬT: bước nào chạy bằng provider giả, có bao nhiêu cảnh báo —
 *     bản `.txt` này không được phép "đẹp hơn" `MANIFEST.json`.
 *
 * Đầu ra là UTF-8, xuống dòng `\n`, không phụ thuộc locale/múi giờ ⇒ hai lần xuất cùng dữ
 * liệu cho ra cùng nội dung.
 */

import { assetMeta } from './assets.js';

/** `true` nếu giá trị là chuỗi có nội dung (sau trim). */
const hasText = (v) => typeof v === 'string' && v.trim() !== '';
/** Mảng chuỗi có nội dung. */
const textList = (v) => (Array.isArray(v) ? v.filter(hasText).map((s) => String(s).trim()) : []);

/** Một mục kiểu "## Tiêu đề\n nội dung" (chuỗi rỗng nếu không có nội dung). */
function section(title, body) {
  if (!hasText(body)) return '';
  return `## ${title}\n${String(body).trim()}\n\n`;
}

/**
 * Dựng nội dung text cho một job.
 *
 * @param {object} params
 * @param {object} params.job job đã hydrate từ store
 * @param {object|null} [params.content] `job.content` (MVP-01)
 * @param {Array} [params.lines] dòng dịch (MVP-02)
 * @param {Array} [params.regions] vùng OCR (MVP-02)
 * @param {string[]} [params.warnings] cảnh báo CÓ THẬT của job
 * @param {string[]} [params.mockSteps] bước đã chạy bằng provider giả
 * @param {boolean} [params.hasVideo] job có asset video (để nói đúng chuyện "không tiếng")
 * @returns {string|null} `null` nếu job không có gì để in (khi đó KHÔNG tạo file)
 */
export function renderHumanText({
  job,
  content = null,
  lines = [],
  regions = [],
  warnings = [],
  mockSteps = [],
  hasVideo = false,
} = {}) {
  const jobId = String(job?.id || '(không rõ id)');
  const kind = String(job?.kind || 'content');
  const status = String(job?.status || '');
  const head = hasText(job?.product_name) ? job.product_name.trim() : null;

  /* ── Đầu file: chỉ dữ liệu ĐÃ LƯU ── */
  const header = [];
  header.push(`${head ? `# Gói xuất bản — job ${jobId} — ${head}` : `# Gói xuất bản — job ${jobId}`}\n`);
  header.push(`Loại job: ${kind} · Trạng thái: ${status || '(không rõ)'}\n`);
  if (hasText(job?.source_url)) header.push(`Nguồn: ${job.source_url.trim()}\n`);
  header.push('\n');

  /* ── Thân file: mỗi mục chỉ xuất hiện khi có dữ liệu thật ── */
  const body = [];

  /* MVP-01: nội dung bán hàng */
  if (content && typeof content === 'object') {
    body.push(section('Tên sản phẩm', content.product_name));
    body.push(section('Tiêu đề (headline)', content.headline));
    body.push(section('Mô tả ngắn', content.short_description));
    const points = textList(content.selling_points);
    if (points.length) body.push(section('Điểm bán hàng', points.map((p, i) => `${i + 1}. ${p}`).join('\n')));
    body.push(section('Mô tả chi tiết', content.detailed_description));
    body.push(section('Bài đăng Facebook', content.facebook_caption));
    body.push(section('Caption TikTok', content.tiktok_caption));
    body.push(section('Mô tả cho sàn TMĐT', content.marketplace_description));
    const tags = textList(content.hashtags);
    if (tags.length) body.push(section('Hashtags', tags.join(' ')));
    const seo = content.seo && typeof content.seo === 'object' ? content.seo : null;
    if (seo) {
      const rows = [];
      if (hasText(seo.title)) rows.push(`- Tiêu đề SEO: ${seo.title.trim()}`);
      if (hasText(seo.meta_description)) rows.push(`- Meta description: ${seo.meta_description.trim()}`);
      const kw = textList(seo.keywords);
      if (kw.length) rows.push(`- Từ khoá: ${kw.join(', ')}`);
      if (rows.length) body.push(section('SEO', rows.join('\n')));
    }
  }

  /* Nội dung dạng chuỗi thô (DB cũ/lạ): in NGUYÊN VĂN, không diễn giải lại. */
  if (typeof content === 'string' && content.trim()) {
    body.push(`${content.trim()}\n\n`);
  }

  /* MVP-02: bản dịch chữ trên ảnh */
  const lineList = Array.isArray(lines) ? lines.filter((l) => l && typeof l === 'object') : [];
  if (lineList.length) {
    body.push(`## Bản dịch chữ trên ảnh (${lineList.length} dòng)\n\n`);
    for (const line of lineList) {
      const key = String(line.region_id || line.region_key || '(không rõ vùng)');
      const flags = [
        hasText(line.status) ? `trạng thái: ${line.status}` : null,
        Number.isFinite(Number(line.confidence)) ? `độ tin cậy: ${Number(line.confidence)}` : null,
        hasText(line.provenance) ? `nguồn: ${line.provenance}` : null,
        line.edited_by_user ? 'người dùng đã sửa' : null,
      ].filter(Boolean);
      body.push(`[${key}]${flags.length ? ` (${flags.join(', ')})` : ''}\n`);
      body.push(`  GỐC : ${hasText(line.text_original) ? line.text_original.trim() : '(trống)'}\n`);
      body.push(`  DỊCH: ${hasText(line.text_vi) ? line.text_vi.trim() : '(trống)'}\n`);
      for (const v of Array.isArray(line.violations) ? line.violations : []) {
        const text = typeof v === 'string' ? v : v?.message || v?.code || JSON.stringify(v);
        if (hasText(text)) body.push(`  ⚠️ vi phạm: ${String(text).trim()}\n`);
      }
      if (hasText(line.notes)) body.push(`  ghi chú: ${line.notes.trim()}\n`);
      body.push('\n');
    }
  }

  /* MVP-02: vùng OCR (để người đọc đối chiếu toạ độ với ảnh) */
  const regionList = Array.isArray(regions) ? regions.filter((r) => r && typeof r === 'object') : [];
  if (regionList.length) {
    body.push(`## Vùng chữ đã dò (${regionList.length} vùng)\n\n`);
    for (const r of regionList) {
      const key = String(r.region_key || r.id || '(không rõ)');
      const box = r.box && typeof r.box === 'object' ? r.box : {};
      const coords = ['x', 'y', 'w', 'h'].map((k) => (Number.isFinite(Number(box[k])) ? Number(box[k]) : '?')).join(',');
      const flags = [
        hasText(r.kind) ? `loại: ${r.kind}` : null,
        r.translatable === true ? 'dịch được' : 'KHÔNG dịch',
        hasText(r.lang) ? `ngôn ngữ: ${r.lang}` : null,
      ].filter(Boolean);
      body.push(`[${key}] box(${coords}) · ${flags.join(' · ')}\n`);
      body.push(`  chữ: ${hasText(r.text) ? r.text.trim() : '(trống)'}\n`);
    }
    body.push('\n');
  }

  const bodyText = body.join('');
  // Không có một dòng nội dung nào ⇒ KHÔNG tạo file rỗng giả (luật §0.2).
  if (!bodyText) return null;

  /* ── Phần nói thật (không giấu cảnh báo — luật §0.1) ── */
  const footer = ['—\n', 'Gói do tính năng "Gói xuất bản" của vip-product-studio tạo. Mọi nội dung ở trên là dữ liệu đã lưu của job.\n'];
  const mock = Array.isArray(mockSteps) ? mockSteps.filter(hasText) : [];
  const warns = Array.isArray(warnings) ? warnings.filter(hasText) : [];
  if (mock.length) {
    footer.push(`⚠️ Các bước đã chạy bằng provider GIẢ (mock): ${mock.join(', ')} — phần dữ liệu tương ứng KHÔNG được kiểm chứng bằng dịch vụ thật.\n`);
  }
  if (warns.length) {
    footer.push(`⚠️ Job có ${warns.length} cảnh báo đã ghi — xem đầy đủ trong MANIFEST.json (không cảnh báo nào bị bỏ).\n`);
  }
  if (hasVideo) {
    footer.push('Video trong gói là bản OFFLINE, KHÔNG có tiếng (audio) — chi tiết xem MANIFEST.json.\n');
  }

  return [...header, bodyText, ...footer].join('');
}

/** Tóm tắt asset đã render cho phần text (chỉ đọc dữ liệu, không suy diễn). */
export function describeAsset(asset) {
  const meta = assetMeta(asset);
  const bits = [];
  if (asset?.width && asset?.height) bits.push(`${asset.width}×${asset.height}`);
  if (Number.isFinite(Number(asset?.bytes))) bits.push(`${Number(asset.bytes)} byte`);
  if (hasText(meta.provider)) bits.push(`provider: ${meta.provider}`);
  if (meta.is_mock === true) bits.push('provider GIẢ (mock)');
  return bits.join(' · ');
}

export default renderHumanText;
