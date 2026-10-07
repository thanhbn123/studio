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
