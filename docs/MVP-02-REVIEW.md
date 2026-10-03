# MVP-02 — BÁO CÁO PHẢN BIỆN ĐỘC LẬP

PHÁN QUYẾT: **FAIL**

- Nhánh: `feat/mvp02-imagelab` · Commit: `442ac478f647973533bda6b2dee84d7d94f11b8b` (ngày chạy: 03/10/2026, 10:07–10:18 UTC)
- Người phản biện: agent độc lập, **không sửa mã nguồn, không sửa test**. Mọi script thử nghiệm nằm ở `/tmp/atk/**`; báo cáo này là file duy nhất được ghi trong repo.
- `git status --short` sau khi làm việc: 8 file `test/imagelab-*.js` (agent test viết song song, untracked), `docs/MVP-02-REVIEW.md` (báo cáo này), và `M README.md` — **README.md do một agent khác sửa lúc 17:18:46, không phải tôi** (ngoài báo cáo này tôi không ghi vào file nào khác).
- Cách chạy lại: `cd /tmp/atk && node <tên script>` (harness tự dựng app THẬT với DB SQLite + thư mục ảnh tạm trong `/tmp/atk/run/`).

**Kết quả tổng quan:** 1 CRITICAL · 2 MAJOR · 5 MINOR. Phần lớn tuyên bố của nhóm code là **đúng và đã cố phá không được** (mục 3), nhưng **luật bất khả xâm phạm #3 (“nhãn hiệu không bao giờ bị xoá”) bị vi phạm ở mức pixel**, và hệ thống còn **tự báo cáo sai** rằng vùng nhãn hiệu không bị xoá.

---

## 1. Tóm tắt

| # | Mức | Phát hiện | Bằng chứng (1 dòng) | Vì sao quan trọng | Gợi ý sửa (KHÔNG tự sửa) |
|---|---|---|---|---|---|
| F-01 | **CRITICAL** | Op `erase_and_draw` của một vùng **mô tả** xoá sạch pixel của vùng **brand/certification** khi hai hộp **chồng lấn / lồng nhau / cùng hộp khác chữ**; dòng brand vẫn được báo “không xoá” trong `skipped` | `PIXEL VÙNG NHÃN HIỆU [40,40,200,40] BỊ ĐỔI: 8000/8000  vd {"before":[255,0,0],"after":[255,255,255]}` trong khi `skipped: [["r2","Vùng nhãn hiệu — không dịch, không xoá…"]]` | Vi phạm luật #3 và mục 5 “Định nghĩa xong”; ảnh giao cho khách có thể mất logo/chứng nhận, và log/UI nói ngược lại | Trước khi dựng op: loại/khấu trừ phần giao với hộp `brand/certification/price`; hoặc coi hộp chồng lấn là `BAD_BOX` (fail-closed); hoặc chỉ xoá phần hộp không giao với vùng được bảo vệ |
| F-02 | **MAJOR** | `allow_brand_override: true` ghi vết đầy đủ (DB: `USER_EDITED`, `provenance=user`, `edited_by_user=1`) nhưng `renderApproved` **luôn bỏ qua** vùng brand ⇒ nút “vẫn dịch vùng này” không bao giờ có tác dụng lên ảnh | `PUT … allow_brand_override=true` → `warnings:["Đã ghi đè vùng nhãn hiệu “r1” … (có lưu vết)"]`; render → `skipped:[{"region_id":"r1","reason":"Vùng nhãn hiệu — tuyệt đối không xoá/vẽ đè (luật #3), kể cả khi dòng dịch có nội dung."}]` | Hợp đồng §5 nói “không bị dịch … (**trừ override có vết**)”, §4.5 yêu cầu nút này — tính năng được hứa không tồn tại | Chọn một hướng và ghi vào hợp đồng: (a) override có vết ⇒ cho phép vẽ vùng đó (kèm cảnh báo), hoặc (b) bỏ nút + sửa §4.5/§5 nói rõ override chỉ lưu chữ, không render |
| F-03 | **MAJOR** | Nhãn MOCK lấy từ **cấu hình server đang chạy**, không lấy từ **dấu vết của job**; `content_meta.imagelab.mock_steps` không được API trả ra và UI không đọc `asset.meta.ocr.is_mock` | Job tạo bằng OCR/translate mock; khởi động lại server với provider thật trên CÙNG DB → `providers.ocr.is_mock=false`, `→ UI sẽ hiện nhãn MOCK cho: []` trong khi `asset.meta.ocr.is_mock=true` | Đúng bài học MVP-01: nhãn MOCK/LIVE phải trung thực theo *job*, không theo *cấu hình hiện tại*; bảng duyệt của job mock bị trình bày như dữ liệu thật | Trả `mock_steps` (từ `content_meta`) trong `GET /api/imagelab/jobs/:id` và cho UI ưu tiên dấu vết đã lưu (`mock_steps`, `asset.meta.ocr.is_mock`, `render_summary.is_mock`) thay vì `providers.*.is_mock` |
| F-04 | MINOR | Route MVP-01 cũ không kiểm quyền sở hữu ⇒ **đọc và GHI** được job ImageLab của session khác | `GET /api/jobs/<job imagelab>` (session B) → `200 … content_meta.imagelab=true`; `PUT /api/jobs/<job>/content` (B) → `200 "B SỬA TRỘM"`, A đọc lại thấy `"B SỬA TRỘM"` | Tuyên bố “chống IDOR” chỉ đúng trên `/api/imagelab/*`; cùng một job còn cửa sau ở route cũ. Là lỗi kế thừa MVP-01 (xem §4 về giới hạn `session_id` không phải xác thực) | Áp cùng `requireImagelabJob`/kiểm `session_id` cho `/api/jobs/:id`, `/content`, `/regenerate`, `/usage` (hoặc ghi rõ trong hợp đồng rằng MVP-01 không phân vùng) |
| F-05 | MINOR | `HttpError` 5xx bị `sendError` che thông báo ⇒ mất đúng câu giải thích thật | `POST /api/imagelab/jobs` khi `OCR_PROVIDER=http` thiếu key → `HTTP 502 {"code":"NOT_CONFIGURED","message":"Lỗi hệ thống. Vui lòng thử lại."}` | Luật #4 “fail-closed, không fail-im lặng” và hợp đồng §4.5 “`HttpError(status, code, message_vi)`” — mã đúng nhưng người dùng không biết vì sao | Cho `HttpError` cờ `expose = true` (hoặc whitelist mã 5xx an toàn) để giữ `message_vi` đã lọc; UI đã có `IL_ERROR_HINT` chỉ phủ một phần mã |
| F-06 | MINOR | Dòng `NEEDS_REVIEW` mà `edited_by_user = true` được coi là “đã duyệt” ⇒ **không** trả 409 và bị bỏ khỏi ảnh không một lời cảnh báo riêng | PUT bản dịch bịa (5 vi phạm) → `POST render (không force) → 202` (đúng ra hợp đồng 4.4 đòi `REVIEW_REQUIRED`), dòng đó vào `skipped` | Người dùng gõ câu bị guardrail chặn, bấm Render, tưởng đã vẽ; chữ đó lặng lẽ không xuất hiện (chỉ thấy trong danh sách “vùng không được vẽ”) | Khi `force !== true` và còn dòng `NEEDS_REVIEW` **bất kể** `edited_by_user`, trả 409 kèm danh sách; hoặc hiện cảnh báo riêng “dòng bạn sửa bị guardrail chặn nên sẽ KHÔNG được vẽ” |
| F-07 | MINOR | **Commit 442ac47 không chứa test nào của MVP-02** — 110 test mới là file untracked do agent test viết *trong lúc tôi phản biện* | Lần chạy 10:07:56Z: `tests 184 … pass 183 … skipped 1`; lần chạy 10:16:33Z: `tests 294 … pass 293`; `git status` → `?? test/imagelab-*.js` (8 file, mtime 17:10–17:15) | “npm test xanh” tại commit này **không chứng minh gì** cho MVP-02; bộ test mới cũng không phủ ca F-01 (grep `chồng|overlap|lồng` = 0 kết quả) | Commit bộ test MVP-02; thêm test pixel-level: hộp mô tả chồng/lồng hộp brand ⇒ vùng brand phải **không đổi một pixel** |
| F-08 | MINOR | Guardrail dịch bị lọt khi “bịa” không dùng chữ số/không dùng từ khoá | `❗LỌT "Áo thun cotton mười hai tháng hậu mãi"`, `❗LỌT "… １２ tháng hậu mãi"` (full-width), `❗LỌT "… こんにちは"`, `❗LỌT "… 한국어"`, `❗LỌT "… bảo\u200bhành 12 tháng"` (zero-width) | Guardrail là lớp cuối chống bịa; các biến thể này qua thẳng vào bảng duyệt dưới dạng `TRANSLATED` không vi phạm | Bổ sung: số viết bằng chữ tiếng Việt, `\d` Unicode (`\p{Nd}`), Unicode category cho kana/Hangul, chuẩn hoá bỏ ký tự vô hình (U+200B…) trước khi so khớp |

---

## 2. Chi tiết từng phát hiện

### F-01 (CRITICAL) — Vùng brand/certification **bị xoá pixel** bởi op của vùng khác; hệ thống còn báo “không xoá”

**Cách dựng ca:** dùng **đúng** `MockOcrProvider` + `normalizeRegions` + `classifyRegion` + pipeline + `purejs` thật; chỉ thay **dữ liệu OCR** (fixture ở `/tmp`, tức thứ mà một OCR engine thật trả về) thành ca có hộp chồng lấn. Ảnh 320×320 nền trắng, vùng brand tô đỏ đặc `[255,0,0]` tại `(40,40,200,40)`, vùng chứng nhận tô xanh `(40,250,260,34)`.

Lệnh:
```
cd /tmp/atk && node c2-overlap.mjs
```

Output thật (3 fixture, nguyên văn):
```
=== FIXTURE "chong-lan-mot-phan" — OCR thật hay trả hộp chữ lớn bao quanh nhãn hiệu ===
  regions: [{"id":"r1","kind":"descriptive","box":{"x":30,"y":30,"w":240,"h":120},"t":"纯棉短袖T恤"},
            {"id":"r2","kind":"brand","box":{"x":40,"y":40,"w":200,"h":40},"t":"品牌旗舰店"},
            {"id":"r3","kind":"certification","box":{"x":40,"y":250,"w":260,"h":34},"t":"3C认证 合格证齐全"}]
  lines:   [{"id":"r1","st":"GLOSSARY"},{"id":"r2","st":"SKIPPED_BRAND","vi":""},{"id":"r3","st":"SKIPPED_CERTIFICATION","vi":""}]
  applied: [{"id":"r1","box":{"x":30,"y":30,"w":240,"h":120}}]
  skipped: [["r2","Vùng nhãn hiệu — không dịch, không xoá ("],["r3","Vùng chứng nhận — không dịch, không xoá "]]
  ➜ PIXEL VÙNG NHÃN HIỆU [40,40,200,40] BỊ ĐỔI: 8000/8000  vd {"x":40,"y":40,"before":[255,0,0],"after":[255,255,255]}
  ➜ PIXEL VÙNG CHỨNG NHẬN [40,250,260,34] BỊ ĐỔI: 0/8840

=== FIXTURE "long-nhau-brand-nam-trong" — vùng mô tả nằm TRỌN trong hộp nhãn hiệu ===
  applied: [{"id":"r2","box":{"x":60,"y":45,"w":100,"h":25}}]
  skipped: [["r1","Vùng nhãn hiệu — không dịch, không xoá ("]]
  ➜ PIXEL VÙNG NHÃN HIỆU [40,40,200,40] BỊ ĐỔI: 252/8000  vd {"x":65,"y":47,"before":[255,0,0],"after":[20,20,20]}

=== FIXTURE "cung-hop-khac-chu" — HAI vùng CÙNG hộp nhưng khác chữ (khử trùng khít không bắt được) ===
  regions: [{"id":"r1","kind":"brand","box":{"x":40,"y":40,"w":200,"h":40}},{"id":"r2","kind":"descriptive","box":{"x":40,"y":40,"w":200,"h":40}}]
  applied: [{"id":"r2","box":{"x":40,"y":40,"w":200,"h":40}}]
  ➜ PIXEL VÙNG NHÃN HIỆU [40,40,200,40] BỊ ĐỔI: 8000/8000  vd {"x":40,"y":40,"before":[255,0,0],"after":[255,255,255]}
```

**Kết luận:** `erase_and_draw` chỉ xoá **đúng hộp của chính nó** (điều đó đúng — xem §3.E2), nhưng pipeline **không hề kiểm tra hộp đó có giao với vùng `brand/certification/price` nào không**. Hệ quả: (1) luật #3 bị vi phạm ở mức pixel; (2) `skipped` báo “Vùng nhãn hiệu — không dịch, không xoá (luật bất khả xâm phạm #3)” trong khi vùng đó vừa bị xoá — **báo cáo của hệ thống sai sự thật**, đúng loại lỗi mà luật #1 cấm.

Đường vào thực tế: `normalizeRegions` chỉ khử trùng khi **cùng chữ + cùng hộp** (`normalize.js:188-194`), không xử lý hộp giao nhau; `HttpOcrProvider` (dùng cho OCR thật, `ocr/index.js:579`) đi thẳng qua `normalizeRegions` nên hộp chồng lấn từ OCR thật vào được DB; hợp đồng 3.2 không cấm hộp chồng lấn.

Mức CRITICAL vì: đây là một trong **năm luật bất khả xâm phạm**, vi phạm **âm thầm** (không có cảnh báo nào nói “vùng bảo vệ bị xoá”), và **hệ thống tự báo cáo ngược lại**. Giảm nhẹ: ảnh gốc vẫn bất biến (mục 3.B1), và cần OCR trả hộp chồng lấn.

---

### F-02 (MAJOR) — `allow_brand_override: true` có vết nhưng **không bao giờ được vẽ**

Lệnh: `cd /tmp/atk && node c-brand.mjs` (CA B). Output thật:
```
=== CA B: PUT lines allow_brand_override=true cho vùng BRAND r1 ===
  HTTP 200 | rejected: [] | warnings: ["Đã ghi đè vùng nhãn hiệu “r1” theo yêu cầu người dùng (có lưu vết).","Đã áp 1 chỉnh sửa."]
  dòng r1 trả về: {"region_id":"r1","text_vi":"Thương hiệu ABC","status":"USER_EDITED","provenance":"user","edited_by_user":true,"edited_at":"2026-10-03T10:11:59.002Z", ...}
  DB r1: {"region_key":"r1","text_vi":"Thương hiệu ABC","status":"USER_EDITED","provenance":"user","edited_by_user":1,...}
  render HTTP 202 | job: succeeded
  render_summary.applied: ["r2","r3"]
  render_summary.skipped: [{"region_id":"r1","reason":"Vùng nhãn hiệu — tuyệt đối không xoá/vẽ đè (luật #3), kể cả khi dòng dịch có nội dung."}, …]
  pixel KHÁC trong r1_brand: 0
```
Đối chứng (CA C) — chặn khi **không** override là đúng và chặt:
```
  HTTP 200 | rejected: [{"region_id":"r1","reason":"Vùng “r1” là nhãn hiệu — không được sửa/dịch khi chưa bật allow_brand_override."}]
  DB r1: {"text_vi":"","status":"SKIPPED_BRAND","edited_by_user":0}
  allow_brand_override="true"/1/"yes"/{} → rejected=1 text_vi=""   (chỉ nhận boolean true)
```
**Kết luận:** C3/C4 đúng ở tầng dữ liệu (từ chối thật, có vết thật, không nhận giá trị truthy). Nhưng tầng render (`pipeline.js:828-831`) chặn tuyệt đối theo `kind`, nên override **không có tác dụng lên ảnh** — trái với §5 “trừ override có vết” và trái với nút “vẫn dịch vùng này” ở UI. Việc này **có được nói ra** (danh sách “N vùng không được vẽ” trong `renderIlWarnings`), nên đây là MAJOR chứ không CRITICAL: tính năng được hứa không tồn tại, nhưng không âm thầm.

---

### F-03 (MAJOR) — Nhãn MOCK không gắn với job

Lệnh: `cd /tmp/atk && node a1c-label.mjs` (2 app instance dùng **cùng** DB + `IMAGELAB_DIR`, cùng session cookie). Output thật:
```
=== B1) Máy chủ #1: OCR=mock, TRANSLATE=mock — tạo job ===
  GET job → providers: {"ocr":{"name":"mock",...,"is_mock":true},"translate":{...,"is_mock":true},"render":{"name":"purejs","is_mock":false}}
  job JSON có content_meta (nơi ghi mock_steps)? false
  DB content_meta.mock_steps: ["ocr","translate"]
  DB asset.meta.ocr.is_mock: true

=== B2) Máy chủ #2 (CÙNG DB, CÙNG thư mục ảnh) nhưng OCR/translate là provider THẬT ===
  GET cùng job → HTTP 200
  providers máy chủ #2 báo: {"ocr":{"name":"real-ocr","is_mock":false},"translate":{"name":"real-ai","is_mock":false},"render":{...,"is_mock":false}}
  dữ liệu job vẫn là của lần chạy MOCK: regions = 4 lines = 4
  → UI (renderIlWarnings dùng providers.is_mock) sẽ hiện nhãn MOCK cho: []
  → dấu vết THẬT còn trong payload: {"asset.meta.ocr.is_mock":true,"asset.meta.ocr.provider":"mock","ocr.is_mock":true,"render_summary":null}
```
Và grep chứng minh UI **chỉ** dùng nguồn theo-cấu hình:
```
$ grep -n "is_mock" public/app.js
1167:  const cls = provider.configured ? (provider.is_mock ? 'warn' : 'ok') : 'bad';
1168:  const mock = provider.is_mock ? ' · MOCK' : '';
1178:  ].filter(([key]) => il?.[key]?.is_mock).map(([, name]) => name);
1280:          ${summary?.is_mock ? '<span class="badge warn">MOCK</span>' : ''}
1419:    .filter(([key]) => providers[key]?.is_mock)
```
**Kết luận:** `pipeline.js:659-664` ghi `mock_steps` rất trung thực vào `content_meta`, `asset.meta.ocr.is_mock` cũng đúng — nhưng `routes.js:740-754` (`jobJson`) **cắt bỏ `content_meta`**, và UI không đọc hai nguồn đã lưu đó. Nhãn MOCK vì vậy đúng với *máy chủ đang chạy*, sai với *job đang xem*. Job render xong vẫn còn `render_summary.is_mock` (đã lưu trong `asset.meta`) nên hậu quả nặng nhất nằm ở **bảng duyệt trước khi render** (ảnh mock được trình bày như kết quả thật để người dùng duyệt).

---

### F-04 (MINOR) — Cửa sau IDOR qua route MVP-01 cũ

Lệnh: `cd /tmp/atk && node f2-migration.mjs` (phần F2c). Output thật:
```
  --- Session B gọi route MVP-01 CŨ nhắm vào job ImageLab của A ---
  GET /api/jobs/2e4337a2-… → 200 (B ĐỌC ĐƯỢC: status=awaiting_review, content_meta.imagelab=true)
  GET /api/jobs/2e4337a2-…/usage → 200
  PUT /api/jobs/42a6b380-…/content (B sửa job của A) → 200 "B SỬA TRỘM"
  A đọc lại: headline = "B SỬA TRỘM"
```
**Kết luận:** 5 route `/api/imagelab/*` kiểm quyền sở hữu rất đúng (D1 — §3), nhưng job ImageLab nằm cùng bảng `jobs` nên vẫn tới được bằng route MVP-01 vốn không kiểm. Đây là lỗi **kế thừa**, cùng gốc với giới hạn đã biết: `sessionId()` đọc cookie do client gửi (`server.js:229-238`, tự ghi chú “Chỉ dùng để PHÂN VÙNG lịch sử, không phải xác thực”). Tôi **không** tính đây là lỗ hổng mới của MVP-02; nêu ra để hợp đồng/hồ sơ nói đúng mức bảo vệ thực tế.

---

### F-05 (MINOR) — Thông báo lỗi 5xx bị che

Lệnh: `cd /tmp/atk && node b4-ops.mjs` (F3a/F4) và `d4-ssrf.mjs`. Output thật:
```
=== F3a: OCR_PROVIDER=http, THIẾU key ===
  /api/config.imagelab.ocr = {"name":"http","model":"","configured":false,"is_mock":false}
  POST job → HTTP 502 {"code":"NOT_CONFIGURED","message":"Lỗi hệ thống. Vui lòng thử lại."}
=== F4: OCR_PROVIDER=none / TRANSLATE_PROVIDER=none ===
  POST /api/imagelab/jobs → HTTP 502 {"code":"NOT_CONFIGURED","message":"Lỗi hệ thống. Vui lòng thử lại."}
  MVP-01 POST /api/jobs → 202 "job tạo được: 837536f2-…"     ← MVP-01 vẫn sống (đúng 4.6)
```
**Kết luận:** `sendError` che mọi message khi `status >= 500` và `err.expose` không được set (`server.js:193-208`) ⇒ câu giải thích thật trong `HttpError` bị nuốt. UI có `IL_ERROR_HINT` dịch lại một số mã (`IMAGELAB_UNAVAILABLE`, `NOT_CONFIGURED`, …) nên người dùng cuối còn manh mối; nhưng hợp đồng §4.5 hứa trả `message_vi`, và log `imagelab.wiring_failed` (nguồn của `reason`) thì UI đã hiện đúng ở `/api/health` + `/api/config`.

---

### F-06 (MINOR) — Cổng 409 bị bỏ qua với dòng `NEEDS_REVIEW` do người dùng sửa

Lệnh: `cd /tmp/atk && node a4-guardrails.mjs` (A4c). Output thật:
```
  PUT → 200 | r2: {"st":"NEEDS_REVIEW","vi":"Áo thun cotton bảo hành 12 tháng, chống nước IP68","violations":[5 lỗi],"edited_by_user":true,"provenance":"user"}
  render khi còn dòng NEEDS_REVIEW → 202 undefined undefined
  render force=true → 202 | job: succeeded | applied: ["r3"] | skipped: [["r2","Dòng cần người duyệt nhưng CHƯA được duyệt — bỏ qua, không v”]]
```
Đối chứng — cổng 409 **hoạt động đúng** khi dòng `NEEDS_REVIEW` do provider sinh (không ai sửa), lệnh `node a1-honesty.mjs`:
```
  POST render (không force) → 409 "REVIEW_REQUIRED" {"pending_region_ids":["r4"]}
  POST render force → 202 | asset.meta.forced: "Người dùng buộc render (force = true) dù còn 1 dòng NEEDS_REVIEW chưa duyệt: r4. …"
```
**Kết luận:** `pendingReviewLines` (`pipeline.js:56-60`) coi `edited_by_user === true` là “đã duyệt”, nên một bản dịch **do guardrail gắn cờ** lại được miễn cổng duyệt và lặng lẽ bị loại khỏi ảnh. Hợp đồng 4.4 viết “còn dòng `NEEDS_REVIEW` chưa duyệt mà `force !== true` → ném `REVIEW_REQUIRED`”. May mắn là hậu quả **an toàn** (không vẽ chữ bịa), nhưng thông điệp tới người dùng thiếu: họ chỉ biết qua danh sách “vùng không được vẽ”.

---

### F-07 (MINOR) — Ở đúng commit này, MVP-02 **không có test nào**

```
$ git status --short           # lúc bắt đầu phản biện (10:07Z): KHÔNG có dòng nào (cây sạch)
$ npm test                     # 10:07:56Z
ℹ tests 184 · pass 183 · fail 0 · skipped 1        ← đúng bằng baseline MVP-01, 0 test MVP-02

$ git status --short           # 10:16Z (sau khi agent test viết xong)
?? test/imagelab-api.test.js  ?? test/imagelab-helpers.js  ?? test/imagelab-ocr.test.js
?? test/imagelab-pipeline.test.js ?? test/imagelab-render.test.js ?? test/imagelab-store.test.js
?? test/imagelab-tools.test.js ?? test/imagelab-translate.test.js
$ npm test                     # 10:16:33Z — sha256 8 file y hệt trước/sau khi chạy
ℹ tests 294 · pass 293 · fail 0 · skipped 1
$ node tools/verify.mjs        # 10:17:17Z → EXIT=0 (294 test, --check toàn bộ src/public/tools/test)
```
**Kết luận:** cả hai lần đều **xanh thật**, nhưng lần đầu (đúng cây mã của commit) **không có test MVP-02**; 110 test mới là file **untracked** sinh ra trong lúc tôi phản biện (mtime 17:10–17:15 giờ máy). Bộ test mới cũng **không phủ** ca F-01: `grep -rn "chồng\|overlap\|giao nhau\|nested\|lồng" test/imagelab-*.js` → không kết quả; không có assert nào kiểm pixel vùng `brand` không đổi. `test/imagelab-translate.test.js:220` chỉ kiểm `applyBrandOverride` ở tầng `applyReviewEdits` (tức chỉ chứng minh F-02 ở nửa đường).

---

### F-08 (MINOR) — Guardrail bị lọt với “bịa” không dùng chữ số

Lệnh: `cd /tmp/atk && node a4-guardrails.mjs`, `text_original = "纯棉T恤"`. Các ca **bắt đúng** (trích):
```
BẮT "Áo thun cotton 12 tháng bảo hành"   → ["Số liệu “12”…","Đơn vị “tháng”…","Khẳng định “bảo hành”…"]
BẮT "Áo thun cotton, BH 12 tháng"        → ["Số liệu “12”…","Khẳng định “BH”…"]
BẮT "Áo thun cotton bảo hành một năm"    → ["Khẳng định “bảo hành”…"]      ← đúng ca hiến chương yêu cầu
BẮT "Áo thun cotton chống nước IP68"     → ["Số liệu “68”…","Khẳng định “chống nước”…","Khẳng định “IP68”…"]
BẮT "Áo thun cotton hơn 10 nghìn người mua" → ["Số liệu “10”…"]
BẮT "Áo thun cotton số 1 Việt Nam" / "tốt nhất" / "chính hãng" / "đạt chuẩn ISO 9001" / "an toàn tuyệt đối"
BẮT "Áo thun cotton 纯棉"                 → ["CHƯA DỊCH: … (纯棉) …"]
```
Các ca **lọt**:
```
❗LỌT "Áo thun cotton mười hai tháng hậu mãi"   → status=TRANSLATED violations=[]
❗LỌT "Áo thun cotton １２ tháng hậu mãi"        → (chữ số full-width)
❗LỌT "Áo thun cotton こんにちは"                → (kana Nhật)
❗LỌT "Áo thun cotton 한국어"                   → (Hangul)
❗LỌT "Áo thun cotton bảo\u200bhành 12 tháng"  → chỉ bắt được nhờ số “12”, từ khoá “bảo hành” bị zero-width cắt
```
**Kết luận:** bốn luật (a)-(d) chạy đúng như mô tả cho mọi biến thể có chữ số/keyword; giới hạn nằm ở chữ số không phải ASCII, số viết bằng chữ, ký tự vô hình và các hệ chữ ngoài dải CJK đã khai báo. Đây là **giới hạn của phương pháp regex**, không phải lỗi cài đặt — nhưng nên ghi vào tài liệu để không ai đọc thành “guardrail chặn mọi ca bịa”.

---

## 3. Những tuyên bố đã cố phá mà KHÔNG phá được

Ghi trung thực — đây là phần chứng minh báo cáo không thiên vị. Mọi mục dưới đây đều có lệnh + output thật (script trong `/tmp/atk`).

| # | Tuyên bố | Đòn tấn công đã thử | Kết quả |
|---|---|---|---|
| B1 | **Ảnh gốc bất biến** | sha256 file gốc trên đĩa trước/sau toàn luồng upload → OCR → duyệt → render (`a0-flow.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `1774 byte, sha256 = c1323668…` giống hệt trước/sau, khớp `asset.sha256` trong DB. Render 2 lần: 2 asset `rendered` khác id, sha giống nhau, bản render lần 1 **không bị ghi đè** (`byte y hệt`), ảnh gốc còn nguyên (`b4-ops.mjs`) |
| B2 | **Buffer đầu vào không bị sửa tại chỗ** | gọi `render()` trực tiếp với `Buffer` gốc, so sha256 trước/sau (`b4-ops.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `sha trước: c1323668a1f078e5 | sau: c1323668a1f078e5 | ĐỔI? false`; `original_sha256` khớp, `output.sha256` khác gốc |
| B3 | **Ảnh render là bản ghi mới, `parent_id` đúng** | đọc DB sau render (`a0-flow.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `role=rendered, parent_id=<id ảnh gốc>, sha256 khác, storage_path=<job>/<asset mới>.png` |
| B4 | **Không có đường ghi đè ảnh gốc** | render 2 lần cùng job (`b4-ops.mjs`) | **KHÔNG PHÁ ĐƯỢC.** 3 asset: 1 original + 2 rendered, không asset nào bị thay byte |
| D1 | **IDOR theo session → 404 ở TẤT CẢ** | session B gọi `GET jobs/:id`, `GET assets/:id`, `GET assets/:id/file`, `PUT lines`, `POST render` (`d1-security.mjs`) | **KHÔNG PHÁ ĐƯỢC.** Cả 6 lời gọi trả `404 JOB_NOT_FOUND`/`ASSET_NOT_FOUND`, kể cả `PUT` (không ghi được gì) |
| D2 | **Path traversal** | id `../../../../etc/passwd`, `..%2f`, `%2e%2e%2f`, `a/b`, `%00`, `....//`, id kèm `%2f..%2f`; và **đầu độc `storage_path` trong DB** thành `/etc/passwd`, `../../..`, `${jobId}/../../..`, có NUL (`d1-security.mjs`) | **KHÔNG PHÁ ĐƯỢC.** Mọi ca trả 400/404; `/etc/passwd` (file **có thật**) trả `404 ASSET_FILE_NOT_FOUND` ⇒ `assertInside` chặn thật, không phải “file không tồn tại”. `storage.js` kiểm cả NUL, số đoạn, `..`, đường dẫn tuyệt đối |
| D2d | **Không trả file sai content-type** | sửa `image_assets.mime` thành `text/html`, `image/svg+xml`, `application/javascript` rồi `GET .../file` (`e4-png.mjs`) | **KHÔNG PHÁ ĐƯỢC.** Cả 3 → `415 UNSUPPORTED_MEDIA_TYPE` (route đối chiếu `config.net.allowedImageMime`), header đúng `Cache-Control: private, no-store` |
| D3 | **XSS: mọi text OCR phải escape** | payload `<img src=x onerror=alert(1)>`, `"><script>…`, `' onmouseover=…` đi qua OCR thật vào API, rồi **chạy hàm `renderIlReview()` thật** trong sandbox (`ui-audit.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `esc()` escape cả `& < > " '`; HTML sinh ra có `0` thẻ `<img>` nguyên văn, chứa `&lt;img src=x onerror=alert(1)&gt;` trong cả ô chữ gốc, `value=` của input, `kind_reason`, `violations`, `notes`, `dropped/skipped/unsupported_glyphs`, tên file |
| D4 | **SSRF** | `OCR_BASE_URL` = `169.254.169.254`, `127.0.0.1:9222`, `localhost`, `[::1]`, `0.0.0.0`; `RENDER_BASE_URL` = `169.254.169.254` (`d4-ssrf.mjs`) | **KHÔNG PHÁ ĐƯỢC.** OCR: `job failed error_code="OCR_HTTP_BLOCKED" … (PRIVATE_IP/BAD_PORT)`; render: `RENDER_NETWORK — Địa chỉ IP nội bộ bị chặn: 169.254.169.254` |
| D5 | **DoS ảnh** | PNG bom IHDR 60000×60000 (IDAT 1×1); **zlib bomb 408KB giải nén 400MB**; PNG cắt ngắn; CRC hỏng; IDAT rỗng; filter type 7; 1×1; 0 byte; base64 rác 3MB; base64 rác 20MB; 200 vùng trùng (`d5-dos.mjs`, `d5b-dos.mjs`) | **KHÔNG PHÁ ĐƯỢC.** Bom IHDR → `413 IMAGE_TOO_LARGE` sau 11ms; bom zlib → `PNG_CORRUPT … Cannot create a Buffer larger than 40100 bytes` sau **2ms**, RSS **không tăng** (471MB→471MB); mọi ca hỏng đều có `error_code` rõ; `0 byte` → `400 MISSING_IMAGE`; 20MB → body limit chặn, `/api/health` vẫn `200 ok`; `normalizeRegions(200 vùng trùng)`: `regions=1 dropped=199`, **không mất vùng nào âm thầm** (`TỔNG vào=9 ra=9`) |
| D6 | **Không rò rỉ log/response** | chạy `src/server.js` thật với `LOG_LEVEL=debug` + key giả, chạy trọn luồng rồi grep log; kiểm mọi response lỗi | **KHÔNG PHÁ ĐƯỢC.** `grep -c` cho cookie sid = **0**, `SUPERSECRET` = **0**, `/Users/` = **0**, `/tmp/atk` = **0**; `session_mode: "[REDACTED]"`; response lỗi không có stack/đường dẫn; `assetJson` **không** trả `storage_path`/`session_id` |
| D7 | **Rate limit** | 20 × `POST /api/imagelab/jobs` (`RATE_LIMIT_MAX_JOBS=10`) | **KHÔNG PHÁ ĐƯỢC.** `{"202":10,"429":10}`, lần thứ 11 trả `429 RATE_LIMITED` kèm `retry_after_ms` |
| E1 | **`layoutText` không tràn hộp** | 9 hộp (10×6, 1×1, âm, tràn ảnh, w=0, h âm, số lẻ) × 10 chuỗi (200 ký tự, 1 ký tự, rỗng, xuống dòng, từ dài 300, emoji, CJK, không glyph) = 90 ca; và đo **bao mực thật** sau khi vẽ (`e-layout.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `fits=true: 30 | vi phạm: 0`; bao mực luôn nằm trong hộp (`mực [29,30]–[130,38] NẰM TRONG ✓`) — kể cả ca có dấu và ca `gjpqy` thò xuống |
| E2 | **`erase_and_draw` không xoá sang vùng khác** | 2 hộp đen/đỏ sát nhau, xoá hộp A rồi đếm pixel đổi (`e-layout.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `pixel đổi NGOÀI hộp: 0 | pixel đổi trong hộp B kề bên: 0`. (Lưu ý: đây là “không tràn **ra ngoài hộp**”; hệ quả khi **hộp chồng nhau** là F-01) |
| E3 | **Tiếng Việt có dấu + glyph thiếu** | 16 từ/ký tự (`Ăn cơm`, `Đường`, `Ớt`, `Ừ`, `Ệ`, `ộ`, `ữ`, `ẩ`, `ẫ`, `ỹ`, `Ơ`, `ư`…) (`e-layout.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `ký tự THIẾU glyph: []`; in mask thấy dấu được ghép thật (`Ă`, `Â`, `Đ`, `Ệ` có hàng dấu riêng); ký tự lạ → `NO_GLYPH` + `skipped`, **không xoá, không vẽ bừa** (`purejs.js:84-97`) |
| E4 | **PNG round-trip y hệt pixel** | encode→decode của repo (4 color type); ảnh **do tôi mã hoá độc lập** với đủ 5 filter × 4 color type → repo decode; repo encode → decoder độc lập của tôi (`e4-png.mjs`, `lib/png.mjs`) | **KHÔNG PHÁ ĐƯỢC.** 4/4 color type khớp byte; 20/20 ca filter×colorType khớp; kiểm chéo 2 chiều đều khớp. 16-bit/interlaced/palette bị từ chối đúng mã `PNG_UNSUPPORTED` |
| A1 | **Không có nhãn LIVE_VERIFIED** | chạy luồng với mock; chạy luồng với provider **không mock** (ocr/translate giả `isMock=false`); truy vấn DB (`a1-honesty.mjs`, `a0-flow.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `verification = MANUAL_INPUT` ở mọi bản ghi; `SELECT COUNT(*) … LIKE '%LIVE%'` = **0**; khi có mock thì `blocked_reason = "Có bước chạy provider MOCK (ocr, translate) — kết quả là dữ liệu minh hoạ…"`; khi không mock thì `blocked_reason=''` và `is_mock=false` |
| A2 | **Vùng rác của OCR không lọt** | fixture có `confidence=0.01` và vùng chỉ khoảng trắng (`a1-honesty.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `dropped: [{"reason":"độ tin cậy 0.01 thấp hơn ngưỡng 0.5"},{"reason":"vùng rỗng hoặc chỉ có khoảng trắng"}]`; bảng `ocr_regions` **không** có 2 vùng đó |
| A3 | **Provider ném lỗi → job không treo** | OCR provider giả ném `OCR_BOOM` (`b4-ops.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `job: failed stage=failed error_code="OCR_BOOM" finished_at="2026-10-03T10:13:06.318Z"` |
| C1 | **Vùng brand/cert/price không bao giờ bị dịch** | luồng thật với 2 provider dịch mặc định; **và** cắm `translator` GIẢ cố tình trả `text_vi` + `status=TRANSLATED` cho vùng brand/certification (`c1-forced.mjs`) | **KHÔNG PHÁ ĐƯỢC Ở TẦNG ẢNH.** Provider dịch mặc định: `r1 → SKIPPED_BRAND text_vi=""`, `r4 → SKIPPED_CERTIFICATION text_vi=""`, `price → SKIPPED_PRICE text_vi=""`. Khi translator giả phá luật: DB **có** `r1 text_vi="DỊCH TRỘM brand" status=TRANSLATED` (pipeline không kiểm lại `kind` ở tầng dữ liệu), nhưng render vẫn `applied: ["r2","r3"]`, `skipped: [["r1","Vùng nhãn hiệu — tuyệt đối không xoá/vẽ đè (luật #…"],["r4","Vùng chứng nhận — …"]]` ⇒ **ảnh vẫn an toàn**; hàng rào cuối là `NEVER_RENDER_KINDS` theo `kind`. Ghi chú: hai provider dịch có sẵn đều giữ luật, chỉ translator cắm ngoài mới phá được tầng dữ liệu |
| C3 | **Từ chối sửa vùng khoá khi thiếu override** | `PUT lines` sửa `r1` brand với `allow_brand_override` = `false/undefined/"true"/1/"yes"/{}` | **KHÔNG PHÁ ĐƯỢC.** `rejected` có lý do tiếng Việt, DB giữ nguyên `text_vi="" status=SKIPPED_BRAND`; chỉ nhận **đúng boolean `true`** (`body.allow_brand_override === true`) |
| F2 | **Migration idempotent + MVP-01 không vỡ** | (a) DB schema CŨ (bảng `jobs` không có `kind`) → `createStore()` 2 lần; (b) **bản sao `data/studio.db` thật** (3 job) → `init()` 2 lần; (c) luồng MVP-01 thật (`f2-migration.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `init() lần 1 OK (2ms)`, `lần 2 OK (0ms)`; cột `kind` được thêm, job cũ đọc ra `kind="content"`, **không mất dữ liệu** (3 → 3 job); 3 bảng mới được tạo; `POST /api/jobs` (MVP-01) → `202`, DB `kind="content"` |
| F3 | **JPEG + `purejs` báo đúng sự thật** | JPEG tổng hợp 320×320 (có SOF hợp lệ) chạy trọn luồng (`jpeg.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `job cuối → failed error_code="RENDER_JPEG_UNSUPPORTED" finished_at=…`, message nói rõ cần cắm `RENDER_PROVIDER=http`; `treo running? {"n":0}` |
| F4 | **Thiếu provider ⇒ fail-closed** | `OCR_PROVIDER=none`, `TRANSLATE_PROVIDER=none`; `AI_PROVIDER=deepseek` không key (`b4-ops.mjs`, `d4-ssrf.mjs`) | **KHÔNG PHÁ ĐƯỢC.** `/api/imagelab/jobs` → `502 NOT_CONFIGURED` (không nhận ảnh rồi để job chết); MVP-01 vẫn `202`; MVP-01 với AI thiếu key → job `failed`, `error_code=CONTENT_FAILED`, có `finished_at` |
| — | **Bản sao luật `IL_LOCKED_*` (UI) vs `NEVER_RENDER_KINDS` (pipeline)** | trích **từ file thật** bằng script rồi so từng phần tử + quét 48 ô (kind × status) (`ui-audit.mjs`) | **KHÔNG PHÁ ĐƯỢC (hôm nay).** `UI IL_LOCKED_KINDS = ["brand","certification","price"]` **giống hệt** `PIPE NEVER_RENDER_KINDS`; `IL_LOCKED_STATUSES` = 3 mã `SKIPPED_*` khớp 3 trạng thái dịch. 6/48 ô “lệch” đều là **khác câu hỏi** (UI hỏi “vùng có bị khoá không”, pipeline hỏi “dòng có được vẽ không”): `NEEDS_REVIEW`/`FAILED` thì UI **cố ý** cho sửa còn pipeline không vẽ. Vẫn là **rủi ro trôi dạt thật** (hợp đồng 4.6 ghi rõ “một luật, một chỗ”): nếu sau này thêm kind vào `NEVER_RENDER_KINDS` mà quên `IL_LOCKED_KINDS`, UI sẽ cho người dùng gõ bản dịch cho vùng mà server **không bao giờ vẽ** — người dùng chỉ biết qua danh sách “vùng không được vẽ”. Tôi **không** dựng được ca lệch hành vi nào ở cây mã hiện tại |

---

## 4. Mục chưa kiểm được

1. **OCR/Dịch/Render provider THẬT (trả tiền).** Toàn bộ bằng chứng dùng `mock` (OCR/dịch) + `purejs` (render) + provider giả cắm qua `createApp({ ocrProvider, translator })`. Chưa kiểm: chất lượng OCR thật, hành vi JSON thật của model dịch, `RENDER_PROVIDER=http` thật. Vì vậy mọi kết luận về “chống bịa” chỉ đúng ở tầng guardrail/parse, không phải chất lượng model.
2. **Hộp chồng lấn do OCR THẬT sinh ra.** F-01 được chứng minh bằng dữ liệu OCR thay thế (fixture `/tmp`, đi qua đúng `normalizeRegions`/`classifyRegion` thật). Tôi **không** có mẫu hộp chồng lấn từ một engine thật để đo tần suất; cần Owner xác nhận mức phổ biến.
3. **PostgreSQL.** Toàn bộ chạy trên SQLite (`node:sqlite`). Nhánh `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind` của Postgres (`store/index.js:139`) chưa được chạy thật (không có `DATABASE_URL`).
4. **Trình duyệt thật.** UI được kiểm bằng cách trích và **chạy hàm render thật** trong Node (`renderIlReview`, `esc`, `ilLocked`) chứ không mở DOM thật; chưa kiểm CSS/layout thị giác, chưa bấm nút trong trình duyệt, chưa kiểm hành vi `drop` tệp.
5. **Nhiều tiến trình ghi song song.** Chưa kiểm hai request `render` đồng thời trên cùng job (đua ghi DB), chưa kiểm nhiều instance server chia sẻ `IMAGELAB_DIR`.
6. **`data/studio.db` thật.** Tôi chỉ chạy migration trên **bản sao** trong `/tmp` (không ghi vào repo); chưa xác nhận trên tệp gốc trong môi trường chạy thật.
7. **Cookie/session như cơ chế xác thực (D1b).** Tôi có chạy và xác nhận: đặt cookie `sid` của người khác (biết trước id) là **đọc và ghi được toàn bộ** job/asset. Đây là **giới hạn đã biết của MVP-01/MVP-05** (`server.js:229`: “Chỉ dùng để PHÂN VÙNG lịch sử, không phải xác thực”), không phải lỗ hổng mới của MVP-02 — nên tôi **không** xếp nó thành phát hiện, nhưng nói rõ để hồ sơ nghiệm thu không hiểu sai rằng “404 theo session” là một hàng rào bảo mật.
8. **Tải đồng thời / bom tài nguyên ở mức hệ điều hành.** Chỉ đo RSS trong tiến trình Node với một ảnh; chưa thử 50 ảnh bom song song qua rate limit thật (rate limit 10 job/phút có thể đã chặn trước).
