# MVP-03 — BÁO CÁO PHẢN BIỆN ĐỘC LẬP

PHÁN QUYẾT: **FAIL**

- Nhánh: `feat/mvp03-imagestudio` · Commit: `ac8efa9` (người phản biện chạy 10:20–10:45 ngày 04/10/2026)
- Người phản biện: agent độc lập, **không sửa mã nguồn, không sửa `test/**`**. Mọi script nằm ở `/tmp/mvp03-atk/**`; file duy nhất được ghi trong repo là báo cáo này.
- `git status --short` khi kết thúc: `docs/MVP-03-REVIEW.md` (báo cáo này) + 9 file `test/imagestudio-*.test.js` và `test/imagestudio-*.mjs` **untracked do agent test viết song song trong lúc tôi phản biện** (mtime 10:26–10:33) + `docs/MVP-05-CONTRACT.md` (có trước khi tôi bắt đầu). Tôi không ghi vào file nào khác.
- Cách chạy lại: `cd /tmp/mvp03-atk && node <tên script>` — harness tự dựng **app THẬT** (HTTP thật, SQLite, storage trong `/tmp/mvp03-atk/run/`) với provider `purejs` thật; không cần mạng, không cần API key.

**Kết quả tổng quan: 1 CRITICAL · 1 MAJOR · 4 MINOR.** Phần lớn hợp đồng MVP-03 **đúng và đã cố phá không phá được** (mục 3: fail-closed tách nền, kẹp retouch, ảnh gốc bất biến, nhãn MÔ PHỎNG, IDOR, XSS, usage/evidence). Nhưng **luật bất khả xâm phạm #1 (“không bóp méo sản phẩm”) bị vi phạm ở mức pixel trong ca sản phẩm màu gần màu nền — và hệ thống vừa báo `succeeded` vừa hiện lời khẳng định ngược lại**; cùng với đó là **đường “tự rửa tội” của overlay** mà chính hiến chương yêu cầu soi (D2).

---

## 1. Tóm tắt

| # | Mức | Phát hiện | Bằng chứng (1 dòng) | Vì sao quan trọng | Gợi ý sửa (KHÔNG tự sửa) |
|---|---|---|---|---|---|
| **F1** | **CRITICAL** | Sản phẩm **màu gần màu nền** (áo trắng 240 trên nền trắng 255) bị flood fill coi là nền ⇒ **2048/2048 pixel sản phẩm bị xoá và đè bằng màu nền mô phỏng**; job vẫn `succeeded`, `SUSPICIOUS_MASK` không kích hoạt (ratio 0.9375 < 0.98), và cả pipeline lẫn UI hiện lời khẳng định **“Pixel sản phẩm (RGB + alpha) giữ nguyên từng byte”** | `node a2b-white-product.mjs` → `job.status = succeeded` · `mask = {"coverage":0.0625,"background_ratio":0.9375,"uniformity":1}` · `pixel vùng "áo" còn màu áo gốc = 0, đã bị đổi thành màu nền mô phỏng = 2048` · `mẫu pixel (10,10) trong áo → [217,234,252,255]` (áo là 240,240,240) | Luật #1 của MVP-03 và mục “ĐỊNH NGHĨA XONG”: ảnh giao cho khách **mất sản phẩm**, hệ thống **tự báo cáo sai** rằng pixel được giữ nguyên (đúng lớp lỗi đã cho MVP-02 F-01 mức CRITICAL). Ca này không hiếm: đồ trắng/màu kem chụp trên nền trắng là kiểu ảnh TMĐT phổ biến nhất | (a) **Kiểm chứng thật ở tầng ghép**: `composeImage` đã có sẵn ảnh gốc — đối chiếu từng byte RGBA vùng `alpha > 0` với ảnh gốc, lệch ⇒ `KEPT_PIXELS_CHANGED`, không lưu ảnh + `status = PARTIAL`. (b) Sau matting, nếu `background_ratio` cao **bất thường so với `kept_bbox`/coverage** hoặc nếu vùng bị xoá chứa pixel có khoảng cách màu tới màu nền **> ngưỡng an toàn riêng (≈8/255)** ⇒ từ chối (`SUSPICIOUS_MASK`). (c) Bỏ câu “pixel giữ nguyên từng byte” khỏi `warnings` của provider — chỉ được nói khi đã kiểm |
| **F2** | **MAJOR** | **Đường “tự rửa tội” của overlay**: client gửi kèm `overlay.source_text` / `overlay.notes` / mảng cùng nội dung ⇒ guardrail coi đó là “chữ gốc của job” ⇒ **vẽ thẳng khẳng định bịa** lên ảnh, `job = succeeded`, UI hiện khối xanh **“Đã vẽ chữ overlay (có kiểm chống bịa)”**. Route còn **chủ động bỏ qua 422** khi thấy client khai bằng chứng | `node d-overlay.mjs`: không bằng chứng → `HTTP 422` (8/8 câu); thêm `source_text` → `HTTP 202 job=succeeded overlay.applied=true pixel vẽ ở dải trên=152`. `node d2b-variants.mjs`: `source_text`=152 px, `notes`=152 px, mảng=152 px | Đúng lỗ “bằng chứng vòng” mà `docs/VERIFICATION.md §7.1` gọi là **lỗ hổng nặng nhất của MVP-01** (ở đó bằng chứng đến từ chính model; ở đây đến từ chính request). Hợp đồng §3.5 định nghĩa `textGốcCủaJob` = **OCR + tên sản phẩm + ghi chú người dùng ĐÃ LƯU**, không phải field client tự khai; và mục “ĐỊNH NGHĨA XONG” hứa “overlay thiếu bằng chứng ⇒ không vẽ + 422” | Bằng chứng chỉ được lấy từ **dữ liệu đã lưu của job** (`job.product_name`, `listOcrRegions`, vùng `source='user'` trong DB) — xoá 16 khoá evidence khỏi `sanitizeImagestudioOverlay` và xoá nhánh `overlayHasClientEvidence` (routes.js:351–361, 380, 2012–2019) + `resolveSourceText` chỉ nhận `params.source_text` do **server** truyền (overlay.js:108–136). Nếu muốn người dùng bổ sung bằng chứng thì phải đi qua đường fact có `provenance` như MVP-02 |
| **F3** | MINOR | **Ở đúng commit được chấm, MVP-03 KHÔNG có test nào** — `npm test` xanh không chứng minh gì cho sprint này; bộ test 101 ca xuất hiện **untracked trong lúc tôi phản biện** và **không phủ ca F1** | `git show --stat HEAD \| grep -c "test/"` → `0`; `git grep -l imagestudio HEAD -- test/` → rỗng; `stat test/imagestudio*` → mtime `10:26–10:33` (tôi chạy baseline `npm test` lúc 10:24); `npm test` 10:34 → **683 test · 682 pass · 0 fail · 1 skipped**; `node --test test/imagestudio-*.test.js` → 101/101 pass | Lặp lại đúng F-07 của MVP-02 (chỉ khác là ở đó test đã viết xong nhưng chưa commit). Không có test pixel nào cho “sản phẩm gần màu nền” nên F1 sống sót qua toàn bộ vòng tự kiểm | Commit bộ test MVP-03 **trước khi nghiệm thu**, và thêm ca pixel bắt buộc: sản phẩm 240 trên nền 255 ⇒ hoặc từ chối, hoặc không được đổi pixel sản phẩm |
| **F4** | MINOR | **Cổng “chưa dịch” của overlay hẹp hơn MVP-02 và trả sai mã**: kana/Hangul **không** bị `hasCjk` bắt (chỉ thoát nhờ font thiếu glyph), và overlay Hán **có số** trả `OVERLAY_UNSUPPORTED_CLAIM` thay vì `OVERLAY_NOT_TRANSLATED` | `node d2b-variants.mjs`: `"保修"` → `422 OVERLAY_NOT_TRANSLATED`; `"保修 12 个月"` → `422 OVERLAY_UNSUPPORTED_CLAIM` (sai mã); `"こんにちは"`/`"한국어"` → `202 job=PARTIAL applied=false reason=OVERLAY_NO_GLYPH` | `hasUntranslatedScript` (đã có từ F-08 MVP-02) phủ kana/Hangul nhưng đường overlay chỉ dùng `hasCjk`; hôm nay chữ không được vẽ **do may mắn của bộ font**, không do luật. Mã lỗi sai làm UI/test đọc sai loại vi phạm | Đổi `hasCjk` → `hasUntranslatedScript` trong `routes.js` + `overlay.js`; kiểm “chưa dịch” **trước** danh sách vi phạm số liệu |
| **F5** | MINOR | Retouch `NO_CHANGES` (không sửa pixel nào) vẫn ghi `retouch_effective` **khác 0** lên ảnh rendered và lên `content_meta` ⇒ dấu vết mô tả một lần retouch chưa từng chạy | `node a3-clamp.mjs` (A3.2): `brightness 99 → status=succeeded retouch="NO_CHANGES" effective={"brightness":0.25,…} clamped=["brightness"]`; `meta.retouch_effective = {"brightness":0.25,…}` | Cùng lớp lỗi “dấu vết nói sai” đã bị bắt ở MVP-02 (F-03/N-3). `retouched:false` và `retouch.status=NO_CHANGES` có lưu, nhưng field `retouch_effective` được đọc như “tham số đã áp” | Khi `status = NO_CHANGES` ⇒ `retouch_effective = {0,0,0,0}` + giữ `params_clamped`/`params_rejected` để không mất vết kẹp |
| **F6** | MINOR | `composeImage` **vẫn ghép** khi `matting.status ≠ OK` nếu kèm buffer: `readMask` chỉ ghi lý do rồi trả mask (lý do bị bỏ luôn nếu mask đọc được) — trái với chú thích trong `pipeline.js:796` (“compose tự fail-closed”). Mask **alpha một phần** cũng đi thẳng vào ảnh ra (pixel sản phẩm thành bán trong suốt) | `node a5-immut.mjs` (A4b): `mask status FAILED + có buffer → ratio=1 \| giống ảnh vào=false \| byte pixel SẢN PHẨM đổi=27` + warning “pixel giữ lại giữ nguyên từng byte”; `mask alpha MỘT PHẦN (128) → ratio=0.8594 \| byte pixel SẢN PHẨM đổi=1` | Lớp cơ sở `MattingProvider` hiện có gỡ `output` khi `status ≠ OK` nên **chưa reachable qua provider chuẩn**, nhưng `composeImage` là hợp đồng công khai (§3.2) và `http` matting trả alpha 0..255 là ca thật của dịch vụ ngoài | Trong `readMask`: `status !== 'OK'` ⇒ trả `null` ngay; coi `alpha` không thuộc {0,255} là mask không đạt ⇒ fail-closed hoặc ghi cảnh báo nổi bật |
| **F7** | MINOR | Khi client có khai bằng chứng, **422 phòng ngừa bị bỏ qua** ⇒ nhận `202`, job chạy xong mới lộ `overlay.applied=false` — đúng kiểu “202 rồi ngồi chờ một tấm ảnh không bao giờ có chữ” mà §3.5 nói phải tránh | `node d2b-variants.mjs`: `7. bằng chứng chỉ có "Bảo hành" (thiếu số) → HTTP 202 job=PARTIAL overlay.applied=false` | Người dùng trả giá bằng một lượt chạy đầy đủ (matting + compose + ghi ảnh) để rồi không có chữ; thông tin không bị ẩn (UI có khối “bị CHẶN”) nên chỉ MINOR | Chỉ bỏ qua preflight khi bằng chứng **thực sự** làm guardrail qua — hoặc luôn chạy preflight trên bằng chứng đã lưu + bằng chứng server chấp nhận |

---

## 2. Chi tiết từng phát hiện

### F1 (CRITICAL) — Sản phẩm gần màu nền bị xoá sạch, hệ thống báo `succeeded` + khẳng định ngược lại

**Dựng ca** (`/tmp/mvp03-atk/a2b-white-product.mjs`): ảnh 64×64 nền trắng 255; “áo” 48×48 màu **240** (khoảng cách Euclid tới nền = 25.98 ≤ `tolerance` mặc định 28); logo 16×16 màu 20. Đây là mô phỏng tối thiểu của “đồ trắng chụp trên nền trắng”.

```
$ cd /tmp/mvp03-atk && node a2b-white-product.mjs
ảnh vào: nền trắng=1792, "áo trắng"=2048, logo tối=256
POST /jobs → 202 {"job_id":"152a14d0-…","asset_id":"113e6058-…","status":"queued"}

--- hệ thống BÁO CÁO ---
job.status      = succeeded | error_code = null
synthetic_bg    = true | composed = true
matting.status  = OK | mask = {"coverage":0.0625,"background_ratio":0.9375,"uniformity":1,"seed_colors":1} | kept_bbox = {"x":24,"y":24,"w":16,"h":16}
compose.ratio   = 0.9375
warnings:
   • Đã tách nền bằng flood fill 4 hướng từ viền (ngưỡng màu 28.0/255, Euclid RGB): nền 93.8% pixel đã đặt alpha = 0, sản phẩm giữ lại 6.3%.
   • Hộp bao phần giữ lại: 16×16 tại (24, 24) trong khung 64×64.
   • Pixel sản phẩm (RGB + alpha) giữ nguyên từng byte; ảnh đầu vào không bị sửa.
   • Đã ghép nền MÔ PHỎNG "Gradient xanh" vào 3840/4096 pixel nền (tỉ lệ 0.9375); pixel giữ lại giữ nguyên từng byte.

--- ẢNH RA THỰC TẾ ---
"áo trắng": XOÁ (alpha=0 → bị nền mô phỏng đè) = 0/2048, còn lại = 2048
logo tối  : còn lại = 256, bị xoá = 0
pixel vùng "áo" còn màu áo gốc = 0, đã bị đổi thành màu nền mô phỏng = 2048
mẫu pixel (10,10) trong áo → [ 217, 234, 252, 255 ] | (32,10) → [ 217, 234, 252, 255 ] | (0,0) nền → [ 234, 244, 255, 255 ]
```

**Đọc số cho đúng**: 2048 pixel “áo” **không** trở thành trong suốt — chúng bị **đè bằng màu nền mô phỏng** (alpha = 255), nên ảnh ra trông như một tấm gradient có mỗi logo 16×16 lơ lửng. Toàn bộ 2048 pixel sản phẩm biến mất; `kept_bbox` chỉ còn logo.

**Vì sao hệ thống không tự phát hiện**: guardrail duy nhất là `SUSPICIOUS_MASK` khi `background_ratio > 0.98`. Ở đây ratio = 0.9375 (vì logo 6.25% còn “giữ lại”) nên lọt. `uniformity` = 1 (viền nền trắng tuyệt đối), `seed_colors` = 1 — mọi chỉ số đều “đẹp”.

**Tầng UI cũng nói sai** — chạy hàm UI THẬT (`renderIsWarnings` trích từ `public/app.js`, cùng cách `test/imagelab-ui-helpers.js` đang làm):

```
$ cd /tmp/mvp03-atk && node e4-ui.mjs
=== B3b — UI thật nhìn vào kết quả TẤN CÔNG "áo trắng bị xoá" ===
  UI có hiện lời khẳng định "Pixel sản phẩm (RGB + alpha) giữ nguyên từng byte"? true
  UI có cảnh báo sản phẩm bị xoá / ăn mất sản phẩm? false
  UI có nhãn MÔ PHỎNG? true
  trạng thái job hiện trên UI: Trạng thái lượt chạy mới nhất: succeeded.
```

**Kết luận**: đây là vi phạm luật #1 ở mức pixel, **âm thầm** (không cảnh báo nào nói sản phẩm bị ăn), và hệ thống **khẳng định ngược lại** ở cả `warnings` lưu trong DB lẫn UI. Mức CRITICAL theo đúng tiền lệ F-01 của MVP-02.

*Ghi chú phạm vi*: cửa sổ màu để lọt là sản phẩm có cả 3 kênh cách nền ≲ 28/255 (ví dụ nền 255, sản phẩm ≥ ~239). Sản phẩm tối màu không bị xoá (đã đo: sản phẩm đỏ/lam 0/1024 pixel đổi — xem mục 3.A2). Ngoài ca “toàn khối”, hiệu ứng phụ rìa: mọi pixel viền khử răng cưa/đổ bóng nằm trong ngưỡng đều bị coi là nền.

### F2 (MAJOR) — Overlay có đường “tự rửa tội” bằng `overlay.source_text`

Đối chứng trước (nguồn bằng chứng rỗng — đúng như hợp đồng §3.5):

```
$ cd /tmp/mvp03-atk && node d-overlay.mjs
=== D1 — nguồn bằng chứng RỖNG ⇒ phải 422 OVERLAY_UNSUPPORTED_CLAIM ===
"Bảo hành 12 tháng"            → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM vi phạm: 3
"BH 12 tháng"                  → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM vi phạm: 3
"chống nước IP68"              → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM vi phạm: 3
"hơn 10 nghìn người mua"       → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM vi phạm: 1
"①② tháng"                     → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM vi phạm: 2
"ｂảo hành 12 tháng"            → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM vi phạm: 3
"bảo hànһ 12 tháng"            → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM vi phạm: 3
"bao hanh 12 thang"            → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM vi phạm: 2
```

Tấn công — **cùng những câu đó**, chỉ thêm khoá bằng chứng do client tự khai:

```
=== D2 — CÙNG khẳng định đó + client tự khai `source_text` ===
"Bảo hành 12 tháng"            → HTTP 202 | job=succeeded overlay.applied=true | pixel vẽ ở dải trên=152
"BH 12 tháng"                  → HTTP 202 | job=succeeded overlay.applied=true | pixel vẽ ở dải trên=315
"chống nước IP68"              → HTTP 202 | job=succeeded overlay.applied=true | pixel vẽ ở dải trên=148
"hơn 10 nghìn người mua"       → HTTP 202 | job=succeeded overlay.applied=true | pixel vẽ ở dải trên=134
"bao hanh 12 thang"            → HTTP 202 | job=succeeded overlay.applied=true | pixel vẽ ở dải trên=124
```

(`①② tháng`, `ｂảo hành…`, `bảo hànһ…` không lọt **chỉ vì bộ font 5×7 thiếu glyph** ⇒ `OVERLAY_NO_GLYPH`, không phải vì guardrail.)

```
$ node d2b-variants.mjs
1. không bằng chứng (đối chứng)            → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM
2. overlay.source_text = chính câu đó      → HTTP 202 job=succeeded overlay.applied=true pixelVẽ=152
3. overlay.notes = chính câu đó            → HTTP 202 job=succeeded overlay.applied=true pixelVẽ=152
4. overlay.source_text = mảng [câu đó]     → HTTP 202 job=succeeded overlay.applied=true pixelVẽ=152
5. evidence ở options (ngoài overlay)      → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM
6. overlay.evidence = {text: câu đó}       → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM
7. bằng chứng chỉ có "Bảo hành" (thiếu số)  → HTTP 202 job=PARTIAL overlay.applied=false reason=OVERLAY_UNSUPPORTED_CLAIM
8. bằng chứng chỉ có "12 tháng"            → HTTP 202 job=PARTIAL overlay.applied=false reason=OVERLAY_UNSUPPORTED_CLAIM
9. bằng chứng = chữ Hán 保修12个月          → HTTP 202 job=succeeded overlay.applied=true pixelVẽ=152
```

**Cơ chế** (3 tầng khớp nhau thành một đường):
1. `src/imagestudio/pipeline.js:438` — `#evidenceText` nối thêm `source_text|sourceText|source|notes|note|user_note|text_original|ocr_text|product_name` **từ chính `options.overlay` của request**.
2. `src/imagestudio/compose/overlay.js:108–136` — `resolveSourceText` nhận đúng 16 khoá đó từ `overlay`.
3. `src/http/routes.js:351–361, 380` — `overlayHasClientEvidence()` phát hiện client có khai bằng chứng thì **bỏ qua 422 phòng ngừa** (“để tầng VẼ phán quyết”), và `sanitizeImagestudioOverlay` (dòng 2012–2019) **chuyển tiếp nguyên văn** 16 khoá đó xuống tầng vẽ.

Hệ quả: bất kỳ ai gọi API đều có thể vừa **phát ngôn** vừa **cấp bằng chứng** cho chính phát ngôn đó — guardrail trở thành thủ tục hình thức, trong khi UI hiện khối xanh “Đã vẽ chữ overlay (có kiểm chống bịa)” (`public/app.js:2859–2864`).

Ghi chú: UI hiện tại **không** gửi các khoá này (đã grep `public/app.js`), nên lỗ hổng nằm ở tầng API — nhưng đây chính là tầng mà hợp đồng §3.5 chọn làm “lớp kiểm CUỐI”.

### F3 (MINOR) — Không có test MVP-03 ở commit được chấm

```
$ git show --stat HEAD | grep -c "test/"          → 0
$ git grep -l imagestudio HEAD -- test/           → (không có kết quả)
$ stat -f "%Sm %N" test/imagestudio*               → 2026-10-04 10:26:40 … 10:33:20
$ git status --short                               → ?? test/imagestudio-*.test.js (9 file, untracked)

$ npm test   (10:24, TRƯỚC khi các file trên xuất hiện)  → tests 582 · pass 581 · fail 0 · skipped 1
$ npm test   (10:34)                                     → tests 683 · pass 682 · fail 0 · skipped 1
$ node --test --test-concurrency=1 test/imagestudio-*.test.js → tests 101 · pass 101 · fail 0
$ grep -n "240\|gần nền" test/imagestudio-*.test.js       → không có ca nào cho sản phẩm gần màu nền
```

Commit message ghi “npm test 582 · 581 pass · 0 fail” — đúng với cây mã **không có test MVP-03 nào**. Bộ 101 test mới (do agent test viết song song, chưa commit) đều xanh nhưng không phủ F1.

### F4 (MINOR) — Cổng “chưa dịch” của overlay và mã lỗi

```
$ node d3-cjk.mjs
"こんにちは"              → HTTP 202 job=PARTIAL applied=false reason=OVERLAY_NO_GLYPH pixelVẽ=0
"한국어"                → HTTP 202 job=PARTIAL applied=false reason=OVERLAY_NO_GLYPH pixelVẽ=0
"ｂảo hành"           → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM
"①② tháng"            → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM
"保修 12 个月"           → HTTP 422 OVERLAY_UNSUPPORTED_CLAIM
```

`routes.js:394–418` kiểm vi phạm **trước** `hasCjk` nên overlay Hán-có-số trả sai mã; `overlay.js:182` dùng `hasCjk` (chỉ Hán) trong khi `guardrails.js` đã có `hasUntranslatedScript` phủ cả kana/Hangul từ vòng 6 của MVP-02. Chữ kana/Hangul hiện **không được vẽ** chỉ vì font thiếu glyph — nếu đổi font, chữ chưa dịch sẽ được vẽ.

### F5 (MINOR) — `retouch_effective` ghi cho lượt retouch không chạy

```
$ node a3-clamp.mjs   (A3.2, gọi pipeline trực tiếp để đưa được giá trị không qua JSON)
brightness 99 (JSON được):
   status=succeeded err=null retouch="NO_CHANGES" effective={"brightness":0.25,"contrast":0,"saturation":0,"sharpen":0} clamped=["brightness"] rejected=[]
   meta.retouch_effective = {"brightness":0.25,…} | meta.retouch_clamped = ["brightness"]
```

Kẹp thì **đúng** (0.25 = trần, có ghi `clamped`) — nhưng vì ảnh thử có màu bão hoà nên retouch `NO_CHANGES` (0 pixel đổi) mà `meta.retouch_effective` vẫn nói +0.25. `retouched:false` và `retouch.status:"NO_CHANGES"` vẫn được lưu nên hậu quả nhẹ.

### F6 (MINOR) — `composeImage` ghép cả khi mask không đạt

```
$ node a5-immut.mjs   (mục A4b)
mask lệch cỡ 4×4                           → ratio=0 | giống ảnh vào=true | byte pixel SẢN PHẨM đổi=0        ✅ fail-closed
mask không phải PNG (JPEG)                 → ratio=0 | giống ảnh vào=true | byte pixel SẢN PHẨM đổi=0        ✅ fail-closed
mask PNG hỏng CRC                          → ratio=0 | giống ảnh vào=true | byte pixel SẢN PHẨM đổi=0        ✅ fail-closed
mask = null                                → ratio=0 | giống ảnh vào=true | byte pixel SẢN PHẨM đổi=0        ✅ fail-closed
mask status FAILED + có buffer             → ratio=1   | giống ảnh vào=false | byte pixel SẢN PHẨM đổi=27      ❌ VẪN GHÉP
mask alpha MỘT PHẦN (128) ở pixel giữ lại  → ratio=0.8594 | byte pixel SẢN PHẨM đổi=1                        ⚠️ pixel bán trong suốt
```

Lý do “Tách nền không thành công (matting.status = FAILED)” do `readMask` đẩy vào `reasons` **bị bỏ luôn** khi mask đọc được (`compose.js:39–70, 124–127`). Chú thích `pipeline.js:796` nói compose tự fail-closed — không đúng với ca này. Chưa reachable qua provider chuẩn (lớp cơ sở gỡ `output` khi `status ≠ OK`).

### F7 (MINOR) — 422 phòng ngừa bị bỏ qua khi client khai bằng chứng

```
$ node d2b-variants.mjs
7. bằng chứng chỉ có "Bảo hành" (thiếu số) → HTTP 202 job=PARTIAL overlay.applied=false pixelVẽ=0
8. bằng chứng chỉ có "12 tháng"            → HTTP 202 job=PARTIAL overlay.applied=false pixelVẽ=0
```

Hợp đồng §3.6/§3.5 muốn `422` **trước khi xếp hàng**; ở đây job chạy trọn (matting + compose + ghi ảnh) mới lộ ra chữ không được vẽ. Không ẩn thông tin (UI có khối “Chữ overlay bị CHẶN”) nên MINOR.

---

## 3. Những tuyên bố đã cố phá mà KHÔNG phá được

**A. Không bóp méo sản phẩm / ảnh gốc bất biến**
1. **A1 — kích thước**: ảnh 1×1, 3×7, 2000×1, 2×2000, 64×64 với mẫu `gradient-xanh`: các ảnh dị thường đều **không tạo ảnh ra** (`status=PARTIAL`, `error_code=NO_CHANGES`, `rendered=0`); ảnh thường ra đúng `64x64` (`node a1-distortion.mjs`). Không có đường resize/crop.
2. **A2 — pixel giữ lại**: sản phẩm đỏ/lam trên nền trắng, không retouch ⇒ `pixel giữ nguyên=1024, pixel NỀN đổi=3072, pixel SẢN PHẨM đổi=0` — pixel sản phẩm **y hệt từng byte** (`node a1-distortion.mjs`).
3. **A4 — alpha & dịch pixel**: retouch full 4 tham số trên ảnh đã tách nền ⇒ `pixel nền alpha=0 bị ghi đè = 0`, khối tâm sản phẩm không đổi (`node a1-distortion.mjs`); mask alpha một phần ⇒ `compose` không ghép (ratio 0) và trả bản sao y nguyên.
4. **A5 — bất biến ảnh gốc**: ingest → generate ×3 (3 mẫu khác nhau, 1 lượt có overlay) ⇒ `sha đĩa = 48d15e2af9316df7` **không đổi**, `sha DB` không đổi, `n rendered = 4`, mọi ảnh ra `parent_id = ảnh gốc`, `job.original_sha256` khớp, `meta.imagestudio.runs` giữ đủ 4 lượt (`node a5-immut.mjs`).
5. **A3 — kẹp retouch không có đường im lặng**: `99`, `-99`, `1e308` ⇒ kẹp đúng trần/sàn + `clamped[]`; `NaN`, `±Infinity`, `'0.9'`, `[0.25]`, `{}`, `true`, `null`, object lồng sâu, `__proto__`, `constructor`, khoá lạ ⇒ vào `rejected[]`, **không giá trị nào được áp**; `Object.prototype.polluted = undefined` sau đòn `__proto__`; qua HTTP cũng vậy (`node a3-clamp.mjs` A3.1/A3.2/A3.3).
6. **Hai lượt generate nhanh trên cùng job**: 3 ảnh rendered với 3 sha khác nhau, không ảnh nào bị ghi đè (`node a3-clamp.mjs` A3.4).

**B. Nền mô phỏng phải khai**
7. 5/5 mẫu `synthetic:true` trong `GET /api/imagestudio/templates`, `GET /api/config`, `meta.template` của ảnh rendered, `content_meta.imagestudio.template` (`node b-synthetic.mjs` B1).
8. Template lạ/rỗng/số/object ⇒ `TEMPLATE_NOT_FOUND` (job `failed`, không có ảnh ra) — **không bịa nền mặc định**; không truyền template ⇒ mặc định `trang` và **vẫn khai** `synthetic:true`; `composeImage` gọi trực tiếp không template cũng trả `synthetic:true` (B2/B2b).
9. Chỉ retouch, **không** ghép nền ⇒ `synthetic_background = false` (cả job lẫn asset) — nhãn không bị “true cho oai” (B5).
10. UI (hàm THẬT): luôn có badge “MÔ PHỎNG” + câu “nền MÔ PHỎNG (không phải ảnh thật)”; nhãn ảnh gốc là **“Ảnh gốc (bất biến)”**, ảnh tạo là **“Ảnh tạo mới (bản ghi mới, parent = ảnh gốc)”**; không có chỗ nào gọi nền sinh ra là ảnh thật, overlay không bị gọi là ảnh gốc (`node e4-ui.mjs` B3/B4).

**C. Tách nền fail-closed**
11. Nền gradient / nhiễu / “ảnh chụp thật” ⇒ `UNIFORM_BACKGROUND_NOT_FOUND` kèm số đo thật (`uniformity 0.0585 / 0.3989 / 0.5426`, `seed_colors 60/13/2`), `output=null`, job `PARTIAL`, không ảnh ra (`node c1-matting.mjs` C1).
12. Ảnh toàn một màu, ảnh chỉ 1 pixel khác, ảnh trong suốt hoàn toàn ⇒ `SUSPICIOUS_MASK` (`background_ratio 1 / 0.999 / 1`), từ chối, không cắt bừa (C2).
13. PNG palette / 1-bit / 16-bit / interlaced / CRC hỏng và JPEG / WebP / GIF ⇒ `UNSUPPORTED_IMAGE` với mã rõ (`PNG_UNSUPPORTED`, `PNG_CORRUPT`, `UNSUPPORTED_IMAGE`) + câu giải thích tiếng Việt, không ảnh ra (C4).
14. Mask lệch cỡ / không phải PNG / CRC hỏng / null ⇒ compose trả **bản sao y nguyên** ảnh vào, `ratio=0`, pixel sản phẩm đổi 0 (A4b).

**D. Chống bịa & dấu vết**
15. 8/8 câu khẳng định bịa (bảo hành, BH, IP68, “hơn 10 nghìn người mua”, ①②, full-width, homoglyph Kirin, không dấu) với bằng chứng rỗng ⇒ **422 + danh sách vi phạm**, **không tạo job** (D1/D4e).
16. **Usage không bịa**: matting từ chối ⇒ chỉ có `IMAGE_RETOUCH`; tắt tách nền + không retouch ⇒ **0 usage event**; đủ bước ⇒ đúng 3 operation `IMAGE_MATTING`/`IMAGE_COMPOSE`/`IMAGE_RETOUCH`; overlay bị chặn ⇒ không tạo job ⇒ không usage rác (D4).
17. **Evidence luôn `MANUAL_INPUT`**: client gửi `verification/verification_level/evidence_level = LIVE_VERIFIED` ⇒ DB vẫn `MANUAL_INPUT` (D5); `imagestudioVerification()` không nhận tham số mức bằng chứng.

**E. Bảo mật & vận hành**
18. **IDOR đóng ở mọi cửa**: session khác ⇒ `404` cho `GET job`, `GET asset gốc/rendered`, `POST generate`, **cả route MVP-02 `GET /api/imagelab/assets/:id/file`** và **cả route MVP-01 cũ `GET /api/jobs/:id`, `/usage`**; id không phải uuid ⇒ `400 BAD_JOB_ID/BAD_ASSET_ID` (E1).
19. **Ảnh đầu vào**: base64 rác, 0 byte, HTML khai `image/png`, data URL không phải ảnh, thiếu `image` ⇒ 400/415; khai mime sai ⇒ magic bytes thắng (202); vượt `maxPixels` ⇒ `413 IMAGE_TOO_LARGE` (E2).
20. **DoS**: body 40 MB ⇒ `413`; overlay 1 MB ⇒ cắt còn 500 ký tự rồi báo `OVERLAY_TEXT_TOO_LONG`; JSON lồng 50k/JSON hỏng/body mảng ⇒ 400 gọn (E3/E6).
21. **XSS**: chạy 4 hàm UI THẬT (`renderIsTemplates`, `renderIsCompare`, `renderIsWarnings`, `renderIsOverlayBlocked`) với payload `<img onerror>`/`"><script>` nhét vào template label, id/mime/sha256 ảnh, mọi `warnings`, `error_message`, `violations` ⇒ **không có thẻ thật nào lọt**, payload luôn bị `esc()`/`encodeURIComponent` (E4).
22. **Rò rỉ**: `GET job` không chứa `storage_path`, `session_id`, `sid`, đường dẫn tuyệt đối, `sk-`; history không lộ 2 field nội bộ (E5).
23. **Prototype pollution**: `__proto__` ở body và trong `retouch` ⇒ không đầu độc `Object.prototype`; JSON hỏng ⇒ 400 (E6).
24. **Tương tác chéo 3 loại job**: `GET /api/jobs` phân biệt đúng `content` / `image_translation` / `image_generation`; `POST /api/imagestudio/jobs/:id/generate` trên job `content` ⇒ `409 IMAGESTUDIO_NOT_IMAGE_JOB`; `POST /api/imagelab/jobs/:id/render` trên job MVP-03 ⇒ `409` (E7).
25. **Job lỗi không treo**: provider ném exception ⇒ `PARTIAL` + `failures[]` + `finished_at`; ảnh gốc bị sửa trên đĩa ⇒ `failed ORIGINAL_HASH_MISMATCH` + `finished_at`; job kẹt `running` có đường thoát bằng `force=true` (E8).

**F. Hồi quy**
26. `npm test` lúc 10:34 → **683 test · 682 pass · 0 fail · 1 skipped**; `node tools/verify.mjs` → **682 test · 681 pass · 0 fail · 1 skipped**, `EXIT=0`, in “Kiểm chứng cục bộ hoàn tất…”.
27. `npm run demo:imagelab` và `npm run demo:imagelab -- --regions` chạy xong, usage 3 event, nhãn `MOCK_VERIFIED` đúng.
28. **F-01 (MVP-02, pixel nhãn hiệu)** còn xanh: `node /tmp/atk5/x1-f01-pixel.mjs` → `➜ pixel đổi | brand trong ảnh [300,280,20,40]: 0/800`, `➜ pixel đổi NGOÀI mọi hộp đã applied: 0`.
29. **IL08-01 (MVP-02 vòng 6)** còn xanh: `node /tmp/atk-il08b/05-limits-race.mjs` → `PUT /regions: {"status": 409}`; `node /tmp/atk-il08b/r6-01-race2.mjs` → `vùng người dùng CÒN NGUYÊN?: true`, `"skipped_write": true`, cảnh báo “KHÔNG ghi đè (1 vùng nguồn 'user'…)”.

---

## 4. Mục chưa kiểm được (vì sao)

1. **PostgreSQL**: toàn bộ đòn dùng `DB_DRIVER=sqlite`. Khác biệt kiểu dữ liệu `content_meta` (JSONB vs TEXT) và hành vi `updateImageAssetMeta` trên PG **chưa đo** — cùng giới hạn MVP-02 đã ghi.
2. **Provider `http` (tách nền ngoài)**: không có service thật, và `safeFetch` chặn mạng nội bộ nên tôi không dựng được service giả qua HTTP. Vì vậy F6 (mask `status ≠ OK` có buffer, mask alpha một phần) chỉ được chứng minh bằng **gọi trực tiếp `composeImage`** — đường đi từ một service thật về `composeImage` chưa đo được end-to-end. `makeImagestudioStack`-tương đương cho `http` cũng chưa có trong repo.
3. **Trình duyệt thật**: các hàm UI được chạy THẬT trong Node (đúng cách `test/imagestudio-ui.test.js` làm) nhưng chưa có DOM/CSS: vòng poll 1,5 giây, kéo-thả ảnh, thanh trượt, focus/blur. Vì thế “UI có ẩn cảnh báo khi poll” chỉ được kiểm ở tầng hàm render.
4. **Ảnh rất lớn × nhiều job (DoS thật)**: chỉ đo được 1 body 40 MB (⇒413) và ảnh 80×80 vượt `maxPixels`. Chưa đo ảnh sát trần `maxPixels` (16 MP) × N job đồng thời — chi phí thời gian và không cần để kết luận.
5. **Provider thật của MVP-01/MVP-02 (AI/OCR trả tiền)**: mọi bằng chứng dùng `mock` + `purejs`, giống các vòng trước.
6. **`queue` đa tiến trình**: harness chạy 1 tiến trình. Cửa sổ đua giữa 2 process (2 lần `generate` đồng thời qua 2 instance) chưa đo; trong 1 tiến trình thì `#inFlight` + cổng `jobs.status` đã chặn đúng.
7. **`git` tại thời điểm chấm**: mã nguồn không đổi trong suốt quá trình phản biện (tôi không sửa file nào), nhưng **agent test ghi thêm file vào `test/` lúc 10:26–10:33** — nếu Owner chấm lại, số `npm test` sẽ khác (683) và bộ test MVP-03 cần được commit.

---

*Người phản biện không sửa một dòng mã nào. Mọi kết luận trên đều kèm lệnh chạy lại được trong `/tmp/mvp03-atk/`.*
