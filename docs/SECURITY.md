# SECURITY — VIP Product Studio MVP-01

Ứng dụng này **tải URL do người dùng nhập** — đó là bề mặt tấn công nguy hiểm nhất của nó.
Tài liệu này ghi rõ từng lớp phòng thủ và **cách tự kiểm lại**.

---

## 1. SSRF — mối nguy số một

Kẻ tấn công dán `http://169.254.169.254/latest/meta-data/` để đọc credential của máy chủ cloud.
Ba lớp phòng thủ, **phải đủ cả ba** (thiếu một là hở):

### Lớp 1 — Allowlist theo registrable domain
Chỉ domain của sàn và CDN ảnh của sàn được phép. So khớp theo **nhãn tên miền**, không dùng
`includes()` — nếu không, `taobao.com.evil.com` sẽ lọt.

### Lớp 2 — Kiểm cú pháp
Từ chối: scheme ngoài http/https (`file:`, `gopher:`, `javascript:`, `data:`), URL chứa
`user:pass@`, cổng ngoài danh sách, host nội bộ (`.local`, `.internal`, `localhost`), IP
literal thuộc dải riêng.

Xử lý cả IPv4 viết trá hình: `2130706433`, `0x7f000001`, `0177.0.0.1` — `new URL()` chuẩn hoá
chúng, rồi lớp 3 kiểm lại.

### Lớp 3 — Phân giải DNS rồi GHIM địa chỉ
Đây là lớp chống **DNS rebinding** và là lớp hay bị bỏ sót nhất.

Kiểm IP rồi gọi `fetch()` bình thường là **sai**: kẻ tấn công trả bản ghi DNS công khai ở lần
phân giải thứ nhất, rồi đổi sang `127.0.0.1` ở lần phân giải thứ hai (lúc socket thật sự kết
nối). Vì vậy `resolvePublicAddresses()` phân giải **một lần**, kiểm **mọi** bản ghi trả về
(một bản ghi nội bộ là từ chối cả tên miền — chống split-horizon), rồi `pinLookup()` buộc socket
chỉ được nối tới đúng IP đã kiểm. Socket **không bao giờ tự phân giải lại**.

### Dải địa chỉ bị chặn
IPv4: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`,
`192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`,
`224/4`, `240/4`, `255.255.255.255`.
IPv6: `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `64:ff9b::/96`,
`2002::/16`, và **IPv4-mapped** `::ffff:a.b.c.d` (kiểm chính IPv4 nhúng bên trong).

### Redirect — mỗi hop đều phải qua allowlist
`safeFetch` **không** để thư viện tự theo redirect. Từng hop được kiểm lại allowlist, chặn
vòng lặp, chặn hạ cấp `https → http`, giới hạn số hop.

### Kiểm lại
```bash
node --test test/url-detect.test.js test/security.test.js
```
Bao gồm: loopback, metadata cloud, IPv4 dạng số nguyên/hex, IPv4-mapped IPv6, suffix attack,
credentials trong URL, cổng lạ, và redirect ra ngoài allowlist.

### `ALLOW_PRIVATE_NETWORK`
Mặc định `false`. Khi bật `true`, các chốt host/IP nội bộ **và** danh sách cổng bị bỏ qua, để
test được với server cục bộ trên cổng ngẫu nhiên. **Chỉ bật khi test cục bộ có kiểm soát.**

---

## 2. Secret

- **Không hardcode secret.** Tất cả qua biến môi trường.
- `.env` nằm trong `.gitignore`; CI có job `secret-scan` chặn commit `.env`, khoá API, file cookie.
- `src/logger.js` che secret **hai cách**: theo **tên khoá** (`api_key`, `authorization`, `cookie`,
  `token`, `password`, `secret`…) và theo **hình dạng giá trị** (`sk-…`, `ghp_…`, `AIza…`, JWT,
  `Bearer …`). Che cả khi tên khoá vô hại — vì khoá thật hay nằm trong `note` hay `message`.
- **Cookie không bao giờ vào log, DB, hay Product Master.** `session.status()` chỉ trả **số lượng**
  cookie, không trả nội dung. Cookie chỉ được gửi tới host trong `cookieDomains` của connector —
  không rò sang CDN hay host khác.
- Phản hồi lỗi 5xx trả thông báo chung, **không** kèm stack hay đường dẫn hệ thống.

---

## 3. Dữ liệu từ nguồn ngoài

Dữ liệu sản phẩm đến từ trang của sàn và từ model — **không được tin**.

- `escapeHtml()` cho mọi nội dung động trước khi vào DOM.
- `sanitizeText()` bỏ ký tự điều khiển, chuẩn hoá NFC, cắt độ dài.
- `safeJsonParse()` + `stripDangerousKeys()` chặn **prototype pollution** (`__proto__`,
  `constructor`, `prototype`) khi parse JSON nhúng từ trang sàn.
- CSP: `default-src 'self'`, `script-src 'self'` (không inline script), `img-src` cho phép
  `https:` vì ảnh sản phẩm nằm trên CDN ngoài, `object-src 'none'`, `frame-ancestors 'none'`.

---

## 4. Upload

Ảnh người dùng tải lên (G11) **không** được tin theo `Content-Type` hay tên file:

- **Magic bytes** quyết định MIME thật (`sniffImageMime`). File HTML đổi tên thành `.png` bị từ chối.
- Giới hạn dung lượng từng file và tổng số file.
- `sanitizeFilename()` chặn path traversal.

> **Lưu ý thiết kế:** `sanitizeUrl()` chỉ nhận http/https và sẽ **xoá rỗng** `data:image/...`.
> Ảnh thủ công phải đi qua `sanitizeImageRef()`. Đã từng dính lỗi này: dùng nhầm hàm làm bước
> Vision âm thầm không bao giờ chạy. Xem `docs/VERIFICATION.md` mục ghi chú lỗi.

---

## 5. Tài nguyên & DoS

- Timeout cứng cho mọi request ra ngoài và cho mọi lời gọi AI.
- Giới hạn số byte đọc được (`maxBytes`) — cắt kết nối khi vượt, không đọc hết rồi mới kiểm.
- Giới hạn kích thước body request.
- Rate limit theo session cho việc tạo job / detect / upload. Hiện là bộ đếm trong bộ nhớ
  (`MemoryRateLimiter`); **phải đổi sang Redis khi chạy nhiều instance** — bộ đếm trong bộ nhớ
  chỉ đúng cho một tiến trình.
- Số ảnh gửi sang Vision bị giới hạn (`VISION_MAX_IMAGES`).

---

## 6. Tắt êm

`app.close()` đóng server, đóng các kết nối keep-alive đang rảnh ngay (nếu không phải chờ hết
`keepAliveTimeout` 65 giây), có thời hạn ân hạn rồi buộc đóng phần còn lại, đợi job đang chạy,
rồi đóng DB. `SIGTERM`/`SIGINT` được xử lý.

---

## 7. Những gì CHƯA có (và phải biết là chưa có)

| Thiếu | Ảnh hưởng | Giai đoạn |
|---|---|---|
| **Xác thực người dùng** | `sid` chỉ là cookie phân vùng lịch sử, **không phải bảo mật**. Ai biết `sid` thì xem được lịch sử đó. Không có mật khẩu, không có phân quyền. | MVP-05 |
| Rate limit phân tán | nhiều instance thì hạn mức bị nhân lên | trước MVP-06 |
| Ký/rotate secret | khoá nằm trong `.env` | MVP-05 |
| Quét lỗ hổng phụ thuộc tự động | mới có CI quét secret | nên thêm |
| CSRF token | cookie `SameSite=Lax` + API JSON-only hiện là lớp chắn duy nhất | MVP-05 |
| Mã hoá dữ liệu nhạy cảm khi lưu | hiện chưa lưu dữ liệu nhạy cảm nào | MVP-05 |
| Audit log truy cập | mới có structured log kỹ thuật | MVP-05 |

> **Kết luận thẳng:** MVP-01 **chưa có xác thực**. Không được đưa lên Internet công khai ở trạng
> thái này. Staging phải nằm sau lớp xác thực mạng (basic auth / IP allowlist / VPN).
