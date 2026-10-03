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
