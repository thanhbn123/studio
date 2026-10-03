/**
 * Tiện ích parse dùng chung cho các connector.
 *
 * Vì sao dùng "deep find" thay vì đường dẫn cứng (vd `data.item.sku.base`):
 * cấu trúc JSON nhúng của các sàn Trung Quốc đổi khá thường xuyên và khác nhau
 * giữa các loại trang. Đường dẫn cứng vỡ ngay khi sàn đổi tên khoá. Tìm theo
 * TÊN KHOÁ trên toàn cây chịu được thay đổi cấu trúc tốt hơn nhiều.
 *
 * Đánh đổi: deep find có thể bắt nhầm khoá trùng tên ở nhánh khác. Nên mọi
 * tiện ích ở đây đều cho phép truyền `predicate` để kiểm hình dạng giá trị.
 */

/** Duyệt cây theo chiều sâu, có giới hạn để không treo với dữ liệu lớn. */
function walk(root, visit, { maxDepth = 9, maxNodes = 50000 } = {}) {
  const stack = [{ node: root, depth: 0, path: [] }];
  let seen = 0;
  const visited = new WeakSet();
  while (stack.length > 0) {
    const { node, depth, path } = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (visited.has(node)) continue;
    visited.add(node);
    seen += 1;
    if (seen > maxNodes || depth > maxDepth) continue;
    if (visit(node, path, depth) === false) return seen;
    for (const [k, v] of Object.entries(node)) {
      if (v !== null && typeof v === 'object') {
        stack.push({ node: v, depth: depth + 1, path: [...path, k] });
      }
    }
  }
  return seen;
}

/**
 * Tìm giá trị đầu tiên có tên khoá khớp và thoả `predicate`.
 * @param {any} root
 * @param {string[]} keyNames tên khoá cần tìm (so khớp không phân biệt hoa thường)
 */
export function deepFind(root, keyNames, predicate = () => true, opts = {}) {
  const wanted = new Set(keyNames.map((k) => k.toLowerCase()));
  let found;
  walk(
    root,
    (node, path) => {
      for (const [k, v] of Object.entries(node)) {
        if (!wanted.has(k.toLowerCase())) continue;
        if (v === null || v === undefined || v === '') continue;
        if (!predicate(v)) continue;
        found = { value: v, key: k, path: [...path, k] };
        return false; // dừng ngay khi thấy
      }
      return undefined;
    },
    opts,
  );
  return found;
}

/** Như deepFind nhưng gom hết (giới hạn số lượng). */
export function deepFindAll(root, keyNames, predicate = () => true, { limit = 200, ...opts } = {}) {
  const wanted = new Set(keyNames.map((k) => k.toLowerCase()));
  const out = [];
  walk(
    root,
    (node, path) => {
      for (const [k, v] of Object.entries(node)) {
        if (!wanted.has(k.toLowerCase())) continue;
        if (v === null || v === undefined || v === '') continue;
        if (!predicate(v)) continue;
        out.push({ value: v, key: k, path: [...path, k] });
        if (out.length >= limit) return false;
      }
      return undefined;
    },
    opts,
  );
  return out;
}

const isStr = (v) => typeof v === 'string';
const isNonEmptyStr = (v) => isStr(v) && v.trim().length > 0;
const isNumLike = (v) => typeof v === 'number' || (isStr(v) && /^\d+(\.\d+)?$/.test(v.trim()));

/** Tìm chuỗi không rỗng đầu tiên theo danh sách tên khoá. */
export function findString(root, keyNames, opts) {
  const r = deepFind(root, keyNames, isNonEmptyStr, opts);
  return r ? r.value.trim() : '';
}

/**
 * Tìm giá trị vô hướng (chuỗi HOẶC số) theo tên khoá, trả về chuỗi.
 *
 * Cần hàm riêng vì nhiều id của sàn Trung Quốc là SỐ (shopId: 446922193,
 * sellerId: 3020167582). Dùng `findString` cho chúng sẽ luôn ra rỗng.
 */
export function findScalar(root, keyNames, opts) {
  const r = deepFind(
    root,
    keyNames,
    (v) => (typeof v === 'string' && v.trim().length > 0) || typeof v === 'number',
    opts,
  );
  return r ? String(r.value).trim() : '';
}

/** Tìm số đầu tiên theo danh sách tên khoá. */
export function findNumber(root, keyNames, opts) {
  const r = deepFind(root, keyNames, isNumLike, opts);
  if (!r) return null;
  const n = Number(r.value);
  return Number.isFinite(n) ? n : null;
}

/** Tìm mảng các chuỗi (vd danh sách ảnh) theo tên khoá. */
export function findStringArray(root, keyNames, opts) {
  const r = deepFind(
    root,
    keyNames,
    (v) => Array.isArray(v) && v.some((x) => isNonEmptyStr(x) || (x && isNonEmptyStr(x.url || x.imageUrl))),
    opts,
  );
  if (!r) return [];
  return r.value
    .map((x) => (isStr(x) ? x : x?.url || x?.imageUrl || x?.picUrl || x?.img || ''))
    .filter(isNonEmptyStr);
}

/* ───────────────────────── HTML ───────────────────────── */

/** Lấy thẻ meta thành map: property/name → content. */
export function metaTags(html) {
  const out = {};
  const re = /<meta\s+([^>]+?)\/?>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const key = /(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (key && content) out[key[1].toLowerCase()] = decodeHtmlEntities(content[1]);
  }
  return out;
}

export function decodeHtmlEntities(s) {
  return String(s ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&amp;/g, '&');
}

/** Gom URL ảnh trong một đoạn HTML (dùng cho mô tả chi tiết). */
export function imagesInHtml(html, base) {
  const out = [];
  const re = /<img\s+[^>]*?(?:data-src|data-ks-lazyload|data-lazy-src|src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = decodeHtmlEntities(m[1]);
    if (!raw || raw.startsWith('data:')) continue;
    let url = raw;
    if (url.startsWith('//')) url = `https:${url}`;
    else if (url.startsWith('/') && base) {
      try {
        url = new URL(url, base).toString();
      } catch {
        continue;
      }
    }
    if (!/^https?:\/\//i.test(url)) continue;
    out.push(url);
  }
  return [...new Set(out)];
}

/** Bỏ thẻ HTML, giữ text — dùng cho mô tả chi tiết. */
export function stripHtml(html) {
  return decodeHtmlEntities(
    String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Phân loại chuỗi giá của sàn Trung Quốc.
 * "¥12.00" → fixed | "¥12.00-25.00" → range | "12.00起" → range (giá từ)
 */
export function classifyPrice(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { kind: 'unknown', min: null, max: null, currency: 'CNY' };
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => Number.isFinite(n));
  const currency = /¥|￥|CNY|RMB/i.test(s) ? 'CNY' : /US?\$|USD/i.test(s) ? 'USD' : 'CNY';
  const hasRangeSep = /[-~—至到]/.test(s) || /起|\+/.test(s);
  if (nums.length === 0) return { kind: 'unknown', min: null, max: null, currency };
  if (nums.length >= 2 && hasRangeSep) {
    return { kind: 'range', min: Math.min(...nums), max: Math.max(...nums), currency };
  }
  return { kind: 'fixed', min: nums[0], max: nums[0], currency };
}
