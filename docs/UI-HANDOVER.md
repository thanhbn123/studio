# BÀN GIAO PHẦN HTML / UI — giao cho Claude làm tiếp

> Người bàn giao: phiên DSH · Ngày: **09/10/2026** · Nhánh nền: **`develop`**
> Đọc kèm: [`HANDOVER.md`](../HANDOVER.md) · [`VERIFICATION.md`](VERIFICATION.md) · [`EXPORT-CONTRACT.md`](EXPORT-CONTRACT.md) §4 · [`MVP-06-CONTRACT.md`](MVP-06-CONTRACT.md) §4 · [`MVP-08-CONTRACT.md`](MVP-08-CONTRACT.md) §5

---

## 1. Hiện trạng UI (đã chạy thật trên Chrome 154)

| | |
|---|---|
| File | `public/index.html` · `public/app.js` (~5.000 dòng) · `public/styles.css` |
| Công nghệ | **Vanilla JS, KHÔNG framework, KHÔNG build step, KHÔNG dependency** — giữ nguyên như vậy |
| Tab hiện có | **Nội dung** · **Dịch ảnh** · **Tạo ảnh** · **Video** · **Tài khoản / Quản trị** |
| Đã kiểm | `npm run test:e2e` — **Chrome THẬT** qua CDP (`tools/e2e/**`), 4/4 luồng, **0 lỗi console**, kéo-thả thật, gõ bàn phím thật, tải file rồi giải mã lại |

Mẫu code đang dùng (giữ nhất quán): `route()` định tuyến, `state` toàn cục, `api()` gọi HTTP,
`toast()` báo, mỗi tab một hàm `renderXxx()`, poll **1,5 giây** khi job đang chạy, thuộc tính
`data-*` để test bám vào, `esc()` escape **mọi** text động.

## 2. Việc UI còn lại (làm tiếp ở đây)

| Việc | Hợp đồng | Ghi chú |
|---|---|---|
| ~~**MVP-06**~~ — **ĐÃ LÀM, chờ gộp: PR [#33](https://github.com/thanhbn123/studio/pull/33)** (nhánh `thanhbn123/mvp06-topup`, 10/10/2026). Form “Nạp credit” + hướng dẫn chuyển khoản lấy từ `/api/config.billing.topup` + bảng yêu cầu của mình; tab **Quản trị**: `pending` + XÁC NHẬN (số credit + tỷ giá) / TỪ CHỐI (bắt buộc lý do). Test: `test/topup-ui.test.js` (hàm thật). | `MVP-06-CONTRACT.md` §4 · `VERIFICATION.md` §28 | **Còn thiếu:** luồng e2e Chrome thật (chờ PR #29 gộp rồi thêm vào `tools/e2e/run.mjs`); chưa đo PostgreSQL thật. |
| **MVP-07** — màn “Đăng bài”: danh sách nháp/chờ duyệt/đã đăng, xem trước nội dung + ảnh/video, nút **DUYỆT / TỪ CHỐI / ĐĂNG**; banner **“CHẾ ĐỘ THỬ — không đăng thật”** khi `dry-run` | PR #32 | Thiếu token ⇒ nói rõ “chưa cấu hình Facebook (cần Page ID + token)” |
| ~~**MVP-08**~~ — **ĐÃ LÀM, chờ gộp** (nhánh `thanhbn123/mvp08-marketplace`, 10/10/2026): tab **“Đăng sàn”** (`#/dangsan`): kênh → form bổ sung giá VND/tồn/cân nặng/danh mục → bảng listing với trạng thái, `external_id`/link, nút **XEM PAYLOAD / DUYỆT / TỪ CHỐI / ĐĂNG / ĐỒNG BỘ** (khoá kèm lý do), `issues[]` **từng dòng**. Test: `test/marketplace-ui.test.js` (hàm thật). | `MVP-08-CONTRACT.md` §5 · `VERIFICATION.md` §29 | Banner **“CHẾ ĐỘ THỬ — không đăng thật”** cho `dry-run`; “chưa có token Shopee/TikTok Shop…” cho kênh chưa cấu hình. **Còn thiếu:** e2e Chrome (chờ PR #29), PostgreSQL thật. |
| **Gói xuất bản (.zip)** — panel đã có ở 4 màn job (đã merge) | `EXPORT-CONTRACT.md` §4 | Nếu thêm màn mới (MVP-06/07/08) thì **cân nhắc** thêm nút tải gói ở đó |

## 3. Luật cứng của phần UI (không được nới)

1. **Không thêm dependency, không build step.** Nếu thấy cần thư viện ⇒ **hỏi trước**, đừng tự thêm.
2. **`esc()` mọi text động** (tên job, tiêu đề, ghi chú, `issues[]`, mã lỗi từ sàn…). Có test XSS.
3. **Không bao giờ nói quá sự thật**: nhãn `MOCK_VERIFIED` / `MANUAL_INPUT` phải hiện đúng; **không** hiện badge “LIVE” nếu chưa gọi dịch vụ thật; video **không tiếng** phải nói rõ; gói `.zip` phải nói rõ “các bước dùng dữ liệu giả ghi trong MANIFEST.json”.
4. **Lỗi thật phải hiện ra** (mã + câu tiếng Việt), không nuốt lỗi, không “thành công” giả. Nút **disabled** khi thiếu id/thiếu quyền, kèm **lý do**.
5. **Không phá tab cũ.** Mọi hàm render bị test trích phải **giữ chữ ký** hoặc thêm tham số **có mặc định** (bài học: một lần gọi `exportPanelHtml` trong `renderIlJob` đã làm **đỏ 22 test** vì harness biên dịch từng hàm với bộ phụ thuộc cố định — cách sửa đúng là **bơm slot HTML qua tham số**, **không** dùng `typeof` guard để giấu tính năng).
6. Tiếng Việt, câu ngắn, không viết hoa toàn bộ (trừ nút hành động chính). Không dùng từ ngữ marketing sáo rỗng.

## 4. Cách kiểm (bắt buộc trước khi mở PR)

```bash
env -u DATABASE_URL npm test      # 0 fail — ⚠️ đừng chạy `npm test` trần: DATABASE_URL trỏ PG đã tắt
node tools/verify.mjs
npm run test:e2e                  # Chrome THẬT qua CDP; phải 0 lỗi console
```

- **Test hàm thật**: theo mẫu `test/*-ui-helpers.js` (trích **nguyên văn** hàm từ `public/app.js` + DOM giả).
- **Test trình duyệt thật**: thêm luồng vào `tools/e2e/run.mjs` cho màn mới (MVP-06/07/08) — mỗi luồng phải có **ảnh chụp** + **0 lỗi console**.
- Bằng chứng phải là **output thật** dán vào báo cáo, không phải lời kể.

> **Cập nhật 10/10/2026 (nhánh `thanhbn123/e2e-pg-mvp06-08`):** `npm run test:e2e` nay có 8 luồng — thêm gói `.zip` (f5), Nạp credit (f6), Đăng bài (f7), Đăng sàn (f8); 8/8 PASS, 0 lỗi console. Đăng nhập trong e2e dùng `uiLogin()`/`uiLogout()` (form thật); dữ liệu gieo xem `SEED` trong `tools/e2e/run.mjs` và `VERIFICATION.md` §30. Luồng mới nào cố ý gây lỗi HTTP thì khai `allowConsole` + `allowReason` cho RIÊNG luồng đó.

## 5. Khoảng trống đã biết của UI (cập nhật 10/10/2026 — nhánh `thanhbn123/ui-khoang-trong`, `VERIFICATION.md` §31)

1. ~~**Mobile/viewport nhỏ** chưa từng đo~~ — **ĐÃ ĐO**: e2e f10, 11 màn ở 375×812 không cuộn ngang. Tìm và sửa 1 lỗi thật: mở "Xem bản kê khai" làm trang rộng 479px (chuỗi JSON không ngắt) ⇒ `.panel, .notice { overflow-wrap: anywhere }`. **Còn:** trên điện thoại thanh nav chiếm gần trọn màn hình đầu (chưa gọn lại thành menu).
2. **Firefox/Safari** chưa đo — máy chưa có trình điều khiển (geckodriver/safaridriver chưa bật); bộ e2e hiện chỉ nói chuyện CDP.
3. ~~**A11y** chưa soát~~ — **ĐÃ SOÁT PHẦN TĨNH**: e2e f11 trên 11 màn (ô nhập có nhãn, nút có tên, ảnh có alt, `lang="vi"`); sửa 2 ô thiếu nhãn (`#url` trang chủ, `#mk-filter-status`). **Còn:** thứ tự Tab, dùng được chỉ bằng bàn phím, tương phản màu.
4. ~~**Trạng thái tải**: bấm 2 lần có thể gửi 2 request~~ — **ĐÃ SỬA MỘT CHỖ cho mọi nút**: khoá trong `onGlobalClick` (handler trả Promise ⇒ lượt trùng cùng hành động + đối tượng bị bỏ qua, nút có `aria-busy`). Đo trước: ~20 nút gọi API không có khoá riêng (có `regenerate`, `vscreate` tốn credit). e2e f9: bấm ĐÚP thật ⇒ 1 lượt gọi + 1 lượt tải; gỡ khoá ⇒ 2 lượt (đột biến đỏ). **Còn:** chưa có spinner riêng từng nút.
5. ~~**Poll 1,5 giây** đóng khối "Xem bản kê khai"~~ — **ĐÃ SỬA**: nhớ HTML bản kê khai đã mở trong `state.exportManifest`, `exportPanelHtml` vẽ lại (chỉ cho đúng job). e2e f9 + đột biến đỏ.
6. ~~Chưa có **tìm kiếm/lọc** lịch sử~~ — **ĐÃ LÀM**: ô tìm (không phân biệt hoa thường, bỏ dấu) + lọc trạng thái, chỉ trong 100 job đã tải — màn hình nói rõ phạm vi khi máy chủ có nhiều hơn. **Còn:** lọc phía máy chủ / phân trang.

## 6. Định nghĩa XONG cho một PR UI

- `npm test` **0 fail** · `verify.mjs` EXIT 0 · **`npm run test:e2e` 0 lỗi console**, luồng mới PASS.
- Ảnh chụp màn hình mới (đặt ở `docs/assets/` nếu là màn quan trọng).
- Không thêm dependency; không sửa `test/**` của sprint khác (trừ khi thêm file mới).
- Cập nhật `docs/VERIFICATION.md`: màn nào **đã đo trên trình duyệt thật**, màn nào **chưa**.
