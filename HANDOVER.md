# BÀN GIAO — VIP PRODUCT STUDIO (từ phiên DSH sang Claude)

> **Đọc file này trước.** Đây là gói bàn giao để một agent khác (Claude) tiếp tục dự án mà không cần
> đọc lại toàn bộ lịch sử phiên làm việc trước.
>
> Chi tiết đầy đủ: **[`docs/HANDOVER-FROM-DSH.md`](docs/HANDOVER-FROM-DSH.md)**.
> Luật làm việc của repo: `CLAUDE.md` (nếu có) — **file này không thay thế `CLAUDE.md`**.

Ngày bàn giao: **07/10/2026** · Nhánh chính: **`develop`** · Commit lúc bàn giao: **`2c51464`**

---

## 1. Trạng thái thật (đo được, không phải lời kể)

```bash
env -u DATABASE_URL npm test     # 986 test · 980 pass · 0 fail · 6 skipped   ← baseline ĐÚNG
env -u DATABASE_URL npm run verify  # kiểm cú pháp + test → EXIT 0
npm run demo:imagelab            # job "succeeded" + nhãn MOCK_VERIFIED
npm start                        # http://127.0.0.1:3000
```

⚠️ **Cạm bẫy môi trường:** biến `DATABASE_URL` trong shell hiện đang trỏ tới
`postgres://studio:studio@127.0.0.1:55440/studio` — **PostgreSQL đó đã tắt**, nên nếu để nguyên biến
này thì 5–6 test PostgreSQL **fail vì `ECONNREFUSED`** (không phải lỗi mã). Hoặc `env -u DATABASE_URL`,
hoặc dựng lại PG rồi chạy — CI có job PostgreSQL 16 thật.

| Giai đoạn | Trạng thái | PR | Hồ sơ nghiệm thu |
|---|---|---|---|
| MVP-01 Nội dung | ✅ merged | — | `docs/VERIFICATION.md` |
| MVP-02 Dịch ảnh + **IL-08 nhập vùng tay** | ✅ merged | #20 | `docs/MVP-02-ACCEPTANCE.md` |
| MVP-03 Tạo ảnh (tách nền/ghép nền/retouch) | ✅ merged | #21 | `docs/MVP-03-ACCEPTANCE.md` |
| MVP-04 Video (phần offline, GIF) | ✅ merged | #23 | `docs/MVP-04-ACCEPTANCE.md` |
| MVP-05 Tài khoản + ví credit | ✅ merged | #22 | `docs/MVP-05-ACCEPTANCE.md` |
| Sprint độ tin cậy R1 (hàng đợi bền, khoá tiền DB, cron) | ✅ merged | #24 | `docs/R1-REVIEW.md` |
| Bộ triển khai trực tiếp (`deploy/`) | ✅ merged (do Claude) | #25 | `docs/DIRECT-DEPLOY.md` |
| MVP-06 Thanh toán · MVP-07/08 Đăng bài | ⛔ **chờ Owner quyết** | — | `docs/OWNER-DECISIONS.md` |

---

## 2. Ba việc còn lại — đều cần **Owner** quyết (đừng tự làm)

1. **Đo provider thật** (OCR / dịch / matting / TTS) — tốn tiền, cần ngân sách. Hiện chạy được nhờ
   `*_PROVIDER=mock` + đường **nhập vùng chữ bằng tay (IL-08)** cho ảnh thật.
2. **MVP-06 thanh toán** — cần: nhà cung cấp (Stripe/PayOS/VNPay/MoMo?), pháp nhân nhận tiền, đơn vị
   giá (credit hay gói), chính sách hoàn tiền, có xuất hoá đơn không.
3. **MVP-07/08 đăng bài Facebook/TikTok/Shopee** — cần Page ID/token + **app review** của nền tảng, và
   nên chọn chế độ **duyệt tay trước khi đăng**.

Chi tiết câu hỏi: `docs/OWNER-DECISIONS.md`.

---

## 3. Việc **làm được ngay** mà không cần Owner quyết

| Việc | Vì sao đáng làm |
|---|---|
| Đo UI trên **trình duyệt thật** (DOM/kéo-thả/poll) | Mọi UI hiện chỉ được test bằng **hàm thật chạy trong Node**, chưa có DOM thật |
| Phủ **PostgreSQL** cho các bảng mới (MVP-03/04/05/R1) | CI đã chạy schema + migration trên PG 16 thật, nhưng test nghiệp vụ vẫn SQLite |
| Đo `deploy/` end-to-end trên máy chủ thật | Bộ `deploy/` đã có 76/76 ca thử tại máy, **chưa lần nào triển khai thật** |
| Giảm chi phí provider khi lease mất (R3) | Xem `docs/VERIFICATION.md` §22.7 — có 4 cách đã ghi |

---

## 4. Cách làm việc trong repo này (bắt buộc giữ)

1. **Hợp đồng trước, code sau.** Mỗi giai đoạn có `docs/MVP-0x-CONTRACT.md` **đóng băng** (tên hàm,
   field, mã lỗi, bản đồ sở hữu file). Agent code **chỉ được ghi file mình sở hữu**.
2. **Phản biện độc lập là bắt buộc.** Mỗi sprint phải qua một agent **cố tình phá**, chỉ được ghi
   `docs/*-REVIEW.md`, mọi kết luận phải kèm **lệnh + output thật**. Ở dự án này phản biện đã bác
   đúng những chỗ nhóm tự tin nhất (MVP-02: xoá pixel logo; MVP-04: chữ bịa vẫn được vẽ 10.535 px;
   R1: cron cướp việc ⇒ hoàn tiền oan).
3. **Không bịa.** Không bao giờ ghi `LIVE_VERIFIED` cho kết quả mock; thà trả `PARTIAL`/`NO_CHANGES`
   kèm lý do thật còn hơn báo `succeeded` giả. Mọi lỗi phải có `code` máy đọc được.
4. **Ba luật bất khả xâm phạm** (xuyên suốt dự án): ảnh gốc **bất biến** · nhãn hiệu/chứng nhận/giá
   **không bao giờ bị dịch hay xoá** · **fail-closed** (không đủ tự tin thì từ chối, không đoán).
5. **Chỉ merge khi xanh:** `npm test` 0 fail · `node tools/verify.mjs` EXIT 0 · CI 5/5 · phản biện PASS
   (hoặc điều kiện đã vá).

---

## 5. Năm cạm bẫy đã vấp (đọc để khỏi vấp lại)

1. **Script phản biện có "khẳng định in cứng" viết cho bản CŨ** ⇒ đọc **số liệu**, đừng để dòng
   `FAIL ::` quyết định phán quyết. (Đã gặp ở MVP-03, MVP-04 và R1.)
2. **Test hardcode số** (`pricing.length === 10`) ⇒ vỡ mỗi lần thêm operation. Hãy so với hằng số.
3. **Khác nền tảng**: nén zlib của `encodePng` **không byte-identical giữa macOS và Linux** ⇒ so
   **pixel**, đừng so byte.
4. **Máy quá tải**: encode video 30 giây ≈ 331 triệu điểm ảnh ⇒ chạy **tuần tự**, đừng mở nhiều tiến
   trình nặng song song (đã từng làm `npm test` chậm 20×).
5. **Thu tiền theo LƯỢT CHẠY, không theo jobId** (MVP-05 §BR-02) — khoá chống trùng phải mang danh
   tính lượt (`runKey`), nếu không sẽ hoặc chạy trùng, hoặc thu tiền hai lần.

---

## 6. Bản đồ tài liệu

| Cần gì | Đọc |
|---|---|
| Bàn giao đầy đủ | `docs/HANDOVER-FROM-DSH.md` |
| Kế hoạch giai đoạn | `docs/ROADMAP.md` |
| Cái gì đo được / chưa đo | `docs/VERIFICATION.md` (nhất là §22.7 của R1) |
| Hợp đồng từng giai đoạn | `docs/MVP-0{2,3,4,5}-CONTRACT.md`, `docs/R1-RELIABILITY-CONTRACT.md` |
| Phản biện nguyên văn | `docs/MVP-0{2,3,4,5}-REVIEW.md`, `docs/R1-REVIEW.md` |
| Nghiệm thu cho Owner | `docs/MVP-0{2,3,4,5}-ACCEPTANCE.md` |
| Quyết định cần Owner | `docs/OWNER-DECISIONS.md` |
| Triển khai | `docs/DIRECT-DEPLOY.md` + `deploy/` |
