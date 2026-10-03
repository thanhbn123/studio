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

---
---

# VÒNG 2 — chấm lại tại commit `e3a8c4f`

PHÁN QUYẾT MỚI: **PASS CÓ ĐIỀU KIỆN**

- Commit chấm: `e3a8c4f` (nhánh `feat/mvp02-imagelab`), ngày chạy 03/10/2026 ~12:0x–12:3x UTC. `git status --short` sau khi làm việc: **sạch** (chỉ `docs/MVP-02-REVIEW.md` được ghi — không sửa mã nguồn, không sửa `test/**`).
- Toàn bộ nội dung VÒNG 1 ở trên được **giữ nguyên** (lịch sử, không xoá). Mọi script vòng 2 nằm ở **`/tmp/atk4/`** (bản sao đòn vòng 1 đã trỏ lại `/tmp/atk4/`, cộng script mới `x1…x13`). Cách chạy lại: `cd /tmp/atk4 && node <tên script>`, bằng chứng gộp ở `/tmp/atk4/out-round1.txt`, `/tmp/atk4/out-tests.txt`.
- Số liệu tự đo tại commit này: `npm test` → **tests 392 · suites 67 · pass 391 · fail 0 · cancelled 0 · skipped 1 · todo 0** (skip duy nhất là test PostgreSQL `test/store.test.js:162`, không có `DATABASE_URL`); `node tools/verify.mjs` → **EXIT=0**.
- **Vì sao PASS CÓ ĐIỀU KIỆN chứ không PASS:** 8/8 phát hiện vòng 1 **đã vá thật** (đo lại bằng pixel/HTTP thật, không tin lời khai), H-1/H-2 cũng vá thật; **không còn lỗi CRITICAL**. Nhưng bản vá mới mở **1 lỗ hổng MAJOR mới** (N-5, chỉ ở `RENDER_PROVIDER=http`) và **6 lỗ hổng MINOR** (N-1…N-4, N-6, N-7) — trong đó N-1 có thể làm **luật bất khả xâm phạm #3 bị vi phạm trở lại** nếu dữ liệu toạ độ trong DB bị NULL/hỏng.

## V2.1 — Bảng chấm lại F-01…F-08 + H-1/H-2

| # | Mức vòng 1 | Kết luận vòng 2 | Bằng chứng (1 dòng, output thật) |
|---|---|---|---|
| F-01 | CRITICAL | **ĐÃ VÁ THẬT** | `node x1-f01-pixel.mjs`: fixture chồng-lấn/lồng nhau/cùng-hộp ⇒ `skipped: [["r1","BOX_OVERLAPS_PROTECTED: r2 (brand)…"]]`, `pixel đổi | brand[40,40,200,40]: 0/8000`, `pixel đổi NGOÀI mọi hộp đã applied: 0` |
| F-02 | MAJOR | **ĐÃ VÁ THẬT** | `node x6-f02-override.mjs` CA B: `PUT … allow_brand_override=true` → `applied: [["r1",true]]`, `overrides: ["r1"]`, `PIXEL VÙNG NHÃN HIỆU … 8000/8000` + cảnh báo “ĐÃ BỊ THAY CHỮ TRÊN ẢNH…”; CA A/C/C2/D/E/G vẫn 0/8000 |
| F-03 | MAJOR | **ĐÃ VÁ THẬT** (còn khe nhỏ ở màn hình danh sách — N-3) | `node x7-f03-mock.mjs`: máy chủ #2 provider THẬT đọc job mock → `mock_steps = ["ocr","translate"]`, hàm UI THẬT `renderIlWarnings` in “MOCK — job này đã chạy OCR, dịch bằng dữ liệu giả lập … Provider hiện tại của máy chủ KHÔNG còn là mock” |
| F-04 | MINOR | **ĐÃ VÁ THẬT** | `node f2-migration.mjs`: session B → `GET /api/jobs/<job A> → 404`, `…/usage → 404`, `PUT …/content → 404 undefined`; `A đọc lại: headline = ""`; hồi quy MVP-01 `202 / 200 / 200` |
| F-05 | MINOR | **ĐÃ VÁ THẬT** | `node b4-ops.mjs`: `POST job → HTTP 502 {"code":"NOT_CONFIGURED","message":"Provider OCR/dịch chưa được cấu hình — chưa thể dịch ảnh."}` (vòng 1 chỉ có “Lỗi hệ thống. Vui lòng thử lại.”) |
| F-06 | MINOR | **ĐÃ VÁ THẬT** | `node a4-guardrails.mjs` (A4c): dòng `NEEDS_REVIEW` do người dùng sửa → `render khi còn dòng NEEDS_REVIEW → 409 "REVIEW_REQUIRED" {"pending_region_ids":["r2"]}` (vòng 1: 202) |
| F-07 | MINOR | **ĐÃ VÁ THẬT** | `git ls-files test/ \| grep imagelab` → **14 file** (kể cả `imagelab-f01-protected-pixels.test.js`); `git status --short` trống; `npm test` 392 test |
| F-08 | MINOR | **VÁ PHẦN LỚN — còn lọt** (xem V2.3/N-6, N-7) | `node x5-f08-guardrails.mjs`: bắt ⅻ/Ⅻ, №1, ⅓, ³, ₂, `12 THÁNG`, `MƯƠI HAI THÁNG`, NBSP/thin/ideographic/soft-hyphen/word-joiner/U+180E/RLO, NFD, full-width, “một trăm hai mươi nghìn đồng”; **lọt 3/37** |
| H-1 | (mới, vòng 3) | **ĐÃ VÁ THẬT** | `node x2…` (A) 27/27 phép kiểm hình học đúng; (B) `x=-30,w=240` → `{"x":0,"y":150,"w":210,"h":40}` (**không** nới thành w=240); `node x3b-poison-targeted.mjs` ca `x3b-h1`: hộp mô tả đầu độc `x=-30` cạnh nhãn hiệu `[215,275)` → `applied: [["r1",{"x":0,"y":150,"w":210,"h":40}]]`, `pixel đổi vùng mô tả: 8400/8400` (không chặn oan), `nhãn hiệu: 0/2400` |
| H-2 | (mới, vòng 3) | **ĐÃ VÁ THẬT** ở tầng engine + API (còn khe N-2, N-5b) | `node x2…` (D): `ops=[] → status="PARTIAL" error_code="NO_OPS"` + cảnh báo “Không có op nào để vẽ…”; `node x3-api-noops-poison.mjs` ca x3b-dims (API thật): `rs.status:"PARTIAL" | rs.error_code:"NO_OPS" | applied: []`, 4 cảnh báo thật, `pixel đổi toàn ảnh: 0` |

## V2.2 — Bằng chứng chi tiết cho các bản vá mới (phần quan trọng nhất)

### F-01 / mặt nạ vùng bảo vệ — tấn công trực diện, KHÔNG phá được

`cd /tmp/atk4 && node x1-f01-pixel.mjs` (9 ca, ảnh 320×320, đo pixel từng vùng trên ảnh đã render):

| Ca | Kết quả thật |
|---|---|
| C1 chồng một phần | `skipped r1 = BOX_OVERLAPS_PROTECTED: r2 (brand)`; `brand 0/8000`; vùng sạch vẫn được vẽ `6000/6000` |
| C2 lồng trong nhãn hiệu | `skipped r2 = BOX_OVERLAPS_PROTECTED: r1 (brand)`; `brand 0/8000` |
| C3 cùng hộp khác chữ | `normalizeRegions` khử theo HỘP và giữ vùng có mức bảo vệ cao hơn ⇒ chỉ còn `r1 brand`; `brand 0/8000` (không còn 2 vùng cùng hộp như vòng 1) |
| C4 chạm cạnh (không giao) | **không chặn oan**: `applied r2`, `mô tả sát cạnh [160,100,80,60]: 252/4800`, `brand 0/3600` |
| C5 nhãn hiệu 1×1 | mô tả chồng đúng 1 pixel → `BOX_OVERLAPS_PROTECTED`; `brand 1px: 0/1`; vùng sạch khác vẫn vẽ `3200/3200` |
| C6 nhãn hiệu tràn biên trái `x=-60` | hộp bảo vệ kẹp còn `[0,100,140,40]`; vùng sạch `[200,100,100,40]` **được vẽ** (`252/4000`) ⇒ không chặn oan; `brand 0/5600` |
| C7 nhãn hiệu hoàn toàn ngoài ảnh | bị `normalizeRegions` loại kèm lý do, không treo, không chặn oan |
| C8 tràn biên phải/dưới | hộp bảo vệ `[300,280,20,40]`; mô tả `[295,280,10,40]` giao → chặn; `brand 0/800` |
| C9 nhãn hiệu phủ TOÀN ẢNH | 0 op dựng được ⇒ job `failed error_code="IMAGELAB_NO_LINES"` (nói thật, không im lặng) |
| **mọi ca** | `pixel đổi NGOÀI mọi hộp đã applied: 0` ⇒ mặt nạ không che nhầm vùng khác |

Mặt nạ tầng 2 (provider `purejs`, `node x2-geometry-mask-noops.mjs` phần C): op chồng một phần → `status="PARTIAL" masked=true`, pixel trong hộp bảo vệ `0` đổi; op nằm trọn trong hộp bảo vệ → `skipped PROTECTED_BOX_MASKED` + `error_code="NO_OPS"` + 0 pixel đổi; hộp bảo vệ **âm/tràn biên** được kẹp đúng (`[−5,−5,15,15]→[0,0,10,10]`, `[54,54,100,100]→[54,54,10,10]`, cả hai `0` pixel đổi); hộp bảo vệ **rác** (`w=0`, `NaN`, ngoài ảnh, thiếu `box`, `null`, chuỗi) bị bỏ qua ⇒ `status="OK"`, op vẫn tác dụng `400/400` (**không chặn oan**); override của chính vùng bảo vệ vẫn vẽ được (`400/400`) trong khi vùng bảo vệ KHÁC đóng băng (`0`).

Che quá tay? `node x11-mask-overreach-f05.mjs`: `pixel ĐỎ trong hộp bảo vệ còn nguyên: 256/256`, `pixel XANH ngoài hộp bảo vệ (dải trái) bị xoá: 616/616` ⇒ mặt nạ khôi phục **đúng** phần giao, không phủ sang phần còn lại của op.

**Provider `http` (không có mặt nạ pixel) — tầng 1 có đủ chặn không?** `node x9-http-provider.mjs` (server render GIẢ ở `127.0.0.1`, `ALLOW_PRIVATE_NETWORK=true`), chế độ `naive` (xoá đúng op nhận được):
```
server nhận 1 op, auth="Bearer k"; op GIAO với hộp nhãn hiệu: []
➜ pixel đổi | NHÃN HIỆU [40,40,200,40]: 0/8000 | vùng sạch [30,200,200,30]: 6000/6000
```
⇒ **Có.** Op chồng hộp bảo vệ **không bao giờ được gửi đi** (tầng 1 lọc trước khi dựng op), nên remote tử tế không thể chạm nhãn hiệu. (Nhưng xem **N-5**: repo **không kiểm pixel ảnh trả về**.)

### H-1 / `geometry.js` — tấn công trực diện, KHÔNG phá được

`node x2-geometry-mask-noops.mjs` phần A (27 phép kiểm, `0` lệch kỳ vọng): `x=-30,w=240 → {0,150,210,40}`; `x,y đều âm → {0,0,90,90}`; tràn phải/dưới cắt đúng `w/h`; `w âm/h âm/0×0/NaN/±Infinity/chuỗi rác/hộp ngoài ảnh ⇒ null`; `chuỗi số` chấp nhận; `chạm đúng biên x=320 ⇒ null`; `boxesIntersect` chạm cạnh `false`, chồng 1px `true`, hộp `null` `false`.
Phần B (đường OCR `normalizeRegions`): `x=-30,w=240 → kept=1 box={"x":0,"y":150,"w":210,"h":40}`; `x=-500` → loại kèm lý do “hộp nằm ngoài biên ảnh sau khi cắt”; `w<=0/0×0` → loại kèm lý do; `NaN/Infinity` → loại; `chuỗi số`/`số thực` → trunc đúng; **không vùng nào thất lạc âm thầm** (mọi ca bị loại đều có mục trong `dropped`).
Đường DB đầu độc (`pipeline.clampBox`) — `node x3b-poison-targeted.mjs`: `x=-30,w=240` → op `{"x":0,"y":150,"w":210,"h":40}` và **được vẽ**, nhãn hiệu `[215,275)` `0/2400` ⇒ bản cũ (nới w=240 ⇒ giao nhãn hiệu ⇒ chặn oan) đã hết.

### H-2 / NO_OPS — các đường “không vẽ gì” còn báo OK không?

- `ops=[]` → `PARTIAL` + `error_code="NO_OPS"` + cảnh báo “Không có op nào để vẽ (ops rỗng) — ảnh trả về y hệt ảnh gốc”.
- Mọi op bị mask / op `0×0` / op toàn `NO_GLYPH` → `PARTIAL` + `NO_OPS` (`node x2…` phần D).
- API thật, mọi dòng `NO_GLYPH` (`node x3-api-noops-poison.mjs` ca x3b-noglyph): `job: succeeded | rs.status:"PARTIAL" | rs.error_code:"NO_OPS" | applied: []`, cảnh báo `⚠️ Không vùng nào được vẽ (0/1 op áp dụng được)…`, `pixel đổi: 0/8000`.
- API thật, op bị đẩy ra ngoài ảnh (dims DB bị đầu độc): `skipped r2 = BAD_BOX`, `PARTIAL` + `NO_OPS` + 4 cảnh báo, `pixel đổi toàn ảnh: 0`.
- API thật, **mọi** op bị tầng 1 chặn (C9) hoặc `only_region_ids=['khong-ton-tai']` → job `failed error_code="IMAGELAB_NO_LINES"` (thậm chí chặt hơn PARTIAL).
- **Còn lọt 1 đường**: provider `http` tự khai `applied` — xem **N-5b**.

### F-08a/b/c — biến thể MỚI và dương tính giả

`node x5-f08-guardrails.mjs` (37 ca bịa) + `x5b`/`x5c`/`x13`:
- **BẮT (đã vá thật):** `ⅻ`/`Ⅻ` (cả `\p{Nl}` hoa và thường), `⅓`, `³`, `₂`, `№1`, `12 THÁNG`, `MƯƠI HAI THÁNG`, `một năm` viết hoa, `một trăm hai mươi nghìn đồng` (F-08a), `１２ｔｈáｎｇ`, `bảo\u200bhành` + NBSP `\u00a0` + thin `\u2009` + ideographic `\u3000` + soft hyphen `\u00ad` + word joiner `\u2060` + `\u180e` + RLO `\u202e`, NFD `ba\u0309o ha\u0300nh`, `bảo- hành`/`bảo - hành`, `chống thấm`, `kháng khuẩn`, `cam kết`, `uy tín`, `xii`… không, xem dưới.
- **CÒN LỌT (3/37 → N-6):**
  - `❗LỌT "Áo thun cotton xii tháng hậu mãi"` (số La Mã viết bằng chữ ASCII thường — không phân biệt được với từ);
  - `❗LỌT "Áo thun cotton № hậu mãi"` (`№` một mình: NFKC → `No`, không có chữ số nào để bắt);
  - `❗LỌT "Ao thun cotton bao hanh mot nam"` (**cùng nội dung** với “bảo hành một năm” đã bị bắt, nhưng viết không dấu ⇒ số-bằng-chữ và từ khoá đều trượt).
  - Ngoài ra, homoglyph **chỉ lọt khi không kèm chữ số**: `x13` → `"Áo thun cotton bао hànһ"` (Kirin а/о/һ) `TRANSLATED n=0`, `"bαo hành"` (Greek α) `n=0`, `"bao hаnh"` `n=0`; còn `"… bао hànһ 12 tháng"` thì **bắt được nhờ số “12”**, KHÔNG nhờ từ khoá. Cùng họ: `"tốt nhứt"` (sai chính tả của “tốt nhất”) → `TRANSLATED n=0`.
- **DƯƠNG TÍNH GIẢ (N-7):**
  - `src=纯棉100%T恤` + `vi="Áo thun cotton 100%"` → `NEEDS_REVIEW: Đơn vị “%” không có trong chữ gốc` **dù chữ gốc CÓ `%`**. Nguyên nhân đo được: `numbersIn('纯棉100%T恤')=["100"]` nhưng `unitsIn('纯棉100%T恤')=[]` (số dính liền chữ Hán `棉100` ⇒ lookbehind biên từ trượt), trong khi `unitsIn('100%纯棉T恤')=["%"]`. Chữ Trung bán hàng rất hay viết liền (`纯棉100%`, `含棉95%`) ⇒ bản dịch trung thành bị tố oan.
  - `src=纯棉T恤` + `vi="Một chiếc áo thun cotton"` → `NEEDS_REVIEW: Số liệu “Một chiếc” (= 1)…` — “một chiếc” ở đây là **mạo từ bất định**, không phải số liệu; `vi="Chiếc áo thun cotton"` thì qua.
  - **KHÔNG tính là dương tính giả** (tôi đã thử và kết luận guardrail đúng): `"Áo thơm ½ giá"` và `"Mã №1"` — cả hai **thêm** số liệu không có trong chữ gốc, bắt là đúng. Tương tự `"tỷ lệ vàng"`, `"đồng phục"`, `"đồng giá"`, `"Áo dài tay"`, `"Size M"`, `"Chất liệu: cotton"`, `"một màu"`, `"bền nhiều năm"` → **không bắt** (đúng).

### F-02 / override — còn đường vẽ nhãn hiệu KHÔNG có vết?

`node x6-f02-override.mjs` (A…G2). Tất cả đường tắt đều bị chặn: `allow_brand_override="true"`/`1` → `rejected: [{"region_id":"r1","reason":"Vùng “r1” là nhãn hiệu — không được sửa/dịch khi chưa bật allow_brand_override."}]`; client tự gửi `status=USER_EDITED, provenance=user, edited_by_user=true` → cũng bị từ chối; `only_region_ids=['r1']` → `skipped` + job `failed IMAGELAB_NO_LINES`; `action='accept'` **không tạo vết** (đọc `review.js:125-135`: `accept` chỉ `continue`) nên kể cả khi cắm translator GIẢ trả chữ cho vùng nhãn hiệu (CA G) thì `lines sau PUT: [["r1","TRANSLATED","DỊCH TRỘM brand",false,"ai"]]` và render vẫn `skipped r1 = "Vùng nhãn hiệu — tuyệt đối không xoá/vẽ đè (luật #3)…"`, `PIXEL … 0/8000` (CA G2: kèm cả `allow_brand_override=true` vẫn 0/8000). **Chỉ còn 1 đường: đầu độc thẳng DB** (CA F: đặt `edited_by_user=1, provenance='user', status='USER_EDITED'` → render `8000/8000` + `overrides:["r1"]`) — chấp nhận được, vì ghi được vào DB thì đã toàn quyền; hệ thống vẫn ghi vết và cảnh báo đúng.

### F-03 / nhãn MOCK — còn đường nào khiến job mock hiện ra như “không mock”?

`node x7-f03-mock.mjs`: payload có `mock_steps: ["ocr","translate"]` + `providers_snapshot` (có cả `recorded_at`); chạy **hàm UI thật** `renderIlWarnings` (trích từ `public/app.js`) bằng payload của máy chủ provider THẬT → vẫn in “MOCK — job này đã chạy OCR, dịch bằng dữ liệu giả lập … Provider hiện tại của máy chủ KHÔNG còn là mock — job cũ vẫn mang nhãn MOCK vì dấu vết đã lưu.”; ca ngược (job tạo bằng provider THẬT, đọc trên máy chủ cấu hình mock) → `mock_steps: []` và UI chỉ hiện ô “theo cấu hình máy chủ”. ⇒ Không còn đường nào ở màn hình duyệt. **Còn khe ở màn hình danh sách: N-3.**

## V2.3 — LỖ HỔNG MỚI (do chính các bản vá vòng 2/vòng 3 sinh ra)

| # | Mức | Phát hiện | Bằng chứng thật | Vì sao quan trọng |
|---|---|---|---|---|
| N-5 | **MAJOR** | **`RENDER_PROVIDER=http`: repo KHÔNG kiểm một pixel nào của ảnh trả về, và tin `applied` do remote tự khai.** (a) remote xoá cả vùng nhãn hiệu → job `succeeded`, `rs.status="OK"`, không cảnh báo, mà `skipped` vẫn nói “Vùng nhãn hiệu — không dịch, không xoá”; (b) remote trả **y hệt ảnh gốc** nhưng khai `applied=[mọi op]` → `OK` dù **0 pixel** được vẽ (lách H-2) | `node x9-http-provider.mjs` chế độ `evil`: `job: succeeded | rs.status:"OK" | rs.error_code: null | warnings: ["…BOX_OVERLAPS_PROTECTED…","server giả chế độ evil"]` nhưng `➜ pixel đổi | NHÃN HIỆU [40,40,200,40]: 8000/8000`; chế độ `liar`: `applied: ["r3"]`, `pixel đổi | vùng sạch: 0/6000` | Luật #3 là **bất khả xâm phạm**, nhưng với `http` nó chỉ được bảo đảm ở phía **yêu cầu** (không gửi op chồng), không ở phía **kết quả**. `http` chính là đường được tài liệu hoá cho JPEG/WebP và cho render thật ⇒ một service inpainting “vẽ lại cả ảnh” (hành vi rất dễ có của model sinh ảnh) sẽ xoá logo mà hệ thống báo ngược lại. *(Không phải lỗi của tầng 1: chế độ `naive` cho thấy op gửi đi sạch.)* |
| N-1 | MINOR | **Toạ độ NULL/rác bị ép về 0 (fail-open) ⇒ F-01 tái sinh.** `ocr_regions.x = NULL` của vùng nhãn hiệu không bị coi là hỏng: `pipeline.#boxOf` dùng `Number.isFinite(Number(v))` mà `Number(null)===0` ⇒ hộp bảo vệ “ảo” tại `x=0`; op mô tả giao **vị trí THẬT** của nhãn hiệu không bị chặn | `node x3b-poison-targeted.mjs` ca `x3b-nullx`: `(đầu độc): [{"region_key":"r2","x":null,…,kind":"brand"}]`, `applied: [["r1",{"x":150,…}]]`, `skipped: [["r2","Vùng nhãn hiệu — không dịch, không xoá…"]]` nhưng `➜ pixel đổi | nhãn hiệu THẬT [200,100,100,40]: 2800/4000`. Gốc rễ đo được: `node x13-final-probe.mjs` → `intersectBoxWithImage({x:null,…}) → {"x":0,…}`, `x=''→0`, `x=[]→0`, `x=false→0`, `x=true→1` (đáng ra phải `null`) | Cùng loại harm như F-01 (CRITICAL): mất logo + báo cáo ngược lại. Cần có `x` NULL (DB hỏng/migration/người ghi khác) — nên chỉ MINOR, nhưng **cách sửa rất rẻ** (`typeof v === 'number' && Number.isFinite(v)`, hoặc `v == null ⇒ null`). |
| N-2 | MINOR | **Job báo `succeeded` + `error_code = null` khi KHÔNG vẽ được vùng nào** — sự thật chỉ nằm ở `render_summary` + warnings | `node x3-api-noops-poison.mjs` ca `x3b-dims`: `job: succeeded | job.error_code: null` trong khi `rs.status:"PARTIAL" | rs.error_code:"NO_OPS" | applied: []` và `pixel đổi toàn ảnh: 0` | Client chỉ đọc `job.status`/`error_code` (rất phổ biến) sẽ tưởng đã render xong; API tự mâu thuẫn giữa hai tầng. |
| N-3 | MINOR | **Màn hình danh sách không có nhãn MOCK và không phân biệt job ImageLab.** `store.listJobs` không `SELECT kind, content_meta`; `historyItemHtml` chỉ in tên + trạng thái | `node x7-f03-mock.mjs`: `GET /api/jobs` (danh sách) item khoá = `[]` sau khi map, `mock_steps = undefined`; `sed -n '366,380p' public/app.js` → không có badge MOCK/kind | F-03 sửa đúng ở màn hình **duyệt**, nhưng lịch sử vẫn có thể trộn job mock với job thật mà không dấu hiệu. |
| N-4 | MINOR | **`only_region_ids` toàn id không hợp lệ ⇒ âm thầm render TẤT CẢ** thay vì báo lỗi/bỏ qua (fail-open khi đầu vào rác) | `node x12-500-leak.mjs`: `POST render only_region_ids = [null, 1, {}] → 202`; `sed -n '1135,1145p' src/http/routes.js` → `sanitizeRegionIds` lọc hết ⇒ `[]` ⇒ pipeline coi như “không lọc” ⇒ dựng op cho mọi dòng | Người dùng gõ sai/thu gọn danh sách vùng muốn render lại nhận **nhiều hơn** yêu cầu (không vi phạm luật #3 vì vùng bảo vệ vẫn bị chặn, nhưng là hành vi “đoán thay người dùng”). |
| N-6 | MINOR | **Guardrail F-08 còn lọt 3 họ biến thể** (số La Mã ASCII `xii`; `№` đứng một mình; tiếng Việt **không dấu** không kèm chữ số) + homoglyph chỉ lọt khi không kèm số + `tốt nhứt` | `node x5-f08-guardrails.mjs` → `❗LỌT "Áo thun cotton xii tháng hậu mãi" / "…№ hậu mãi" / "Ao thun cotton bao hanh mot nam"`; `node x13-final-probe.mjs` → `"bао hànһ" TRANSLATED n=0`, `"tốt nhứt" TRANSLATED n=0` | Vẫn là “lớp cuối chống bịa”: câu bịa đi thẳng vào bảng duyệt dưới dạng `TRANSLATED`. Mức MINOR như F-08 vòng 1 (giới hạn phương pháp regex), nhưng phải ghi vào tài liệu để không ai đọc thành “guardrail chặn mọi ca bịa”. |
| N-7 | MINOR | **Dương tính giả sau NFKC/`\p{No}`/đơn vị:** (a) `纯棉100%T恤` + `"Áo thun cotton 100%"` bị tố “Đơn vị ‘%’ không có trong chữ gốc” dù chữ gốc có `%`; (b) `"Một chiếc áo thun cotton"` bị tố “Số liệu ‘Một chiếc’ (= 1)” | `node x5c-glued-fp.mjs`: `numbersIn('纯棉100%T恤')=["100"]` nhưng `unitsIn('纯棉100%T恤')=[]` (so với `unitsIn('100%纯棉T恤')=["%"]`) → `NEEDS_REVIEW`; `node x5b-units-fp.mjs`: `Một chiếc áo thun cotton → NEEDS_REVIEW n=1 ["Số liệu “Một chiếc” (= 1)…"]` | Chữ Trung hay viết liền số vào chữ Hán (`纯棉100%`, `含棉95%`) ⇒ bản dịch trung thành bị chặn, người dùng phải duyệt tay vô ích; “một chiếc” là mạo từ, không phải số liệu. |

## V2.4 — VẪN KHÔNG PHÁ ĐƯỢC (đo lại tại `e3a8c4f`)

| # | Tuyên bố | Đòn tấn công vòng 2 | Kết quả |
|---|---|---|---|
| B1/B3/B4 | Ảnh gốc bất biến, render là bản ghi mới | `node b4-ops.mjs` sau khi vá | **KHÔNG PHÁ ĐƯỢC.** `số asset: 3 | rendered: 2`; `sha gốc == sha file gốc ban đầu? true`; render lần 1 không bị ghi đè |
| B2 | Buffer đầu vào không bị sửa tại chỗ | `node b4-ops.mjs` | **KHÔNG PHÁ ĐƯỢC.** `sha trước: c1323668a1f078e5 | sau: c1323668a1f078e5 | ĐỔI? false` |
| D1 | IDOR theo session → 404 | `node d1-security.mjs`, `f2-migration.mjs` (F2c) | **KHÔNG PHÁ ĐƯỢC** — D1a: cả 6 lời gọi imagelab của session B → `404 JOB_NOT_FOUND`/`ASSET_NOT_FOUND`; 3 route MVP-01 cũ → 404. (D1b: **đóng giả cookie `sid` của A vẫn 200** — giới hạn đã biết của MVP-01, `session_id` không phải xác thực; không tính là lỗ hổng mới) |
| — | **Hồi quy MVP-01 cho khách ẨN DANH (không giữ cookie)** | `node x10-anon-mvp01.mjs` | **KHÔNG PHÁ ĐƯỢC.** `POST /api/jobs → 202`, `GET /api/jobs/:id → 200`, `GET …/usage → 200`, `PUT …/content → 200`, `GET /api/jobs → 200`; UI thật gửi cookie (`api()` có `credentials: 'same-origin'`) nên luồng trình duyệt không bị ảnh hưởng. Job ImageLab tạo bằng khách không cookie thì cả 4 route MVP-01 trả `404 JOB_NOT_FOUND` — **đúng thiết kế** (job ImageLab luôn đòi session khớp), đã ghi ở “chưa kiểm được” |
| F4 | Thiếu provider ⇒ fail-closed | `node b4-ops.mjs` | **KHÔNG PHÁ ĐƯỢC.** `502 NOT_CONFIGURED` cho imagelab; `MVP-01 POST /api/jobs → 202` vẫn sống |
| A2/A1 | Không nhãn LIVE, vùng rác OCR không lọt | `node a1-honesty.mjs` | **KHÔNG PHÁ ĐƯỢC.** `chuỗi LIVE trong toàn bộ DB: {"n":0}`; `asset JSON … có storage_path? false | có session_id? false` |
| D6 (F-05 mở rộng) | `expose` không được mở thành cửa rò rỉ | `node x11-mask-overreach-f05.mjs`, `x12-500-leak.mjs`, `grep -rn "HttpError.safe" src/` | **KHÔNG PHÁ ĐƯỢC.** `expose` chỉ bật qua `HttpError.safe` (11 chỗ, **toàn câu tiếng Việt tĩnh do repo viết**, `details:{}`); `storage_path=/tmp` (thư mục) → `404 ASSET_FILE_NOT_FOUND`; body dị dạng → `400 BAD_EDITS` / `400 BAD_REGION_IDS` / `413 TOO_MANY_EDITS`; **không tìm được đường nào trả 500 kèm stack/đường dẫn** |
| — | Mặt nạ không che quá tay | `node x11-mask-overreach-f05.mjs` | **KHÔNG PHÁ ĐƯỢC.** `ĐỎ trong hộp bảo vệ: 256/256` + `XANH ngoài hộp bảo vệ bị xoá: 616/616` |

## V2.5 — CHƯA KIỂM ĐƯỢC (vòng 2)

1. **Một service render `http` THẬT** (trả tiền, inpainting thật): N-5 được chứng minh bằng server GIẢ ở `127.0.0.1`; tôi **không** đo được tần suất một service thật “vẽ lem” ra ngoài hộp, cũng không kiểm được service thật có trả `applied` trung thực không. Đây là câu hỏi cho Owner.
2. **Lỗi 500 KHÔNG `expose` sinh từ một exception bất ngờ**: tôi chỉ chứng minh được bằng đọc mã (`sendError`: `status >= 500 && !err.expose` ⇒ câu chung) + 6 ca đầu vào dị dạng đều bị chặn ở 4xx; **không** dựng được một 500 thật mà không sửa mã nguồn.
3. **`x` NULL sinh ra từ chính hệ thống** (N-1): tôi đầu độc DB bằng `node:sqlite`; chưa kiểm được liệu một migration/tác nhân ghi khác trong vận hành có tạo được NULL thật hay không (schema hiện tại có ràng buộc gì cho `ocr_regions.x` — chưa xác minh).
4. **Hai request `render` đồng thời trên cùng job** (đua ghi DB) và nhiều instance server chia sẻ `IMAGELAB_DIR`: vẫn chưa kiểm (giữ nguyên như vòng 1).
5. **PostgreSQL**: vẫn chỉ chạy SQLite (`node:sqlite`); test PostgreSQL vẫn là test **skip** duy nhất (`test/store.test.js:162`).
6. **Trình duyệt thật**: các hàm UI (`renderIlWarnings`) được trích và **chạy thật** trong Node, nhưng chưa mở DOM/CSS thật, chưa bấm nút override trong trình duyệt, chưa kiểm `Set-Cookie` (`SameSite`/`Path`) trên trình duyệt thật.
7. **`data/studio.db` thật**: vẫn chỉ chạy migration trên bản sao trong `/tmp`.
8. **Giới hạn phương pháp của guardrail** (N-6): không có cách nào chặn `xii`/homoglyph/không-dấu bằng regex mà không tăng dương tính giả; tôi **không** đề xuất ngưỡng cụ thể — cần Owner quyết định đánh đổi.

---
---

# VÒNG 3 — chấm lại tại commit `3644d4f`

PHÁN QUYẾT CUỐI: **PASS CÓ ĐIỀU KIỆN** *(1 điều kiện nhỏ còn lại: vá `store.toNum` — N-1 phần chưa kín; mọi phát hiện khác đều MINOR)*

- Commit chấm: `3644d4fc52cfdc392828445e8b9a7cb2bc0ce1e6` (03/10/2026 ~12:3x–13:0x UTC). `git status --short` sau khi làm việc: **sạch** (chỉ `docs/MVP-02-REVIEW.md` được ghi; không sửa mã nguồn, không sửa `test/**`).
- Toàn bộ nội dung VÒNG 1 + VÒNG 2 ở trên được **giữ nguyên**. Script vòng 3 ở **`/tmp/atk5/`** (bản sao đòn vòng 2 đã trỏ lại `/tmp/atk5/`, cộng `x20…x29`). Bằng chứng gộp: `/tmp/atk5/out-rerun1.txt`, `out-rerun2.txt`, `out-x3b.txt`, `out-tests.txt`.
- Tự đo tại commit này: `npm test` → **tests 408 · suites 72 · pass 407 · fail 0 · cancelled 0 · skipped 1 · todo 0** (skip duy nhất vẫn là PostgreSQL `test/store.test.js:162`); `node tools/verify.mjs` → **EXIT=0**. Khớp đúng con số nhóm gộp công bố.
- **Kết luận ngắn:** cả 3 điều kiện của vòng 2 đều **đã được xử lý thật**, N-5 và N-2 **đã thoả**, N-1 **thoả một phần** (còn một đường qua tầng `store`). Không còn lỗi CRITICAL/MAJOR. Bản vá N-5 (hậu kiểm pixel) là bản vá **chất lượng cao**: đo pixel thật, từ chối lưu khi hộp bảo vệ đổi, giữ ảnh gốc nguyên vẹn và ghi vết đầy đủ.

## V3.1 — Bảng 3 điều kiện + N-3/N-4/N-6/N-7

| # | Điều kiện vòng 2 | Kết luận vòng 3 | Bằng chứng (output thật) |
|---|---|---|---|
| **N-5** | Kiểm pixel hộp bảo vệ trên đường `http` hoặc từ chối lưu | **ĐÃ THOẢ** (còn 1 điểm mù MINOR — **N-8**) | `node x9-http-provider.mjs`: `naive` → `rs.status="OK"`, brand `0/8000`, vùng sạch `6000/6000`; `liar` → `PARTIAL` + `NO_OPS` + job `RENDER_NO_OPS` + `applied=[]`; `evil` → job **failed** `PROTECTED_PIXELS_CHANGED`, `ảnhMới=0`. `node x29-refuse-trace.mjs`: `error_message="…8000/8000 pixel tại hộp {"x":40,"y":40,"w":200,"h":40}. TỪ CHỐI lưu ảnh này…"`, `rendered mới: 0`, `sha256 ảnh gốc trước/sau: 14efcb0d3b29024f / 14efcb0d3b29024f`, vết nằm trong `content_meta.imagelab.render.warnings` |
| **N-1** | Fail-closed với toạ độ NULL/rác | **THOẢ MỘT PHẦN** — tầng `geometry`/pipeline đã kín, **tầng `store` vẫn ép rác thành 0** (xem V3.3) | `node x25-n1-coordinates.mjs`: 18/18 loại rác → `strictCoordinate=null`, `intersect=null`; API: `x=NULL/''/'abc'/'12abc'/'NaN'/'Infinity'/'[]'/'{}'`, `y/w/h=NULL`, `box+box_normalized` đều rác → nhãn hiệu **`0/4000`** pixel đổi (ca cuối job `failed IMAGELAB_NO_LINES`). **NHƯNG** `node x26-n1-store-gap.mjs`: `x='  '` (2 dấu cách) → `STORE trả về box … {"x":0,…}` → `PIXEL VÙNG NHÃN HIỆU THẬT … 2800/4000` |
| **N-2** | Đẩy `NO_OPS` lên `job.error_code` | **ĐÃ THOẢ** | `node x27-n2-n3-n4.mjs`: mọi dòng `NO_GLYPH` → `job.status="succeeded"` nhưng `job.error_code="RENDER_NO_OPS"` + `error_message` giải thích; `GET` lại job vẫn giữ `RENDER_NO_OPS`. `node x3-api-noops-poison.mjs` ca dims: `job.error_code="RENDER_NO_OPS"`, `rs.status="PARTIAL"`, `applied=[]` |
| **N-3** | Danh sách lịch sử có nhãn MOCK/kind | **ĐÃ THOẢ** | `node x27…`: item `GET /api/jobs` = `{"kind":"image_translation",…,"mock":true,"mock_steps":["ocr","translate"]}`, `có session_id? false | có content_meta thô? false`; hàm UI THẬT `historyItemHtml` in ra `"(chưa có tên) Thủ công · 19:38:32 3/10/2026 Dịch ảnh MOCK awaiting_review"` |
| **N-4** | `only_region_ids` fail-closed | **ĐÃ THOẢ** (còn khe biên `[]` — **N-11**) | `node x27…`: `["khong-ton-tai"]` → `409 UNKNOWN_REGION_IDS`; `[null,1,{}]` → `409`; `"r1"` (chuỗi) → `400 BAD_REGION_IDS`. `node x28b-only-partial2.mjs`: `[r3, bogus-1, bogus-2]` → `202`, `applied=["r3"]`, `warnings:["⚠️ 2 id trong only_region_ids không khớp vùng nào…"]`. **Khe:** `only_region_ids: []` → `202` và `applied=["r3"]` (= render TẤT CẢ) |
| **N-6** | Guardrail bỏ dấu + `№` | **ĐÃ THOẢ phần lớn** (còn `xii`/homoglyph/`tốt nhứt` — đã ghi ở `docs/VERIFICATION.md §10.3`) | `node x22-guardrail-regression.mjs`: **hồi quy MẤT 0/21** (vẫn bắt `một trăm hai mươi nghìn đồng`, `BH 12 tháng`, `①② tháng`, `ｂảo hành`, `１２ tháng`, ZWSP/NBSP, `Ⅻ`/`ⅻ`, `№1` **và `№` trơ**, kana/Hangul, `chống nước IP68`); 7/7 ca không-dấu nay **BẮT** (`bao hanh mot nam`, `muoi hai thang`, `tot nhat`, `chinh hang`, `chong nuoc`, `cam ket`) — `node x24-old-vs-new.mjs` xác nhận 2 ca này **đổi hành vi từ LỌT sang BẮT** |
| **N-7** | Sửa dương tính giả | **ĐÃ THOẢ** (nhưng sinh 3 dương tính giả MỚI — **N-10**) | `node x22…`: `纯棉100%T恤` + `"Áo thun cotton 100%"` → `TRANSLATED` (hết tố oan); `"Một chiếc áo thun cotton"` → `TRANSLATED`. `node x24-old-vs-new.mjs`: 2 ca này **đổi từ BẮT sang lọt** (đúng như chủ ý); 3 ca `"Chỉnh hàng"`, `"Đất chuẩn bị trồng"`, `"Tột nhất"` **đổi từ lọt sang BẮT** (dương tính giả mới) |

## V3.2 — N-5: tấn công hậu kiểm bằng 14 chế độ server giả

`cd /tmp/atk5 && node x20-http-hardening.mjs` (server render giả ở `127.0.0.1`, `ALLOW_PRIVATE_NETWORK=true`; job có 1 vùng nhãn hiệu `[40,40,200,40]` + 1 vùng mô tả sạch):

| Chế độ server giả | job | `rs.status` | `rs.error_code` | `verified` | ảnh mới | Nhận xét |
|---|---|---|---|---|---|---|
| `naive` (vẽ đúng op) | succeeded | `OK` | null | true | 1 | Đúng: brand `0/8000`, vùng sạch `6000/6000` |
| `liar` (trả ảnh y hệt + khai `applied`) | succeeded | `PARTIAL` | `NO_OPS` | true | 1 | **Bắt được** — bỏ lời khai `applied`, job `RENDER_NO_OPS` |
| `onepixel` (đổi **đúng 1 pixel** trong hộp bảo vệ) | **failed** | – | – | – | **0** | **Từ chối lưu** đúng mức |
| `alphaonly` (chỉ đổi **kênh alpha** 1 pixel) | **failed** | – | – | – | **0** | So RGBA nên vẫn bắt |
| `evil` (xoá cả nhãn hiệu) | **failed** | – | – | – | **0** | `PROTECTED_PIXELS_CHANGED` |
| `bigger` / `smaller` (ảnh khác kích thước) | **failed** | – | – | – | **0** | `SIZE_MISMATCH` ⇒ từ chối |
| `white` (ảnh trắng toàn bộ) | **failed** | – | – | – | **0** | Từ chối |
| `jpeg` (trả JPEG) | succeeded | `PARTIAL` | `PROTECTED_PIXELS_UNVERIFIED` | **false** | 1 | Không báo `OK`, có cảnh báo “⚠️ KHÔNG kiểm chứng được pixel vùng bảo vệ…” |
| `garbage` (base64 rác) | succeeded | `PARTIAL` | `PROTECTED_PIXELS_UNVERIFIED` | false | 1 | Có cảnh báo, **nhưng xem N-8d** |
| `applied-huge` (khai 999 op) | succeeded | `PARTIAL` | `RENDER_APPLIED_MISMATCH` | true | 1 | `applied=1` (giữ đúng số op đã gửi) + cảnh báo |
| `applied-string` (không phải mảng) | succeeded | `PARTIAL` | `NO_OPS` | true | 1 | Fail-closed |
| `applied-empty` | succeeded | `PARTIAL` | `NO_OPS` | true | 1 | Fail-closed |

⇒ **Không chế độ nào báo `OK` khi chưa kiểm được**, và mọi ca hộp bảo vệ bị đổi (kể cả 1 pixel, kể cả chỉ alpha) đều **không sinh ảnh mới**.

## V3.3 — N-1: tầng `geometry` đã kín, tầng `store` thì chưa (điều kiện còn lại)

`node x25-n1-coordinates.mjs` (A) 18/18 phép kiểm đúng: `null/undefined/''/'  '/'abc'/'12abc'/NaN/±Infinity/true/false/[]/{}/new Date/'NaN'` → `strictCoordinate=null` **và** `intersectBoxWithImage=null`; số âm, số thực, chuỗi số vẫn hợp lệ.
(B) API thật — đầu độc từng cột của vùng **nhãn hiệu** trong khi có một vùng mô tả **chồng đúng vị trí thật**, đo pixel:

```
x=NULL / '' / 'abc' / '12abc' / 'NaN' / 'Infinity' / '[]' / '{}' / y=NULL / w=NULL / h=NULL
   → applied=1, skipped có BOX_OVERLAPS_PROTECTED: r2 (brand)  |  PIXEL NHÃN HIỆU ĐỔI=0/4000
box + box_normalized đều rác → job failed "IMAGELAB_NO_LINES", applied=0, KHÔNG render gì (fail-closed)
```
⇒ Với `NULL`/chuỗi rác, bản vá **thậm chí còn tốt hơn yêu cầu**: `#boxOf` lấy lại hộp ĐÚNG từ `box_normalized` nên vẫn chặn được op chồng lấn (thay vì chỉ chặn mù).

**Nhưng còn một đường qua `store`:** `src/store/index.js#toNum` dùng `Number(value)` — mà `Number('  ') === 0`, `Number('\t') === 0`, `Number('0x10') === 16`. Toạ độ rác dạng **chuỗi chỉ có khoảng trắng** (hoặc hex) bị biến thành **SỐ** ngay ở tầng đọc, nên `strictCoordinate` không bao giờ nhìn thấy "rác" để mà chặn:

```
$ cd /tmp/atk5 && node x26-n1-store-gap.mjs
=== x = '  ' (2 dấu cách) ===
  DB thô: {"region_key":"r2","x":"  ","t":"text","x_norm":0.625}
  STORE trả về box của vùng nhãn hiệu: {"x":0,"y":100,"w":100,"h":40}   <-- pipeline dùng hộp này
  render=202 | job=succeeded | applied=["r1","r3"]
  skipped: [["r2","Vùng nhãn hiệu — không dịch, không xoá (luật bất khả xâm phạm #3)."]]
  ➜ PIXEL VÙNG NHÃN HIỆU THẬT [200,100,100,40] BỊ ĐỔI: 2800/4000
```
Giống hệt với `x='\t'`, `x='\n'`, `x='0x10'`. Đối chứng `x=NULL` / `x=''` → `STORE trả về box {"x":null,…}` → `0/4000` (an toàn).
**Cách sửa (1 chỗ, ~3 dòng):** cho `toNum` dùng đúng luật của `strictCoordinate` (chỉ nhận `typeof === 'number'` hữu hạn, hoặc chuỗi đã `trim()` khác rỗng mà `Number()` ra hữu hạn), hoặc gọi thẳng `strictCoordinate` từ `geometry.js` trong `store`. Đây là **điều kiện duy nhất còn lại** của phán quyết.
*(Mức MINOR vì cần dữ liệu DB hỏng/dị thường — pipeline luôn ghi số — nhưng đây đúng là kịch bản mà N-1 được đặt ra để chặn.)*

## V3.4 — N-6/N-7: hồi quy và dương tính giả mới

- **Hồi quy 0/21** (`node x22-guardrail-regression.mjs` phần A): mọi ca từng bắt được vẫn bắt — kể cả `một trăm hai mươi nghìn đồng`, `BH 12 tháng`, `①② tháng`, `ｂảo hành`, `１２ tháng`, `bảo\u200bhành`, `Ⅻ`, `ⅻ`, `№1`, `№` trơ, kana/Hangul, chữ Trung sót.
- **Ca vừa sửa nay BẮT (7/7)**: `Ao thun cotton bao hanh mot nam`, `… 12 thang`, `tot nhat`, `chinh hang`, `chong nuoc`, `cam ket`, `muoi hai thang`.
- **Dương tính giả cũ đã hết (2/2)**: `纯棉100%T恤`+“100%”, `"Một chiếc áo thun cotton"`.
- **Dương tính giả MỚI do so khớp bỏ dấu (N-10)**: `"Chỉnh hàng theo yêu cầu"` → bị tố `Chinh hang` (chính hãng); `"Đất chuẩn bị trồng"` → `Dat chuan` (đạt chuẩn); `"Tột nhất là màu đen"` → `Tot nhat` (tốt nhất). `node x24-old-vs-new.mjs` chứng minh cả 3 **lọt ở vòng 3 và bị bắt ở vòng 4**. Đối chứng sạch không bị bắt oan: `"Áo dài tay"`, `"đồng phục"`, `"Bảo quản nơi khô ráo"`, `"Bao bì đẹp"`, `"Giao hàng toàn quốc"`, `"Ủy tin cậy"`, `"Áo thun cotton một lớp"`, `"Màu sắc: đen, trắng"`.
- **Đơn vị (N-9, có từ trước, không phải hồi quy)**: `node x23-unit-substitution.mjs` — thay đơn vị **bị bắt tốt** (`12 tháng→12 tuần/năm/ngày`, `500克→500 kg`, `100cm→100 m`), nhưng lọt khi đơn vị nằm ngoài từ vựng: `纯棉T恤 500克` + `"500 tấn"` → `LỌT n=0` (`unitsIn(vi)=[]`), `3件装` + `"3 bộ"` → `LỌT`. `node x24-old-vs-new.mjs` xác nhận **cả hai đều lọt ở cả vòng 3 lẫn vòng 4** ⇒ lỗ hổng cũ, chỉ ra rằng từ vựng đơn vị còn thiếu (`tấn`, danh từ đếm).

## V3.5 — LỖ HỔNG MỚI (vòng 3)

| # | Mức | Phát hiện | Bằng chứng thật | Vì sao quan trọng |
|---|---|---|---|---|
| N-8 | MINOR | **Hậu kiểm N-5 chỉ một chiều và dựa vào HASH, không dựa vào PIXEL.** (a) remote trả PNG **cùng pixel nhưng khác byte** (thêm chunk `tEXt`) + khai `applied` ⇒ repo tưởng “đã vẽ” dù **0 pixel** thay đổi; (b) remote chỉ đổi **1 pixel ở góc xa**, không vẽ op ⇒ cũng `OK` + `applied=1`; (c) job **không có vùng bảo vệ** ⇒ không kiểm gì cả, ảnh trả về khác kích thước vẫn được lưu; (d) base64 rác được lưu thành asset `.png` | `node x21-n5-blindspot.mjs`: (a) `status="OK" | job=succeeded | jobErr=null | applied=1 | verified=true` nhưng `pixel đổi | vùng sạch [30,200,200,30]: 0/6000`; (b) y hệt, `0/6000`; (c) `nobrand-small`: asset `100×100` cho job ảnh `320×320`, `status="OK"`, không cảnh báo. `node x20`: `garbage` → asset `bytes=519 magic="646179206b686f6e"` (= chữ “day khon”), `job=succeeded` | Không vi phạm luật #3 (hộp bảo vệ vẫn được đo), nhưng là **báo cáo sai sự thật**: job nói đã dịch/dịch xong trong khi ảnh giao cho khách **y hệt ảnh gốc** (chữ Trung còn nguyên) hoặc là ảnh sai kích thước/rác. Một remote chỉ cần **decode rồi encode lại** (hành vi rất phổ biến) là lách được. Cách sửa rẻ: so **pixel** thay vì hash, và kiểm chiều ngược lại — hộp của các op PHẢI đổi; kiểm `width/height` ảnh trả về == ảnh gốc **kể cả khi không có hộp bảo vệ**; từ chối ảnh không nhận dạng được magic bytes |
| N-9 | MINOR | **Từ vựng đơn vị của guardrail còn thiếu** (`tấn`, danh từ đếm `bộ/chiếc/…`) ⇒ số đúng nhưng **đơn vị sai** vẫn lọt | `node x23-unit-substitution.mjs`: `纯棉T恤 500克` + `"Áo thun cotton 500 tấn"` → `LỌT n=0`, `unitsIn(vi)=[]`; `3件装` + `"3 bộ"` → `LỌT` | “500克 → 500 tấn” là sai 1000 lần mà guardrail im lặng; `node x24-old-vs-new.mjs` xác nhận lỗi **có từ vòng 3** (không phải hồi quy) nhưng cùng nhóm luật (a) mà N-7 vừa sửa |
| N-10 | MINOR | **So khớp BỎ DẤU sinh dương tính giả** khi từ khác dấu trùng chuỗi ASCII với từ khoá khẳng định | `node x24-old-vs-new.mjs`: `"Chỉnh hàng theo yêu cầu"`, `"Đất chuẩn bị trồng"`, `"Tột nhất là màu đen"` → **lọt ở vòng 3, BẮT ở vòng 4** | Hậu quả an toàn (chỉ tốn công duyệt tay), nhưng là đánh đổi mới do N-6; nên ghi vào hợp đồng để người duyệt biết vì sao bị hỏi |
| N-11 | MINOR | **`only_region_ids: []` (mảng rỗng) vẫn render TẤT CẢ** — cùng lớp fail-open mà N-4 vừa bịt, chỉ khác giá trị biên; hợp đồng không nói rõ `[]` = “không lọc” | `node x27-n2-n3-n4.mjs`: `[] (mảng RỖNG) → HTTP 202`; `node x28-only-partial.mjs`: `chỉ định [] → 202 | job=succeeded | applied=["r3"]` (r3 = vùng duy nhất render được) | Client lọc ra danh sách rỗng (ví dụ “chưa chọn vùng nào”) rồi bấm Render sẽ nhận **nhiều hơn** yêu cầu. Không vi phạm luật #3 (vùng bảo vệ vẫn chặn), nhưng trái tinh thần “không vẽ nhiều hơn yêu cầu” của N-4 |

## V3.6 — VẪN KHÔNG PHÁ ĐƯỢC (đo lại tại `3644d4f`)

| # | Tuyên bố | Đòn tấn công vòng 3 | Kết quả |
|---|---|---|---|
| F-01 | Nhãn hiệu không bị xoá pixel (purejs) | `node x2-geometry-mask-noops.mjs` | **KHÔNG PHÁ ĐƯỢC.** 27/27 phép hình học đúng; `TỔNG: 0 phép kiểm LỆCH kỳ vọng`; mọi ca mặt nạ giữ `0` pixel đổi trong hộp bảo vệ |
| F-01 (http) | Op chồng hộp bảo vệ không được gửi đi | `node x9` chế độ `naive` | **KHÔNG PHÁ ĐƯỢC.** `server nhận 1 op; op GIAO với hộp nhãn hiệu: []`; brand `0/8000` |
| F-02 | Override phải có vết | `node x6-f02-override.mjs` | **KHÔNG PHÁ ĐƯỢC** (vẫn `0/8000` cho mọi đường tắt; chỉ override `USER_EDITED`+`provenance=user` mới vẽ) |
| H-1 | Kẹp hộp = giao, không nới rộng | `node x3b-poison-targeted.mjs` ca `x3b-h1` | **KHÔNG PHÁ ĐƯỢC.** Op `{"x":0,"y":150,"w":210,"h":40}` được vẽ (`8400/8400`), nhãn hiệu `0/2400` |
| H-2 / N-2 | 0 op ⇒ không được im lặng | `node x2` phần D, `node x27` | **KHÔNG PHÁ ĐƯỢC** — `PARTIAL`+`NO_OPS` ở engine, `RENDER_NO_OPS` ở job |
| — | Fail-closed khi hộp bảo vệ không xác định được | `node x25` phần C | **KHÔNG PHÁ ĐƯỢC.** `job=failed "IMAGELAB_NO_LINES"`, `applied=0`, không render gì |
| — | Từ chối lưu ảnh làm hỏng vùng bảo vệ | `node x29-refuse-trace.mjs` | **KHÔNG PHÁ ĐƯỢC.** `rendered mới: 0`; thư mục job chỉ còn ảnh gốc; `sha256 … trước/sau: 14efcb0d3b29024f / 14efcb0d3b29024f` |
| N-3 | Danh sách không lộ dữ liệu nội bộ | `node x27` | **KHÔNG PHÁ ĐƯỢC.** `có session_id? false | có content_meta thô? false` |
| — | `npm test` / `verify.mjs` (tự đo) | `npm test`, `node tools/verify.mjs` | **XANH THẬT.** `tests 408 · pass 407 · fail 0 · skipped 1`; verify `EXIT=0` |

## V3.7 — CHƯA KIỂM ĐƯỢC (vòng 3)

1. **Service render `http` THẬT** (trả tiền / inpainting thật): N-5 được chứng minh bằng server GIẢ ở `127.0.0.1` với 14 chế độ; tôi vẫn **không** đo được hành vi của một service thật (tần suất “vẽ lem”, có trả `applied` trung thực không, có re-encode không — chính N-8a).
2. **Nguồn sinh ra toạ độ rác dạng chuỗi khoảng trắng** (N-1 phần còn lại): tôi đầu độc DB bằng `node:sqlite`; chưa xác minh được SQLite có ràng buộc kiểu cho `ocr_regions` và liệu vận hành thật có tạo được giá trị TEXT như vậy không.
3. **PNG 16-bit / interlaced / palette**: `decodePng` từ chối các dạng này — nghĩa là provider `http` trả PNG 16-bit sẽ rơi vào nhánh “không giải mã được ⇒ TỪ CHỐI lưu”; tôi **chưa** kiểm nhánh này bằng ảnh 16-bit thật.
4. **PostgreSQL**: vẫn chỉ chạy SQLite; test PostgreSQL vẫn là test **skip** duy nhất.
5. **Hai request `render` đồng thời** trên cùng job (đua ghi DB) và nhiều instance chia sẻ `IMAGELAB_DIR`: vẫn chưa kiểm.
6. **DOM/trình duyệt thật**: các hàm UI (`renderIlWarnings`, `historyItemHtml`) được trích và **chạy thật** trong Node; chưa mở DOM/CSS thật, chưa bấm nút trong trình duyệt. `protected_pixels_verified` có trong `render_summary`/meta nhưng **UI chưa hiện badge riêng** (chỉ hiện qua câu cảnh báo).
7. **`data/studio.db` thật**: vẫn chỉ chạy migration trên bản sao trong `/tmp`.
8. **Đánh đổi của guardrail**: không có ngưỡng nào chặn được `xii`/homoglyph/`tốt nhứt` mà không tăng dương tính giả (N-10 là ví dụ vừa xảy ra); cần Owner quyết định mức đánh đổi, tôi không tự chọn.
