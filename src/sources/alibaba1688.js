/**
 * G04 — 1688 CONNECTOR.
 *
 * Thực tế đã đo được (03/10/2026):
 *   - `detail.1688.com/offer/<id>.html` với id SAI → redirect sang
 *     `page.1688.com/shtml/static/wrongpage.html` (đây là tín hiệu NOT_FOUND đáng tin).
 *   - Với id ĐÚNG, trang trả về HTML thật có JSON nhúng.
 *   ⇒ 1688 là nguồn khả thi nhất trong ba nguồn khi truy cập ẩn danh.
 *
 * Lưu ý về giá: 1688 hầu như luôn hiển thị giá theo BẬC SỐ LƯỢNG (price tiers)
 * hoặc dạng khoảng. Connector này phân loại `price.kind` = tier|range|fixed và
 * giữ nguyên `tiers`, KHÔNG bao giờ gộp bậc thành một "giá cố định".
 */

import {
  ProductSourceConnector,
  classifyPage,
  extractInlineJson,
  pageTitle,
  normalizeImageUrl,
} from './base-connector.js';
import { STATUS, addWarning, image, video, variant, attribute, price as mkPrice } from '../product-master.js';
import {
  classifyPrice,
  decodeHtmlEntities,
  deepFind,
  findNumber,
  findScalar,
  findString,
  imagesInHtml,
  metaTags,
  stripHtml,
} from './parsers/util.js';

const ALIBABA_COOKIE_DOMAINS = ['1688.com', 'alibaba.com'];

export class Alibaba1688Connector extends ProductSourceConnector {
  static source = '1688';
  static displayName = '1688';

  homeUrl() {
    return 'https://www.1688.com/';
  }

  cookieDomains() {
    return ALIBABA_COOKIE_DOMAINS;
  }

  /** 1688 cần Referer từ s.1688.com mới trả trang thật (đã đo). */
  headers(ctx = {}) {
    return { ...super.headers(ctx), referer: 'https://s.1688.com/' };
  }

  /**
   * Phân loại phản hồi 1688 theo DUNG LƯỢNG — tín hiệu phân biệt nhanh và đáng tin
   * nhất, vì 1688 không luôn trả wrongpage mà có thể trả tường đăng nhập hoặc
   * challenge anti-bot, cả ba đều HTTP 200:
   *   > 50KB  → trang offer thật
   *   ~4822B  → tường đăng nhập
   *   ~2825B  → challenge x5sec ("punish")
   *   redirect page.1688.com/.../wrongpage.html → offer không tồn tại
   */
  classifyBySize(bytes, html, cls) {
    const text = String(html || '');
    if (bytes < 8000) {
      // Kiểm dấu hiệu ĐẶC THÙ trước: tường đăng nhập có `"action":"login"`, còn
      // challenge anti-bot có x5sec/punish. Thứ tự quan trọng vì trang tường đăng
      // nhập cũng có thể chứa chữ "captcha" trong bundle JS của nó.
      if (/"action"\s*:\s*"login"|login\.1688\.com|请登录/i.test(text)) return 'LOGIN';
      if (/x5secdata|punish|_____tmd_____|验证码|captcha/i.test(text)) return 'ANTIBOT';
      if (bytes < 6000) return 'ANTIBOT';
    }
    if (cls?.login) return 'LOGIN';
    if (cls?.antibot) return 'ANTIBOT';
    return 'UNKNOWN';
  }

  /** Lấy object dữ liệu nhúng của trang offer 1688. */
  parseOfferJson(html) {
    const NAMES = [
      '__INIT_DATA__',
      '__GLOBAL_DATA__',
      'iDataOffer',
      '__INITIAL_STATE__',
      'detailData',
      'offerData',
      'runParams',
    ];
    for (const name of NAMES) {
      const json = extractInlineJson(html, [name]);
      if (json && typeof json === 'object') {
        // Ưu tiên nhánh có vẻ chứa offer
        const holder = deepFind(json, ['offerDetail', 'offer', 'detail', 'data'], (v) => v && typeof v === 'object');
        if (holder && (deepFind(holder.value, ['offerId', 'subject', 'title'], (v) => v !== null))) {
          return holder.value;
        }
        if (deepFind(json, ['offerId', 'subject'], (v) => v !== null)) return json;
      }
    }
    return null;
  }

  normalize(raw, master) {
    const html = raw.html || '';
    const finalUrl = raw.finalUrl || '';

    // ── Tín hiệu mạnh nhất: redirect sang wrongpage = sản phẩm không tồn tại ──
    if (/page\.1688\.com\/shtml\/static\/wrongpage\.html/i.test(finalUrl) || /wrongpage/i.test(finalUrl)) {
      master.extraction.method = 'redirect-detection';
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
      addWarning(master, '1688 chuyển hướng sang trang "wrongpage" — offer không tồn tại hoặc đã bị gỡ.');
      return master;
    }

    const cls = classifyPage(html, { url: finalUrl });
    const offer = this.parseOfferJson(html);

    if (!offer) {
      // Không có JSON → phân loại nguyên nhân theo dung lượng phản hồi.
      const meta = metaTags(html);
      const ogTitle = decodeHtmlEntities(meta['og:title'] || '') || pageTitle(html);
      if (ogTitle && !/1688|阿里巴巴/i.test(ogTitle)) {
        master.title_original = ogTitle;
        master.title_original_status = STATUS.FOUND;
      }
      if (meta['og:image']) master.images.push(image(normalizeImageUrl(meta['og:image'], finalUrl), 'cover'));

      const kind = this.classifyBySize(master.extraction.bytes || html.length, html, cls);
      if (kind === 'ANTIBOT') {
        master.extraction.blocked_reason =
          `1688 trả challenge anti-bot (x5sec/punish, ${master.extraction.bytes || html.length} byte). ` +
          '1688 giới hạn tần suất rất chặt: request đầu từ một IP thường trả trang thật, các request sau bị chặn.';
        this.markLoginRequired(
          master,
          '1688 chặn anti-bot (x5sec/punish). Cần chờ hoặc dùng session trình duyệt thật (SESSION_MODE=cdp).',
        );
      } else if (kind === 'LOGIN') {
        this.markLoginRequired(master, '1688 yêu cầu đăng nhập cho offer này — cần session trình duyệt thật.');
      } else if (master.images.length === 0) {
        // Trang thật nhưng không tìm thấy JSON nhúng → có thể cấu trúc đã đổi.
        this.markNotFound(master, ['title_original', 'description_original']);
        addWarning(
          master,
          `Không tìm thấy JSON nhúng của 1688 (${master.extraction.bytes || html.length} byte) — cấu trúc trang có thể đã đổi.`,
        );
      }
      return master;
    }

    master.extraction.method = 'html-inline-json';

    const title = findString(offer, ['subject', 'title', 'offerTitle', 'name']);
    if (title) {
      master.title_original = stripHtml(title).slice(0, 500);
      master.title_original_status = STATUS.FOUND;
    }

    // ── Ảnh: cover + gallery ────────────────────────────────────────────────
    const cover =
      findString(offer, ['image', 'coverImage', 'mainImage', 'offerImg', 'picUrl'], { maxDepth: 5 }) || '';
    const galleryBlock = deepFind(
      offer,
      ['imageList', 'images', 'offerImgList', 'gallery', 'picList'],
      (v) => Array.isArray(v),
    );
    const gallery = galleryBlock
      ? galleryBlock.value
          .map((x) => (typeof x === 'string' ? x : x?.url || x?.fullPathImageURI || x?.imageURI || x?.img || ''))
          .map((u) => normalizeImageUrl(u, finalUrl))
          .filter(Boolean)
      : [];

    const coverUrl = normalizeImageUrl(cover, finalUrl);
    if (coverUrl) {
      master.images.push(image(coverUrl, 'cover'));
      gallery.forEach((u) => {
        if (u !== coverUrl) master.images.push(image(u, 'gallery'));
      });
    } else if (gallery.length > 0) {
      // 1688 không phải lúc nào cũng có field ảnh bìa riêng — khi đó ảnh ĐẦU TIÊN
      // của gallery chính là ảnh bìa. Không suy diễn gì thêm, chỉ đặt đúng nhãn.
      gallery.forEach((u, i) => master.images.push(image(u, i === 0 ? 'cover' : 'gallery')));
    }

    // ── Ảnh chi tiết: nằm trong HTML mô tả ─────────────────────────────────
    const descHtml = findString(offer, ['detailHtml', 'description', 'desc', 'offerDetailHtml'], { maxDepth: 7 }) || '';
    if (descHtml && /<img/i.test(descHtml)) {
      for (const u of imagesInHtml(descHtml, finalUrl).slice(0, 80)) {
        master.images.push(image(u, 'detail'));
      }
      master.description_original = stripHtml(descHtml).slice(0, 20000);
      master.description_original_status = master.description_original ? STATUS.FOUND : STATUS.NOT_FOUND;
    }

    // ── Giá theo bậc (price tiers) — đặc trưng của 1688 ────────────────────
    const tierBlock = deepFind(
      offer,
      ['priceRanges', 'priceRange', 'priceTiers', 'ladderPrice', 'priceList'],
      (v) => Array.isArray(v) && v.length > 0,
    );
    const priceText = findString(offer, ['price', 'priceText', 'showPrice', 'currentPrice'], { maxDepth: 5 }) || '';

    if (tierBlock) {
      const tiers = tierBlock.value
        .map((t) => {
          if (!t || typeof t !== 'object') return null;
          const min = Number(t.beginAmount ?? t.startQuantity ?? t.minQuantity ?? t.begin ?? NaN);
          const max = Number(t.endAmount ?? t.endQuantity ?? t.maxQuantity ?? t.end ?? NaN);
          const p = Number(t.price ?? t.unitPrice ?? t.priceValue ?? NaN);
          return {
            min_quantity: Number.isFinite(min) ? min : null,
            max_quantity: Number.isFinite(max) ? max : null,
            price: Number.isFinite(p) ? p : null,
          };
        })
        .filter((t) => t && t.price !== null);
      if (tiers.length > 0) {
        const prices = tiers.map((t) => t.price);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        master.price = mkPrice({
          raw: min === max ? `¥${min}` : `¥${min}-${max}`,
          currency: 'CNY',
          status: STATUS.FOUND,
          kind: 'tier',
          tiers,
        });
      }
    } else if (priceText) {
      const { kind, currency } = classifyPrice(priceText);
      master.price = mkPrice({ raw: String(priceText), currency, status: STATUS.FOUND, kind });
    }

    // ── MOQ (số lượng đặt tối thiểu) — 1688 rất hay có ─────────────────────
    const moq = findNumber(offer, [
      'minOrderQuantity',
      'beginAmount',
      'minOrder',
      'startQuantity',
      'minimumOrderQuantity',
    ]);
    if (moq !== null) {
      master.attributes.push(attribute({ name: 'MOQ', value: String(moq) }));
    }

    // ── SKU / biến thể ─────────────────────────────────────────────────────
    const skuMap = deepFind(offer, ['skuInfoMap', 'skuMap', 'skuInfos'], (v) => v && typeof v === 'object');
    if (skuMap) {
      const entries = Array.isArray(skuMap.value) ? skuMap.value : Object.entries(skuMap.value);
      for (const entry of entries.slice(0, 200)) {
        if (Array.isArray(skuMap.value)) {
          const s = entry;
          if (!s || typeof s !== 'object') continue;
          master.variants.push(
            variant({
              skuId: String(s.skuId ?? s.specId ?? ''),
              name: String(s.name ?? s.specAttrs ?? ''),
              priceRaw: String(s.price ?? ''),
            }),
          );
        } else {
          const [key, val] = entry;
          if (!val || typeof val !== 'object') continue;
          master.variants.push(
            variant({
              skuId: String(val.skuId ?? val.specId ?? ''),
              name: String(key),
              priceRaw: String(val.price ?? val.discountPrice ?? ''),
              attributes: { spec: String(key) },
            }),
          );
        }
      }
    }

    // ── Thuộc tính sản phẩm ────────────────────────────────────────────────
    const attrBlock = deepFind(
      offer,
      ['productAttribute', 'attributes', 'offerAttributes', 'props'],
      (v) => Array.isArray(v),
    );
    if (attrBlock) {
      for (const a of attrBlock.value.slice(0, 100)) {
        if (!a || typeof a !== 'object') continue;
        const name = a.attributeName ?? a.name ?? a.key;
        const value = a.attributeValue ?? a.value ?? a.values;
        if (name && value !== undefined && value !== null && value !== '') {
          master.attributes.push(
            attribute({ name: String(name), value: String(Array.isArray(value) ? value.join(', ') : value) }),
          );
        }
      }
    }

    // ── Nhà cung cấp / cửa hàng (chỉ khi công khai) ────────────────────────
    const supplier = deepFind(offer, ['seller', 'supplier', 'company', 'sellerInfo'], (v) => v && typeof v === 'object');
    if (supplier) {
      const shopName = findString(supplier.value, ['companyName', 'shopName', 'sellerNick', 'name', 'loginId']);
      const shopId = findScalar(supplier.value, ['sellerId', 'memberId', 'companyId', 'userId']);
      if (shopName) master.store = { name: shopName, id: shopId || '', url: '', status: STATUS.FOUND };
    }

    // ── Video (nếu trang thật sự có) ───────────────────────────────────────
    const vid =
      findString(offer, ['videoUrl', 'video_url', 'mainVideoUrl'], { maxDepth: 6 }) ||
      (() => {
        const m = /https?:\/\/[^"'\s]+\.mp4/i.exec(html);
        return m ? m[0] : '';
      })();
    if (vid) master.videos.push(video(vid, 'main'));
    else master.extraction.field_status = { ...(master.extraction.field_status || {}), videos: STATUS.NOT_FOUND };

    if (cls.antibot && master.images.length === 0) {
      this.markLoginRequired(master, '1688 chặn anti-bot một phần.');
    }
    return master;
  }
}

export default Alibaba1688Connector;
