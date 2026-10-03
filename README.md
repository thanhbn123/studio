# VIP Product Studio — MVP-01 + MVP-02

**MVP-01 — Product Content Studio.** Dán link sản phẩm **Taobao / 1688 / Pinduoduo** → hệ thống tự
nhận diện nguồn, lấy dữ liệu sản phẩm thật, chuẩn hoá thành **Product Master**, phân tích ảnh bằng
AI, rồi sinh **bộ nội dung bán hàng tiếng Việt**.

**MVP-02 — Image Translation Studio.** Tải ảnh sản phẩm lên → phát hiện vùng chữ Trung (OCR) →
phân loại từng vùng → dịch sang tiếng Việt qua **bảng duyệt từng dòng** → xoá chữ cũ và render chữ
Việt vào đúng vị trí, giữ nguyên bố cục. **Ảnh gốc bất biến**; mọi ảnh sinh ra là bản mới có truy
vết về ảnh gốc.

> **Chưa có:** tạo ảnh AI, edit video, voice-over, đăng bài tự động, Shopee API, tài khoản người
> dùng + credit, thanh toán. Kiến trúc đã chừa sẵn chỗ — xem [`docs/ROADMAP.md`](docs/ROADMAP.md).
>
> **Giới hạn thật của MVP-02 (đọc trước khi tin):** OCR mặc định là **MOCK** (đọc vùng chữ từ
> fixture dựng tay, `is_mock = true`, UI hiện nhãn MOCK) — muốn OCR thật phải cắm provider qua
> `OCR_PROVIDER=http` + `OCR_BASE_URL` + `OCR_API_KEY`. Bộ render nội bộ `purejs` **chỉ giải mã
> PNG** (8-bit, color type 0/2/4/6, non-interlaced); JPEG/WebP/GIF trả `UNSUPPORTED_IMAGE` chứ
> **không** giả vờ thành công — muốn xử lý các định dạng đó phải cắm `RENDER_PROVIDER=http`.
> Chi tiết đo được: [`docs/VERIFICATION.md`](docs/VERIFICATION.md).

---

## 1. Chạy nhanh

```bash
# 1. Cấu hình
cp .env.example .env
#    rồi mở .env, điền AI_API_KEY (DeepSeek/OpenAI/Anthropic/Gemini)

# 2. Cài phụ thuộc (chỉ `pg`; SQLite dùng module có sẵn của Node)
npm install

# 3. Tạo bảng
npm run migrate

# 4. Chạy
npm start          # http://127.0.0.1:3000
```

**Yêu cầu:** Node `>= 24` (dùng `node:sqlite` có sẵn, không cần biên dịch native module).

### Kiểm thử

```bash
npm test                                   # toàn bộ test (không cần mạng, không cần API key)
npm run verify                             # kiểm cú pháp src/public/tools/test + toàn bộ test
npm run demo:imagelab                      # MVP-02: chạy trọn luồng dịch ảnh + in bằng chứng đo được
DATABASE_URL=postgres://... npm test       # bật thêm test PostgreSQL thật
```

`npm run demo:imagelab` tự dựng **ảnh mẫu 800×800** (không cần ảnh của anh) rồi in ra **sha256 ảnh
gốc trước/sau** (chứng minh ảnh gốc không đổi), danh sách vùng chữ theo loại, số dòng bị khoá,
`usage_event` đọc lại từ DB — và ghi **ảnh TRƯỚC | SAU** vào `data/imagelab-demo/truoc-sau.png`
để mở bằng mắt. Muốn dùng ảnh thật: `node tools/imagelab-demo.mjs --image <ảnh.png>`.
Nó **không** chứng minh OCR thật — output tự ghi nhãn `MOCK_VERIFIED` khi có bước dùng provider giả.

> **Owner nghiệm thu MVP-02:** xem hồ sơ từng bước tại
> [`docs/MVP-02-ACCEPTANCE.md`](docs/MVP-02-ACCEPTANCE.md) (4 lệnh chạy + checklist + ảnh minh chứng).

### Docker

```bash
docker compose up --build     # app + PostgreSQL 16, mở http://localhost:3000
```

Ảnh của MVP-02 (ảnh gốc + ảnh đã render) nằm trong **volume `appdata`** mount tại `/data`
(`IMAGELAB_DIR=/data/imagelab`), nên **không mất khi dựng lại container**. Mặc định trong
container là OCR `mock` + render `purejs` (miễn phí, chỉ PNG); muốn cắm dịch vụ thật thì đặt
`OCR_PROVIDER` / `RENDER_PROVIDER` / `TRANSLATE_PROVIDER` + key trong `.env` — compose đã truyền sẵn.

Kiểm nhanh luồng dịch ảnh **bên trong chính image** (offline):

```bash
docker run --rm vip-product-studio:local node tools/imagelab-demo.mjs
```

---

## 2. Luồng xử lý

```
Link người dùng dán
   │
   ├─ G01  nhận diện nguồn + canonical URL + product id   (chặn SSRF tại đây)
   │
   ├─ G02  ProductSourceConnector registry (cô lập lỗi từng connector)
   │      ├─ G03 TaobaoConnector
   │      ├─ G04 Alibaba1688Connector
   │      └─ G05 PinduoduoConnector      (adapter độc lập, có nhánh session)
   │
   ├─ G06  Product Master — schema thống nhất, mỗi field có `status`
   │
   ├─ G07  VisionProvider — phân tích ảnh có cấu trúc, chống bịa
   ├─ G08  Knowledge Merge — gộp nguồn + ảnh + chữ Trung, MỌI fact có nhãn nguồn gốc
   ├─ G09  Vietnamese Content Engine — 9 đầu ra, 6 phong cách × 3 độ dài
   │
   ├─ G14  Extraction Evidence — bảng chứng minh những gì lấy được / không lấy được
   ├─ G12  History
   └─ G13  usage_event — nền tảng credit-based billing
```

Nếu connector bị chặn, pipeline **không chết**: nó chuyển sang **G11 manual fallback** để
người dùng tự tải ảnh / nhập tên / nhập ghi chú, rồi vẫn chạy Content Engine.
Các sàn không được phép là điểm chết duy nhất.

### 2.1 Luồng MVP-02 — Image Translation Studio

```
Ảnh sản phẩm người dùng tải lên (PNG/JPEG/WebP/GIF — sniff magic bytes, không tin Content-Type)
   │
   ├─ IL-00  ingest   — lưu ẢNH GỐC bất biến (sha256 + storage_path), tạo job kind=image_translation
   │
   ├─ IL-01  OcrProvider      — phát hiện vùng chữ: hộp bao (pixel + chuẩn hoá), chữ nguyên văn,
   │                            ngôn ngữ, độ tin cậy            [mock | http | none]
   ├─ IL-02  classifyRegion   — mô tả | nhãn hiệu | chứng nhận | giá | unknown  (fail-closed)
   ├─ IL-03  Translator       — dịch sang tiếng Việt + 4 luật guardrail, TỪ ĐIỂN thuật ngữ
   ├─ IL-04  Bảng duyệt       — người dùng sửa/duyệt TỪNG DÒNG (vùng khoá phải override có vết)
   │
   ├─ IL-05  RenderProvider   — xoá chữ cũ (inpaint) + render chữ Việt vừa hộp (layout tự chọn cỡ)
   │                            [mock | purejs | http | none]
   │
   ├─ IL-06  Ảnh MỚI có parent_id trỏ về ảnh gốc; ảnh gốc không đổi một byte nào
   └─ IL-07  usage_event: OCR_DETECT · TRANSLATION · IMAGE_RENDER
```

Ba chốt chặn nằm ở **cả ba tầng** của luồng, không chỉ ở UI: vùng **nhãn hiệu / chứng nhận / giá**
(1) không bao giờ được gửi cho provider dịch, (2) không bao giờ được dựng thành lệnh render,
(3) không bao giờ bị xoá pixel — chúng bị bỏ qua và **lý do được ghi lại** để UI hiện ra.
Vùng không đủ chỗ cho chữ Việt (`fits = false`) hoặc thiếu glyph cũng bị bỏ qua và giữ nguyên
chữ gốc, không bao giờ vẽ tràn ra ngoài hộp.

---

## 3. Bốn nguyên tắc bất khả xâm phạm

Đây là phần quan trọng nhất của dự án — không phải tính năng, mà là **tính trung thực**.

### 3.1 Không bịa field

Mỗi field trong Product Master mang `status`:

| status | nghĩa |
|---|---|
| `FOUND` | lấy được thật |
| `NOT_FOUND` | trang không có field này |
| `LOGIN_REQUIRED` | cần session đăng nhập mới thấy |
| `BLOCKED` | bị anti-bot / lỗi mạng chặn |
| `UNSUPPORTED` | nguồn không được hỗ trợ |

Không có chuyện "lấy xong" mà không chứng minh được nguồn. UI luôn hiện bảng
**Bằng chứng trích xuất** kèm số đếm thật và lý do thật.

### 3.2 Không biến suy đoán thành fact

Mọi dữ kiện trong `knowledge.facts` đều mang `provenance`:

`source` (từ sàn) → `vision` (nhìn thấy trong ảnh) → `inference` (AI suy luận, **phải** gắn nhãn)

### 3.3 Chống bịa hai tầng

1. **Prompt** bị chặn bằng *fact sheet* — danh sách ĐÓNG các dữ kiện được phép dùng.
2. **Guardrails** chạy trên văn bản đã sinh (9 nhóm luật: bảo hành, chứng nhận, chống nước,
   đơn vị thông số, dung tích/công suất, chất liệu, nguồn gốc, khuyến mãi, số liệu xã hội).
   Nếu phát hiện khẳng định không có bằng chứng, engine **tự gọi một lượt sửa**; nếu vẫn còn
   thì nội dung được trả về kèm `guardrails_passed = false` và UI hiện cảnh báo —
   **không bao giờ im lặng**.

   > **Bài học đã trả giá.** Bộ luật đầu tiên chỉ bắt **cách nói thẳng**. Khi tự thử phá chính
   > mình bằng 23 cách **diễn đạt lại** thường gặp của tiếng Việt, **13 cách lọt lưới** —
   > "BH 12 tháng", "đi mưa không sao", "Pin 5000 mAh", "Sale 50%", "Hơn 10 nghìn người mua".
   > Đã vá (10/23 → **23/23**) và **khoá lại bằng test thường trực**, kèm một test chống
   > dương tính giả trên nội dung sạch. Regex bắt được cái đã biết, không bắt được cái chưa
   > nghĩ tới — nên lỗ hổng này phải có test canh, không thể chỉ dựa vào việc "đã viết kỹ".

### 3.4 Ảnh gốc bất biến, nhãn hiệu không bị đụng (MVP-02)

Ba luật riêng của xử lý ảnh, đều được **khoá bằng test**:

1. **Ảnh gốc bất biến.** Buffer đầu vào không bị sửa tại chỗ; file gốc không bao giờ bị ghi đè.
   Mọi ảnh sinh ra là bản ghi mới có `parent_id` trỏ về ảnh gốc, kèm `sha256` của cả hai.
   Test so `sha256` trước/sau và kiểm **pixel ngoài mọi hộp chữ không đổi**.
2. **Nhãn hiệu / chứng nhận / giá không bao giờ bị dịch hay xoá.** Chúng bị khoá ở cả ba tầng
   (dịch → dựng lệnh render → xoá pixel). Chỉ người dùng mới override được, và override để lại vết.
3. **Không vừa hộp thì bỏ qua, không vẽ tràn.** `layoutText` phải chứng minh mọi đường bao chữ nằm
   trong hộp; vùng không đủ chỗ hoặc thiếu glyph bị bỏ qua, **giữ nguyên chữ gốc**, và lý do được
   ghi vào `skipped` để UI hiện ra.

### 3.5 `session_id` KHÔNG phải xác thực (đọc trước khi tin "404 theo session")

Cookie `sid` do **client tự gửi**; máy chủ chỉ dùng nó để **phân vùng lịch sử** và tránh
truy cập nhầm giữa các phiên. Cụ thể:

- `/api/imagelab/*` và bốn route MVP-01 (`GET /api/jobs/:id`, `PUT .../content`,
  `POST .../regenerate`, `GET .../usage`) trả **404** khi job thuộc session khác — đây là
  **chống truy cập nhầm**, KHÔNG phải hàng rào bảo mật: ai biết `job_id` và tự đặt cookie
  `sid` của người khác vẫn đọc/ghi được. Request **không khai** cookie session nào được coi là
  khách ẩn danh (MVP-01 vẫn chạy được không cần cookie).
- `GET /api/jobs?scope=all` là **tính năng lịch sử có chủ ý**: nó liệt kê job của mọi phiên.
- Việc phân vùng thật (tài khoản, đăng nhập, quyền) thuộc **MVP-05**; xem thêm
  [`docs/VERIFICATION.md`](docs/VERIFICATION.md) §8.

---

## 4. Mức độ kiểm chứng

Dự án phân biệt rõ ba mức, và **không bao giờ** gọi mock là nghiệm thu cuối:

| Mức | Nghĩa |
|---|---|
| `MOCK_VERIFIED` | chỉ chạy bằng fixture/dữ liệu giả |
| `LIVE_VERIFIED` | lấy được dữ liệu THẬT từ sàn, truy cập ẩn danh |
| `AUTHENTICATED_LIVE_VERIFIED` | dữ liệu thật qua session đăng nhập |

Trạng thái thực tế của từng nguồn, kèm bằng chứng đo được:
xem [`docs/VERIFICATION.md`](docs/VERIFICATION.md).

---

## 5. Bản đồ mã nguồn

```
src/
├── server.js              điểm khởi động
├── app.js                 composition root (bơm phụ thuộc)
├── config.js  env.js  logger.js
├── security/
│   ├── url-guard.js       SSRF: allowlist, chặn IP nội bộ, chống DNS rebinding
│   ├── fetcher.js         fetch an toàn: redirect từng hop, timeout, giới hạn byte
│   ├── sanitize.js        làm sạch text/URL/ảnh, magic bytes, chống prototype pollution
│   └── ratelimit.js       rate-limit abstraction
├── sources/
│   ├── detect.js          G01 nhận diện nguồn
│   ├── base-connector.js  G02 lớp cơ sở + phân loại trang
│   ├── registry.js        G02 registry, cô lập lỗi
│   ├── taobao.js  1688.js  pinduoduo.js
│   └── parsers/util.js    deep-find, meta, giá, HTML
├── product-master.js      G06 schema + evidence + validate
├── vision/                G07 VisionProvider
├── merge/                 G08 knowledge merge
├── content/               G09 engine + styles + guardrails
├── jobs/                  queue + pipeline (MVP-01)
├── imagelab/              MVP-02 — Image Translation Studio
│   ├── ocr/               IL-01/02 OcrProvider (mock|http|none) + classifyRegion + normalizeRegions
│   ├── translate/         IL-03/04 Translator (mock|ai|none) + từ điển + 4 luật guardrail + duyệt
│   ├── render/            IL-05 render: PNG codec thuần JS, font 5×7 ghép dấu tiếng Việt,
│   │                      layout tự chọn cỡ chữ, inpaint, provider (mock|purejs|http|none)
│   ├── pipeline.js        ingest → runOcr → renderApproved (cổng duyệt bắt buộc)
│   └── storage.js         lưu ảnh nguyên tử, chặn path traversal
├── store/                 SQLite & PostgreSQL, cùng một schema.sql (jobs.kind + 3 bảng MVP-02)
├── session/               session cho sàn cần đăng nhập (none|file|cdp)
└── http/                  server + routes (MVP-01 + 6 route /api/imagelab/*)
public/                    giao diện (HTML/CSS/JS thuần, không build step) — 2 tab: Nội dung, Dịch ảnh
test/                      test + fixture (MVP-01 + imagelab-*.test.js)
tools/                     provider-probe, live-probe, imagelab-demo, sinh ảnh test
docs/                      kiến trúc, bảo mật, kiểm chứng, roadmap, hợp đồng MVP-02
```

---

## 6. Cấu hình

Xem [`.env.example`](.env.example) — mọi biến đều có chú thích tiếng Việt.
Vài điểm cần lưu ý:

- **Không hardcode secret.** Không commit `.env`. Không log cookie hay API key
  (`src/logger.js` che theo cả tên khoá lẫn hình dạng giá trị).
- `SESSION_MODE` — `cdp` cho phép dùng Chrome đang đăng nhập để lấy dữ liệu các sàn cần session
  **mà không export cookie vào repo**.
- `ALLOW_PRIVATE_NETWORK=false` là mặc định an toàn. Chỉ bật khi test cục bộ có kiểm soát.
- **MVP-02:** `IMAGELAB_ENABLED` (tắt hẳn tính năng), `IMAGELAB_DIR` (nơi lưu ảnh; mặc định
  `./data/imagelab`, đã nằm trong `.gitignore`), `IMAGELAB_MAX_IMAGE_BYTES`, `IMAGELAB_MAX_PIXELS`
  (chặn ảnh khổng lồ trước khi cấp phát bộ nhớ), `IMAGELAB_MAX_REGIONS`, `IMAGELAB_MIN_CONFIDENCE`.
- `OCR_PROVIDER=mock` và `RENDER_PROVIDER=purejs` là mặc định **an toàn và miễn phí**. Cắm
  `OCR_PROVIDER=http` + `OCR_BASE_URL` + `OCR_API_KEY` (và/hoặc `RENDER_PROVIDER=http` +
  `RENDER_BASE_URL`) khi có dịch vụ thật. `TRANSLATE_PROVIDER` mặc định kế thừa khối `ai`.
- `IMAGELAB_ENABLED=false` hoặc module MVP-02 nạp lỗi ⇒ MVP-01 **vẫn chạy bình thường**; lý do
  hiện ở `GET /api/health` tại `imagelab.reason`, và các route `/api/imagelab/*` trả 503.

---

## 7. Giấy phép & quy ước

Mã nguồn nội bộ của VIPORDER. Tài liệu và chú thích viết bằng tiếng Việt; thuật ngữ nước ngoài
được giữ nguyên khi là tên riêng của kỹ thuật (connector, guardrail, provenance…).
