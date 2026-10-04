# VERIFICATION — mức độ kiểm chứng thật của từng nguồn

> **Đọc kỹ trước khi tin bất cứ dòng nào.** Tài liệu này phân biệt rõ **đo được** với
> **chưa đo được**. Không có nguồn nào được gọi là "fully supported" nếu mới chỉ chạy bằng mock.

Mọi số liệu dưới đây lấy từ lệnh thật, chạy ngày **03/10/2026**, từ máy MacBook Pro của Owner.
Công cụ: `curl` và chính connector trong repo. Người đo: phiên điều khiển DSH.

---

## 1. Bảng tổng hợp

| Nguồn | Mức kiểm chứng | Ghi chú |
|---|---|---|
| **Taobao** | `LIVE_VERIFIED` (qua `world.taobao.com`) | `item.taobao.com` chặn đăng nhập với **mọi** id, kể cả id thật |
| **1688** | `PARTIAL` | Trang thật đo được từ IP sạch; IP hiện tại đã bị chặn tần suất |
| **Pinduoduo** | `AUTH REQUIRED` | Không có dữ liệu sản phẩm nào trong HTML tĩnh |

---

## 2. Taobao — `LIVE_VERIFIED`

### 2.1 Điều đã ĐO được

**Route ẩn danh duy nhất chạy được: `world.taobao.com/item/<id>.htm`**

```
$ curl -sL -A "<Chrome UA>" "https://world.taobao.com/item/671021594308.htm" -w 'bytes=%{size_download}'
bytes=68015
<title>MuseLab HDMI擴展模組FPGA顯示模組標準PMOD接口高清擴展卡-Taobao-Tmall</title>
"itemId":671021594308
```

Connector của repo lấy được từ trang đó (đo bằng `tools/live-probe.mjs`):

| Field | Giá trị thật |
|---|---|
| `title_original` | `MuseLab HDMI擴展模組FPGA顯示模組標準PMOD接口高清擴展卡` |
| `price.raw` | `15.00` CNY, `kind = fixed` |
| `store.name` | `Muse Lab` |
| `images` | 1 ảnh (`img.alicdn.com`) |
| thuộc tính | Nơi xuất xứ `浙江金華`; Đánh giá `100%, 0 lượt chê`; Ghi chú giá; 5 điểm bán hàng của sàn; từ khoá của sàn |
| `description_original` | 76 ký tự, lấy từ `aibModuleResponse` của chính Taobao |
| `main_video` | `NOT_FOUND` (trang không có video — **không bịa**) |

### 2.2 Điều đã ĐO là KHÔNG chạy được

**a) `item.taobao.com/item.htm?id=<id>` — chặn đăng nhập với MỌI id**

```
id THẬT 671021594308  →  http 200, 5044 bytes   (stub đăng nhập)
id GIẢ  678901234567  →  http 200, 5044 bytes   (Y HỆT NHAU)
```

Hai phản hồi **giống hệt nhau về số byte**, nên route này không phân biệt được sản phẩm thật
với sản phẩm không tồn tại. `detail.tmall.com/item.htm?id=` cũng vậy (5047 byte).

**b) API H5 — bị anti-bot chặn từ bước đầu**

`h5api.m.taobao.com` và `acs.m.taobao.com` trả về challenge x5sec:

```
window.location.href = "https://h5api.m.taobao.com:443/h5/mtop.taobao.detail.getdetail/6.0/_____tmd_____/page/set_x5referer?..."
```

Cookie duy nhất nhận được là `x5secdata`; **`_m_h5_tk` không bao giờ được trả về**, nên không
thể bắt đầu bắt tay token và ký md5 không tới được. Đã thử: sign rỗng, sign sai, cookie jar mới,
có/không `Referer`+`Origin`. Tất cả đều bị chặn.

### 2.3 Hệ quả thiết kế

Connector dùng `world.taobao.com` làm **route tải ẩn danh**, còn `item.taobao.com` chỉ giữ vai
trò URL canonical. Khi người dùng dán link `item.taobao.com`, connector **tự chuyển** sang route
ẩn danh và ghi lại việc đó vào `extraction.method` + `warnings`.

Để lấy được SKU/biến thể đầy đủ (route ẩn danh không trả `skuBase`), cần session đăng nhập thật
qua `SESSION_MODE=cdp` → khi đó mức sẽ là `AUTHENTICATED_LIVE_VERIFIED`.

---

## 3. 1688 — `PARTIAL`

### 3.1 Trang chi tiết offer — ĐÃ đo được trang thật (từ IP sạch)

```
https://detail.1688.com/offer/555231932025.html
  → http 200, 171586 bytes, final URL KHÔNG đổi (không redirect wrongpage)
  → <title>涂鸦WiFi智能开关通断器WIFI+433大功率30A计量遥控语音灯具开关 - 阿里巴巴</title>

https://detail.1688.com/offer/552160420012.html
  → http 200, 51936 bytes, final URL không đổi
  → <title>厂家定制高品质七彩毛毛虫千足玩具公仔创意长形公仔抱枕鑰虫満批 - 阿里巴巴</title>
```

Đây là bằng chứng 1688 **phục vụ trang thật cho id thật khi truy cập ẩn danh**.

### 3.2 IP đo hiện tại ĐÃ BỊ CHẶN TẦN SUẤT

1688 giới hạn rất chặt: request đầu từ một IP sạch trả trang thật, các request sau bị chặn.
Sau khi đo, IP này nhận:

```
offer/555231932025.html  → http 200, 4822 bytes  (tường đăng nhập: "action":"login")
offer/552160420012.html  → http 200, 2825 bytes  (challenge x5sec: punish + captcha)
```

**Ba phản hồi HTTP 200 phải phân biệt được** — connector phân loại theo dung lượng:

| Dung lượng | Nghĩa |
|---|---|
| > 50 KB | trang offer thật |
| ~4822 B | tường đăng nhập |
| ~2825 B | challenge x5sec (`punish`) |
| redirect `page.1688.com/shtml/static/wrongpage.html` | offer không tồn tại |

Cả ba trường hợp chặn đều được báo `LOGIN_REQUIRED` kèm `blocked_reason` nêu rõ dung lượng và
loại chặn — **không** báo thành công, **không** bịa field.

### 3.3 Bằng chứng bổ sung: các offer đó là THẬT

Vì trang chi tiết bị chặn tần suất, đã xác minh tính thật của offer bằng API tìm kiếm ẩn danh
của chính 1688 (`search.1688.com/service/marketOfferResultViewService`), và API này vẫn trả
dữ liệu thật cho đúng hai offer trên: tiêu đề, ảnh bìa (`cbu01.alicdn.com`), tên công ty
(`东莞市爱笙玩具有限公司`), thuộc tính, `detailUrl`.

### 3.4 Việc cần làm để đạt `LIVE_VERIFIED` đầy đủ

- Chờ hết thời gian chặn, hoặc dùng IP/proxy khác, rồi chạy lại `tools/live-probe.mjs`.
- Hoặc dùng `SESSION_MODE=cdp` với Chrome đã đăng nhập → `AUTHENTICATED_LIVE_VERIFIED`.
- **Chưa đo:** parser 1688 trên trang thật >50 KB. Hiện parser mới được kiểm bằng fixture dựng
  theo đúng cấu trúc `__INIT_DATA__` với dữ liệu thật của offer `552160420012`. Đây là điểm
  cần đo lại khi có trang thật — ghi rõ ở đây thay vì để người đọc tự suy.

---

## 4. Pinduoduo — `AUTH REQUIRED`

### 4.1 Điều đã ĐO được

```
https://mobile.yangkeduo.com/goods.html?goods_id=<BẤT KỲ>
  → http 200, 63552 bytes, md5 d273f68add4aff0976fcd309c8de3d7a
```

**Cùng một md5 cho mọi `goods_id`** — kể cả id thật, id giả, và id rác 18 chữ số. Trang là một
React SPA shell rỗng, không chứa `goods_id`, `goodsName`, `window.rawData`, `__NEXT_DATA__` hay
`__INITIAL_STATE__` nào.

Các chuỗi `登录` / `验证` tìm thấy trong trang là **literal trong bundle JS**
(`__ENABLE_ALERT_WECHAT_LOGIN__`, `请登录后再操作`, `验证失败` trong `window.__ERROR_FILTER_LIST__`),
**không phải** tường đăng nhập do server render. Vì vậy không thể dựa vào chuỗi để kết luận.

**Hệ quả quan trọng:** `curl` **không thể phân biệt** `goods_id` thật với `goods_id` giả trên PDD.
Đây là lý do connector PDD báo `LOGIN_REQUIRED` chứ không báo `NOT_FOUND` cho id sai — vì nó
thật sự **không biết**.

### 4.2 API nội bộ cũng chặn

```
POST https://mobile.yangkeduo.com/proxy/api/api/oak/integration/render
  → 403 {"success":false,"error_code":40001,"error_msg":"请登录后再操作"}
```

Đã thử kèm cookie làm ấm (`api_uid`, `pdd_vds`), UA iPhone, `Referer`/`Origin` đúng, body JSON
đúng. Vẫn 403.

Theo tài liệu công khai của các dự án scraper PDD: mọi API của PDD đòi header `anti-content` —
một token hành vi `0as...` sinh động bên trong JS của chính trang, **không tái tạo được** ngoài
trình duyệt — cộng với cookie `PDDAccessToken` + `pdd_user_id` có hạn ~1 giờ.

### 4.3 Hệ quả thiết kế

Connector PDD thử **đúng thứ tự mà đề bài yêu cầu**:

1. canonical link resolution → 2. public/SSR page data → 3. browser network data →
4. authenticated browser-session adapter

Bước 3 và 4 cần `SESSION_MODE=cdp` (Chrome thật qua DevTools Protocol). Đã cài sẵn:
`CdpSessionProvider` lấy cookie qua `Storage.getCookies` và **render trang bằng JS thật**
(`Target.createTarget` + `Page.navigate` + `Runtime.evaluate`).

**Chưa đo:** render PDD qua CDP có ra dữ liệu sản phẩm hay không — cần Owner bật
`SESSION_MODE=cdp` với Chrome đã đăng nhập PDD. Đây là kết quả trung thực, không phải suy đoán.

---

## 5. Những gì KHÔNG được kiểm chứng và phải nói rõ

| Hạng mục | Trạng thái | Vì sao |
|---|---|---|
| Parser 1688 trên trang >50 KB thật | **chưa đo** | IP bị chặn tần suất sau lượt đo đầu |
| Lấy SKU/biến thể Taobao | **chưa đo** | route ẩn danh không trả `skuBase`; cần session |
| PDD có dữ liệu qua CDP render | **chưa đo** | cần Owner bật Chrome đăng nhập |
| Ảnh chi tiết (`detail`) của Taobao | `NOT_FOUND` | trang ẩn danh không trả HTML mô tả |
| Deploy staging | **chưa làm** | xem báo cáo cuối phiên |

## 6. Cách tự kiểm lại

```bash
# Thăm dò năng lực provider AI (text / JSON / vision)
node tools/provider-probe.mjs

# Chạy 4 ca nghiệm thu A/B/C/D trên link THẬT
node tools/live-probe.mjs

# Toàn bộ test (không cần mạng)
npm test
```

**Luật của tài liệu này:** một dòng chỉ được ghi `LIVE_VERIFIED` khi có lệnh thật tạo ra nó.
Nếu chỉ chạy bằng fixture, phải ghi `MOCK_VERIFIED`.

---

## 7. Verifier độc lập đã bác hai tuyên bố — và đã sửa

Ngày 03/10/2026, một **verifier độc lập** được chạy để cố tình phá các tuyên bố trong tài liệu này.
Kết quả: **VERDICT FAIL** — hai tuyên bố bị bác, và cả hai đều là tuyên bố mà sản phẩm dựa vào.

| Tuyên bố | Kết quả | Sửa thế nào |
|---|---|---|
| Guardrails chống bịa hiệu quả | **BÁC** — 42/79 cách nói vòng lọt lưới | Siết lên **11 nhóm luật**; bỏ `\b` quanh từ tiếng Việt; cắt **bằng chứng vòng**; khoá bằng test |
| Nhãn MOCK vs LIVE trung thực | **BÁC** — master dựng từ fixture vẫn bị ghi `LIVE_VERIFIED` | Nhãn nay do **`extraction.transport`** quyết định, không do "có field hay không" |

### 7.1 Bằng chứng vòng — lỗ hổng nặng nhất

Bản dịch (`translation.title_vi`) do **chính model** sinh ra, bị gắn nhãn `inference`, nhưng lại
được đưa vào bằng chứng; `checkContent` sau đó miễn kiểm cho bất cứ câu nào tìm thấy trong bằng chứng.
Hệ quả đo được: nội dung *"Bảo hành 12 tháng, chống nước IP68"* cho **4 vi phạm** khi bằng chứng rỗng,
nhưng **0 vi phạm, `passed = true`** khi bản dịch của model đã nói điều đó trước.

Tức là model **tự rửa tội cho chính mình** qua bước dịch — không cần biết gì về regex.
**Đã sửa:** bằng chứng chỉ nhận fact có provenance `source` / `vision` / `user`; mọi fact
`inference` bị loại.

### 7.2 `\b` của JavaScript chỉ hiểu ASCII

JS coi `\w` là `[A-Za-z0-9_]`. Vì vậy `\b(?:…|đạt chuẩn|…)` **không bao giờ** khớp với "đạt chuẩn",
và `\bđược đánh giá\b` cũng vậy — hai nhánh luật là **mã chết** suốt thời gian tồn tại.
**Đã sửa:** bỏ `\b` quanh mọi từ tiếng Việt, và thêm một test kiểm bằng **hình dạng regex lẫn hành vi**
để lớp lỗi này không quay lại.

### 7.3 Nhãn LIVE bị gán sai

`determineVerificationLevel` chỉ nhìn `isMock` (vốn chỉ nói về provider **sinh nội dung**) và xem
master có tiêu đề/ảnh hay không — **không hề nhìn nguồn gốc trích xuất**. Verifier dựng được ca:
một master dựng HOÀN TOÀN từ fixture, qua fetcher giả, **không mở socket nào**, vẫn được ghi
`LIVE_VERIFIED` vào cả blob JSON lẫn cột `extraction_evidence.verification`.

**Đã sửa:** cổng chặn là `extraction.transport` — chỉ `'http'` (do chính `safeFetch` gắn, fetcher giả
không gắn được) mới được xét `LIVE_VERIFIED`. Dữ liệu người dùng tự nhập có mức riêng: `MANUAL_INPUT`.
Có test chạy **Pipeline thật + Store thật** để khoá lại.

### 7.4 Các lỗi khác verifier tìm ra và đã sửa

| Lỗi | Mức | Đã sửa |
|---|---|---|
| Không có ai nghe `queue.on('failed')` → job lỗi để `status='running'` mãi, UI quay vô tận | MAJOR | Thêm handler ghi `status='failed'` + lỗi vào job |
| `evidenceTable` lấy `arr.length` làm "FOUND" → ảnh `LOGIN_REQUIRED` hiện thành `FOUND` | MINOR | Đếm theo `status`; lý do lấy từ `field_status` **và** từ chính phần tử mảng |
| `blockedMaster` không đặt `error_code` → nhánh UNSUPPORTED là mã chết, luôn trả BLOCKED | MINOR | Đặt `error_code`; xét UNSUPPORTED **trước** cổng transport |
| Nhánh lỗi chỉ đặt 4/8 field, 4 field còn lại rơi về NOT_FOUND | MINOR | Đặt đủ 8 field cùng một lý do; bỏ no-op `{...prev, ...{}}` |
| PDD: trang không đọc được mà vẫn khẳng định `video = NOT_FOUND` | MINOR | Đổi thành `LOGIN_REQUIRED` — "chưa biết", không phải "không có" |
| `decodeURIComponent` lỗi → HTTP 500 thay vì 400 | MINOR | Bọc `try/catch` → `HttpError 400 BAD_ENCODING` |
| `isPrivateAddress('::127.0.0.1')` trả `false` (chỉ xử lý `::ffff:`) | MINOR | Thêm nhánh IPv4-compatible |
| `src/env.js` nuốt lỗi đọc `.env` → chạy bằng mặc định trong im lặng | MINOR | Fail-fast, nêu rõ tên file |

### 7.5 Verifier xác nhận ĐẠT

Tests · **SSRF (pinning DNS chứng minh end-to-end bằng cách đầu độc `dns.lookup`)** ·
cô lập connector · schema Product Master đồng nhất 3 nguồn · không có secret · router định tuyến đúng.

> **Bài học giữ lại:** verifier bác đúng hai thứ mà em tự tin nhất. Nếu chỉ tự kiểm, hai lỗi này
> sẽ nằm nguyên trong bản giao. Đây là lý do bước verifier độc lập không được bỏ.

---

## 8. MVP-02 — phản biện độc lập (lượt 1: FAIL → đã sửa 8 phát hiện)

Báo cáo đầy đủ (nguyên văn, **không sửa**): [`docs/MVP-02-REVIEW.md`](MVP-02-REVIEW.md).
Tám phát hiện F-01…F-08 đã được sửa; phần chưa sửa được ghi rõ ở §8.3.

### 8.1 Điều đã sửa (kèm bằng chứng chạy lại)

| # | Nội dung | Bằng chứng |
|---|---|---|
| F-01 (CRITICAL) | Hộp của vùng `brand/certification/price` giờ là **vùng bảo vệ ở ba tầng**: (1) pipeline không dựng op nào giao với hộp bảo vệ (`BOX_OVERLAPS_PROTECTED`), (2) provider `purejs` phủ **mặt nạ pixel** — op bị chặn một phần thì chỉ vẽ ngoài vùng bảo vệ, bị chặn toàn bộ thì vào `skipped` (`PROTECTED_BOX_MASKED`), (3) `normalizeRegions` khử trùng theo **mức bảo vệ** khi hai vùng cùng hộp khác chữ, và cảnh báo mọi cặp hộp giao nhau | `node /tmp/atk2/f01-overlap.mjs`: 3 ca của phản biện + 1 ca có render thật → `PIXEL VÙNG NHÃN HIỆU BỊ ĐỔI: 0/8000`, `PIXEL VÙNG CHỨNG NHẬN BỊ ĐỔI: 0/8840` |
| F-02 (MAJOR) | `allow_brand_override` có tác dụng thật: vùng brand/cert/price **chỉ** được vẽ khi dòng có vết (`edited_by_user` + `provenance='user'` + có chữ Việt); ghi `applied[].override`, `asset.meta.overrides`, và warning tiếng Việt | `node /tmp/atk2/f02-override.mjs`: nhánh 1 pixel brand đổi **0**, nhánh 2 đổi **8000** kèm `meta.overrides`, nhánh 3 (không vết) đổi **0** |
| F-03 (MAJOR) | `GET /api/imagelab/jobs/:id` trả `mock_steps` + `providers_snapshot` đọc từ dữ liệu **đã lưu của job**; UI ưu tiên dấu vết job và chỉ hiện "provider hiện tại" như thông tin phụ | `node /tmp/atk2/f03-label.mjs`: khởi động lại server với provider THẬT trên cùng DB → `mock_steps: ["ocr","translate"]`, hàm `renderIlWarnings` THẬT của UI vẫn hiện nhãn MOCK |
| F-04 (MINOR) | Bốn route MVP-01 cũ kiểm quyền sở hữu theo session → **404** (xem §8.2 về giới hạn) | `node /tmp/atk/f2-migration.mjs`: session B nhận `404` ở cả `GET`, `/usage`, và `PUT .../content`; nội dung của A không đổi |
| F-05 (MINOR) | `HttpError` có cờ `expose`; các lỗi an toàn (`NOT_CONFIGURED`, `IMAGELAB_UNAVAILABLE`, `REVIEW_REQUIRED`, `IMAGELAB_NO_LINES`) trả ĐÚNG câu tiếng Việt đã viết, vẫn không lộ stack | `node /tmp/atk/b4-ops.mjs`: `502 {"code":"NOT_CONFIGURED","message":"Provider OCR/dịch chưa được cấu hình — chưa thể dịch ảnh."}` |
| F-06 (MINOR) | Tách `SKIPPED_BY_USER` (người dùng bỏ qua) khỏi `NEEDS_REVIEW` (guardrail chặn); cổng 409 chỉ nhìn `status`; `force` ghi cảnh báo "KHÔNG được vẽ" | `node /tmp/atk2/f06-gate.mjs`: dòng bịa (dù `edited_by_user=true`) → `409 REVIEW_REQUIRED`; `skip` → `SKIPPED_BY_USER`, render `202`, vào `skipped` |
| F-07 (MINOR) | Toàn bộ test MVP-02 (kể cả test pixel mức hộp) đã được commit cùng mã nguồn | `npm test` — xem §8.3 |
| F-08 (MINOR) | Guardrail: bỏ ký tự vô hình trước mọi phép so khớp, `\p{Nd}` cho mọi bộ chữ số Unicode, số viết bằng chữ tiếng Việt + đơn vị, và kana/Hangul tính là "CHƯA DỊCH" | `node /tmp/atk/a4-guardrails.mjs`: 5 ca từng lọt đều bị BẮT; các ca âm tính (`500毫升`→"500 ml", `保修12个月`→"Bảo hành 12 tháng") vẫn `TRANSLATED` |

### 8.2 `session_id` KHÔNG phải xác thực — nói thẳng mức bảo vệ thật

Phản biện F-04 chỉ ra (đúng) rằng job ImageLab còn tới được bằng route MVP-01 cũ. Đã áp cùng
chính sách 404 theo session cho bốn route đó. **Nhưng phải đọc đúng mức bảo vệ:**

- `sid` là cookie **do client gửi** — không phải đăng nhập, không có chữ ký, không có máy chủ
  xác minh. Ai biết `job_id` và tự đặt cookie `sid` của người khác vẫn đọc/ghi được.
- Vì vậy "404 theo session" là **chống truy cập nhầm**, KHÔNG phải hàng rào bảo mật. Request
  không khai cookie session nào được coi là khách ẩn danh (hành vi MVP-01 giữ nguyên, để không
  phá luồng dùng không-cookie); riêng job `kind = 'image_translation'` thì luôn đòi session khớp.
- `GET /api/jobs?scope=all` vẫn liệt kê job của mọi phiên — **tính năng lịch sử có chủ ý**.
- Việc phân vùng thật (tài khoản + quyền) thuộc **MVP-05**.

### 8.3 Còn lại / chưa sửa được

- **Chất lượng provider THẬT** (OCR/dịch/render trả tiền) vẫn chưa đo — mọi bằng chứng ở trên
  chạy bằng `mock` + `purejs`. Không có kết luận nào về model thật.
- **Guardrail vẫn là regex**: các biến thể chính tả (`"tốt nhứt"`) hoặc cách nói vòng chưa có
  trong danh sách vẫn lọt. Đây là giới hạn của phương pháp, đã ghi rõ để không ai đọc thành
  "guardrail chặn mọi ca bịa".
- **PostgreSQL**: nhánh migration `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind` chưa chạy thật
  (không có `DATABASE_URL`).
- **Trình duyệt thật**: UI được kiểm bằng cách trích và chạy hàm render thật trong Node, chưa mở DOM.

---

## 9. MVP-02 — vòng săn lỗ hổng thứ ba (7 test `skip` → đã vá, đã gỡ skip)

Agent test độc lập (commit `701f3ae`) ghi lại 7 lỗ hổng bằng 7 test bị `skip` có chủ đích.
Vòng 3 vá hết và **gỡ `skip`**; tổng kết: `npm test` → **392 test · 391 pass · 0 fail · 1 skipped**
(1 skip còn lại là PostgreSQL có sẵn từ MVP-01, không có `DATABASE_URL`).

| # | Lỗ hổng | Đã vá gì | Bằng chứng (test đã gỡ skip) |
|---|---|---|---|
| F-08a | "…một trăm hai mươi nghìn đồng" lọt vì `COUNTED_UNITS` thiếu đơn vị tiền tệ | thêm `đồng/vnđ/vnd/đ/nghìn/nghàn/ngàn/triệu/tỷ/tỉ` vào bộ đơn vị bắt số-viết-bằng-chữ | `✔ giá bịa bằng CHỮ + đơn vị tiền tệ ("…nghìn đồng") phải bị bắt` |
| F-08b | ①② là `\p{No}` nên luật `\p{Nd}` không thấy | thêm `checkSpecialNumerals()` cho `\p{No}` + `\p{Nl}` (số La Mã), soi trên văn bản GỐC | `✔ chữ số khoanh tròn ①② phải bị bắt` |
| F-08c | từ khoá viết FULL-WIDTH Latin ("ｂảo hành") không khớp | `normalizeForMatch` dùng **NFKC** thay NFC | `✔ từ khoá viết bằng chữ FULL-WIDTH Latin ("ｂảo hành") phải bị bắt` |
| H-1 | kẹp hộp có toạ độ ÂM bị NỚI RỘNG (dời gốc, giữ `w`/`h`) ⇒ vùng hợp lệ bị `BOX_OVERLAPS_PROTECTED` chặn oan; `box_normalized` sai | thêm `src/imagelab/geometry.js` (`intersectBoxWithImage` = GIAO với khung ảnh) và dùng chung ở `ocr/normalize.js`, `pipeline.js#clampBox`, `render/image.js#clampBox` | `✔ H-1a`, `✔ H-1b`, `✔ H-1c` (hộp `{x:-30,w:240}` trên ảnh 320 → `{x:0,w:210}`) |
| H-2 | `render({ ops: [] })` trả `OK` + ảnh y hệt gốc + không cảnh báo | `RENDER_CODES.NO_OPS`: `applied` rỗng ⇒ `PARTIAL` + `error_code` + cảnh báo tiếng Việt; pipeline ghi `meta.error_code` + cảnh báo nổi bật | `✔ H-2: render với 0 op không được báo OK im lặng` |

### 9.1 Một kỳ vọng CŨ của test do lỗi H-1 mà ra — đã sửa và nói rõ

`test/imagelab-ocr.test.js` → test *"toạ độ lẻ bị cắt thành số nguyên; hộp tràn biên bị kẹp
vào ảnh"* trước đây khẳng định hộp `{ x: -50, y: -30, w: 100, h: 60 }` (ảnh 1000×100) phải
được kẹp thành `{ x: 0, y: 0, w: 100, h: 60 }`. **Kỳ vọng đó mã hoá đúng lỗi H-1**: phần hộp
nằm trong ảnh chỉ là `x ∈ [0, 50)`, `y ∈ [0, 30)`, nên kết quả ĐÚNG là `{ x: 0, y: 0, w: 50, h: 30 }`.
Đã sửa kỳ vọng kèm chú thích trong test (không sửa `src/**` cho vừa test).

### 9.2 Vì sao các ca âm tính vẫn xanh

NFKC + luật `\p{No}`/`\p{Nl}` + đơn vị tiền tệ đều được kiểm chống dương tính giả:
`"Áo thun cotton thoáng mát, đường may chắc chắn"`, `500毫升 → "500 ml"`,
`保修12个月 → "Bảo hành 12 tháng"`, `三年质保 → "Bảo hành ba năm"` (số viết bằng chữ nhưng
chữ gốc CÓ đúng số đó), `防水IP68 → "Chống nước IP68"` đều `TRANSLATED`, `violations = []`.

---

## 10. MVP-02 — vòng 4: thoả 3 điều kiện của phản biện vòng 2 (N-5/N-1/N-2) + N-3/N-4/N-6/N-7

Phán quyết vòng 2: **PASS CÓ ĐIỀU KIỆN** (`docs/MVP-02-REVIEW.md`, mục “VÒNG 2 — chấm lại”).
Đã vá hết và đo lại. `npm test` → **408 test · 407 pass · 0 fail · 1 skipped** (skip duy nhất là
PostgreSQL của MVP-01); `node tools/verify.mjs` EXIT=0; `node tools/imagelab-demo.mjs` → `succeeded`.

### 10.1 Ba điều kiện bắt buộc

| Điều kiện | Đã sửa gì | Bằng chứng (chạy lại script của phản biện) |
|---|---|---|
| **1 — N-5** `RENDER_PROVIDER=http` không được tin remote | Hậu kiểm ở `RenderProvider.render()`: sha256 trùng ảnh gốc ⇒ bỏ `applied` + `PARTIAL`/`NO_OPS`; PNG mà pixel hộp bảo vệ đổi (hoặc khác kích thước) ⇒ **TỪ CHỐI LƯU** `FAILED PROTECTED_PIXELS_CHANGED`; không phải PNG ⇒ `protected_pixels_verified=false` + `PARTIAL PROTECTED_PIXELS_UNVERIFIED` + cảnh báo; `applied` khai nhiều hơn gửi ⇒ `RENDER_APPLIED_MISMATCH` | `cd /tmp/atk4 && node x9-http-provider.mjs` — `naive`: `rs.status:"OK"`, brand `0/8000`, vùng sạch `6000/6000`; **`liar`**: `job: succeeded "RENDER_NO_OPS"`, `rs.status:"PARTIAL" rs.error_code:"NO_OPS" applied: []`, cảnh báo “khai đã áp dụng 1/1 op nhưng ảnh trả về Y HỆT ảnh gốc”; **`evil`**: `job: failed "PROTECTED_PIXELS_CHANGED"` (không lưu ảnh, không có `rs`) |
| **2 — N-1** toạ độ NULL/rác không được thành 0 | `strictCoordinate()` trong `geometry.js` (dùng chung `normalize.js`/`pipeline`/`render`); `#boxOf` lấy `box_normalized` khi `box` hỏng; cả hai hỏng ⇒ `BAD_BOX_COORDINATE`; hộp bảo vệ không xác định được ⇒ chặn MỌI op (fail-closed) | `cd /tmp/atk4 && node x3b-poison-targeted.mjs` ca `x3b-nullx`: `skipped: [["r2","Vùng nhãn hiệu…"],["r1","BOX_OVERLAPS_PROTECTED: r2 (brand)…"]]` và `➜ pixel đổi | nhãn hiệu THẬT [200,100,100,40]: 0/4000` (trước vá: `2800/4000`). `node x13-final-probe.mjs`: `intersectBoxWithImage` với `x=null/''/[]/true/false/w=null` đều → `null` |
| **3 — N-2** job phải mang `error_code` khi 0 op được vẽ | `job.error_code = 'RENDER_NO_OPS'` (+ `error_message`) khi `applied.length === 0` mà ảnh mới vẫn được lưu; không có ảnh ⇒ `failed` | `cd /tmp/atk4 && node x3-api-noops-poison.mjs` ca `x3b-noglyph`: `job: succeeded | error_code: "RENDER_NO_OPS" | rs.status: "PARTIAL" | rs.error_code: "NO_OPS" | applied: []`; ca `x3a-dims` (chỉ có vùng nhãn hiệu): `job: failed "IMAGELAB_NO_LINES"` |

### 10.2 Bốn phát hiện phụ

| # | Đã sửa gì | Bằng chứng |
|---|---|---|
| N-3 | `Store.listJobs` trả thêm `kind` + `content_meta`; `GET /api/jobs` mỗi dòng có `kind`, `mock`, `mock_steps` (không lộ `session_id`/`content_meta` thô); UI lịch sử có badge “Dịch ảnh” + “MOCK” | `node /tmp/gop4/n3-list.mjs`: `job DỊCH ẢNH (mock) → {"kind":"image_translation","mock":true,"mock_steps":["ocr","translate"]}`; chạy hàm UI THẬT `historyItemHtml` → `"... Dịch ảnh MOCK awaiting_review"` (badge MOCK ✓, badge Dịch ảnh ✓); `có lộ session_id? false` |
| N-4 | `only_region_ids` fail-closed: không id nào khớp ⇒ `409 UNKNOWN_REGION_IDS` + `unknown_region_ids`; khớp một phần ⇒ render phần khớp + cảnh báo | `node /tmp/atk4/x12-500-leak.mjs`: `POST render only_region_ids = [null, 1, {}] → 409 {"code":"UNKNOWN_REGION_IDS",…}` (trước vá: `202`) |
| N-6 | So khớp thêm bản KHÔNG DẤU (`deaccent`) cho từ khoá khẳng định + cụm số-bằng-chữ; thêm `№` | `node /tmp/atk4/x5-f08-guardrails.mjs`: phần “không dấu” `✔ BẮT` cả 3 ca (`bao hanh`, `mot nam`); tổng lọt phần 1 còn **1/37** (chỉ `xii`) |
| N-7 | (a) sửa lookahead đơn vị (`\p{L}\p{N}` + cờ `u`) + nhánh ký hiệu `%` + `unitAppearsInText`; (b) bỏ danh từ đếm khỏi `COUNTED_UNITS` | `node /tmp/atk4/x5c-glued-fp.mjs`: `纯棉100%T恤 → "Áo thun cotton 100%"` nay `TRANSLATED`; `node /tmp/atk4/x5b-units-fp.mjs`: `Một chiếc áo thun cotton → TRANSLATED` (0 vi phạm) trong khi `một trăm hai mươi nghìn đồng` vẫn bị BẮT |

### 10.3 Còn lọt / chưa vá được (nói thẳng)

- **`xii`** (số La Mã viết bằng chữ ASCII thường) và **homoglyph** (Kirin `а/о/һ`, Greek `α`),
  **“tốt nhứt”** (sai chính tả): không phân biệt được với từ thật bằng regex mà không tăng dương
  tính giả; **giữ nguyên là giới hạn đã biết** của lớp guardrail (`x5-f08`: còn lọt 1/37 ca).
- **Dương tính giả đã chấp nhận có ý thức:** `"½"`/`"¾"` (NFKC → chữ số) và `"№1"` vẫn bị coi là
  số liệu khi chữ gốc không có — theo đúng kết luận của phản biện, đây là **bắt đúng**.
- **Provider `http` chỉ được hậu kiểm theo những gì đo được:** pixel vùng bảo vệ chỉ kiểm được
  khi ảnh trả về là PNG; với JPEG/WebP hệ thống **nói thẳng** `protected_pixels_verified = false`
  + cảnh báo, KHÔNG khẳng định đã kiểm.
- Vẫn chưa đo: một service render `http` THẬT (trả tiền), PostgreSQL, trình duyệt thật,
  `data/studio.db` thật, hai request render đồng thời.

---

## 11. MVP-02 — vòng 5: vá điều kiện cuối của phản biện vòng 3 (N-1 store) + N-8/N-9/N-10/N-11

Phán quyết vòng 3 (`docs/MVP-02-REVIEW.md`, mục “VÒNG 3 — chấm lại”): **PASS CÓ ĐIỀU KIỆN —
không còn CRITICAL/MAJOR**, với **một điều kiện còn lại** (`store.toNum` biến chuỗi khoảng trắng
thành `0` ⇒ hộp nhãn hiệu "ảo" ⇒ F-01 tái sinh) và 4 phát hiện MINOR (N-8…N-11).

Đã vá và **chạy lại chính script của phản biện** (người điều phối chạy, không phải phản biện tự chấm
lại — nói rõ để không ai đọc nhầm mức độ độc lập):

| # | Đã sửa gì | Bằng chứng (script của phản biện, chạy lại sau khi vá) |
|---|---|---|
| **N-1 (store)** | `store.toNum` dùng cùng luật `strictCoordinate`: chuỗi khoảng trắng/hex/boolean/mảng ⇒ `null`, KHÔNG thành `0`/`16` | `cd /tmp/atk5 && node x26-n1-store-gap.mjs` → `STORE trả về box của vùng nhãn hiệu: {"x":null,...}` và `➜ PIXEL VÙNG NHÃN HIỆU THẬT [200,100,100,40] BỊ ĐỔI: 0/4000` (trước vá: `x:0` ⇒ `2800/4000`) |
| **N-8a** | Ảnh remote cùng pixel khác byte + khai `applied` ⇒ so PIXEL trong hộp op, không tin lời khai | `node x21-n5-blindspot.mjs` chế độ `reencode-chunk` → `status="PARTIAL"`, `rsErr="NO_OPS"`, `applied=0`, cảnh báo “Provider khai đã áp dụng 1/1 op nhưng PIXEL trong hộp các op KHÔNG đổi” |
| **N-8b** | Remote chỉ đổi 1 pixel NGOÀI hộp op ⇒ không báo `OK` | cùng script, chế độ `stray-pixel` → `PARTIAL` + `NO_OPS`, `applied=0` |
| **N-8c** | Ảnh sai kích thước (kể cả job không có vùng bảo vệ) ⇒ từ chối lưu | cùng script, chế độ `nobrand-small` → `job=failed`, `jobErr="RENDER_SIZE_MISMATCH"`, `ảnhMới=0` |
| **N-9** | Bổ sung đơn vị đo lường ⇒ `500克 → "500 tấn"` bị bắt; `500克 → "500 gram"` vẫn `TRANSLATED` | `node x24-old-vs-new.mjs` → dòng `(N-9) 500克 → "500 tấn"` : `lọt → BẮT`; `test/imagelab-round5-hardening.test.js` |
| **N-10** | Nhánh bỏ dấu chỉ áp dụng khi văn bản ứng viên KHÔNG có dấu tiếng Việt | `node x24-old-vs-new.mjs` → `"Chỉnh hàng"`, `"Đất chuẩn bị trồng"`, `"Tột nhất"` đều **không còn bị tố oan**, trong khi `"bao hanh mot nam"` vẫn bị bắt |
| **N-11** | `only_region_ids: []` ⇒ `400 EMPTY_REGION_IDS`; vắng mặt ⇒ render tất cả; id rác ⇒ `409 UNKNOWN_REGION_IDS` | `test/imagelab-round5-hardening.test.js` (2 ca HTTP thật) |

`npm test` sau vòng 5 → **425 test · 424 pass · 0 fail · 1 skipped** (skip duy nhất vẫn là
PostgreSQL của MVP-01, không có `DATABASE_URL`); `node tools/verify.mjs` EXIT=0;
`node tools/imagelab-demo.mjs` → job `succeeded`.

### 11.1 Còn lọt / chưa vá được sau vòng 5 (nói thẳng)

- **`xii`** (số La Mã ASCII thường), **homoglyph** (Kirin/Greek), **“tốt nhứt”** (sai chính tả):
  regex không phân biệt được với từ thật nếu không tăng dương tính giả — giữ nguyên là giới hạn
  đã biết (tổng còn lọt **1/37** ca của phản biện).
- **`3件装` → “3 bộ”**: danh từ đếm đã bị loại khỏi `COUNTED_UNITS` (để chữa dương tính giả N-7b),
  nên cụm đếm thuần túy không còn bị bắt. Đây là **đánh đổi có ý thức**: thà bỏ sót một cụm đếm
  vô hại còn hơn tố oan mọi câu có “một chiếc / một bộ”.
- **Phản biện chưa tự chấm lại vòng 4**: các script của họ đã được chạy lại và đều đạt, nhưng
  phán quyết “PASS” cuối cùng vẫn nên do chính agent phản biện đưa ra ở vòng kế tiếp.
- Vẫn chưa đo: provider thật (OCR/dịch/render trả tiền), PostgreSQL, trình duyệt thật,
  `data/studio.db` thật, hai request render đồng thời, `test/imagelab-round5-hardening.test.js`
  không phủ provider `http` thật (chỉ mô phỏng bằng provider giả kế thừa `RenderProvider`).

---

## 12. MVP-02 — PHÁN QUYẾT CUỐI: **PASS** (phản biện vòng 4, commit `9db4090`)

Agent phản biện độc lập chấm lần cuối và kết luận **PASS** (`docs/MVP-02-REVIEW.md`, mục
“VÒNG 4 — chấm cuối”, giữ nguyên cả 3 lượt trước). Họ tự đo: `npm test` 425 · 424 pass · 0 fail
· 1 skip; `node tools/verify.mjs` EXIT=0. Cả 5 mục của vòng 3 (N-1 store, N-8, N-9, N-10, N-11)
**đều đạt**; 17 test hồi quy do người điều phối viết được họ đọc hết và xác nhận **không có test
vô nghĩa**.

Hai lỗ hổng MINOR còn lại đã được vá ngay sau đó (vòng 6) và có test hồi quy:

| # | Đã sửa gì | Bằng chứng |
|---|---|---|
| **N-12** | Hậu kiểm **đến từng vùng**: `opEntries` chi tiết theo `region_id`; “đã vẽ” = có pixel **RGB** đổi (đổi mỗi alpha không tính); vùng không đổi bị bỏ khỏi `applied` + `PARTIAL` + `RENDER_APPLIED_MISMATCH` | `test/imagelab-round5-hardening.test.js` → “remote vẽ 1/2 op mà khai cả 2 ⇒ PARTIAL + bỏ vùng KHÔNG được vẽ” và “chỉ đổi kênh ALPHA ⇒ PARTIAL + NO_OPS” |
| **N-13** | Có op mà **không giải mã được** ảnh trả về (PNG palette/1-bit/interlaced…) và job **không có vùng bảo vệ** ⇒ `PARTIAL` + `RENDER_OUTPUT_UNVERIFIED` + cảnh báo, KHÔNG còn `OK` | cùng file → “PNG palette… ⇒ PARTIAL + RENDER_OUTPUT_UNVERIFIED” (dựng PNG palette thật bằng cách sửa IHDR + tính lại CRC) |

Sau vòng 6: `npm test` → **428 test · 427 pass · 0 fail · 1 skipped**; `npm run verify` EXIT=0;
`npm run demo:imagelab` → `succeeded`.

### 12.1 PASS nghĩa là gì — và KHÔNG nghĩa là gì

**Nghĩa là:** không còn phá được luật bất khả xâm phạm nào trong ~150 ca tấn công của phản biện;
toàn bộ 12 phát hiện của 3 vòng trước đã vá và được **kiểm lại độc lập** (không phải nhóm code tự
xác nhận).

**KHÔNG nghĩa là:**
- OCR / dịch / render **THẬT** đã được đo — mọi bằng chứng đều chạy bằng `mock` + `purejs` +
  server giả localhost. **Đây là mục chưa kiểm lớn nhất.**
- Chống được kẻ ghi trực tiếp vào DB (toạ độ đầu độc từ DB vẫn là giả định tấn công).
- `session_id` là xác thực — vẫn là phân vùng lịch sử, không phải bảo mật (MVP-05).
- Guardrail chặn mọi câu bịa — còn lọt `xii`, homoglyph, “tốt nhứt”, `3件装 → "3 bộ"` (§10.3, §11.1).
- JPEG/WebP được bảo vệ ở tầng pixel — hệ thống chỉ **nói thật** là `protected_pixels_verified = false`.
- Đã hết lỗi — vẫn còn N-12/N-13 vừa vá ở trên và các giới hạn đã ghi.

**Cách tự kiểm lại toàn bộ:** `npm test` · `npm run verify` · `npm run demo:imagelab` ·
`cd /tmp/atk6 && node x26-n1-store-gap.mjs` (script của phản biện).

### 12.2 CI trên GitHub — bằng chứng đo trên môi trường KHÁC (Linux)

PR [#20](https://github.com/thanhbn123/studio/pull/20) chạy 5 job, **tất cả PASS**:

| Job | Chứng minh được gì |
|---|---|
| Test (Node 24.x, SQLite) | Toàn bộ 428 test chạy trên Linux (khác macOS của Owner); gồm migration DB MVP-01 CŨ và `npm run demo:imagelab` |
| **Test (PostgreSQL 16)** | `schema.sql` + migration cộng thêm chạy được trên **PostgreSQL 16 THẬT** (3 bảng `image_assets`/`ocr_regions`/`translation_lines` + cột `jobs.kind` được tạo), rồi chạy bộ test trên PG |
| Smoke test (server khởi động thật) | Server boot thật, `/api/health` trả `imagelab.available = true`, trang chủ phục vụ được, SSRF vẫn bị chặn |
| Build Docker image | Image dựng được; container chạy health OK; **luồng MVP-02 chạy trong chính image**: sinh ảnh mẫu bằng `tools/` rồi `tools/imagelab-demo.mjs` → `succeeded` + nhãn `MOCK_VERIFIED` (ảnh ghi vào `/data`) |
| Quét secret | Không có `.env`/API key/cookie bị commit |

**Hai lỗi thật đã lộ ra khi chạy trên Linux** (máy macOS xanh, CI đỏ — đây là giá trị của việc
chạy trên môi trường khác):

1. `test/imagelab-render.test.js` đòi `encodePng(decodePng(fixture))` giống **từng byte** của file
   PNG có sẵn. Nén zlib là “tuỳ cài đặt”: cùng pixel nhưng macOS và Linux cho byte/độ dài khác
   nhau ⇒ **test sai, không phải codec sai**. Đã sửa thành: pixel round-trip y hệt + `encodePng`
   tất định với cùng input trong cùng tiến trình + không phình quá 4 lần.
2. Bước CI trong Docker gọi demo với fixture `test/fixtures/…`, nhưng image runtime **cố ý không
   chứa `test/`** ⇒ nay sinh ảnh mẫu bằng chính `tools/make-test-image.mjs` bên trong image.

**Vẫn chưa đo (dù CI xanh):** provider thật (OCR/dịch/render trả tiền) và trình duyệt thật (DOM).

### 12.3 Hai mục “chưa đo” đã đóng — có test thường trực

| Mục trước đây chỉ là tự kiểm | Nay là test trong repo | Kết quả đo |
|---|---|---|
| **Method store MVP-02 trên PostgreSQL** | `test/imagelab-store-postgres.test.js` (5 test, tự BỎ QUA khi không có `DATABASE_URL`): 3 bảng + `jobs.kind`, `init()` chạy LẦN HAI không lỗi, `createJob({kind})`/`getJob`/`listJobs`, **đủ 8 method** (image_assets, ocr_regions, translation_lines), tính **idempotent theo job**, mảng/JSON lồng nhau round-trip, `translatable`/`edited_by_user` giữ đúng boolean, `usage_event` `OCR_DETECT`+`IMAGE_RENDER`, job `awaiting_review` có `finished_at = null`. Mọi dữ liệu tạo ra đều được dọn theo `job_id` | Chạy thật trên **PostgreSQL 16.15** (máy Owner): 5/5 pass. Trên CI, job PostgreSQL 16 set `DATABASE_URL` nên file này cũng chạy ở đó |
| **Hai request render ĐỒNG THỜI trên cùng một job** | `test/imagelab-concurrency.test.js` (2 test): bắn 2 `POST /render` song song, khẳng định không 5xx, ảnh gốc bất biến (sha256 trên đĩa), mỗi request được nhận để lại **đúng một** asset `rendered` có `parent_id` đúng và `sha256` khớp byte trên đĩa, không có asset rác, job không treo `running`, và số `usage_event IMAGE_RENDER` = số request được nhận | Đo được: **cả hai đều 202** ⇒ tạo **2 asset riêng** (mỗi ảnh một bản ghi có cha chung), **2 usage_event**, `parent_id` đúng cả hai, ảnh gốc không đổi một byte |

Tổng sau khi thêm: `npm test` → **435 test · 434 pass · 0 fail · 1 skipped** (skip duy nhất là ca
“thiếu `DATABASE_URL`” trong `test/store.test.js`, chỉ chạy khi KHÔNG có PostgreSQL).

### 12.4 Vòng 6b — hai lỗ hổng guardrail vá được + phủ rate limit

Sau phán quyết PASS, còn hai nhóm lỗi guardrail được ghi là “còn lọt”. Một trong hai nhóm **vá
được mà không tăng dương tính giả**, nên đã vá:

| Lỗ hổng đã vá | Cách vá | Bằng chứng (`test/imagelab-f08-guardrails.test.js`) |
|---|---|---|
| **Homoglyph**: từ khoá viết bằng ký tự Kirin/Greek giống hình (“bảo hànһ”, “chống nướϲ”, “сhính hãng”) | `normalizeForMatch` gộp homoglyph Kirin/Greek về Latin (`foldHomoglyphs`). Lưu ý thứ tự: **NFKC chạy trước** nên `ϲ` (U+03F2) đã thành `ς` (U+03C2) và `Ϲ` thành `Σ` — phải map cả dạng SAU chuẩn hoá | 7 ca phải bắt đều `NEEDS_REVIEW`; 6 ca phải sạch (“Chỉnh hàng”, “Đất chuẩn bị trồng”, “Tột nhất”, “Áo thun cao cấp”, câu sạch) đều `TRANSLATED` |
| **Chính tả**: “tốt nhứt”, “chính hảng” | `SPELLING_VARIANTS` với lookaround `\p{L}` (**không** dùng `\b` — `\b` của JS chỉ hiểu ASCII, bài học MVP-01) | 2 ca phải bắt đều `NEEDS_REVIEW` |

Vẫn **cố ý KHÔNG vá** (đã ghi ở §10.3/§11.1 vì vá sẽ tăng dương tính giả): `xii` (số La Mã viết
bằng chữ ASCII thường — không phân biệt được với từ thật), `3件装 → "3 bộ"` (danh từ đếm đã bị loại
khỏi `COUNTED_UNITS` để chữa dương tính giả N-7b). Ghi chú thêm: “cao cấp” **không phải** từ khoá
(chỉ “cao cấp nhất” mới bị chặn) — có test khẳng định điều này để sau này không ai tưởng là lỗi.

**Phủ rate limit** (`test/imagelab-ratelimit.test.js`, mục agent test ghi là chưa phủ):
`POST /render` quá hạn mức → **429 `RATE_LIMITED`** (không 5xx); và **hạn mức là RIÊNG theo
session** — session A hết hạn mức không làm session B bị chặn.

> **Bài học hạ tầng test (đã trả giá):** `sessionId()` chỉ nhận cookie `sid` khớp
> `/^[A-Za-z0-9_-]{16,64}$/`; sid **ngắn hơn 16 ký tự** bị server cấp sid MỚI cho mỗi request,
> nên job tạo ở request này không đọc được ở request sau (404 “không tìm thấy job”). Đã ghi chú
> ngay trong file test. Đây là hành vi CÓ CHỦ Ý (chống session id đoán được), không phải lỗi.

Tổng sau vòng 6b: `npm test` → **451 test · 450 pass · 0 fail · 1 skipped**; `npm run verify` EXIT=0;
`npm run demo:imagelab` → `succeeded`.

### 12.5 Đo ĐỘ PHỦ để tìm lỗ hổng — và vá lỗ hổng lớn nhất

Chạy `node --test --experimental-test-coverage` (Node 24) và soi riêng `src/imagelab/**`:

| Module | Trước | Sau | Ghi chú |
|---|---|---|---|
| `render/providers/http.js` | **20.81% dòng · 0% hàm** | **100% dòng · 77.78% hàm** | Lỗ hổng lớn nhất: các test cũ dùng **lớp giả kế thừa `RenderProvider`**, tức bỏ qua toàn bộ tầng HTTP — đúng đường mà phản biện đã chứng minh là nơi ẩn N-5/N-8/N-12/N-13 |
| `render/png.js` | 81.42% | (giữ nguyên, các nhánh lỗi hiếm) | — |
| `render/image.js` | 75.42% | (giữ nguyên) | Hàm tiện ích ảnh, phần lớn nhánh là định dạng không hỗ trợ |
| `translate/index.js` | 79.88% | (giữ nguyên) | Nhánh provider AI thật cần mạng |

**Đã thêm `test/imagelab-http-render.test.js` (16 test)** — dựng **service render giả chạy thật trên
localhost** (`node:http`) và khoá lại hợp đồng của provider `http`: request đúng
`{image_base64, mime, ops}`; gửi `Authorization: Bearer …` khi có key; **không trả `applied` ⇒
`PARTIAL` + cảnh báo, KHÔNG bịa danh sách đã vẽ**; `applied` thiếu ⇒ `PARTIAL`; HTTP 500 ⇒
`RENDER_HTTP_STATUS`; body không phải JSON ⇒ `RENDER_BAD_RESPONSE`; `image_base64` rác ⇒
`RENDER_BAD_RESPONSE`; ảnh sai kích thước ⇒ `FAILED RENDER_SIZE_MISMATCH`; ảnh JPEG trả về ⇒
`PARTIAL` + `PROTECTED_PIXELS_UNVERIFIED` + `protected_pixels_verified = false`; thiếu `baseUrl` ⇒
`NOT_CONFIGURED`; `ALLOW_PRIVATE_NETWORK=false` ⇒ **chặn gọi vào localhost** (SSRF) và không chạm
tới service; thiếu ảnh đầu vào ⇒ `BAD_INPUT`; response thiếu `image_base64` ⇒ `RENDER_BAD_RESPONSE`;
ảnh vượt `maxOutputBytes` ⇒ `UNSUPPORTED_IMAGE` + `RENDER_OUTPUT_TOO_LARGE`.

Tổng sau vòng 6c: `npm test` → **467 test · 466 pass · 0 fail · 1 skipped**; `npm run verify` EXIT=0.

### 12.6 Vòng 6d — phủ nốt bề mặt chưa ai chạm (UI, provider AI, storage, ops)

Tiếp tục đo độ phủ và vá các chỗ mỏng nhất. **Bốn file test mới, 45 test**, và **một lỗi UI thật
được tìm ra nhờ test**:

| Bề mặt | Trước | Sau khi thêm test | Nội dung khoá lại |
|---|---|---|---|
| **UI `public/app.js`** | **0 test thường trực** | `test/imagelab-ui.test.js` (15 test) + harness trích hàm THẬT (`test/imagelab-ui-helpers.js`) | XSS: payload nguyên văn không bao giờ lọt HTML (`renderIlReview`, `historyItemHtml`); vùng nhãn hiệu bị `disabled` thật + có nút override; nhãn **MOCK theo dấu vết của job** (hồi quy F-03 ở tầng UI); `ilErrorText` dùng câu gợi ý tiếng Việt cho 5xx chứ không hiện câu chung của server |
| `translate/index.js` (nhánh provider **AI**) | 79.88% | **90.34%** — `test/imagelab-translate-ai.test.js` (8 test, provider AI giả) | Vùng khoá **không bao giờ** lọt prompt gửi API trả tiền; provider bỏ sót ⇒ `GLOSSARY` (truy nguồn) hoặc `NEEDS_REVIEW`, **không bịa**; `region_id` lạ ⇒ bỏ + cảnh báo; JSON hỏng/lỗi mạng ⇒ `FAILED` + `error_code`, không lộ nội dung gửi đi; không có vùng cần dịch ⇒ **không gọi API** (không tốn tiền) |
| `storage.js` | 84.65% | **97.52%** — `test/imagelab-storage.test.js` (10 test) | `..`/tuyệt đối ra ngoài/quá 2 đoạn ⇒ từ chối; NUL ⇒ `UNSAFE_PATH`; thiếu `storage_path` ⇒ `INVALID_PATH`; file mất ⇒ `NOT_FOUND` + `exists()` false + `remove()` idempotent; ghi đè nguyên tử, **không để lại file `.tmp`** |
| `render/ops.js` | 76.56% | **100%** — `test/imagelab-ops.test.js` (10 test) | op rác ⇒ `BAD_OP`/`UNSUPPORTED_ACTION`/`NO_TEXT` và **các op tốt vẫn chạy**; box sai kiểu ⇒ `null` (không đoán toạ độ); `region_id` rác ⇒ đánh số theo vị trí; giữ chỉ số gốc để map ngược về vùng |

> **Lỗi UI thật do test tìm ra:** `renderIlWarnings(null)` ném `TypeError` (hàm chạy trong luồng
> render, ném lỗi ở đây sẽ làm trắng trang kết quả). Đã vá: `data = data || {}`. Đây là loại lỗi
> mà mọi test API/store đều không thấy, vì nó chỉ xảy ra ở tầng giao diện.

Tổng sau vòng 6d: `npm test` → **510 test · 509 pass · 0 fail · 1 skipped**; `npm run verify` EXIT=0.

**Còn mỏng (đã đo, chưa phủ):** `render/image.js` 75.42% (hàm tiện ích ảnh: dò MIME, kẹp hộp —
phần lớn nhánh là định dạng không hỗ trợ), `render/png.js` 81.42% (nhánh lỗi hiếm),
`translate/util.js` 81.60%. Ba chỗ này không phải đường nghiệp vụ, nhưng **đã ghi lại** thay vì
để người đọc tự suy là "đã phủ hết".

---

## 11. IL-08 — vòng 6: vá 5 phát hiện của phản biện (IL08-01…IL08-05)

Phán quyết vòng 5: **FAIL** (`docs/MVP-02-REVIEW.md`, mục “VÒNG 5 — IL-08 — phản biện”).
Đã vá hết. `npm test` → **578 test · 577 pass · 0 fail · 1 skipped** (skip duy nhất vẫn là
PostgreSQL của MVP-01); `node tools/verify.mjs` EXIT=0; `node tools/imagelab-demo.mjs` →
`succeeded`; `node tools/imagelab-demo.mjs --regions /tmp/vung-that.json` → `succeeded`.

### 11.1 IL08-01 (CRITICAL) — OCR đang chạy không được xoá vùng nhập tay

Sửa **hai tầng** (đúng như phản biện yêu cầu), cộng UI:

- **(a) `src/imagelab/pipeline.js` + `src/http/routes.js`:** job `running`, hoặc `queued` **và
  thật sự có lượt OCR trong hàng đợi** (`JobQueue.isPending` — mục đã chạy xong vẫn nằm trong
  `active`, nên phải loại `done/failed`) ⇒ `409 IMAGELAB_JOB_RUNNING`, KHÔNG ghi gì.
- **(b) `runOcr`:** trước `saveOcrRegions` **đọc lại job + danh sách vùng**; nếu
  `manual_regions === true` hoặc có vùng `source='user'` ⇒ **DỪNG**, giữ `awaiting_review`, ghi
  `content_meta.imagelab.ocr_superseded` + cảnh báo “KHÔNG ghi đè…” (lớp chặn khe TOCTOU).
- **(c) `public/app.js`:** job `queued/running` ⇒ nút “LƯU VÙNG & DỊCH” **disabled** + ghi chú
  “Job đang chạy OCR/dịch — chờ xong…”; gặp 409 thì hiện đúng câu máy chủ (không nuốt lỗi).

Bằng chứng (`node test/il08-manual-regions-race.probe.mjs` — XANH):

```
✅ lưu vùng trong lúc OCR đang chạy ⇒ 409 IMAGELAB_JOB_RUNNING (nhận: IMAGELAB_JOB_RUNNING)
✅ bị từ chối thì KHÔNG được ghi vùng nào vào DB
   vùng trong DB sau khi OCR chạy lại: [["u1","user","纯棉短袖T恤"]]
   content_meta.imagelab: true awaiting_review awaiting_review
   có cảnh báo "KHÔNG ghi đè"? true
```

`cd /tmp/atk-il08 && node 05-limits-race.mjs` (mục B1 — 40 job dồn hàng đợi, PUT vào job cuối):
`job CUỐI lúc PUT: {"status":"running","stage":"ocr"}` → `PUT /regions: {"status":409}` → DB giữ
nguyên vùng OCR, không có vùng `user` nào bị ghi rồi bị xoá.
`node 15-ui-race-window.mjs`: `có nút disabled vì job đang chạy? true`, `có câu cảnh báo "chờ OCR"? true`.

### 11.2 IL08-02 (MAJOR) — `kind` client khai chỉ được LEO THANG bảo vệ

- `src/imagelab/manual-regions.js`: **luôn** chạy `classifyRegion`, rồi hợp nhất bằng
  `dedupePriority` (`brand|certification|price > unknown > descriptive`) — **một bản luật** với
  `ocr/normalize.js`. Khai thấp hơn ⇒ giữ mức cao + `warnings`; muốn hạ phải có
  `allow_kind_downgrade: true` **theo từng vùng** ⇒ mới dùng kind client khai và ghi vết
  `kind_downgraded` + `kind_declared_by_user` + warning.
- `src/http/routes.js`: `sanitizeManualRegionsInput` chuyển tiếp cờ này (không tự quyết định).

`cd /tmp/atk-il08 && node 14-asymmetry.mjs` — cột “NHẬP TAY (client khai descriptive)” nay khớp
C1 và đường OCR ở MỌI dòng:

```
免运费  | price/false        | … | price/false        | price/false
旗舰    | brand/false        | … | brand/false        | brand/false
检测    | certification/false | … | certification/false | certification/false
１９９元 | price/false        | … | price/false        | price/false
```

`node 03-render-gap.mjs` ca G1 (`免运费` khai `descriptive`): `DB lines: "status":"SKIPPED_PRICE"`,
`KẾT LUẬN PIXEL: không có ảnh render` (trước vá: dòng `GLOSSARY`, `pixel đã đổi 8000/8000`,
`chữ gốc còn nguyên? false`, KHÔNG có cảnh báo override).

### 11.3 IL08-03, IL08-04, IL08-05

| # | Sửa gì | Bằng chứng |
|---|---|---|
| IL08-03 | `collectOcrMeta` (`routes.js`) trả thêm `superseded_by_manual_regions`, `superseded_at`, `note`; `public/app.js` đổi tiêu đề khối “vùng bị bỏ khi OCR” thành *“Dấu vết OCR TRƯỚC ĐÓ — đã bị thay bởi vùng nhập tay”* và không tô đỏ như cảnh báo hiện hành | `node 09-trace.mjs` (T2): `"superseded_by_manual_regions": true`, `"note": "Dấu vết OCR TRƯỚC ĐÓ — đã bị thay bởi vùng nhập tay; … KHÔNG mô tả vùng chữ đang có của job."`, `GET response có trường superseded nào không?: true` |
| IL08-04 | `ingest` lưu `content_meta.imagelab.limits.max_regions`; `runOcr` **giữ** các field `imagelab` cũ (trước đây dựng lại từ đầu ⇒ trần theo job biến mất); route + `setManualRegions` áp `min(trần cấu hình, trần job)` ⇒ `413 TOO_MANY_REGIONS` | `node 11-abuse.mjs` (mục D): `vùng OCR sau job: 1` → `PUT 5 vùng nhập tay: {"status":413}` → `vùng trong DB: 1` |
| IL08-05 | `readBody` (`src/http/server.js`): vượt trần ⇒ **bỏ listener + `resume()` xả bỏ** rồi để route trả JSON `413 PAYLOAD_TOO_LARGE`; KHÔNG `req.destroy()` trước khi response kịp ghi | `node 12b-body.mjs`: `HTTP: {"status":413,"code":"PAYLOAD_TOO_LARGE","message":"Body vượt giới hạn 524288 byte."}`, `vùng trong DB (không thêm gì): 1`, `server còn sống: 200` (trước vá: `CLIENT_ECONNRESET`) |

### 11.4 Test thêm/sửa (nói rõ, không giấu)

- **Thêm** `test/imagelab-manual-hardening.test.js` — 10 test hồi quy cho IL08-01(a,b),
  IL08-02 (4 ca đơn vị + 1 ca API), IL08-03, IL08-04, IL08-05.
- **Sửa** `test/il08-manual-regions-race.probe.mjs`: khẳng định 1 của bản gốc là
  “lưu vùng trong lúc OCR đang chạy ⇒ **200**” — đúng hành vi mà IL08-01 phải chặn. Nay probe
  khẳng định **409 + không ghi gì**, và thêm bước cho OCR chạy LẠI để chứng minh tầng (b)
  (vùng người dùng còn nguyên + cảnh báo). Tính chất gốc giữ nguyên: không xoá im lặng.
- **Sửa** `test/imagelab-manual-api.test.js` (test rate limit): thêm `await waitJob(...)` trước
  lượt PUT đầu — test này đo **hạn mức request**, nhưng lại PUT ngay sau khi tạo job (job còn
  `queued`), nên tiền đề “lượt đầu 200” mâu thuẫn với luật IL08-01(a).

### 11.5 Còn lại / chưa đo được

- **UI chưa có nút hạ mức bảo vệ.** Cờ `allow_kind_downgrade` mới chỉ có ở tầng API (theo từng
  vùng) — cố ý: hạ mức bảo vệ của vùng giá/nhãn hiệu không nên là thao tác một cú bấm. Người
  dùng vẫn thấy `warnings` giải thích vì sao vùng bị giữ ở mức cao hơn.
- **`JobQueue.isPending` là trạng thái TRONG BỘ NHỚ.** Nếu máy chủ khởi động lại giữa lúc OCR,
  job còn `queued` mà không còn mục trong hàng đợi ⇒ lượt lưu vùng tay được phép; khi đó lớp (b)
  (`runOcr` đọc lại job) vẫn là lưới chặn — không mất dữ liệu, nhưng cửa sổ 409 hẹp hơn.
- **OCR provider THẬT (chậm) chưa đo được**: mọi bằng chứng dùng provider mock + cổng promise
  tất định. Cửa sổ race với OCR thật rộng hơn, nhưng cả hai tầng đều không phụ thuộc thời gian.
- Chưa đo: PostgreSQL, trình duyệt thật, `data/studio.db` thật, nhiều máy chủ chạy song song
  (hàng đợi trong bộ nhớ không chia sẻ giữa các tiến trình).

---

## 12. IL-08 — vòng 7: IL08-06 (vết hạ mức bền) + IL08-07 (chẩn đoán đúng bước, mở đường cho job kẹt)

Phán quyết vòng 6: **PASS CÓ ĐIỀU KIỆN** (2 MINOR mới). Đã vá. `npm test` →
**582 test · 581 pass · 0 fail · 1 skipped**; `node tools/verify.mjs` EXIT=0;
`node tools/imagelab-demo.mjs --regions <file>` → `succeeded`; probe race → XANH.

### 12.1 IL08-06 — vết hạ mức bảo vệ: BỀN + ĐỌC LẠI ĐƯỢC

Sửa ở `src/imagelab/manual-regions.js` (hằng `KIND_DOWNGRADE_MARK`, `kindDowngradeNote`,
`parseKindDowngrade`, `withKindDowngradeTrace`), `src/imagelab/pipeline.js`
(`content_meta.imagelab.manual.kind_downgrades` + nhắc lại cảnh báo cho vết còn hiệu lực),
`src/http/routes.js` (`regionJson` gắn vết cho **cả PUT và GET** + `kind_downgrades` cấp job).

`node /tmp/atk-il08b/r6-02b-trace.mjs` (sau khi vá):

```
response regions[0]: {"kind_downgraded":true,"kind_declared_by_user":"descriptive",
                      "kind_classified_by_machine":"price", … ,
                      "kind_reason":"chữ mô tả thông thường [NGƯỜI DÙNG HẠ MỨC từ price]"}
DB region row: kind_reason "chữ mô tả thông thường [NGƯỜI DÙNG HẠ MỨC từ price]", source "user"
toàn bộ content_meta.imagelab có chuỗi "kind_downgraded" không?: true
[T2 — lưu lần kế tiếp] content_meta warnings còn "HẠ MỨC"? ["⚠️ Vùng u1 vẫn đang ở mức "descriptive"
                      do NGƯỜI DÙNG HẠ MỨC từ "price" (ghi vết lúc …) …"], vùng u1 còn nguyên
```

`node /tmp/gop7/verify-trace.mjs` (tự kiểm, trả lời câu “mở lại trang có thấy vết không”):

```
GET regions[0] (vết) {"id":"u1","kind":"descriptive","kind_downgraded":true,
                      "declared":"descriptive","machine":"price"}
GET kind_downgrades  [{"kind_downgraded":true,"region_id":"u1","declared_by_user":"descriptive",
                       "classified_by_machine":"price","applied_kind":"descriptive","at":"…"}]
[G2 — lưu lần 2] GET kind_downgrades: vẫn còn u1 (cùng `at`) · vùng u1 còn vết?: ["u1"]
[G3 — không bịa vết] các vùng có kind_downgraded: [["u1", true], ["u2", false]]
```

### 12.2 IL08-07 — chẩn đoán đúng bước + job kẹt không bị chặn vĩnh viễn

- `src/imagelab/pipeline.js`: `IMAGELAB_STAGE_LABEL` + `orphanRunningWarning`; cổng chặn dùng
  `ocrPending` (đến từ `queue.isPending`) làm nguồn chân lý, câu 409 nêu đúng `stage`;
  hàng đợi rỗng mà job vẫn `queued`/`running` ⇒ **cho lưu** + cảnh báo mồ côi.
- `src/http/routes.js`: đã truyền `queue.isPending(job.id)` (từ vòng 6) — không đổi thêm.
- `public/app.js`: nhãn chờ việc theo `job.stage` (“đang render ảnh”, “đang nhận dạng chữ (OCR)”…).

`node /tmp/atk-il08b/r6-05-render-busy.mjs`:

```
job row lúc này: {"status":"running","stage":"rendering"}
PUT /regions khi RENDER đang chạy: {"status":409,"code":"IMAGELAB_JOB_RUNNING",
  "message":"Job đang chạy bước render ảnh (status = running, stage = rendering) — chờ bước này xong …",
  "details":{"status":"running","stage":"rendering","queue_pending":true}}
sau khi render xong, job row: {"status":"succeeded","stage":"done"} · PUT lại: {"status":200,"regions":1}
```

Job **mồ côi** (hàng đợi rỗng, mô phỏng tiến trình chết) — `node /tmp/gop7/orphan.mjs`:

```
queue có việc cho job này?: false
PUT /regions: {"status":200,"regions":1}
warnings: ["… ⚠️ Job đang ở trạng thái "running" (bước "ocr" — nhận dạng chữ (OCR)) nhưng HÀNG ĐỢI
            không còn việc nào cho job này (tiến trình có thể đã chết hoặc máy chủ vừa khởi động lại).
            Vẫn cho lưu vùng chữ bạn nhập — dữ liệu của bạn KHÔNG bị chặn vĩnh viễn."]
vùng trong DB: [{"region_key":"u1","source":"user","text_original":"纯棉短袖T恤"}]
job row sau khi lưu: {"status":"awaiting_review","stage":"awaiting_review"}
```

### 12.3 Test thêm/sửa

- **Thêm 4 test** vào `test/imagelab-manual-hardening.test.js`: IL08-06 (hàm thuần đọc lại vết từ
  `kind_reason`; API: vết ra response + `content_meta`, còn sau lần lưu kế tiếp, GET trả vết và
  vùng sạch KHÔNG bị gắn cờ) và IL08-07 (409 nêu đúng bước `render ảnh`; job mồ côi ⇒ 200 +
  cảnh báo + dữ liệu được ghi + job thoát trạng thái kẹt).
- **Sửa 1 test cũ**: `test/imagelab-manual-hardening.test.js` (tầng (a) của IL08-01) — câu chặn
  nay nêu đúng bước, nên kỳ vọng đổi từ `/chờ xong rồi…/` sang
  `/chạy bước nhận dạng chữ \(OCR\)/` + `/chờ bước này xong rồi…/`. Không nới lỏng gì khác.

### 12.4 Còn lại

- UI **chưa** có nút gửi `allow_kind_downgrade` (cố ý — hạ mức bảo vệ không nên là một cú bấm);
  vết chỉ hiện khi client gửi cờ, và vẫn hiện đủ ở `warnings`/`kind_reason`/`kind_downgrades`.
- `JobQueue.isPending` là trạng thái TRONG BỘ NHỚ: nhiều tiến trình chạy song song thì tiến trình
  này không thấy việc của tiến trình kia ⇒ có thể coi job là “mồ côi” và cho lưu (lớp chặn (b)
  của `runOcr` vẫn bảo vệ dữ liệu). Chưa đo với PostgreSQL/nhiều máy chủ.
