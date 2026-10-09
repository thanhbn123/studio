/**
 * Provider `facebook` — ĐĂNG LÊN FACEBOOK PAGE qua Graph API (hợp đồng §2.5).
 *
 * ⚠️ TRẠNG THÁI THẬT KHI VIẾT FILE NÀY: dự án **CHƯA có Page ID + Page Access Token** (cần
 * Facebook app review). Vì vậy đường mã này **CHƯA từng gọi API thật một lần nào** — nó được
 * kiểm bằng server HTTP giả trong test. Xem `docs/VERIFICATION.md` §27.
 *
 * Bốn luật của file này:
 *   1. **Thiếu token ⇒ KHÔNG gọi mạng.** `configured = false` được kiểm TRƯỚC khi dựng URL;
 *      trả `NOT_CONFIGURED` và KHÔNG bịa `post_id`.
 *   2. **Lỗi nền tảng giữ NGUYÊN VĂN.** `error.message` của Facebook được đưa thẳng vào
 *      `error_message` (sau `maskToken`), kèm `error.code`/`error_subcode` trong `raw`.
 *   3. **Token chỉ nằm trong THÂN request.** Không vào URL (query string đi vào access log của
 *      proxy), không vào log, không vào `raw`, không vào `error_message` — `maskToken()` là lưới
 *      cuối cùng, áp cho MỌI chuỗi trả ra.
 *   4. **Chống SSRF.** Đi qua `safeFetch` với allowlist = ĐÚNG host của `baseUrl` đã cấu hình
 *      (mặc định `graph.facebook.com`) và `allowPrivateNetwork = false`.
 */

import { DEFAULT_CHANNEL, normalizePublishText, normalizeSchedule } from '../items.js';
import { safeFetch } from '../../security/fetcher.js';

/** Phiên bản Graph API mặc định (khai ở đây để test và tài liệu dùng chung một nguồn). */
export const DEFAULT_API_VERSION = 'v21.0';
export const DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';

export const FACEBOOK_NOT_CONFIGURED_MESSAGE =
  'Chưa cấu hình Facebook (cần Page ID + Page Access Token). Khai FACEBOOK_PAGE_ID và '
  + 'FACEBOOK_PAGE_ACCESS_TOKEN rồi khởi động lại — chưa có hai giá trị này thì hệ thống KHÔNG đăng gì.';

/**
 * Che access token trong một chuỗi bất kỳ.
 *
 * Gọi ở MỌI đường ra (log, `error_message`, `raw`): Facebook có trả lại token trong thông báo lỗi
 * của một số mã (ví dụ token hết hạn), nên không che là rò secret vào DB và vào UI.
 */
export function maskToken(value, token) {
  let s = typeof value === 'string' ? value : String(value ?? '');
  const t = String(token ?? '');
  if (t.length >= 6) s = s.split(t).join('<token>');
  // Lưới chung: bất kỳ `access_token=…` còn sót (ví dụ trong URL do Facebook trả về).
  return s.replace(/access_token=[^&"'\s]+/gi, 'access_token=<token>');
}

/** Host được phép gọi — suy TỪ `baseUrl` đã cấu hình, không hardcode thêm host nào. */
export function graphHostOf(baseUrl) {
  try {
    return new URL(String(baseUrl || DEFAULT_GRAPH_BASE_URL)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function createFacebookPublishProvider(config = {}, { logger = null, fetchImpl = safeFetch } = {}) {
  const fb = config?.publish?.facebook || {};
  const pageId = String(fb.pageId ?? '').trim();
  const accessToken = String(fb.accessToken ?? '').trim();
  const apiVersion = String(fb.apiVersion ?? '').trim() || DEFAULT_API_VERSION;
  const baseUrl = String(fb.baseUrl ?? '').trim() || DEFAULT_GRAPH_BASE_URL;
  const timeoutMs = Number(fb.timeoutMs) > 0 ? Math.trunc(Number(fb.timeoutMs)) : 30000;
  const allowPrivateNetwork = fb.allowPrivateNetwork === true;
  const maxLength = Number(config?.publish?.maxTextLength) || 63206;
  const host = graphHostOf(baseUrl);
  const configured = Boolean(pageId && accessToken && host);
  const calls = [];

  /** Dựng `PublishResult` ĐÚNG hình dạng §2.1 — một nguồn duy nhất cho provider này. */
  const result = ({ status, post_id = null, url = null, error_code = null, error_message = '', scheduled_at = null, raw = null }) => ({
    status,
    post_id,
    url,
    error_code,
    // Lưới cuối: không chuỗi nào ra khỏi provider mà còn token.
    error_message: maskToken(error_message, accessToken),
    is_mock: false,
    provider: 'facebook',
    scheduled_at,
    raw,
  });

  /** Gọi Graph API bằng thân `x-www-form-urlencoded`; KHÔNG bao giờ đưa token vào URL. */
  const callGraph = async (edge, fields) => {
    const endpoint = `${baseUrl.replace(/\/+$/, '')}/${apiVersion}/${encodeURIComponent(pageId)}/${edge}`;
    const body = new URLSearchParams({ ...fields, access_token: accessToken }).toString();
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      timeoutMs,
      // Chỉ host của Graph base URL — không phải cả allowlist sàn Trung Quốc của repo.
      domains: [host],
      allowPrivateNetwork,
      maxBytes: 256 * 1024,
    });
    const text = Buffer.isBuffer(res?.body) ? res.body.toString('utf8') : String(res?.body ?? '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res?.status ?? 0, text, json, endpoint: `${apiVersion}/<page-id>/${edge}` };
  };

  return {
    name: 'facebook',
    channel: DEFAULT_CHANNEL,
    model: apiVersion,
    configured,
    isMock: false,
    notice: configured ? '' : FACEBOOK_NOT_CONFIGURED_MESSAGE,
    calls,

    /**
     * `probe()` CHỈ đọc cấu hình — cố ý KHÔNG gọi mạng khi chưa cấu hình. Đã cấu hình thì gọi
     * `GET /{page-id}?fields=id,name` để biết token còn sống hay không.
     *
     * Token đi trong header `Authorization: Bearer` (cách Graph API chính thức hỗ trợ) chứ KHÔNG
     * trong query string: query string đi vào access log của mọi proxy trên đường.
     */
    async probe() {
      if (!configured) {
        return {
          ok: false,
          name: 'facebook',
          channel: DEFAULT_CHANNEL,
          configured: false,
          is_mock: false,
          page_id: '',
          error_code: 'NOT_CONFIGURED',
          message: FACEBOOK_NOT_CONFIGURED_MESSAGE,
        };
      }
      try {
        const endpoint = `${baseUrl.replace(/\/+$/, '')}/${apiVersion}/${encodeURIComponent(pageId)}?fields=id%2Cname`;
        const res = await fetchImpl(endpoint, {
          method: 'GET',
          headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
          timeoutMs,
          domains: [host],
          allowPrivateNetwork,
          maxBytes: 64 * 1024,
        });
        const text = Buffer.isBuffer(res?.body) ? res.body.toString('utf8') : String(res?.body ?? '');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        const ok = (res?.status ?? 0) >= 200 && (res?.status ?? 0) < 300 && Boolean(json?.id);
        return {
          ok,
          name: 'facebook',
          channel: DEFAULT_CHANNEL,
          configured: true,
          is_mock: false,
          page_id: ok ? String(json.id) : pageId,
          error_code: ok ? null : 'PROVIDER_FAILED',
          message: ok
            ? `Page "${maskToken(String(json?.name ?? ''), accessToken)}" trả lời bình thường.`
            : maskToken(String(json?.error?.message ?? text ?? `HTTP ${res?.status ?? 0}`), accessToken).slice(0, 500),
        };
      } catch (err) {
        return {
          ok: false,
          name: 'facebook',
          channel: DEFAULT_CHANNEL,
          configured: true,
          is_mock: false,
          page_id: pageId,
          error_code: String(err?.code || 'PROVIDER_FAILED'),
          message: maskToken(String(err?.message ?? err), accessToken).slice(0, 500),
        };
      }
    },

    async publish({ text = '', media = [], scheduledAt = null } = {}) {
      // LUẬT 1: chưa cấu hình ⇒ dừng TRƯỚC mọi thao tác mạng.
      if (!configured) {
        logger?.warn?.('publish.facebook_not_configured', {
          has_page_id: Boolean(pageId),
          has_token: Boolean(accessToken),
          host_ok: Boolean(host),
        });
        return result({ status: 'NOT_CONFIGURED', error_code: 'NOT_CONFIGURED', error_message: FACEBOOK_NOT_CONFIGURED_MESSAGE });
      }

      const norm = normalizePublishText(text, { maxLength });
      const list = (Array.isArray(media) ? media : []).filter((m) => m && typeof m === 'object');
      const sched = normalizeSchedule(scheduledAt);

      if (!norm.text && list.length === 0) {
        return result({ status: 'FAILED', error_code: 'BAD_INPUT', error_message: 'Bài không có nội dung và cũng không có ảnh/video.' });
      }
      if (norm.tooLong) {
        return result({ status: 'FAILED', error_code: 'TEXT_TOO_LONG', error_message: `Nội dung dài ${norm.length} ký tự, vượt trần ${maxLength}.` });
      }
      if (sched.bad) {
        return result({ status: 'FAILED', error_code: 'BAD_SCHEDULE', error_message: 'Mốc hẹn giờ không phải thời điểm ISO-8601 trong tương lai.' });
      }
      // §2.5 — CHƯA LÀM: nhiều ảnh trong một bài (`attached_media`). Nói thẳng, không đăng thiếu ảnh.
      if (list.length > 1) {
        return result({
          status: 'FAILED',
          error_code: 'MEDIA_TOO_MANY',
          error_message: `Bản này đăng được tối đa 1 ảnh/bài; bài đang có ${list.length}. Nhiều ảnh (attached_media) CHƯA làm.`,
        });
      }
      // §2.5 — CHƯA LÀM: tải ảnh từ ĐĨA lên (multipart `source`). Chỉ nhận ảnh đã có URL công khai.
      if (list.length === 1 && !String(list[0]?.url ?? '').trim()) {
        return result({
          status: 'FAILED',
          error_code: 'MEDIA_NOT_PUBLIC',
          error_message:
            'Ảnh chỉ có trên đĩa của máy chủ, chưa có địa chỉ công khai để Facebook tải về. '
            + 'Bản này CHƯA làm đường tải ảnh trực tiếp (multipart) — hãy đăng bài chỉ có chữ, '
            + 'hoặc cấu hình PUBLIC_BASE_URL công khai cho ảnh.',
        });
      }

      const scheduleFields = sched.scheduledAt
        ? { published: 'false', scheduled_publish_time: String(Math.floor(Date.parse(sched.scheduledAt) / 1000)) }
        : {};
      const usePhotos = list.length === 1;
      const edge = usePhotos ? 'photos' : 'feed';
      const fields = usePhotos
        ? { url: String(list[0].url).trim(), ...(norm.text ? { caption: norm.text } : {}), ...scheduleFields }
        : { message: norm.text, ...scheduleFields };

      calls.push({ edge, text_length: norm.length, media_count: list.length, scheduled: Boolean(sched.scheduledAt) });

      let res;
      try {
        res = await callGraph(edge, fields);
      } catch (err) {
        // Mạng lỗi / bị allowlist chặn / timeout — KHÔNG ném ra ngoài (fail-closed như OcrProvider).
        const message = maskToken(String(err?.message ?? err), accessToken);
        logger?.error?.('publish.facebook_transport_failed', { edge, error_code: err?.code || null, error_message: message.slice(0, 300) });
        return result({
          status: 'FAILED',
          error_code: String(err?.code || 'PROVIDER_FAILED'),
          error_message: message.slice(0, 1000),
          raw: { endpoint: `${apiVersion}/<page-id>/${edge}`, transport_error: String(err?.code || 'PROVIDER_FAILED') },
        });
      }

      const ok = res.status >= 200 && res.status < 300;
      // Graph trả `{id}` cho /feed, `{id, post_id}` cho /photos — `post_id` mới là id BÀI.
      const postId = String(res.json?.post_id ?? res.json?.id ?? '').trim();

      if (!ok || !postId) {
        // LUẬT 2: nguyên văn lỗi Facebook, không dịch lại, không nuốt.
        const fbError = res.json?.error || null;
        const raw = fbError
          ? {
            endpoint: res.endpoint,
            http_status: res.status,
            error: {
              message: maskToken(String(fbError.message ?? ''), accessToken),
              type: fbError.type ?? null,
              code: fbError.code ?? null,
              error_subcode: fbError.error_subcode ?? null,
              fbtrace_id: fbError.fbtrace_id ?? null,
            },
          }
          : { endpoint: res.endpoint, http_status: res.status, body_excerpt: maskToken(res.text, accessToken).slice(0, 500) };
        const message = fbError?.message
          ? String(fbError.message)
          : res.text
            ? res.text.slice(0, 500)
            : `HTTP ${res.status} từ Graph API mà không có thân phản hồi.`;
        logger?.error?.('publish.facebook_rejected', {
          endpoint: res.endpoint,
          http_status: res.status,
          fb_code: fbError?.code ?? null,
          fb_subcode: fbError?.error_subcode ?? null,
        });
        return result({ status: 'FAILED', error_code: 'PROVIDER_FAILED', error_message: message, raw });
      }

      logger?.info?.('publish.facebook_published', { endpoint: res.endpoint, scheduled: Boolean(sched.scheduledAt) });
      return result({
        status: sched.scheduledAt ? 'SCHEDULED' : 'PUBLISHED',
        post_id: postId,
        // Link bài THẬT do Facebook quy ước từ `post_id`; chỉ dựng khi đã có id thật.
        url: `https://www.facebook.com/${encodeURIComponent(postId)}`,
        scheduled_at: sched.scheduledAt,
        raw: { endpoint: res.endpoint, http_status: res.status, id: postId },
      });
    },
  };
}

export default createFacebookPublishProvider;
