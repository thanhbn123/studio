# Triển khai trực tiếp — VIP PRODUCT STUDIO

> **Theo §20 của `CLAUDE.md`** (anh Thành chốt 07/10/2026): GitHub Actions không
> phải cửa quyết định triển khai. GitHub giữ ba việc — lưu mã, lưu lịch sử, đánh tag.
>
> **Trạng thái thật lúc viết (07/10/2026, 21:0x +0700):**
>
> | | |
> |---|---|
> | Bộ `deploy/` | **CÓ** — 76/76 ca thử tại máy đạt |
> | Dự án đã triển khai ở đâu chưa | **CHƯA** — không script nào trong repo gọi `ssh`/`scp`/`rsync`, và `deploy.conf` để trống mọi host |
> | Docker trên máy viết bộ này | **KHÔNG CÓ** (Mac mini) ⇒ chưa lần nào build ảnh hay chạy compose |
>
> Bộ này dựng **trước** lượt triển khai đầu tiên, đúng §20.6: có `deploy/` trước,
> rồi mới triển khai — không triển khai tay rồi hợp thức hoá sau.

---

## 1. Năm lệnh

```bash
./deploy/staging.sh          # test tại máy → đóng gói → lên staging
./deploy/verify.sh staging   # nghiệm thu; CHỈ lệnh này sinh phiếu cho production
./deploy/production.sh       # chỉ nhận bản có phiếu, đúng SHA
./deploy/verify.sh production
./deploy/rollback.sh production
```

`DEPLOY_DRY_RUN=1` trước lệnh nào cũng được: in kế hoạch, **không chạm máy chủ**,
và mọi bước chưa làm được in là `CHƯA LÀM` thay vì `PASS`.

### Ba cửa khoá, cả ba fail closed

| Cửa | Chặn gì |
|---|---|
| cây làm việc sạch | mã chưa commit = mã không có SHA. Script **không** stash, **không** xoá gì của bạn |
| phiếu staging PASS **đúng SHA** | bản chưa ai nghiệm thu. Phiếu của SHA **khác** cũng bị từ chối |
| mã băm gói trùng | production phải là **đúng gói** đã test ở staging |

---

## 2. Kiểm tra tại máy

`deploy/deploy.conf` chạy đúng những gì CI chạy:

```bash
npm test                                  # node --test --test-concurrency=1
node src/store/migrate.js --driver sqlite
node tools/verify.mjs
```

Cờ `--test-concurrency=1` giữ nguyên, không "tối ưu": bộ test dùng CSDL dùng
chung, chạy song song là tự gây đỏ ngẫu nhiên.

Thiếu `node_modules` thì `staging.sh` **dừng** và bảo chạy `npm ci`, chứ không tự
chạy hộ — `npm ci` xoá sạch `node_modules`, và đó không phải việc một script
triển khai được tự quyết.

---

## 3. Bố cục trên máy chủ

```
<APP_ROOT>/<môi trường>/
├── releases/<release_id>/     toàn bộ cây repo của một bản (+ release.json)
├── current  →  releases/…     bản ĐANG CHẠY
├── previous →  releases/…     bản TRƯỚC (đích rollback)
├── shared/.env                SECRET — người đặt, script KHÔNG tạo, KHÔNG in
├── backups/<mốc>/             dump CSDL + metadata
└── history.log                sổ triển khai, chỉ ghi thêm
```

`release_id` dạng `YYYYMMDD-HHMMSS-<sha7>`. Thư mục bản phát hành **là** compose
context: `docker-compose.yml` nằm ở gốc repo, nên `compose_prefix()` trỏ
`releases/<id>/docker-compose.yml`. Đổi chỗ file compose thì sửa **đúng hàm đó**.

`shared/.env` được nối vào bản phát hành bằng liên kết mềm `releases/<id>/.env`,
nên đổi bản không làm mất cấu hình và không nhân thêm bản secret thứ hai.

**`AI_API_KEY` là tiền thật.** Nó nằm trong `shared/.env` trên máy chủ, không
bao giờ trong Git, và không script nào ở đây đọc nó về máy trạm hay in nó ra.

---

## 4. Hai môi trường, cùng một bộ service

`docker-compose.yml` chỉ có `app` + `db`. **Không có nginx, không có TLS.** Hai
môi trường khác nhau ở: tên project compose, cổng ngoài (staging 13000 /
production 13100), và file `.env`.

> **Hệ quả phải đọc:** mọi phép đo HTTP trong `verify.sh` gọi `127.0.0.1` **trên
> máy chủ**, thẳng vào ứng dụng. Chúng **không nói gì** về DNS, chứng chỉ,
> security header, hay rate limit ở tầng proxy — chưa có tầng đó. Ai đặt proxy
> trước nó thì phải nghiệm thu riêng, và sửa lại câu này cho đúng.

---

## 5. Sao lưu

`./deploy/backup.sh <môi trường>`: dump `pg_dump -Fc` kèm `.sha256`, **và đọc lại
bằng `pg_restore --list`** — một dump hỏng vẫn là một file có kích thước, và nó
sẽ chỉ lộ ra đúng lúc cần phục hồi. Cấu hình chỉ sao lưu **TÊN biến**, không giá
trị. Lượt triển khai đầu chưa có CSDL thì script nói ra và thoát 0, chứ không
làm như đã sao lưu được gì.

**Giới hạn còn nguyên:** bản sao lưu nằm trên chính máy chủ đó.

---

## 6. Lược đồ CSDL — ĐỌC KỸ MỤC NÀY

> **Dự án này KHÔNG CÓ phiên bản lược đồ.** `src/store/schema.sql` toàn
> `CREATE TABLE IF NOT EXISTS`, và `src/store/migrate.js` không ghi bảng phiên
> bản nào.

Hệ quả, cả hai đều thật:

1. **Câu "migration ở head" không đo được ở đây**, nên `verify.sh` không nói câu
   đó. Nó đo thứ đo được: tập bảng mà `schema.sql` khai báo có mặt đủ trong CSDL.
2. **Thêm một CỘT vào `schema.sql` sẽ KHÔNG tới CSDL đã có bảng đó.**
   `CREATE TABLE IF NOT EXISTS` thấy bảng tồn tại là bỏ qua — nó không `ALTER`.
   Trên máy mới thì đúng; trên máy đã chạy thì cột mới **im lặng không xuất
   hiện**, và lỗi sẽ nổ ở chỗ khác, muộn hơn, khó lần hơn.

`production.sh` vì vậy **báo khi `schema.sql` đổi** giữa bản đang chạy và bản
mới, kèm đúng cảnh báo trên. Nó báo, không tự xử — việc này không suy ra được
từ một con số.

**Rollback quay lại MÃ, không quay lại lược đồ**, và ở đây còn mạnh hơn: dự án
**không có đường hạ cấp nào cả**. Nên đổi lược đồ phải **tương thích ngược** —
mã cũ chạy được trên lược đồ mới. Tự viết một đường vá lùi trong lúc sự cố là
cách mất dữ liệu.

---

## 7. Đồng bộ GitHub

Sau khi production đã nghiệm thu:

```bash
git push origin HEAD
git tag -a "v<release_id>" -m "release <release_id>" && git push origin --tags
```

Push lỗi **không** làm lượt triển khai thành lỗi nếu bản đang chạy đã được xác
minh — nhưng phải báo `GITHUB_SYNC_PENDING = YES` và không để lịch sử local mất.

---

## 8. GitHub Actions — xem rồi, KHÔNG sửa gì

Rà ngày 07/10/2026. Một workflow `.github/workflows/ci.yml`, ba job:
`test-sqlite`, `test-postgres`, `smoke`.

| Hạng mục | Kết luận |
|---|---|
| Trùng lặp push/PR | **không có** — cả hai trigger đã giới hạn `main`/`develop` |
| Job nặng (trình duyệt, matrix lớn, build ảnh) | **không có** |
| Job tốn phí đáng cắt | **không có** |

Nên lượt này **không sửa CI**. Sửa để có cái mà sửa là thêm rủi ro không đổi lại
được gì. Cả ba job vẫn là lưới an toàn cho mã vào `develop`/`main`; chúng không
còn là **cửa quyết định triển khai**, và đó là toàn bộ thay đổi về vai trò.

---

## 9. Trước lượt triển khai thật đầu tiên

| Cần | Ai làm |
|---|---|
| một máy chủ (staging), có Docker + compose | anh Thành / cấp hạ tầng |
| khoá SSH tới máy đó, đặt trên máy sắp chạy deploy | anh Thành |
| `deploy/deploy.local.conf` điền host/user/khoá/URL | một lần, xem file mẫu |
| `shared/.env` trên máy chủ, có `POSTGRES_PASSWORD` và `AI_API_KEY` | người, một lần |

Có đủ bốn thứ đó thì `./deploy/staging.sh` là một lượt chạy thật. Trước đó, mọi
`PASS` ở đây là **LOCAL**, và **LOCAL PASS không thay thế STAGING PASS**.

---

## 10. Gỡ lỗi

| Triệu chứng | Nhìn trước tiên |
|---|---|
| `cây làm việc KHÔNG sạch` | `git status`. Script không stash hộ, cố ý |
| `chưa có node_modules` | `npm ci` |
| `require_host` dừng | `deploy/deploy.local.conf` — xem §9 |
| `thiếu shared/.env` | nó thuộc **máy chủ**, không phải máy trạm |
| health không lên 200 | `docker compose logs --tail 60 app`; `RestartCount > 0` nghĩa là nó đang chết rồi được dựng lại |
| `CSDL THIẾU bảng …` | chạy lại migration; nếu vẫn thiếu thì đọc §6 |
| `mã băm gói LỆCH` | HEAD đã khác bản đã nghiệm thu ⇒ staging lại |

Deploy hỏng thì **không sửa trực tiếp trên máy chủ**: rollback → sửa ở máy →
test → staging → deploy lại.
