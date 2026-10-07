# BÀN GIAO CHI TIẾT — từ phiên DSH (DeepSeek Harness) sang Claude

> Gói này để một agent khác tiếp tục dự án **mà không cần đọc lại lịch sử phiên**.
> Bản ngắn ở [`../HANDOVER.md`](../HANDOVER.md). File này là bản đầy đủ.
>
> Người bàn giao: phiên DSH (điều phối + nhiều agent con). Ngày: **07/10/2026**.
> Trạng thái: `develop` @ **`2c51464`**.

---

## 1. Dự án là gì

**VIP Product Studio** — biến **link sản phẩm Trung Quốc** (Taobao/1688/Pinduoduo) thành **nội dung bán
hàng tiếng Việt trung thực**: nội dung mô tả, ảnh marketing, video ngắn; có tài khoản + ví credit.

Nguyên tắc xuyên suốt: **không bịa**. Hệ thống phải nói đúng cái nó đo được: nhãn `MOCK_VERIFIED` khi
dùng provider giả, `MANUAL_INPUT` khi ảnh do người dùng tải lên, và **không bao giờ** `LIVE_VERIFIED`
nếu chưa gọi dịch vụ thật.

---

## 2. Trạng thái đo được (không phải lời kể)

```bash
env -u DATABASE_URL npm test          # 986 test · 980 pass · 0 fail · 6 skipped
env -u DATABASE_URL npm run verify    # EXIT 0
npm run demo:imagelab                 # job succeeded · nhãn MOCK_VERIFIED · ảnh gốc bất biến
npm start                             # server thật, UI 4 tab
```text

| Hạng mục | Số |
|---|---|
| Test | **986** (980 pass · 0 fail · 6 skip = các test PostgreSQL khi không có `DATABASE_URL`) |
| CI (GitHub Actions) | **5 job**: test SQLite · test PostgreSQL 16 · smoke server thật · build Docker + chạy trong ảnh · quét secret |
| Giai đoạn đã merge | MVP-01, MVP-02 (+IL-08), MVP-03, MVP-04 (offline), MVP-05, sprint R1, bộ `deploy/` (do Claude) |
| Số vòng phản biện đã chạy | MVP-02: 6 · MVP-03: 3 · MVP-04: 5 · MVP-05: 4 · R1: 3 |

⚠️ **`DATABASE_URL` trong shell hiện trỏ tới PostgreSQL đã tắt** (`127.0.0.1:55440`) ⇒ nếu để nguyên,
6 test PG sẽ **fail vì `ECONNREFUSED`** (không phải lỗi mã). Dùng `env -u DATABASE_URL`, hoặc dựng lại PG.

---

## 3. Kiến trúc (bản đồ nhanh)

```text
src/
  app.js              composition root — nạp MỌI module theo kiểu PHÒNG THỦ (try/catch + dynamic import)
  config.js           cấu hình + env (mỗi giai đoạn thêm một khối; .env.example là hợp đồng)
  server.js           HTTP server + scheduler (cron) + tắt sạch
  scheduler.js        cron: dọn lượt ví treo + nhặt việc hàng đợi đang chờ
  store/              schema.sql (SQLite + PostgreSQL dùng CHUNG) + index.js (migration cộng thêm idempotent)
  jobs/queue.js       hàng đợi BỀN (job_queue) — claim nguyên tử, heartbeat/lease, epoch/fencing, retry
  content/ ai/ vision/ sources/   MVP-01: lấy nội dung, vision, sinh nội dung tiếng Việt
  imagelab/           MVP-02: OCR (mock/http/none) · dịch + guardrails chống bịa · render PNG + font Việt
  imagestudio/        MVP-03: matting (flood fill, fail-closed) · compose nền mẫu · retouch kẹp ngưỡng
  videostudio/        MVP-04: plan (kịch bản khung hình) · encode (GIF LZW tự viết) · pipeline
  accounts/           MVP-05: scrypt, token chỉ lưu sha256, phiên
  billing/            MVP-05: sổ credit APPEND-ONLY, số dư = tổng sổ, không bao giờ âm
  http/routes.js      ~4.500 dòng: mọi route + phân quyền theo session/tài khoản + rate limit
public/               UI 4 tab: Nội dung · Dịch ảnh · Tạo ảnh · Video (+ Tài khoản/Quản trị)
deploy/               bộ triển khai trực tiếp (do Claude dựng, chưa chạy thật lần nào)
tools/                verify.mjs · imagelab-demo.mjs · make-test-image.mjs …
```

**Ba luật bất khả xâm phạm** (kiểm bằng test, không phải bằng lời): **ảnh gốc bất biến** (sha256
trước/sau) · **nhãn hiệu/chứng nhận/giá không bao giờ bị dịch hay xoá** · **fail-closed** (không đủ tự
tin thì từ chối kèm số đo, không đoán).

**Năm luật riêng của MVP-03**: không bóp méo sản phẩm · nền sinh ra là **MÔ PHỎNG phải khai** · tách nền
fail-closed · retouch **bị kẹp ngưỡng và ghi lại** · overlay thiếu bằng chứng thì **không vẽ**.

**Hai luật của MVP-05**: **ẩn danh không bị phá** (dán link là chạy, không cần đăng nhập, không trừ
credit) · **sổ credit append-only, không bao giờ âm**.

---

## 4. Cách làm việc của phiên trước (giữ nguyên nếu muốn chất lượng tương đương)

1. **Khoá hợp đồng trước**: viết `docs/MVP-0x-CONTRACT.md` (mục tiêu, **bản đồ sở hữu file**, chữ ký
   hàm, shape dữ liệu, mã lỗi, định nghĩa XONG). Hợp đồng là **luật**; agent thấy sai thì báo người
   điều phối, không tự sửa.
2. **Chia việc theo file**: 5 agent code song song, **mỗi agent chỉ ghi file mình sở hữu** ⇒ không xung
   đột. Agent phải tự chạy thử ở `/tmp` và dán output thật.
3. **Agent test độc lập** viết test vào `test/**` (không được sửa `src/**`); nếu tìm ra mã sai thì viết
   test thể hiện hành vi ĐÚNG (test đỏ) và **báo cáo**, không tự sửa.
4. **Agent phản biện độc lập** cố tình phá, chỉ ghi `docs/*-REVIEW.md`, mọi kết luận kèm lệnh + output.
   Đây là bước **không được bỏ** — nó bắt được những lỗi nặng nhất ở cả 5 sprint.
5. **Agent gộp** sửa mọi phát hiện + lệch hợp đồng, chạy lại script của phản biện để chứng minh.
6. **Chỉ merge khi xanh**: test 0 fail · verify EXIT 0 · CI 5/5 · phản biện PASS (hoặc điều kiện đã vá).
   Merge bằng PR vào `develop`; `main` chỉ nhận bản đã nghiệm thu.

---

## 5. Những chỗ đã từng sai (đọc để khỏi lặp)

| # | Cạm bẫy | Cách tránh |
|---|---|---|
| 1 | **Script phản biện có khẳng định in cứng viết cho bản CŨ** ⇒ in `FAIL ::` dù số liệu đã đúng | Đọc **số liệu** trong output, đừng để câu in cứng quyết định |
| 2 | Test hardcode con số (`pricing.length === 10`) | So với hằng số (`USAGE_OPERATIONS.length`) |
| 3 | `encodePng` **khác byte giữa macOS/Linux** (zlib) | So **pixel**, đừng so byte |
| 4 | Encode video 30s ≈ 331 triệu điểm ảnh ⇒ máy quá tải, test chậm 20× | Chạy **tuần tự**, không mở nhiều job nặng song song |
| 5 | Thu tiền **theo jobId** ⇒ chạy lại miễn phí hoặc thu hai lần | Khoá theo **lượt chạy** (`runKey`) — MVP-05 §BR-02 |
| 6 | Bộ kiểm chống bịa ở **hai tầng** mà một tầng bị nuốt (`viaV1 ?? fallback`) | Khi có hai bộ kiểm, dùng **hợp** của chúng và test đối chứng **hai chiều** (chặn được chữ bịa + **không** chặn oan chữ lành) |
| 7 | Chữ nguỵ trang: không dấu, homoglyph (Cyrillic/Hy Lạp), full-width, dấu câu chen, dính chữ, **tách cụm sang 2 mục**, mảng/object lồng | Chuẩn hoá **và** khớp "bỏ dấu câu giữa các từ" có ranh giới, **nối mọi đoạn chữ**; chặn ký tự ngoại (Hy Lạp/Cyrillic) và số đặc biệt (`Ⅰ Ⅻ № ①`) |
| 8 | `DATABASE_URL` trỏ PG đã tắt ⇒ test PG đỏ vì `ECONNREFUSED` | `env -u DATABASE_URL` hoặc dựng lại PG |
| 9 | Migration: index trong `schema.sql` cho cột mới làm **chết `init()`** trên DB cũ | Tạo index **sau** migration; DDL phải **idempotent** (`duplicate column name` = thành công) |
| 10 | Nhiều tiến trình boot cùng lúc ⇒ `database is locked` | `busy_timeout` đặt **trước** mọi pragma + ngân sách retry có trần (R1 §B2) |

---

## 6. Việc còn lại

### 6.1 Cần **Owner** quyết (đừng tự làm)

1. **Đo provider thật**: OCR / dịch / matting / TTS — tốn tiền. Hiện `.env` có `AI_PROVIDER=deepseek`;
   muốn đo phải được Owner cho ngân sách. Đường **không tốn tiền** cho ảnh thật: **IL-08 nhập vùng chữ
   bằng tay** (`PUT /api/imagelab/jobs/:id/regions`) + `npm run demo:imagelab -- --regions vung.json`.
2. **MVP-06 thanh toán**: nhà cung cấp, pháp nhân nhận tiền, đơn vị giá, chính sách hoàn tiền, hoá đơn.
3. **MVP-07/08 đăng bài**: nền tảng nào trước, Page ID/token, app review, chế độ duyệt tay.

Câu hỏi cụ thể: [`OWNER-DECISIONS.md`](OWNER-DECISIONS.md).

### 6.2 Làm được ngay (không cần Owner)

| Việc | Gợi ý bắt đầu |
|---|---|
| Test UI trên **trình duyệt thật** (DOM, kéo-thả, poll, tải tệp) | Hiện chỉ test bằng **hàm thật chạy trong Node** (`test/*-ui-helpers.js`) |
| Phủ **PostgreSQL** cho bảng mới (MVP-03/04/05/R1) | CI đã chạy schema/migration trên PG 16; test nghiệp vụ vẫn SQLite |
| Chạy `deploy/` **thật** lần đầu | `docs/DIRECT-DEPLOY.md` — 76/76 ca thử tại máy, chưa triển khai lần nào |
| Giảm rủi ro R3 (mất lease ⇒ 2 tiến trình cùng thực thi) | 4 cách ghi ở `VERIFICATION.md` §22.7 |

### 6.3 Giới hạn đã biết (đã ghi tài liệu, **không** phải lỗi mã)

- **SQLite là một khoá ghi toàn cục** ⇒ trần chờ liên tiến trình = `số lần thử × lockTimeoutMs`
  (tệ nhất ~31,5s mặc định; giảm bằng `BILLING_LOCK_TIMEOUT_MS` / `QUEUE_LOCK_TIMEOUT_MS`). PG giữ khoá **per-user**.
- **Mô hình lease**: `SIGSTOP`/máy ngủ ⇒ có thể **hai tiến trình cùng thực thi** một mục; tiền/trạng thái
  đã fenced nhưng **chi phí provider có thể nhân đôi**.
- Tham số request (`force`, `only_region_ids`, `options`) **không được lưu** ⇒ lượt khôi phục sau restart
  dùng **mặc định an toàn**.
- **Video MVP-04 không có tiếng** (GIF không chứa âm thanh) và **chưa có MP4/H.264** (cần `ffmpeg`; máy
  này không có — provider fail-closed `FFMPEG_NOT_AVAILABLE`).
- **Tách nền MVP-03** chỉ hợp ảnh **nền đồng nhất**; sản phẩm cách nền ≤ 8/255 là giới hạn vật lý.
- **Chưa đo**: provider thật · đa tiến trình PG cho lease/epoch · mất điện/fsync · tải lớn · trình duyệt thật.

---

## 7. Bản đồ tài liệu

| File | Nội dung |
|---|---|
| `HANDOVER.md` (gốc) | bản ngắn của gói này |
| `docs/ROADMAP.md` | kế hoạch MVP-01→08 + trạng thái từng giai đoạn |
| `docs/VERIFICATION.md` | cái gì **đo được** / **chưa đo** (đọc §22.7 cho R1) |
| `docs/MVP-0{2,3,4,5}-CONTRACT.md` | hợp đồng đóng băng từng giai đoạn |
| `docs/R1-RELIABILITY-CONTRACT.md` | hợp đồng sprint độ tin cậy |
| `docs/MVP-0{2,3,4,5}-REVIEW.md`, `docs/R1-REVIEW.md` | **phản biện nguyên văn** (giữ nguyên, không sửa) |
| `docs/MVP-0{2,3,4,5}-ACCEPTANCE.md` | hồ sơ nghiệm thu cho Owner (checklist + giới hạn) |
| `docs/OWNER-DECISIONS.md` | câu hỏi cần Owner quyết |
| `docs/DIRECT-DEPLOY.md` + `deploy/` | triển khai trực tiếp |
| `docs/SECURITY.md` | ghi chú an toàn (cookie, rate limit, `trust proxy`) |
| `docs/assets/` | ảnh minh chứng: `mvp02-truoc-sau.png`, `mvp03-truoc-sau.png`, `mvp04-video-mau.gif` |

---

## 8. Điều phiên DSH **KHÔNG** làm / **KHÔNG** xác nhận

Để Claude không hiểu nhầm là "đã xong hết":

1. **Chưa từng gọi provider trả tiền** ⇒ mọi số liệu về OCR/dịch/matting/TTS đều là **mock**.
2. **Chưa từng chạy trên trình duyệt thật** ⇒ UI chỉ được kiểm bằng hàm thật trong Node.
3. **Chưa từng triển khai** ⇒ `deploy/` mới chỉ có ca thử tại máy.
4. **Chưa có thanh toán** ⇒ credit chỉ do quản trị cấp tay.
5. **Chưa đăng bài lên nền tảng nào.**
6. **Không tự ký nghiệm thu** — 4 hồ sơ `MVP-0x-ACCEPTANCE.md` đang **chờ Owner ký**.
7. Trong phiên có **agent bị treo/lỗi** vài lần; phần việc đó do người điều phối tự làm và **đã ghi rõ
   trong commit message** (ví dụ commit `023a711`, `0809931`, `5a53da0`) để không ai tưởng là agent làm.

---

## 9. Nếu Claude muốn tiếp tục đúng nhịp

1. Đọc `HANDOVER.md` → `docs/ROADMAP.md` → `docs/OWNER-DECISIONS.md`.
2. Chọn một việc ở §6.2 (làm được ngay) **hoặc** chờ Owner trả lời §6.1.
3. Viết hợp đồng đóng băng trước, chia agent theo file, **bắt buộc có agent phản biện độc lập**.
4. Kết thúc mỗi sprint: `env -u DATABASE_URL npm test` 0 fail · `npm run verify` EXIT 0 · CI 5/5 ·
   cập nhật `docs/VERIFICATION.md` (cái gì **chưa** đo) và `docs/ROADMAP.md`.
