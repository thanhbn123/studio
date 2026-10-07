#!/usr/bin/env bash
# =============================================================================
# NGHIỆM THU — VIP PRODUCT STUDIO      ./deploy/verify.sh staging|production
# =============================================================================
# Chỉ lệnh này sinh phiếu cho production (deploy/state/staging-pass/<id>.json).
#
# ⚠️  §12.1 của CLAUDE.md, viết lại cho script này: thứ dùng để kiểm chứng phải
#     ĐỘC LẬP với thứ được kiểm chứng. Nên:
#       · không tin release.json để biết mã nào đang chạy — chính lượt deploy
#         viết nó. Mã đang chạy đo bằng băm nội dung file trên máy chủ, so với
#         cây commit bằng CÙNG MỘT công thức.
#       · "container tồn tại" KHÔNG phải "ứng dụng chạy được".
#       · mỗi phạm vi không đo được thì in ra, không bỏ qua.
# =============================================================================
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
load_conf
select_env "${1:-}"
require_host

if [ "$ENV_NAME" = staging ]; then
  PROBE_PORT="$STAGING_PORT"
  PROBE_WHAT="thẳng vào app (dự án này KHÔNG có tầng proxy trong compose)"
else
  PROBE_PORT="$PRODUCTION_PROXY_PORT"
  PROBE_WHAT="thẳng vào app (dự án này KHÔNG có tầng proxy trong compose)"
fi

PASS=0; FAIL=0
p() { ok "$1"; PASS=$((PASS+1)); }
f() { bad "$1"; FAIL=$((FAIL+1)); }

step "NGHIỆM THU $ENV_NAME — $(_ts)"
log "phép đo HTTP đi $PROBE_WHAT, từ bên trong máy chủ (127.0.0.1:$PROBE_PORT)"

CUR="$(remote_capture <<REMOTE
readlink "$ENV_ROOT/current" 2>/dev/null | xargs -r basename || true
REMOTE
)"
[ -n "$CUR" ] || die "không đọc được current trên $ENV_NAME — chưa triển khai bản nào?"
log "current: $CUR"
CP="$(compose_prefix "$CUR")"

# --- 1. Các service compose đang chạy ------------------------------------
want="$COMPOSE_DB_SERVICE $COMPOSE_APP_SERVICE"
[ "$ENV_NAME" = production ] && want="$want $COMPOSE_NGINX_SERVICE"
for svc in $want; do
  out="$(remote_capture <<REMOTE
cd "$ENV_ROOT/releases/$CUR" && $CP ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s=$svc '\$1==s{print \$2}'
REMOTE
)"
  case "$out" in
    running) p "service $svc: running" ;;
    "")      f "service $svc: KHÔNG có trong compose ps" ;;
    *)       f "service $svc: $out" ;;
  esac
done

# --- 2. Số lần container tự dựng lại -------------------------------------
# "running" khi RestartCount tăng dần nghĩa là nó đang chết rồi được dựng lại.
out="$(remote_capture <<REMOTE
cd "$ENV_ROOT/releases/$CUR"
id=\$($CP ps -q $COMPOSE_APP_SERVICE 2>/dev/null | head -1)
[ -n "\$id" ] && docker inspect -f '{{.RestartCount}}' "\$id" || echo "-"
REMOTE
)"
case "$out" in
  0) p "app chưa phải dựng lại lần nào (RestartCount=0)" ;;
  -|"") f "không đọc được RestartCount ⇒ chưa kết luận app ổn định" ;;
  *) f "app RestartCount=$out — đang chết rồi tự dựng lại" ;;
esac

# --- 3. Health ----------------------------------------------------------
out="$(app_probe "$HEALTH_PATH" "$PROBE_PORT")"
[ "$out" = "200" ] && p "$HEALTH_PATH → 200" || f "$HEALTH_PATH → $out"

# --- 4. Health nói CSDL ok, và không lộ DSN -----------------------------
body="$(remote_capture <<REMOTE
curl -s -m 10 "http://127.0.0.1:$PROBE_PORT$HEALTH_PATH" || echo '{}'
REMOTE
)"
case "$body" in
  *'"ok":true'*|*'"ok": true'*) p "health báo db.ok = true" ;;
  *) f "health không báo database ok: $(printf '%s' "$body" | head -c 200)" ;;
esac
case "$body" in
  *postgresql*|*password*|*@*:*5432*) f "health trả ra thứ giống DSN/credential — phải sửa, không phải ghi chú" ;;
  *) p "health không chứa DSN/credential" ;;
esac

# --- 5. CSDL nối được, và các bảng schema.sql khai báo có mặt -----------
#
# ⚠️  DỰ ÁN NÀY KHÔNG CÓ PHIÊN BẢN LƯỢC ĐỒ. `src/store/schema.sql` toàn
#     `CREATE TABLE IF NOT EXISTS` và `migrate.js` không ghi bảng phiên bản
#     nào. Vì vậy câu "migration ở head" là câu KHÔNG đo được ở đây, và phiếu
#     này không nói câu đó.
#
#     Đo được: tập bảng mà schema.sql khai báo đều CÓ MẶT trong CSDL.
#     KHÔNG đo được: một CỘT thêm vào schema.sql về sau đã tới CSDL hay chưa —
#     `CREATE TABLE IF NOT EXISTS` thấy bảng đã tồn tại là bỏ qua, nó không
#     ALTER. Đây là một rủi ro thật của dự án, không phải giới hạn của phép đo;
#     xem docs/DIRECT-DEPLOY.md §6.
KHAI="$(remote_capture <<REMOTE
grep -oE 'CREATE TABLE IF NOT EXISTS [a-z_]+' "$ENV_ROOT/releases/$CUR/src/store/schema.sql" 2>/dev/null \
  | awk '{print \$NF}' | LC_ALL=C sort -u
REMOTE
)"
COTHAT="$(remote_capture <<REMOTE
cd "$ENV_ROOT/releases/$CUR"
$CP exec -T $COMPOSE_DB_SERVICE psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "select tablename from pg_tables where schemaname='public'" 2>/dev/null | tr -d ' \r' | LC_ALL=C sort -u || echo LOI
REMOTE
)"
if [ -z "$KHAI" ]; then
  f "không đọc được schema.sql trên máy chủ ⇒ chưa kết luận được về lược đồ"
elif [ "$COTHAT" = "LOI" ] || [ -z "$COTHAT" ]; then
  f "không truy vấn được CSDL $PG_DB"
else
  THIEU="$(comm -23 <(printf '%s\n' "$KHAI") <(printf '%s\n' "$COTHAT"))"
  if [ -z "$THIEU" ]; then
    p "đủ $(printf '%s\n' "$KHAI" | wc -l | tr -d ' ') bảng mà schema.sql khai báo (KHÔNG chứng minh được cột mới đã tới)"
  else
    f "CSDL THIẾU bảng: $(printf '%s' "$THIEU" | tr '\n' ' ')"
  fi
fi

# --- 6. Trang chính + tài sản tĩnh --------------------------------------
# Cùng một bộ cho hai môi trường: dự án này không có tầng proxy, nên không có
# phép kiểm nào "chỉ có nghĩa ở production".
for path in "/" "/api/health"; do
  out="$(app_probe "$path" "$PROBE_PORT")"
  [ "$out" = "200" ] && p "GET $path → 200" || f "GET $path → $out"
done
# Thứ KHÔNG được phục vụ ra ngoài thì phải 404/403. `app` chạy bằng chính thư
# mục bản phát hành, nên nếu máy chủ tĩnh phục vụ sai gốc thì mã nguồn, test và
# `.env` sẽ fetch được — đây là phép đo cho đúng điều đó.
for path in "/package.json" "/docker-compose.yml" "/src/server.js" "/.env" "/test"; do
  out="$(app_probe "$path" "$PROBE_PORT")"
  case "$out" in
    404|403) p "GET $path → $out (đúng: không phục vụ)" ;;
    200) f "GET $path → 200 — ĐANG PHÁT TÁN thứ không nên phục vụ" ;;
    *) f "GET $path → $out" ;;
  esac
done

# --- 7. Smoke test KHÔNG PHÁ DỮ LIỆU -----------------------------------
# Gọi health kèm một tham số rác: chứng minh tiến trình còn phục vụ và không
# sập vì đầu vào lạ, mà không tạo bản ghi nào. Dự án này có đường tạo nội dung
# bằng AI (tốn tiền thật), nên smoke test CỐ Ý không gọi đường đó.
out="$(app_probe "/api/health?x=%27%22%3E" "$PROBE_PORT")"
case "$out" in
  200) p "health với tham số rác → 200 (không sập, không tạo bản ghi)" ;;
  *)   f "health với tham số rác → $out" ;;
esac
# Đường tốn tiền phải KHÔNG mở công khai không xác thực. Chỉ gửi GET để không
# tạo việc gì; mục này đo CỬA, không đo chức năng.
out="$(app_probe "/api/generate" "$PROBE_PORT")"
case "$out" in
  401|403|404|405) p "GET /api/generate → $out (không mở công khai)" ;;
  200) f "GET /api/generate → 200 — đường gọi AI mở công khai, đây là tiền thật" ;;
  *)   warn "GET /api/generate → $out (chưa kết luận; kiểm tay)" ;;
esac

# --- 8. Log lỗi và log secret -------------------------------------------
out="$(remote_capture <<REMOTE
cd "$ENV_ROOT/releases/$CUR"
$CP logs --since 10m $COMPOSE_APP_SERVICE 2>&1 | grep -cE 'Traceback|CRITICAL|ERROR' || true
REMOTE
)"
[ "${out:-0}" = "0" ] && p "log 10 phút: 0 dòng Traceback/ERROR/CRITICAL" \
  || f "log 10 phút có $out dòng lỗi"
out="$(remote_capture <<REMOTE
cd "$ENV_ROOT/releases/$CUR"
$CP logs --since 60m $COMPOSE_APP_SERVICE 2>&1 \
  | grep -cE 'POSTGRES_PASSWORD|ADMIN_API_TOKEN|postgresql(\+psycopg)?://[^ ]*:[^ @]*@' || true
REMOTE
)"
[ "${out:-0}" = "0" ] && p "log 60 phút: 0 dòng khớp mẫu secret" || f "log có $out dòng khớp mẫu secret"

# --- 9. Mã đang chạy so với Git — phép đo độc lập -----------------------
step "9. ĐỐI CHIẾU MÃ ĐANG CHẠY VỚI GIT"
SHA_LOCAL="$(git_sha)"
rsha="$(remote_tree_sha "$CUR")"
tmp="$(mktemp -d)"
git -C "$REPO_ROOT" archive --format=tar "$SHA_LOCAL" | tar -x -C "$tmp"
lsha="$( cd "$tmp" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 \
          | awk '{print $1"  "$2}' | shasum -a 256 | awk '{print $1}' )"
rm -rf "$tmp"
log "băm máy chủ : ${rsha:-(không đo được)}"
log "băm máy trạm: ${lsha:-(không đo được)}"
if [ -z "$rsha" ]; then
  f "KHÔNG đo được băm trên máy chủ ⇒ không kết luận mã đang chạy khớp Git"
elif [ "$rsha" = "$lsha" ]; then
  p "mã trên máy chủ KHỚP BYTE với cây commit $SHA_LOCAL"
else
  f "mã trên máy chủ KHÁC cây commit $SHA_LOCAL"
fi

# --- 10. Đo từ ngoài Internet — CHƯA CÓ ---------------------------------
if [ "$ENV_NAME" = production ]; then
  if [ -n "${PRODUCTION_URL:-}" ]; then
    step "10. ĐO TỪ NGOÀI INTERNET"
    code="$(http_probe "${PRODUCTION_URL%/}$HEALTH_PATH" 20)"
    case "$code" in
      200\ *) p "health qua Internet trên $PRODUCTION_URL → 200" ;;
      *) f "health qua Internet → $code (DNS? proxy? tường lửa?)" ;;
    esac
    log "phạm vi: một lượt GET. Nó KHÔNG nói gì về chứng chỉ, header, hay tải."
  else
    warn "chưa có PRODUCTION_URL ⇒ KHÔNG đo được gì từ ngoài Internet"
    warn "mọi mục trên đo ở 127.0.0.1 TRÊN máy chủ — không nói gì về DNS/TLS/proxy"
  fi
fi

step "PHẠM VI CỦA PHIẾU NÀY"
cat <<SCOPE
  Đo: service compose, số lần dựng lại, health, CSDL + migration head,
  smoke test không phá dữ liệu, log lỗi, log secret, băm mã so với cây commit.
  KHÔNG đo: hành vi dưới tải; trình duyệt thật; chất lượng ảnh/video sinh ra;
  và TLS/header/rate-limit ở tầng proxy — compose của dự án này KHÔNG có tầng đó,
  nên ai đặt proxy trước nó phải nghiệm thu riêng.
SCOPE

step "KẾT QUẢ: $PASS đạt · $FAIL không đạt"
if [ "$FAIL" -ne 0 ]; then
  [ "$ENV_NAME" = staging ] && { rm -f "$(gate_file "$CUR")"; log "KHÔNG sinh phiếu (và xoá phiếu cũ của $CUR nếu có)"; }
  die "nghiệm thu $ENV_NAME KHÔNG ĐẠT — $FAIL mục hỏng. Production vẫn bị chặn."
fi

if [ "$ENV_NAME" = staging ]; then
  mkdir -p "$STATE_DIR/staging-pass"
  G="$(gate_file "$CUR")"
  cat > "$G" <<JSON
{
  "project": "$PROJECT",
  "release_id": "$CUR",
  "git_sha": "$SHA_LOCAL",
  "verified_at": "$(_ts)",
  "staging_host_tree_sha256": "$rsha",
  "local_tree_sha256": "$lsha",
  "checks_passed": $PASS,
  "checks_failed": 0,
  "scope_note": "compose chi co app+db, KHONG co proxy/TLS — phieu nay khong nghiem thu tang proxy",
  "verified_by": "deploy/verify.sh"
}
JSON
  ok "đã sinh phiếu staging PASS: $G"
  printf '\n  BƯỚC TIẾP THEO: Owner nghiệm thu, rồi ./deploy/production.sh\n'
else
  ok "production nghiệm thu ĐẠT cho bản $CUR"
fi
