/**
 * G05 — PINDUODUO CONNECTOR (adapter ĐỘC LẬP).
 *
 * Pinduoduo khác hẳn Taobao/1688 ở chỗ dữ liệu sản phẩm KHÔNG có trong HTML tĩnh:
 * trang trả về một shell rồi JS mới nạp dữ liệu. Vì vậy connector này thử theo
 * đúng thứ tự mà đề bài yêu cầu:
 *
 *   1. canonical link resolution        → resolve short link/share link
 *   2. public/SSR page data             → đọc JSON nhúng nếu có (rawData/__INITIAL_STATE__)
 *   3. browser network data             → render bằng CDP rồi đọc DOM/JSON sau render
 *   4. authenticated browser-session    → dùng cookie Chrome đã đăng nhập
 *
 * Nếu tới bước 4 vẫn không được → báo LOGIN_REQUIRED, KHÔNG báo thành công.
 *
 * VIDEO: nếu không thật sự tìm thấy URL video thì `main_video.status = NOT_FOUND`.
 * TUYỆT ĐỐI không dựng URL video giả.
 */

import {
  ProductSourceConnector,
  classifyPage,
  extractInlineJson,
  normalizeImageUrl,
} from './base-connector.js';
import { STATUS, PROVENANCE, addWarning, image, video, variant, attribute, price as mkPrice } from '../product-master.js';
import {
  classifyPrice,
  decodeHtmlEntities,
  deepFind,
  findNumber,
  findString,
  imagesInHtml,
  metaTags,
  stripHtml,
} from './parsers/util.js';

const PDD_COOKIE_DOMAINS = ['yangkeduo.com', 'pinduoduo.com'];

export class PinduoduoConnector extends ProductSourceConnector {
  static source = 'pinduoduo';
  static displayName = 'Pinduoduo';

  homeUrl() {
    return 'https://mobile.yangkeduo.com/';
  }

  cookieDomains() {
    return PDD_COOKIE_DOMAINS;
  }

  /** Bước 1: resolve link chia sẻ / short link của PDD. */
  async resolveUrl(url, ctx = {}) {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return { url, redirects: [] };
    }
    const isShort = ['p.pinduoduo.com', 'yangkeduo.com', 'pinduoduo.com'].some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
    const needsResolve = isShort && !/goods_id=/i.test(url);
    if (!needsResolve) return { url, redirects: [] };

    // Thử render trước nếu có CDP (link chia sẻ PDD thường là trang trung gian chạy JS).
    if (this.session?.capabilities?.render && ctx.allowSession !== false) {
      try {
        const rendered = await this.session.renderPage(url, { waitMs: 2500 });
        const m = /goods_id=(\d+)/i.exec(rendered.finalUrl || '') || /goods_id=(\d+)/i.exec(rendered.html || '');
        if (m) return { url: `https://mobile.yangkeduo.com/goods.html?goods_id=${m[1]}`, redirects: [rendered.finalUrl] };
      } catch (err) {
        this.logger?.warn('pdd.render_resolve_failed', { error: err });
      }
    }

    const res = await this._fetch(url, {
      maxRedirects: this.config?.net?.maxRedirects ?? 5,
      timeoutMs: this.config?.net?.fetchTimeoutMs ?? 20000,
      maxBytes: 2 * 1024 * 1024,
      allowPrivateNetwork: this.config?.net?.allowPrivateNetwork ?? false,
      headers: this.headers(),
      cookieHeader: await this.getCookieHeader(url, ctx),
      cookieDomains: this.cookieDomains(),
    });
    const m = /goods_id=(\d+)/i.exec(res.finalUrl || '') || /goods_id=(\d+)/i.exec(res.body.toString('utf8'));
    return {
      url: m ? `https://mobile.yangkeduo.com/goods.html?goods_id=${m[1]}` : res.finalUrl || url,
      redirects: res.redirects || [],
    };
  }

  /** Bước 2 & 3: tải dữ liệu, ưu tiên render nếu có session. */
  async fetchProduct(url, ctx = {}) {
    // Thử SSR tĩnh trước — rẻ và không cần session.
    let staticRaw = null;
    try {
      staticRaw = await super.fetchProduct(url, ctx);
    } catch (err) {
      this.logger?.warn('pdd.static_fetch_failed', { error: err });
    }

    const staticHasData = staticRaw ? this.looksLikeProductData(staticRaw.html) : false;

    // Nếu HTML tĩnh không có dữ liệu sản phẩm và có CDP → render bằng trình duyệt thật.
    if (!staticHasData && this.session?.capabilities?.render && ctx.allowSession !== false) {
      try {
        const rendered = await this.session.renderPage(url, { waitMs: ctx.renderWaitMs ?? 4000 });
        if (rendered?.html) {
          return {
            html: rendered.html,
            status: 200,
            finalUrl: rendered.finalUrl || url,
            redirects: [],
            bytes: rendered.html.length,
            method: 'cdp-render',
            static_fallback: staticRaw ? { status: staticRaw.status, bytes: staticRaw.bytes } : null,
          };
        }
      } catch (err) {
        this.logger?.warn('pdd.render_failed', { error: err });
      }
    }

    if (!staticRaw) {
      throw new Error('Không tải được trang Pinduoduo (cả tĩnh lẫn render).');
    }
    return staticRaw;
  }

  /** Dấu hiệu HTML đã chứa dữ liệu sản phẩm thật (không phải shell rỗng). */
  looksLikeProductData(html) {
    if (!html) return false;
    const hasGoods = /"goods_id"\s*:\s*\d+/.test(html) || /"goodsId"\s*:\s*"?\d+/.test(html);
    const hasName = /"goods_name"|"goodsName"/.test(html);
    const hasSku = /"skus"\s*:|"sku_list"/.test(html);
    return (hasGoods && hasName) || (hasName && hasSku);
  }

  /** Tìm object sản phẩm trong các biến toàn cục đã biết của PDD. */
  parseGoodsJson(html) {
    const NAMES = [
      'rawData',
      '__INITIAL_STATE__',
      '__NEXT_DATA__',
      '__PRELOADED_STATE__',
      'window._g',
      'initData',
      'goodsData',
    ];
    for (const name of NAMES) {
      const json = extractInlineJson(html, [name]);
      if (json && typeof json === 'object') {
        const holder = deepFind(json, ['goods', 'goodsInfo', 'goodsDetail', 'store'], (v) => v && typeof v === 'object');
        if (holder && deepFind(holder.value, ['goodsName', 'goods_name', 'goodsId', 'goods_id'], (v) => v != null)) {
          return holder.value;
        }
        if (deepFind(json, ['goodsName', 'goods_name'], (v) => v != null)) return json;
      }
    }
    return null;
  }

  normalize(raw, master) {
    const html = raw.html || '';
    const finalUrl = raw.finalUrl || '';
    const cls = classifyPage(html, { url: finalUrl });
    const goods = this.parseGoodsJson(html);

    // ── Không có dữ liệu: phân loại ĐÚNG nguyên nhân ────────────────────────
    if (!goods) {
      master.extraction.field_status = {
        ...(master.extraction.field_status || {}),
        images: STATUS.LOGIN_REQUIRED,
        videos: STATUS.NOT_FOUND,
        variants: STATUS.LOGIN_REQUIRED,
        attributes: STATUS.LOGIN_REQUIRED,
        price: STATUS.LOGIN_REQUIRED,
        store: STATUS.LOGIN_REQUIRED,
      };
      if (cls.antibot || cls.login) {
        this.markLoginRequired(
          master,
          'Pinduoduo trả về trang yêu cầu đăng nhập/xác minh. Cần SESSION_MODE=cdp với Chrome đã đăng nhập.',
        );
        if (cls.antibot) {
          master.extraction.blocked_reason = `Pinduoduo anti-bot/verify: ${cls.markers.slice(0, 3).join(', ')}`;
        }
      } else {
        this.markLoginRequired(
          master,
          'Pinduoduo không nhúng dữ liệu sản phẩm trong HTML tĩnh (trang chỉ có shell JS). Cần render bằng trình duyệt.',
        );
      }
      addWarning(master, `Phương thức tải đã dùng: ${raw.method || 'http-get'}.`);
      return master;
    }

    // ── Có dữ liệu sản phẩm ────────────────────────────────────────────────
    master.extraction.method = raw.method === 'cdp-render' ? 'cdp-render+inline-json' : 'html-inline-json';

    const title = findString(goods, ['goodsName', 'goods_name', 'title', 'goodsTitle']);
    if (title) {
      master.title_original = stripHtml(decodeHtmlEntities(title)).slice(0, 500);
      master.title_original_status = STATUS.FOUND;
    }

    // Ảnh: PDD dùng viewImageData / goodsGallery / topGallery
    const galleryBlock = deepFind(
      goods,
      ['viewImageData', 'goodsGallery', 'topGallery', 'gallery', 'images', 'detailGallery'],
      (v) => Array.isArray(v) && v.length > 0,
    );
    if (galleryBlock) {
      const urls = galleryBlock.value
        .map((x) => (typeof x === 'string' ? x : x?.url || x?.imageUrl || x?.imgUrl || x?.hdUrl || ''))
        .map((u) => normalizeImageUrl(u, finalUrl))
        .filter(Boolean);
      urls.forEach((u, i) => master.images.push(image(u, i === 0 ? 'cover' : 'gallery')));
    }

    // Ảnh mô tả chi tiết
    const descHtml = findString(goods, ['goodsDesc', 'detailHtml', 'description', 'goodsDescription'], { maxDepth: 7 }) || '';
    if (descHtml && /<img/i.test(descHtml)) {
      for (const u of imagesInHtml(descHtml, finalUrl).slice(0, 80)) {
        master.images.push(image(u, 'detail'));
      }
      master.description_original = stripHtml(descHtml).slice(0, 20000);
      master.description_original_status = master.description_original ? STATUS.FOUND : STATUS.NOT_FOUND;
    }

    // ── Giá: PDD hay hiển thị khoảng (min–max) và giá sau khuyến mãi ────────
    const priceText = findString(goods, ['price', 'priceText', 'minPrice', 'groupPrice', 'priceRange'], { maxDepth: 6 }) || '';
    const minPrice = findNumber(goods, ['minPrice', 'minGroupPrice', 'price']);
    const maxPrice = findNumber(goods, ['maxPrice', 'maxGroupPrice', 'marketPrice']);
    if (priceText) {
      const { kind, currency } = classifyPrice(priceText);
      master.price = mkPrice({ raw: String(priceText), currency, status: STATUS.FOUND, kind });
    } else if (minPrice !== null) {
      const isRange = maxPrice !== null && maxPrice !== minPrice;
      master.price = mkPrice({
        raw: isRange ? `¥${minPrice}-${maxPrice}` : `¥${minPrice}`,
        currency: 'CNY',
        status: STATUS.FOUND,
        kind: isRange ? 'range' : 'fixed',
      });
    }

    // ── SKU / biến thể ─────────────────────────────────────────────────────
    const skuBlock = deepFind(goods, ['skus', 'sku_list', 'skuList'], (v) => Array.isArray(v) && v.length > 0);
    if (skuBlock) {
      for (const s of skuBlock.value.slice(0, 200)) {
        if (!s || typeof s !== 'object') continue;
        master.variants.push(
          variant({
            skuId: String(s.skuId ?? s.sku_id ?? s.skuID ?? ''),
            name: String(s.specs?.map?.((x) => x.spec_value ?? x.specValue).filter(Boolean).join(' / ') ?? s.skuName ?? ''),
            priceRaw: String(s.groupPrice ?? s.price ?? s.normalPrice ?? ''),
          }),
        );
      }
    }

    // ── Thuộc tính hiển thị ────────────────────────────────────────────────
    const attrBlock = deepFind(goods, ['goodsProperty', 'properties', 'attributes', 'goodsAttrs'], (v) => Array.isArray(v));
    if (attrBlock) {
      for (const a of attrBlock.value.slice(0, 80)) {
        if (!a || typeof a !== 'object') continue;
        const name = a.key ?? a.name ?? a.propertyName;
        const value = a.values?.join?.(', ') ?? a.value ?? a.propertyValue;
        if (name && value) master.attributes.push(attribute({ name: String(name), value: String(value) }));
      }
    }

    // ── Cửa hàng ───────────────────────────────────────────────────────────
    const mall = deepFind(goods, ['mall', 'mallInfo', 'store', 'shopInfo'], (v) => v && typeof v === 'object');
    if (mall) {
      const shopName = findString(mall.value, ['mallName', 'mall_name', 'shopName', 'storeName']);
      const shopId = findString(mall.value, ['mallId', 'mall_id', 'shopId']);
      if (shopName) master.store = { name: shopName, id: shopId || '', url: '', status: STATUS.FOUND };
    }

    // ── VIDEO: chỉ nhận khi THẬT SỰ có URL. Không suy diễn, không dựng. ────
    const vid =
      findString(goods, ['videoUrl', 'video_url', 'mainVideoUrl', 'goodsVideo'], { maxDepth: 7 }) ||
      (() => {
        const m = /https?:\/\/[^"'\s\\]+\.(?:mp4|m3u8)/i.exec(html);
        return m ? m[0].replace(/\\u002F/gi, '/') : '';
      })();
    if (vid && /^https?:\/\//i.test(vid)) {
      master.videos.push(video(vid, 'main', STATUS.FOUND, PROVENANCE.SOURCE));
    } else {
      master.extraction.field_status = { ...(master.extraction.field_status || {}), videos: STATUS.NOT_FOUND };
    }

    if (master.images.length === 0 && !title) {
      this.markLoginRequired(master, 'Pinduoduo trả về dữ liệu rỗng — có thể cần session đăng nhập.');
    }
    return master;
  }
}

export default PinduoduoConnector;
