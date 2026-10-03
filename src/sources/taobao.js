/**
 * G03 — TAOBAO CONNECTOR.
 *
 * ── SỰ THẬT ĐÃ ĐO ĐƯỢC (03/10/2026, từ máy này) ──────────────────────────────
 *  • `item.taobao.com/item.htm?id=<id>` → HTTP 200 nhưng là STUB ĐĂNG NHẬP 5044 byte,
 *    và trả về Y HỆT NHAU cho cả id thật lẫn id giả ⇒ không phân biệt được gì.
 *    `detail.tmall.com/item.htm?id=` cũng vậy (5047 byte).
 *  • API H5 (`h5api.m.taobao.com` / `acs.m.taobao.com`) → challenge anti-bot x5sec
 *    (`_____tmd_____`), chỉ set cookie `x5secdata`, KHÔNG bao giờ trả `_m_h5_tk`
 *    ⇒ không thể bắt đầu bắt tay token, nên ký md5 không tới được.
 *  • `world.taobao.com/item/<id>.htm` → TRANG SẢN PHẨM THẬT, ẩn danh, không cần cookie.
 *    Id thật → ~68KB kèm `normalItemResponse` đầy đủ. Id giả → redirect về trang chủ.
 *
 * ⇒ Chiến lược: dùng `world.taobao.com` làm ROUTE TẢI ẨN DANH, còn `item.taobao.com`
 *   chỉ giữ vai trò URL canonical. Khi người dùng dán link `item.taobao.com`, connector
 *   tự chuyển sang route ẩn danh thay vì báo lỗi.
 *
 * Mọi field lấy từ `normalItemResponse` đều là dữ liệu THẬT của sàn: tiêu đề, ảnh,
 * giá, người bán, nơi xuất xứ, đánh giá. Không field nào được bịa.
 */

import {
  ProductSourceConnector,
  classifyPage,
  extractInlineJson,
  pageTitle,
  normalizeImageUrl,
  readBalancedJson,
} from './base-connector.js';
import { STATUS, PROVENANCE, addWarning, image, video, variant, attribute, price as mkPrice } from '../product-master.js';
import { classifyPrice, decodeHtmlEntities, deepFind, findString, imagesInHtml, metaTags, stripHtml } from './parsers/util.js';

const TAOBAO_COOKIE_DOMAINS = ['taobao.com', 'tmall.com', 'tb.cn'];

/** Tiêu đề trang chủ Taobao — dấu hiệu id không tồn tại hoặc đã bị gỡ. */
const HOMEPAGE_TITLES = ['taobao | 淘寶', 'taobao | 淘宝'];

export class TaobaoConnector extends ProductSourceConnector {
  static source = 'taobao';
  static displayName = 'Taobao';

  homeUrl() {
    return 'https://world.taobao.com/';
  }

  cookieDomains() {
    return TAOBAO_COOKIE_DOMAINS;
  }

  /** Đọc khối SSR `window.__ICE_APP_CONTEXT__` (JSON thật nằm trong `var X = {...}`). */
  parseIceContext(html) {
    const marker = html.indexOf('__ICE_APP_CONTEXT__');
    if (marker === -1) return null;
    const tail = html.slice(marker);
    const assign = /var\s+[A-Za-z_$][\w$]*\s*=\s*/.exec(tail);
    const searchFrom = assign ? assign.index + assign[0].length : 0;
    const start = tail.indexOf('{', searchFrom);
    if (start === -1) return null;
    return readBalancedJson(tail, start);
  }

  /** Lấy node `normalItemResponse` (chứa item, giá, người bán, đánh giá). */
  findItemNode(html) {
    const ice = this.parseIceContext(html);
    if (ice) {
      const node = deepFind(ice, ['normalItemResponse'], (v) => v && typeof v === 'object');
      // `normalItemResponse` có thể tồn tại nhưng RỖNG (chỉ có itemExist:false) —
      // đó là trang chủ / id không tồn tại, KHÔNG phải sản phẩm.
      if (node?.value && this.#hasProductShape(node.value)) {
        return { node: node.value, source: 'ice-app-context', ice };
      }
      const itemExist = deepFind(ice, ['itemExist'], (v) => typeof v === 'boolean');
      if (itemExist && itemExist.value === false) {
        return { node: null, source: 'ice-app-context', notExist: true, ice };
      }
      if (node?.value) return { node: null, source: 'ice-app-context', notExist: true, ice };
      // Có ICE nhưng không có normalItemResponse: vẫn trả `ice` để còn tìm mô tả.
      return { node: null, source: 'ice-app-context', ice };
    }
    // Tương thích ngược với các biến toàn cục cũ hơn.
    for (const name of ['__INITIAL_DATA__', '__INIT_DATA__', '__GLOBAL_DATA__', 'detailData']) {
      const json = extractInlineJson(html, [name]);
      if (!json || typeof json !== 'object') continue;
      const node = deepFind(json, ['normalItemResponse', 'item'], (v) => v && typeof v === 'object');
      if (node?.value) return { node: node.value, source: `inline:${name}`, ice: json };
    }
    return { node: null, source: 'none', ice: null };
  }

  /** Node có hình dạng sản phẩm thật không (có tiêu đề hoặc có ảnh). */
  #hasProductShape(node) {
    if (!node || typeof node !== 'object') return false;
    const item = deepFind(node, ['item'], (v) => v && typeof v === 'object')?.value || node;
    return Boolean(
      findString(item, ['title', 'itemTitle']) ||
        deepFind(item, ['images', 'imageList'], (v) => Array.isArray(v) && v.length > 0),
    );
  }

  /** Trang này có dữ liệu sản phẩm thật hay không. */
  hasItemData(html) {
    const { node } = this.findItemNode(html);
    if (!node) return false;
    return Boolean(
      findString(node, ['title']) || deepFind(node, ['images'], (v) => Array.isArray(v) && v.length > 0),
    );
  }

  /** Short link (m.tb.cn) → đi theo redirect để lấy URL chuẩn. */
  async resolveUrl(url) {
    const host = (() => {
      try {
        return new URL(url).hostname.toLowerCase();
      } catch {
        return '';
      }
    })();
    const isShort = ['m.tb.cn', 'e.tb.cn', 'tb.cn'].some((d) => host === d || host.endsWith(`.${d}`));
    if (!isShort) return { url, redirects: [] };
    const res = await this._fetch(url, {
      maxRedirects: this.config?.net?.maxRedirects ?? 5,
      timeoutMs: this.config?.net?.fetchTimeoutMs ?? 20000,
      maxBytes: 512 * 1024,
      allowPrivateNetwork: this.config?.net?.allowPrivateNetwork ?? false,
      headers: { 'user-agent': this.headers()['user-agent'] },
    });
    return { url: res.finalUrl || url, redirects: res.redirects || [] };
  }

  /**
   * Tải trang sản phẩm. Nếu URL là `item.taobao.com/item.htm?id=` (bị chặn đăng nhập
   * với mọi id), tự động thử lại bằng route ẩn danh `world.taobao.com`.
   */
  async fetchProduct(url, ctx = {}) {
    const first = await super.fetchProduct(url, ctx);
    if (this.hasItemData(first.html)) return first;

    const numericId = this.#numericIdFrom(url);
    if (!numericId) return first;

    const cls = classifyPage(first.html, { url: first.finalUrl });
    const looksWall = cls.login || cls.antibot || first.bytes < 8000;
    if (!looksWall) return first;

    const alt = `https://world.taobao.com/item/${numericId}.htm`;
    try {
      const second = await super.fetchProduct(alt, ctx);
      if (this.hasItemData(second.html)) {
        return {
          ...second,
          method: 'http-get+world.taobao-fallback',
          fallback_from: url,
          fallback_reason:
            'item.taobao.com chặn đăng nhập với mọi id — đã tự chuyển sang route ẩn danh world.taobao.com.',
        };
      }
    } catch (err) {
      this.logger?.warn('taobao.world_fallback_failed', { error: err });
    }
    return first;
  }

  #numericIdFrom(url) {
    try {
      const u = new URL(url);
      const q = u.searchParams.get('id') || u.searchParams.get('itemId');
      if (q && /^\d{6,20}$/.test(q)) return q;
      const m = u.pathname.match(/\/item\/(\d{6,20})\.html?$/i);
      if (m) return m[1];
    } catch {
      /* bỏ qua */
    }
    return null;
  }

  normalize(raw, master) {
    const html = raw.html || '';
    const finalUrl = raw.finalUrl || '';
    const cls = classifyPage(html, { url: finalUrl });
    const parsed = this.findItemNode(html);
    const node = parsed.node;

    if (raw.fallback_from) {
      master.extraction.fallback_from = raw.fallback_from;
      addWarning(master, raw.fallback_reason);
    }

    // ── Không có dữ liệu: phân loại ĐÚNG nguyên nhân ────────────────────────
    if (!node) {
      const meta = metaTags(html);
      const title = decodeHtmlEntities(meta['og:title'] || '') || pageTitle(html);
      const isHomepage =
        parsed.notExist === true ||
        (title && HOMEPAGE_TITLES.some((t) => title.toLowerCase().includes(t))) ||
        /\/tbhome\/oversea\/home/.test(html);

      if (isHomepage) {
        master.extraction.method = 'homepage-redirect-detection';
        this.markNotFound(master, ['title_original', 'description_original']);
        master.extraction.field_status = {
          ...(master.extraction.field_status || {}),
          images: STATUS.NOT_FOUND,
          videos: STATUS.NOT_FOUND,
          variants: STATUS.NOT_FOUND,
          attributes: STATUS.NOT_FOUND,
          price: STATUS.NOT_FOUND,
          store: STATUS.NOT_FOUND,
        };
        addWarning(master, 'Taobao chuyển hướng về trang chủ — mã sản phẩm không tồn tại hoặc đã bị gỡ.');
        return master;
      }

      if (cls.antibot) {
        master.extraction.blocked_reason = `Taobao anti-bot (x5sec/TMD): ${cls.markers.slice(0, 3).join(', ')}`;
        this.markLoginRequired(master, 'Taobao yêu cầu vượt anti-bot x5sec — cần session trình duyệt thật.');
      } else if (cls.login) {
        this.markLoginRequired(master, 'Taobao yêu cầu đăng nhập — cần session trình duyệt thật (SESSION_MODE=cdp).');
      } else if (meta['og:title']) {
        // Trang tĩnh chỉ có thẻ meta — vẫn là dữ liệu thật, chỉ thiếu chiều sâu.
        master.title_original = decodeHtmlEntities(meta['og:title']);
        master.title_original_status = STATUS.FOUND;
        master.extraction.method = 'meta-tags-only';
        if (meta['og:image']) master.images.push(image(normalizeImageUrl(meta['og:image'], finalUrl), 'cover'));
        if (meta['og:description']) {
          master.description_original = decodeHtmlEntities(meta['og:description']).slice(0, 20000);
          master.description_original_status = STATUS.FOUND;
        }
        addWarning(master, 'Chỉ lấy được thẻ meta — không có khối dữ liệu SSR đầy đủ.');
      } else {
        this.markNotFound(master, ['title_original', 'description_original']);
        addWarning(master, 'Không tìm thấy dữ liệu sản phẩm Taobao trong trang.');
      }
      return master;
    }

    // ── Có dữ liệu sản phẩm thật ────────────────────────────────────────────
    master.extraction.method =
      parsed.source + (raw.method?.includes('world.taobao-fallback') ? '+world.taobao-fallback' : '');

    const itemNode = deepFind(node, ['item'], (v) => v && typeof v === 'object')?.value || node;

    const title = findString(itemNode, ['title', 'itemTitle']) || findString(node, ['title']);
    if (title) {
      master.title_original = stripHtml(title).slice(0, 500);
      master.title_original_status = STATUS.FOUND;
    }

    // ── Ảnh: item.images (mảng URL) + og:image + ảnh trong mô tả ────────────
    const imgBlock = deepFind(itemNode, ['images', 'imageList', 'itemImages'], (v) => Array.isArray(v));
    const urls = [];
    if (imgBlock) {
      for (const x of imgBlock.value) {
        const u = typeof x === 'string' ? x : x?.url || x?.picUrl || x?.img || '';
        const norm = normalizeImageUrl(u, finalUrl);
        if (norm) urls.push(norm);
      }
    }
    const meta = metaTags(html);
    if (meta['og:image']) {
      const og = normalizeImageUrl(meta['og:image'], finalUrl);
      if (og) urls.push(og);
    }
    const detailHtml = findString(node, ['longDescription', 'description', 'detailHtml'], { maxDepth: 6 }) || '';
    const detailImgs = /<img/i.test(detailHtml) ? imagesInHtml(detailHtml, finalUrl).slice(0, 60) : [];

    [...new Set(urls)].forEach((u, i) => master.images.push(image(u, i === 0 ? 'cover' : 'gallery')));
    detailImgs.forEach((u) => master.images.push(image(u, 'detail')));

    // ── Giá — Taobao trả originalPrice / promotionPrice / hasRangePrice ─────
    const priceNode = deepFind(node, ['itemPrice'], (v) => v && typeof v === 'object')?.value;
    if (priceNode) {
      const promo = String(priceNode.promotionPrice ?? '').trim();
      const orig = String(priceNode.originalPrice ?? '').trim();
      const rawPrice = promo || orig;
      if (rawPrice) {
        const { kind } = classifyPrice(rawPrice);
        master.price = mkPrice({
          raw: rawPrice,
          currency: 'CNY',
          status: STATUS.FOUND,
          kind: priceNode.hasRangePrice === true ? 'range' : kind,
        });
        if (priceNode.remark) {
          master.attributes.push(attribute({ name: 'Ghi chú giá (sàn)', value: String(priceNode.remark) }));
        }
      }
    } else {
      const pt = findString(node, ['priceText', 'price'], { maxDepth: 5 }) || '';
      if (pt) {
        const { kind, currency } = classifyPrice(pt);
        master.price = mkPrice({ raw: pt, currency, status: STATUS.FOUND, kind });
      }
    }

    // ── Người bán ───────────────────────────────────────────────────────────
    const seller = deepFind(node, ['seller'], (v) => v && typeof v === 'object')?.value;
    if (seller) {
      const shopName = findString(seller, ['shopName', 'nick', 'sellerNick']);
      const shopId = findString(seller, ['shopId', 'userId', 'sellerId']);
      if (shopName) {
        master.store = {
          name: shopName,
          id: shopId || '',
          url: findString(seller, ['shopUrl', 'taoShopUrl']) || '',
          status: STATUS.FOUND,
        };
      }
    }

    // ── Thuộc tính THẬT lấy từ trang ────────────────────────────────────────
    const location = findString(itemNode, ['location']);
    if (location) master.attributes.push(attribute({ name: 'Nơi xuất xứ (theo sàn)', value: location }));

    const rate = deepFind(node, ['rate'], (v) => v && typeof v === 'object')?.value;
    if (rate && (rate.goodPercent !== undefined || rate.goodCount !== undefined)) {
      const good = rate.goodPercent ?? rate.goodCount;
      const bad = rate.badCount !== undefined ? `, ${rate.badCount} lượt chê` : '';
      master.attributes.push(attribute({ name: 'Đánh giá trên sàn', value: `${good}${bad}` }));
    }

    // ── Mô tả + điểm bán hàng do chính sàn sinh ─────────────────────────────
    // `aibModuleResponse` nằm ở `loaderData.pdp-pc.data.httpData`, TỨC LÀ BÊN NGOÀI
    // `normalItemResponse` — phải tìm trên cả cây ICE, không chỉ trong node item.
    const aib =
      deepFind(parsed.ice || node, ['aibModuleResponse'], (v) => v && typeof v === 'object')?.value ||
      deepFind(node, ['aibModuleResponse'], (v) => v && typeof v === 'object')?.value;
    const descParts = [];
    for (const src of [aib, node]) {
      if (!src) continue;
      const long = findString(src, ['longDescription', 'description'], { maxDepth: 5 });
      if (long && !descParts.includes(long)) descParts.push(long);
      const sellPoint = deepFind(src, ['sellPoint'], (v) => Array.isArray(v) && v.length > 0);
      if (sellPoint) {
        for (const sp of sellPoint.value.slice(0, 10)) {
          master.attributes.push(attribute({ name: 'Điểm bán hàng (sàn)', value: String(sp) }));
        }
      }
      const kw = findString(src, ['keywords', 'keyword'], { maxDepth: 4 });
      if (kw) {
        let value = kw;
        try {
          const arr = JSON.parse(kw);
          if (Array.isArray(arr)) value = arr.join(', ');
        } catch {
          /* giữ nguyên chuỗi */
        }
        master.attributes.push(attribute({ name: 'Từ khoá (sàn)', value }));
      }
    }
    if (descParts.length > 0) {
      master.description_original = stripHtml(descParts.join('\n\n')).slice(0, 20000);
      master.description_original_status = STATUS.FOUND;
      addWarning(
        master,
        'Mô tả lấy từ module mô tả của Taobao (aibModuleResponse) — nội dung do SÀN sinh, không phải mô tả gốc của người bán.',
      );
    }

    // ── SKU / biến thể (chỉ khi trang thật sự có) ───────────────────────────
    const skuBlock = deepFind(node, ['skus', 'skuList'], (v) => Array.isArray(v) && v.length > 0);
    if (skuBlock) {
      for (const s of skuBlock.value.slice(0, 200)) {
        if (!s || typeof s !== 'object') continue;
        master.variants.push(
          variant({
            skuId: String(s.skuId ?? s.sku_id ?? ''),
            name: String(s.name ?? s.skuName ?? ''),
            priceRaw: String(s.price ?? s.priceText ?? ''),
          }),
        );
      }
    }

    // ── Video: CHỈ nhận khi thật sự có URL. Không suy diễn, không dựng. ────
    const vid = deepFind(node, ['videoUrl', 'video_url', 'mainVideo'], (v) => typeof v === 'string' && /^https?:/.test(v));
    if (vid) master.videos.push(video(vid.value, 'main', STATUS.FOUND, PROVENANCE.SOURCE));
    else master.extraction.field_status = { ...(master.extraction.field_status || {}), videos: STATUS.NOT_FOUND };

    if (master.images.length === 0) {
      master.extraction.field_status = { ...(master.extraction.field_status || {}), images: STATUS.NOT_FOUND };
    }
    return master;
  }
}

export default TaobaoConnector;
