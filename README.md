# VIP Product Studio — MVP-01

Dán link sản phẩm **Taobao / 1688 / Pinduoduo** → hệ thống tự nhận diện nguồn, lấy dữ liệu
sản phẩm thật, chuẩn hoá thành **Product Master**, phân tích ảnh bằng AI, rồi sinh **bộ nội
dung bán hàng tiếng Việt**.

> **Phạm vi MVP-01.** Chưa có: chỉnh ảnh, xoá chữ Trung, render chữ Việt lên ảnh, tạo ảnh AI,
> edit video, voice-over, đăng bài tự động, Shopee API, thanh toán, subscription.
> Kiến trúc đã chừa sẵn chỗ cho những phần đó — xem [`docs/ROADMAP.md`](docs/ROADMAP.md).

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
DATABASE_URL=postgres://... npm test       # bật thêm test PostgreSQL thật
```

### Docker

```bash
docker compose up --build     # app + PostgreSQL 16, mở http://localhost:3000
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

---

## 3. Ba nguyên tắc bất khả xâm phạm

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
2. **Guardrails** chạy trên văn bản đã sinh (8 nhóm luật: bảo hành, chứng nhận, chống nước,
   thông số kỹ thuật, chất liệu, nguồn gốc, khuyến mãi, số liệu xã hội). Nếu phát hiện khẳng
   định không có bằng chứng, engine **tự gọi một lượt sửa**; nếu vẫn còn thì nội dung được trả
   về kèm `guardrails_passed = false` và UI hiện cảnh báo — **không bao giờ im lặng**.

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
├── jobs/                  queue + pipeline
├── store/                 SQLite & PostgreSQL, cùng một schema.sql
├── session/               session cho sàn cần đăng nhập (none|file|cdp)
└── http/                  server + routes
public/                    giao diện (HTML/CSS/JS thuần, không build step)
test/                      test + fixture
tools/                     provider-probe, live-probe, sinh ảnh test
docs/                      kiến trúc, bảo mật, kiểm chứng, roadmap
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

---

## 7. Giấy phép & quy ước

Mã nguồn nội bộ của VIPORDER. Tài liệu và chú thích viết bằng tiếng Việt; thuật ngữ nước ngoài
được giữ nguyên khi là tên riêng của kỹ thuật (connector, guardrail, provenance…).
