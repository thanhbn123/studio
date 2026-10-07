# MVP-04 — BÁO CÁO PHẢN BIỆN ĐỘC LẬP

PHÁN QUYẾT: **FAIL**

- Nhánh: `feat/mvp04-videostudio` · Commit: `0684ff4` (người phản biện chạy 00:5x–01:3x ngày 07/10/2026)
- Người phản biện: agent độc lập, **không sửa mã nguồn, không sửa `test/**`**. Mọi script nằm ở `/tmp/mvp04-atk/**`; file duy nhất được ghi trong repo là báo cáo này.
- `git status --short` khi kết thúc: chỉ `docs/MVP-04-REVIEW.md` (báo cáo này) + 8 file `test/mvp04-*.test.js` / `test/mvp04-*.mjs` **untracked do agent test viết song song trong lúc tôi phản biện** (mtime 01:03–01:11; `git ls-files test/ | grep mvp04` chỉ có `test/mvp04-multi-scene.test.js`). `git diff --stat` trên file tracked: **rỗng**.
- Cách chạy lại: `cd /tmp/mvp04-atk && node <tên script>` — harness tự dựng **app THẬT** (HTTP thật, SQLite in-memory, storage thật trong thư mục tạm), provider `purejs` thật; bộ giải mã GIF là **Python thuần tự viết** (`gifdec.py`, không dùng mã repo) + đối chứng `file` / `sips` (ImageIO của macOS) / `magick` (ImageMagick).

**Kết quả tổng quan: 1 CRITICAL · 2 MAJOR · 6 MINOR.** Phần lớn hợp đồng **đúng và đã cố phá không phá được** (mục 3): GIF mở được thật và **khớp pixel**, không bóp méo, số khung/delay khớp, 29/37 biến thể chữ bịa bị chặn, tiền/hoàn tiền/402/usage đúng, IDOR/XSS/prototype-pollution/DoS đều kín. Nhưng **luật riêng #3 (“chữ thiếu bằng chứng ⇒ KHÔNG vẽ, 0 pixel chữ”) bị vi phạm ở mức pixel** với 13 từ khoá mà chính mã nguồn V3 khai là phải chặn — job vẫn `succeeded`; cùng đó **video dài hơn ~5,75–6,58 giây KHÔNG BAO GIỜ tạo được** (preset cho 30 giây) và **ảnh PNG trong suốt cho ra video đen toàn tập mà không một cảnh báo**.

---

## 1. Tóm tắt

| # | Mức | Phát hiện | Bằng chứng (1 dòng) | Vì sao quan trọng | Gợi ý sửa (KHÔNG tự sửa) |
|---|---|---|---|---|---|
| **F1** | **CRITICAL** | **Rò luật chống bịa**: 13/19 từ khoá trong danh sách `CLAIM_PHRASES` của chính V3 (`pipeline.js`) KHÔNG được V1 kiểm, và `collectViolations` **chỉ dùng bộ dự phòng khi V1 vắng** ⇒ chữ khẳng định **không có bằng chứng nào vẫn được VẼ lên video**, job `succeeded`, API/UI không hề báo chặn | `node findings.mjs` → `F1_UNIT: v1_misses=["đảm bảo","uy tín","miễn phí","freeship","giảm giá","khuyến mãi","hàng đầu","chất lượng cao","nguyên seal","nguyên đai","duy nhất","giá rẻ nhất","nhập khẩu"]` · `F1_HTTP: http=202 job=succeeded white_pixels_with_claim=10535 white_pixels_control_no_text=0` (giải GIF bằng decoder Python độc lập) · `node e2e-round2.mjs` → **12/13 câu qua HTTP đều lọt**, ví dụ `"giá rẻ nhất" (20956px, bbox [21,21,865,137])` | Hợp đồng §0 luật 3 + §3: “Chữ thiếu bằng chứng ⇒ **không vẽ** + lỗi `VIDEO_TEXT_UNSUPPORTED_CLAIM` (422), **0 pixel chữ**”. Sprint này sinh ra sản phẩm **để đăng bán**; video đang quảng cáo “miễn phí vận chuyển”, “giá rẻ nhất”, “chính hãng/nguyên seal” mà hệ thống tuyên bố đã kiểm. Bộ dự phòng của V3 tồn tại chính vì V1 hẹp hơn — nhưng bị `??` vô hiệu hoá | `src/videostudio/pipeline.js:415-427`: đổi `[...(viaV1 ?? fallbackViolations(...))]` thành **hợp của hai bộ** (`[...(viaV1 ?? []), ...fallbackViolations(texts, evidenceText)]` rồi khử trùng) — đúng như chú thích ngay trên hàm (“hai bộ chạy SONG SONG… không bao giờ nới lỏng bộ dự phòng”). Thêm test HTTP cho **từng** phần tử `CLAIM_PHRASES` |
| **F2** | **MAJOR** | **Video dài hơn ~5,75s (16:9/dọc) hoặc ~6,58s (1:1) KHÔNG BAO GIỜ tạo được**: `inspectGif` tự chặn vì `INSPECT_MAX_PIXELS = 64_000_000`, trong khi preset cho tới 30s (331,8M điểm ảnh); job `failed` `VIDEO_GIF_INVALID` với câu **đổ lỗi cho GIF** dù GIF hợp lệ | `node findings.mjs` → `F2_UNIT: repo_inspect={"valid":false,"frames":70,"errors":["Tổng điểm ảnh 64512000 vượt trần kiểm 64000000."]}` nhưng `external: file=GIF 1280x720 · magick_frames=360 · strict_python={"ok":true,"frames":360,...} · sips=1280×720` · `F2_HTTP: 10 cảnh×3s → http=202 job=failed error_code=VIDEO_GIF_INVALID` · `node e2e-round6.mjs` → 30s ở 16:9: `total_ms=8828 job=failed` | §2.1 `max_seconds: 30` + §3 “Tổng thời lượng ≤ trần preset”; “ĐỊNH NGHĨA XONG” hứa video 30s. Thực tế **mọi preset đều bất khả thi ở độ dài quảng cáo** (video 3 ảnh × 3s mặc định đã fail). Tệ hơn: thông báo nói **GIF hỏng** — trong khi 4 công cụ ngoài đọc được đủ 360 khung ⇒ hệ thống **nói sai về chính sản phẩm của mình** | Nâng `INSPECT_MAX_PIXELS` (hoặc kiểm theo từng khung: ngân sách = `width×height×MAX_GIF_FRAMES`) để **bao trùm** trần preset (`30s × fps × W × H` = 331,8M); nếu vẫn muốn trần, phải **kẹp `max_seconds` của preset theo ngân sách kiểm** và báo `PLAN_TOO_LONG` **trước khi** render — tuyệt đối không trả `VIDEO_GIF_INVALID` cho một GIF hợp lệ |
| **F3** | **MAJOR** | **Ảnh PNG trong suốt ⇒ video đen, không cảnh báo**: alpha bị làm phẳng lên `pad_color` **trong `renderFrames`** nên cảnh báo “Đã làm phẳng N điểm ảnh alpha < 255…” của `encodeGif` (§2.2) **không bao giờ chạy trên đường thật**; PNG trong suốt hoàn toàn cho ra 810.000 pixel đen, `succeeded` | `node alpha-2000.mjs` → `FULLY_TRANSPARENT_PNG: http=202 job=succeeded warnings=["Video KHÔNG có tiếng …"] distinct_colors_frame0=1 black=810000 white=0` · `node e2e-round3.mjs` → `TRANSPARENT_IMAGE: left(alpha=0)=[0,0,0] right=[0,0,255] warnings=[chỉ câu không-tiếng]` | §2.2 yêu cầu `warnings` khi alpha bị làm phẳng (“GIF không có alpha bán phần”); người dùng không được nói rằng nền trong suốt của họ đã thành **đen**. Ca này rất thật: **đầu ra của MVP-03 (ảnh đã tách nền, nền alpha=0) đưa thẳng vào MVP-04 sẽ ra video nền đen** | Trong `renderFrames`: đếm pixel `alpha < 255` của ẢNH NGUỒN và ghi cảnh báo (kèm `pad_color` đã dùng), hoặc cho chọn `background` riêng; và/hoặc đẩy cảnh báo `encodeGif.flattened` lên `meta.warnings` khi nguồn có alpha |
| **F4** | MINOR | **Bằng chứng VÒNG qua `PUT /api/jobs/:id/content`**: 2 request là đủ để tự cấp bằng chứng (`product_name`) rồi vẽ chữ khẳng định | `node findings.mjs` → `F3_HTTP: put_http=200 generate_http=202 job=succeeded white_pixels=8025` | V3/V4 tuyên bố “client vừa phát ngôn vừa tự cấp bằng chứng là lỗ ‘bằng chứng vòng’” và chỉ nhận bằng chứng từ dữ liệu ĐÃ LƯU — nhưng `product_name` của job `video_generation` lại ghi được qua route MVP-01. **Theo tiền lệ MVP-03 vòng 2** (dữ liệu người dùng đã lưu là bằng chứng hợp lệ theo §0 luật 3) nên chỉ MINOR, nhưng phải nói rõ trong hợp đồng | Ghi vào hợp đồng “bằng chứng = mọi thứ người dùng ĐÃ LƯU vào job (kể cả `product_name` sửa qua `/api/jobs/:id/content`)”; trả `evidence_used.sources` cụ thể (`product_name` / `ocr_region` / `job_notes`) trong `meta.videostudio` để người duyệt biết vì sao chữ được vẽ |
| **F5** | MINOR | **Biên LZW: mã kết thúc EOI thiếu 1 bit** khi mã cuối cùng chạm đúng mốc `2^k` ⇒ file do repo ghi bị `inspectGif` coi là hỏng (`job failed`, không lưu — fail-closed, tốt) dù pixel đủ | `node findings.mjs` → `F4_EOI_8x8: bytes=66 inspect_valid=false errors=["Khung #0: dòng LZW hết bit trước khi gặp mã kết thúc"] strict_python={"ok":false,"error":"LZW: hết bit trước mã kết thúc"} magick="GIF 8x8 … 66B"`; ImageMagick ghi **cùng dòng mã** nhưng thêm 1 byte `0x00` (`848fa9cbed5d` vs `848fa9cbed5d00`) | `encodeGif` là hợp đồng §2.2 (“GIF89a thật”); ở ca biên này tệp là GIF **không chuẩn** (decoder nghiêm ngặt từ chối). Trên khung cỡ preset (720×1280/900×900/1280×720) tôi chưa tái hiện được (`node preset-solid.mjs` → 9/9 valid), nên hiện là lỗi **tiềm ẩn**, đã được chặn bởi `inspectGif` | Trong `encodeLzw`, trước khi `emit(endCode)` phải nới `codeSize` nếu `nextCode === 1 << codeSize` (đối xứng với nhánh gán mã); thêm ca test 8×8 đơn sắc |
| **F6** | MINOR | **Nhịp phát thật NGẮN hơn khai báo 4%**: delay 83,33ms làm tròn còn 80ms ⇒ 30s khai báo chỉ phát 28,8s, **không cảnh báo** (ngưỡng cảnh báo là lệch ≥ 5ms/khung, ở đây 3,33ms) | `node frames.mjs` → `FRAMES max_30s: duration_ms=30000 delay_units=[8] playback_ms=28800 drift_ms=-1200 drift_pct=-4`; mọi ca thời lượng khác đều `-4%` | §2.1 khai `duration_ms`; UI hiện “dài X giây” theo plan. Sai 4% không phá video nhưng là **con số nói sai** ở mọi video | Hạ ngưỡng cảnh báo xuống < 3,34ms/khung, hoặc chọn `fps`/delay sao cho `1000/fps` là bội của 10ms (fps 10/20/25) — hoặc ghi thẳng “nhịp thật ≈ X giây” vào `encode_summary` |
| **F7** | MINOR | **Preflight của route hẹp hơn V1**: chỉ đọc `item.text` ⇒ `{content}` / `{value}` / `{label}` / số không bị kiểm sớm ⇒ trả **202 rồi job `failed`** thay vì **422** | `node e2e-anon.mjs` → `A4: item.label_only → http=202 job=failed error=VIDEO_TEXT_UNSUPPORTED_CLAIM`; `item.content_only`, `item.value_only`, `scene.texts_array` cũng 202→failed | §2.4/§3 hứa 422 khi chữ thiếu bằng chứng; V1 vẫn chặn ở pipeline (không vẽ, 0 byte) nên **không rò**, nhưng người dùng trả giá bằng 1 job + 1 lượt chạy để nhận lỗi muộn | Cho `videostudioTextsOf` đọc đúng bộ khoá của V1 (`text`/`content`/`label`/`value` + số) — hoặc gọi thẳng `collectClaimViolations` trên **chính mảng `itemLists`** mà V3 sẽ dùng |
| **F8** | MINOR | `plan_summary` cắt chữ ở **300** ký tự trong khi video vẽ tới **500** (route cắt ở `VIDEOSTUDIO_TEXT_MAX=500`) ⇒ mở lại job thấy chữ khác chữ trên video | `node misc.mjs` → `LONG_TEXT_500_vs_300: job=succeeded plan_summary_len=300 meta_plan_len=300` (route nhận 800 → cắt 500 → summary 300) | §4 vòng gộp: `plan_summary` giữ `scenes[].texts` để “mở lại job, ô chữ không trống”; cắt lệch ⇒ người dùng sửa lại chữ mà không biết mình đang thiếu 200 ký tự | Dùng chung một hằng `VIDEOSTUDIO_TEXT_MAX` cho cả sanitize, `summarizePlan` và `VIDEOSTUDIO_TEXT_MAX` của UI |
| **F9** | MINOR | Đường **job lỗi**: `GET /api/videostudio/jobs/:id → warnings: []` (câu “không có tiếng” chỉ còn ở `last_run.warnings` + `content_meta`) | `node misc.mjs` → `AUDIO_FAIL_PATH: job=failed data_warnings_audio=0 last_run_warnings_audio=1 content_meta_warnings_audio=1` | §0 luật 2: “mọi kết quả … + cảnh báo”; ở đây **không có video nào được trả** nên không phải “video thiếu cảnh báo”, nhưng danh sách `warnings` cấp cao nhất rỗng là điểm lệch giữa các đường trả | Gộp `content_meta.videostudio.warnings` vào `warnings` của route GET (đã có sẵn trong DB) |
| **F10** | MINOR | **`fit_box` của plan KHÔNG khớp nội dung được vẽ** với ảnh rất mảnh: V1 làm tròn `w`/`h` độc lập nên tỉ lệ `fit_box` lệch tỉ lệ nguồn, V2 tự tính lại `contain` **bên trong** hộp ⇒ ảnh nhỏ hơn hộp, viền nhiều hơn kế hoạch (nội dung vẫn đúng tỉ lệ — không méo, nhưng metadata nói sai vị trí/kích thước ảnh) | `node fitbox.mjs` → `1x1000 pad: fit_box={"x":359,"y":0,"w":1,"h":1280} drawn_bbox={"x":359,"y":140,"w":1,"h":1000} drawn_smaller_h_pct=21.88`; `10x4000 pad: drawn_smaller_h_pct=6.25` | §2.1: `fit_box` là field hợp đồng (“vị trí ảnh trong khung”) và UI giải thích pad/crop theo nó; người đọc `fit_box` tưởng ảnh phủ `0..1280` trong khi thực tế `140..1139` | Trong `plan/fit.js` tính `w`,`h` từ **cùng một** `scale` rồi để V2 dùng thẳng `fit_box` — hoặc V1 tính `scale` hiệu dụng `min(w/sw, h/sh)` **sau** làm tròn và ghi vào plan (một nguồn số duy nhất) |

---

## 2. Chi tiết từng phát hiện (lệnh + output thật)

### F1 (CRITICAL) — Chữ khẳng định không có bằng chứng VẪN ĐƯỢC VẼ (luật riêng #3 bị vi phạm)

**Gốc lỗi (đọc mã)**: `src/videostudio/pipeline.js`

```js
// dòng 134-159: bản dự phòng của V3 — CHÍNH V3 khai các từ này phải chặn
const CLAIM_PHRASES = Object.freeze(['bảo hành','chính hãng','cam kết','đảm bảo','uy tín','tốt nhất','số 1',
  'miễn phí','freeship','giảm giá','khuyến mãi','hàng đầu','chất lượng cao','nguyên seal','nguyên đai',
  'duy nhất','giá rẻ nhất','nhập khẩu','an toàn tuyệt đối']);
// dòng 137 (ghi chú): "hai bộ chạy SONG SONG, V1 chỉ có thể THÊM vi phạm, không bao giờ nới lỏng bộ dự phòng"
// dòng 415-417 (mã):   const viaV1 = moduleViolations(...);
//                      const all = [...(viaV1 ?? fallbackViolations(texts, evidenceText))];   ← ?? nuốt bộ dự phòng
```

**Đo thật (unit + HTTP + pixel)**:

```
$ cd /tmp/mvp04-atk && node findings.mjs
{"test":"F1_UNIT","v1_blocks":["bảo hành","chính hãng","cam kết","tốt nhất","số 1","an toàn tuyệt đối"],
 "v1_misses":["đảm bảo","uy tín","miễn phí","freeship","giảm giá","khuyến mãi","hàng đầu","chất lượng cao",
              "nguyên seal","nguyên đai","duy nhất","giá rẻ nhất","nhập khẩu"],
 "src_line":"src/videostudio/pipeline.js:417  const all = [...(viaV1 ?? fallbackViolations(texts, evidenceText))];"}
{"test":"F1_HTTP","http":202,"job":"succeeded","error_code":null,
 "white_pixels_with_claim":10535,"white_pixels_control_no_text":0,"verdict":"CHỮ ĐÃ ĐƯỢC VẼ (rò luật 3)"}
```

Pixel trắng chỉ có thể là CHỮ (ảnh nguồn xám `rgb(10,10,10)`, viền đen) — job **không có chữ** cho `white=0`, job có chữ cho `white=10535`; bbox `[21,21,811,90]` là một dải chữ ngang.

```
$ cd /tmp/mvp04-atk && node e2e-round2.mjs | tail -3
{"text":"giá rẻ nhất","http":202,"job":"succeeded","white":20956,"frames":3,"delays":[8,8,8],"bbox":[21,21,865,137],"drawn":true}
{"test":"HTTP_V3_PHRASES","leaked":["đảm bảo chất lượng (14144px)","miễn phí vận chuyển (10535px)","freeship toàn quốc (12864px)",
 "giảm giá sốc (20016px)","khuyến mãi lớn (16100px)","hàng đầu thị trường (11025px)","chất lượng cao (16100px)",
 "nguyên seal (22308px)","nguyên đai nguyên kiện (9252px)","duy nhất hôm nay (14499px)","giá rẻ nhất (20956px)",
 "nhập khẩu chính ngạch (12054px)"]}
```

**Đối chứng (bộ kiểm V1 vẫn chạy tốt cho phần nó biết)**: 37 biến thể ở vòng 1 có **29 bị chặn 422** (`Bảo hành 12 tháng`, `bao hanh 12 thang`, `bảo\u200bhành`, `bảo hànһ` (Kirin һ), `ＢẢＯ…`, `ＩＳＯ ９００１`, `IP68 chống nước`, `①②③ sản phẩm số 1`, `100% an toàn`, `保修 12 个月`, `保証期間`…). Rò đúng 13 từ khoá V3-only ở trên ⇒ **không phải guardrail hỏng chung, mà là bộ dự phòng bị vô hiệu**. Một chi tiết cho thấy rò là do *danh sách từ*, không do luật số: câu `"uy tín 10 năm"` **bị chặn** (vì số `10` không có trong bằng chứng — luật số liệu của V1 vẫn chạy), nhưng `"uy tín"` trần thì **lọt**.

**Vì sao CRITICAL**: đây là luật riêng #3 của sprint, ở tầng “sản phẩm cuối để đăng bán”; hệ thống vừa **vẽ** khẳng định vừa **báo `succeeded`** và (qua route preflight) vừa **ngầm khẳng định đã kiểm chống bịa**.

---

### F2 (MAJOR) — Video > ~5,75–6,58s bất khả thi; lỗi đổ cho GIF trong khi GIF hợp lệ

```
$ cd /tmp/mvp04-atk && node findings.mjs
{"test":"F2_UNIT","frames":360,"bytes":51174244,"total_pixels":331776000,
 "repo_inspect":{"valid":false,"frames":70,"errors":["Tổng điểm ảnh 64512000 vượt trần kiểm 64000000."]},
 "external":{"file":"long_1280x720.gif: GIF image data, version 89a, 1280 x 720",
             "magick_frames":360,
             "strict_python":{"ok":true,"frames":360,"w":1280,"h":720,"loop":0,"delay_units":[8,8,8,8],"lzw_resets":9180},
             "sips":"pixelWidth: 1280   pixelHeight: 720"},
 "ceiling":{"900x900":"79 khung ≈ 6,58s","720x1280|1280x720":"69 khung ≈ 5,75s","preset_max_seconds":30}}
{"test":"F2_HTTP","scenes":10,"seconds":30,"http":202,"job":"failed","error_code":"VIDEO_GIF_INVALID",
 "error_message":"GIF mã hoá ra KHÔNG hợp lệ hoặc lệch kế hoạch ({\"valid\":false,…,\"frames\":70,…,
  \"errors\":[\"Tổng điểm ảnh 64512000 vượt trần kiểm 64000000.\"]}) — KHÔNG lưu (fail-closed)."}
```

```
$ cd /tmp/mvp04-atk && node e2e-round3.mjs   # (trích)
{"test":"LONG_VIDEO","scenes":1,"seconds":3,"http":202,"status":"succeeded",...}
{"test":"LONG_VIDEO","scenes":2,"seconds":6,"http":202,"status":"succeeded",...}
{"test":"LONG_VIDEO","scenes":3,"seconds":9,"http":202,"status":"failed","error_code":"VIDEO_GIF_INVALID",
 "error_message":"… errors\":[\"Tổng điểm ảnh 64800000 vượt trần kiểm 64000000.\"] …"}
$ node e2e-round6.mjs
{"test":"MAX_LENGTH_JOB","http":202,"total_ms":8828,"job":"failed","error_code":"VIDEO_GIF_INVALID",
 "error_message":"…\"frames\":70,…\"Tổng điểm ảnh 64512000 vượt trần kiểm 64000000.\""}
```

**Đọc số cho đúng**: `INSPECT_MAX_PIXELS = 64_000_000` (inspect.js) vs preset cho `30s × 12fps × 921.600 px = 331.776.000` px — **ngân sách kiểm nhỏ hơn 5,2 lần** mức hợp đồng cho phép. Ngưỡng thực: 1:1 = 79 khung (6,58s), dọc/ngang = 69 khung (5,75s). **3 ảnh × 3 giây (mặc định `DEFAULT_SCENE_MS`) đã fail.** Thông báo `VIDEO_GIF_INVALID` là **nói sai**: GIF đủ 360 khung, `magick identify` liệt kê đủ 360 dòng, decoder Python giải đủ 360 khung với 9.180 lần reset từ điển LZW.

---

### F3 (MAJOR) — PNG trong suốt ⇒ video đen, không cảnh báo alpha

```
$ cd /tmp/mvp04-atk && node alpha-2000.mjs
{"test":"FULLY_TRANSPARENT_PNG","http":202,"job":"succeeded",
 "warnings":["Video KHÔNG có tiếng (GIF không chứa âm thanh) — …"],
 "plan_warnings":["Video KHÔNG có tiếng: …"],"encode_warnings":["video KHÔNG có tiếng …"],
 "distinct_colors_frame0":1,"white":0,"black":810000}
$ node e2e-round3.mjs     # (trích) ảnh nửa trái alpha=0 (đỏ), nửa phải đục (xanh)
{"test":"TRANSPARENT_IMAGE","http":202,"status":"succeeded",
 "pixels":{"left":[0,0,0],"right":[0,0,255],"w":900,"h":900},
 "warnings":["Video KHÔNG có tiếng (GIF không chứa âm thanh) — …"]}
```

Nửa trong suốt thành **đen** (màu viền), và **không** cảnh báo nào nói về alpha: cảnh báo làm phẳng của `encodeGif` không chạy vì `renderFrames` đã composite alpha lên `pad_color` trước khi mã hoá ⇒ khung gửi vào encoder đã `alpha = 255` toàn bộ. Đây là mắt xích thật giữa MVP-03 (xuất PNG nền trong suốt) và MVP-04.

---

### F4 (MINOR) — Bằng chứng vòng qua `PUT /api/jobs/:id/content`

```
$ cd /tmp/mvp04-atk && node findings.mjs
{"test":"F3_HTTP","put_http":200,"generate_http":202,"job":"succeeded","error_code":null,"white_pixels":8025,
 "verdict":"CHỮ KHAI BÁO ĐƯỢC VẼ nhờ tự ghi product_name"}
```
Chuỗi: tạo job video → `PUT /api/jobs/:id/content {product_name:"Bảo hành 12 tháng chính hãng ISO 9001"}` (route MVP-01, không giới hạn `kind`) → `POST generate` với chữ “Bảo hành 12 tháng chính hãng” ⇒ **không** 422, chữ được vẽ. Theo tiền lệ MVP-03 vòng 2 (`docs/MVP-03-REVIEW.md`, mục “Lập luận mức độ”), dữ liệu người dùng **đã lưu** là bằng chứng hợp lệ theo định nghĩa hợp đồng ⇒ MINOR, nhưng cần ghi rõ + truy vết nguồn.

---

### F5 (MINOR) — Biên LZW: EOI thiếu 1 bit ở mốc `2^k`

```
$ cd /tmp/mvp04-atk && node findings.mjs
{"test":"F4_EOI_8x8","bytes":66,"inspect_valid":false,
 "inspect_errors":["Khung #0: dòng LZW hết bit trước khi gặp mã kết thúc (file bị cắt?)."],
 "strict_python":{"ok":false,"error":"GifError: LZW: hết bit trước mã kết thúc"},
 "file":"…/eoi_8x8.gif: GIF image data, version 89a, 8 x 8",
 "magick":"…/eoi_8x8.gif GIF 8x8 8x8+0+0 8-bit sRGB 2c 66B"}

$ cd /tmp/mvp04-atk && python3 - <<'EOF'      # so dòng mã với bộ mã hoá tham chiếu
# repo_08.gif (repo)  : 848fa9cbed5d      (6 byte)
# magick_08.gif (IM)  : 848fa9cbed5d00    (7 byte — thêm 0x00 cho EOI 5 bit)
EOF
$ node corpus.mjs ; python3 scan_gifs.py | tail -5
== strict decode: 191 OK / 4 FAIL trên 195 file
 FAIL …/out/c01_solid_1frame/out.gif · …/boundary/repo_08.gif · …/corpus/solid2_8.gif · …/corpus/solid_8.gif
```
4/195 file hỏng — **tất cả** là khung 8×8 một màu (frame nhỏ, 1 màu bảng). Toàn bộ GIF do pipeline thật tạo (≈50 file 720×1280/900×900) giải **OK**; `node preset-solid.mjs` (9 ca ở 3 cỡ preset) đều `valid:true` ⇒ hiện là lỗi tiềm ẩn, đã được `inspectGif` chặn (fail-closed, không lưu file hỏng).

---

### F6 (MINOR) — Nhịp phát ngắn hơn khai báo 4%

```
$ cd /tmp/mvp04-atk && node frames.mjs | grep FRAMES
FRAMES max_30s   plan=360 sum=360 render=360 gif=80  formula=360 dur=30000ms delay_units=[8] playback=28800ms drift=-1200ms (-4%) valid=False
FRAMES min_250   plan=3   sum=3   render=3   gif=3   formula=3   dur=250ms   delay_units=[8] playback=240ms   drift=-10ms (-4%)  valid=True
FRAMES 3_canh_250 plan=9  sum=9   render=9   gif=9   formula=9   dur=750ms   delay_units=[8] playback=720ms   drift=-30ms (-4%)  valid=True
```
Số khung thì **khớp tuyệt đối** ở mọi ca (`plan.frame_count == Σ scene.frames == frames render == frames GIF == round(duration/1000×fps)`, kẹp sàn 250ms và cắt trần 30s đúng), nhưng thời lượng phát thật luôn −4% và không có cảnh báo (ngưỡng `delayDrift ≥ 5ms`).

---

### F7 (MINOR) — Preflight hẹp hơn V1 ⇒ 202 rồi failed thay vì 422

```
$ cd /tmp/mvp04-atk && node e2e-anon.mjs | grep A4_fake_evidence
{"name":"item.label_only","http":202,"job_status":"failed","job_error":"VIDEO_TEXT_UNSUPPORTED_CLAIM"}
{"name":"item.content_only","http":202,"job_status":"failed","job_error":"VIDEO_TEXT_UNSUPPORTED_CLAIM"}
{"name":"item.value_only","http":202,"job_status":"failed","job_error":"VIDEO_TEXT_UNSUPPORTED_CLAIM"}
{"name":"scene.texts_array","http":202,"job_status":"failed","job_error":"VIDEO_TEXT_UNSUPPORTED_CLAIM"}
{"name":"number_text","http":422,"code":"VIDEO_TEXT_UNSUPPORTED_CLAIM"}
```
`options.title/cta/scene.cta` và mọi bằng chứng client tự khai (`options.evidence`, `options.source_text`, `item.source_text`, `item.evidence`, `scene.evidence`, `scene.source_text`) **đều bị 422** — đó là phần làm đúng. Chỉ các dạng `{content}/{value}/{label}` lọt preflight (nhưng V1 chặn ở pipeline: **0 byte video**).

---

### F8 & F9 (MINOR)

```
$ cd /tmp/mvp04-atk && node misc.mjs | tail -2
{"test":"LONG_TEXT_500_vs_300","http":202,"job":"succeeded","plan_summary_len":300,"meta_plan_len":300}
{"test":"AUDIO_FAIL_PATH","http":202,"job":"failed","error_code":"VIDEO_TEXT_UNSUPPORTED_CLAIM",
 "data_audio":null,"data_warnings_audio":0,"last_run_warnings_audio":1,"content_meta_warnings_audio":1,"warnings":[]}
```

---

### F10 (MINOR) — `fit_box` của plan không khớp nội dung vẽ ra (ảnh rất mảnh)

```
$ cd /tmp/mvp04-atk && node fitbox.mjs
{"src":"1x1000","fit":"pad","fit_box":{"x":359,"y":0,"w":1,"h":1280},"drawn_bbox":{"x":359,"y":140,"w":1,"h":1000},
 "drawn_smaller_h_pct":21.88,"drawn_smaller_w_pct":0,"scale_v1":1.28}
{"src":"10x4000","fit":"pad","fit_box":{"x":358,"y":0,"w":3,"h":1280},"drawn_bbox":{"x":358,"y":40,"w":3,"h":1200},
 "drawn_smaller_h_pct":6.25,"drawn_smaller_w_pct":0,"scale_v1":0.32}
{"src":"1x4000","fit":"pad","fit_box":{"x":359,"y":0,"w":1,"h":1280},"drawn_bbox":{"x":359,"y":0,"w":1,"h":1280},"drawn_smaller_h_pct":0}
{"src":"1000x1","fit":"pad","fit_box":{"x":0,"y":639,"w":720,"h":1},"drawn_bbox":{"x":0,"y":639,"w":720,"h":1},"drawn_smaller_h_pct":0}
{"src":"4000x10","fit":"pad","fit_box":{"x":0,"y":639,"w":720,"h":2},"drawn_bbox":{"x":0,"y":639,"w":720,"h":2},"drawn_smaller_h_pct":0}
{"src":"333x777","fit":"pad","fit_box":{"x":85,"y":0,"w":549,"h":1280},"drawn_bbox":{"x":85,"y":0,"w":549,"h":1280},"drawn_smaller_h_pct":0}
```

Cơ chế: `plan/fit.js` tính `w = max(1, min(W, round(sw*scale)))` và `h = max(1, min(H, round(sh*scale)))` — **làm tròn độc lập hai trục**, nên với `1×1000` hộp thành `1×1280` (tỉ lệ 0,00078 ≠ 0,001 của nguồn); `encode/frames.js` không dùng thẳng hộp mà tính lại `contain = min(bw/sw, bh/sh) = 1` rồi **căn giữa trong hộp** ⇒ ảnh vẽ ra `1×1000`, thừa 140 px viền trên + 140 px dưới. Ảnh **không méo** (một hệ số phóng), nhưng `fit_box` trong `plan`/`plan_summary`/UI nói sai. Không thấy ở các tỉ lệ thường (333×777, 720×1280, 1280×720, 4000×10, 1000×1 đều khớp 0%).


---

## 3. Đã cố phá mà KHÔNG phá được

1. **GIF mở được thật + khớp pixel (không chỉ `inspectGif`)**: 191/195 file do repo ghi giải được bằng **bộ giải mã Python tự viết** (LZW LSB-first độc lập); 4 file hỏng đều là ca F5. Với các ca “màu điểm cố định của lượng tử hoá 5-bit”, pixel giải ra **GIỐNG HỆT** nguồn: 1 khung · 30 khung · **300 khung** · 1×1 · 2000×2000 (2 màu, 20.018 byte) · nhiễu 512×512 **buộc LZW đầy 4096 mã và reset 66 lần** · palette 2/3 màu · delay riêng từng khung (40/250/1000ms) · `loop=3`. `file`/`sips`/`magick identify` đọc đúng số khung/kích thước mọi ca. (`node gif-cases.mjs`, `python3 gifdec.py`)
2. **Sai số lượng tử hoá được khai TRUNG THỰC**: với gradient 256×256 → palette 4, sai số đo ngoài `22.3542` vs repo khai `22.35`; palette 3 → `32.0809` vs `32.08`; dither → `20.0055` vs `17.17` (đo sau dither, có giải thích trong mã). Cảnh báo bật đúng khi > 8/255 và **không** bật khi ≤ 8 (gradient 2000×2000: 3,87 → không cảnh báo). Alpha: cảnh báo “làm phẳng 3072 điểm ảnh…” đúng số, đúng màu nền khi gọi `encodeGif` trực tiếp (kể cả nền trắng).
3. **Không bóp méo** (đo bằng NỘI DUNG, không tin `fit_box`): 8 tỉ lệ nguồn cực đoan (1×1000, 1000×1, 1×1, 4000×10, 10×4000, 720×1280, 1280×720, 333×777) × {pad, crop}. Ở các tỉ lệ đo được bằng độ dốc gradient hai trục (333×777, 720×1280, 1280×720), `anisotropic_pct` ≤ **0,02%** ⇒ **không có chuyện kéo giãn một trục**; nội dung `pad` giữ đúng tỉ lệ nguồn (333×777 → 549×1280, lệch 0,08% do làm tròn pixel); `crop` phủ kín khung, không lộ viền; `motion` zoom/pan giữ nguyên hệ số phóng đều hai trục. Với nguồn dày 1–10 px (1×1000, 4000×10…), phép đo tỉ lệ bị chi phối bởi làm tròn 1–2 pixel (không kết luận được từ con số tỉ lệ) — nhưng pixel vẫn là phép lấy mẫu **một hệ số phóng** và `plan.fit_box` mới là thứ lệch (xem F10). (`node frames.mjs`, `node fitbox.mjs`)
4. **Số khung/delay/cắt trần**: 9 ca thời lượng (250ms, 500ms, 1000ms, 333ms, 84ms, 3×250ms, 2×20s, 30s) — `plan.frame_count == Σ scene.frames == frames render == frames GIF == công thức`, sàn 250ms và trần 30s được kẹp + ghi `warnings`, không bao giờ vượt trần (F6 chỉ là độ lệch nhịp 4%).
5. **Motion/fade thật**: `zoom-in`/`zoom-out` đổi 806.636/806.864 pixel giữa khung đầu và khung cuối; `pan-left`/`pan-right` đổi 810.000 pixel và dịch nội dung đúng chiều; mọi hiệu ứng giữ khung phủ kín (crop) — không lộ nền, không méo. `fade` pha trộn thật: `[255,0,0] → [202,0,53] → [149,0,106] → … → [0,0,255]`; cảnh cuối có khung và khung cuối nằm trong cảnh cuối (`last_frame_inside_last_scene=true`).
6. **Chống bịa phần lớn vẫn kín**: 29/37 biến thể bị 422 (chữ Hán/kana, homoglyph Kirin `һ`/`а`/`о`, full-width `ＩＳＯ`, không dấu `bao hanh`, zero-width `bảo\u200bhành`, `①②③`, `IP68`, `100%`, `số 1`, `bảo hành`…); mọi đường “bằng chứng giả trong request” bị chặn; `{content}/{value}/{label}`/số bị V1 chặn ở pipeline (job `failed`, **0 byte video**).
7. **Tiền đúng** (`node e2e-money.mjs`): 402 `INSUFFICIENT_CREDIT` **trước khi tạo job** (`jobs_created: 0`); usage chỉ cho bước chạy thật (encode fail ⇒ **không** có `VIDEO_ENCODE`, chỉ `VIDEO_RENDER`); **thu theo lượt** (chạy lại 3 lần ⇒ `run_key` #2/#3/#4, mỗi lượt −0,001 ⇒ balance 1,999 → 1,996); job lỗi ⇒ **hoàn tiền** (balance không đổi, `refunds_total=1`), job **không treo** `running` (`status=failed` + `finished_at`); 2 request generate đồng thời ⇒ 1×202 + **1×409 `JOB_ALREADY_RUNNING`**, không thu 2 lần cho 1 lượt; `settle == Σ usage.estimated_cost` từng lượt.
8. **IDOR**: session khác / **tài khoản khác** / ẩn danh ⇒ **404** cho `GET job`, `GET asset file` (cả ảnh gốc lẫn GIF), `POST generate`; chủ sở hữu ⇒ 200. (`node e2e-round6.mjs`, `node e2e-anon.mjs` A7)
9. **XSS tầng UI thật**: trích đúng hàm `public/app.js` (`vsRenderWarnings`, `vsRenderResult`, `vsTextBlockedPanel`, `vsFileErrorsHtml`, `vsErrorBox`, `esc`) như cách repo tự test, nhét 6 payload (`<img onerror>`, `"><script>`, `</li></ul><svg onload>`, `" onmouseover="`, `' onmouseover='`, `javascript:`) vào **mọi** trường máy chủ trả về (warnings, violations, error_message, error_code, tên tệp, tiêu đề chữ, provider, mime, id, ảnh `id` độc hại) ⇒ **0 payload vào được attribute/DOM**: `<` `>` `"` `'` đều thành entity, `id` được `encodeURIComponent`. (`node ui-xss.mjs`, `node ui-ctx.mjs`)
10. **Vận hành/DoS**: ảnh 20MP ⇒ 413 `IMAGE_TOO_LARGE`; **500 ảnh** ⇒ 413 `TOO_MANY_SCENES` trong **4ms**; 25 cảnh ⇒ 413; 61 `texts` ⇒ 413 `TOO_MANY_TEXTS`; 24 cảnh ⇒ 202; `texts` 10k ký tự ⇒ cắt còn 500 (F8 là chuyện summary); `planFrameCount` fail-closed với plan hỏng.
11. **Bảo mật đường dẫn/tệp**: `writeFrameSequence` từ chối `/tmp/.../outside`, `${root}/../outside2`, `${root}-khac` (⇒ `UNSAFE_PATH`) và `prefix='../evil'` (⇒ `BAD_INPUT`); không rò `storage_path`/`session_id` trong JSON job/asset; **ảnh gốc bất biến**: sha256 file trên đĩa y hệt trước/sau 3 lượt chạy, khớp sha trong DB, `parent_id` của asset `rendered` = ảnh gốc; `extraction_evidence` luôn `connector=videostudio`, `extraction_method=upload+video`, `verification=MANUAL_INPUT` (không bao giờ `LIVE_VERIFIED`).
12. **Prototype pollution**: `__proto__`/`constructor.prototype` ở `options`, `scenes[i]`, `texts[i]` ⇒ `({}).polluted*` đều `null`.
13. **“Không có tiếng” NÓI RÕ**: đường thành công có **đúng 1 câu** ở `data.warnings`, `plan.warnings`, `encode.warnings`, `last_run.warnings`, `asset.meta.warnings`, `content_meta.videostudio.warnings`; `audio: null` + `meta.no_audio: true` + `/api/config → videostudio.audio=false`; `dedupeWarnings` gộp 4 biến thể câu thành 1, danh sách rỗng vẫn trả 1 câu. Không có đường nào trả **video** mà thiếu câu này (F9 chỉ là danh sách rỗng ở đường job lỗi, nơi không có video).
14. **Hồi quy**: `npm test` → **914 test · 913 pass · 0 fail · 1 skipped**, EXIT=0 (baseline lúc tôi bắt đầu: 856 · 855 · 0 · 1 — 58 test tăng thêm là 8 file `test/mvp04-*` untracked xuất hiện giữa lúc phản biện); `node tools/verify.mjs` → **914 · 913 · 0 · 1**, EXIT=0; `node tools/imagelab-demo.mjs` → `succeeded`, EXIT=0; các bộ phản biện cũ `/tmp/atk5`, `/tmp/atk6`, `/tmp/atk-il08b`, `/tmp/mvp03-atk`, `/tmp/mvp05-atk4` → **27/28 script EXIT=0** (`node old-suites.mjs`). Script còn lại `/tmp/mvp05-atk4/v1-br08.mjs` fail ở mục “V1.4 RECONCILE LÚC BOOT” vì harness dùng **SQLite in-memory** rồi `app.close()` xong vẫn truy vấn (`Error: no such table: wallet_ledger`) — chính probe ghi chú “in-memory không restart được”; các mục trước đó của chính probe (401/403/200, hoàn tiền, idempotent) đều PASS, và diff MVP-04 không đụng `app.close`.

---

## 4. Chưa kiểm được (vì sao)

1. **Preview/QuickLook GUI thật**: `qlmanage -t` bị sandbox của phiên chặn (`sandbox initialization failed: Operation not permitted`). Đã thay bằng `sips` (cùng ImageIO như Preview) + `file` + ImageMagick + decoder Python tự viết. Chưa mở được bằng trình duyệt thật (Chrome/Safari) — chỉ suy ra từ việc 4 bộ giải mã độc lập đều đọc đủ khung.
2. **Provider `ffmpeg`/MP4**: máy không có `ffmpeg` (đúng như hợp đồng §0) nên chỉ đọc mã: `probe()` ⇒ `FFMPEG_NOT_AVAILABLE`, không ghi file rác, kẹp ghi trong `IMAGELAB_DIR` — **chưa đo được** chất lượng/độ dài MP4 thật.
3. **Postgres (`pg`)**: toàn bộ đo đạc chạy trên SQLite in-memory; chưa kiểm hành vi store/ledger/`listOcrRegions` trên PG (nhất là tính idempotent giữ tiền và `usageSummary` theo `run_key`).
4. **Bộ test MVP-04 mới (untracked)**: 8 file `test/mvp04-*` xuất hiện giữa lúc phản biện (mtime 01:03–01:11) — tôi chỉ chạy qua `npm test`/`verify.mjs`, **không đọc hết 58 ca**; đã grep thấy bộ này **không phủ** `CLAIM_PHRASES`/`fallbackViolations` (F1) và **không phủ** ngân sách `INSPECT_MAX_PIXELS`/video > 7s (F2).
5. **Tải đồng thời nhiều job video**: chưa đo nghẽn CPU khi nhiều job 6s chạy song song trên cùng tiến trình (một job 360 khung đã ngốn ~8,7s CPU; rate limit mặc định cho phép nhiều job/phiên).
6. **`inspectGif` trên GIF khổng lồ do client cung cấp**: API không có đường upload GIF, nên chỉ kiểm được qua hàm trực tiếp (trần `INSPECT_MAX_FRAMES=2000`, `INSPECT_MAX_PIXELS=64M` — chính là nguyên nhân F2).

---

# VÒNG 2 — chấm lại tại commit `023a711`

**PHÁN QUYẾT: FAIL** (hẹp — *một* lỗ hổng, nhưng đúng **lớp CRITICAL của vòng 1**: chữ khẳng định **không có bằng chứng vẫn được VẼ** lên video và job báo `succeeded`).

- Nhánh `feat/mvp04-videostudio` · commit `023a711` (người phản biện **mới**, độc lập; chấm 12:5x–13:3x ngày 07/10/2026) · **không sửa mã nguồn/`test/**`**; `git status --short` cuối phiên chỉ có `docs/MVP-04-REVIEW.md`.
- Script vòng 2: `/tmp/mvp04-atk3/**`; tái dùng decoder vòng 1 ở `/tmp/mvp04-atk/**`. Mọi kết luận dưới đây đo bằng **HTTP thật + pixel thật**, không tin `warnings`/lời khai.
- **Chứng minh "chuỗi nào đã được vẽ"**: mặt nạ pixel trắng khung 0 (hash chuẩn hoá, bất biến vị trí) đo bằng **decoder Python tự viết** (`gifdec2.py` — giải LZW *mọi* khung, chỉ tô khung đầu/cuối: 360 khung × 1280×720 = **331,8M điểm ảnh trong 1,7 giây**), rồi khớp với **vân tay mực** của từng ứng viên (`ink.mjs`, mọi scale 1..64). Hai decoder (vòng 1 và vòng 2) đã **đối chiếu khớp hash** trên 4 tệp.
- Điểm mấu chốt của bản vá: `collectViolations` nay là **HỢP** hai bộ (`pipeline.js:430-442`) — đúng như yêu cầu vòng 1 — nhưng **hai bộ dùng hai kiểu khớp khác nhau**, và đó là gốc của lỗ hổng còn lại (xem **N1**).

## B1. Bảng F1…F10

| # | Mức vòng 1 | Trạng thái vòng 2 | Bằng chứng (1 dòng) |
|---|---|---|---|
| **F1** | CRITICAL | **VÁ ĐÚNG CƠ CHẾ — NHƯNG CHƯA KÍN (⇒ N1 CRITICAL)** | 19/19 từ khoá `CLAIM_PHRASES` **nguyên bản có dấu** ⇒ **422** cả hai endpoint, 0 pixel (`node claims-rig.mjs` → `A_nguyen_ban n=19 422=19 drawn=0`); nhưng **11/12 bản KHÔNG DẤU**, **6/6 homoglyph**, **3/4 full-width**, **2/6 ký tự vô hình** ⇒ **202 + succeeded + chữ được VẼ** (11.319–41.454 px, khớp vân tay mực) |
| **F2** | MAJOR | **VÁ THẬT** | `node f2-verify.mjs`: 30s ở **cả 3 preset** ⇒ 202, `succeeded`, **360 khung**, 331.776.000 điểm ảnh (1:1 = 291.600.000); `file`=GIF89a đúng cỡ · `sips` · `magick` 360 khung · **decoder Python nghiêm ngặt 360/360 khung, không lỗi** |
| **F3** | MAJOR | **VÁ THẬT** | `node f3-alpha.mjs`: trong suốt hoàn toàn ⇒ cảnh báo `120000/120000 … LÀM PHẲNG lên màu nền #00ff00`, khung 0 = **810.000 px đúng #00FF00**; bán trong suốt ⇒ `70000/120000` + `#ff00ff` (đo `p(5,5)=[255,0,255]`); “đầu ra MVP-03” (`eraseBox` → alpha=0) ⇒ `76800/76800` + `#ffffff` |
| **F4** | MINOR | **VÁ THEO THOẢ THUẬN (vòng bằng chứng vẫn mở, nay khai rõ nguồn)** | `node f4-loop.mjs`: `PUT /api/jobs/:id/content {product_name:"…miễn phí vận chuyển…"}` rồi generate `"miễn phí vận chuyển"` ⇒ 202 + `succeeded` + `evidence_used:{sources:["product_name"],chars:44}` |
| **F5** | MINOR | **VÁ THẬT** | `node f5f10.mjs`: khung đơn sắc 1·2·4·8·16·32·64·128·256 ⇒ `inspect_valid=true`, `magick` đọc được, **decoder Python nghiêm ngặt chấp nhận 100%** (8×8 = 67 byte, trước đây cả repo lẫn Python đều từ chối) |
| **F6** | MINOR | **VÁ MỘT NỬA** | Có cảnh báo thật: `"Nhịp phát THẬT của GIF là 0.96s (khai báo 1.00s; lệch -0.04s)"`; **nhưng** `encode.playback_ms = requested_ms = delay_drift_ms = null` (`node f6-idor.mjs`) ⇒ UI không đọc được bằng máy |
| **F7** | MINOR | **VÁ THẬT** | `node shapes-fix.mjs`: **15/17 dạng field ⇒ 422** (`texts:[str]`, `text`, `title`, `subtitle`, `price`, `cta`, `scene.*`, `{label}`, `{value}`, object kèm style…), **0 ca "202 rồi failed"**, đối chứng lành ⇒ 202 + vẽ đúng 12.288 px; `node generate-endpoint.mjs` ⇒ 6/6 dạng ⇒ 422, `late_fail=[]` |
| **F8** | MINOR | **VÁ THẬT** | `node f8-meta.mjs`: chữ 800 ký tự ⇒ video vẽ **500**, `content_meta.videostudio.plan_summary.scenes[0].texts[0].text.length = 500` (hết cắt 300) |
| **F9** | MINOR | **VÁ THẬT** | `node f6-idor.mjs`: job `failed` (`UNKNOWN_PRESET`) ⇒ `data.warnings` **không còn rỗng**, có câu "Video KHÔNG có tiếng…" + cảnh báo pad/nhịp phát |
| **F10** | MINOR | **VÁ THẬT** | `node f5f10.mjs`: `1×1000` `fit_box={359,140,1,1000}` = **bbox vẽ thật** `[359,140,1,1000]` (delta 0); `1000×1`, `1×1`, `4000×10` delta **0** cả 4 cạnh (trước: lệch 21,88%) |
| **F-thứ tự cảnh** | (agent test báo) | **VÁ THẬT** | `node f5f10.mjs`: 3 ảnh lưu **cùng mili-giây** (`created_at` 13.158Z ×2), store trả **SAI** thứ tự (`store_order_matches_sent=false`) nhưng `plan.scenes[].asset_id` **đúng thứ tự gửi** và **màu tâm khung** = `[[255,0,0],[0,255,0],[0,0,255]]`; đảo chiều gửi ⇒ vẫn đúng |

**Hồi quy (tự đo)**: `npm test` → **929 · 928 pass · 0 fail · 1 skipped**, EXIT=0; `node tools/verify.mjs` → **929 · 928 · 0 · 1**, EXIT=0; ảnh gốc **bất biến** (sha256 file = sha trong DB trước/sau 2 lượt: `0fd335ccb14ef8b8…`, `same=true`); tiền: 402 `INSUFFICIENT_CREDIT` với `jobs_created=0`, usage theo bước `VIDEO_RENDER:0.0006 + VIDEO_ENCODE:0.0004`, **thu theo lượt** (`#1` → `#2`, ledger 4,999 → 4,998); IDOR: job/GIF/ảnh gốc của phiên khác ⇒ **404**, chủ sở hữu ⇒ 200 (`image/png 219B`, `image/gif 6.555B`).

## B2. Lỗ hổng mới

### N1 (CRITICAL) — Bộ dự phòng V3 khớp **THÔ**, nên mọi cách viết "lạ" của 13 từ khoá V3-only vẫn được vẽ

**Cơ chế (đọc mã)**: `pipeline.js:365-388` so khớp bằng `const lower = value.toLowerCase().normalize('NFC')` rồi `lower.includes(phrase)` — **không** khử dấu, **không** NFKC/full-width, **không** gộp homoglyph, **không** bỏ ký tự vô hình. Bộ của V1 (`guardrails.normalizeForMatch` + `deaccent` + `foldHomoglyphs`) *có* làm những việc đó, nhưng **danh sách của V1 không chứa 13 từ khoá V3-only** (`miễn phí`, `giá rẻ nhất`, `uy tín`, `hàng đầu`, `nguyên seal`, `khuyến mãi`…). HỢP hai bộ vì thế chỉ mở rộng **độ phủ**, không mở rộng **độ chuẩn hoá** ⇒ cả hai bộ đều "mù" với chính những từ đó khi viết khác đi.

```
$ cd /tmp/mvp04-atk3 && node probe-claims.mjs
{"test":"P2_BIEN_THE","rows":[{"t":"\"miễn phí\"","V1":1,"V3":1,"drawn":false},
 {"t":"\"mien phi\"","V1":0,"V3":0,"drawn":true},{"t":"\"ｍｉễｎ ｐｈí\"","V1":0,"V3":0,"drawn":true}, …]}
```

**Đo qua HTTP + PIXEL (không tin `warnings`)** — `/tmp/mvp04-atk3/claims-rig.mjs` (98 ca) và `generate-endpoint.mjs` (12 ca):

```
{"id":"v_b0_miễn phí","group":"B_khong_dau","http":202,"job":"succeeded","white":27540,
 "ink_candidates":["\"mien phi\"@scale18(27540px)"],"verdict":"CHỮ ĐÃ ĐƯỢC VẼ (khớp vân tay mực)"}
{"id":"v_c0_Cyrillic і","text":"miễn phі","http":202,"job":"succeeded","white":26892, "ink":"miễn phі@18"}
{"id":"v_d0_full-width","text":"ｍｉễｎ ｐｈí","http":202,"job":"succeeded","white":10368, "ink":"ｍｉễｎ ｐｈí@18"}
{"id":"v_e2_xuống dòng","text":"miễn\nphí","http":202,"job":"succeeded","white":41454}
{"label":"KHÔNG DẤU","http":202,"job":"succeeded","white":9555,"ink":"\"mien phi van chuyen\"@7"}   ← endpoint /generate
```

Tổng: **22 ca LỌT có bằng chứng pixel** trong bộ 98 ca ở `/jobs` (11 không dấu: `mien phi`, `gia re nhat`, `uy tin`, `nguyen seal`, `khuyen mai`, `hang dau thi truong`, `chat luong cao`, `nhap khau chinh ngach`, `duy nhat hom nay`, `dam bao chat luong`, `giam gia soc` · 6 homoglyph: Cyrillic і/е/о/у/а + Kirin һ · 3 full-width · 2 xuống dòng/CR) **+ 5 ca nữa ở `/generate`** (2 không dấu · 1 homoglyph · 1 full-width · 1 xuống dòng) — **tất cả** `succeeded` + chữ được vẽ, **0 ca** `failed`/0 byte. (Ba ca `{text lành, label bịa}` cũng ra 202 nhưng vân tay chứng minh chữ được vẽ là `"ok"` — **không** phải rò, xem mục B3.)

**Vì sao vẫn CRITICAL**: đây đúng là luật riêng #3 (§0) và đúng lớp lỗi vòng 1, chỉ đổi *cách viết*. "mien phi van chuyen" là kiểu gõ phổ biến nhất của người bán Việt Nam; video vẫn ra `succeeded` và hệ thống vẫn ngầm khẳng định "đã kiểm chống bịa". **Gợi ý sửa (1 dòng)**: cho `fallbackViolations` so khớp qua `deaccent(normalizeForMatch(text))` với `deaccent(normalizeForMatch(phrase))` (dùng lại `guardrails.js` — đừng viết bộ chuẩn hoá thứ hai), rồi thêm test HTTP cho **từng** từ khoá × {có dấu, không dấu, homoglyph, full-width, `\n`}.

### N2 (MINOR) — Nhịp phát thật chỉ có ở câu cảnh báo, trường máy đọc luôn `null` (F6 vá nửa)
`node f6-idor.mjs` → `encode_keys` **có** `playback_ms, requested_ms, delay_drift_ms` nhưng cả ba `= null`; con số thật (0.96s vs 1.00s) chỉ nằm trong chuỗi `warnings`. UI muốn hiện "video dài thật X giây" thì phải parse chuỗi tiếng Việt.

### N3 (MINOR) — `texts` **mảng lồng** bị bỏ IM LẶNG
`node shapes-fix.mjs` → `scene.texts=[[str]] lồng`: **202 + `succeeded` + 0 px chữ**, không cảnh báo, không 422. Chữ người dùng gửi biến mất không dấu vết (fail-silent, khác fail-closed).

### N4 (MINOR) — Đối chứng "40s" không bị CHẶN SỚM, mà bị KẸP còn 30s (khác kỳ vọng vòng 1, nhưng không còn báo sai)
`node f2-verify.mjs` → `over_40s_2x20`: **202**, `succeeded`, `duration_ms=30000`, cảnh báo nguyên văn *"Tổng thời lượng yêu cầu 40000ms vượt trần 30000ms của preset “ngang-16x9” — đã cắt 10000ms (cảnh #1 rút 20000ms → 10000ms)"*. **Không** còn `VIDEO_GIF_INVALID` cho GIF hợp lệ (đúng yêu cầu), nhưng nếu hợp đồng muốn "báo lỗi mã đúng nghĩa" thì hiện chưa có mã đó — cần chốt lại bằng chữ trong §2.1.

## B3. Đã cố phá mà KHÔNG phá được (vòng 2)

1. **F1 phần lõi**: 19/19 từ khoá `CLAIM_PHRASES` nguyên bản ⇒ **422** ở **cả** hai endpoint (trong **127 ca HTTP** của vòng 2 — 98 + 17 + 12 — **không còn một ca `202 → job failed`** nào). Không tìm được **bất kỳ** đường nào vẽ được từ khoá *có dấu* khi bằng chứng rỗng.
2. **"Chữ lành + chữ bịa trong cùng một mục"**: `{text:"ok", label:"miễn phí vận chuyển"}`, `{content:"ok", value:"…"}`, `{text:"ok", content:"…"}` ⇒ 202 nhưng **vân tay mực chứng minh chỉ `"ok"` được vẽ** (13.824 px = `"ok"@24`) — V1 đọc theo đúng thứ tự `text ?? content ?? label ?? value`, không có khe hở thứ tự khoá.
3. **Bằng chứng tự khai**: `options.evidence`, `options.notes`, `item.source_text/evidence` ⇒ **422** (không dùng làm bằng chứng).
4. **F2**: 30s ở 3 preset, 4 đường kiểm độc lập đều đọc đủ **360 khung**, tổng điểm ảnh khớp công thức (331.776.000 / 291.600.000), GIF đúng 89a; ≈0,55–0,59 MB (550.479–592.599 byte).
5. **F3**: số alpha + **màu nền đã dùng** trong cảnh báo khớp **từng pixel** với GIF (đo độc lập ở 5 toạ độ/khung).
6. **F5**: toàn bộ mốc `2^k` (1…256) qua được **cả** `inspectGif` **và** decoder nghiêm ngặt; không tái hiện được biên EOI thiếu bit.
7. **F10**: 4 ảnh cực mảnh (`1×1000`, `1000×1`, `1×1`, `4000×10`) — `fit_box` **khớp bbox vẽ thật tới 0 px**; nội dung vẫn không méo.
8. **Thứ tự cảnh**: 3 ảnh lưu **cùng mili-giây** + store trả sai thứ tự ⇒ plan **và pixel** vẫn đúng thứ tự gửi (2 chiều, 9 khung/ca).
9. **Tiền/IDOR/usage**: 402 trước khi tạo job (`jobs_created=0`); usage đúng bước chạy thật; thu theo lượt; IDOR 404 cho job/GIF/ảnh gốc; ảnh gốc bất biến (sha trùng DB).
10. **Hồi quy**: `npm test` 929 · 928 · 0 · 1 EXIT=0; `verify.mjs` y hệt; `git status` sạch (chỉ báo cáo này được ghi).

## B4. Chưa kiểm được (vòng 2)

1. **Không có tiếng**: vẫn chỉ đọc được `audio: null` + cảnh báo; **chưa** đo được tiếng thật (không có TTS/ffmpeg).
2. **MP4/ffmpeg**: máy không có `ffmpeg` ⇒ chưa đo chất lượng/độ dài MP4 (đúng như hợp đồng §0).
3. **GIF 256 màu**: mọi phép đo pixel dùng GIF đã lượng tử hoá; chưa đo bản màu đầy đủ/MP4.
4. **UI trên trình duyệt thật**: chưa mở Chrome/Safari; chỉ suy ra từ 4 bộ giải mã + `file`/`sips`/`magick`.
5. **Nhịp phát thật**: chỉ đo được `Σ delay` của GIF (`magick` = 28.800ms cho video khai 30.000ms) — **chưa** đo cảm nhận phát trên trình duyệt/điện thoại; trường `playback_ms` còn `null` (N2).
6. **Postgres**: toàn bộ chạy SQLite in-memory.
7. **Tải đồng thời**: chưa đo nhiều job 30s chạy song song (một job 30s ≈ 10 giây CPU) — chỉ chạy tuần tự theo đúng cảnh báo của người điều phối.

## B5. Nếu N1 được vá thì "PASS" sẽ nghĩa là gì

PASS sẽ **chỉ** có nghĩa: (a) mọi biến thể trong danh sách từ khoá — kể cả viết không dấu/homoglyph/full-width/xuống dòng — không được vẽ khi thiếu bằng chứng; (b) video 30s ở cả 3 preset tạo được và mở được bằng 4 bộ giải mã độc lập; (c) cảnh báo alpha/fit_box/thứ tự cảnh khớp pixel thật; (d) 929 test xanh. PASS **KHÔNG** có nghĩa: video có tiếng, MP4/ffmpeg đã đo, chất lượng màu đã kiểm ngoài GIF 256 màu, UI đã kiểm trên trình duyệt thật, nhịp phát thật khớp tuyệt đối (vẫn lệch ~4% do GIF làm tròn delay 10ms), hay hàng rào chống bịa là "kín tuyệt đối" trước mọi cách viết sáng tạo khác.

---

# VÒNG 3 — xác nhận tại commit `0809931`

**PHÁN QUYẾT CUỐI: PASS CÓ ĐIỀU KIỆN.**

N1 (lỗ hổng CRITICAL của vòng 2 — chữ khẳng định **viết không dấu / homoglyph / full-width / xuống dòng vẫn được VẼ**) **đã KÍN thật** với mọi cách viết thường gặp: rig vòng 2 chạy lại trên commit mới cho `leaks: []` (98 ca, 74 × 422, 0 ca `202 → failed`), 24 ca tấn công mới đều bị chặn hoặc không vẽ pixel nào, `/generate` 11/12 × 422 + 0 chữ bịa được vẽ, đối chứng dương vẫn 202 + vẽ đúng. **Nhưng** vẫn còn **2 họ biến thể ĐỐI KHÁNG** vẽ được chữ bịa (6 ca đo bằng pixel + vân tay mực) và **2 điểm chưa kín khác** (N3 im lặng, N2 trường máy đọc `null`) ⇒ **có điều kiện**, không phải PASS sạch.

- Commit `0809931` (nhánh `feat/mvp04-videostudio`) · người chấm **độc lập**, **không sửa mã nguồn/`test/**`**; `git status --short` cuối phiên: chỉ `docs/MVP-04-REVIEW.md`.
- Script vòng 3: `/tmp/mvp04-atk4/**` (dùng lại decoder độc lập `gifdec2.py` + rig `/tmp/mvp04-atk3/**`). Mọi ca "lọt" đều được **đo pixel khung 0 bằng decoder Python tự viết** và **khớp vân tay mực** (`ink.mjs`) để biết CHÍNH XÁC chuỗi nào đã được vẽ.
- Bản vá tự kiểm: `fallbackViolations` nay `deaccent(normalizeForMatch(...))` cho **cả** câu chữ **và** bằng chứng (`pipeline.js:368-380`); bộ gom chữ của preflight **đệ quy** mọi mảng/object lồng (`routes.js` — `videostudioTextValueOf`).

## C1. Bảng N1…N4 + F1…F10 (trạng thái cuối)

| # | Trạng thái vòng 3 | Bằng chứng (1 dòng) |
|---|---|---|
| **N1** | **ĐÃ KÍN phần chính — CÒN 2 HỌ BIẾN THỂ ĐỐI KHÁNG (⇒ điều kiện 1 & 2)** | `node claims-rig.mjs` → `{"total":98,"http_422":74,"late_fail_202":[],"leaks":[]}`, đối chứng `benign` 202 + 12.288 px, `notext` 0 px; `node attack3.mjs` → 24 ca: 14 × 422 + 8 ca 0 px + 1 × 400 + **2 ca vẽ chữ bịa**; `node generate-endpoint.mjs` → 11/12 × 422, `drawn_claim: []`, đối chứng lành 202 + 12.288 px |
| **N2** | **CHƯA VÁ** | `node f6-idor.mjs` → `encode.playback_ms = requested_ms = delay_drift_ms = null`; con số thật chỉ nằm trong chuỗi cảnh báo `"Nhịp phát THẬT của GIF là 0.96s (khai báo 1.00s; lệch -0.04s)"` |
| **N3** | **VÁ MỘT NỬA** | Đã 422: `texts=[{text:["khuyen mai soc"]}]`, `scene.texts=[{text:["uy tin"]}]`; **vẫn im lặng**: `texts=[["mien phi van chuyen"]]` và `[[["gia re nhat"]]]` ⇒ 202 + `succeeded` + **0 px + 0 text + 0 cảnh báo** (sanitize bỏ mảng trước preflight). Thêm: `{text:{label:"nguyen seal"}}` ⇒ 202 + vẽ **"[object Object]" 17.400 px** (cảnh báo của repo ghi đúng chuỗi đó) |
| **N4** | **ĐẠT** (kẹp + cảnh báo là hợp lý) | `node n3n4.mjs`: yêu cầu 40s ⇒ 202, `succeeded`, `plan.duration_ms = 30000`, cảnh báo nguyên văn *"Tổng thời lượng yêu cầu 40000ms vượt trần 30000ms … đã cắt 10000ms"*; GIF **360 khung 1280×720** hợp lệ, `playback 28.800ms`, không còn `VIDEO_GIF_INVALID` sai. §2.1 chỉ buộc "tổng ≤ trần preset" ⇒ kẹp + cảnh báo là **đúng hợp đồng**; muốn "chặn bằng mã" thì phải sửa hợp đồng trước |
| **F1** | ĐÃ VÁ (như vòng 2) + N1 nay kín phần thường gặp | 19/19 từ khoá gốc ⇒ 422; không dấu (`mien phi`), Cyrillic, full-width, tab/CRLF/nhiều dòng/ZWJ/U+2060/BOM/NBSP, HOA, `１９９`, `①②③` ⇒ **đều 422** |
| **F2** | ĐÃ VÁ (kiểm lại) | `node recheck.mjs`: 30s 16:9 ⇒ 202/`succeeded`/360 khung/`pixels_total 331.776.000`/592.599 B/`playback 28.800ms`; `file`+`sips`+`magick` 360 khung + hash luồng RGB `efbd382e65448b7a` (trùng vòng 2) |
| **F3** | ĐÃ VÁ (kiểm lại) | `recheck.mjs`: PNG trong suốt toàn phần ⇒ cảnh báo `120000/120000 … LÀM PHẲNG lên màu nền #00FF00`, khung 0 = **810.000 px đúng `[0,255,0]`** |
| **F4** | ĐÃ VÁ theo thoả thuận | `evidence_used.sources:["product_name"]` + `chars` (vòng bằng chứng vẫn mở đúng như hợp đồng, nay khai rõ nguồn) |
| **F5** | ĐÃ VÁ (kiểm lại) | `recheck.mjs`: khung 8×8 (67 B) · 64×64 (129 B) · 256×256 (411 B) ⇒ `inspectGif.valid=true` + decoder Python nghiêm ngặt chấp nhận |
| **F6** | VÁ MỘT NỬA (= N2) | Cảnh báo nhịp phát thật ĐÚNG và có mặt ở mọi đường; trường máy đọc vẫn `null` |
| **F7** | ĐÃ VÁ (như vòng 2 + mạnh hơn) | 15/17 dạng field ⇒ 422; thêm đệ quy: `{text:['…']}`, mảng lồng trong object ⇒ 422; `0` ca `202 → failed` |
| **F8** | ĐÃ VÁ | chữ 800 ký tự ⇒ vẽ 500, `plan_summary` cũng 500 |
| **F9** | ĐÃ VÁ | job `failed` ⇒ `data.warnings` 4 câu (có câu không-tiếng) |
| **F10** | ĐÃ VÁ (kiểm lại) | `recheck.mjs`: `fit_box={359,140,1,1000}` = **bbox vẽ thật `[359,140,1,1000]`** |
| **Thứ tự cảnh** | ĐÃ VÁ (kiểm lại) | `node tt-order.mjs`: 3 ảnh lưu cùng/khác mili-giây (2 ảnh trùng `…02.618Z`), gửi NGƯỢC ⇒ `plan_order_matches_sent=true` và **màu tâm khung** `[[0,0,255],[0,255,0],[255,0,0]]` = đúng thứ tự gửi |

**Hồi quy tự đo**: `npm test` → **929 · 928 pass · 0 fail · 1 skipped**, EXIT=0; `node tools/verify.mjs` → **929 · 928 · 0 · 1**, EXIT=0; ảnh gốc **bất biến** (`sha_before = sha_after = db_sha = 0fd335ccb14ef8b8…`); 402 `INSUFFICIENT_CREDIT` với `jobs_created=0`; usage theo bước (`VIDEO_RENDER:0.0006` + `VIDEO_ENCODE:0.0004`); **thu theo lượt** (`#1` → `#2`, ledger 4,999 → 4,998); IDOR: job/GIF/ảnh gốc ⇒ **404** cho phiên khác, chủ sở hữu 200 (`image/png 219B`, `image/gif 6.555B`).

## C2. Lỗ hổng CÒN LẠI (2 họ, 6 ca đo được) — điều kiện để PASS sạch

**Họ 1 — homoglyph GREEK chưa nằm trong bảng gộp** (Cyrillic đã kín; Greek thì chưa):

```
{"label":"Greek ο","text":"miễn phοí","http":202,"job":"succeeded","white":24064,"ink":"\"miễn phοí\"@16"}
{"label":"Greek μ","text":"μιễn phí","http":202,"job":"succeeded","white":22680,"ink":"\"μιễn phí\"@18"}
{"label":"Greek ν","text":"giảm ν giá","http":202,"job":"succeeded","white":22050,"ink":"\"giảm ν giá\"@15"}
```
(`ρ` và `ί` **đã** được xử lý → 422; lỗ nằm đúng ở vài codepoint Greek còn thiếu trong `foldHomoglyphs`.)

**Họ 2 — "số" ngoài `\p{Nd}` mà luật số liệu không bắt** (½, ², ①②③, ¹⁹⁹, ١٩٩, १९९ **đều bị chặn**, nhưng `\p{Nl}`/`№` thì lọt):

```
{"label":"La Mã Ⅰ","text":"sản phẩm Ⅰ","http":202,"job":"succeeded","white":23175,"ink":"\"sản phẩm Ⅰ\"@15"}
{"label":"La Mã Ⅻ","text":"top Ⅻ","http":202,"job":"succeeded","white":20736}
{"label":"№","text":"№ một","http":202,"job":"succeeded","white":25344}
```
`guardrails.js` **đã có sẵn** luật cho `\p{No}`/`\p{Nl}`/`№` (dùng cho đường dịch) — bộ dự phòng của V3 chỉ cần dùng lại. **Gợi ý vá 1 dòng**: thêm Greek vào `foldHomoglyphs` + coi `\p{Nl}|\p{No}|№` là số liệu trong `fallbackViolations`.

## C3. Chặn oan (false positive) — 1 ca do bản vá, 1 ca có sẵn

- **MỚI (do bản vá)**: `"Suy tin hieu camera"` ⇒ **422** — tách bộ cho thấy `V3 = 1, V1 = 0`: chuẩn hoá mới khớp **chuỗi con** `"uy tin"` nằm trong `"suy tin"`. Đây là giá của việc khử dấu + so chuỗi con không biên từ (trước vá V3 không bắt câu này). Khuyến nghị: biên từ (`\b`) cho các needle một-từ.
- **CÓ SẴN (không do bản vá)**: `"Also mot chiec ao"` ⇒ **422** với `V1 = 1, V3 = 0` (nhóm "số 1" của guardrails khớp `"so mot"`).
- **Đối chứng dương vẫn đúng** (không chặn oan hàng loạt): 5/7 câu lành ⇒ 202 + **được vẽ**: `"Ao thun nam cotton"` 12.288 px · `"Giay sneaker trang"` 13.056 px · `"Tui xach da bo"` 13.800 px · `"Mien thue va phi van chuyen"` 6.825 px · `"Nguyen lieu vai cao cap"` 8.424 px (vân tay mực khớp từng câu).

## C4. Đã cố phá mà KHÔNG phá được (vòng 3)

1. **N1 toàn bộ biến thể thường gặp**: rig 98 ca + 24 ca mới — không dấu, Cyrillic (а/е/і/о/у/һ/ѕ), full-width (kể cả số `１９９`), HOA, tab/CRLF/3 dòng, ZWJ/U+2060/BOM/NBSP, `①②③`, `½`, `²`, `¹⁹⁹`, chữ số Ả Rập-Ấn/Devanagari, nhiều khoá trong 1 mục, object lồng, mảng trong object, `scene.texts[i].label` ⇒ **422 hết**.
2. **Không có ca nào "202 rồi job failed"** (0/127+ ca) — preflight nay rộng hơn hoặc bằng thứ được vẽ.
3. **Đối chứng dương**: chữ lành vẫn 202 **và được vẽ** cả ở `/jobs` lẫn `/generate` (12.288 px, vân tay khớp) ⇒ không "chặn bừa cho chắc".
4. **N4**: 40s bị kẹp còn 30s kèm cảnh báo, GIF 360 khung hợp lệ — không còn lỗi sai kiểu `VIDEO_GIF_INVALID`.
5. **Hồi quy**: `npm test` 929/928/0/1 · `verify.mjs` y hệt · ảnh gốc bất biến · tiền/usage/hoàn tiền theo lượt · IDOR 404/200 · F2/F3/F5/F10/thứ tự cảnh kiểm lại bằng pixel.

## C5. Chưa kiểm được (vòng 3)

1. **Tiếng**: không có TTS/ffmpeg ⇒ chỉ đọc được `audio: null` + cảnh báo; **chưa** đo tiếng thật.
2. **MP4/ffmpeg**: máy không có `ffmpeg` ⇒ chưa đo chất lượng/độ dài MP4.
3. **GIF 256 màu**: mọi phép đo pixel là trên GIF đã lượng tử hoá (palette 2–256 màu).
4. **UI trình duyệt thật**: chưa mở Chrome/Safari; chỉ suy ra từ 4 bộ giải mã (`file`/`sips`/`magick`/Python).
5. **Nhịp phát thật**: chỉ đo `Σ delay` trong GIF (28.800ms cho video khai 30.000ms ≈ −4%); chưa đo cảm nhận phát thật trên thiết bị.
6. **Postgres** (toàn bộ chạy SQLite in-memory) và **nhiều job 30s song song** (một job ≈ 10 giây CPU; chỉ chạy tuần tự).
7. **Bằng chứng "vòng"**: người dùng vẫn tự khai được `product_name`/ghi chú rồi lấy đó làm bằng chứng (đã ghi rõ trong hợp đồng, `evidence_used.sources` nói ra nguồn) — **chưa** kiểm được hành vi người dùng thật.

## C6. PASS CÓ ĐIỀU KIỆN nghĩa là gì — và KHÔNG nghĩa là gì

**Nghĩa là**: với mọi cách viết mà người dùng thật có thể gõ (kể cả không dấu, HOA, full-width, dán ký tự vô hình), chữ khẳng định/số liệu thiếu bằng chứng **không được vẽ**, đã đo bằng pixel trên 120+ ca; video 30s ở cả 3 preset tạo được và mở được bằng 4 bộ giải mã độc lập; cảnh báo alpha/`fit_box`/thứ tự cảnh khớp pixel thật; tiền/IDOR/quyền sở hữu/ảnh gốc bất biến đúng; 929 test xanh. **Điều kiện kèm theo**: (1) vá homoglyph Greek, (2) vá số `\p{Nl}`/`\p{No}`/`№`, (3) xử lý N3 (mảng lồng bị bỏ im lặng + `[object Object]`), (4) bổ sung trường `playback_ms` thật (N2) — cả bốn đều đã có bằng chứng đo được trong mục C2/C3.

**KHÔNG nghĩa là**: (a) hàng rào chống bịa là **kín tuyệt đối** — đây là danh sách từ khoá + luật số, vẫn còn 6 ca đối kháng vẽ được chữ bịa (C2) và vẫn có thể chặn oan vài câu chứa chuỗi con (C3); (b) video có tiếng — bản offline là GIF **không tiếng**, mọi kết quả đều mang `audio: null`; (c) MP4/ffmpeg đã đo — chưa từng chạy; (d) chất lượng màu đã kiểm ngoài GIF 256 màu; (e) UI đã kiểm trên trình duyệt thật; (f) nhịp phát khớp tuyệt đối — vẫn lệch ~4% vì GIF chỉ ghi delay bội số 10ms; (g) bằng chứng là "khách quan" — bằng chứng = **dữ liệu người dùng đã lưu** (tên sản phẩm, ghi chú, vùng chữ nhập tay), nên người dùng vẫn có thể tự khai rồi tự vẽ (đã ghi trong hợp đồng, có `evidence_used.sources` để truy vết).

---

# VÒNG 4 — xác nhận chốt tại commit `5a53da0`

**PHÁN QUYẾT CUỐI: FAIL** (hẹp — 2/5 mục người điều phối khai đã vá **không hoạt động**, 1 mục vá nửa, và **17 ca chữ bịa mới vẫn được VẼ**).

Hai họ biến thể của vòng 3 **đã kín thật** (Hy Lạp/Cyrillic, số `\p{No}`/`\p{Nl}`/`№`) — 6/6 ca vòng 3 nay **422** và 6 biến thể Hy Lạp/Cyrillic mới cũng bị chặn. Nhưng: **(a) N2 và N3 mà người điều phối khai đã vá thì đo ra CHƯA** (số nhịp phát vẫn `null`; `{text:{label}}` vẫn vẽ `[object Object]` 17.400 px), **(b) 1 ca chặn oan vẫn còn**, **(c) bộ kiểm từ khoá vẫn hở trước dấu câu/dính chữ/lookalike Latin** ⇒ tiêu chí của chính vòng này ("không ca nào vẽ được chữ bịa, false positive cũng là lỗi") **không đạt**.

- Commit `5a53da0` · người chấm **độc lập**, **không sửa mã nguồn/`test/**`**; `git status --short` cuối phiên: chỉ `docs/MVP-04-REVIEW.md`.
- Script vòng 4: `/tmp/mvp04-atk5/**` (`attack4.mjs`, `probe4.mjs`, `punct.mjs`, `extra.mjs` + decoder Python độc lập `gifmask.py`/`gifdec2.py` + vân tay mực `ink.mjs`).
- Tự chạy lại rig vòng 2 trên commit này: `{"total":98,"http_422":74,"late_fail_202":[],"leaks":[]}`, đối chứng `benign` 202 + 12.288 px, `notext` 0 px — **khớp** lời khai của người điều phối.

## D1. Bảng N1/N2/N3 + F1…F10

| # | Trạng thái vòng 4 | Bằng chứng (1 dòng) |
|---|---|---|
| **N1** | **2 họ vòng 3: ĐÃ KÍN. Nhưng phát sinh 3 họ mới (⇒ FAIL)** | Đã kín: `miễn phοí` · `μιễn phí` · `giảm ν giá` · `sản phẩm Ⅰ` · `top Ⅻ` · `№ một` ⇒ **422** cả 6; thêm `miễn βhí`, `giảm θ giá`, `uy tín ω`, `ΜΙỄΝ ΡΗÍ`, `miễn phí cho mọі người`, `Nguуên ѕeal`, `top Ⅷ`, `№ mot`, ZWJ, BOM+ZWSP ⇒ **422**. **Nhưng 17 ca mới vẫn 202 + `succeeded` + chữ được VẼ** (xem D2) |
| **N2** | **CHƯA VÁ (lời khai sai)** | `encode.playback_ms = requested_ms = delay_drift_ms = null` ở `data.encode` **và** `last_run.encode`; đo in-process: `encodeGif()` trả `{playback_ms:960, requested_ms:996, delay_drift_ms:3}` nhưng kết quả provider chỉ còn `[…,"warnings","elapsed_ms","error_code"]` ⇒ **`createEncodeResult()` (encoder.js:82) không copy 3 field** dù `ENCODE_RESULT_FIELDS` đã thêm tên |
| **N3** | **CHƯA VÁ (lời khai sai)** | `{text:{label:"nguyen seal"}}` ⇒ 202 + vẽ **`[object Object]` 17.400 px** (vân tay mực khớp; cảnh báo của repo ghi đúng chuỗi đó). Nguyên nhân: `sanitizeText({label:…})` = `"[object Object]"` (đo trực tiếp) — sanitize ở route biến object thành chuỗi TRƯỚC khi `plan/texts.js` kịp từ chối. `texts=[[str]]` / `[[[str]]]` ⇒ 202 + 0 px nhưng **không một cảnh báo** nào nói chữ đã bị bỏ |
| **Chặn oan** | **CÒN 1/2** | `"Suy tin hieu camera"` ⇒ 202 + **vẽ 9.702 px** ✔ (hết oan); `"Also mot chiec ao"` ⇒ **vẫn 422** — tách bộ: `V3=0, V1=1` với thông báo *"Khẳng định “so mot” (nhóm số 1) không có trong chữ gốc"* (regex của `guardrails.js` không có ranh giới từ; `"Also, mot chiec ao"` có dấu phẩy thì **qua**) |
| **F1** | ĐÃ VÁ (giữ) | 19/19 từ khoá gốc ⇒ 422; không dấu/Cyrillic/full-width/HOA/ký tự vô hình/`①②③`/`１９９` ⇒ 422 |
| **F2** | ĐÃ VÁ (giữ) | vòng 3: 30s 16:9 ⇒ 360 khung/331.776.000 px, `file`+`sips`+`magick`+decoder Python OK (patch vòng 4 không đụng tầng mã hoá) |
| **F3** | ĐÃ VÁ (giữ) | cảnh báo alpha `120000/120000` + khung 0 đúng màu nền `#00FF00` (đo vòng 3, tầng `frames.js` không đổi) |
| **F4** | ĐÃ VÁ theo thoả thuận | `evidence_used.sources:["product_name"]` + `chars` |
| **F5** | ĐÃ VÁ (giữ) | 8×8/64×64/256×256 ⇒ `inspectGif.valid=true` + decoder nghiêm ngặt chấp nhận |
| **F6** | **CHƯA** (= N2) | cảnh báo chữ vẫn đúng, nhưng số máy đọc vẫn `null` |
| **F7** | ĐÃ VÁ | 15/17 dạng field ⇒ 422; đệ quy `{text:['…']}` ⇒ 422; 0 ca `202 → failed` |
| **F8** | ĐÃ VÁ | chữ 800 ký tự ⇒ vẽ 500, `plan_summary` 500 |
| **F9** | ĐÃ VÁ | job `failed` ⇒ `data.warnings` có câu không-tiếng |
| **F10** | ĐÃ VÁ (giữ) | `fit_box={359,140,1,1000}` = bbox vẽ thật |
| **Thứ tự cảnh** | ĐÃ VÁ (giữ) | cùng mili-giây + gửi ngược ⇒ plan + màu tâm khung đúng thứ tự gửi |

**Hồi quy tự đo**: `npm test` → **929 · 928 pass · 0 fail · 1 skipped**, EXIT=0; `node tools/verify.mjs` → **929 · 928 · 0 · 1**, EXIT=0; ảnh gốc **bất biến** (`sha_before = sha_after = db_sha = 0fd335ccb14ef8b8…`); 402 `INSUFFICIENT_CREDIT` với `jobs_created=0`; usage theo bước (`VIDEO_RENDER:0.0006` + `VIDEO_ENCODE:0.0004`); **thu theo lượt** (`#1` → `#2`, ledger 4,999 → 4,998); IDOR job/GIF ⇒ **404** cho phiên khác, chủ 200.

## D2. 17 ca chữ bịa MỚI vẫn được vẽ (202 + `succeeded`, đo pixel + vân tay mực)

| Họ | Ca đo được (px trắng khung 0) | Vì sao lọt |
|---|---|---|
| **A. Dấu câu chen TRONG cụm từ** (11 ca) | `miễn-phí vận chuyển` 10.780 · `miễn - phí` · `miễn.phí` 31.752 · `miễn/phí` 32.724 · `miễn_phí` 32.076 · `miễn•phí` 30.456 · `miễn(phí)` 27.648 · `miễn…phí` · `miễn–phí` (en dash) · `khuyến-mãi` · `nguyên-seal` | `norm()` chỉ gộp **khoảng trắng**; dấu câu nằm giữa hai chữ nên needle `"mien phi"` không còn là chuỗi con. Dấu câu ở **ngoài** cụm (`"Miễn phí vận chuyển!"`, `"(Miễn phí vận chuyển)"`, `"Giá rẻ nhất — sốc"`) **vẫn bị chặn đúng** |
| **B. Dính chữ** (1 ca) | `miễnphí` (202 + succeeded, có mực) | Bỏ khoảng trắng ⇒ `"mienphi"` không chứa `"mien phi"` — lỗi gõ rất thường gặp |
| **C. Lookalike Latin ngoài bảng gộp** (4 ca) | `Mıễn phí` (dotless ı U+0131) · `miễn phı` · `khuyến mãı` · `giɑ re nhat` (ɑ U+0251) | `HOMOGLYPH_MAP` có Greek/Cyrillic nhưng **thiếu lookalike Latin**; chúng vẫn thuộc `\p{Script=Latin}` nên `FOREIGN_SCRIPT_RE` không bắt |
| **D. Cụm bị TÁCH thành nhiều mục chữ** (1 ca) | 2 mục `"Miễn"` + `"phí vận chuyển"` ⇒ 202 + **63.700 px** mực | Bộ kiểm chạy **theo từng mục**; không kiểm văn bản GHÉP của cả cảnh |

**Không tính là rò**: `ⓐ bán chạy` (21.825 px) và `Ⓐ sale` (29.376 px) — ký tự trang trí `\p{So}`, **không chứa khẳng định/số liệu nào**; ngược lại claim viết bằng chữ khoanh `ⓜⓘⓔⓝ ⓟⓗⓘ` **bị chặn 422** (NFKC gỡ đúng).

**Gợi ý vá (đều là sửa nhỏ, có bằng chứng ở trên)**: (1) `createEncodeResult` copy thêm `playback_ms/requested_ms/delay_drift_ms`; (2) chặn ở route: object lồng ⇒ 400/422 **hoặc** bỏ kèm cảnh báo, tuyệt đối không `String(object)` thành `"[object Object]"`, và mảng lồng bị bỏ phải có cảnh báo; (3) so khớp từ khoá trên bản **đã bỏ mọi ký tự không phải chữ/số** (`mienphi`) song song với bản có khoảng trắng, và thêm `ı→i, ɑ→a` vào `HOMOGLYPH_MAP`; (4) kiểm thêm văn bản **ghép** của `scene.texts`; (5) `guardrails.checkClaimWords` cũng cần ranh giới từ cho nhánh không dấu.

## D3. Đã cố phá mà KHÔNG phá được (vòng 4)

1. **Hy Lạp/Cyrillic**: 12 biến thể (β, θ, ω, Ο hoa, trộn giữa từ, `ѕ`/`у`/`і`, hoa) ⇒ **422 hết**.
2. **Số/ký hiệu đặc biệt**: `Ⅰ`, `Ⅻ`, `Ⅷ`, `№ mot`, `①②③`, `½`, `²`, `¹⁹⁹`, `١٩٩`, `१९९` ⇒ **422 hết** (dùng lại luật guardrails).
3. **Ký tự vô hình/không gian đặc biệt**: ZWJ, ZWSP, BOM, U+2060, NBSP, ideographic space U+3000, tab, CRLF, nhiều dòng ⇒ **422 hết**.
4. **Chữ khoanh/full-width**: `ⓜⓘⓔⓝ ⓟⓗⓘ`, `ｇｉá ｒẻ ｎｈấｔ` ⇒ **422** (NFKC).
5. **Dấu câu NGOÀI cụm**: `"Miễn phí vận chuyển!"`, `"(Miễn phí vận chuyển)"`, `"GIÁ RẺ NHẤT?"`, `"Giá rẻ nhất — sốc"` ⇒ **422** (ranh giới từ hoạt động đúng chiều này).
6. **Đối chứng dương**: 5/6 câu lành ⇒ 202 **và được vẽ** (`"Ao thun (cotton) - size M"` 8.532 px · `"Suy tin hieu camera"` 9.702 px · `"Giay the thao, mau trang!"` 9.324 px · `"Tui xach da bo"` 13.800 px · `"Mien thue va phi van chuyen"` 6.825 px) — **không** chặn bừa.
7. **Hồi quy**: `npm test` 929/928/0/1 · `verify.mjs` y hệt · ảnh gốc bất biến · tiền/usage/thu theo lượt · IDOR 404/200.

## D4. Chưa kiểm được (vòng 4)

1. **Tiếng**: không có TTS/ffmpeg ⇒ chỉ đọc được `audio: null` + cảnh báo. 2. **MP4/ffmpeg**: chưa chạy được. 3. **GIF 256 màu**: mọi phép đo pixel là trên GIF đã lượng tử hoá. 4. **UI trình duyệt thật**: chưa mở Chrome/Safari. 5. **Nhịp phát thật trên thiết bị**: chỉ đo `Σ delay` trong GIF (960ms cho video khai 1.000ms ≈ −4%). 6. **Postgres** (toàn bộ chạy SQLite in-memory) và **nhiều job 30s song song** (chỉ chạy tuần tự). 7. **Bằng chứng "vòng"**: người dùng vẫn tự khai `product_name`/ghi chú rồi lấy đó làm bằng chứng (đã ghi trong hợp đồng; `evidence_used.sources` nói ra nguồn) — chưa kiểm với người dùng thật.

## D5. Muốn PASS thì cần gì (điều kiện đo được, không phải ý kiến)

(1) `{text:{label:…}}` **không** vẽ `[object Object]` (422 hoặc bỏ + cảnh báo) và `texts=[[str]]` bị bỏ **có cảnh báo**; (2) `encode.playback_ms` là **số** khớp `Σ delay` GIF; (3) `"Also mot chiec ao"` và `"Suy tin hieu camera"` đều **202 + được vẽ**, còn `"Miễn phí vận chuyển"` vẫn **422**; (4) 17 ca ở D2 **không ca nào** được vẽ (422 hoặc `failed` + 0 px). Khi đó PASS sẽ nghĩa là: chữ khẳng định/số liệu thiếu bằng chứng không được vẽ với mọi cách viết thường gặp **và** chữ lành vẫn vẽ được; video 30s ở 3 preset mở được bằng 4 bộ giải mã độc lập; cảnh báo alpha/`fit_box`/thứ tự cảnh khớp pixel; tiền/IDOR/ảnh gốc bất biến đúng; 929 test xanh. PASS **KHÔNG** nghĩa là: có tiếng · MP4/ffmpeg đã đo · màu đã kiểm ngoài GIF 256 màu · UI đã kiểm trên trình duyệt thật · nhịp phát khớp tuyệt đối · bằng chứng khách quan (vẫn là dữ liệu người dùng tự lưu) · hàng rào từ khoá kín tuyệt đối trước mọi cách viết sáng tạo.
