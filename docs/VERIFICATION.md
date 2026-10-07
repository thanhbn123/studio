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

---

## 13. MVP-03 — vòng 8: vá 6 phát hiện của phản biện (M03-01…M03-06)

Phán quyết vòng MVP-03: **FAIL** (1 CRITICAL · 1 MAJOR · 4 MINOR — `docs/MVP-03-REVIEW.md`).
Đã vá hết. `npm test` → **698 test · 697 pass · 0 fail · 1 skipped** (baseline 683 + 15 test mới);
`node tools/verify.mjs` EXIT=0; `node test/imagestudio-config-gap.probe.mjs` → **XANH 6/6**.

### 13.1 M03-01 (CRITICAL) — sản phẩm gần màu nền không còn bị ăn

Sửa ở `src/imagestudio/matting/background.js` (tolerance 12, `measureBoundaryDelta` hai phía,
các hằng ngưỡng), `matting/providers/purejs.js` (soi biên + siết nghi ngờ + câu chữ),
`matting/provider.js` + `matting/result.js` (giữ số đo mở rộng của `mask`),
`compose/compose.js` (câu chữ), `public/app.js` (cảnh báo nổi bật cho MỌI lượt tách nền).

```
$ cd /tmp/mvp03-atk && node a2b-white-product.mjs
matting.status = OK | mask = {"coverage":0.5625,"background_ratio":0.4375,…}
warnings: • Soi biên vùng đã tách: phía NỀN 192 pixel kề sản phẩm (Δmax 0/255, Δp95 0/255,
            vượt 8/255: 0.0%); phía GIỮ LẠI 188 pixel kề nền (Δmin 25.98/255, dưới ngưỡng
            dứt khoát 20/255: 0.0%).
          • Pixel NGOÀI vùng đã tách giữ nguyên từng byte; vùng đã tách do máy đoán theo màu
            nền — hãy mở ảnh TRƯỚC|SAU để kiểm.
"áo trắng": XOÁ = 0/2048, còn lại = 2048 · pixel vùng "áo" còn màu áo gốc = 2048,
            đã bị đổi thành màu nền mô phỏng = 0 · mẫu pixel (10,10) → [240,240,240,255]
```

Ba ca biên (script tự kiểm `/tmp/gop8/m1-boundary.mjs`):

```
kem 248 (Δ≈12.1, sát nền)  → FAILED  boundary={"kept_under_ratio":1,"kept_min":12.12,"suspicious":true}
trắng 250 (Δ≈8.7)          → FAILED  boundary={"over_ratio":1,"max":8.66,"suspicious":true}
trắng 240 (ca M03-01 gốc)  → OK      0 pixel sản phẩm bị đổi (kept 48×48)
xám 200 (khác rõ)          → OK      0 pixel sản phẩm bị đổi
```

Hồi quy không vỡ: `node a1-distortion.mjs` → `pixel giữ nguyên=1024, pixel SẢN PHẨM đổi=0`;
`node c1-matting.mjs` → nền gradient vẫn `UNIFORM_BACKGROUND_NOT_FOUND` (uniformity 0.0266/0.3989/
0.5426), ảnh toàn nền/1 pixel khác vẫn `SUSPICIOUS_MASK`.
`node e4-ui.mjs` (B3b, hàm UI THẬT): `UI có hiện lời khẳng định "Pixel sản phẩm … giữ nguyên
từng byte"? **false**` + UI hiện *“Vùng tách nền do MÁY ĐOÁN theo màu nền — hãy kiểm ảnh
TRƯỚC|SAU”*.

### 13.2 M03-02 (MAJOR) — overlay hết đường “tự rửa tội”

Sửa ở `src/imagestudio/pipeline.js` (`#evidenceText` chỉ đọc dữ liệu ĐÃ LƯU),
`compose/overlay.js` (`resolveSourceText` chỉ nhận `params.source_text` của server; thêm
`CLIENT_EVIDENCE_KEYS`/`clientEvidenceKeysIn`), `src/http/routes.js` (bỏ `overlayHasClientEvidence`
+ bỏ chuyển tiếp 16 khoá bằng chứng; preflight LUÔN chạy).

```
$ node d-overlay.mjs        # D2 — CÙNG khẳng định đó + client tự khai `source_text`
"Bảo hành 12 tháng" → 422 | "BH 12 tháng" → 422 | "chống nước IP68" → 422 |
"hơn 10 nghìn người mua" → 422 | "①② tháng" → 422 | "ｂảo hành 12 tháng" → 422 |
"bảo hànһ 12 tháng" → 422 | "bao hanh 12 thang" → 422      (trước vá: 202 + 152 pixel được vẽ)

$ node d2b-variants.mjs     # cả 9 biến thể đều 422, KHÔNG biến thể nào vẽ pixel
1. không bằng chứng → 422 · 2. source_text → 422 · 3. notes → 422 · 4. source_text=[…] → 422 ·
5. evidence ngoài overlay → 422 · 6. evidence={text} → 422 · 7. chỉ "Bảo hành" → 422 ·
8. chỉ "12 tháng" → 422 · 9. bằng chứng chữ Hán → 422
```

Đối chứng DƯƠNG (khẳng định CÓ thật trong dữ liệu đã lưu ⇒ vẫn vẽ): xem `test/imagestudio-round8-
hardening.test.js` — `drawOverlay` với `source_text` do server truyền ⇒ `applied: true` + có pixel
vẽ; và qua pipeline: `jobs.product_name = "Bảo hành 12 tháng chính hãng"` ⇒ `overlay.applied = true`
kèm cảnh báo *“BỎ QUA bằng chứng do client tự khai (source_text)”*.

### 13.3 M03-04, M03-05, M03-06

| # | Sửa gì | Bằng chứng |
|---|---|---|
| M03-04 | `overlay.js` + preflight của route dùng `hasUntranslatedScript` (Hán + kana + Hangul) và kiểm **trước** danh sách vi phạm ⇒ trả đúng `OVERLAY_NOT_TRANSLATED` | `node d3-cjk.mjs`: `"こんにちは" → 422 OVERLAY_NOT_TRANSLATED`, `"한국어" → 422 OVERLAY_NOT_TRANSLATED`, `"保修 12 个月" → 422 OVERLAY_NOT_TRANSLATED` (trước: 202 `OVERLAY_NO_GLYPH` và `OVERLAY_UNSUPPORTED_CLAIM`) |
| M03-05 | `retouch_effective` = 0 khi `NO_CHANGES`/`FAILED` (giữ `retouch_clamped`); `composeImage` chỉ ghép khi `matting.status === 'OK'`; mask alpha một phần được ĐẾM + cảnh báo | `node a3-clamp.mjs` (A3.2): `retouch="NO_CHANGES" effective={"brightness":0,…} clamped=["brightness"]`, `meta.retouch_effective = {0,0,0,0}`. `node a5-immut.mjs` (A4b): `mask status FAILED + có buffer → ratio=0 | giống ảnh vào=true | byte pixel SẢN PHẨM đổi=0` (trước: ratio=1, 27 byte đổi); `mask alpha MỘT PHẦN → cảnh báo "Mask nền có 1 pixel alpha MỘT PHẦN…"` |
| M03-06 | `src/config.js` thêm khối `imagestudio`/`matting`/`retouch` + `COST_IMAGE_*`; `.env.example` ghi kèm chú thích tiếng Việt | `node test/imagestudio-config-gap.probe.mjs` → **6/6 XANH** (`IMAGESTUDIO_ENABLED=false` ⇒ 503 + `/api/config` `enabled:false`; `MATTING_PROVIDER=none/http` chọn đúng provider; `RETOUCH_PROVIDER=none`) |

### 13.4 Test thêm/sửa

- **Thêm** `test/imagestudio-round8-hardening.test.js` (15 test): M03-01 (6 ca, gồm 248/250/240/200
  + "đảo nhỏ" + câu cảnh báo), M03-02 (3 ca, gồm **đối chứng dương**), M03-04, M03-05 (2 ca),
  M03-06 (3 ca, gồm "trần retouch chỉ siết được").
- **Sửa** `test/imagestudio-matting.test.js`: khẳng định `Object.keys(mask)` deep-equal 4 field
  đóng băng ⇒ nay kiểm 4 field đứng đầu + phần mở rộng phải nằm trong `MATTING_MASK_EXTRA_FIELDS`
  (M03-01a yêu cầu `mask.boundary_delta`; đây là **mở rộng hợp đồng có chủ đích**, đã ghi §3.1).
- **Commit** 9 file test MVP-03 (101 test) + `test/imagestudio-config-gap.probe.mjs` — trước vòng 8
  chúng còn untracked nên commit `ac8efa9` không có test nào cho MVP-03 (M03-03/F3).

### 13.5 Còn lại / chưa sửa được

- **Mask alpha MỘT PHẦN vẫn được ghép** (có cảnh báo + số đếm): dịch vụ tách nền thật hay trả alpha
  mềm, từ chối hết sẽ chặn cả đường `http` hợp lệ. Ngưỡng "alpha mềm bao nhiêu thì từ chối" cần
  một provider thật để hiệu chỉnh — chưa đo được (không có service thật, `safeFetch` chặn mạng nội bộ).
- **Ngưỡng biên (8/20/5%) là lựa chọn có ghi lý do, không phải số đo từ ảnh thật**: bộ dữ liệu đo
  chỉ gồm ảnh tổng hợp. Ảnh chụp thật có bóng đổ mềm có thể bị TỪ CHỐI (đúng luật #3 fail-closed,
  người dùng vẫn nhận ảnh chỉ-retouch + lý do tiếng Việt) — cần đo lại khi có ảnh thật.
- **`tolerance`/`minUniformity`/ngưỡng biên không đưa ra biến môi trường** (cố ý): nới chúng qua
  env là đổi luật fail-closed mà không qua hợp đồng.
- Vẫn chưa đo: PostgreSQL, provider `http` thật, trình duyệt thật, nhiều job đồng thời (như §4 của
  báo cáo phản biện đã ghi).

---

## 14. MVP-03 — vòng 9: xử lý N1…N6 của phản biện vòng 2

Phán quyết vòng 2: **PASS CÓ ĐIỀU KIỆN** (1 MAJOR mới + 5 MINOR — `docs/MVP-03-REVIEW.md`).
Đã xử lý cả 6. `npm test` → **708 test · 707 pass · 0 fail · 1 skipped**; `verify.mjs` EXIT=0;
`imagelab-demo.mjs` → `succeeded`.

### 14.1 N1 (MAJOR) — tách “NHẬP NHẰNG” khỏi “NGHI NGỜ ĂN MẤT SẢN PHẨM”

Sửa: `src/imagestudio/matting/background.js` (đo `dirty_removed_ratio` = diện tích bị coi là nền mà
KHÔNG sạch màu nền; `AMBIGUOUS_DIRTY_AREA_MAX = 0.15`), `matting/result.js` +
`matting/errors.js` (`status`/`error_code` mới `SEGMENTATION_AMBIGUOUS`), `matting/providers/purejs.js`
(phân loại 3 nhánh + cờ `matting_allow_ambiguous`), `matting/provider.js` (N6), `pipeline.js`
(`matting_options` + `meta.matting.ambiguous_override`), `http/routes.js`
(`options.matting_allow_ambiguous`), `public/app.js` (checkbox + câu giải thích).

```
$ cd /tmp/mvp03-atk2 && node r2-threshold-scan.mjs
sản phẩm 240/243 + logo                 | OK/OK | cov=0.4307
sản phẩm 244/245/246/247/248 + logo     | OK/OK | cov=0.4307      <-- HẾT chặn oan
sản phẩm 249/250 + logo                 | FAILED/SUSPICIOUS_MASK | cov=0.1329 "…NGHI NGỜ ĂN MẤT SẢN PHẨM:
                                          NỀN ĐÃ TÁCH KHÔNG SẠCH: 29.8% ảnh bị coi là nền mà lệch màu nền quá 8/255…"
bóng mềm Δmax 12/20/30/40               | SEGMENTATION_AMBIGUOUS/SEGMENTATION_AMBIGUOUS | "BIÊN NHẬP NHẰNG
                                          nên KHÔNG GHÉP NỀN (sản phẩm vẫn được giữ nguyên)… vẫn được RETOUCH…"
viền mờ 1–4px · đỏ đặc không bóng       | OK/OK
```

`node /tmp/gop9/n1-override.mjs` (HTTP thật, 3 lượt trên cùng một ảnh bóng mềm):

```
mặc định (không override)          | matting=SEGMENTATION_AMBIGUOUS | ambiguous_override=false | rendered=0
override + retouch                 | matting=OK/OK | ambiguous_override=true | meta.matting.ambiguous_override=true | rendered=1
mặc định + retouch (không ghép nền)| matting=SEGMENTATION_AMBIGUOUS | rendered=1  (ảnh RETOUCH vẫn ra)
```

### 14.2 N2…N6

| # | Sửa gì | Bằng chứng |
|---|---|---|
| N2 | Ghi **giới hạn vật lý** vào hợp đồng §3.1: sản phẩm cách nền ≤ 8/255 không thể phân biệt bằng đo màu ⇒ phải dùng provider `http`/AI | `r2-threshold-scan`: `sản phẩm 251 + logo → OK/OK cov=0.1329` (thân bị ăn — giới hạn đã biết, KHÔNG còn im lặng vì hợp đồng nói rõ) |
| N3 | `summarizeMatting` chuyển tiếp `kept_bbox_ratio` + `boundary_delta` + `boundary_checked` + `ambiguous_override`; UI thêm khối “Số đo vùng tách nền” (Δp95, over_ratio, kept_under_ratio, dirty_removed_ratio, cờ override) | `node /tmp/mvp03-atk/a2b-white-product.mjs`: `mask = {"coverage":0.5625,…,"kept_bbox_ratio":0.5625,"boundary_delta":{"p95":0,"over_ratio":0,"kept_min":25.98,"dirty_removed_ratio":0,…},"boundary_checked":true}` |
| N4 | **BỎ** `IMAGESTUDIO_DIR`/`imagestudio.dir` khỏi `src/config.js` + `.env.example` + hợp đồng; ghi rõ ảnh MVP-03 dùng CHUNG kho `IMAGELAB_DIR` | `node r2-config.mjs`: `IMAGESTUDIO_DIR=/tmp/khac (có tác dụng?) → config.imagestudio.dir=undefined | storage THẬT dùng = <IMAGELAB_DIR>/images` |
| N5 | `#evidenceText` trả `evidence_used {sources, region_ids, chars}`; đi vào `overlay` của kết quả (kể cả khi bị chặn), `content_meta`, `asset.meta.overlay` và UI (“Bằng chứng dùng để duyệt chữ overlay: …”) | test `N5: overlay trả evidence_used với nguồn thật` → `sources: ["product_name","user_region"]`, `region_ids: ["u1"]` |
| N6 | Provider ngoài `purejs` ⇒ `mask.boundary_checked = false` + warning; ghi vào VERIFICATION là **chưa đo end-to-end** | `node -e` với provider `mock`: `mask keys [...,"boundary_checked"] = false` + câu *"Provider "mock" KHÔNG đo được biên vùng tách (chỉ provider "purejs" đo được)…"* |

### 14.3 Test thêm/sửa

- **Thêm** `test/imagestudio-round9-hardening.test.js` (10 test): N1 hai chiều (bóng mềm ⇒
  AMBIGUOUS + câu đúng; 244–248 ⇒ ĐẠT; 249/250 và tolerance cũ 28 ⇒ vẫn SUSPICIOUS), cờ override
  (unit + HTTP + `meta.matting.ambiguous_override`), N3, N6, N4, N5.
- **Sửa 2 test cũ** (chúng đang khẳng định hành vi mà N1 xác định là SAI/chưa đủ):
  `imagestudio-round8-hardening.test.js` — “kem 248 ⇒ FAILED/SUSPICIOUS_MASK” đổi thành “kem 248 ⇒
  ĐẠT + lưu ý viền gần màu nền + 0 pixel sản phẩm đổi” (ghi rõ lý do trong test);
  `imagestudio-matting.test.js` — mask của provider `mock` nay có thêm `boundary_checked: false`
  (N6) nên khẳng định `deepEqual(MOCK_MASK)` được bổ sung field đó + kiểm câu cảnh báo.

### 14.4 Chưa sửa được

- **N2 vẫn là giới hạn thật**: sản phẩm ≤ 8/255 so với nền vẫn có thể bị ăn im lặng (đã ghi hợp
  đồng + khuyến nghị dùng provider `http`/AI). Không thể vá bằng heuristic màu.
- **N6/đường `http` chưa đo end-to-end**: `safeFetch` chặn mạng nội bộ và không có service thật ⇒
  chỉ khẳng định được “provider ngoài TỰ KHAI là chưa kiểm biên”, chưa đo mask thật của một dịch vụ.
- **Ngưỡng `AMBIGUOUS_DIRTY_AREA_MAX = 0.15` chọn từ ảnh TỔNG HỢP** (96×96): bóng đổ mềm ~0.03,
  ca ăn sản phẩm ~0.30 — ngưỡng nằm giữa hai cụm. Ảnh chụp thật (JPEG→PNG, bóng đổ lớn, nền màu)
  chưa đo ⇒ có thể còn ca rơi vào nhầm nhánh.
- Vẫn chưa đo: PostgreSQL, provider AI/OCR trả tiền, trình duyệt thật, queue đa tiến trình.

---

## 15. MVP-03 — vòng 10: xử lý N7/N8/N9 của phản biện vòng 3

Phán quyết vòng 3: **PASS CÓ ĐIỀU KIỆN** (1 MAJOR mới + 2 MINOR — `docs/MVP-03-REVIEW.md`).
Đã xử lý cả 3. `npm test` → **717 test · 716 pass · 0 fail · 1 skipped**; `verify.mjs` EXIT=0;
`imagelab-demo.mjs` → `succeeded`.

### 15.1 N7 (MAJOR) — mẫu số đúng + tín hiệu “cắt sâu”, và câu chữ chỉ nói điều ĐO ĐƯỢC

Sửa ở `src/imagestudio/matting/background.js` (đo `kept_pixels`, `dirty_ratio_kept`,
`dirty_inside_bbox(+_ratio)` với BFS khoảng cách tới vùng giữ; `AMBIGUOUS_DIRTY_RATIO_MAX = 1.0`,
`DIRTY_DEEP_MIN_DISTANCE = 2`), `matting/providers/purejs.js` (phân loại + câu chữ),
`pipeline.js` + `public/app.js` (N9). Cờ `matting_allow_ambiguous` **không** mở đường cho ca nguy hiểm.

```
$ cd /tmp/mvp03-atk3 && node r3d-threshold-hole.mjs
thân 220 (đối chứng)                   | job=succeeded | matting=OK | cov=0.1576 dirty=0 | ảnh ra=CÓ | pixel thân SP đổi màu=0/12100
thân 249 (BỊ ĂN, 13.4% khung)          | job=PARTIAL/NO_CHANGES | matting=FAILED/SUSPICIOUS_MASK | dirty=0.13444444
   ↳ TỪ CHỐI … (nghi ngờ ĂN MẤT SẢN PHẨM): NỀN ĐÃ TÁCH KHÔNG SẠCH: 12100 pixel … = 581.7% DIỆN TÍCH
     VÙNG GIỮ LẠI (ngưỡng 15%…; 13.44% khung ảnh) …  | ảnh ra=không
thân 249 + CỜ matting_allow_ambiguous  | matting=FAILED/SUSPICIOUS_MASK | ảnh ra=không   (cờ KHÔNG mở đường)
thân 249 TO HƠN (44% khung)            | matting=FAILED/SUSPICIOUS_MASK | dirty=0.44444444
(B) 700 px bẩn / 16 000 000 px         | job=PARTIAL/NO_CHANGES | matting=SEGMENTATION_AMBIGUOUS | ảnh ra=không

$ node /tmp/mvp03-atk3/r3e-ui-claim.mjs
A) UI có câu "sản phẩm vẫn được giữ nguyên"? false
   UI có câu "dải mỏng quanh sản phẩm" (mô tả 13.4% khung)? false
B) UI có "Số đo vùng tách nền"? true
```

Không hồi quy (3 chiều còn lại):

```
$ node /tmp/mvp03-atk2/r2-threshold-scan.mjs
sản phẩm 244/245/246/247/248 + logo | OK/OK | cov=0.4307          (mask đúng ⇒ vẫn ĐẠT)
bóng mềm Δmax 12/20/30/40           | SEGMENTATION_AMBIGUOUS/SEGMENTATION_AMBIGUOUS | "CHƯA ĐỦ CHẮC…"
viền mờ 1–4px · đỏ đặc không bóng   | OK/OK
$ node /tmp/mvp03-atk/a2b-white-product.mjs
matting.status = OK | "áo trắng": XOÁ = 0/2048 · pixel vùng "áo" còn màu áo gốc = 2048
```

### 15.2 N8 (MINOR) — không làm tròn mất tín hiệu

`dirty_removed_ratio` giữ `toFixed(8)`; phân loại nhập nhằng dùng **SỐ NGUYÊN** `dirty_removed > 0`.
Test mới: khung 1000×1000 với **42 px** bẩn (0.000042 khung ≈ ngưỡng làm tròn cũ 0.00005) ⇒
`notEqual(status, OK)` + `output = null` (trước: `toFixed(4)` ⇒ 0 ⇒ `OK` + ảnh ra).
Bằng chứng script: mục (B) ở trên — `700 px bẩn / 16 000 000` ⇒ **SEGMENTATION_AMBIGUOUS**, không ảnh ra.

### 15.3 N9 (MINOR) — số đo tới được API/UI THẬT

Sửa: `pipeline.js` ghi `meta.matting = summarizeMatting(matting)` (bản ĐẦY ĐỦ, không còn 3 field);
`routes.js` thêm `matting` vào `last_run`; `public/app.js` đọc mask từ **cả ba** nguồn
(`data.matting.mask` → `rendered[].meta.matting.mask` → `last_run.matting.mask`).

```
$ cd /tmp/mvp03-atk3 && node r3c-exposure.mjs
[ĐẠT] GET data.matting.mask  = {"coverage":0.2397,…,"kept_bbox_ratio":0.2397,
       "boundary_delta":{"p95":0,"dirty_removed":0,"kept_pixels":2209,"dirty_ratio_kept":0,…},
       "boundary_checked":true}
      GET rendered[0].meta.matting = (cùng bản tóm tắt đầy đủ)
      UI  có khối "Số đo vùng tách nền"? true | Δp95=true dirty=true under=true
[NHẬP NHẰNG] UI có khối "Số đo vùng tách nền"? true   (lấy từ last_run.matting)
[N6 mock]  UI có "Provider ngoài (không phải purejs) KHÔNG đo được biên"? true
```

### 15.4 Test thêm/sửa

- **Thêm** `test/imagestudio-round10-hardening.test.js` (9 test): N7 **ba chiều** (ăn sản phẩm
  khung 300×300 ⇒ SUSPICIOUS + cờ không mở đường; bóng đổ mềm ⇒ AMBIGUOUS + câu chỉ nói điều đo
  được; sản phẩm sáng 244–248 ⇒ ĐẠT), N8 (42 px bẩn trên 1000×1000 ⇒ không OK), N9 (GET `matting.mask`
  + `asset.meta.matting.mask`; UI THẬT hiện khối số đo từ **cả ba** nguồn; mã AMBIGUOUS có câu riêng).
- **Sửa** `test/imagestudio-round9-hardening.test.js`: kỳ vọng câu chữ của nhánh nhập nhằng đổi theo
  N7b (`CHƯA ĐỦ CHẮC…` + `KHÔNG ghép nền` + `vẫn được RETOUCH`, và **cấm** câu “sản phẩm vẫn được
  giữ nguyên”) — ghi rõ trong test.

### 15.5 Còn lại

- **N2 vẫn là giới hạn vật lý** (≤ 8/255): ca `sản phẩm 251 + logo` vẫn `OK` với `cov` tụt
  0.4307 → 0.1329 (thân bị ăn) — đã ghi hợp đồng + khuyến nghị provider `http`/AI.
- **`r3e-ui-claim.mjs` crash ở dòng 66** sau bản vá: script giả định “bật cờ ⇒ có ảnh ra”, nhưng
  ca N7 nay là NGUY HIỂM nên cờ không mở đường và **không có ảnh** ⇒ `rendered` rỗng. Đây là hệ quả
  ĐÚNG của bản vá (lỗi giả định trong script của phản biện, không phải lỗi repo).
- **Ngưỡng `1.0` và `DIRTY_DEEP_MIN_DISTANCE = 2` chọn từ ảnh TỔNG HỢP** (bóng mềm 0.061–0.196 vs
  ăn sản phẩm 2.24–19.23); ảnh chụp thật (JPEG→PNG, nền màu, bóng lớn) chưa đo.
- Đường `http` vẫn **chưa đo end-to-end**; chưa đo PostgreSQL/trình duyệt thật/queue đa tiến trình.

---

## 16. MVP-05 — vòng 2: sửa PB-01…PB-08 của phản biện

Phán quyết vòng 1: **FAIL** (`docs/MVP-05-REVIEW.md`: “mất tiền của người dùng”, “tạo tiền từ hư
không”, “chạy lại miễn phí”, “không có đường tạo owner”). Đã sửa cả 8 mục.
`npm test` → **826 test · 825 pass · 0 fail · 1 skipped**; `verify.mjs` EXIT=0;
`imagelab-demo.mjs` → `succeeded`; probe cũ `mvp05-refund-retry.probe.mjs` đã **chuyển thành
`test/mvp05-refund-retry.test.js`** (3 khẳng định, XANH).

### 16.1 PB-01 (CAO) — giữ tiền rồi trả 4xx mà không hoàn

`src/http/routes.js` thêm `withHoldRelease()`; áp cho **cả 5 chỗ** đã giữ tiền (kể cả nhánh
`ingest` lỗi và `queue.enqueue` lỗi).

```
$ node /tmp/mvp05-atk/atk8-confirm.mjs   §8.3 (5 request 409 liên tiếp)
[audit sau 5 request 409] OK rows=11 sum=1 balance=1 reasons={"admin_grant":1,"job_hold":-0.0415,"job_refund":0.0415}
  số dư: {"amount":1} → {"amount":1}  (mất 0 credit)     ← vòng 1: 1 → 0.9585, KHÔNG dòng hoàn
$ node test/mvp05-refund-retry.test.js   → (3) request 4xx sau khi giữ tiền ⇒ có dòng hoàn, ví về đúng cũ ✅
```

### 16.2 PB-02 (CAO) — chạy lại miễn phí

`run_key` mới trong `wallet_ledger` (migration cộng thêm) + chu kỳ theo LƯỢT CHẠY ở hook;
`regenerate`/`render`/`generate` giữ tiền ngay trong request; trần `BILLING_MAX_RUNS_PER_JOB`
⇒ `429 RERUN_LIMIT_EXCEEDED`.

```
$ node /tmp/mvp05-atk/atk4-gate.mjs   §G3 (1 lượt chạy + 3 regenerate)
regenerate #1..#3 → 202, usage_events 2→4→6→8
[audit sau 3 lần regenerate] OK rows=9 sum=0.982 balance=0.982
  balance: 0.9982 → 0.982                                  ← vòng 1: 0.9982 → 0.9982 (miễn phí)
$ node /tmp/mvp05-atk/atk8-confirm.mjs §8.2 (chạy lại SAU khi job lỗi đã hoàn tiền)
  sổ theo job: [job_hold −0.0083, job_refund +0.0083, job_hold −0.0078, job_settle +0.0052]
  lần 2: status=succeeded, balance=0.9974                   ← vòng 1: balance = 1 (miễn phí)
```

### 16.3 PB-03 (CAO) — không có đường tạo owner đầu tiên

`AccountService.bootstrapOwner()` + `config.auth.ownerEmail` (`OWNER_EMAIL`) + CLI
`npm run make-owner -- <email>` + README/`.env.example`; không có owner và không có `OWNER_EMAIL`
⇒ log WARN hướng dẫn.

```
$ SQLITE_PATH=<DB mới> npm run make-owner -- owner@example.com
✅ Đã TẠO owner owner@example.com.  MẬT KHẨU TẠM (chỉ in lần này): …   (chạy lần 2: idempotent)
$ node /tmp/gop11/pb03-e2e.mjs
1) CLI: ✅ Đã TẠO owner owner@example.com | MẬT KHẨU TẠM …   2) owner login → 200
3) GET /api/admin/users → 200   4) cấp credit → 201 {"amount":1,"currency":"USD"}
5) user chạy job → 202 (KHÔNG còn 402)
```

### 16.4 PB-04 (TB) — refund sau settle tạo tiền

`refundForJob` trả dòng settle cũ khi lượt đã settle; thêm **partial unique index**
`uniq_wallet_ledger_run_reason` (SQLite + PostgreSQL, tạo sau migration).

```
$ node /tmp/mvp05-atk/atk7-race.mjs
§7.3: 20 lần đua settle+refund: số lần bị thu ĐÚNG (0.9) = 20; số lần job THÀNH RA MIỄN PHÍ (1.0) = 0
§7.4: sau settle: balance=0.9 (đã thu 0.1) → refund → balance cuối = 0.9 ⇒ ok
      ← vòng 1: §7.3 = 0/20 thu đúng (20/20 miễn phí); §7.4 hoàn thêm +0.1 ⇒ balance 1.0
```

### 16.5 PB-05…PB-08

| # | Sửa gì | Bằng chứng |
|---|---|---|
| PB-05 | `defaultGrant` nối thật vào `register()` (`reason='grant'`); `holdBeforeJob=false` ⇒ không giữ trước, không 402, có log WARN + `/api/config.billing` nói thật | test `PB-05` (2 ca): `credit_granted.amount = 5`, ví 5, 1 dòng `grant`; `hold_before_job:false` ⇒ job 202 với ví 0 + 0 dòng `job_hold` |
| PB-06 | `normalizeAmount` chặn tràn số + trần `BILLING_MAX_AMOUNT` ⇒ 400 | `node atk6-money.mjs` §6.5: `credit amount=1e308 → 400 INVALID_AMOUNT` (vòng 1: 201 + dòng `amount=0`); test HTTP: 400 + sổ không thêm dòng |
| PB-07 | `amount` âm ⇒ `reason='adjustment'`; `0`/không phải số ⇒ 400; giảm quá số dư ⇒ 400 `INSUFFICIENT_CREDIT` | `node atk6-money.mjs` §6.5: `amount=-5 → 400 INSUFFICIENT_CREDIT` (ví 0); test: `-0.5` ⇒ 201 `adjustment`, số dư 1.25 → 1 |
| PB-08 | bucket theo (email chuẩn hoá, IP), chỉ đếm lần SAI, 429 + `Retry-After`, đăng nhập ĐÚNG không bị chặn; ghi chú `trust proxy` ở `docs/SECURITY.md` | `/tmp/gop11/pb08-check.mjs`: `14 lần SAI → {"401":9,"429":5}`, 429 đầu tiên ở **lần 10**; `đăng nhập ĐÚNG sau khi bucket đầy → 200`; email khác → 401 |

### 16.6 Test thêm & phần chưa sửa được

- **Thêm** `test/mvp05-round2-hardening.test.js` (14 test cho PB-01…PB-08) và
  `test/mvp05-refund-retry.test.js` (3 test — chuyển từ probe cũ, đã **xoá** `*.probe.mjs`).
- **Sửa** 1 khẳng định cũ trong `test/mvp05-api.test.js`: `amount = -1 ⇒ 400` đổi thành
  `-0.25 ⇒ 201 adjustment` (PB-07 đổi hành vi có chủ đích) + thêm ca `-99 ⇒ 400 INSUFFICIENT_CREDIT`.
- **Chưa sửa được / giới hạn đã biết:**
  · `run_key` khoá theo LƯỢT CHẠY dựa trên sổ + trạng thái job: nếu hai lượt chạy **chồng thời gian**
    trên cùng job (route gọi `beforeJob` khi lượt trước CHƯA settle) thì hook coi là CÙNG lượt ⇒ lượt
    thứ hai không mở hold mới. **Ca đo được còn lại: `atk8-confirm.mjs` §8.1 — retry TỰ ĐỘNG của hàng
    đợi sau khi job lỗi**: lượt retry chạy khi dòng `job_refund` của lượt trước CHƯA kịp ghi ⇒ hook
    thấy lượt cũ còn mở ⇒ chạy lại KHÔNG mở hold mới (`rows=3 sum=1 balance=1`). Đường người dùng bấm
    (`regenerate`/`render`/`generate` sau khi job đã dừng) thì ĐÃ thu đúng — xem §16.2. Sửa triệt để
    cần cho hàng đợi chờ `afterJob` xong trước khi retry (thay đổi tầng queue/pipeline, ngoài phạm vi
    vòng này). Chưa đo với nhiều tiến trình (`#locks` vẫn trong bộ nhớ — giới hạn đã ghi từ vòng 1).
  · `BILLING_HOLD_BEFORE_JOB=false` ở chế độ nhiều tiến trình: lượt settle-only dựa vào sổ để suy ra
    `run_key`, hai tiến trình có thể cùng mở một lượt ⇒ chưa đo.
  · Chưa đo: PostgreSQL thật cho partial unique index (chỉ chạy SQLite), reverse proxy thật cho
    `trust proxy`, trình duyệt thật cho UI credit âm.

---

## 17. MVP-05 — vòng 3: sửa BR-01…BR-07 của phản biện vòng 2

Phán quyết vòng 2: **FAIL** — “bản vá PB-02 phát sinh lỗi thu thừa ở ĐƯỜNG MẶC ĐỊNH” (BR-07).
Đã sửa cả 7 mục. `npm test` → **836 test · 835 pass · 0 fail · 1 skipped**; `verify.mjs` EXIT=0;
`imagelab-demo.mjs` → `succeeded`.

### 17.1 BR-07 (CAO, đường mặc định) — thu theo usage TÍCH LUỸ của cả job

`usage_events.run_key` + `recordUsage({runKey})` + `usageSummary(jobId, {runKey})`; pipeline gắn
`run_key` của lượt vào mọi event và truyền vào `afterJob`; `settleForJob` chỉ thu **chi phí của
riêng lượt** (fallback: `max(0, tổng usage − Σ đã thu các lượt trước)`).

```
$ node /tmp/mvp05-atk2/t13-overcharge-unit.mjs
  lượt 1: hold=JOB-OVER#1 · usage TÍCH LUỸ=0.1 · chi phí THẬT của lượt=0.1 · settle=0.4 · balance=0.9
  lượt 2: hold=JOB-OVER#2 · usage TÍCH LUỸ=0.2 · chi phí THẬT của lượt=0.1 · settle=0.4 · balance=0.8
  lượt 3: hold=JOB-OVER#3 · usage TÍCH LUỸ=0.3 · chi phí THẬT của lượt=0.1 · settle=0.4 · balance=0.7
  lượt 4: hold=JOB-OVER#4 … settle=0.4 · balance=0.6      ← KHÔNG còn bị chặn oan
  TỔNG chi phí THẬT = 0.5 · TỔNG ĐÃ THU = 0.5 ⇒ không thu thừa
        (vòng 2: settle 0.4/0.3/0.2 ⇒ thu 0.6 cho 0.3, lượt 4 INSUFFICIENT_CREDIT)

$ node /tmp/mvp05-atk2/t12-overcharge.mjs
  chi phí THẬT từng lượt: [0.0018 ×4] · TỔNG THẬT = 0.0072
  TỔNG ĐÃ THU = 0.0072 ⇒ không thu thừa          (vòng 2: 0.018 = +150%)
  sổ: hold#1,settle#1 … hold#4,settle#4 (mỗi lượt 0.0083/0.0065)

$ node /tmp/mvp05-atk2/t11-render-final.mjs
  sổ: ["job_hold@#1=-0.0027","job_settle@#1=0.0015","job_hold@#2=-0.0027","job_settle@#2=0.0012"]
  ⇒ lượt render chỉ bị thu phần CỦA LƯỢT (0.0015), không phải cả job 0.0027

$ node /tmp/mvp05-atk/atk4-gate.mjs   §G3 (3 lượt regenerate)
  balance: 0.9982 → 0.9928 · tổng chi phí thật usage = 0.0072   (vòng 2: → 0.982, tức 0.018)
```

### 17.2 BR-01 — `BILLING_HOLD_BEFORE_JOB=false` (trần 3)

```
$ node /tmp/mvp05-atk2/t7-regression.mjs   §T7.1
[audit sau lượt 1] OK rows=2 … reasons={"admin_grant":1,"job_settle":-0.0018}
  lượt 2: HTTP 202 · balance=0.9964 · dòng sổ=3 · usage={"events":4,…}
  lượt 3: HTTP 202 · balance=0.9946 · dòng sổ=4 · usage={"events":6,…}
  lượt 4: HTTP 429 · balance=0.9946 · dòng sổ=4      ← trần CÓ tác dụng
  sổ cuối: ["job_settle=-0.0018","job_settle=-0.0018","job_settle=-0.0018"]
  ⇒ có thu tiền            (vòng 2: 202/202/202, số dư 0.9982 không đổi, 0 dòng settle)
```

### 17.3 BR-02 — chồng nhau; BR-05 — lượt lỗi không ăn trần; BR-06 — ingest lỗi

```
$ node /tmp/mvp05-atk2/t9-overlap.mjs
  A=202 B=409
  sổ: ["job_hold@#1=-0.0083","job_settle@#1=0.0065","job_hold@#2=-0.0083","job_settle@#2=0.0065"]
  số lượt (run_key) = 2 · số lần chạy thật = 2 · số lần bị giữ tiền = 2 ⇒ mỗi lượt chạy đều bị giữ tiền
        (vòng 2: A=202 B=202 · 3 lượt chạy thật nhưng chỉ 2 lượt bị thu)

$ node /tmp/mvp05-atk2/t10-cap-failed.mjs
  job.status=failed error=TEMPLATE_NOT_FOUND · số lượt đã tiêu: 2
  balance = {"amount":1} (các lượt lỗi đều được hoàn) · chạy lại sau khi job lỗi → HTTP 202
        (vòng 2: 429 {runs:2,max_runs:2} — job chưa từng thành công đã bị khoá)

$ node /tmp/mvp05-atk2/t4-pb04-proc.mjs      (BR-03: 2 tiến trình chung 1 file SQLite)
  §T4.2 settle‖refund: A ok (job_settle 0.4) · B {"code":"ERR_SQLITE_ERROR","message":"database is locked"}
    CÓ CẢ settle VÀ refund cho cùng run? false ⇒ không · balance cuối = 0.9 (thu đúng)
  §T4.3 hai settle: số dòng settle = 1 · balance = 0.9    §T4.4 hai refund: số dòng refund = 1 · balance = 1
  §T4.1 50 lần đua trong 1 tiến trình: thu ĐÚNG = 50 · job MIỄN PHÍ = 0
  Ghi chú: lỗi `database is locked` ở tiến trình thua là lỗi HẠ TẦNG (đã map thành `LEDGER_BUSY`
  khi đi qua tầng billing); điều quan trọng: **không** run nào vừa settle vừa refund, số dòng đóng
  = 1, số dư đúng. `beforeJob` gặp lỗi sổ ⇒ 503 `BILLING_UNAVAILABLE` (fail-closed, xem test).
```

### 17.4 Hồi quy vòng 1 + ẩn danh + migration

```
$ node /tmp/mvp05-atk/{atk8-confirm,atk7-race,atk4-gate}.mjs
  atk8 §8.3: 5×409 ⇒ balance 1 → 1, sổ 5 hold + 5 refund        (PB-01 vẫn xanh)
  atk8 §8.2: job lỗi đã hoàn → regenerate mở lượt #2, thu 0.0018 (PB-02 vẫn xanh)
  atk7 §7.3: 20/20 thu đúng 0.9, 0 lần miễn phí · §7.4 balance cuối 0.9 ⇒ ok  (PB-04 vẫn xanh)
$ node /tmp/mvp05-atk2/t7-regression.mjs §T7.2/§T7.3
  3 job ẨN DANH (0 cookie) → 202 · dòng sổ = 0        (luật #1 không đổi)
  init() 2 lần trên DB CŨ → OK · cột wallet_ledger có thêm run_key, close_kind
```

### 17.5 Test thêm & phần chưa sửa được

- **Thêm** `test/mvp05-round3-hardening.test.js` (**10 test**: BR-01…BR-07, gồm cả ca fail-closed
  và ràng buộc DB chặn 2 dòng đóng cho cùng lượt).
- **Chưa sửa được / còn đo được:**
  · Hai tiến trình ghi sổ **cùng lúc** trên một file SQLite: một tiến trình vẫn nhận
    `database is locked` (dù `busy_timeout = 5000`) — nay được map thành `LEDGER_BUSY`/503 thay vì
    chạy free, nhưng **chưa** có retry tự động; PostgreSQL thật cũng **chưa đo**.
  · `usage_events.run_key` của các dòng CŨ là NULL; chúng được quy về lượt `#1`, nên trên DB cũ
    lượt `#1` vẫn có thể gộp usage của nhiều lượt lịch sử (không thể tái tạo dữ liệu đã mất).
  · BR-02 chặn bằng 409 khi lượt đang mở: nếu client chạy **hai tiến trình** cùng job (không qua
    route) thì vẫn phụ thuộc trạng thái sổ (đã có unique index bảo vệ, chưa đo đa tiến trình).
  · Chưa đo: reverse proxy thật cho `trust proxy`, hàng đợi đa tiến trình, PG partial unique index.

---

## 18. MVP-05 — vòng 4: sửa BR-08 + BR-09 của phản biện vòng 3

Phán quyết vòng 3: **PASS CÓ ĐIỀU KIỆN** (2 lỗ mới). Đã sửa cả hai.
`npm test` → **842 test · 841 pass · 0 fail · 1 skipped**; `verify.mjs` EXIT=0; `imagelab-demo.mjs`
→ `succeeded`.

### 18.1 BR-08 — lượt TREO (hold không có dòng đóng) ⇒ thu hồi, hết 409 vĩnh viễn

`store.listOpenJobHolds()` + `BillingService.reconcileStuckRuns()` (hoàn 100% + `meta.reconciled`,
`meta.stuck_ms`), gọi lúc boot, trước 409, và qua `POST /api/admin/billing/reconcile`.

```
$ node /tmp/mvp05-atk3/u3b-stuck.mjs        (ngưỡng MẶC ĐỊNH 15 phút = ĐỐI CHỨNG ÂM)
  SAU khi settle lượt 2 bị lỗi: balance=1.9899 sổ=["job_hold@#1","job_settle@#1","job_hold@#2"]
  chạy lại lần 3/4/5 → HTTP 409 JOB_ALREADY_RUNNING run_key=#2
  ⇒ lượt CÒN MỚI: KHÔNG bị thu hồi, vẫn 409 (không cắt ngang job đang chạy thật) ✔

$ node /tmp/gop13/u3b-low.mjs               (cùng kịch bản, hạ ngưỡng qua configOverrides)
  SAU khi settle lượt 2 bị lỗi: balance=1.9899 sổ=[... "job_hold@#2"]
  chạy lại lần 3 → HTTP 202
    sau lần 3: balance=1.9964 sổ=[hold#1, settle#1, hold#2, job_refund@#2=0.0083, hold#3, settle#3]
  chạy lại lần 4 → HTTP 202 · sau lần 4: balance=1.9946 (hold#4, settle#4)
  POST /api/admin/billing/reconcile → HTTP 200 {"reconciled":0,"refunded":0,"older_than_ms":50}
  ⇒ 4 hold, 4 dòng đóng ⇒ MỌI lượt đều đã khép (không còn kẹt) ✔

$ node --test test/mvp05-round4-hardening.test.js
  ✔ lượt quá hạn ⇒ hoàn 100% + có dòng đóng; lượt CÒN MỚI ⇒ không đụng
  ✔ HTTP: lượt treo quá hạn ⇒ request sau KHÔNG còn 409, tiền được hoàn, lượt mới bị thu
  ✔ route bảo trì: member ⇒ 403, owner ⇒ 200 kèm {reconciled, refunded}
```

Ghi chú trung thực: harness của phản biện (`/tmp/mvp05-atk3/lib3.mjs`) dựng config từ một object env
cố định nên **không** đọc biến môi trường `BILLING_STUCK_RUN_MS`; muốn chạy ca "thu hồi" với script
của họ phải truyền `configOverrides` — đó chính là `/tmp/gop13/u3b-low.mjs` (bản sao 1:1 kịch bản,
chỉ khác ngưỡng).

### 18.2 BR-09 — không thu lại usage của lượt ĐÃ HOÀN

```
$ node /tmp/mvp05-atk3/u1-br07.mjs
  U1.1: TỔNG THẬT=0.3 · TỔNG ĐÃ THU=0.3 ⇒ KHÔNG thu thừa ✔
  U1.2 (HTTP 4 lượt): TỔNG THẬT=0.0072 · TỔNG ĐÃ THU=0.0072 ⇒ KHÔNG thu thừa ✔
  U1.3: #1 (usage NULL) thu 0.5 · #2 (usage gắn #2) thu 0.2 · #3 (không usage riêng) thu 0
  U1.4: lượt #1 LỖI → refund 0.5 (hoàn 100%) · lượt #2 (KHÔNG usage riêng): thu 0 ⇒ KHÔNG thu lại ✔
        (vòng 3: thu 0.3 — tức thu lại đúng phần vừa hoàn)

$ node /tmp/mvp05-atk3/u6-late-usage.mjs
  lượt 1: thu 0.1 · ghi thêm usage 0.2 cho LƯỢT 1 SAU khi đã settle
  lượt 2 (usage riêng 0.3): thu 0.3 (KHÔNG thu phần đến muộn của lượt 1)
  lượt 3 (không usage riêng): thu 0 ⇒ không thu      (vòng 3: thu 0.2 của lượt 1)
  tổng chi phí THẬT đã ghi = 0.6 · tổng ĐÃ THU = 0.4  ← thu THIẾU 0.2 (có chủ ý: thà thiếu hơn thừa)
```

### 18.3 Không hồi quy (script phản biện vòng 2)

```
$ node /tmp/mvp05-atk2/t13-overcharge-unit.mjs   → TỔNG ĐÃ THU = 0.5 ⇒ không thu thừa
$ node /tmp/mvp05-atk2/t12-overcharge.mjs        → TỔNG ĐÃ THU = 0.0072 ⇒ không thu thừa
$ node /tmp/mvp05-atk2/t9-overlap.mjs            → A=202 B=409 · mỗi lượt chạy đều bị giữ tiền
$ node /tmp/mvp05-atk2/t7-regression.mjs §T7.1   → lượt 4 HTTP 429 · "⇒ có thu tiền"
```

### 18.4 Test thêm & phần chưa sửa được

- **Thêm** `test/mvp05-round4-hardening.test.js` (**6 test**: BR-08 ba chiều — thu hồi lượt cũ, không
  đụng lượt mới (409), route bảo trì 403/200; BR-09 ba ca — lượt đã hoàn, usage đến muộn, DB cũ).
- **Chưa sửa được / còn đo được:**
  · Thu hồi lượt treo dựa trên **ngưỡng thời gian**: một job bị treo vẫn phải chờ tới
    `BILLING_STUCK_RUN_MS` (mặc định 15 phút) mới chạy lại được (trước đó vẫn 409).
  · Thứ tự `created_at` giữa các dòng trong cùng mili-giây là ngẫu nhiên; BR-09 vì vậy dùng bộ đếm
    xác định thay cho so sánh thời gian, nhưng usage ghi bởi **tiến trình khác** (không qua
    `recordUsage` của repo) vẫn có thể bị quy nhầm lượt — chưa đo.
  · Usage đến muộn của lượt đã khép bị **bỏ** (thu thiếu) — cố ý, đã ghi trong hợp đồng §7.2.
  · Chưa đo: PostgreSQL thật cho `listOpenJobHolds` (NOT EXISTS + partial index) và cho
    `reconcileStuckRuns`; chưa có job định kỳ (cron) gọi reconcile — hiện chỉ boot/409/route tay.

---

## 19. MVP-05 — vòng 5: BR-10 (không cắt ngang lượt đang chạy) + BR-11 (dấu vết usage)

Phán quyết vòng 4: **PASS** + 2 cảnh báo. Đã sửa cả hai.
`npm test` → **849 test · 848 pass · 0 fail · 1 skipped**; `verify.mjs` EXIT=0; `imagelab-demo.mjs`
→ `succeeded`.

### 19.1 BR-10 — reconcile không cắt ngang lượt ĐANG CHẠY

`reconcileStuckRuns` nhận `isJobActive` (app bơm: `queue.isPending` hoặc status `queued|running`)
⇒ bỏ qua lượt của job đang chạy; `force` cho admin; đáy an toàn `minStuckRunMs` chỉ áp cho đường
KHÔNG kiểm được trạng thái job.

```
$ node /tmp/mvp05-atk4/v2-br09-boot.mjs   §V2.4 (hạ ngưỡng 300ms, job chậm 2s, bắn 2 request)
  HTTP: A=202 B=409
  sổ: hold/settle cho 2 lượt (KHÔNG có job_refund nào)
  chi phí THẬT tổng=0.0036 · ĐÃ THU=0.0036 ⇒ không hụt
        (vòng 4: 3 lượt chạy thật, chi phí 0.0054 mà chỉ thu 0.0036 = THU THIẾU 0.0018)
  §V2.3 boot reconcile: "trước restart: balance=1.9899 · lượt MỞ=1" → "sau restart: balance=1.9982
        (trước 1.9899) · lượt MỞ=0" ⇒ boot đã thu hồi ✔

$ node /tmp/mvp05-atk4/v1-br08.mjs
  §V1.1: dòng refund: [{"run_key":"#2","amount":0.0083,"reconciled":true,"stuck_ms":28937}] ⇒ PHỤC HỒI ĐƯỢC ✔
  §V1.2 (đối chứng âm, ngưỡng mặc định): "có dòng refund nào mới không? không ✔" (vẫn 409)
  §V1.3 route admin: owner → 200 {"reconciled":1,"refunded":0.0083,"older_than_ms":1000,
        "skipped_active":0,"forced":false}; gọi lần 2 → {"reconciled":0} (idempotent)
        (member 403 · ẩn danh 401)

$ node /tmp/mvp05-atk4/v3-negative-regression.mjs
  §V3.2 admin ép reconcile (older_than_ms=0) cho lượt MỚI ⇒ "retry → 409" (KHÔNG cắt lượt mới),
        sau đó "admin reconcile older_than_ms=0 → 200 {reconciled:1, refunded:0.0083}" ⇒
        "chạy lại sau khi ép reconcile → 202"
  §V3.4 BR-07: TỔNG THẬT=0.0072 · ĐÃ THU=0.0072 ⇒ khớp ✔
```

### 19.2 BR-11 — dấu vết nguồn usage

```
$ node /tmp/mvp05-atk4/v3-negative-regression.mjs   §V3.3
  usage_unavailable: KHÔNG đọc được usage ⇒ thu 0 + meta + WARN · balance=1 (thu 0 ⇒ hoàn hết)

$ node --test test/mvp05-round5-hardening.test.js
  ✔ job KHÔNG tốn gì ⇒ meta.usage_source = 'none' (không phải 'unavailable')
  ✔ usage có nhưng KHÔNG thuộc lượt ⇒ usage_source='unavailable' + usage_unavailable + WARN
  ✔ usage của chính lượt ⇒ 'run'; usage DB cũ (không run_key) ⇒ 'legacy'
```

### 19.3 Không hồi quy (script vòng 3 + vòng 4)

```
$ node /tmp/mvp05-atk3/u1-br07.mjs  → U1.1: 0.3 = 0.3 ✔ · U1.2: 0.0072 = 0.0072 ✔
                                       U1.4: "lượt #2 (KHÔNG usage riêng): thu 0 ⇒ không thu lại ✔"
$ node /tmp/mvp05-atk3/u3b-stuck.mjs → lượt CÒN MỚI + ngưỡng mặc định: vẫn 409 (đối chứng âm)
$ node /tmp/mvp05-atk2/t13,t12,t9,t7 → mỗi lượt thu đúng phần của lượt; A=202 B=409; trần 429
```

### 19.4 Test thêm & phần chưa sửa được

- **Thêm** `test/mvp05-round5-hardening.test.js` (**7 test**: BR-10 bốn chiều — bỏ qua job đang
  chạy, đáy an toàn + WARN, ca HTTP "tổng thu = tổng thật", `force` + `meta.forced`; BR-11 ba ca —
  `none`, `unavailable` + WARN, `run`/`legacy`).
- **Chưa sửa được / còn đo được:**
  · `isJobActive` dựa vào trạng thái job: một tiến trình **chết** để lại job `running` vĩnh viễn ⇒
    reconciliation bỏ qua mãi (phải dùng `force: true`); chưa có heartbeat/TTL cho trạng thái job.
  · Đáy an toàn chỉ áp cho đường KHÔNG kiểm được trạng thái job — nghĩa là vẫn có thể cấu hình
    ngưỡng rất ngắn cho đường có `isJobActive`; rào thật ở đó là `queue.isPending` + status, chưa
    đo với hàng đợi **đa tiến trình**.
  · `/tmp/mvp05-atk4/v1-br08.mjs` §V1.4 crash trong **script của phản biện** (`no such table:
    wallet_ledger`) khi họ thử dựng lại boot trên store in-memory — không phải lỗi repo; ca boot
    được chứng minh bằng `v2 §V2.3` (DB file thật, restart thật).

---

## 20. MVP-04 (Video Studio offline) — vòng gộp: cái gì ĐO ĐƯỢC, cái gì KHÔNG

**Bối cảnh:** V1–V5 land chưa commit; `npm test` lúc bàn giao **1 fail** (`test/mvp05-api.test.js`
hardcode `pricing.length === 10`, nay 12 vì thêm `VIDEO_RENDER`/`VIDEO_ENCODE`). Vòng gộp: sửa test
+ **nối multi-ảnh → nhiều cảnh** + các điểm lệch nhỏ.

`npm test` → **856 test · 855 pass · 0 fail · 1 skipped**; `verify.mjs` EXIT=0; `imagelab-demo.mjs`
→ `succeeded`.

### 20.1 Nhiều ảnh ⇒ nhiều cảnh — ĐÃ CHẠY THẬT end-to-end

```
$ node --test test/mvp04-multi-scene.test.js
  ✔ 3 ẢNH (scenes[i].image) ⇒ plan 3 cảnh, asset_id mỗi cảnh khác nhau, GIF đủ khung
  ✔ ĐỐI CHỨNG NGƯỢC: 1 ảnh (chỉ `image`) ⇒ vẫn 1 cảnh như trước, không hồi quy
  ✔ CHỈ `scenes[i].image` (không có `image` top-level) ⇒ vẫn nhận job
  ✔ KHÔNG có ảnh nào ⇒ 400 MISSING_IMAGE; ảnh TRÙNG byte ⇒ khử còn 1 cảnh; quá trần ⇒ 413
  ✔ presets: `limits.max_scenes` có mặt + đúng giá trị chặn 413 (=24)
  ✔ cảnh báo "KHÔNG có tiếng" chỉ MỘT câu
  ✔ mở lại job: `plan.scenes[].texts` giữ nội dung chữ + `last_run.run_key` có thật

$ node /tmp/gop15/probe-multi.mjs      (HTTP thật, 6 ca)
A) image + scenes KHÔNG kèm image → 202 asset_ids = 1 ảnh · plan.scene_count = 1   (đối chứng ngược)
B) scenes[i].image (3 ảnh) → 202 asset_ids = 3 · plan.scene_count = 3 · durations=[250,250,250]
   GIF: {"frames":9,"w":900,"h":900,"valid":true} · 19593 byte   (= 3 × 250 ms × 12 fps)
C) CHỈ scenes[i].image (2 ảnh, không `image`) → 202 (2 asset_ids)   ← trước đây 400 MISSING_IMAGE
D) 3 ảnh TRÙNG byte ⇒ asset_ids = 1 (khử trùng sha256)
E) limits = {"max_image_bytes":8388608,"max_pixels":16000000,"max_seconds":30,"max_scenes":24}
F) 30 cảnh ⇒ 413 TOO_MANY_SCENES
```

`GET /api/videostudio/jobs/:id` trả `rendered[]` + `plan.scene_count` khớp số ảnh; `plan.scenes[]`
có `asset_id` **lấy từ DB** (khác nhau giữa các cảnh) + `texts` để UI hiện lại ô chữ;
`last_run.run_key = 9da6fb16-…` (trước: `null`).

### 20.2 Script tự kiểm của các agent (chạy lại sau khi gộp)

```
$ node /tmp/vs-v4-check/run.mjs      → ===== 48/48 PASS · 0 FAIL =====   (V4: API/IDOR/402/413/422/503)
$ node /tmp/mvp04-v3/demo.mjs        → TẤT CẢ KHẲNG ĐỊNH ĐỀU ĐÚNG ✔      (V3: pipeline/wiring/store)
$ node /tmp/vscheck/vs-real.test.mjs → 5/5 pass   (V5: payload V3/V4 chạy qua hàm render của UI)
$ node /tmp/vscheck/vs-ui.test.mjs   → 32/34 pass · 2 FAIL — HAI khẳng định cũ nói "API chỉ nhận
  1 ảnh/job" (đã lỗi thời sau vòng gộp):
    · "body gửi máy chủ: cảnh 1 ở `image`, metadata cảnh trong options.scenes…" (đòi scenes KHÔNG có ảnh)
    · "nhiều ảnh: nói THẲNG cảnh nào chưa gửi được (API 1 ảnh/job)" (đòi nhãn "chưa gửi được" ở cảnh 2+)
  Hai khẳng định này KHÔNG sửa được từ phía repo (`/tmp` thuộc agent V5) và mâu thuẫn trực tiếp với
  §2.5 nay đã chạy thật; hợp đồng + test repo đã khoá hành vi MỚI.
```

### 20.3 Giới hạn THẬT của MVP-04 (không tô hồng)

- **KHÔNG có tiếng**: mọi kết quả `audio: null` + cảnh báo “Video KHÔNG có tiếng…” (đúng một câu).
  Không có TTS/nhạc nền — muốn có tiếng phải cắm dịch vụ trả tiền.
- **MP4/H.264 CHƯA ĐO**: máy này **không có `ffmpeg`**; provider `ffmpeg` fail-closed bằng
  `FFMPEG_NOT_AVAILABLE` (không bịa). Đường đo được duy nhất là **GIF 89a** (bộ mã hoá LZW tự viết)
  và chuỗi khung PNG.
- **GIF là ảnh động 256 màu**: lượng tử hoá bảng màu (median-cut) ⇒ **có sai số màu**; `dither`
  mặc định `false`; số khung = `round(duration_ms/1000 × fps)`; không có âm thanh, không tua được
  như video thật.
- **Ảnh gốc bất biến** và **không kéo giãn**: chỉ `pad`/`crop` (ghi vào `plan.scenes[].fit` + cảnh báo
  đo được); ảnh ra đúng tỉ lệ preset (đo bằng pixel: 900×900 cho `vuong-1x1`).
- **Chữ trên video** theo luật chống bịa của MVP-03: khẳng định/số liệu thiếu bằng chứng ⇒ 422
  `VIDEO_TEXT_UNSUPPORTED_CLAIM`, **0 byte video** (đo ở V4 §(g): preflight chặn TRƯỚC khi tạo job).
- Chưa đo: ffmpeg thật, video nhiều giây (>30 s bị cắt theo trần preset), UI trên trình duyệt thật
  (chỉ đo hàm render thuần qua `/tmp/vscheck`).

---

## 21. R1 (độ tin cậy) — vòng sửa phản biện F1…F6

Phán quyết vòng 1: **FAIL** (`docs/R1-REVIEW.md`: 1 CRITICAL + 2 CAO + 3 VỪA). Đã sửa cả 6 mục.
`npm test` → **970 test · 969 pass · 0 fail · 1 skipped**; `verify.mjs` EXIT=0; `imagelab-demo.mjs`
→ `succeeded`; `test/imagelab-concurrency.test.js` **2/2** (2 request render song song ⇒ 2 asset +
2 usage).

### 21.1 F1 (CRITICAL) — crash-loop vượt `max_attempts`

`claimNextJob` có `attempts < max_attempts`; `requeueStaleJobs` chốt mục chạm trần thành `failed`;
`JobQueue.reclaimStale` đánh dấu job `failed` + `QUEUE_ATTEMPTS_EXHAUSTED` + `finished_at`.

```
$ node /tmp/r1-atk/q3_crashloop.mjs
vòng 1..3: status=running attempts=1..3 (max_attempts=3)
vòng 4:    status=failed  attempts=3
TỔNG số lần handler được gọi = 3 (max_attempts=3)      ← vòng 1: 8 lần, DB cuối `running`/attempts=8
DB cuối: [{"job_id":"job-0","status":"failed","attempts":3,"max_attempts":3}]
PASS :: k3': handler không chạy quá max_attempts=3 :: thực tế=3
PASS :: k3': sau khi hết lượt, mục phải 'failed' (không quay lại queued/running)
```

### 21.2 F2 (CAO) — cướp việc ⇒ chạy song song

`job_queue.heartbeat_at` + `touchQueueItem` + nhịp tim `stale_ms/3` (sàn 50ms) trong lúc chạy.

```
$ node /tmp/r1-atk/q4_steal.mjs
DB lúc A đang chạy: [{"status":"running","attempts":1,"locked_by":"A"}]
sau requeueStaleJobs: {"requeued":0,…} -> [{"status":"running","attempts":1,"locked_by":"A"}]
log: A-START … A-END (KHÔNG có B-START)   B=[null..null]
DB cuối: [{"status":"done","attempts":1,"locked_by":null}]
     ← vòng 1: B chạy LỌT TRONG A, attempts 1→2, job bị chạy 2 lần
```

### 21.3 F3 (CAO) — việc mồ côi đình trệ vô hạn

`JobQueue.pumpQueued()` + vòng poll `queue.pollMs` (mặc định 1s) + scheduler gọi mỗi nhịp.

```
$ node /tmp/r1-atk/q6_orphan.mjs
B boot + resume(): {"durable":true,"requeued":0,"restored":0,"skipped":0}
DB sau khi A chết: [job-0 running, job-1 queued, job-2 queued]
sau 6 nhịp cron: requeued=2 · B đã chạy được 3 VIỆC      ← vòng 1: 0 việc, phải restart
DB: [{"job_id":"job-0","status":"done","attempts":2},{"job_id":"job-1","status":"done"},{"job_id":"job-2","status":"done"}]
```

### 21.4 F4 (VỪA–CAO) — va chạm unique index báo sai mã (`25P02`/`LEDGER_BUSY`)

`appendLedger` ghi `ON CONFLICT DO NOTHING`/`OR IGNORE` ⇒ UNIQUE không abort transaction;
`#callStore` phân loại constraint TRƯỚC busy ⇒ `LEDGER_CONFLICT` (`retryable: false`); tx view có
`savepoint()`; section tự chạy lại khi tx bị abort.

```
$ node /tmp/r1-atk/l6_pg_rehold.mjs
SQLite:   hold lại CÙNG lượt sau khi đã đóng → ok skipped=true · holds=1 · errCode=null
PostgreSQL THẬT: hold lại CÙNG lượt → ok skipped=true run_key=rk-1 · holds=1 · errCode=null
     ← vòng 1: SQLite `LEDGER_BUSY` (retryable cho lỗi vĩnh viễn) · PG `25P02` thô
```

### 21.5 F5/F6 (VỪA)

```
$ node --test test/r1-fixes.test.js
  ✔ F5: chờ khoá ví quá hạn ⇒ LEDGER_BUSY có `retryable` (không treo vô hạn)
  ✔ F4: ghi trùng ⇒ LEDGER_CONFLICT (KHÔNG `retryable`), transaction vẫn ĐỌC được sau savepoint
  ✔ F1/F2/F3: trần attempts · heartbeat giữ lease · pumpQueued nhặt việc mồ côi (và KHÔNG nhặt lại
    mục đang chờ trong bộ nhớ ⇒ handler chạy đúng 1 lần)
$ node --test --test-concurrency=1 test/imagelab-concurrency.test.js   → 2/2
  (F6: hai request render KHÁC lượt ⇒ 2 mục, 2 asset, 2 usage — không bị gộp)
```

Khoá idempotency đường thật (F6): mọi `queue.enqueue` trong `src/http/routes.js` truyền
`meta.runKey = hold.run_key` của LƯỢT CHẠY ⇒ hai tiến trình cùng xếp một lượt = **1 mục/1 lần chạy**;
hai lượt khác nhau (hoặc khách ẩn danh không có ví) vẫn **2 mục/2 lần chạy** (MVP-05 §BR-02).

### 21.6 Test thêm & phần chưa sửa được

- **Thêm** `test/r1-fixes.test.js` (**8 test**: F1 hai chiều, F2 lease + idempotent trạng thái,
  F3 nhặt mồ côi + không nhặt trùng, F4 phân loại + đọc lại sau savepoint, F5 timeout khoá).
- **Sửa test cũ** theo hợp đồng mới: `test/r1-scheduler.test.js` (nhịp có thêm `claimed`/`exhausted`
  và cron nay **nhặt-chạy** mục vừa thu hồi), `test/r1-regression.test.js` (`job_queue` có thêm cột
  `heartbeat_at`), `test/mvp05-round{2,3}-hardening.test.js` (DB không còn ném UNIQUE thô ⇒
  `LEDGER_CONFLICT`).
- **Chưa sửa được / còn đo được:**
  · `/tmp/r1-atk/l6_pg_rehold.mjs` vẫn in `FAIL :: tiền không đổi (100)` cho CẢ SQLite lẫn
    PostgreSQL — đây là lỗi so sánh của chính script (nó so `balance` dạng object với số, in ra
    `[object Object]`); số liệu thật trong cùng output cho thấy số dư **không đổi** ở cả hai.
  · `q4_steal.mjs`/`q6_orphan.mjs` vẫn in `FAIL :: …` vì các dòng đó là **khẳng định cũ của script
    chứng minh lỗi** (script viết để bắt lỗi, không phải để xác nhận bản vá); số liệu đã đúng.
  · SQLite vẫn là **một khoá ghi toàn cục** (một file/một kết nối): trần chờ 5s chỉ bảo đảm fail
    SỚM, không làm cho ví và hàng đợi chạy song song thật. PostgreSQL giữ khoá **per-user**
    (`pg_advisory_xact_lock`).
  · Chưa đo: nhiều tiến trình PostgreSQL cho F1/F2/F3 (mới đo ở SQLite + `l6` PG một tiến trình).

---

## 22. R1 — vòng 3: A1…A6 + F5/F6 (chấm lại tại `f1e75c5`)

`npm test` → **977 test · 976 pass · 0 fail · 1 skipped**; `node --check` mọi file sửa ✓;
`verify.mjs` EXIT=0; `imagelab-demo.mjs` → `succeeded`; `test/imagelab-concurrency.test.js` 2/2.

### 22.1 A1 — boot đồng thời (SQLite)

```
$ node /tmp/r1-atk2/a1_boot_race.mjs
DB TRẮNG: 0/16 tiến trình CHẾT khi boot đồng thời · tỉ lệ chết: 0%
PASS :: A1.2: boot đồng thời trên DB trắng không được làm chết tiến trình nào :: chết=0/16
ĐỐI CHỨNG (DB đã init sẵn): 0/16 tiến trình chết
   ← vòng 2: 2–6/16 chết (13–38%), nguyên nhân: hai tiến trình cùng ALTER TABLE ⇒ duplicate column
```
Lặp lại độc lập 12 cặp (24 tiến trình): **chết 0/24** (trước khi vá: 3/24 với
`BOOT_FAIL … duplicate column name: user_id|run_key`).

### 22.2 A2 — hồi sinh mục chạm trần

```
$ node /tmp/r1-atk2/a2_revive.mjs
enqueue LẦN 2 (cùng id): revived=true status=queued attempts=0/2 · claim sau revive: NHẶT ĐƯỢC
PASS :: A2: mục revive phải nhặt được (chạy lại được) :: ok
lượt 2: handler chạy thêm 1 lần · events=["done(skipped=false)"]
PASS :: A2.2: enqueue lại CÙNG lượt chạy phải chạy lại thật (không nuốt lượt) :: chạy thêm=1
PASS :: A2.2: không còn mục queued nào vĩnh viễn không nhặt được :: n=0
   ← vòng 2: 10 lần dựng handler + 10 `done(skipped=true)` GIẢ trong 2s dù handler chạy 0 lần
```

### 22.3 A3 — fencing + tiền

```
$ node /tmp/r1-atk2/a3_lease_sigstop.mjs
1) giữ tiền cho lượt: -10 · balance 100 -> 90 (run_key=rk-1)
2) bản TRÙNG thất bại ⇒ hoàn tiền +10 · balance -> 100
3) bản GỐC thành công, settle chi phí 10 ⇒ job_settle -10 · balance -> 90
sổ: job_settle-10 , job_refund+10 , job_hold-10 , grant+100
   ← vòng 2: settle bị TỪ CHỐI ⇒ sản phẩm miễn phí, mất 10 credit
```
Fencing (đo trong `test/r1-fixes.test.js`): `completeQueueItem(id, {epoch:1})` sau khi mục bị claim
lần hai (epoch 2) ⇒ `false`; `failQueueItem(…, {epoch:1})` ⇒ `{ stale: true }`; trạng thái của
runner mới nguyên vẹn; runner cũ ghi log `queue.stale_result_discarded`.

### 22.4 A4 + F5 — mã lỗi khoá

```
$ node /tmp/r1-atk2/a44_poison.mjs
config lockTimeoutMs: queue=300 billing=300
  withLedgerLock(u2) #1: 2564ms · LỖI LEDGER_BUSY · inTx=false
  claimNextJob #1: 2521ms · LỖI QUEUE_BUSY · inTx=false
  appendLedger(u2) #1: 336ms · LỖI LEDGER_BUSY · inTx=false
  claimNextJob #3 (holder đã nhả): 1ms · OK · withLedgerLock(u2) #2: 1ms · OK
PASS :: A4.4: sau timeout, các thao tác khác KHÔNG được nổ mã thô ERR_SQLITE_ERROR :: ["QUEUE_BUSY","LEDGER_BUSY",null]
PASS :: A4.4: hồi phục hoàn toàn sau khi người giữ nhả khoá :: null/null
   ← vòng 2: ["QUEUE_BUSY","ERR_SQLITE_ERROR",null] (mã thô lọt ra)
```

### 22.5 A5 + A6 + F6

- A5: `PRAGMA busy_timeout = config.queue.lockTimeoutMs` (đặt TRƯỚC mọi pragma) + PG
  `SET LOCAL lock_timeout` / `statement_timeout`; ngân sách thử lại của `init()` bị chặn bởi
  `queue.lockTimeoutMs`.
- A6: `touchQueueItem('q')` (thiếu `workerId`) ⇒ `false` (test mới trong `test/r1-fixes.test.js`;
  vòng 2 chỉ kiểm ca workerId SAI).
- F6: `grep -c "queue.enqueue(" src/http/routes.js` = 8 và `grep -c "runKey"` = 8 ⇒ **8/8** chỗ
  truyền khoá lượt (bổ sung `POST /api/jobs/:id/regenerate`).

### 22.6 KHÔNG hồi quy (script vòng 1 + vòng 2)

```
q3_crashloop  : TỔNG handler = 3 (max_attempts=3) · DB cuối status=failed attempts=3 · PASS ×2
q4_steal      : sau requeueStaleJobs {"requeued":0} · KHÔNG có B-START · DB cuối done/attempts=1
q6_orphan     : sau 6 nhịp cron: requeued=1 · B đã chạy được 3 việc (không cần restart)
l5_race_err   : sqlite hold errs=0 dupHold=0 bothClose=0 · pg hold errs=0 dupHold=0 bothClose=0
a5_pg_multi   : A5.1 (PG) chạm trần ⇒ failed+finished_at · claim=null · A5.2 B nhặt đủ 3 việc
```

### 22.7 GIỚI HẠN CÒN LẠI (ghi rõ, không im lặng)

1. **A5 chưa đạt đúng “~5s” trên SQLite.** Đo thật (`/tmp/gop18/a5-probe.mjs`): tiến trình thứ hai
   giữ khoá bằng `BEGIN IMMEDIATE` 9s ⇒ tiến trình sau **chờ tới khi chủ nhả (~8,5s)** rồi mới
   chạy được, KHÔNG cắt ở 5s như cấu hình. Nguyên nhân: SQLite chỉ có **một khoá ghi toàn cục** và
   `busy_timeout` áp cho từng câu lệnh; đường `init()` còn thử lại. PostgreSQL đã có
   `lock_timeout`/`statement_timeout` ở tầng máy chủ (per-transaction) nên **không** có giới hạn này.
2. **A3.1 vẫn đo được hai khoảng chạy CHỒNG NHAU khi tiến trình bị SIGSTOP** (máy ngủ/container
   pause): lease trông giống hệt tiến trình đã chết nên tiến trình khác CƯỚP là hợp lệ. Nay hệ quả
   đã được chặn: kết quả của runner cũ bị **BỎ** (epoch lệch, log `queue.stale_result_discarded`)
   và **tiền không mất** (quyết toán muộn `<runKey>#late`) — script A3.2 in ra `job_settle -10`
   thay vì để sản phẩm miễn phí. (Dòng `FAIL :: A3…` trong script là **khẳng định cũ** mã hoá lỗi
   của vòng 2, không phải số đo.)
3. Chưa đo: nhiều tiến trình PostgreSQL cho A1/A4 (mới đo SQLite cho A1/A4; PG đã đo cho F1/F3).
