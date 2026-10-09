# ĐO PROVIDER THẬT LẦN 1 — DỊCH BẰNG DEEPSEEK

> **Đây là lần đầu tiên dự án gọi provider TRẢ TIỀN thật.** Mọi số trong tài liệu này do
> `tools/measure-translate-live.mjs` in ra từ phản hồi thật của API DeepSeek, không có số nào
> viết tay. Số liệu thô: xem mục [§9 Cách chạy lại](#9-cách-chạy-lại).

| | |
|---|---|
| Ngày đo | **2026-10-09**, 15:55–15:56 UTC (Thứ Sáu) |
| Nhánh / commit | `thanhbn123/live-measure-translate` · `f8d96a3` |
| Provider | **DeepSeek** (`https://api.deepseek.com`, định dạng OpenAI) |
| Model | **`deepseek-flash`** (= DeepSeek-V4.1-Flash) |
| API key | `sk-…7467` (đã che — key không bao giờ được in đủ ở bất kỳ đâu) |
| Khung giá lúc đo | **THẤP ĐIỂM** (off-peak) |
| Ngân sách chủ dự án cấp | ≤ 1.00 USD · trần cứng harness 0.80 USD |
| **TỔNG CHI PHÍ THỰC TẾ** | **0.003590 USD** (≈ 94 VNĐ) — dùng **0.36 %** ngân sách |
| Lời gọi | **5** (đúng trần: 5 sản phẩm × 1 lời gọi) |

---

## 1. Ngân sách đã tiêu — và vì sao không thể vượt

Harness đặt **bốn trần cứng** trong mã, kiểm **trước mỗi** lời gọi; vượt bất kỳ trần nào thì
ném `BudgetExceeded` và không gọi nữa:

| Trần | Giá trị | Thực tế đo được |
|---|---|---|
| `max_calls` | 5 | **5** (đạt trần, không vượt) |
| `max_input_tokens` (ước tính trước khi gọi) | 3000 | cao nhất **1072** |
| `max_output_tokens` | 2048 | cao nhất **2048** (một lần đụng trần — xem §5 L1) |
| `budget_usd` | 0.80 | **0.003590** |

**Vì sao `max_output_tokens` là 2048 chứ không phải 1500 như brief nêu ví dụ:** `src/imagelab/translate/ai.js`
đã ghi cứng `maxTokens: 2048` cho đường dịch của sản phẩm. Siết xuống 1500 là **đo harness
chứ không đo sản phẩm** — bản dịch sẽ bị cắt vì trần của tôi, không phải vì hành vi thật. Đặt
đúng 2048 giữ phép đo trung thực, và rủi ro tiền vẫn bằng 0: 5 × 2048 token ra ở giá thấp điểm
= **0.0061 USD** trong trường hợp xấu nhất tuyệt đối.

`max_input_tokens` đặt 3000 (không phải 1500) vì **chính prompt của sản phẩm** đã chiếm ~1000
token: `TRANSLATE_SYSTEM_PROMPT` (7 luật, tiếng Việt) + bảng thuật ngữ + 8–9 vùng chữ Hán.
Trần 1500 sẽ **chặn mọi lời gọi** và phép đo không bao giờ xảy ra.

---

## 2. Bảng giá dùng để tính — kèm nguồn và ngày

**Nguồn:** <https://api-docs.deepseek.com/quick_start/pricing> · **ngày đọc: 2026-10-09**.
Bảng này có hiệu lực từ **04:00 UTC ngày 2026-09-10** (<https://api-docs.deepseek.com/news/news260910>).

USD / 1 triệu token:

| Model | input (cache HIT) | input (cache MISS) | output |
|---|---|---|---|
| `deepseek-flash` — thấp điểm | 0.003 | 0.15 | 0.60 |
| `deepseek-flash` — cao điểm | 0.006 | 0.30 | 1.20 |
| `deepseek-v4-pro` — thấp điểm | 0.022 | 0.66 | 1.98 |
| `deepseek-v4-pro` — cao điểm | 0.044 | 1.32 | 3.96 |

**Cao điểm** = 01:00–04:00 và 06:00–10:00 UTC, Thứ Hai–Thứ Sáu (trừ ngày lễ Trung Quốc).
Ngoài các khung đó là thấp điểm, giá bằng **một nửa** cao điểm. Lúc đo là 15:55 UTC Thứ Sáu
⇒ **thấp điểm**. Harness **không** trừ ngày lễ Trung Quốc, nên nếu sai thì sai về phía
**đắt hơn thực tế** — ước tính an toàn, không bao giờ báo rẻ hơn hoá đơn.

> ⚠️ Đây là **ước tính theo đơn giá công bố × token API trả về**, KHÔNG phải hoá đơn.
> Chưa đối chiếu với bảng kê thanh toán của DeepSeek.

---

## 3. Bảng 5 sản phẩm — số đo thật

Mỗi sản phẩm = 1 tiêu đề + 5 điểm bán + 1 mô tả ngắn + 1–2 vùng thử guardrail (8–9 vùng),
gửi trong **đúng 1 lời gọi**. Thời gian là thời gian của lời gọi API.

| # | SKU | Kết quả | Thời gian | Token vào | (hit / miss) | Token ra | trong đó *reasoning* | `finish_reason` | Chi phí (USD) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `P1-juicer` máy ép mini | **OK** | 2 961 ms | 1 049 | 0 / 1 049 | 767 | 453 | `stop` | 0.000618 |
| 2 | `P2-earbuds` tai nghe BT | **OK** | 3 642 ms | 1 040 | 384 / 656 | 650 | 359 | `stop` | 0.000490 |
| 3 | `P3-dress` váy lụa | **FAILED** | 8 579 ms | 1 013 | 384 / 629 | 2 048 | **2 048** | **`length`** | 0.001324 |
| 4 | `P4-thermos` bình giữ nhiệt | **OK** | 3 576 ms | 1 072 | 384 / 688 | 924 | 626 | `stop` | 0.000659 |
| 5 | `P5-smartwatch` đồng hồ TM | **OK** | 2 625 ms | 1 028 | 384 / 644 | 670 | 388 | `stop` | 0.000500 |
| | **TỔNG** | **4/5 OK** | TB 4 277 ms | 5 202 | 1 536 / 3 666 | 5 059 | 3 874 | | **0.003590** |

Quan sát về tiền: **77 % token ra là token "suy nghĩ" (reasoning)** mà người dùng không bao giờ
thấy, nhưng vẫn bị tính tiền như token thường. Cache input bắt đầu ăn từ lời gọi thứ hai
(384 token hit — chính là `TRANSLATE_SYSTEM_PROMPT` lặp lại), rẻ hơn 50 lần so với cache miss.

**Tổng 42 vùng chữ:**

| Trạng thái | Số vùng | Nghĩa |
|---|---|---|
| `TRANSLATED` | 30 | dịch xong, 0 vi phạm |
| `NEEDS_REVIEW` | 2 | **bị tố oan** — xem §5 L2, L3 |
| `FAILED` | 7 | toàn bộ P3 — xem §5 L1 |
| `SKIPPED_BRAND` / `_CERTIFICATION` / `_PRICE` | 1 + 1 + 1 | chặn **trước** khi gọi, không gửi provider |
| **Gửi tới provider** | **39 / 42** | 3 vùng bảo vệ **chưa bao giờ** rời khỏi máy |

---

## 4. Nhận xét chất lượng dịch

### 4.1 Đúng — và đúng ở chỗ khó

Trên 30 vùng `TRANSLATED`, bản dịch **sát nghĩa, giữ đúng số liệu, văn phong bán hàng tự nhiên**:

| Chữ gốc | Bản dịch | Vì sao đáng ghi nhận |
|---|---|---|
| `容量300ml，一人份刚好够喝` | Dung tích 300ml, vừa đủ cho một người | giữ nguyên `300ml`; `一人份` dịch thoát đúng ý |
| `单耳重量仅4克，久戴不累` | Khối lượng mỗi bên tai chỉ 4g, đeo lâu không mỏi | `单耳` → "mỗi bên tai" (không dịch máy thành "tai đơn") |
| `内胆316不锈钢，不生锈无异味` | Ruột bình thép không gỉ 316, không gỉ, không mùi | giữ mã vật liệu `316` đúng vị trí |
| `电池容量5000mAh，续航72小时` | Dung tích pin 5000mAh, thời lượng pin 72 giờ | **cả hai số + đơn vị** nguyên vẹn |
| `充满一次可用八杯` | Sạc đầy một lần dùng được 8 cốc | `八` (chữ) → `8` (số) mà guardrail **không** tố oan |
| `保修12个月，杯体破损可换新` | Bảo hành 12 tháng, thân bình hư hỏng được đổi mới | khẳng định có thật trong gốc ⇒ dịch, **không** bị chặn |
| `正品行货，支持七天无理由退换` | Hàng chính hãng, hỗ trợ đổi trả trong 7 ngày | `七天` → `7 ngày`, `无理由` lược đúng kiểu TMĐT Việt |
| `来电和消息直接在手表上看，跑步时不用掏手机。` | Xem cuộc gọi và tin nhắn ngay trên đồng hồ, chạy bộ không cần lấy điện thoại. | câu dài, giữ trọn hai mệnh đề |

**Quan trọng nhất: KHÔNG CÓ MỘT CA BỊA NÀO.** Trên 30 vùng dịch được, model không tự thêm bảo
hành, chứng nhận, chống nước, "số 1", "tốt nhất" — tức `TRANSLATE_SYSTEM_PROMPT` (7 luật cấm)
có tác dụng thật trên dữ liệu thật, không chỉ trong test mock.

### 4.2 Sai / chưa đạt

| Chữ gốc | Bản dịch | Vấn đề | Mức |
|---|---|---|---|
| `办公室也放得下` (trong r7 của P1) | "văn phòng cũng để vừa" | **cộc, sai trật tự tiếng Việt.** Đúng phải là "để vừa trong văn phòng" / "đặt ở văn phòng cũng vừa" | văn phong, không sai nghĩa |
| `多功能果汁杯` | "cốc nước ép nhỏ đa năng" | `果汁杯` là **tên gọi loại máy**, dịch thành "cốc" nghe như đồ dùng rời | nhẹ |
| `双麦克风通话` | "Đàm thoại 2 mic" | nghĩa đúng nhưng `mic` là từ chen tiếng Anh; "2 micro" tự nhiên hơn | nhẹ |
| `表带可换，硅胶和金属两种` | "hai loại Silicon và Kim loại" | **viết hoa vô cớ** giữa câu ("Silicon", "Kim loại") | nhẹ |
| `气质长裙` (P3) | — | **không có bản dịch nào** vì cả sản phẩm FAILED | nặng, xem §5 L1 |

**Kết luận chất lượng:** với vùng dịch được, chất lượng **đủ dùng cho bước duyệt tay** — người
duyệt sửa văn phong, không phải dịch lại. Rủi ro thật **không nằm ở chất lượng dịch** mà nằm ở
độ tin cậy của lời gọi (§5 L1).

---

## 5. Guardrails trên dữ liệu thật

### 5.1 Lớp A — chặn TRƯỚC khi gọi (3/3 đúng)

Ba vùng bảo vệ **không bao giờ được gửi lên mạng**. Bằng chứng: harness rút `region_id:` ra khỏi
prompt mà sản phẩm thực sự dựng, và không thấy ba id này ở bất kỳ lời gọi nào
(`sent_to_provider: false`).

| Vùng gốc | Phải ra | Thực tế | Gửi provider? |
|---|---|---|---|
| `官方旗舰店授权销售` | `SKIPPED_BRAND` | ✅ `SKIPPED_BRAND` | **không** |
| `已通过质检，附检测报告与合格证` | `SKIPPED_CERTIFICATION` | ✅ `SKIPPED_CERTIFICATION` | **không** |
| `原价￥299 现价￥199 券后到手价更低` | `SKIPPED_PRICE` | ✅ `SKIPPED_PRICE` | **không** |

### 5.2 Lớp B — không tố oan bản dịch trung thực (3/3 đúng)

Theo yêu cầu: hai câu có **khẳng định** và một câu có **chữ số**, nhưng khẳng định/số **có thật
trong bản gốc** ⇒ phải dịch được và **không** bị chặn.

| Vùng gốc | Bản dịch thật | Kết quả | Đúng? |
|---|---|---|---|
| `保修12个月，杯体破损可换新` | Bảo hành 12 tháng, thân bình hư hỏng được đổi mới | `TRANSLATED`, 0 vi phạm | ✅ |
| `正品行货，支持七天无理由退换` | Hàng chính hãng, hỗ trợ đổi trả trong 7 ngày | `TRANSLATED`, 0 vi phạm | ✅ |
| `电池容量5000mAh，续航72小时` | Dung tích pin 5000mAh, thời lượng pin 72 giờ | `TRANSLATED`, 0 vi phạm | ✅ |

**7/7 mẫu thử guardrail đúng thiết kế** (3 lớp A + 3 lớp B + 1 `digits` thứ hai ở P5:
`待机时长可达30天` → "Thời gian chờ lên đến 30 ngày", giữ nguyên `30`).

### 5.3 Lớp C — bắt BỊA: tiêm khẳng định/số vào bản dịch THẬT (4/4 chặn)

Model thật **không bịa**, nên để đo luật chống bịa thì harness lấy **bản dịch thật** rồi **cố ý
tiêm** thêm khẳng định/số không có trong gốc, chạy lại `enforceTranslationGuardrails`.
*(Đây là đột biến nhân tạo trên dữ liệu thật — nói rõ để không nhập nhằng với hành vi của model.)*

| Bản dịch thật + phần tiêm | Kết quả | Vi phạm guardrail bắt được |
|---|---|---|
| "…cốc nước ép nhỏ đa năng **— bảo hành 24 tháng**" | ✅ `NEEDS_REVIEW` | số `24` bịa · đơn vị `tháng` bịa · khẳng định **bảo hành** |
| "…nghiền nhanh trái cây **— hàng chính hãng**" | ✅ `NEEDS_REVIEW` | khẳng định **chính hãng** |
| "Dung tích 300ml, vừa đủ cho một người **— dùng được 15 năm**" | ✅ `NEEDS_REVIEW` | số `15` bịa · đơn vị `năm` bịa |
| "…dùng được 8 cốc **— đã đạt chuẩn ISO 9001**" | ✅ `NEEDS_REVIEW` | số `9001` bịa · **đạt chuẩn** · **ISO** |

**4/4 bị chặn.** Luật chống bịa hoạt động trên dữ liệu thật, bắt cả ba loại: khẳng định, con số,
và đơn vị đi kèm.

### 5.4 Ba lỗi THẬT mà mock không bao giờ thấy

> Theo luật repo, tôi **không sửa `src/**`**; ba lỗi dưới đây đã báo coordinator kèm bằng chứng.

#### L1 — NẶNG: "thinking mode" ăn hết token ra ⇒ mất trắng 1/5 sản phẩm

`P3-dress` FAILED **toàn bộ 7/7 dòng** với `TRANSLATE_BAD_JSON`. Bằng chứng từ chính API:

```
finish_reason                                  = "length"
usage.completion_tokens                        = 2048   ← đụng trần
usage.completion_tokens_details.reasoning_tokens = 2048   ← TOÀN BỘ là token suy nghĩ
```

**Toàn bộ 2048 token output bị token suy nghĩ chiếm hết, không còn một token nào cho JSON.**
`extractJson()` trả `null` ⇒ `ai.js` ném `TRANSLATE_BAD_JSON` cho cả lô.

Nguyên nhân: `src/imagelab/translate/ai.js:137` ghi cứng `maxTokens: 2048`, trong khi
DeepSeek-V4.1-Flash **bật thinking mode MẶC ĐỊNH** và token suy nghĩ **tính vào** `max_tokens`.
Bốn sản phẩm kia reasoning 359–626 token nên vừa đủ sống. Tức đây là **lỗi xác suất**:
quan sát 1/5 ⇒ **~20 %** lượt dịch mất trắng, không đoán trước được.

Fail-closed vẫn đúng (trả `FAILED` + mã lỗi, không bịa bản dịch), nhưng **mất 100 % dữ liệu của
sản phẩm đó mà vẫn bị trừ tiền** — lời gọi này là lời gọi **đắt nhất** trong cả năm lần
(0.001324 USD, 37 % tổng chi phí) và **chậm nhất** (8 579 ms, gấp 2.4× trung bình).

Ba hướng vá (chờ quyết): tắt thinking cho tác vụ dịch · nâng `max_tokens` · hoặc tự thử lại khi
`finish_reason === 'length'`.

#### L2 — VỪA: đơn vị `度` không được nhận ⇒ tố oan bản dịch đúng

`保温六小时后水温仍有55度` → "Giữ nhiệt 6 giờ, nhiệt độ nước vẫn còn 55 độ" — **dịch hoàn toàn
đúng**, vậy mà bị gắn *"Đơn vị 『độ』 không có trong chữ gốc"* ⇒ `NEEDS_REVIEW` oan.

```
unitsIn(ZH)              = [ 'giờ' ]
unitsIn(VI)              = [ 'giờ', 'độ' ]
unitAppearsInText(ZH,'độ') = true      ← helper BIẾT 度 = độ, và trả đúng
checkNumericClaims(…)    = [ 'Đơn vị “độ” không có trong chữ gốc…' ]
```

`UNIT_LITERALS['độ'] = ['°','độ','度']` đã có sẵn và `unitAppearsInText()` trả đúng — nhưng
nhánh `missingUnits` trong `checkNumericClaims()` lọc **chỉ bằng `unitsIn()`**, nên không bao giờ
gọi tới helper đó. `CN_UNIT_ALIASES` có `摄氏度` nhưng **thiếu `度` trơn** (đối chứng:
`unitsIn('水温55摄氏度')` = `['°c']`, không bị tố). Vá được bằng **một dòng**: thêm
`&& !unitAppearsInText(original, u)` vào filter.

#### L3 — VỪA: `双` (đôi/hai) không nằm trong bảng chữ số Hán ⇒ tố oan

`双麦克风通话` → "Đàm thoại 2 mic" bị tố *"Số liệu 『2』 không có trong chữ gốc"*.

```
numbersIn(ZH)      = []        ← 双 không có trong CN_NUMERAL_RUN
asciiNumbersIn(VI) = [ '2' ]
```

`CN_NUMERAL_RUN` = `[零〇一二两三四五六七八九十百千万亿]` — có `两` nhưng thiếu `双`
(và `俩`, `半`). Đối chứng: `六小时` → "6 giờ" **không** bị tố vì `六` có trong bảng.

**Hậu quả chung của L2+L3:** 2/32 vùng gửi đi (**6 %**) bị đẩy sang duyệt tay vô ích. Đây là
fail-closed nên **an toàn**, nhưng tốn công người thật.

#### L4 — nhẹ: bảng giá trong mã đã cũ

`PRICE_TABLE` ở `src/ai/provider.js:27` ghi `deepseek-chat: { in: 0.27, out: 1.1 }`. Đơn giá công
bố hiện tại (§2) là 0.15/0.60 thấp điểm và 0.30/1.20 cao điểm cho `deepseek-flash`; bảng trong mã
**không có** khái niệm cao/thấp điểm lẫn bậc cache-hit (0.003/0.006) ⇒ `estimateCostFromUsage()`
lệch khoảng **1.8×**. Số trong báo cáo này **không bị ảnh hưởng** vì harness mang bảng giá riêng,
có nguồn và ngày đọc.

### 5.5 Đính chính: `deepseek-chat` VẪN SỐNG

Tài liệu DeepSeek (changelog 2026-04-24) và nhiều nguồn bên thứ ba nói `deepseek-chat` bị khai tử
từ 2026-07-24. **Probe thật cho kết quả ngược lại:**

```
model = "deepseek-chat" → usage { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
```

Endpoint vẫn trả lời bình thường. Nghĩa là `.env` của repo (`AI_MODEL=deepseek-chat`) **không
làm sập** đường dịch. Nhưng model đó **không còn trên trang giá**, nên **không có đơn giá công
bố** để tính chi phí trung thực — đó là lý do phép đo này dùng `deepseek-flash`.

---

## 6. Tổng chi phí

| Khoản | Giá trị |
|---|---|
| Token vào (cache MISS) | 3 666 × 0.15 / 1M = 0.000550 USD |
| Token vào (cache HIT) | 1 536 × 0.003 / 1M = 0.0000046 USD |
| Token ra | 5 059 × 0.60 / 1M = 0.003035 USD |
| **TỔNG** | **0.003590 USD** (≈ **94 VNĐ**) |
| Ngân sách cấp | 1.00 USD ⇒ **đã dùng 0.36 %**, còn lại 0.9964 USD |
| Nếu chạy giờ cao điểm | ước 0.007180 USD (gấp đôi) |

**Suy ra chi phí vận hành** (dịch 1 sản phẩm ≈ 9 vùng chữ, 1 lời gọi, giá thấp điểm):

| Quy mô | Chi phí ước tính |
|---|---|
| 1 sản phẩm | ~0.00072 USD (≈ 19 VNĐ) |
| 1 000 sản phẩm | ~0.72 USD |
| 10 000 sản phẩm | ~7.2 USD |

⚠️ Chưa tính: **phần phải dịch lại** vì lỗi L1 (~20 %) và OCR/vision (chưa đo — §8).

---

## 7. Nhãn nào giờ đã `LIVE_VERIFIED`

| Phần | Trước | **Sau phép đo này** |
|---|---|---|
| Đường dịch `createTranslator` + `TRANSLATE_PROVIDER=ai` → DeepSeek thật | `MOCK_VERIFIED` | **`LIVE_VERIFIED`** |
| Guardrail chặn trước khi gọi (brand/cert/price không rời máy) | `MOCK_VERIFIED` | **`LIVE_VERIFIED`** |
| Guardrail chống bịa (khẳng định/số/đơn vị) | `MOCK_VERIFIED` | **`LIVE_VERIFIED`** (lớp A+B trên bản dịch thật; lớp C là đột biến nhân tạo trên dữ liệu thật) |
| Đo chi phí theo usage API thật | chưa có | **`LIVE_VERIFIED`** |
| Chất lượng dịch Trung→Việt | chưa đo | **`LIVE_VERIFIED`** — 30/42 vùng, có ví dụ đúng/sai ở §4 |

Chi tiết + phần vẫn là `MOCK_VERIFIED` / `MANUAL_INPUT`: `docs/VERIFICATION.md` §23.

---

## 8. CÒN GÌ **CHƯA** ĐO

> Tất cả những mục dưới đây **chưa được cấp key / chưa được cấp ngân sách**. Chúng vẫn chạy bằng
> `*_PROVIDER=mock` và **phải giữ nhãn `MOCK_VERIFIED`**. Không được suy ra từ phép đo này.

| Hạng mục | Trạng thái thật | Vì sao chưa đo |
|---|---|---|
| **Vision** (`src/vision/**`, G07 đọc ảnh sản phẩm) | `MOCK_VERIFIED` | chưa cấp key provider vision; gửi ảnh ⇒ token vào gấp nhiều lần, cần ngân sách riêng |
| **OCR** (`src/imagelab/ocr/**` dò vùng chữ trên ảnh) | `MOCK_VERIFIED` + `MANUAL_INPUT` | chạy bằng fixture `mock-regions.json`; ảnh thật hiện đi đường **nhập vùng tay (IL-08)** |
| **Matting / tách nền** (MVP-03) | `MOCK_VERIFIED` | chưa cấp key provider matting |
| **TTS** (MVP-04 video) | `MOCK_VERIFIED` | chưa cấp key TTS |
| **Render provider HTTP** (`RENDER_PROVIDER=http`) | `MOCK_VERIFIED` | chưa có máy chủ render thật |
| Dịch **ảnh thật đầu-cuối** (OCR thật → dịch thật → vẽ lại) | **chưa đo** | khâu OCR còn mock ⇒ chưa nối được chuỗi thật |
| Chi phí dịch ở **giờ cao điểm** | **chưa đo** | phép đo rơi vào thấp điểm; §6 chỉ là ước tính ×2 |
| **Hoá đơn thật** của DeepSeek | **chưa đối chiếu** | §2/§6 là đơn giá công bố × token, không phải bảng kê thanh toán |
| Tần suất thật của lỗi L1 | **chưa đo** | quan sát 1/5; cần cỡ mẫu lớn hơn mới ra tỉ lệ đáng tin |
| `deepseek-v4-pro` (model đắt hơn) | **chưa đo** | ngoài phạm vi ngân sách lần này |

---

## 9. Cách chạy lại

```bash
# Không tốn tiền — kiểm đường đi bằng MockProvider:
node tools/measure-translate-live.mjs --dry-run --out /tmp/dry.json

# Đo thật (ĐỌC KEY TỪ .env, KHÔNG BAO GIỜ in key ra):
node tools/measure-translate-live.mjs \
  --env-file /đường/dẫn/tới/.env \
  --model deepseek-flash \
  --max-calls 5 --max-input-tokens 3000 --max-output-tokens 2048 \
  --budget-usd 0.8 \
  --probe-legacy-model \
  --out /tmp/live.json
```

Không có key ⇒ harness in `✖ CHƯA CÓ KEY` và **thoát mã 2**; không bao giờ giả vờ đã đo.

**Harness đo đúng đường của sản phẩm:** nó gọi `createTranslator({ translate: { provider: 'ai' } })`
— prompt, chia lô, parse JSON, guardrails đều là mã sản phẩm. Harness **không tự gọi HTTP thô**;
nó chỉ **bọc** provider thật (`createProvider`) bằng một lớp đo/chặn tiền (`BudgetGuard`) rồi bơm
vào qua tham số `aiProvider`. Lớp bọc không đổi prompt, không đổi endpoint — chỉ đếm lời gọi,
siết `maxTokens`, cộng chi phí và **dừng khi đụng trần**.

**Bảo mật:** key chỉ dùng để tạo header `authorization`. Mọi chỗ in ra đều qua `maskKey()`
(`sk-…7467`). File số liệu thô `live.json` **không chứa key** — chỉ chứa dạng đã che.
`.env` **không** được commit.

---

## 10. Bối cảnh test

```
$ env -u DATABASE_URL npm test
tests 1069 · pass 1063 · fail 0 · skipped 6 · todo 0   (exit 0)
```

⚠️ Hai điểm cần ghi đúng sự thật:
1. **Đừng chạy `npm test` trần** — `DATABASE_URL` trỏ PostgreSQL đã tắt ⇒ 6 test PG fail
   `ECONNREFUSED`, không phải lỗi mã.
2. Số test **lệch so với baseline được giao** (brief ghi 1090 · 1084 pass). Trên worktree này
   (`f8d96a3`) con số đo được là **1069 · 1063 pass**, lệch 21 test — có thể baseline của brief
   lấy từ nhánh khác. **`fail = 0`** nên vẫn coi là xanh, nhưng ghi lại để không ai tưởng đã mất test.

Phép đo này **không sửa một dòng `src/**` nào** — chỉ thêm `tools/measure-translate-live.mjs`
và hai tài liệu.
