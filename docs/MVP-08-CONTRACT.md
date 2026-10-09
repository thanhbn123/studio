# MVP-08 — ĐĂNG SẢN PHẨM LÊN SÀN (SHOPEE / TIKTOK SHOP) — HỢP ĐỒNG ĐÓNG BĂNG

> **Phạm vi làm được NGAY, không cần Owner:** toàn bộ **lớp trừu tượng + ánh xạ dữ liệu + hàng đợi + kiểm tra
> trước khi đăng + provider `dry-run`**. Chỉ **lời gọi API thật** mới cần tài khoản người bán đã được duyệt
> (blocker bên ngoài, ghi ở `docs/OWNER-DECISIONS.md`) — khi đó chỉ việc cắm token, **không sửa kiến trúc**.
> Nguyên tắc xuyên suốt: **một sàn hỏng không được làm hỏng luồng chung** (cô lập như `ConnectorRegistry`),
> và **DUYỆT TAY** trước mọi lần đăng.

## 0. Bốn luật riêng

1. **Không bịa dữ liệu sàn.** Thiếu trường bắt buộc (giá, tồn kho, ảnh, cân nặng…) ⇒ **không** đoán,
   không điền mặc định im lặng: trả **danh sách lỗi kiểm tra** (`issues[]`) và **chặn** đăng.
2. **Tiền và tồn kho là dữ liệu của sàn, không phải của mình.** Hệ thống chỉ **đọc** từ sàn để đối chiếu;
   mọi thay đổi giá/tồn phải do người dùng bấm, và ghi vết (`marketplace_events`).
3. **Không đăng hai lần.** Mỗi lần đăng có `run_key`; đăng lại cùng `(job_id, channel, run_key)` ⇒ trả **bản ghi cũ**,
   không tạo bài mới trên sàn.
4. **Thất bại phải nói rõ sàn nào, mã nào.** Lỗi từ sàn giữ **nguyên văn** + `error_code` chuẩn hoá của mình;
   không nuốt lỗi, không đổi thành “thành công một phần” mà không ghi.

## 1. Bản đồ sở hữu file

| Phần | File |
|---|---|
| Trừu tượng sàn | `src/marketplace/provider.js` (interface), `src/marketplace/registry.js` |
| Provider | `src/marketplace/providers/{dry-run,shopee,tiktokshop}.js` |
| Ánh xạ | `src/marketplace/mapping/{shopee,tiktokshop}.js` — Product Master → payload của sàn |
| Kiểm tra | `src/marketplace/preflight.js` — trả `issues[]` **trước** khi gọi mạng |
| Nghiệp vụ | `src/marketplace/publish.js` — hàng đợi, retry, `marketplace_events` |
| Bảng | `src/store/schema.sql` + migration (index **sau** migration) |
| API | `src/http/routes.js` (chỉ thêm) |
| UI | `public/app.js`, `public/index.html` (tab mới **“Đăng sàn”**) |
| Test | `test/marketplace-*.test.js` |

## 2. Interface provider (đóng băng)

```js
// mọi provider phải có
{ name, configured, capabilities: { createListing, updatePrice, updateStock, readListing },
  async probe() -> { ok, detail },
  async createListing(payload) -> { status: 'published'|'dry_run'|'failed', external_id, url, error_code, raw },
  async updatePrice(externalId, price) -> …, async updateStock(externalId, qty) -> …,
  async readListing(externalId) -> … }
```
- `dry-run` (**MẶC ĐỊNH**): **không gọi mạng**, trả `status:'dry_run'`, `external_id:'dry-<hash>'`,
  `url:null`; payload đã qua `preflight` được **lưu nguyên** để người dùng soi.
- `shopee` / `tiktokshop`: thiếu token/partner id ⇒ `configured:false` và mọi lời gọi trả
  **`NOT_CONFIGURED`** (fail-closed) — **không** giả lập thành công.

## 3. Ánh xạ (phần dễ sai nhất — phải có test đối chứng)

- Đầu vào: **Product Master** của repo (`src/product-master.js`) — tên, mô tả, điểm bán, ảnh, giá, tồn, cân nặng, biến thể (nếu có).
- Đầu ra: payload theo schema **tài liệu công khai** của từng sàn; mỗi trường ánh xạ phải **dẫn nguồn**
  (comment ghi tài liệu + ngày), và trường nào **không** ánh xạ được thì khai vào `unmapped[]`.
- **Không** tự dịch/viết lại nội dung ở tầng này (nội dung đã có từ MVP-01); chỉ ánh xạ + kiểm tra.
- Giới hạn của sàn (độ dài tiêu đề, số ảnh, đơn vị cân nặng, đơn vị tiền) phải kiểm ở `preflight` ⇒ `issues[]`.

## 4. API (chỉ THÊM)

```
GET  /api/marketplace/channels                      → [{name, configured, capabilities}]
POST /api/marketplace/listings                      {job_id, channel, run_key?} → 201 {listing, issues[]}
GET  /api/marketplace/listings?job_id=&channel=     → danh sách + trạng thái
POST /api/marketplace/listings/:id/publish          (chỉ khi đã DUYỆT) → {status, external_id, url, error_code}
POST /api/marketplace/listings/:id/approve|reject   (chỉ admin/chủ sở hữu theo luật repo)
POST /api/marketplace/listings/:id/sync             → đọc giá/tồn từ sàn (chỉ kênh đã cấu hình)
```
Luật: ẩn danh ⇒ 401 (đăng sàn **không** dành cho ẩn danh); khác chủ ⇒ 404; thiếu trường bắt buộc ⇒
**422 `PREFLIGHT_FAILED`** kèm `issues[]`; kênh chưa cấu hình ⇒ **409 `CHANNEL_NOT_CONFIGURED`**;
đăng khi chưa duyệt ⇒ **409 `NOT_APPROVED`**; sàn lỗi ⇒ **502 `MARKETPLACE_ERROR`** + `raw` (đã lọc bí mật).

## 5. UI (tab “Đăng sàn”)

Bảng: sản phẩm (job) → kênh → trạng thái (`draft|pending_review|approved|publishing|published|failed`) →
`external_id`/link (nếu có) → nút **XEM PAYLOAD**, **DUYỆT**, **TỪ CHỐI**, **ĐĂNG**, **ĐỒNG BỘ**.
Hiện **rõ**: kênh đang `dry-run` ⇒ banner **“CHẾ ĐỘ THỬ — không đăng thật”**; kênh chưa cấu hình ⇒
“chưa có token Shopee/TikTok Shop (cần tài khoản người bán được duyệt)”; `issues[]` hiện **từng dòng**.

## 6. Định nghĩa XONG

- `dry-run` chạy trọn luồng: tạo listing → kiểm tra → duyệt → “đăng” (dry) ⇒ có `marketplace_events` đầy đủ, **0 lời gọi mạng**.
- Ánh xạ có test đối chứng **hai chiều**: payload đúng cho ca đủ trường; ca thiếu trường ⇒ `issues[]` **nêu đúng tên trường**.
- Sàn lỗi ⇒ chỉ listing đó `failed`, **các listing khác vẫn đăng được** (cô lập); test chứng minh.
- Đăng 2 lần cùng `run_key` ⇒ **1** bản ghi, **1** lần gọi provider.
- `npm test` xanh; `npm run verify` xanh; UI chạy được (test bằng hàm thật như các tab khác).
