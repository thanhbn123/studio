# GÓI XUẤT BẢN — BÁO CÁO PHẢN BIỆN ĐỘC LẬP

**PHÁN QUYẾT: FAIL** *(hẹp)* — cơ chế ZIP, độ trung thực của **dữ liệu**, quyền sở hữu và UI đều vững,
nhưng **luật riêng §0.1 bị vi phạm ở đúng kịch bản phổ biến nhất của chế độ offline**: job MVP-01 sinh
nội dung bằng provider GIẢ (`AI_PROVIDER=mock`) ra gói có `mock_steps: []`, và bản kê khai còn **khai sai**
`is_mock: false` cho những dòng `usage_events` mang `provider: "mock"`.

Nhánh `feat/export-bundle` @ `e5241f2` · phản biện viên độc lập (không sửa mã nguồn, không sửa `test/**`) ·
toàn bộ script tấn công ở `/tmp/x-atk/` · mọi kết luận đều kèm **lệnh + output thật**.

Bốn câu hỏi trung tâm:

| Câu hỏi | Trả lời | Bằng chứng |
|---|---|---|
| Gói tải về có **file hỏng** không? | **KHÔNG** — 16/16 gói (kể cả 1000 entry, 5 MB, entry 0 byte, tên tiếng Việt + emoji) mở được bằng `python3 zipfile` (`testzip()=None`) và `unzip -t`; CRC/kích thước/tên khớp **từng byte** với `inspectZip` | §3.1, §3.2 |
| Có **giấu cảnh báo** không? | **CÓ** — `mock_steps` rỗng cho job sinh bằng provider giả; `providers.usage[].is_mock=false` cho `provider="mock"`; nhãn `LIVE_VERIFIED` được giữ khi thiếu dấu vết `transport` | P1, P2, P3 |
| Có **bịa nội dung** không? | **KHÔNG** về dữ liệu: `noi-dung.json` ≡ `jobs.content`, `usage.json` ≡ `usage_events` (đã lược `session_id`), `evidence.json` ≡ `extraction_evidence` + `jobs.evidence`, byte ảnh ≡ đĩa ≡ `sha256` trong DB, `MANIFEST.job` ≡ cột DB (so từng field) | §3.4 |
| Có **lộ dữ liệu người khác** không? | **KHÔNG** — IDOR theo phiên/tài khoản ⇒ 404, không cookie ⇒ 404, id rác ⇒ 400; gói không chứa `session_id`/`storage_path`/đường dẫn tuyệt đối | §3.3 |

---

## 1. Tóm tắt phát hiện

| # | Mức | Phát hiện | Bằng chứng (1 dòng) | Vì sao quan trọng | Gợi ý sửa |
|---|---|---|---|---|---|
| **P1** | **HIGH** | `MANIFEST.json` + `noi-dung.txt` **giấu bước chạy provider GIẢ** của job MVP-01: `mock_steps: []` dù `jobs.content_meta.is_mock = true` và `usage_events.provider = "mock"` | E2E job thật: `content_meta.is_mock=true`, `MANIFEST.json.mock_steps=[]`; `mockStepsFor(job,assets,usage)` (hàm có sẵn) trả `["content"]` nhưng **không được gọi ở đâu** | Luật §0.1 ("gói phải tự khai … không được gói đẹp bằng cách bỏ cảnh báo"); UI còn in câu khẳng định sai *"Máy chủ khai KHÔNG có bước nào dùng dữ liệu giả."* | Trong `manifestFor`: `mockSteps = orderMockSteps(new Set([...mockStepsFromAssets(assetList), ...mockStepsFor(job, assetList, usageList)]))`; `bundle.js` truyền `mock_steps` xuống `renderHumanText` bằng cùng nguồn |
| **P2** | **HIGH** | `providers.usage[].is_mock` **khai sai**: dòng có `provider: "mock"` nhưng meta không kèm cờ `is_mock` ⇒ manifest ghi `is_mock: false` | E2E: `{"operation":"CONTENT_GENERATE","provider":"mock","model":"mock-1","is_mock":false,"events":1}` trong khi `usage_events.provider="mock"` | Gói khẳng định một điều **sai sự thật** về chính dữ liệu nó chứa; `mockStepsFor` đã biết luật đúng (`provider === 'mock'`) | Dùng chung một hàm chuẩn hoá: `is_mock = rowMeta.is_mock === true \|\| String(row.provider).toLowerCase() === 'mock'` (hoặc ghi `meta.is_mock` ngay lúc `recordUsage`) |
| **P3** | MEDIUM | `verificationFor()` **fail-open** khi dấu vết thiếu `transport`: vẫn giữ nhãn `LIVE_VERIFIED`/`AUTHENTICATED_LIVE_VERIFIED` dù `live_service_called = false` và `notes = []` | `verificationFor({id,kind:'content'},[{verification:'AUTHENTICATED_LIVE_VERIFIED'}],[])` ⇒ `label='AUTHENTICATED_LIVE_VERIFIED'` (điều kiện bỏ nhãn là `transport !== null && transport !== 'http'`) | Chính comment đầu file ghi "nghi ngờ ⇒ trả `null`"; `src/jobs/pipeline.js:48` coi transport thiếu là MOCK | Bỏ nhãn trừ khi `transport === 'http'`: `if (label && LIVE_LEVELS.includes(label) && transport !== 'http') { … label = null }` |
| **P4** | MEDIUM | Job **không có `session_id`** ⇒ bất kỳ ai (không cookie, phiên khác) tải được **toàn bộ** gói | `job-api-nosession` → không cookie `200`, phiên B `200` (`requireOwnExportJob` chỉ so session khi `job.session_id` khác rỗng) | Gói là "tất cả dữ liệu trong một file"; rủi ro chỉ khi tồn tại job `session_id=''` (các route tạo job hiện đều truyền sid, nhưng job cũ/import/tool thủ công thì không) | Chặn ở tầng gói: job không có cả `user_id` lẫn `session_id` ⇒ 404 (khác các route chi tiết job vốn cố ý mở cho khách ẩn danh) |
| **P5** | MEDIUM | `/api/exports/jobs/:id/manifest` **dựng cả ZIP** (đọc hết asset + nén + tự kiểm) cho một phản hồi ~10 KB | 60 MB asset: `/bundle` 1992 ms · `/manifest` 2347 ms (thân 10 KB) | Mỗi lần UI bấm "Xem bản kê khai" (và trước mỗi lần tải) là một lần đọc/nén toàn bộ ảnh — nhân đôi chi phí tài nguyên, không cần thiết | Route manifest gọi `manifestFor()` (+ `sha256` nếu muốn) thay vì `buildExportBundle()`; hoặc cache theo `(jobId, updated_at)` |
| **P6** | MEDIUM | Khuếch đại tài nguyên ~4×, không giới hạn đồng thời: 60 MB asset ⇒ **+245 MB RSS**, ~2 s/request; trần mặc định 512 MB ⇒ một request có thể ngốn ~2 GB | `res-big.zip`: 60 MB, RSS 98→342 MB; `maxTotalBytes` chỉ kiểm được ở mức hàm (`BUNDLE_TOO_LARGE` khi đặt 1 MB) | Rate limit 10 job/phút/phiên **không** giới hạn số request đồng thời; gói được dựng trọn trong RAM (`Buffer.concat`) rồi `res.end(buffer)` | Hạ trần mặc định theo cấu hình, hoặc stream ZIP, hoặc semaphore số lượt dựng gói đồng thời |
| **P7** | LOW | `manifest.entries` **không liệt kê chính `MANIFEST.json`** (lệch 1 so với gói thật) | `zipEntries=7` vs `manifest.entries=6` (thiếu `MANIFEST.json`) | Bản kê khai tự đếm thiếu chính nó; công cụ đối chiếu "manifest vs ZIP" sẽ báo lệch | Thêm `MANIFEST.json` vào `entries` (và ghi rõ trong `provenance`) hoặc đổi tên field thành `payload_entries` |
| **P8** | LOW | Thiếu khối `storage` ⇒ **500 `EXPORT_FAILED`** (hợp đồng §3 ghi "thiếu module ⇒ 503 `EXPORT_UNAVAILABLE`"), và `/api/config` vẫn khai `exports.available = true` | `app.storage = null` ⇒ bundle/manifest đều `500 EXPORT_FAILED`, `config.exports = {"available":true,"formats":["zip"]}` | Người dùng bấm nút, `config` nói "khả dụng", nhưng mọi lần tải đều 500 — hệ thống nói một đằng làm một nẻo | `mapExportError`: `BAD_INPUT` ⇒ 503 `EXPORT_UNAVAILABLE` khi nguyên nhân là thiếu `storage`; `exportsAvailable()` kiểm thêm `app.storage` |
| **P9** | LOW | `createZip` **nhận tên entry chứa CR/LF** (`normalizeZipName` chỉ chặn NUL, rỗng, `..`, tuyệt đối) | `createZip({entries:[{name:'a\nb.txt'}]})` ⇒ `inspectZip.valid=true`, tên giữ nguyên `a\nb.txt`; `unzip -l` hiển thị lệch dòng | Hiện **không có đường tới từ HTTP** (mọi tên entry của gói là hằng số + đuôi asset bị siết `^[A-Za-z0-9]{1,8}$`), nhưng là API công khai của X1 | Chặn `[\u0000-\u001f]` trong `normalizeZipName` |

**Tương quan độc lập:** 4 file test xuất bản (`test/export-*.test.js`) do agent test của sprint thêm **giữa phiên phản biện** (untracked, 14:28–14:34) có **2 test `todo` mang nhãn `TODO(mã nguồn sai)`** đúng hai lỗi **P1** và **P3** — hai bên tìm độc lập, kết luận trùng nhau. Ở commit `e5241f2` **không có test nào** cho tính năng này (`grep -rln "buildExportBundle\|inspectZip" test/ tools/` ⇒ rỗng).

---

## 2. Chi tiết từng phát hiện

### P1 — HIGH: gói giấu bước chạy provider giả (MVP-01)

**(a) End-to-end bằng job THẬT** — app thật, pipeline thật, engine nội dung thật với `AI_PROVIDER=mock`
(`/tmp/x-atk/a6-e2e.mjs`, connector giả để không cần mạng):

```
$ node /tmp/x-atk/a6-e2e.mjs
AI provider theo cấu hình: mock
job.status = succeeded
content_meta = {"style":"ban-hang",...,"provider":"mock","model":"mock-1","is_mock":true}
usage_events = [{"operation":"SOURCE_EXTRACT","provider":"1688",...},
                {"operation":"VISION_ANALYSIS","provider":"mock","model":"mock-1",...},
                {"operation":"TRANSLATION","provider":"mock","model":"mock-1",...},
                {"operation":"CONTENT_GENERATE","provider":"mock","model":"mock-1",...}]
==> /api/exports/.../manifest: mock_steps = [] | verification = "MOCK_VERIFIED"
MANIFEST.json trong gói: mock_steps = []
MANIFEST.json providers.content = {"name":"mock","model":"mock-1","is_mock":true,...}
MANIFEST.json providers.usage = [...,{"operation":"CONTENT_GENERATE","provider":"mock","model":"mock-1","is_mock":false,"events":1}]
```

**(b) Cùng dữ liệu, hàm "đúng luật" có sẵn lại trả kết quả khác** (`/tmp/x-atk/a1-bundle.mjs`, kịch bản S1 —
job `content_meta.is_mock=true` + 1 dòng usage `provider=mock`):

```
=== S1 mock content job ===
manifest.mock_steps      = []
mockStepsFor(job,a,u)    = ["content"]
content_meta.is_mock     = true
usage provider/op        = mock/CONTENT_GENERATE/mock=true
entries                  = ["MANIFEST.json","noi-dung/noi-dung.json","noi-dung/noi-dung.txt","bang-chung/usage.json","bang-chung/evidence.json"]
```

`mockStepsFor()` (`src/exports/manifest.js:216`) đọc đúng `content_meta.imagelab.mock_steps`,
`content_meta.is_mock`, `imagestudio/videostudio.providers.*.is_mock` và `usage_events` (kể cả
`provider === 'mock'`) — nhưng **không được export ở `index.js` và không được gọi ở đâu**:

```
$ grep -rn "mockStepsFor" src/ | cat
src/exports/manifest.js:216:export function mockStepsFor(job, assets = [], usage = []) {
```

`manifestFor()` chỉ dùng `mockStepsFromAssets(assetList)` (meta **asset**), còn `bundle.js` truyền
`extra = { entries, files, original_sha256, warnings, missing, regions, filename, generated_at }` —
**không có `mock_steps`**. Job MVP-01 không có asset ⇒ `mock_steps` luôn rỗng.

**(c) File dễ đọc cho người cũng im lặng** (`bundle.js:316` truyền `mockSteps: orderMockSteps(new Set(mockStepsFromAssets(assets)))`):

```
$ tail -3 /tmp/x-atk/out/s1x/noi-dung/noi-dung.txt
—
Gói do tính năng "Gói xuất bản" của vip-product-studio tạo. Mọi nội dung ở trên là dữ liệu đã lưu của job.
```
(không có dòng `⚠️ Các bước đã chạy bằng provider GIẢ (mock): …` dù `renderHumanText` có sẵn dòng đó)

**(d) UI in câu khẳng định sai** (`public/app.js:5031`):

```
${exportBlockHtml('Bước dùng dữ liệu giả (mock_steps)', mockSteps, { …, empty: 'Máy chủ khai KHÔNG có bước nào dùng dữ liệu giả.' })}
```

⇒ Người dùng bấm "Xem bản kê khai" và đọc được đúng câu **"Máy chủ khai KHÔNG có bước nào dùng dữ liệu giả"**
cho một job mà mọi bước AI đều chạy bằng `mock`.

**Gợi ý sửa:** `manifestFor()` dùng `mockStepsFor(job, assetList, usageList)` (hợp với `mockStepsFromAssets`);
`bundle.js` truyền `mock_steps: mockSteps` xuống `extra` để MANIFEST và `.txt` cùng một nguồn sự thật.

---

### P2 — HIGH: `providers.usage[].is_mock = false` cho dòng `provider = "mock"`

`providersFor()` (`manifest.js:141-151`):

```js
const rowMeta = parseMaybeJson(row.meta) || {};
is_mock: rowMeta.is_mock === true,
```

Pipeline thật ghi `usage_events.meta` **không** kèm `is_mock` (chỉ `{used, skipped, ms, status}`, `{ms}`,
`{style, length, …}`) — nên mọi dòng `provider="mock"` bị khai thành `is_mock: false`:

```
$ node /tmp/x-atk/a6-e2e.mjs   (trích)
usage_events = [{"operation":"VISION_ANALYSIS","provider":"mock","model":"mock-1","meta":"{\"used\":1,\"skipped\":0,\"ms\":0,\"status\":\"OK\"}"}, …]
MANIFEST.json providers.usage = [{"operation":"SOURCE_EXTRACT","provider":"1688","model":"http","is_mock":false,"events":1},
                                 {"operation":"VISION_ANALYSIS","provider":"mock","model":"mock-1","is_mock":false,"events":1},
                                 {"operation":"TRANSLATION","provider":"mock","model":"mock-1","is_mock":false,"events":1},
                                 {"operation":"CONTENT_GENERATE","provider":"mock","model":"mock-1","is_mock":false,"events":1}]
```

Cùng file, `mockStepsFor` (không được gọi) lại biết luật đúng: `rowMeta.is_mock === true || provider === 'mock'`
(`manifest.js:229`). Đây là **khai báo sai sự thật** ngay trong bản kê khai (không phải thiếu sót im lặng).

---

### P3 — MEDIUM: nhãn `LIVE_VERIFIED` được giữ khi KHÔNG có dấu vết `transport`

`verificationFor()` (`manifest.js:261`):

```js
if (label && LIVE_LEVELS.includes(label) && transport !== null && transport !== 'http') { … label = null; }
```

`transport = job?.product_master?.extraction?.transport ?? null` ⇒ **transport thiếu (null) được coi là đủ tin**:

```
$ node /tmp/x-atk/a1-bundle.mjs   (kịch bản S6: evidence ghi LIVE_VERIFIED, job KHÔNG có product_master)
=== S6 LIVE_VERIFIED + transport KHÔNG rõ ===
verification    : "LIVE_VERIFIED"
detail          : {"label":"LIVE_VERIFIED","recorded_level":"LIVE_VERIFIED","recorded_levels":["LIVE_VERIFIED"],
                   "source":"extraction_evidence","connector":"fixture","extraction_method":"fixture",
                   "http_status":null,"transport":null,"live_service_called":false,"contains_mock":false,
                   "mock_steps":[],"notes":[]}
```

Bản kê khai tự mâu thuẫn: `live_service_called: false` nhưng `verification: "LIVE_VERIFIED"`, `notes: []`
(trong khi nhánh `transport='fixture'` lại bỏ nhãn và ghi chú đầy đủ). Test độc lập của agent test cũng dựng
đúng ca này và đánh dấu `TODO(mã nguồn sai)`:

```
$ grep -n "TODO(mã nguồn sai)" test/export-bundle.test.js
229:  test('TODO(mã nguồn sai): MANIFEST.json kể ĐỦ bước mock từ content_meta + usage_events',
363:  test('TODO(mã nguồn sai): thiếu hẳn transport ⇒ KHÔNG được khẳng định LIVE_VERIFIED',
```

*Phạm vi:* không tìm được đường mã nguồn "chuẩn" nào ghi `LIVE_VERIFIED` mà thiếu `transport`
(`src/jobs/pipeline.js` ghi nhãn theo `master.extraction.transport`, đã lưu cùng `product_master`) ⇒ cần
DB cũ/sửa tay/import. Vì vậy để MEDIUM, không phải HIGH.

---

### P4 — MEDIUM: job không có `session_id` ⇒ ai cũng tải được cả gói

```
$ node /tmp/x-atk/a3-api.mjs   (trích)
=== 4. job không session_id ===
  không cookie: 200 | phiên B: 200
[requireOwnExportJob] chỉ kiểm: if (job.user_id == null && job.session_id) { … so sid … }
```

Đối chứng chủ sở hữu **đúng** khi job có `session_id`/`user_id` (xem §3.3). Rủi ro nằm ở job `session_id=''`
(hiện 4 chỗ `store.createJob` trong `src/http/routes.js` đều truyền sid, nhưng job cũ/import/tool thủ công
thì không) — với route chỉ-đọc thì chấp nhận được, với một file chứa **toàn bộ** nội dung + ảnh + video thì không.

---

### P5 + P6 — MEDIUM: `/manifest` dựng cả ZIP; khuếch đại RAM ~4×

```
$ node /tmp/x-atk/a3c-resource.mjs
assets: 40 × 1.5MB = 60MB dữ liệu ngẫu nhiên (không nén được)
GET /bundle : 200 content-length=62924015 nhận=60.0MB thời gian=1992ms RSS 98→342MB (+245MB)
GET /manifest: 200 thân=10KB thời gian=2347ms  <-- có dựng cả ZIP không?
maxTotalBytes=1MB: ném BUNDLE_TOO_LARGE — Gói vượt trần 1048576 byte — từ chối xuất để không ăn hết bộ nhớ.
```

`/manifest` gọi `buildBundleFor()` (⇒ `createZip` + `inspectZip`) chỉ để trả 3 field JSON. Với trần mặc định
512 MB (`DEFAULT_MAX_TOTAL_BYTES`), một request hợp lệ có thể cấp phát ~2 GB (entry buffers + ZIP + bản sao
trong `Buffer.concat`); rate limit theo **phiên** (10 job/phút) không giới hạn số request **đồng thời**.
Trần hoạt động đúng ở mức hàm, nhưng route không có cách hạ trần (không đọc config).

---

### P7 — LOW: `manifest.entries` thiếu chính `MANIFEST.json`

```
$ node /tmp/x-atk/a1-bundle.mjs   (kịch bản S2)
entries                  : ["MANIFEST.json","noi-dung/noi-dung.json","noi-dung/noi-dung.txt","anh/anh-goc-1.png","anh/anh-goc-2.jpg","bang-chung/usage.json","bang-chung/evidence.json"]
manifest.entries         : ["noi-dung/noi-dung.json","noi-dung/noi-dung.txt","anh/anh-goc-1.png","anh/anh-goc-2.jpg","bang-chung/usage.json","bang-chung/evidence.json"]
[LOW] manifest.entries KHÔNG liệt kê đủ entry thật của ZIP (thiếu chính MANIFEST.json)
```

`manifestFor` nhận `extra.entries = payloadEntries.map(e => e.name)` (bundle.js:335) — đúng theo cách gọi,
nhưng field lại tên là `entries` và nằm cạnh `files` (cũng thiếu `MANIFEST.json`) ⇒ dễ bị đọc như "danh sách
file của gói".

---

### P8 — LOW: thiếu `storage` ⇒ 500 (không phải 503) và `/api/config` vẫn khai khả dụng

```
$ node /tmp/x-atk/a4b-nostorage.mjs
config.exports = {"available":true,"formats":["zip"]}
GET /bundle khi app.storage=null: 500 {"error":{"code":"EXPORT_FAILED","message":"Không dựng được gói xuất bản. Vui lòng thử lại.","details":{}}}
GET /manifest khi app.storage=null: 500 {"error":{"code":"EXPORT_FAILED",…}}
server sống: 200
```

Hợp đồng §3: "thiếu module ⇒ **503 `EXPORT_UNAVAILABLE`**". X1 ném `BAD_INPUT`, `mapExportError` không map
`BAD_INPUT` ⇒ rơi vào 500. Không sập server (điểm cộng), nhưng thông điệp sai loại lỗi và `config` nói dối.

---

### P9 — LOW: `createZip` nhận tên entry chứa CR/LF

```
$ node /tmp/x-atk/a1-bundle.mjs   (kịch bản S9)
  NHẬN "a\nb.txt" -> valid=true names=["a\nb.txt"]
[MEDIUM] createZip cho phép tên entry chứa CR/LF (chưa thấy đường tới từ HTTP)
```

`normalizeZipName` chặn NUL/rỗng/`..`/tuyệt đối/`\` nhưng không chặn ký tự điều khiển. Hạ xuống LOW vì
đường HTTP hiện tại không tạo được tên như vậy (§3.5).

---

## 3. Đã cố phá mà KHÔNG phá được

### 3.1 ZIP thật, mở được bằng công cụ NGOÀI (không tin `inspectZip`)

```
$ python3 /tmp/x-atk/a2-external.py        # zipfile chuẩn của Python: testzip() + namelist() + read() từng entry
s14-unicode-names.zip: python_testzip=None entries=5 valid_mine=True names_match=True crc_match=True size_match=True method_match=True all_crc_ok=True => OK
s10-1000-entries.zip:  python_testzip=None entries=1000 … => OK
s10-5mb.zip:           python_testzip=None entries=1 … => OK
s10-zero.zip:          python_testzip=None entries=1 … => OK
s2-real-originals.zip / s1 / s3 / s4 / s6 / s8 / api-own / api-big / debug-big / match / e2e-real-job / res-big … => OK
FAILED: 0
   utf8_flag=0x800 on 1000/1000 entries; names=['anh/anh-tao-0.png', …]
$ cd /tmp/x-atk/out && for f in *.zip; do unzip -t "$f" >/dev/null 2>&1 && echo "OK $f" || echo "FAIL $f"; done
OK api-big.zip … OK res-big.zip … (16/16 OK)
```

- **Tên tiếng Việt + emoji**: `unzip -l` cắt cụt chữ ở *cột hiển thị* (bản `unzip 6.00` của macOS không in UTF-8 ra terminal), nhưng **giải nén ra đúng tên** và **byte y hệt**:
  ```
  $ unzip -qq s14-unicode-names.zip -d x14 && python3 - <<'PY' … sha256(disk) vs sha256(zip.read) …
    'nội-dung/noi-dung.txt': disk=15B zip=15B byte-identical=True
    'anh/ảnh-gốc-1.png': … True    'video/😀-video-1.gif': … True
  ALL BYTE-IDENTICAL: True
  ```
- **zip-slip / đường dẫn tuyệt đối**: `createZip` **chặn hết** — `../evil.txt`, `a/../../evil.txt`, `/etc/passwd`,
  `C:\Windows\evil`, `good/../bad`, `x/./y`, `''`, `ok\0nul`, `dir/`, `'../'` đều `ZIP_NAME_INVALID`;
  trùng tên ⇒ `ZIP_DUPLICATE_NAME`.
- **`storage_path` bị sửa tay thành `../../etc/passwd`** ⇒ `storage.read` từ chối `UNSAFE_PATH`, gói **không** sinh entry thoát thư mục, `missing[]` nói rõ:
  ```
  missing: ["anh/anh-goc-1.png — KHÔNG đọc được file của asset assetS11a trên đĩa (UNSAFE_PATH); gói không chứa file này.", …]
  ```
- **Biên khác**: 1000 entry (`valid=true`), 5 MB (deflate, `size=5242880`), entry 0 byte (`crc=0`), tiếng Việt có dấu, emoji — tất cả `valid=true` và công cụ ngoài đọc được.

### 3.2 `inspectZip` không phải "con dấu rỗng"

```
$ node /tmp/x-atk/a8-inspect.mjs     # đột biến ZIP rồi xem bộ đọc có bắt không
  lành: valid=true
  cắt 5 byte cuối: valid=false ("Không tìm thấy End Of Central Directory …")
  thêm 4 byte rác cuối: valid=false      thêm rác ĐẦU file: valid=false ("Vùng central directory không khớp EOCD …")
  flip byte #40: valid=false ("tên trong local header khác central directory")
  CRC central = 0xdeadbeef: valid=false   uncompressed size = 9999: valid=false   method central = 8: valid=false
```
Bộ đọc bắt được **mọi** đột biến thử được ⇒ bước tự kiểm của gói có giá trị thật.

### 3.3 Quyền sở hữu / IDOR / header / rate limit / 503

```
$ node /tmp/x-atk/a3-api.mjs    (trích)
1. chủ phiên A tải gói: status 200, content-type=application/zip, content-disposition="attachment; filename=\"content-job-api--20261009-1428.zip\"",
   cache-control="private, no-store", x-content-type-options=nosniff, magic=504b0304
2. phiên B (khác chủ): 404 | KHÔNG cookie: 404 | cookie sai định dạng: 404 | uuid lạ: 404 | id rác %2e%2e%2f: 400 | id rỗng: 400
3. IDOR tài khoản: chủ U1 = 200 | U2 = 404 | phiên ẩn danh A = 404
5. header injection: id chứa dấu " -> 400 (requireJob chặn trước); kind='a"\r\nX-Injected: 1' -> filename="a-X-Injected-1-jobS12-n-20261009-1426.zip", X-Injected = null
6. config.exports = {"available":true,"formats":["zip"]} | /manifest chủ 200, phiên khác 404 | rò rỉ: KHÔNG thấy session_id / storage_path / đường dẫn tuyệt đối
7. RATE_LIMIT_MAX_JOBS=3, 5 lần /manifest: [200,200,200,429,429]   (bucket riêng: /api/jobs/:id sau đó vẫn 200)
8. exportsUnavailableReason set ⇒ bundle 503 {"code":"EXPORT_UNAVAILABLE"}; /api/config vẫn 200 (KHÔNG sập server)
9. 3 request song song: payload entry giống nhau (sha256/z-CRC từng entry trùng), sha256 asset trên đĩa trước/sau KHÔNG ĐỔI
```

### 3.4 Không bịa: gói khớp DB **từng field**

```
$ node /tmp/x-atk/a7-dbmatch.mjs
  OK   noi-dung.json === jobs.content
  OK   events (đã bỏ session_id) === store.listUsage      OK count   OK totals.input_units/output_units/estimated_cost   OK job_id
  session_id có trong usage.json? false
  OK   extraction_evidence === store.getEvidence          OK job_evidence === jobs.evidence
  OK   anh/anh-goc-1.png byte === đĩa                     OK … sha256 === DB image_assets.sha256
  OK   video/video-1.gif byte === đĩa                     OK … sha256 === DB image_assets.sha256
  OK   counts.assets / counts.lines / counts.usage        OK audio (=null)
  mock_steps = ["render","video_encode"] | providers.videostudio = {"encoder":null,"preset":null}
```

- **Job rỗng** không sinh file giả: 3 entry (`MANIFEST.json`, `bang-chung/usage.json`, `bang-chung/evidence.json`),
  `missing[]` liệt kê 6 mục kèm lý do; `noi-dung/noi-dung.txt` **không** được tạo khi không có dữ liệu văn bản.
- **Asset mất file trên đĩa** ⇒ `missing[]` nói rõ `(NOT_FOUND)` + cảnh báo, gói vẫn hợp lệ, **không** chèn placeholder.
- **`sha256` đĩa ≠ DB** ⇒ `original_sha256[].match=false`, ghi cả hai giá trị + cảnh báo nguyên văn.
- **Cảnh báo không bị giấu**: 16 nguồn cảnh báo (content_meta các khối, `imagestudio.failures`, `videostudio.violations`,
  `job.error_message`, `product_master.extraction.warnings`, `evidence.guardrails.warnings`, meta asset, `blocked_reason`…)
  vào đủ `manifest.warnings` — kịch bản S7 dựng 16 cảnh báo, **thiếu 0**.
- **`audio: null`** có căn cứ: VideoStudio luôn ghi `meta.audio = null` (`src/videostudio/pipeline.js`), manifest kèm
  `no_audio: true` + `audio_note` giải thích — không phải khẳng định suông.

### 3.5 UI: XSS, nút khoá, URL (chạy **hàm UI THẬT** trích từ `public/app.js`)

```
$ node /tmp/x-atk/a5-ui.mjs
1. XSS panel:  id/kind = "><img src=x onerror=alert(1)>", ' onmouseover='alert(1), </div><script>…, `; alert(1); //
               -> raw? false ×4   (esc() phủ hết; data-export-kind không thoát thuộc tính)
2. XSS bản kê khai: payload ở generated_at / verification / counts / job.id / job.kind / mock_steps / warnings / providers / missing
               -> HTML sinh ra chứa thẻ/handler nguy hiểm? false
3. URL encode: id='a b/c?d=e&f#g' -> /api/exports/jobs/a%20b%2Fc%3Fd%3De%26f%23g/bundle  (encodeURIComponent đúng)
4. Nút: id rỗng -> disabled + nhắc lý do | running -> nhắc "job chưa xong" | có dòng nói thật §4 | config.available=false -> cảnh báo
5. Tải: dùng createElement('a') + a.download, KHÔNG có btoa/base64 trong khối export
6. Thông báo lỗi: exportPaintError esc(text) — payload </div><script>alert(1)</script> -> không có <script> trong HTML
```

---

## 4. Chưa kiểm được (vì sao)

1. **PostgreSQL thật**: `DATABASE_URL` trong shell trỏ `postgres://studio:studio@127.0.0.1:55440/studio` (PG đã tắt)
   nên mọi thứ chạy trên SQLite in-memory (`sqlitePath: ':memory:'`). Nhánh PG/JSONB (`parseMaybeJson`, `driver: 'postgres'`)
   **chưa** được kiểm — đặc biệt chỗ `content_meta` là object (PG) vs chuỗi JSON (SQLite) có thể ảnh hưởng P1/P2.
2. **Trần 512 MB thật**: không dựng nổi job > 512 MB trong thời gian cho phép; chỉ kiểm được cơ chế trần bằng
   `maxTotalBytes: 1 MB` ⇒ `BUNDLE_TOO_LARGE`. Con số ~2 GB/RAM là **ngoại suy** từ 60 MB (+245 MB RSS), không phải đo trực tiếp.
3. **Trình duyệt thật / Finder**: XSS kiểm bằng hàm UI thật + `esc()` trong Node, **không** có DOM/Chrome;
   ZIP kiểm bằng `unzip`/`python3 zipfile`, **không** mở bằng Finder (không có GUI trong phiên này).
4. **Windows**: tên file gói có ký tự dành riêng của Windows (CON/PRN/NUL…) chỉ kiểm ở mức `sanitizeFilename`
   (đọc mã + gọi hàm), không thử trên hệ tệp Windows.
5. **Đa tiến trình thật**: "2 tiến trình cùng lúc" mô phỏng bằng 3 request song song trong **cùng** một tiến trình
   server; chưa chạy 2 process server khác nhau trên cùng `IMAGELAB_DIR` (đọc-only nên rủi ro thấp).
6. **Số test thay đổi giữa phiên**: 4 file `test/export-*.test.js` do agent test thêm lúc 14:28–14:34 (untracked).
   Số đo **ở commit `e5241f2`** (đầu phiên): **986 test · 980 pass · 0 fail · 6 skipped** (exit 0). Số đo **cuối phiên**
   (đã có test xuất bản): **1056 · 1048 pass · 0 fail · 6 skipped · 2 todo** (exit 0) — 2 `todo` chính là P1 và P3.
7. **Hồi quy UI "22 test"**: không tái lập được đúng danh sách 22 (không test nào nhắc tới tính năng xuất bản);
   đã chạy trọn 3 suite liên quan — `imagelab-ui` 23/23, `imagestudio-ui` 15/15, `mvp04-ui` 9/9 = **47/47 xanh**.

---

## 5. Hồi quy & lệnh đã chạy

| Lệnh | Kết quả |
|---|---|
| `env -u DATABASE_URL npm test` (đầu phiên, @`e5241f2`) | **986 test · 980 pass · 0 fail · 6 skipped**, exit 0 |
| `env -u DATABASE_URL npm test` (cuối phiên, có test xuất bản mới) | **1056 · 1048 pass · 0 fail · 6 skipped · 2 todo**, exit 0 |
| `env -u DATABASE_URL node tools/verify.mjs` | kiểm cú pháp 219 file + bộ test: **1056 · 1048 pass · 0 fail**, exit 0 |
| `env -u DATABASE_URL node tools/imagelab-demo.mjs` | exit 0, `NHÃN KIỂM CHỨNG: MOCK_VERIFIED` |
| `env -u DATABASE_URL node --test test/imagelab-ui.test.js test/imagestudio-ui.test.js test/mvp04-ui.test.js` | **47/47 pass**, 0 fail |
| `git status --short` | không file nào trong repo bị sửa (chỉ 6 file test untracked của agent test + báo cáo này) |

*Script phản biện: `/tmp/x-atk/a1-bundle.mjs`, `a2-unicode-zip.mjs` + `a2-external.py`, `a3-api.mjs`, `a3b-debug.mjs`,
`a3c-resource.mjs`, `a4-edge.mjs`, `a4b-nostorage.mjs`, `a5-ui.mjs`, `a6-e2e.mjs`, `a7-dbmatch.mjs`, `a8-inspect.mjs`.*
