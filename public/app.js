/**
 * VIP Product Studio — giao diện MVP-01.
 *
 * Không dùng framework. Mọi nội dung động đều đi qua `esc()` trước khi vào DOM —
 * dữ liệu sản phẩm đến từ trang của sàn và từ model, KHÔNG được tin.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

/* ─────────────────────────── Tiện ích ─────────────────────────── */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* giữ null */
  }
  if (!res.ok) {
    const err = new Error(json?.error?.message || `HTTP ${res.status}`);
    err.code = json?.error?.code;
    err.status = res.status;
    // MVP-03 (§3.5/§3.7): 422 `OVERLAY_UNSUPPORTED_CLAIM` trả danh sách vi phạm trong body
    // (E4 trả CẢ `error.details.violations` lẫn `violations` phẳng) — giữ nguyên cả hai để UI
    // hiện ĐÚNG các vi phạm đó, không nuốt mất.
    err.payload = json?.error || null;
    err.body = json || null;
    // Hợp đồng §3.5: 402 `INSUFFICIENT_CREDIT` ở BẤT KỲ thao tác nào cũng phải hiện rõ
    // số cần / số đang có + link nạp ⇒ bắt ngay tại tầng gọi API, không phụ thuộc từng màn hình.
    if (err.code === 'INSUFFICIENT_CREDIT' || res.status === 402) noteCreditAlert(err);
    throw err;
  }
  return json;
}

async function copyText(text, label = 'Đã copy') {
  try {
    await navigator.clipboard.writeText(text ?? '');
    toast(label);
  } catch {
    // Trình duyệt chặn clipboard (không phải https/localhost) → dùng cách dự phòng.
    const ta = document.createElement('textarea');
    ta.value = text ?? '';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(label);
    } catch {
      toast('Không copy được — hãy chọn và copy thủ công.');
    }
    ta.remove();
  }
}

const STATUS_LABEL = {
  queued: 'Đang chờ',
  running: 'Đang xử lý',
  succeeded: 'Hoàn tất',
  failed: 'Thất bại',
  needs_manual: 'Cần bổ sung dữ liệu',
};

const STAGE_LABEL = {
  starting: 'Bắt đầu',
  extracting: 'Đang lấy dữ liệu từ sàn',
  vision: 'Đang phân tích ảnh',
  merging: 'Đang hợp nhất tri thức',
  generating: 'Đang viết nội dung tiếng Việt',
  regenerating: 'Đang sinh lại nội dung',
  resuming: 'Đang chạy tiếp',
  needs_manual: 'Cần bạn bổ sung dữ liệu',
  done: 'Xong',
};

const SOURCE_LABEL = { taobao: 'Taobao', '1688': '1688', pinduoduo: 'Pinduoduo', manual: 'Thủ công', unknown: 'Không rõ' };

/* ───────────── MVP-02 — Dịch ảnh Trung → Việt (imagelab) ───────────── */

const IL_STATUS_LABEL = {
  queued: 'Đang chờ',
  running: 'Đang xử lý',
  awaiting_review: 'Chờ bạn duyệt',
  succeeded: 'Hoàn tất',
  failed: 'Thất bại',
  needs_manual: 'Cần bổ sung dữ liệu',
};

const IL_STAGE_LABEL = {
  queued: 'Xếp hàng',
  storing: 'Đang lưu ảnh gốc',
  ocr: 'Đang đọc chữ trong ảnh (OCR)',
  translating: 'Đang dịch sang tiếng Việt',
  awaiting_review: 'Chờ bạn duyệt bản dịch',
  rendering: 'Đang render ảnh mới',
  done: 'Xong',
  failed: 'Lỗi',
};

const IL_STAGE_ORDER = ['queued', 'storing', 'ocr', 'translating', 'awaiting_review', 'rendering', 'done'];

const IL_LINE_STATUS = {
  TRANSLATED: { label: 'Đã dịch', cls: 'ok' },
  GLOSSARY: { label: 'Từ điển thuật ngữ', cls: 'ok' },
  SKIPPED_BRAND: { label: 'KHÔNG dịch: nhãn hiệu', cls: 'warn' },
  SKIPPED_CERTIFICATION: { label: 'KHÔNG dịch: chứng nhận', cls: 'warn' },
  SKIPPED_PRICE: { label: 'KHÔNG dịch: giá', cls: 'warn' },
  // F-06: người dùng CHỦ ĐỘNG bỏ qua — khác "cần duyệt" (guardrail chặn).
  SKIPPED_BY_USER: { label: 'Bạn đã bỏ qua', cls: 'warn' },
  NEEDS_REVIEW: { label: 'Cần bạn duyệt', cls: 'warn' },
  USER_EDITED: { label: 'Bạn đã sửa', cls: 'ok' },
  FAILED: { label: 'Dịch lỗi', cls: 'bad' },
};

const IL_KIND_LABEL = { descriptive: 'Mô tả', brand: 'Nhãn hiệu', certification: 'Chứng nhận', price: 'Giá', unknown: 'Không rõ' };

// IL-08: 5 loại vùng hợp lệ của hợp đồng §3.2 — dùng cho select của bảng nhập tay.
const IL_MANUAL_KINDS = ['descriptive', 'brand', 'certification', 'price', 'unknown'];

// Luật 3: vùng nhãn hiệu / chứng nhận / giá KHÔNG BAO GIỜ tự dịch — chỉ override có vết.
const IL_LOCKED_KINDS = new Set(['brand', 'certification', 'price']);
const IL_LOCKED_STATUSES = new Set(['SKIPPED_BRAND', 'SKIPPED_CERTIFICATION', 'SKIPPED_PRICE', 'SKIPPED_BY_USER']);

const IL_SKIP_REASON = {
  TEXT_TOO_LONG: 'Chữ quá dài so với ô',
  BOX_TOO_SMALL: 'Ô quá nhỏ để vẽ chữ',
  NO_GLYPH: 'Thiếu glyph cho ký tự',
  BAD_BOX: 'Ô không hợp lệ',
  NEEDS_REVIEW: 'Bị guardrail chặn — chưa được bạn duyệt',
  SKIPPED_BY_USER: 'Bạn đã bỏ qua dòng này',
  PROTECTED_BOX_MASKED: 'Nằm trọn trong vùng bảo vệ (nhãn hiệu/chứng nhận/giá) — không xoá, không vẽ',
  EMPTY_TEXT: 'Không có chữ để vẽ',
};

/* ─────────────────────────── Trạng thái ─────────────────────────── */

const state = {
  config: null,
  view: 'home',
  jobId: null,
  job: null,
  poll: null,
  activeTab: 'tongquan',
  editing: false,
  history: [],
  // MVP-02 — tách riêng khỏi state của MVP-01 để không giẫm chân nhau.
  il: {
    jobId: null,
    job: null,
    poll: null,
    loading: null,
    pending: null, // { name, bytes, mime, base64, dataUrl }
    busy: false,
    error: null,
    overrides: new Set(),
    lastSave: null,
    renderBlocked: null,
    // IL-08 — nhập vùng chữ bằng tay. `open: null` = theo mặc định (mock OCR hoặc job chưa có
    // vùng); `rows: null` = chưa đổ từ job; `touched` = người dùng đã sửa tay bảng này.
    manual: {
      open: null,
      rows: null,
      touched: false,
      busy: false,
      error: null,
      notice: null,
      warnings: [],
      rejected: null,
      conflict: null,
      dirtyPaint: false,
    },
  },
  // MVP-05 — Tài khoản + ví credit (§3.5). `me` là câu trả lời THẬT của `GET /api/auth/me`.
  auth: {
    me: null, // { user, anonymous, balance } | null = chưa kiểm tra
    loaded: false,
    loading: false,
    error: null,
    mode: 'login', // 'login' | 'register'
    form: { email: '', display_name: '' }, // KHÔNG bao giờ giữ mật khẩu trong state
    busy: false,
    formError: null,
    formNotice: null,
    ledger: null,
    ledgerOffset: 0,
    ledgerMore: false,
    ledgerLoading: false,
    pricing: null,
    pricingLoading: false,
    users: null,
    usersTotal: null,
    usersOffset: 0,
    usersMore: false,
    usersLoading: false,
    usage: null,
    usageGroup: 'day',
    usageFrom: '',
    usageTo: '',
    usageLoading: false,
    adminBusy: false,
    adminError: null,
    adminNotice: null,
    creditTarget: null, // { userId, email } — đang mở form cấp credit cho ai
    creditDraft: { amount: '', note: '' },
    creditConfirm: null, // { userId, email, amount, note } — đã xem lại, chờ xác nhận
    roleDraft: {}, // userId → vai trò đang chọn (chưa lưu)
  },
  // 402 INSUFFICIENT_CREDIT gặp ở BẤT KỲ thao tác nào (kể cả trong `api()`) ⇒ băng báo dùng chung.
  // MVP-08 — Đăng sàn (`docs/MVP-08-CONTRACT.md` §5). Kênh/cờ live lấy từ `/api/config.marketplace`.
  mk: {
    listings: null, // bài đăng sàn (null = chưa tải)
    total: null,
    jobs: null, // job nội dung của tôi để chọn làm nguồn
    loading: false,
    busy: false,
    draft: { job_id: '', channel: '', price_vnd: '', stock: '', weight_g: '', category_id: '', brand: '', sku: '', length_cm: '', width_cm: '', height_cm: '', title: '', description: '' },
    issues: null, // issues[] của lần tạo bị 422
    error: null,
    notice: null,
    listError: null,
    filter: { status: '' },
    payloadId: null,
    payloadData: null,
    rejectId: null,
    rejectDraft: '',
  },
  creditAlert: null,
  // MVP-03 — Tạo ảnh (imagestudio). Tách riêng khỏi `il` để không giẫm chân MVP-02.
  is: {
    jobId: null,
    job: null,
    poll: null,
    pollCount: 0,
    loading: null,
    pending: null, // { name, bytes, mime, base64, dataUrl }
    busy: false,
    error: null,
    templates: null, // [{ id, label, kind, synthetic }] từ GET /api/imagestudio/templates
    limits: null, // retouch_limits của MÁY CHỦ (§3.6) — UI KHÔNG hardcode ngưỡng
    mattingProvider: null,
    providers: null, // khối `providers` trả kèm job
    templatesLoading: false,
    templatesError: null,
    overlayBlocked: null, // { code, reason, violations } — 422 phải hiện ĐỦ vi phạm
    dirtyPaint: false,
    options: {
      template: 'trang',
      remove_background: true,
      // N1 (vòng 9): mặc định KHÔNG bỏ qua cảnh báo biên nhập nhằng.
      matting_allow_ambiguous: false,
      retouch: { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 },
      overlay_text: '',
    },
  },
  // MVP-04 — Video (videostudio). Tách riêng khỏi `il`/`is` để không giẫm chân MVP-02/03.
  vs: {
    jobId: null,
    job: null,
    poll: null,
    pollCount: 0,
    loading: null,
    busy: false,
    error: null, // đối tượng lỗi THẬT (giữ cả code/status/payload để hiện đúng) hoặc chuỗi
    // Preset THẬT của máy chủ (GET /api/videostudio/presets) — UI KHÔNG hardcode kích thước.
    presets: null,
    encoder: null, // { name, is_mock, configured }
    limits: null,
    presetsLoading: false,
    presetsError: null,
    // scenes: thứ tự mảng = thứ tự cảnh = thứ tự ảnh người dùng chọn.
    scenes: [],
    fileErrors: [], // lý do từng tệp bị từ chối — hiện nguyên, không nuốt
    pendingFiles: false,
    preset: null, // preset_id đang chọn
    fit: 'pad', // 'pad' (thêm viền) | 'crop' (cắt bớt) — KHÔNG bao giờ kéo giãn
    textBlocked: null, // 422 VIDEO_TEXT_UNSUPPORTED_CLAIM: { code, reason, violations }
    dirtyPaint: false,
  },
};

/* ─────────────────────────── Khởi động ─────────────────────────── */

async function boot() {
  try {
    state.config = await api('/api/config');
  } catch (err) {
    app.innerHTML = `<div class="notice error">Không tải được cấu hình: ${esc(err.message)}</div>`;
    return;
  }
  renderBadge();
  document.addEventListener('click', onGlobalClick);
  window.addEventListener('popstate', route);
  // `location.hash = ...` phát hashchange (không phải lúc nào cũng có popstate) — cần cả hai
  // để điều hướng bằng hash luôn đổi view đúng.
  window.addEventListener('hashchange', route);
  wireImagelabGlobal();
  wireImagestudioGlobal();
  wireVideostudioGlobal();
  wireAuthGlobal();
  // Kiểm tra phiên THẬT trước khi vẽ: hỏi được thì header đúng ngay, không hỏi được thì vẫn là
  // khách ẩn danh và nói thật là chưa kiểm tra được (luật #1: không chặn gì cả).
  await loadMe();
  route();
}

function renderBadge() {
  const el = $('#provider-badge');
  const p = state.config?.providers?.content;
  const v = state.config?.providers?.vision;
  if (!p) {
    el.textContent = 'Không rõ provider';
    el.className = 'badge bad';
    return;
  }
  if (p.configured) {
    el.textContent = `AI: ${p.name}${v?.configured && v.name !== p.name ? ` · Vision: ${v.name}` : ''}`;
    el.className = 'badge ok';
    el.title = `Content: ${p.name}/${p.model} · Vision: ${v?.name}/${v?.model}`;
  } else {
    el.textContent = 'Chưa cấu hình AI';
    el.className = 'badge warn';
    el.title = 'Thiếu AI_API_KEY — pipeline trích xuất được nhưng không sinh được nội dung.';
  }
}

function route() {
  const hash = location.hash || '#/';
  // MVP-05 (§3.5) — ba route tài khoản: đăng nhập/đăng ký, tài khoản, quản trị.
  if (hash.startsWith('#/dangnhap')) {
    stopPolling();
    stopIlPolling();
    stopIsPolling();
    stopVsPolling();
    openAuth();
    return;
  }
  if (hash.startsWith('#/taikhoan')) {
    stopPolling();
    stopIlPolling();
    stopIsPolling();
    stopVsPolling();
    openAccount();
    return;
  }
  if (hash.startsWith('#/quantri')) {
    stopPolling();
    stopIlPolling();
    stopIsPolling();
    stopVsPolling();
    openAdmin();
    return;
  }
  // MVP-08 (§5) — tab “Đăng sàn”: `#/dangsan`.
  if (hash.startsWith('#/dangsan')) {
    stopPolling();
    stopIlPolling();
    stopIsPolling();
    stopVsPolling();
    openMarketplace();
    return;
  }
  // MVP-04 (§2.5) — tab thứ tư “Video”, route hash riêng: `#/video` và `#/video/:id`.
  const vsMatch = /^#\/video(?:\/([A-Za-z0-9_-]+))?/.exec(hash);
  if (vsMatch) {
    stopPolling();
    stopIlPolling();
    stopIsPolling();
    if (vsMatch[1]) {
      openVideoJob(vsMatch[1]);
    } else {
      stopVsPolling();
      vsReset();
      vsRenderPage();
    }
    return;
  }
  // MVP-03 (§3.7) — tab thứ ba “Tạo ảnh”, route hash riêng: `#/taoanh` và `#/taoanh/:id`.
  const isMatch = /^#\/taoanh(?:\/([A-Za-z0-9_-]+))?/.exec(hash);
  if (isMatch) {
    stopPolling();
    stopIlPolling();
    stopVsPolling();
    if (isMatch[1]) {
      openImagestudioJob(isMatch[1]);
    } else {
      stopIsPolling();
      isReset();
      renderImagestudio();
    }
    return;
  }
  const ilMatch = /^#\/imagelab(?:\/([A-Za-z0-9_-]+))?/.exec(hash);
  if (ilMatch) {
    stopPolling();
    stopIsPolling(); // rời tab “Tạo ảnh” thì dừng vòng poll của nó (không kéo người dùng về trang cũ)
    stopVsPolling(); // rời tab “Video” thì dừng vòng poll của nó
    if (ilMatch[1]) {
      openImagelabJob(ilMatch[1]);
    } else {
      stopIlPolling();
      state.il.job = null;
      state.il.jobId = null;
      ilManualReset();
      renderImagelab();
    }
    return;
  }
  const jobMatch = /^#\/job\/([A-Za-z0-9_-]+)/.exec(hash);
  if (jobMatch) {
    stopVsPolling();
    openJob(jobMatch[1]);
    return;
  }
  if (hash.startsWith('#/history')) {
    stopVsPolling();
    renderHistory();
    return;
  }
  stopVsPolling();
  renderHome();
}

function onGlobalClick(ev) {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const handlers = {
    home: () => {
      location.hash = '#/';
    },
    history: () => {
      location.hash = '#/history';
    },
    imagelab: () => {
      location.hash = '#/imagelab';
    },
    submit: submitLink,
    analyze: () => submitLink(),
    retry: () => regenerate(),
    regenerate: () => regenerate(),
    copy: () => copyText(btn.dataset.copy ?? '', 'Đã copy'),
    copyall: copyAll,
    edit: () => {
      state.editing = true;
      renderJob();
    },
    canceledit: () => {
      state.editing = false;
      renderJob();
    },
    saveedit: saveEdit,
    tab: () => {
      state.activeTab = btn.dataset.tab;
      state.editing = false;
      renderJob();
    },
    openjob: () => {
      location.hash = `#/job/${btn.dataset.id}`;
    },
    manualsubmit: () => submitManual(),
    addfiles: () => $('#files')?.click(),
    refreshhistory: () => renderHistory(),
    // ── MVP-02 ──
    ilpick: () => $('#il-file')?.click(),
    ilsubmit: () => submitImagelabJob(),
    ilclear: () => {
      state.il.pending = null;
      state.il.error = null;
      renderImagelab();
    },
    ilsave: () => saveImagelabLines(),
    ilrender: () => renderImagelabImage(false),
    ilforce: () => renderImagelabImage(true),
    iloverride: () => toggleIlOverride(btn.dataset.region),
    // ── IL-08: nhập vùng chữ bằng tay ──
    ilmanualtoggle: () => {
      const data = state.il.job || {};
      state.il.manual.open = !ilManualOpen(data);
      if (state.il.manual.open) ilManualRows(data); // mở ra là đổ sẵn vùng hiện có của job
      renderImagelab();
    },
    ilmanualadd: () => addIlManualRow(),
    ilmanualdel: () => removeIlManualRow(Number.parseInt(btn.dataset.row ?? '', 10)),
    ilmanualreload: () => {
      state.il.manual.rows = null;
      state.il.manual.touched = false;
      state.il.manual.rejected = null;
      state.il.manual.error = null;
      state.il.manual.notice = null;
      ilManualRows(state.il.job || {});
      renderImagelab();
    },
    ilmanualsave: () => saveIlManualRegions(false),
    ilmanualforce: () => saveIlManualRegions(true),
    ilnew: () => {
      stopIlPolling();
      state.il.job = null;
      state.il.jobId = null;
      state.il.pending = null;
      state.il.overrides = new Set();
      state.il.lastSave = null;
      state.il.renderBlocked = null;
      ilManualReset();
      location.hash = '#/imagelab';
      renderImagelab();
    },
    // ── MVP-03 — Tạo ảnh ──
    imagestudio: () => {
      // Đang ở đúng tab này thì `location.hash` không đổi ⇒ không có hashchange, phải tự vẽ lại.
      if (String(location.hash || '').startsWith('#/taoanh')) {
        stopIsPolling();
        isReset();
        renderImagestudio();
      } else {
        location.hash = '#/taoanh';
      }
    },
    ispick: () => $('#is-file')?.click(),
    isclear: () => {
      state.is.pending = null;
      state.is.error = null;
      renderImagestudio();
    },
    issubmit: () => submitImagestudioJob(),
    isgenerate: () => regenerateImagestudio(),
    isreload: () => loadImagestudioTemplates(true),
    isrefresh: () => {
      if (state.is.jobId) openImagestudioJob(state.is.jobId, { force: true });
    },
    isnew: () => {
      stopIsPolling();
      isReset();
      location.hash = '#/taoanh';
      renderImagestudio();
    },
    // ── MVP-04 — Video ──
    video: () => {
      // Đang ở đúng tab này thì `location.hash` không đổi ⇒ không có hashchange, phải tự vẽ lại.
      if (String(location.hash || '').startsWith('#/video')) {
        if (state.vs?.jobId || state.vs?.job) {
          stopVsPolling();
          vsReset();
          location.hash = '#/video'; // rời màn job ⇒ về màn tạo mới
        }
        // Đang ở MÀN TẠO thì GIỮ nguyên ảnh/chữ người dùng đã chọn, chỉ vẽ lại.
        vsRenderPage();
      } else {
        location.hash = '#/video';
      }
    },
    vspick: () => $('#vs-file')?.click(),
    vsclear: () => {
      state.vs.scenes = [];
      state.vs.fileErrors = [];
      state.vs.error = null;
      vsRenderPage();
    },
    vscreate: () => submitVideoJob(),
    vsregen: () => regenerateVideo(false),
    vsregenforce: () => regenerateVideo(true),
    vsreload: () => loadVideoPresets(true),
    vsrefresh: () => {
      if (state.vs.jobId) openVideoJob(state.vs.jobId, { force: true });
    },
    vsnew: () => {
      stopVsPolling();
      vsReset();
      location.hash = '#/video';
      vsRenderPage();
    },
    vsmove: () => {
      if (vsMoveScene(Number.parseInt(btn.dataset.index ?? '', 10), Number.parseInt(btn.dataset.dir ?? '', 10))) vsRenderPage();
    },
    vsremove: () => {
      if (vsRemoveScene(Number.parseInt(btn.dataset.index ?? '', 10))) vsRenderPage();
    },
    openvideojob: () => {
      location.hash = `#/video/${btn.dataset.id}`;
    },
    // ── Gói xuất bản (.zip) — hợp đồng §4 ──
    exportbundle: () => downloadExportBundle(btn.dataset.exportId),
    exportmanifest: () => openExportManifest(btn.dataset.exportId),
    // ── MVP-05 — Tài khoản + ví credit ──
    login: () => {
      location.hash = '#/dangnhap';
    },
    account: () => {
      location.hash = '#/taikhoan';
    },
    admin: () => {
      location.hash = '#/quantri';
    },
    logout: () => doLogout(),
    authmode: () => {
      state.auth.mode = btn.dataset.mode === 'register' ? 'register' : 'login';
      state.auth.formError = null;
      state.auth.formNotice = null;
      renderAuthPage();
    },
    ledgerreload: () => loadLedger(true),
    ledgerMore: () => loadLedger(false),
    pricingreload: () => loadPricing(true),
    creditopen: () => openCreditForm(btn.dataset.user, btn.dataset.email),
    creditcancel: () => {
      state.auth.creditConfirm = null;
      state.auth.creditTarget = null;
      state.auth.adminError = null;
      renderAdminPage();
    },
    creditreview: () => reviewCreditGrant(),
    creditgrant: () => grantCredit(btn.dataset.user),
    rolesave: () => saveRole(btn.dataset.user),
    usersreload: () => loadAdminUsers(true),
    usersMore: () => loadAdminUsers(false),
    usageload: () => loadAdminUsage(true),
    creditdismiss: () => dismissCreditAlert(),
    // ── MVP-08 — Đăng sàn ──
    marketplace: () => {
      if (String(location.hash || '').startsWith('#/dangsan')) openMarketplace();
      else location.hash = '#/dangsan';
    },
    mkcreate: () => submitMkListing(),
    mkreload: () => {
      state.mk.filter.status = String($('#mk-filter-status')?.value ?? state.mk.filter.status ?? '');
      loadMkJobs();
      loadMkListings(true);
    },
    mkapprove: () => mkDecide(btn.dataset.id, { reject: false }),
    mkrejectopen: () => {
      state.mk.rejectId = String(btn.dataset.id || '');
      state.mk.rejectDraft = '';
      state.mk.listError = null;
      renderMarketplacePage();
    },
    mkreject: () => mkDecide(btn.dataset.id, { reject: true }),
    mkcancel: () => {
      state.mk.rejectId = null;
      state.mk.rejectDraft = '';
      renderMarketplacePage();
    },
    mkpublish: () => mkPublish(btn.dataset.id),
    mksync: () => mkSync(btn.dataset.id),
    mkpayload: () => mkShowPayload(btn.dataset.id),
    mkpayloadclose: () => {
      state.mk.payloadId = null;
      state.mk.payloadData = null;
      renderMarketplacePage();
    },
  };
  if (handlers[action]) handlers[action](ev);
}

/* ─────────────────────────── Trang chủ (G01) ─────────────────────────── */

function renderHome() {
  state.view = 'home';
  stopPolling();
  const styles = state.config.styles.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
  const lengths = state.config.lengths.map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join('');

  app.innerHTML = `
    <section class="hero">
      <h1>Dán link sản phẩm, nhận nội dung bán hàng tiếng Việt</h1>
      <p class="sub">Hỗ trợ Taobao · 1688 · Pinduoduo — hệ thống tự nhận diện nguồn.</p>
      <div class="linkbox">
        <input id="url" type="url" inputmode="url" autocomplete="off" spellcheck="false"
               placeholder="Dán link sản phẩm Taobao / 1688 / Pinduoduo" />
        <button class="btn primary" data-action="submit" id="go">PHÂN TÍCH SẢN PHẨM</button>
      </div>
      <div class="opts">
        <label>Phong cách <select id="style">${styles}</select></label>
        <label>Độ dài <select id="length">${lengths}</select></label>
      </div>
      <p class="hint">
        Ví dụ: <code>https://detail.1688.com/offer/&lt;id&gt;.html</code> ·
        <code>https://item.taobao.com/item.htm?id=&lt;id&gt;</code> ·
        <code>https://mobile.yangkeduo.com/goods.html?goods_id=&lt;id&gt;</code>
      </p>
      <div id="home-error"></div>
      ${authHintHtml()}
    </section>

    <section class="panel">
      <div class="spread">
        <h2 style="margin:0">Lịch sử gần đây</h2>
        <button class="btn ghost tiny" data-action="history">Xem tất cả</button>
      </div>
      <div id="mini-history" class="hist" style="margin-top:12px"><p class="muted small">Đang tải…</p></div>
    </section>
  `;

  $('#url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitLink();
  });
  $('#style').value = state.config.defaults.style;
  $('#length').value = state.config.defaults.length;
  loadMiniHistory();
}

async function loadMiniHistory() {
  const box = $('#mini-history');
  if (!box) return;
  try {
    const data = await api('/api/jobs?limit=5');
    if (!data.items.length) {
      box.innerHTML = '<p class="muted small">Chưa có sản phẩm nào.</p>';
      return;
    }
    box.innerHTML = data.items.map(historyItemHtml).join('');
  } catch (err) {
    box.innerHTML = `<p class="muted small">Không tải được lịch sử: ${esc(err.message)}</p>`;
  }
}

function historyItemHtml(item) {
  const st = item.status || 'queued';
  const cls = st === 'succeeded' ? 'ok' : st === 'failed' ? 'bad' : st === 'needs_manual' ? 'warn' : '';
  // N-3 (vòng 4): phân biệt job DỊCH ẢNH và dán nhãn MOCK theo dấu vết ĐÃ LƯU của chính
  // job đó (cùng luật với màn hình duyệt — không theo cấu hình máy chủ đang chạy).
  const isImagelab = item.kind === 'image_translation';
  // MVP-04: job VIDEO cũng nằm trong lịch sử — mở bằng tab “Video” (không phải màn job MVP-01).
  const isVideo = item.kind === 'video_generation';
  const mockSteps = Array.isArray(item.mock_steps) ? item.mock_steps : [];
  const mockBadge = (item.mock || mockSteps.length)
    ? `<span class="badge warn" title="${esc(`Bước chạy provider MOCK: ${mockSteps.join(', ') || 'có'}`)}">MOCK</span>`
    : '';
  const kindBadge = isImagelab ? '<span class="badge">Dịch ảnh</span>' : isVideo ? '<span class="badge">Video</span>' : '';
  return `
    <button class="hist-item" data-action="${isVideo ? 'openvideojob' : 'openjob'}" data-id="${esc(item.id)}">
      <span style="min-width:0">
        <span class="hist-name">${esc(item.product_name || item.source_url || '(chưa có tên)')}</span>
        <span class="hist-sub">${esc(SOURCE_LABEL[item.source] || item.source || '—')} · ${esc(new Date(item.created_at).toLocaleString('vi-VN'))}</span>
      </span>
      <span class="row" style="gap:6px;align-items:center">${kindBadge}${mockBadge}<span class="badge ${cls}">${esc(STATUS_LABEL[st] || st)}</span></span>
    </button>`;
}

async function submitLink() {
  const url = $('#url')?.value?.trim();
  const errBox = $('#home-error');
  if (errBox) errBox.innerHTML = '';
  if (!url) {
    if (errBox) errBox.innerHTML = '<div class="notice error">Hãy dán link sản phẩm trước.</div>';
    return;
  }
  const btn = $('#go');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'ĐANG XỬ LÝ…';
  }
  try {
    const res = await api('/api/jobs', {
      method: 'POST',
      body: { url, style: $('#style').value, length: $('#length').value },
    });
    location.hash = `#/job/${res.job_id}`;
  } catch (err) {
    if (errBox) {
      errBox.innerHTML = `<div class="notice error"><strong>${esc(err.code || 'LỖI')}</strong><br>${esc(err.message)}</div>`;
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'PHÂN TÍCH SẢN PHẨM';
    }
  }
}

/* ─────────────────────────── Lịch sử (G12) ─────────────────────────── */

async function renderHistory() {
  state.view = 'history';
  stopPolling();
  app.innerHTML = `<section class="panel"><h2>Lịch sử sản phẩm</h2><div id="hist" class="hist"><p class="muted small">Đang tải…</p></div></section>`;
  try {
    const data = await api('/api/jobs?limit=100');
    const box = $('#hist');
    box.innerHTML = data.items.length
      ? data.items.map(historyItemHtml).join('')
      : '<p class="muted small">Chưa có sản phẩm nào.</p>';
  } catch (err) {
    $('#hist').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

/* ─────────────────────────── Trang job (G10) ─────────────────────────── */

async function openJob(id) {
  state.jobId = id;
  state.view = 'job';
  if (!state.job || state.job.id !== id) {
    app.innerHTML = `<section class="panel"><div class="status"><span class="spinner"></span> Đang tải job…</div></section>`;
    try {
      state.job = await api(`/api/jobs/${id}`);
    } catch (err) {
      app.innerHTML = `<section class="panel"><div class="notice error">${esc(err.message)}</div>
        <button class="btn" data-action="home">Về trang chủ</button></section>`;
      return;
    }
  }
  renderJob();
  const st = state.job.status;
  if (st === 'queued' || st === 'running') startPolling();
  else stopPolling();
}

function startPolling() {
  stopPolling();
  state.poll = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${state.jobId}`);
      state.job = job;
      if (job.status !== 'queued' && job.status !== 'running') {
        stopPolling();
        // Đổi tab mặc định theo kết quả
        state.activeTab = 'tongquan';
      }
      renderJob();
    } catch {
      /* lỗi tạm thời khi poll — bỏ qua, lần sau thử lại */
    }
  }, 1200);
}

function stopPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

function renderJob() {
  const job = state.job;
  if (!job) return;
  const st = job.status;

  let body = '';
  if (st === 'queued' || st === 'running') body = renderProgress(job);
  else if (st === 'needs_manual') body = renderNeedsManual(job);
  else body = renderResult(job);

  app.innerHTML = `
    <section class="panel">
      <div class="spread">
        <div style="min-width:0">
          <h2 style="margin:0 0 4px">${esc(job.product_name || 'Sản phẩm chưa có tên')}</h2>
          <div class="muted small mono" style="word-break:break-all">${esc(job.canonical_url || job.source_url || '')}</div>
        </div>
        <div class="row">
          <span class="badge">${esc(SOURCE_LABEL[job.source] || job.source || '—')}</span>
          <span class="badge ${st === 'succeeded' ? 'ok' : st === 'failed' ? 'bad' : 'warn'}">${esc(STATUS_LABEL[st] || st)}</span>
          <button class="btn ghost tiny" data-action="home">Sản phẩm mới</button>
        </div>
      </div>
    </section>
    ${exportPanelHtml(job.id, job.status, { kind: job.kind || 'content' })}
    ${body}
  `;

  if (st === 'succeeded') wireEditForm();
  if (st === 'needs_manual') wireManualForm();
}

function renderProgress(job) {
  return `<section class="panel">
    <div class="status"><span class="spinner"></span>
      <span>${esc(STAGE_LABEL[job.stage] || job.stage || 'Đang xử lý')}…</span>
    </div>
    <p class="muted small" style="margin-top:12px">
      Quá trình gồm: nhận diện nguồn → lấy dữ liệu sản phẩm → phân tích ảnh → dịch → sinh nội dung tiếng Việt.
      Thường mất 20–90 giây tuỳ số ảnh.
    </p>
  </section>`;
}

/* ── G11 — màn hình bổ sung dữ liệu thủ công ───────────────────────── */

function renderNeedsManual(job) {
  const ev = job.evidence || {};
  const reason = job.error_message || ev.blocked_reason || 'Không thể tự lấy đầy đủ dữ liệu từ link này.';
  return `
    <section class="panel">
      <div class="notice warn">
        <strong>Không thể tự lấy đầy đủ dữ liệu từ link này.</strong>
        <p style="margin:8px 0 0">${esc(reason)}</p>
      </div>
      ${renderEvidence(job)}
    </section>

    <section class="panel">
      <h2>Bổ sung dữ liệu để vẫn tạo được nội dung</h2>
      <p class="muted small">Bạn không cần điền hết. Chỉ cần ảnh hoặc tên sản phẩm là hệ thống đã chạy được Content Engine.</p>
      <div class="field">
        <div class="field-head"><label>Tên sản phẩm</label></div>
        <input id="m-title" class="edit" style="min-height:auto" placeholder="Ví dụ: Tai nghe chụp tai không dây" />
      </div>
      <div class="field">
        <div class="field-head"><label>Ghi chú / mô tả</label></div>
        <textarea id="m-notes" class="edit" placeholder="Mô tả điểm nổi bật, công dụng, đối tượng dùng…"></textarea>
      </div>
      <div class="field">
        <div class="field-head"><label>Ảnh sản phẩm</label></div>
        <div class="drop" id="drop">
          <div id="drop-text">Kéo ảnh vào đây hoặc bấm để chọn ảnh</div>
          <input id="files" type="file" accept="image/*" multiple hidden />
        </div>
        <div id="thumbs" class="gallery" style="margin-top:10px"></div>
      </div>
      <div id="m-error"></div>
      <div class="row">
        <button class="btn primary" data-action="manualsubmit" id="m-go">TẠO NỘI DUNG TỪ DỮ LIỆU NÀY</button>
        <button class="btn ghost" data-action="retry">Thử lấy lại từ link</button>
      </div>
    </section>`;
}

/** Ảnh người dùng chọn, giữ trong bộ nhớ dưới dạng data URL. */
const manualImages = [];

function wireManualForm() {
  const drop = $('#drop');
  const input = $('#files');
  const thumbs = $('#thumbs');
  if (!drop) return;

  const paint = () => {
    thumbs.innerHTML = manualImages
      .map(
        (src, i) => `<figure><img src="${esc(src)}" alt="Ảnh ${i + 1}" />
          <figcaption>${i + 1}</figcaption></figure>`,
      )
      .join('');
    $('#drop-text').textContent = manualImages.length
      ? `${manualImages.length} ảnh đã chọn — bấm để thêm`
      : 'Kéo ảnh vào đây hoặc bấm để chọn ảnh';
  };

  const addFiles = async (files) => {
    const maxFiles = state.config.limits.max_upload_files;
    const maxBytes = state.config.limits.max_upload_bytes;
    for (const f of files) {
      if (manualImages.length >= maxFiles) {
        toast(`Tối đa ${maxFiles} ảnh.`);
        break;
      }
      if (f.size > maxBytes) {
        toast(`Ảnh "${f.name}" vượt ${Math.round(maxBytes / 1024 / 1024)}MB.`);
        continue;
      }
      if (!f.type.startsWith('image/')) {
        toast(`"${f.name}" không phải ảnh.`);
        continue;
      }
      const dataUrl = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(f);
      });
      manualImages.push(dataUrl);
    }
    paint();
  };

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => addFiles([...input.files]));
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('hover');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('hover');
    });
  }
  drop.addEventListener('drop', (e) => addFiles([...(e.dataTransfer?.files || [])]));
  paint();
}

async function submitManual() {
  const btn = $('#m-go');
  const errBox = $('#m-error');
  errBox.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'ĐANG XỬ LÝ…';
  try {
    const res = await api('/api/jobs', {
      method: 'POST',
      body: {
        url: state.job.source_url || undefined,
        style: state.job.style,
        length: state.job.length,
        manual: {
          title: $('#m-title').value.trim(),
          notes: $('#m-notes').value.trim(),
          images: manualImages,
        },
      },
    });
    manualImages.length = 0;
    state.job = null;
    location.hash = `#/job/${res.job_id}`;
  } catch (err) {
    errBox.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    btn.disabled = false;
    btn.textContent = 'TẠO NỘI DUNG TỪ DỮ LIỆU NÀY';
  }
}

/* ── G14 + G10 — bằng chứng và kết quả ─────────────────────────────── */

function renderEvidence(job) {
  const master = job.product_master;
  const ev = job.evidence || {};
  const rows = ev.rows || [];
  const meta = job.content_meta || {};

  const extraRows = [
    { label: 'Nguồn (connector)', value: ev.connector || '—' },
    { label: 'Phương pháp trích xuất', value: ev.extraction_method || '—' },
    { label: 'HTTP status', value: ev.http_status ?? '—' },
    { label: 'Yêu cầu đăng nhập', value: ev.login_required ? 'CÓ' : 'không' },
    { label: 'Lý do bị chặn', value: ev.blocked_reason || '—' },
    { label: 'Vision provider', value: ev.vision_provider || meta.provider || '—' },
    { label: 'Content provider', value: ev.content_provider || meta.provider || '—' },
    { label: 'Mức độ kiểm chứng', value: ev.verification || '—' },
  ];

  return `
    <h3 style="margin-top:0">Bằng chứng trích xuất</h3>
    <table class="evidence">
      <thead><tr><th>Trường</th><th>Trạng thái</th><th>Chi tiết</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
              <td>${esc(r.label)}</td>
              <td><span class="st st-${esc(r.status)}">${esc(r.status)}</span></td>
              <td class="detail">${esc(r.detail || '')}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <dl class="kv" style="margin-top:14px">
      ${extraRows.map((r) => `<dt>${esc(r.label)}</dt><dd class="mono">${esc(r.value)}</dd>`).join('')}
    </dl>
    ${
      ev.warnings?.length
        ? `<div class="notice warn"><strong>Cảnh báo</strong><ul>${ev.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
        : ''
    }
    ${
      ev.guardrails && !ev.guardrails.passed
        ? `<div class="notice error"><strong>Chống bịa: phát hiện ${ev.guardrails.violations.length} khẳng định thiếu bằng chứng</strong>
             <ul>${ev.guardrails.violations.map((v) => `<li>[${esc(v.label)}] “${esc(v.matched)}” — ${esc(v.reason)}</li>`).join('')}</ul>
           </div>`
        : ''
    }
  `;
}

function renderGallery(master) {
  const imgs = (master?.images || []).filter((i) => i.status === 'FOUND' && i.url).slice(0, 60);
  if (!imgs.length) return '<p class="muted small">Không lấy được ảnh nào.</p>';
  return `<div class="gallery">${imgs
    .map(
      (i) => `<figure>
        <img src="${esc(i.url)}" alt="Ảnh sản phẩm" loading="lazy" referrerpolicy="no-referrer"
             onerror="this.closest('figure').style.opacity=0.3" />
        <figcaption>${esc(i.type)}</figcaption>
      </figure>`,
    )
    .join('')}</div>`;
}

function renderResult(job) {
  const master = job.product_master || {};
  const knowledge = job.knowledge;
  const content = job.content;
  const ev = job.evidence || {};
  const meta = job.content_meta || {};

  if (!content) {
    return `
      <section class="panel">${renderEvidence(job)}</section>
      <section class="panel">
        <div class="notice error"><strong>Không sinh được nội dung.</strong>
          <p style="margin:8px 0 0">${esc(job.error_message || meta.error || 'Lỗi không xác định.')}</p>
        </div>
        <button class="btn" data-action="regenerate">Thử lại</button>
      </section>`;
  }

  const tabs = [
    ['tongquan', 'Tổng quan'],
    ['facebook', 'Facebook'],
    ['tiktok', 'TikTok'],
    ['marketplace', 'Marketplace'],
    ['seo', 'SEO'],
  ];

  return `
    <section class="panel">
      <div class="spread">
        <h2 style="margin:0">Nội dung tiếng Việt</h2>
        <div class="row">
          <span class="badge">${esc(meta.style_label || job.style || '')} · ${esc(meta.length_label || job.length || '')}</span>
          <button class="btn ghost tiny" data-action="regenerate">Sinh lại</button>
          <button class="btn ghost tiny" data-action="edit">${state.editing ? 'Hủy sửa' : 'Sửa'}</button>
          <button class="btn tiny" data-action="copyall">Copy all</button>
        </div>
      </div>
      <div class="tabs" style="margin-top:14px">
        ${tabs.map(([id, label]) => `<button class="tab ${state.activeTab === id ? 'active' : ''}" data-action="tab" data-tab="${id}">${label}</button>`).join('')}
      </div>
      ${renderTab(job, content, state.activeTab)}
    </section>

    <section class="panel">
      <h2>Ảnh lấy được</h2>
      ${renderGallery(master)}
    </section>

    <section class="panel">
      <h2>Dữ liệu gốc</h2>
      <h3>Tiêu đề tiếng Trung</h3>
      <div class="field-body ${master.title_original ? '' : 'empty'}">${esc(master.title_original || 'Không lấy được')}</div>
      <h3>Thuộc tính</h3>
      ${
        (master.attributes || []).length
          ? `<dl class="kv">${master.attributes
              .slice(0, 40)
              .map((a) => `<dt>${esc(a.name)}</dt><dd>${esc(a.value)}</dd>`)
              .join('')}</dl>`
          : '<p class="muted small">Không lấy được thuộc tính.</p>'
      }
      <h3>Biến thể / SKU (${(master.variants || []).length})</h3>
      ${
        (master.variants || []).length
          ? `<div class="row">${master.variants
              .slice(0, 60)
              .map((v) => `<span class="tag">${esc(v.name || v.sku_id || '—')}${v.price_raw ? ` · ${esc(v.price_raw)}` : ''}</span>`)
              .join('')}</div>`
          : '<p class="muted small">Không lấy được biến thể.</p>'
      }
      <h3>Giá hiển thị</h3>
      <div class="field-body ${master.price?.raw ? '' : 'empty'}">
        ${esc(master.price?.raw || 'Không lấy được')}
        ${master.price?.raw ? `<span class="muted small"> (${esc(master.price.kind)} · ${esc(master.price.currency)})</span>` : ''}
      </div>
      ${master.price?.kind === 'tier' && master.price.tiers?.length ? `<p class="muted small">Giá theo bậc — KHÔNG phải giá cố định:</p><ul class="bullets">${master.price.tiers.map((t) => `<li>${esc(t.min_quantity ?? '?')}–${esc(t.max_quantity ?? '∞')}: ¥${esc(t.price)}</li>`).join('')}</ul>` : ''}
    </section>

    <section class="panel">
      <h2>AI hiểu sản phẩm</h2>
      ${
        knowledge
          ? `
        ${knowledge.product_type ? `<p><strong>Loại sản phẩm:</strong> ${esc(knowledge.product_type)}</p>` : ''}
        ${
          knowledge.visual_features?.length
            ? `<h3>Đặc điểm nhìn thấy trong ảnh</h3><ul class="bullets">${knowledge.visual_features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
            : ''
        }
        ${knowledge.colors?.length ? `<h3>Màu sắc</h3><div class="row">${knowledge.colors.map((c) => `<span class="tag vision">${esc(c)}</span>`).join('')}</div>` : ''}
        ${knowledge.visual_text?.length ? `<h3>Chữ đọc được trong ảnh</h3><div class="row">${knowledge.visual_text.slice(0, 30).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        <h3>Dữ kiện đã hợp nhất (có gắn nhãn nguồn gốc)</h3>
        <dl class="kv">
          ${(knowledge.facts || [])
            .slice(0, 60)
            .map((f) => `<dt>${esc(f.label)} <span class="tag ${esc(f.provenance)}">${esc(f.provenance)}</span></dt><dd>${esc(f.value)}</dd>`)
            .join('')}
        </dl>
        ${
          knowledge.uncertain_claims?.length
            ? `<div class="notice warn"><strong>Điểm chưa chắc chắn — cần xác minh trước khi đăng</strong><ul>${knowledge.uncertain_claims.map((u) => `<li>${esc(u)}</li>`).join('')}</ul></div>`
            : ''
        }`
          : '<p class="muted small">Chưa có phân tích.</p>'
      }
    </section>

    <section class="panel">
      <h2>Bằng chứng trích xuất</h2>
      ${renderEvidence(job)}
    </section>
  `;
}

function field(label, value, { multiline = true, key = '' } = {}) {
  const has = value && (Array.isArray(value) ? value.length : String(value).trim());
  if (state.editing && key) {
    const raw = Array.isArray(value) ? value.join('\n') : value || '';
    return `<div class="field">
      <div class="field-head"><label>${esc(label)}</label></div>
      <textarea class="edit" data-key="${esc(key)}">${esc(raw)}</textarea>
    </div>`;
  }
  const body = Array.isArray(value)
    ? `<ul class="bullets">${value.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>`
    : esc(value || '');
  return `<div class="field">
    <div class="field-head">
      <label>${esc(label)}</label>
      ${has ? `<button class="btn ghost tiny" data-action="copy" data-copy="${esc(Array.isArray(value) ? value.join('\n') : value)}">Copy</button>` : ''}
    </div>
    <div class="field-body ${has ? '' : 'empty'}">${has ? body : 'Chưa có nội dung'}</div>
  </div>`;
}

function renderTab(job, c, tab) {
  if (tab === 'facebook') {
    return `<div class="tabpane active">${field('Bài đăng Facebook', c.facebook_caption, { key: 'facebook_caption' })}</div>`;
  }
  if (tab === 'tiktok') {
    return `<div class="tabpane active">${field('Caption TikTok', c.tiktok_caption, { key: 'tiktok_caption' })}
      ${field('Hashtags', c.hashtags, { key: 'hashtags' })}</div>`;
  }
  if (tab === 'marketplace') {
    return `<div class="tabpane active">
      ${field('Tên sản phẩm', c.product_name, { key: 'product_name' })}
      ${field('Mô tả cho Shopee / TikTok Shop', c.marketplace_description, { key: 'marketplace_description' })}
      <div class="notice warn small">Hãy kiểm lại giá, tồn kho và thông số trước khi đăng — hệ thống không tự xác minh các thông tin đó.</div>
    </div>`;
  }
  if (tab === 'seo') {
    const seo = c.seo || {};
    return `<div class="tabpane active">
      ${field('SEO title', seo.title, { key: 'seo.title' })}
      ${field('Meta description', seo.meta_description, { key: 'seo.meta_description' })}
      ${field('Từ khoá', seo.keywords, { key: 'seo.keywords' })}
    </div>`;
  }
  return `<div class="tabpane active">
    ${field('Tên sản phẩm', c.product_name, { key: 'product_name' })}
    ${field('Headline', c.headline, { key: 'headline' })}
    ${field('Mô tả ngắn', c.short_description, { key: 'short_description' })}
    ${field('Điểm bán hàng', c.selling_points, { key: 'selling_points' })}
    ${field('Mô tả chi tiết', c.detailed_description, { key: 'detailed_description' })}
    ${field('Hashtags', c.hashtags, { key: 'hashtags' })}
    ${state.editing ? `<div class="row"><button class="btn primary" data-action="saveedit">Lưu thay đổi</button><button class="btn ghost" data-action="canceledit">Hủy</button></div>` : ''}
  </div>`;
}

function copyAll() {
  const c = state.job?.content;
  if (!c) return;
  const text = [
    `TÊN SẢN PHẨM\n${c.product_name}`,
    `HEADLINE\n${c.headline}`,
    `MÔ TẢ NGẮN\n${c.short_description}`,
    `ĐIỂM BÁN HÀNG\n${(c.selling_points || []).map((s) => `- ${s}`).join('\n')}`,
    `MÔ TẢ CHI TIẾT\n${c.detailed_description}`,
    `FACEBOOK\n${c.facebook_caption}`,
    `TIKTOK\n${c.tiktok_caption}`,
    `MARKETPLACE\n${c.marketplace_description}`,
    `HASHTAGS\n${(c.hashtags || []).join(' ')}`,
    `SEO TITLE\n${c.seo?.title || ''}`,
    `SEO META\n${c.seo?.meta_description || ''}`,
    `SEO KEYWORDS\n${(c.seo?.keywords || []).join(', ')}`,
  ].join('\n\n');
  copyText(text, 'Đã copy toàn bộ nội dung');
}

/** Gắn sự kiện cho form sửa nội dung (dùng event delegation là chính). */
function wireEditForm() {
  /* các nút đã dùng data-action, không cần gắn thêm */
}

async function saveEdit() {
  const patch = {};
  document.querySelectorAll('textarea[data-key]').forEach((ta) => {
    const key = ta.dataset.key;
    const value = ta.value;
    if (key.startsWith('seo.')) {
      patch.seo = patch.seo || {};
      const k = key.slice(4);
      patch.seo[k] = k === 'keywords' ? value.split('\n').map((s) => s.trim()).filter(Boolean) : value;
    } else if (['selling_points', 'hashtags'].includes(key)) {
      patch[key] = value.split('\n').map((s) => s.trim()).filter(Boolean);
    } else {
      patch[key] = value;
    }
  });
  try {
    await api(`/api/jobs/${state.job.id}/content`, { method: 'PUT', body: patch });
    toast('Đã lưu nội dung đã sửa');
    state.editing = false;
    state.job = await api(`/api/jobs/${state.job.id}`);
    renderJob();
  } catch (err) {
    toast(`Lỗi lưu: ${err.message}`);
  }
}

async function regenerate() {
  try {
    await api(`/api/jobs/${state.job.id}/regenerate`, {
      method: 'POST',
      body: { style: state.job.style, length: state.job.length },
    });
    state.editing = false;
    toast('Đang sinh lại nội dung…');
    await openJob(state.job.id);
  } catch (err) {
    toast(`Lỗi: ${err.message}`);
  }
}

/* ═══════════════════ MVP-02 — Dịch ảnh Trung → Việt ═══════════════════
   Mọi text lấy từ OCR / DB (chữ Trung trong ảnh là dữ liệu KHÔNG tin cậy)
   đều phải đi qua `esc()` trước khi vào DOM. Không dùng innerHTML thô với
   dữ liệu chưa escape. */

const cssEscape = (value) =>
  window.CSS && CSS.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, '\\$&');

const ilLocked = (line, region) =>
  IL_LOCKED_KINDS.has(region?.kind || 'unknown') || IL_LOCKED_STATUSES.has(line?.status || '');

// Lỗi 5xx bị server che thông báo (an toàn), nên UI tự dịch mã lỗi sang câu tiếng Việt.
const IL_ERROR_HINT = {
  IMAGELAB_UNAVAILABLE: 'Máy chủ chưa nạp được module dịch ảnh. Các tính năng MVP-01 vẫn dùng bình thường.',
  NOT_CONFIGURED: 'Provider OCR / dịch / render chưa được cấu hình trên máy chủ.',
  OCR_NOT_CONFIGURED: 'Provider OCR chưa được cấu hình.',
  RENDER_NOT_CONFIGURED: 'Provider render chưa được cấu hình.',
  RATE_LIMITED: 'Bạn thao tác quá nhanh — chờ một lát rồi thử lại.',
  BAD_IMAGE: 'Dữ liệu ảnh không hợp lệ.',
  IMAGE_TOO_LARGE: 'Ảnh vượt giới hạn cho phép.',
  UNSUPPORTED_MEDIA_TYPE: 'Ảnh không hợp lệ hoặc định dạng không được phép (PNG / JPEG / WebP / GIF).',
  IMAGELAB_NO_LINES: 'Job chưa có dòng chữ nào để render.',
};

function ilErrorText(err) {
  const prefix = err?.code ? `${err.code}: ` : '';
  const hint = err?.status >= 500 ? IL_ERROR_HINT[err.code] : null;
  return `${prefix}${hint || err?.message || 'Lỗi không xác định.'}`;
}

/** Gắn sự kiện kéo-thả / chọn tệp cho khu imagelab (chỉ gắn một lần). */
function wireImagelabGlobal() {
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t instanceof HTMLInputElement && t.id === 'il-file') pickImagelabFiles(t.files);
    ilManualSyncField(t);
  });
  // Giữ bản nháp bảng nhập tay trong `state` để render lại KHÔNG mất chữ đang gõ.
  document.addEventListener('input', (ev) => ilManualSyncField(ev.target));
  // Trong lúc người dùng đang gõ trong bảng nhập tay, vòng poll KHÔNG vẽ lại (mất focus/chữ);
  // khi rời khỏi bảng thì vẽ bù đúng một lần.
  document.addEventListener('focusout', (ev) => {
    if (!state.il.manual.dirtyPaint) return;
    if (ev.relatedTarget?.closest?.('#il-manual')) return;
    state.il.manual.dirtyPaint = false;
    if (state.view === 'imagelab') renderImagelab();
  });
  for (const name of ['dragenter', 'dragover']) {
    document.addEventListener(name, (ev) => {
      if (ev.target.closest?.('#il-drop')) {
        ev.preventDefault();
        $('#il-drop')?.classList.add('hover');
      }
    });
  }
  for (const name of ['dragleave', 'drop']) {
    document.addEventListener(name, (ev) => {
      if (ev.target.closest?.('#il-drop')) {
        ev.preventDefault();
        $('#il-drop')?.classList.remove('hover');
      }
    });
  }
  document.addEventListener('drop', (ev) => {
    if (ev.target.closest?.('#il-drop')) pickImagelabFiles(ev.dataTransfer?.files);
  });
}

/* ── Chọn ảnh + tạo job ─────────────────────────────────────────────── */

async function pickImagelabFiles(files) {
  const file = [...(files || [])][0];
  if (!file) return;
  const lim = state.config?.imagelab?.limits || {};
  const allowed = lim.allowed_image_mime || ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) {
    state.il.error = `Định dạng "${file.type || 'không rõ'}" không được phép. Chỉ nhận PNG / JPEG / WebP / GIF.`;
    renderImagelab();
    return;
  }
  if (lim.max_image_bytes && file.size > lim.max_image_bytes) {
    state.il.error = `Ảnh vượt giới hạn ${Math.round(lim.max_image_bytes / 1024 / 1024)}MB.`;
    renderImagelab();
    return;
  }
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Không đọc được tệp ảnh.'));
      reader.readAsDataURL(file);
    });
    state.il.pending = {
      name: file.name || 'image',
      bytes: file.size,
      mime: file.type,
      base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      dataUrl,
    };
    state.il.error = null;
  } catch (err) {
    state.il.error = err.message;
  }
  renderImagelab();
}

async function submitImagelabJob() {
  const pending = state.il.pending;
  if (!pending || state.il.busy) return;
  state.il.busy = true;
  state.il.error = null;
  renderImagelab();
  try {
    const res = await api('/api/imagelab/jobs', {
      method: 'POST',
      body: { image: { base64: pending.base64, filename: pending.name } },
    });
    state.il.busy = false;
    state.il.pending = null;
    state.il.overrides = new Set();
    state.il.lastSave = null;
    state.il.renderBlocked = null;
    ilManualReset();
    state.il.jobId = res.job_id;
    state.il.job = null;
    location.hash = `#/imagelab/${res.job_id}`;
    await openImagelabJob(res.job_id);
  } catch (err) {
    state.il.busy = false;
    state.il.error = ilErrorText(err);
    renderImagelab();
  }
}

/* ── Theo dõi tiến trình ────────────────────────────────────────────── */

async function openImagelabJob(id) {
  if (!id) return;
  if (state.il.jobId === id && state.il.job) {
    renderImagelab();
    startIlPollIfRunning();
    return;
  }
  if (state.il.loading === id) return;
  state.il.loading = id;
  state.il.jobId = id;
  // Job KHÁC ⇒ bảng nhập tay phải bắt đầu lại từ vùng của job mới (không giữ bản nháp job cũ).
  ilManualReset();
  app.innerHTML = '<section class="panel"><div class="status"><span class="spinner"></span> Đang tải job dịch ảnh…</div></section>';
  try {
    state.il.job = await api(`/api/imagelab/jobs/${id}`);
    state.il.error = null;
  } catch (err) {
    state.il.job = null;
    state.il.error = ilErrorText(err);
  } finally {
    state.il.loading = null;
  }
  renderImagelab();
  startIlPollIfRunning();
}

function startIlPollIfRunning() {
  const st = state.il.job?.job?.status;
  if (st === 'queued' || st === 'running') startIlPolling();
  else stopIlPolling();
}

function startIlPolling() {
  stopIlPolling();
  state.il.poll = setInterval(async () => {
    // Rời khỏi khu imagelab thì tự dừng, không kéo người dùng về trang cũ.
    if (state.view !== 'imagelab' || !state.il.jobId) {
      stopIlPolling();
      return;
    }
    try {
      const data = await api(`/api/imagelab/jobs/${state.il.jobId}`);
      state.il.job = data;
      const st = data.job?.status;
      if (st !== 'queued' && st !== 'running') stopIlPolling();
      // Đang gõ trong bảng nhập tay ⇒ hoãn vẽ lại (không cướp focus/không mất chữ đang gõ).
      if (ilManualHasFocus()) state.il.manual.dirtyPaint = true;
      else renderImagelab();
    } catch (err) {
      stopIlPolling();
      state.il.error = `Mất kết nối khi theo dõi tiến trình: ${err.message}`;
      renderImagelab();
    }
  }, 1500);
}

function stopIlPolling() {
  if (state.il.poll) clearInterval(state.il.poll);
  state.il.poll = null;
}

/* ── Render khu imagelab ────────────────────────────────────────────── */

function renderImagelab() {
  state.view = 'imagelab';
  stopPolling();
  const il = state.config?.imagelab || {};
  const available = il.available !== false;
  // Khối “Gói xuất bản” (§4) chỉ có ở MÀN JOB; vẽ ở đây rồi BƠM vào `renderIlJob` để hàm render
  // thuần không phải gọi thêm hàm ngoài (giữ nguyên tập phụ thuộc mà test trích hàm đang bơm).
  const exportPanel = state.il.job
    ? exportPanelHtml(state.il.job.job?.id, state.il.job.job?.status, { kind: state.il.job.job?.kind || 'image_translation' })
    : '';
  app.innerHTML = `
    <section class="panel">
      <div class="spread">
        <div style="min-width:0">
          <h2 style="margin:0 0 4px">Dịch ảnh Trung → Việt</h2>
          <p class="muted small" style="margin:0">
            Tải ảnh sản phẩm có chữ Trung: hệ thống đọc chữ → dịch → bạn duyệt từng dòng → render ảnh mới.
            <strong>Ảnh gốc không bị sửa.</strong>
          </p>
        </div>
        <span class="badge ${available ? 'ok' : 'bad'}">${available ? 'Sẵn sàng' : 'Chưa khả dụng'}</span>
      </div>
      <div class="row" style="margin-top:10px">
        ${ilProviderBadge('OCR', il.ocr)}
        ${ilProviderBadge('Dịch', il.translate)}
        ${ilProviderBadge('Render', il.render)}
      </div>
      ${ilMockNotice(il)}
    </section>
    ${available
      ? state.il.job
        ? renderIlJob(exportPanel)
        : renderIlUpload()
      : `<section class="panel"><div class="notice error"><strong>Tính năng dịch ảnh chưa sẵn sàng trên máy chủ này (IMAGELAB_UNAVAILABLE).</strong>
           <p style="margin:6px 0 0">Lý do máy chủ báo: ${esc(il.reason || 'không nêu lý do — xem log máy chủ (imagelab.wiring_failed).')}</p>
           <p style="margin:6px 0 0">Các tính năng MVP-01 vẫn dùng bình thường.</p></div></section>`}
    ${authHintHtml()}
    <div id="il-error"></div>
  `;
  paintIlError();
}

function ilProviderBadge(label, provider) {
  if (!provider) return `<span class="badge">${esc(label)}: không rõ</span>`;
  const cls = provider.configured ? (provider.is_mock ? 'warn' : 'ok') : 'bad';
  const mock = provider.is_mock ? ' · MOCK' : '';
  const notReady = provider.configured ? '' : ' · chưa cấu hình';
  return `<span class="badge ${cls}" title="${esc(`${provider.name || 'none'} / ${provider.model || ''}`)}">${esc(label)}: ${esc(provider.name || 'none')}${mock}${notReady}</span>`;
}

function ilMockNotice(il) {
  const steps = [
    ['ocr', 'OCR (đọc chữ)'],
    ['translate', 'dịch'],
    ['render', 'render (vẽ ảnh)'],
  ].filter(([key]) => il?.[key]?.is_mock).map(([, name]) => name);
  if (!steps.length) return '';
  return `<div class="notice warn">
    <strong>MOCK — ${esc(steps.join(', '))} đang chạy bằng dữ liệu giả lập.</strong>
    <p style="margin:6px 0 0">Kết quả không phải đọc/dịch/vẽ thật. Không dùng để đánh giá chất lượng hoặc đăng bán.</p>
  </div>`;
}

function renderIlUpload() {
  const lim = state.config?.imagelab?.limits || {};
  const maxMb = Math.round((lim.max_image_bytes || 0) / 1024 / 1024);
  const p = state.il.pending;
  return `
    <section class="panel">
      <h3 style="margin-top:0">1 · Chọn ảnh sản phẩm</h3>
      <div class="drop" id="il-drop">
        <div id="il-drop-text">Kéo ảnh vào đây hoặc bấm để chọn (PNG / JPEG / WebP / GIF)</div>
        <input id="il-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
      </div>
      ${p
        ? `<div class="il-picked">
             <img src="${esc(p.dataUrl)}" alt="Ảnh đã chọn" />
             <div class="muted small">${esc(p.name)} · ${Math.round(p.bytes / 1024)}KB</div>
           </div>`
        : ''}
      <p class="muted small" style="margin-top:10px">
        Giới hạn: ${esc(maxMb)}MB · ${esc(lim.max_pixels || 0)} pixel · tối đa ${esc(lim.max_regions || 0)} vùng chữ.
        Ảnh được lưu thành bản ghi mới, ảnh gốc giữ nguyên SHA-256.
      </p>
      <div class="row">
        <button class="btn primary" data-action="ilsubmit" ${p && !state.il.busy ? '' : 'disabled'}>
          ${state.il.busy ? 'ĐANG TẢI LÊN…' : 'DỊCH ẢNH NÀY'}
        </button>
        ${p ? '<button class="btn ghost" data-action="ilclear">Bỏ ảnh đã chọn</button>' : ''}
      </div>
    </section>`;
}

function renderIlJob(exportPanel = '') {
  const data = state.il.job;
  const job = data.job || {};
  const st = job.status || 'queued';
  const running = st === 'queued' || st === 'running';
  const lines = data.lines || [];
  const failCode = job.error_code ? ` (${esc(job.error_code)})` : '';
  return `
    <section class="panel">
      <div class="spread">
        <div style="min-width:0">
          <h2 style="margin:0 0 4px">Job dịch ảnh <span class="mono small">${esc(String(job.id || '').slice(0, 8))}</span></h2>
          <div class="muted small">${esc(IL_STAGE_LABEL[job.stage] || job.stage || '')}</div>
        </div>
        <div class="row">
          <span class="badge ${st === 'succeeded' ? 'ok' : st === 'failed' ? 'bad' : 'warn'}">${esc(IL_STATUS_LABEL[st] || st)}</span>
          <button class="btn ghost tiny" data-action="ilnew">Ảnh khác</button>
        </div>
      </div>
      ${running ? renderIlSteps(job.stage) : ''}
      ${st === 'failed'
        ? `<div class="notice error"><strong>Job thất bại${failCode}</strong>
             <p style="margin:6px 0 0">${esc(job.error_message || 'Không rõ nguyên nhân.')}</p></div>`
        : ''}
    </section>
    ${exportPanel}
    ${data.asset ? renderIlCompare(data) : ''}
    ${lines.length > 0 ? renderIlReview(data) : renderIlNoLines(data)}
    ${renderIlManual(data)}
    ${renderIlWarnings(data)}
  `;
}

function renderIlSteps(stage) {
  const idx = IL_STAGE_ORDER.indexOf(stage);
  const items = [
    ['storing', 'Lưu ảnh gốc'],
    ['ocr', 'Đọc chữ (OCR)'],
    ['translating', 'Dịch sang tiếng Việt'],
    ['awaiting_review', 'Chờ bạn duyệt'],
    ['rendering', 'Render ảnh'],
    ['done', 'Hoàn tất'],
  ];
  return `<ol class="il-steps">${items
    .map(([key, label]) => {
      const i = IL_STAGE_ORDER.indexOf(key);
      const cls = idx < 0 ? '' : i < idx ? 'done' : i === idx ? 'current' : '';
      return `<li class="${cls}"><span class="il-dot"></span>${esc(label)}</li>`;
    })
    .join('')}</ol>`;
}

function renderIlCompare(data) {
  const asset = data.asset;
  const renderedList = data.rendered || [];
  const rendered = renderedList[renderedList.length - 1] || null;
  const summary = data.render_summary;
  const src = (a) => `/api/imagelab/assets/${encodeURIComponent(a.id)}/file`;
  const ext = (mime) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] || 'img');
  return `
    <section class="panel">
      <div class="spread">
        <h2 style="margin:0">Trước / Sau</h2>
        <div class="row">
          ${summary?.status === 'PARTIAL' ? '<span class="badge warn">PARTIAL — chỉ render được một phần</span>' : ''}
          ${summary?.status === 'OK' ? '<span class="badge ok">Đã render</span>' : ''}
          ${summary?.is_mock ? '<span class="badge warn">MOCK</span>' : ''}
          ${rendered
            ? `<a class="btn tiny primary" href="${esc(src(rendered))}" download="imagelab-${esc(String(rendered.id).slice(0, 8))}.${esc(ext(rendered.mime))}">Tải ảnh dịch</a>`
            : ''}
        </div>
      </div>
      <div class="il-compare">
        <figure>
          <img src="${esc(src(asset))}" alt="Ảnh gốc" />
          <figcaption>
            <strong>Ảnh gốc</strong> (bất biến) · ${esc(asset.mime || '')}${asset.width ? ` · ${esc(asset.width)}×${esc(asset.height)}` : ''}<br />
            <span class="mono">sha256 ${esc(String(asset.sha256 || '').slice(0, 16))}…</span>
          </figcaption>
        </figure>
        ${rendered
          ? `<figure>
               <img src="${esc(src(rendered))}" alt="Ảnh đã dịch" />
               <figcaption>
                 <strong>Ảnh dịch</strong> (bản ghi mới, parent = ảnh gốc) · ${esc(rendered.mime || '')}${rendered.width ? ` · ${esc(rendered.width)}×${esc(rendered.height)}` : ''}<br />
                 <span class="mono">sha256 ${esc(String(rendered.sha256 || '').slice(0, 16))}…</span>
               </figcaption>
             </figure>`
          : '<figure class="il-empty"><div class="muted small">Chưa có ảnh render. Duyệt bản dịch rồi bấm “RENDER ẢNH”.</div></figure>'}
      </div>
      ${renderedList.length > 1
        ? `<p class="muted small">Có ${esc(renderedList.length)} bản render — đang hiện bản mới nhất; các bản trước vẫn giữ nguyên trong lịch sử.</p>`
        : ''}
    </section>`;
}

function renderIlReview(data) {
  const regions = new Map((data.regions || []).map((r) => [r.id, r]));
  const rows = (data.lines || [])
    .map((line) => {
      const region = regions.get(line.region_id) || null;
      const kind = region?.kind || 'unknown';
      const locked = ilLocked(line, region);
      const overridden = state.il.overrides.has(line.region_id);
      const st = IL_LINE_STATUS[line.status] || { label: line.status || '—', cls: '' };
      const reasons = [];
      if (locked) {
        reasons.push(region?.kind_reason || `Vùng ${IL_KIND_LABEL[kind] || kind}: hệ thống KHÔNG tự dịch (bảo vệ nhãn hiệu/chứng nhận/giá).`);
      }
      for (const v of line.violations || []) reasons.push(String(v));
      if (line.edited_by_user) reasons.push('Bạn đã sửa dòng này — thay đổi có ghi vết.');
      return `<tr class="${locked ? 'il-locked' : ''}${overridden ? ' il-overridden' : ''}" data-region="${esc(line.region_id)}">
        <td class="il-zh">
          ${esc(line.text_original)}
          ${region ? `<div class="muted small">${esc(IL_KIND_LABEL[kind] || kind)}${region.confidence != null ? ` · tin cậy ${esc(Math.round(Number(region.confidence) * 100))}%` : ''}</div>` : ''}
        </td>
        <td>
          <input class="il-input" data-region="${esc(line.region_id)}" value="${esc(line.text_vi)}"
            ${locked && !overridden ? 'disabled' : ''}
            placeholder="${locked ? 'Vùng bị khoá — bấm “vẫn dịch vùng này” nếu bạn chắc chắn' : 'Nhập bản dịch tiếng Việt'}" />
          ${locked
            ? `<div class="il-lock-note">
                 <span>🔒 ${esc(region?.kind_reason || 'Vùng nhãn hiệu/chứng nhận/giá')}</span>
                 <button class="btn ghost tiny" data-action="iloverride" data-region="${esc(line.region_id)}">
                   ${overridden ? 'huỷ cho phép dịch' : 'vẫn dịch vùng này (sẽ thay chữ trên ảnh và ghi vết)'}
                 </button>
                 ${overridden
                   ? `<div class="muted small" style="margin-top:4px">Bạn đã cho phép dịch vùng này: khi RENDER, chữ trên ảnh sẽ bị THAY và hệ thống ghi vết vào <span class="mono">meta.overrides</span>.</div>`
                   : ''}
               </div>`
            : ''}
        </td>
        <td><span class="badge">${esc(IL_KIND_LABEL[kind] || kind)}</span></td>
        <td>
          <span class="badge ${st.cls}">${esc(st.label)}</span>
          ${line.provenance ? `<div class="muted small">nguồn: ${esc(line.provenance)}</div>` : ''}
        </td>
        <td class="small">${reasons.length ? reasons.map((r) => `<div>• ${esc(r)}</div>`).join('') : '<span class="muted">—</span>'}</td>
      </tr>`;
    })
    .join('');

  return `
    <section class="panel" id="il-lines">
      <h2>2 · Duyệt bản dịch từng dòng</h2>
      <p class="muted small">
        Sửa trực tiếp ở cột “chữ Việt”. Vùng <strong>nhãn hiệu / chứng nhận / giá</strong> bị khoá —
        chỉ dịch khi bạn bấm “vẫn dịch vùng này”, và thay đổi đó được ghi vết.
      </p>
      <div class="il-tablewrap">
        <table class="evidence il-table">
          <thead>
            <tr><th>Chữ gốc (Trung)</th><th>Chữ Việt (sửa được)</th><th>Loại</th><th>Trạng thái</th><th>Lý do cần duyệt</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${state.il.renderBlocked
        ? `<div class="notice warn">
             <strong>Chưa thể render</strong>
             <p style="margin:6px 0 0">${esc(state.il.renderBlocked)}</p>
             <button class="btn tiny danger" data-action="ilforce" style="margin-top:8px">VẪN RENDER (bỏ qua cảnh báo — có ghi vết)</button>
           </div>`
        : ''}
      ${renderIlSaveResult()}
      <div class="row" style="margin-top:12px">
        <button class="btn primary" data-action="ilsave">LƯU &amp; DUYỆT TẤT CẢ</button>
        <button class="btn" data-action="ilrender">RENDER ẢNH</button>
        <span class="muted small">Chỉ những dòng có chữ Việt và không còn “cần duyệt” mới được vẽ.</span>
      </div>
    </section>`;
}

function renderIlSaveResult() {
  const saved = state.il.lastSave;
  if (!saved) return '';
  const rejected = saved.rejected || [];
  const warnings = saved.warnings || [];
  return `<div class="notice ${rejected.length ? 'warn' : 'ok'}">
    <strong>${rejected.length ? `Đã lưu, nhưng ${rejected.length} dòng bị từ chối` : 'Đã lưu bản dịch'}</strong>
    ${warnings.length ? `<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${rejected.length
      ? `<ul>${rejected.map((r) => `<li><span class="mono">${esc(r.region_id || '?')}</span>: ${esc(r.reason || 'không rõ lý do')}</li>`).join('')}</ul>`
      : ''}
  </div>`;
}

function renderIlNoLines(data) {
  const ocr = data.ocr || {};
  const job = data.job || {};
  let msg = 'Chưa có dòng chữ nào để duyệt.';
  if (ocr.status === 'NO_TEXT') msg = 'OCR không tìm thấy chữ Trung nào trong ảnh này.';
  else if (ocr.status === 'NOT_CONFIGURED') msg = 'Provider OCR chưa được cấu hình nên chưa đọc được chữ.';
  else if (ocr.status === 'UNSUPPORTED_IMAGE') msg = 'Ảnh không giải mã được (định dạng không được hỗ trợ).';
  else if (ocr.status === 'FAILED') msg = 'Bước OCR thất bại — chưa có chữ để dịch.';
  else if (job.status === 'failed') msg = job.error_message || 'Job lỗi trước khi có bản dịch.';
  return `<section class="panel"><h2>2 · Duyệt bản dịch</h2>
    <div class="notice ${job.status === 'failed' ? 'error' : 'warn'}">${esc(msg)}</div></section>`;
}

/** Cảnh báo THẬT: mock, glyph thiếu, vùng bị bỏ kèm lý do, vi phạm guardrail, PARTIAL. */
function renderIlWarnings(data) {
  // Chịu được `data` rỗng/null: hàm này chạy trong luồng render, ném lỗi ở đây sẽ làm trắng
  // cả trang kết quả. (Test UI bắt được: `renderIlWarnings(null)` từng ném TypeError.)
  data = data || {};
  const blocks = [];
  const ocr = data.ocr || {};
  const summary = data.render_summary;
  const providers = data.providers || {};
  const snapshot = data.providers_snapshot || {};

  // F-03: nhãn MOCK phải theo DẤU VẾT CỦA JOB (mock_steps + meta ảnh đã lưu +
  // render_summary.is_mock), KHÔNG theo cấu hình provider đang chạy. Cấu hình hiện tại
  // chỉ được hiện như thông tin phụ.
  const traceSteps = new Set(
    (Array.isArray(data.mock_steps) ? data.mock_steps : []).map((s) => String(s)),
  );
  if (data.asset?.meta?.ocr?.is_mock) traceSteps.add('ocr');
  if (data.asset?.meta?.translate?.is_mock) traceSteps.add('translate');
  if (ocr.is_mock) traceSteps.add('ocr');
  if (summary?.is_mock) traceSteps.add('render');
  const jobMockSteps = [['ocr', 'OCR'], ['translate', 'dịch'], ['render', 'render (vẽ ảnh)']]
    .filter(([key]) => traceSteps.has(key))
    .map(([, label]) => label);
  const currentMockSteps = [['ocr', 'OCR'], ['translate', 'dịch'], ['render', 'render']]
    .filter(([key]) => providers[key]?.is_mock)
    .map(([, label]) => label);

  if (jobMockSteps.length) {
    const items = [
      'Dấu vết MOCK đọc từ chính JOB ĐÃ LƯU (content_meta.imagelab.mock_steps + meta ảnh), không phải từ cấu hình máy chủ đang chạy.',
      'Kết quả của job này là dữ liệu minh hoạ — không dùng để đánh giá chất lượng hay đăng bán.',
    ];
    if (snapshot.ocr || snapshot.render || snapshot.translate) {
      const snap = [snapshot.ocr, snapshot.translate, snapshot.render]
        .filter(Boolean)
        .map((p) => `${p.name || '?'}${p.is_mock ? ' (MOCK)' : ''}`)
        .join(' · ');
      items.push(`Provider lúc chạy job (đã lưu): ${snap}.`);
    }
    items.push(
      currentMockSteps.length
        ? `Provider hiện tại của máy chủ cũng đang là mock: ${currentMockSteps.join(', ')} (thông tin phụ).`
        : 'Provider hiện tại của máy chủ KHÔNG còn là mock — job cũ vẫn mang nhãn MOCK vì dấu vết đã lưu.',
    );
    blocks.push({ cls: 'warn', title: `MOCK — job này đã chạy ${jobMockSteps.join(', ')} bằng dữ liệu giả lập`, items });
  } else if (currentMockSteps.length) {
    blocks.push({
      cls: 'warn',
      title: `MOCK — ${currentMockSteps.join(', ')} đang chạy dữ liệu giả lập (theo cấu hình máy chủ)`,
      items: ['Provider mock tự khai is_mock = true. Kết quả không phải đọc/dịch/vẽ thật.'],
    });
  }

  if (ocr.status === 'NO_TEXT') blocks.push({ cls: 'warn', title: 'Không tìm thấy chữ nào trong ảnh', items: [] });
  if (ocr.status === 'NOT_CONFIGURED') blocks.push({ cls: 'error', title: 'Provider OCR chưa được cấu hình', items: [] });
  if (ocr.status === 'UNSUPPORTED_IMAGE') blocks.push({ cls: 'error', title: 'Ảnh không giải mã được', items: [] });
  if (ocr.status === 'FAILED') blocks.push({ cls: 'error', title: 'OCR thất bại', items: [] });

  // IL08-03 (vòng 6): nếu vùng nhập tay đã THAY vùng OCR thì khối này là LỊCH SỬ. Vẫn hiện
  // (truy vết) nhưng nói RÕ nó không mô tả vùng chữ đang có — không trình bày như số liệu
  // hiện hành, và không doạ người dùng bằng "N vùng bị bỏ" của một lần OCR đã bị thay.
  const ocrSuperseded = ocr.superseded_by_manual_regions === true;
  const dropped = (ocr.dropped || []).map(
    (d) => `${d?.text ? `“${d.text}” — ` : ''}${d?.reason || 'không rõ lý do'}`,
  );
  if (dropped.length) {
    blocks.push({
      cls: ocrSuperseded ? '' : 'warn',
      title: ocrSuperseded
        ? `Dấu vết OCR TRƯỚC ĐÓ — ${dropped.length} vùng chữ đã bị bỏ (đã bị thay bởi vùng nhập tay)`
        : `${dropped.length} vùng chữ bị bỏ khi OCR`,
      items: [
        ...(ocrSuperseded
          ? [ocr.note || 'Dấu vết OCR trước đó — đã bị thay bởi vùng nhập tay; KHÔNG phải vùng chữ đang có của job.']
          : []),
        ...dropped,
      ],
    });
  }

  if (summary) {
    if (summary.status === 'PARTIAL') {
      blocks.push({ cls: 'warn', title: 'PARTIAL — ảnh kết quả chỉ render được một phần', items: ['Một số vùng không vẽ được; xem danh sách bên dưới.'] });
    }
    const skipped = (summary.skipped || []).map(
      (s) => `${s?.region_id || '?'}: ${IL_SKIP_REASON[s?.reason] || s?.reason || 'không rõ lý do'}`,
    );
    if (skipped.length) blocks.push({ cls: 'warn', title: `${skipped.length} vùng không được vẽ`, items: skipped });
    if ((summary.unsupported_glyphs || []).length) {
      blocks.push({
        cls: 'warn',
        title: 'Thiếu glyph — không vẽ được một số ký tự',
        items: summary.unsupported_glyphs.map((g) => `Ký tự không có glyph: ${g}`),
      });
    }
    // F-02: override có vết ⇒ vùng nhãn hiệu/chứng nhận/giá ĐÃ bị thay chữ trên ảnh.
    const overrides = Array.isArray(summary.overrides) ? summary.overrides : [];
    if (overrides.length) {
      blocks.push({
        cls: 'warn',
        title: `${overrides.length} vùng nhãn hiệu/chứng nhận/giá ĐÃ BỊ THAY CHỮ trên ảnh theo yêu cầu của bạn`,
        items: overrides.map(
          (o) => `${o?.region_id || '?'} (${IL_KIND_LABEL[o?.kind] || o?.kind || '?'}) — override có vết${o?.edited_at ? ` lúc ${o.edited_at}` : ''}.`,
        ),
      });
    }
    if (summary.forced) {
      blocks.push({ cls: 'warn', title: 'Render đã bỏ qua cảnh báo cần duyệt (force)', items: ['Dòng bị guardrail chặn KHÔNG được vẽ; lý do đã ghi vào meta của ảnh kết quả.'] });
    }
    for (const w of summary.warnings || []) blocks.push({ cls: 'warn', title: 'Cảnh báo từ bước render', items: [String(w)] });
  }

  for (const w of data.warnings || []) blocks.push({ cls: 'warn', title: 'Cảnh báo', items: [String(w)] });

  if (!blocks.length) return '';
  return `<section class="panel">
    <h2>Cảnh báo thật từ hệ thống</h2>
    ${blocks
      .map(
        (b) => `<div class="notice ${b.cls}">
          <strong>${esc(b.title)}</strong>
          ${b.items.length ? `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
        </div>`,
      )
      .join('')}
  </section>`;
}

/* ── IL-08 — nhập vùng chữ bằng tay (manual OCR fallback) ───────────────
   Vì sao có: `OCR_PROVIDER=mock` (mặc định) trả vùng của một fixture cố định, KHÔNG liên quan
   tới ảnh người dùng — nên trên ảnh THẬT đường nhập tay là lối dùng được. Mọi chữ người dùng
   nhập đi qua `esc()` (XSS), kể cả `value=""` của input. */

/** Dấu vết OCR MOCK của CHÍNH JOB (ưu tiên), rồi mới tới provider đang chạy — luật như §F-03. */
function ilOcrMockTrace(data) {
  data = data || {};
  const steps = Array.isArray(data.mock_steps) ? data.mock_steps.map(String) : [];
  return Boolean(steps.includes('ocr') || data.ocr?.is_mock || data.asset?.meta?.ocr?.is_mock || data.providers?.ocr?.is_mock);
}

/** Mặc định mở khối nhập tay: OCR đang mock HOẶC job chưa có vùng chữ nào (§11.3). */
function ilManualDefaultOpen(data) {
  const regions = Array.isArray(data?.regions) ? data.regions : [];
  return regions.length === 0 || ilOcrMockTrace(data);
}

/** Người dùng đã tự bấm mở/đóng thì tôn trọng lựa chọn đó. */
function ilManualOpen(data) {
  const open = state.il.manual.open;
  return open === null || open === undefined ? ilManualDefaultOpen(data) : Boolean(open);
}

const ilNumText = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** Bản nháp bảng nhập tay = nguồn chân lý, để render lại KHÔNG mất chữ đang gõ. */
function ilManualRows(data) {
  const m = state.il.manual;
  if (Array.isArray(m.rows) && (m.rows.length > 0 || m.touched)) return m.rows;
  const regions = Array.isArray(data?.regions) ? data.regions : [];
  m.rows = regions.map((r) => {
    const box = r?.box && typeof r.box === 'object' ? r.box : {};
    return {
      x: ilNumText(box.x),
      y: ilNumText(box.y),
      w: ilNumText(box.w),
      h: ilNumText(box.h),
      text: String(r?.text ?? ''),
      kind: IL_MANUAL_KINDS.includes(r?.kind) ? r.kind : 'unknown',
    };
  });
  return m.rows;
}

/** Giới hạn vùng theo `/api/config` (imagelab.limits.max_regions); không có ⇒ null (máy chủ tự kiểm). */
function ilMaxRegions() {
  const cfg = state?.config || {};
  const raw = cfg?.imagelab?.limits?.max_regions ?? cfg?.limits?.max_regions ?? cfg?.imagelab?.max_regions;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** Bảng nhập tay bắt đầu lại từ đầu (đổi job / job mới / rời khu imagelab). */
function ilManualReset() {
  state.il.manual = {
    open: null,
    rows: null,
    touched: false,
    busy: false,
    error: null,
    notice: null,
    warnings: [],
    rejected: null,
    conflict: null,
    dirtyPaint: false,
  };
}

/** Người dùng có đang gõ trong khối nhập tay không (để vòng poll không cướp focus). */
function ilManualHasFocus() {
  const el = document.activeElement;
  return Boolean(el && typeof el.closest === 'function' && el.closest('#il-manual'));
}

/** Đồng bộ giá trị vừa gõ vào bản nháp trong `state`. */
function ilManualSyncField(target) {
  const ds = target?.dataset;
  if (!ds || ds.mfield === undefined) return;
  const idx = Number.parseInt(ds.mrow ?? '', 10);
  const rows = state.il.manual.rows;
  if (!Number.isInteger(idx) || !Array.isArray(rows) || !rows[idx]) return;
  const field = String(ds.mfield);
  if (!['x', 'y', 'w', 'h', 'text', 'kind'].includes(field)) return;
  rows[idx][field] = String(target.value ?? '');
  state.il.manual.touched = true;
}

/**
 * Dựng `regions` để gửi lên từ bảng nhập tay.
 * Trả về `{ regions, error }`: `error` khác null ⇒ CHẶN TRƯỚC, KHÔNG gọi API (nói rõ dòng nào sai).
 */
function ilManualPayload(rows, limit) {
  const list = Array.isArray(rows) ? rows : [];
  const fields = ['x', 'y', 'w', 'h'];
  const regions = [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i] || {};
    const n = i + 1;
    const text = String(row.text ?? '').trim();
    const raw = fields.map((f) => String(row[f] ?? '').trim());
    if (!text && raw.every((v) => v === '')) {
      return { regions: [], error: `Dòng ${n} đang trống hoàn toàn — điền toạ độ + chữ Trung, hoặc bấm “Xoá” ở dòng đó.` };
    }
    const nums = [];
    for (let k = 0; k < fields.length; k += 1) {
      if (raw[k] === '') {
        return { regions: [], error: `Dòng ${n}: thiếu “${fields[k]}” — cần đủ x, y, w, h (pixel trên ảnh gốc).` };
      }
      const v = Number(raw[k]);
      if (!Number.isFinite(v)) {
        return { regions: [], error: `Dòng ${n}: ${fields[k]} = “${raw[k]}” không phải là số.` };
      }
      nums.push(v);
    }
    if (!(nums[2] > 0) || !(nums[3] > 0)) {
      return { regions: [], error: `Dòng ${n}: w và h phải lớn hơn 0 — hộp không có diện tích sẽ bị máy chủ từ chối.` };
    }
    // `text` để nguyên (kể cả rỗng): máy chủ làm sạch rồi báo vào `rejected` kèm lý do — UI không tự bỏ im lặng.
    regions.push({
      box: { x: nums[0], y: nums[1], w: nums[2], h: nums[3] },
      text,
      kind: IL_MANUAL_KINDS.includes(row.kind) ? row.kind : 'unknown',
    });
  }
  if (!regions.length) {
    return { regions: [], error: 'Chưa có vùng nào để lưu — bấm “Thêm vùng” rồi điền toạ độ và chữ Trung.' };
  }
  if (limit !== null && regions.length > limit) {
    return {
      regions: [],
      error: `Đang gửi ${regions.length} vùng, vượt giới hạn ${limit} vùng của máy chủ (413 TOO_MANY_REGIONS) — xoá bớt rồi lưu lại.`,
    };
  }
  return { regions, error: null };
}

/** Khối IL-08 — bảng nhập vùng chữ bằng tay (mặc định mở khi OCR mock / job chưa có vùng). */
function renderIlManual(data) {
  data = data || {};
  const m = state.il.manual;
  const open = ilManualOpen(data);
  const limit = ilMaxRegions();
  // IL08-01(c) (vòng 6): job đang queued/running (OCR/dịch chưa xong) ⇒ KHOÁ nút lưu.
  // Máy chủ cũng từ chối (409 IMAGELAB_JOB_RUNNING) để vùng nhập tay không bị OCR ghi đè;
  // UI không được mời người dùng làm một việc chắc chắn thất bại.
  const jobStatus = String(data.job?.status || '');
  const jobRunning = jobStatus === 'queued' || jobStatus === 'running';
  // Nhãn viết tại chỗ (không mượn hằng số khác) để khối này chạy được cả khi hàm UI được
  // trích ra chạy riêng trong test/script kiểm chứng.
  // IL08-07: nhãn nêu ĐÚNG bước đang chạy (`job.stage`) — job có thể đang RENDER, không phải OCR.
  const IL_STAGE_LABEL = {
    queued: 'đang xếp hàng chờ xử lý',
    storing: 'đang lưu ảnh gốc',
    ocr: 'đang nhận dạng chữ (OCR)',
    translating: 'đang dịch chữ',
    rendering: 'đang render ảnh',
  };
  const jobStage = String(data.job?.stage || '');
  const jobStatusLabel = IL_STAGE_LABEL[jobStage] || (jobStatus === 'queued' ? 'đang xếp hàng chờ xử lý' : 'đang xử lý ảnh');
  const asset = data.asset || null;
  const rows = open ? ilManualRows(data) : [];
  const over = limit !== null && rows.length > limit;
  const reasons = [];
  if (!(Array.isArray(data.regions) && data.regions.length)) reasons.push('job chưa có vùng chữ nào');
  if (ilOcrMockTrace(data)) reasons.push('OCR đang chạy bằng dữ liệu MOCK');
  const rejected = m.rejected || null;
  const badRow = new Map();
  for (const it of rejected?.items || []) if (Number.isInteger(it.row)) badRow.set(it.row, it.reason);
  const dims = Number.isFinite(Number(asset?.width)) && Number.isFinite(Number(asset?.height))
    ? `Ảnh gốc ${asset.width}×${asset.height} px — x trong 0…${asset.width}, y trong 0…${asset.height}.`
    : 'Chưa rõ kích thước ảnh gốc — toạ độ là pixel trên ảnh gốc.';

  const body = !open
    ? ''
    : `
    <p class="muted small" style="margin:10px 0 0">
      ${esc(dims)} Hộp tràn ra ngoài ảnh sẽ bị máy chủ cắt lại; hộp nằm hoàn toàn ngoài ảnh sẽ bị từ chối.
    </p>
    <p class="muted small" style="margin:6px 0 0">
      <strong>Mô tả</strong> = sẽ dịch · <strong>Nhãn hiệu / Chứng nhận / Giá</strong> = KHOÁ, không dịch
      (giống hệt khi OCR đọc ra).${reasons.length ? ` Khối này mặc định mở vì ${esc(reasons.join(' và '))}.` : ''}
    </p>
    <p class="muted small" style="margin:6px 0 0">
      ${limit !== null ? `Giới hạn máy chủ: tối đa ${esc(limit)} vùng — bảng đang có ${esc(rows.length)} dòng.` : 'Máy chủ không công bố giới hạn số vùng — máy chủ vẫn kiểm tra khi lưu.'}
    </p>
    ${over
      ? `<div class="notice warn"><strong>Vượt giới hạn ${esc(limit)} vùng của máy chủ.</strong>
           <p style="margin:6px 0 0">Xoá bớt ${esc(rows.length - limit)} dòng rồi lưu — nếu không, máy chủ sẽ từ chối cả lượt lưu (413 TOO_MANY_REGIONS).</p>
         </div>`
      : ''}
    <div class="il-tablewrap" style="margin-top:10px">
      <table class="evidence il-table il-manual-table">
        <thead>
          <tr><th>x</th><th>y</th><th>w</th><th>h</th><th>Chữ Trung</th><th>Loại</th><th></th></tr>
        </thead>
        <tbody>
          ${rows
            .map((row, i) => {
              const why = badRow.get(i + 1);
              return `<tr${why ? ` class="il-row-bad" title="${esc(why)}"` : ''}>
                ${['x', 'y', 'w', 'h']
                  .map(
                    (f) =>
                      `<td><input class="il-input il-mini" data-mrow="${i}" data-mfield="${f}" inputmode="decimal" value="${esc(row[f])}" aria-label="Dòng ${i + 1} cột ${f}" /></td>`,
                  )
                  .join('')}
                <td><input class="il-input il-manual-zh" data-mrow="${i}" data-mfield="text" value="${esc(row.text)}" aria-label="Dòng ${i + 1} chữ Trung" /></td>
                <td>
                  <select class="il-input il-mini" data-mrow="${i}" data-mfield="kind" aria-label="Dòng ${i + 1} loại vùng">
                    ${IL_MANUAL_KINDS.map((k) => `<option value="${esc(k)}"${row.kind === k ? ' selected' : ''}>${esc(IL_KIND_LABEL[k] || k)}</option>`).join('')}
                  </select>
                </td>
                <td><button class="btn ghost tiny danger" data-action="ilmanualdel" data-row="${i}" title="Xoá dòng ${i + 1}">Xoá</button></td>
              </tr>`;
            })
            .join('') || '<tr><td colspan="7" class="muted small">Chưa có dòng nào — bấm “Thêm vùng”.</td></tr>'}
        </tbody>
      </table>
    </div>
    ${m.conflict
      ? `<div class="notice warn">
           <strong>MANUAL_EDITS_WOULD_BE_LOST — bạn đã sửa tay các dòng dịch của job này.</strong>
           <p style="margin:6px 0 0">Thay vùng chữ sẽ <strong>XOÁ</strong> những bản sửa tay đó rồi dịch lại từ đầu.
             Máy chủ báo: ${esc(m.conflict.message || 'chưa xác nhận thay thế')}</p>
           <button class="btn tiny danger" data-action="ilmanualforce" style="margin-top:8px"${m.busy ? ' disabled' : ''}>Vẫn thay (mất bản sửa tay)</button>
         </div>`
      : ''}
    ${rejected
      ? `<div class="notice ${rejected.items.length ? 'warn' : 'ok'}">
           <strong>${rejected.items.length ? `Máy chủ đã từ chối ${esc(rejected.items.length)} vùng` : 'Không có vùng nào bị máy chủ từ chối'}</strong>
           ${rejected.items.length
             ? `<ul>${rejected.items
                 .map(
                   (it) =>
                     `<li><span class="mono">index ${esc(it.index)}</span>${Number.isInteger(it.row) ? ` — dòng ${esc(it.row)} trong bảng` : ''}: ${esc(it.reason)}</li>`,
                 )
                 .join('')}</ul>
                <p style="margin:6px 0 0">Các dòng bị từ chối VẪN nằm trong bảng để bạn sửa; sửa xong bấm “LƯU VÙNG &amp; DỊCH” lần nữa.</p>`
             : ''}
         </div>`
      : ''}
    ${m.warnings.length ? `<div class="notice warn"><strong>Cảnh báo từ lần lưu vùng</strong><ul>${m.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    ${m.error ? `<div class="notice error">${esc(m.error)}</div>` : ''}
    ${m.notice ? `<div class="notice ok">${esc(m.notice)}</div>` : ''}
    ${jobRunning
      ? `<div class="notice warn"><strong>Job ${esc(jobStatusLabel)} — chờ bước này xong rồi hãy lưu vùng.</strong>
           <p style="margin:6px 0 0">Bạn vẫn nhập/sửa bảng được; nút lưu sẽ mở lại khi job xong. Máy chủ từ chối lưu lúc này
           (409 <span class="mono">IMAGELAB_JOB_RUNNING</span>) để vùng bạn nhập không bị bước OCR ghi đè.</p></div>`
      : ''}
    <div class="row" style="margin-top:12px">
      <button class="btn primary" data-action="ilmanualsave"${m.busy || jobRunning ? ' disabled' : ''}>${
        jobRunning ? 'JOB ĐANG CHẠY — CHỜ XONG' : m.busy ? 'ĐANG LƯU…' : 'LƯU VÙNG &amp; DỊCH'
      }</button>
      <button class="btn ghost" data-action="ilmanualadd">Thêm vùng</button>
      <button class="btn ghost tiny" data-action="ilmanualreload">Nạp lại vùng của job</button>
      <span class="muted small">Lưu sẽ THAY toàn bộ vùng của job (replace: true) rồi dịch lại.</span>
    </div>
    ${m.rejected
      ? '<p class="muted small" style="margin:8px 0 0">Bảng vẫn giữ đúng những gì bạn đã gửi. Bấm “Nạp lại vùng của job” để xem bản máy chủ đã lưu (toạ độ có thể đã bị cắt theo khung ảnh).</p>'
      : ''}`;

  return `
    <section class="panel" id="il-manual">
      <div class="spread">
        <h2 style="margin:0">Nhập vùng chữ bằng tay</h2>
        <button class="btn ghost tiny" data-action="ilmanualtoggle">${open ? 'Thu gọn' : 'Mở ra'}</button>
      </div>
      <p class="muted small" style="margin:8px 0 0">
        Dùng khi OCR đọc sai hoặc không đọc được chữ trên ảnh thật.
        Vùng nhập tay có <strong>nguồn = người dùng</strong>; vùng <strong>nhãn hiệu / chứng nhận / giá vẫn bị KHOÁ</strong> như khi OCR đọc ra.
      </p>
      ${body}
    </section>`;
}

/** Thêm một dòng trống vào bảng nhập tay (chặn trước nếu vượt `max_regions`). */
function addIlManualRow() {
  const data = state.il.job || {};
  const m = state.il.manual;
  const rows = ilManualRows(data);
  const limit = ilMaxRegions();
  if (limit !== null && rows.length >= limit) {
    m.open = true;
    m.error = `Chỉ được tối đa ${limit} vùng (giới hạn máy chủ). Bảng đang có ${rows.length} vùng — xoá bớt rồi thêm.`;
    renderImagelab();
    toast(`Tối đa ${limit} vùng.`);
    return;
  }
  m.open = true;
  m.touched = true;
  m.error = null;
  m.rejected = null; // số dòng đổi ⇒ chỉ số của lần lưu trước không còn đúng
  rows.push({ x: '', y: '', w: '', h: '', text: '', kind: 'descriptive' });
  renderImagelab();
  const el = document.querySelector(`#il-manual input[data-mrow="${rows.length - 1}"][data-mfield="x"]`);
  if (el) el.focus();
}

/** Xoá một dòng khỏi bảng nhập tay. */
function removeIlManualRow(index) {
  const rows = state.il.manual.rows;
  if (!Number.isInteger(index) || !Array.isArray(rows) || !rows[index]) return;
  rows.splice(index, 1);
  state.il.manual.touched = true;
  state.il.manual.error = null;
  state.il.manual.rejected = null; // chỉ số của lần lưu trước không còn đúng sau khi xoá dòng
  renderImagelab();
}

/**
 * IL-08 — `PUT /api/imagelab/jobs/:id/regions` với `{ regions, replace: true }`.
 * 409 `MANUAL_EDITS_WOULD_BE_LOST` ⇒ hiện cảnh báo rõ + nút xác nhận (`confirm_replace_edited`).
 */
async function saveIlManualRegions(confirmReplace) {
  const data = state.il.job || {};
  const jobId = data.job?.id;
  const m = state.il.manual;
  if (!jobId || m.busy) return;
  const built = ilManualPayload(ilManualRows(data), ilMaxRegions());
  m.open = true;
  if (built.error) {
    m.error = built.error;
    m.conflict = null;
    m.notice = null;
    renderImagelab();
    toast('Chưa lưu được — xem lý do trong khối “Nhập vùng chữ bằng tay”.');
    return;
  }
  m.busy = true;
  m.error = null;
  m.conflict = null;
  renderImagelab();
  try {
    const res = await api(`/api/imagelab/jobs/${jobId}/regions`, {
      method: 'PUT',
      body: confirmReplace
        ? { regions: built.regions, replace: true, confirm_replace_edited: true }
        : { regions: built.regions, replace: true },
    });
    // `rejected[].index` = vị trí trong mảng vùng ĐÃ GỬI; bảng gửi đủ mọi dòng theo đúng thứ tự
    // nên dòng trong bảng = index + 1.
    const items = (Array.isArray(res.rejected) ? res.rejected : []).map((r) => {
      const i = Number(r?.index);
      return {
        index: r?.index,
        row: Number.isInteger(i) && i >= 0 ? i + 1 : null,
        reason: String(r?.reason || 'không rõ lý do'),
      };
    });
    const savedRegions = Array.isArray(res.regions) ? res.regions : null;
    m.busy = false;
    m.rejected = { items };
    m.warnings = (Array.isArray(res.warnings) ? res.warnings : []).map(String);
    m.notice = items.length
      ? `Lần lưu gần nhất: đã lưu ${(savedRegions || []).length} vùng nhập tay (nguồn = người dùng) và dịch lại; ${items.length} vùng bị máy chủ từ chối.`
      : `Lần lưu gần nhất: đã lưu ${(savedRegions || []).length} vùng nhập tay (nguồn = người dùng) và dịch lại.`;
    state.il.lastSave = null; // kết quả lưu vùng hiện ngay trong khối này, không trộn với bảng duyệt
    // Vùng cũ đã bị thay ⇒ "cho phép dịch vùng này" của vùng cũ KHÔNG được dính sang vùng mới.
    state.il.overrides = new Set();
    state.il.job = {
      ...data,
      job: { ...(data.job || {}), status: res.status || data.job?.status },
      regions: savedRegions || data.regions,
      lines: Array.isArray(res.lines) ? res.lines : data.lines,
    };
    state.il.error = null;
    toast(items.length ? 'Đã lưu vùng (một số vùng bị từ chối — xem chi tiết)' : 'Đã lưu vùng & dịch lại');
    renderImagelab();
  } catch (err) {
    m.busy = false;
    if (err.code === 'MANUAL_EDITS_WOULD_BE_LOST') {
      m.conflict = { message: err.message || '' };
      m.error = null;
    } else if (err.code === 'IMAGELAB_JOB_RUNNING') {
      // IL08-01(c): KHÔNG nuốt lỗi — nói rõ vì sao chưa lưu được và phải làm gì.
      m.error = `Chưa lưu được: ${err.message || 'job đang chạy OCR/dịch.'} Bảng bạn vừa nhập vẫn còn nguyên trên màn hình — bấm “LƯU VÙNG & DỊCH” lại sau khi job xong.`;
      m.conflict = null;
      toast('Job đang chạy — chờ xong rồi lưu vùng.');
    } else {
      m.error = ilErrorText(err);
      m.conflict = null;
    }
    renderImagelab();
  }
}

function paintIlError() {
  const box = $('#il-error');
  if (!box || !state.il.error) return;
  box.innerHTML = `<div class="notice error">${esc(state.il.error)}</div>`;
}

/* ── Hành động: override, lưu, render ───────────────────────────────── */

function toggleIlOverride(regionId) {
  if (!regionId) return;
  const row = document.querySelector(`#il-lines tr[data-region="${cssEscape(regionId)}"]`);
  if (!row) return;
  const on = !state.il.overrides.has(regionId);
  if (on) state.il.overrides.add(regionId);
  else state.il.overrides.delete(regionId);

  row.classList.toggle('il-overridden', on);
  const input = row.querySelector('input.il-input');
  if (input) {
    input.disabled = !on;
    input.placeholder = on ? 'Nhập bản dịch tiếng Việt' : 'Vùng bị khoá — bấm “vẫn dịch vùng này” nếu bạn chắc chắn';
    if (on) input.focus();
  }
  const btn = row.querySelector('[data-action="iloverride"]');
  if (btn) btn.textContent = on ? 'huỷ cho phép dịch' : 'vẫn dịch vùng này (sẽ thay chữ trên ảnh và ghi vết)';
}

async function saveImagelabLines() {
  const data = state.il.job;
  const jobId = data?.job?.id;
  if (!jobId) return;
  const regions = new Map((data.regions || []).map((r) => [r.id, r]));
  const edits = [];
  document.querySelectorAll('#il-lines input[data-region]').forEach((input) => {
    const id = input.dataset.region;
    const line = (data.lines || []).find((l) => l.region_id === id);
    if (!line) return;
    const region = regions.get(id) || null;
    if (ilLocked(line, region) && !state.il.overrides.has(id)) return; // vùng khoá: không gửi lên
    const value = input.value.trim();
    if (!value) edits.push({ region_id: id, text_vi: '', action: 'skip' });
    else if (value === (line.text_vi || '')) edits.push({ region_id: id, text_vi: value, action: 'accept' });
    else edits.push({ region_id: id, text_vi: value, action: 'edit' });
  });

  if (!edits.length) {
    toast('Không có thay đổi nào để lưu.');
    return;
  }
  try {
    const res = await api(`/api/imagelab/jobs/${jobId}/lines`, {
      method: 'PUT',
      body: { edits, allow_brand_override: state.il.overrides.size > 0 },
    });
    state.il.job = { ...data, lines: res.lines || data.lines };
    state.il.lastSave = { rejected: res.rejected || [], warnings: res.warnings || [] };
    state.il.renderBlocked = null;
    state.il.error = null;
    toast(res.rejected?.length ? 'Đã lưu (một số dòng bị từ chối)' : 'Đã lưu bản dịch');
    renderImagelab();
  } catch (err) {
    state.il.error = ilErrorText(err);
    renderImagelab();
  }
}

async function renderImagelabImage(force) {
  const jobId = state.il.job?.job?.id;
  if (!jobId) return;
  try {
    await api(`/api/imagelab/jobs/${jobId}/render`, {
      method: 'POST',
      body: force ? { force: true } : {},
    });
    state.il.lastSave = null;
    state.il.renderBlocked = null;
    state.il.error = null;
    toast(force ? 'Đang render (đã ghi vết bỏ qua cảnh báo)…' : 'Đang render ảnh…');
    startIlPolling();
    renderImagelab();
  } catch (err) {
    if (err.code === 'REVIEW_REQUIRED') {
      // Không im lặng bỏ qua: hiện đúng lý do và để người dùng quyết định có force hay không.
      state.il.renderBlocked = err.message;
      state.il.error = null;
    } else {
      state.il.error = ilErrorText(err);
    }
    renderImagelab();
  }
}

/* ═════════════ MVP-03 — TAB “TẠO ẢNH” (Image Generation / Retouching) ═════════════
 * Hợp đồng §3.7. Ba luật riêng của MVP-03 được UI NÓI THẲNG ra, không giấu:
 *   1. Không bóp méo sản phẩm — ảnh ra cùng khung hình; retouch bị KẸP trong ngưỡng CỦA MÁY CHỦ.
 *   2. Nền mới là MÔ PHỎNG — mẫu nền hiện nhãn “MÔ PHỎNG”; UI không bao giờ nói “nền thật”.
 *   3. Tách nền fail-closed — không đủ tự tin thì UI nói rõ “không tách được nền, ảnh chỉ được retouch”.
 *
 * Mọi chữ đi qua `esc()` trước khi vào DOM, kể cả giá trị trong `value=""`.
 * Hàm THUẦN, dễ trích để test (không cần DOM): renderImagestudioBody, renderIsUpload, renderIsOptions,
 * renderIsTemplates, renderIsParam, renderIsJob, renderIsSteps, renderIsCompare, renderIsWarnings,
 * renderIsOverlayBlocked, isErrorBox, isJobOptions, isLimitFor, isNumText, isViolationText.
 */

const IS_STATUS_LABEL = {
  queued: 'Đang chờ',
  running: 'Đang xử lý',
  succeeded: 'Hoàn tất',
  partial: 'Xong một phần (PARTIAL)',
  failed: 'Thất bại',
  needs_manual: 'Cần bổ sung dữ liệu',
};

const IS_STAGE_LABEL = {
  queued: 'Xếp hàng',
  storing: 'Đang lưu ảnh gốc',
  matting: 'Đang tách nền (fail-closed)',
  composing: 'Đang ghép nền MÔ PHỎNG',
  retouching: 'Đang retouch trong ngưỡng cho phép',
  done: 'Xong',
  failed: 'Lỗi',
};

const IS_STAGE_ORDER = ['queued', 'storing', 'matting', 'composing', 'retouching', 'done'];

const IS_STAGE_STEPS = [['storing', 'Lưu ảnh gốc'], ['matting', 'Tách nền (không đủ tự tin ⇒ TỪ CHỐI cắt)'], ['composing', 'Ghép nền MÔ PHỎNG'], ['retouching', 'Retouch trong ngưỡng'], ['done', 'Hoàn tất']];

const IS_PARAM_LABEL = {
  brightness: 'Độ sáng',
  contrast: 'Tương phản',
  saturation: 'Bão hoà',
  sharpen: 'Nét',
};

const IS_PARAM_ORDER = ['brightness', 'contrast', 'saturation', 'sharpen'];

/** Nhãn trung thực BẮT BUỘC cho mọi nền do hệ thống sinh ra (§0 luật 2). */
const IS_SYNTHETIC_NOTE = 'nền MÔ PHỎNG (không phải ảnh thật)';

const IS_OVERLAY_CLAIM_NOTE = 'Chữ có khẳng định (bảo hành, chứng nhận, số liệu…) mà ảnh/tên sản phẩm không có sẽ bị CHẶN, không vẽ.';

const IS_MATTING_FAIL_TEXT = {
  UNIFORM_BACKGROUND_NOT_FOUND: 'Không tách được nền: nền không đủ đồng nhất nên hệ thống TỪ CHỐI cắt (fail-closed). Ảnh chỉ được retouch, nền gốc giữ nguyên.',
  SUSPICIOUS_MASK: 'TỪ CHỐI tách nền vì NGHI NGỜ ĐÃ ĂN MẤT SẢN PHẨM (một mảng lớn không-phải-nền bị cắt, hoặc phần giữ lại quá nhỏ). Ảnh chỉ được retouch, nền gốc giữ nguyên.',
  // N1 (vòng 9): KHÁC hẳn "nghi ngờ ăn mất sản phẩm" — mask bao ĐÚNG sản phẩm, chỉ mờ ở viền.
  SEGMENTATION_AMBIGUOUS: 'KHÔNG GHÉP NỀN vì biên nhập nhằng (bóng đổ mềm / viền mờ / sản phẩm sáng gần màu nền) — sản phẩm vẫn được giữ nguyên. Ảnh của bạn vẫn được retouch theo tham số; muốn ghép nền hãy dùng ảnh có nền phẳng hơn, hoặc bật “Vẫn ghép nền dù biên nhập nhằng” (có ghi vết).',
  SEGMENTATION_FAILED: 'Không tách được nền: hệ thống không đủ tự tin nên TỪ CHỐI cắt (fail-closed). Ảnh chỉ được retouch, nền gốc giữ nguyên.',
  UNSUPPORTED_IMAGE: 'Ảnh không giải mã được ở bước tách nền. Ảnh chỉ được retouch, nền gốc giữ nguyên.',
  NOT_CONFIGURED: 'Không tách được nền: provider tách nền chưa được cấu hình. Ảnh chỉ được retouch, nền gốc giữ nguyên.',
  FAILED: 'Không tách được nền: bước tách nền thất bại. Ảnh chỉ được retouch, nền gốc giữ nguyên.',
};

/** Lỗi 5xx bị server che message ⇒ UI tự dịch mã lỗi sang câu tiếng Việt (như MVP-02). */
const IS_ERROR_HINT = {
  IMAGESTUDIO_UNAVAILABLE: 'Máy chủ chưa nạp được module tạo ảnh. Các tính năng MVP-01/MVP-02 vẫn dùng bình thường.',
  NOT_CONFIGURED: 'Provider tách nền / retouch chưa được cấu hình trên máy chủ.',
  MATTING_NOT_CONFIGURED: 'Provider tách nền chưa được cấu hình — ảnh sẽ chỉ được retouch.',
  RETOUCH_NOT_CONFIGURED: 'Provider retouch chưa được cấu hình.',
  RATE_LIMITED: 'Bạn thao tác quá nhanh — chờ một lát rồi thử lại.',
  BAD_IMAGE: 'Dữ liệu ảnh không hợp lệ.',
  IMAGE_TOO_LARGE: 'Ảnh vượt giới hạn cho phép.',
  UNSUPPORTED_MEDIA_TYPE: 'Ảnh không hợp lệ hoặc định dạng không được phép (PNG / JPEG / WebP / GIF).',
  OVERLAY_UNSUPPORTED_CLAIM: 'Chữ overlay có khẳng định không có bằng chứng trong ảnh/tên sản phẩm nên bị CHẶN — không vẽ.',
  JOB_NOT_FOUND: 'Không tìm thấy job này (có thể thuộc phiên làm việc khác).',
};

/** Số lần poll tối đa trước khi nói thẳng “có thể job bị kẹt” (1.5s × 240 ≈ 6 phút). */
const IS_MAX_POLLS = 240;

/* ── Đọc ngưỡng / tham số ───────────────────────────────────────────────────── */

/** Ngưỡng retouch của MÁY CHỦ (§3.6). UI KHÔNG hardcode: thiếu ⇒ null và thanh trượt bị khoá. */
function isLimits() {
  const fromApi = state.is?.limits;
  const fromConfig = state.config?.imagestudio?.retouch_limits;
  const src = fromApi && typeof fromApi === 'object' ? fromApi : fromConfig;
  return src && typeof src === 'object' ? src : null;
}

/** Ngưỡng của MỘT tham số (biên độ dương) — null nghĩa là chưa biết thì KHÔNG cho kéo. */
function isLimitFor(name) {
  const lim = isLimits();
  const n = Number(lim && lim[name]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isParamValue(name) {
  const v = Number(state.is?.options?.retouch?.[name]);
  return Number.isFinite(v) ? v : 0;
}

/** Tham số HIỆU LỰC sau khi máy chủ kẹp — cảnh báo phải nói đúng con số này. */
function isEffectiveValue(retouch, name) {
  const eff = retouch && retouch.params_effective;
  if (!eff || typeof eff !== 'object' || !Object.prototype.hasOwnProperty.call(eff, name)) return null;
  const n = Number(eff[name]);
  return Number.isFinite(n) ? n : null;
}

/** Số có dấu, gọn: +0.25 / -0.1 / 0 — không làm tròn thành con số khác. */
function isNumText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (s === '' || s === '-' || Number(s) === 0) return '0';
  return n > 0 ? `+${s}` : s;
}

/** Số không dấu (số đo thật của matting). */
function isNumPlain(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const s = n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-' ? '0' : s;
}

function isJobRunning(job) {
  if (!job || typeof job !== 'object') return false;
  const stage = String(job.stage || '').toLowerCase();
  const status = String(job.status || '').toLowerCase();
  if (stage === 'done' || stage === 'failed') return false;
  if (status === 'succeeded' || status === 'failed' || status === 'partial' || status === 'needs_manual') return false;
  return true;
}

/** Số đo THẬT của matting — hiện nguyên, không diễn giải thành “chắc là ổn”. */
function isMaskItems(mask) {
  if (!mask || typeof mask !== 'object') return [];
  const items = [];
  if (mask.uniformity !== null && mask.uniformity !== undefined) {
    items.push(`Độ đồng nhất nền đo được: ${isNumPlain(mask.uniformity)} (càng thấp càng khó tách).`);
  }
  if (mask.background_ratio !== null && mask.background_ratio !== undefined) {
    items.push(`Tỉ lệ pixel thuộc nền: ${isNumPlain(mask.background_ratio)}.`);
  }
  if (mask.coverage !== null && mask.coverage !== undefined) {
    items.push(`Tỉ lệ pixel giữ lại (sản phẩm): ${isNumPlain(mask.coverage)}.`);
  }
  if (mask.seed_colors !== null && mask.seed_colors !== undefined) {
    items.push(`Số cụm màu nền: ${isNumPlain(mask.seed_colors)}.`);
  }
  return items;
}

/** Vi phạm của guardrail overlay có thể là chuỗi hoặc object — hiện sao cho đọc được. */
function isViolationText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const parts = [v.group || v.kind, v.word || v.text || v.claim || v.value, v.reason || v.message].filter(
    (x) => x !== null && x !== undefined && x !== '',
  );
  if (parts.length) return parts.map((x) => String(x)).join(' · ');
  try {
    return JSON.stringify(v);
  } catch {
    return 'vi phạm không đọc được';
  }
}

/** Vi phạm nhét trong body 422 (§3.5) — `api()` giữ nguyên cả phong bì lỗi lẫn body phẳng. */
function isErrorViolations(err) {
  const holders = [err?.payload || {}, err?.body || {}];
  const raw = [];
  for (const holder of holders) {
    const details = holder.details || {};
    for (const src of [holder.violations, details.violations]) {
      if (Array.isArray(src)) raw.push(...src);
    }
  }
  // E4 trả CÙNG danh sách ở hai chỗ (`violations` phẳng + `error.details.violations`) ⇒ khử
  // trùng, để người dùng không phải đọc cùng một vi phạm hai lần.
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    const t = isViolationText(v);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 422 của overlay (mọi mã `OVERLAY_*`) ⇒ khối cảnh báo riêng, hiện ĐỦ lý do + vi phạm. */
function isOverlayBlockedFromError(err) {
  const violations = isErrorViolations(err);
  const code = String(err?.code || '');
  // `OVERLAY_NOT_TRANSLATED` (còn chữ Hán) có thể KHÔNG kèm vi phạm nào — vẫn phải hiện thành
  // khối “bị chặn”, không rơi xuống thành lỗi chung chung.
  if (!code.startsWith('OVERLAY_') && violations.length === 0) return null;
  return { code: code || 'OVERLAY_UNSUPPORTED_CLAIM', reason: err?.message || 'Máy chủ không nêu lý do.', violations };
}

function isErrorText(err) {
  const prefix = err?.code ? `${err.code}: ` : '';
  const hint = err?.status >= 500 ? IS_ERROR_HINT[err.code] : null;
  return `${prefix}${hint || err?.message || 'Lỗi không xác định.'}`;
}

/* ── Tham số gửi lên API ───────────────────────────────────────────────────── */

/** `options` gửi lên: chỉ gửi tham số THẬT SỰ khác 0; overlay chỉ gửi khi có chữ. */
function isJobOptions() {
  const o = state.is?.options || {};
  const retouch = {};
  for (const name of IS_PARAM_ORDER) {
    const v = Number(o.retouch && o.retouch[name]);
    if (Number.isFinite(v) && v !== 0) retouch[name] = v;
  }
  const overlayText = String(o.overlay_text ?? '').trim();
  const options = { template: o.template || null, remove_background: o.remove_background !== false };
  // N1: chỉ gửi khi người dùng THẬT SỰ bật (mặc định máy chủ từ chối ghép nền khi biên nhập nhằng).
  if (o.matting_allow_ambiguous === true) options.matting_allow_ambiguous = true;
  if (Object.keys(retouch).length) options.retouch = retouch;
  if (overlayText) options.overlay = { text: overlayText };
  return options;
}

/** Mặc định mẫu nền = `trang` (§3.2); máy chủ không có `trang` thì lấy mẫu đầu tiên. */
function ensureIsTemplate() {
  const list = Array.isArray(state.is?.templates) ? state.is.templates : [];
  const ids = list.map((t) => String(t?.id ?? ''));
  if (!ids.length) return;
  if (ids.includes(String(state.is.options.template || ''))) return;
  state.is.options.template = ids.includes('trang') ? 'trang' : ids[0];
}

/** GET job cũng trả `templates` + `retouch_limits` (§3.6) — dùng luôn, khỏi phụ thuộc một lần gọi. */
function adoptIsMeta(data) {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data.templates) && data.templates.length) {
    state.is.templates = data.templates;
    ensureIsTemplate();
  }
  if (data.retouch_limits && typeof data.retouch_limits === 'object') state.is.limits = data.retouch_limits;
  if (data.providers) state.is.providers = data.providers;
}

/** Khi MỞ một job đã có: nạp lại tham số job đã dùng để “tạo lại với tham số khác” bắt đầu từ đó. */
function syncIsOptionsFromJob(data) {
  if (!data || typeof data !== 'object') return;
  const renderedList = Array.isArray(data.rendered) ? data.rendered : [];
  const rendered = renderedList[renderedList.length - 1] || null;
  const meta = rendered?.meta || {};
  const tpl = data.compose?.template || meta.template;
  const tplId = typeof tpl === 'string' ? tpl : tpl?.id;
  if (tplId) state.is.options.template = String(tplId);
  const eff = data.retouch?.params_effective;
  if (eff && typeof eff === 'object') {
    for (const name of IS_PARAM_ORDER) {
      const n = Number(eff[name]);
      if (Number.isFinite(n)) state.is.options.retouch[name] = n;
    }
  }
  const overlayText = data.overlay?.text ?? meta.overlay?.text;
  if (typeof overlayText === 'string' && overlayText.trim()) state.is.options.overlay_text = overlayText;
  if (data.providers) state.is.providers = data.providers;
}

/* ── Khối render (thuần, không đụng DOM) ───────────────────────────────────── */

function isProviderBadges() {
  const cfg = state.config?.imagestudio || {};
  const known = state.is?.providers || {};
  const matting = known.matting || cfg.matting || state.is?.mattingProvider || null;
  const retouch = known.retouch || cfg.retouch || null;
  return `${ilProviderBadge('Tách nền', matting)}${ilProviderBadge('Retouch', retouch)}`;
}

function isMockNotice() {
  const cfg = state.config?.imagestudio || {};
  const steps = [['matting', 'tách nền (matting)'], ['retouch', 'retouch']]
    .filter(([key]) => cfg?.[key]?.is_mock)
    .map(([, label]) => label);
  if (!steps.length) return '';
  return `<div class="notice warn">
    <strong>MOCK — ${esc(steps.join(', '))} đang chạy bằng dữ liệu giả lập.</strong>
    <p style="margin:6px 0 0">Kết quả không phải tách nền / retouch thật. Không dùng để đánh giá chất lượng hoặc đăng bán.</p>
  </div>`;
}

/** Nói rõ ngưỡng đang dùng là SỐ CỦA MÁY CHỦ — và nếu chưa có thì thanh trượt bị khoá. */
function isLimitsNotice() {
  const pairs = IS_PARAM_ORDER.map((name) => [name, isLimitFor(name)]);
  if (pairs.every(([, v]) => v === null)) {
    return `<div class="notice warn small" style="margin-bottom:0">Chưa lấy được <span class="mono">retouch_limits</span> từ máy chủ — 4 thanh trượt bị khoá. UI KHÔNG tự bịa ngưỡng.</div>`;
  }
  return `<div class="muted small" style="margin-top:10px">Ngưỡng retouch đang dùng (số của MÁY CHỦ, UI không hardcode):
    ${pairs.map(([name, v]) => `${esc(IS_PARAM_LABEL[name] || name)} ${v === null ? '—' : `±${esc(v)}`}`).join(' · ')}</div>`;
}

function isHeaderPanel() {
  const cfg = state.config?.imagestudio || {};
  const available = cfg.available !== false;
  return `<section class="panel">
    <div class="spread">
      <div style="min-width:0">
        <h2 style="margin:0 0 4px">Tạo ảnh marketing từ ảnh thật</h2>
        <p class="muted small" style="margin:0">
          Tách nền là <strong>fail-closed</strong>: không đủ tự tin thì hệ thống TỪ CHỐI cắt và chỉ retouch.
          Nền do hệ thống sinh ra luôn là <strong>${esc(IS_SYNTHETIC_NOTE)}</strong> — hệ thống KHÔNG tạo ảnh nền thật.
          Ảnh ra <strong>cùng kích thước</strong> ảnh gốc, <strong>ảnh gốc không bị sửa</strong>.
        </p>
      </div>
      <span class="badge ${available ? 'ok' : 'bad'}">${available ? 'Sẵn sàng' : 'Chưa khả dụng'}</span>
    </div>
    <div class="row" style="margin-top:10px">${isProviderBadges()}</div>
    ${isMockNotice()}
    ${isLimitsNotice()}
  </section>`;
}

function isUnavailablePanel() {
  const cfg = state.config?.imagestudio || {};
  const reason = cfg.reason || state.is?.templatesError || null;
  return `<section class="panel"><div class="notice error"><strong>Tính năng tạo ảnh chưa sẵn sàng trên máy chủ này (IMAGESTUDIO_UNAVAILABLE).</strong>
    <p style="margin:6px 0 0">Lý do máy chủ báo: ${esc(reason || 'không nêu lý do — xem log máy chủ (imagestudio.wiring_failed).')}</p>
    <p style="margin:6px 0 0">Các tính năng MVP-01 và “Dịch ảnh Trung → Việt” (MVP-02) vẫn dùng bình thường.</p></div></section>`;
}

function isErrorBox() {
  if (!state.is?.error) return '';
  return `<div class="notice error">${esc(state.is.error)}</div>`;
}

/** 422 khi tạo/tạo lại: hiện đúng reason + từng vi phạm (không nuốt). */
function renderIsOverlayBlocked() {
  const b = state.is?.overlayBlocked;
  if (!b) return '';
  const violations = Array.isArray(b.violations) ? b.violations : [];
  return `<div class="notice error">
    <strong>Chữ overlay bị CHẶN — không vẽ (${esc(b.code || 'OVERLAY_UNSUPPORTED_CLAIM')})</strong>
    <p style="margin:6px 0 0">${esc(b.reason || 'Máy chủ không nêu lý do.')}</p>
    ${violations.length ? `<ul>${violations.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>` : ''}
    <p class="muted small" style="margin:6px 0 0">${esc(IS_OVERLAY_CLAIM_NOTE)} Sửa chữ cho khớp với thứ ảnh/tên sản phẩm thực có, rồi gửi lại.</p>
  </div>`;
}

function renderIsTemplates() {
  const list = Array.isArray(state.is?.templates) ? state.is.templates : [];
  if (!list.length) {
    const err = state.is?.templatesError;
    return `<div class="notice warn"><strong>Chưa có danh sách mẫu nền.</strong>
      <p style="margin:6px 0 0">${err ? esc(err) : 'Đang lấy danh sách mẫu nền từ máy chủ…'}</p>
      <button class="btn tiny" data-action="isreload" style="margin-top:8px">THỬ LẤY LẠI MẪU NỀN</button>
    </div>`;
  }
  const chosen = String(state.is?.options?.template ?? '');
  return `<div class="is-templates">${list
    .map((t) => {
      const id = String(t?.id ?? '');
      const label = String(t?.label ?? id);
      const synthetic = t?.synthetic === true;
      const checked = chosen === id;
      return `<label class="is-template${checked ? ' active' : ''}">
        <input type="radio" name="is-template" value="${esc(id)}" data-is-template ${checked ? 'checked' : ''} />
        <span class="is-template-label">${esc(label)}</span>
        ${synthetic ? '<span class="badge warn">MÔ PHỎNG</span>' : ''}
        <span class="mono muted small">${esc(id)}</span>
      </label>`;
    })
    .join('')}</div>`;
}

function renderIsParam(name) {
  const label = IS_PARAM_LABEL[name] || name;
  const lim = isLimitFor(name);
  const value = isParamValue(name);
  const inputId = `is-param-${name}`;
  if (lim === null) {
    return `<div class="is-slider">
      <div class="is-slider-head"><label for="${esc(inputId)}">${esc(label)} <span class="mono muted">(${esc(name)})</span></label></div>
      <div class="muted small">Chưa lấy được ngưỡng của tham số này từ máy chủ nên thanh trượt bị khoá — UI không tự bịa ngưỡng.</div>
    </div>`;
  }
  return `<div class="is-slider">
    <div class="is-slider-head">
      <label for="${esc(inputId)}">${esc(label)} <span class="mono muted">(${esc(name)})</span></label>
      <span class="row">
        <span class="badge">ngưỡng ±${esc(lim)}</span>
        <span class="mono" id="is-val-${esc(name)}">${esc(isNumText(value))}</span>
      </span>
    </div>
    <input id="${esc(inputId)}" type="range" min="${esc(-lim)}" max="${esc(lim)}" step="0.01"
      value="${esc(value)}" data-is-param="${esc(name)}" ${state.is?.busy ? 'disabled' : ''} />
  </div>`;
}

/** Form tham số dùng cho cả “TẠO ẢNH” (create) và “TẠO LẠI với tham số khác” (regenerate). */
function renderIsOptions(mode) {
  const o = state.is?.options || {};
  const busy = Boolean(state.is?.busy);
  const running = isJobRunning(state.is?.job?.job);
  const removeBg = o.remove_background !== false;
  const overlayText = String(o.overlay_text ?? '');
  const canCreate = Boolean(state.is?.pending);
  const button = mode === 'regenerate'
    ? `<button class="btn primary" data-action="isgenerate" ${busy || running ? 'disabled' : ''}>${busy ? 'ĐANG GỬI…' : running ? 'ĐANG CHẠY — CHỜ XONG…' : 'TẠO LẠI VỚI THAM SỐ NÀY'}</button>`
    : `<button class="btn primary" data-action="issubmit" ${canCreate && !busy ? '' : 'disabled'}>${busy ? 'ĐANG TẠO…' : 'TẠO ẢNH'}</button>`;
  return `
    <section class="panel" id="is-options">
      <h3 style="margin-top:0">${mode === 'regenerate' ? 'Tạo lại với tham số khác' : '2 · Chọn nền, retouch và chữ overlay'}</h3>
      <p class="muted small" style="margin-top:0">
        Mọi mẫu nền dưới đây do hệ thống tự sinh: <strong>${esc(IS_SYNTHETIC_NOTE)}</strong>.
        Hệ thống không resize / crop / bóp méo sản phẩm.
      </p>
      ${renderIsTemplates()}
      <label class="is-check">
        <input type="checkbox" data-is-bg ${removeBg ? 'checked' : ''} ${busy ? 'disabled' : ''} />
        <span><strong>Tách nền</strong> (<span class="mono">remove_background</span>) — không đủ tự tin thì hệ thống TỪ CHỐI cắt, ảnh chỉ được retouch.</span>
      </label>
      <label class="is-check">
        <input type="checkbox" data-is-ambiguous ${o.matting_allow_ambiguous === true ? 'checked' : ''} ${busy || !removeBg ? 'disabled' : ''} />
        <span><strong>Vẫn ghép nền dù biên nhập nhằng</strong> (<span class="mono">matting_allow_ambiguous</span>) —
          dùng khi ảnh có bóng đổ mềm/viền mờ. Mặc định hệ thống <strong>KHÔNG ghép nền</strong> trong ca này
          (ảnh vẫn được retouch); bật lên thì vẫn ghép nhưng <strong>có ghi vết</strong> và phải tự kiểm ảnh TRƯỚC|SAU.</span>
      </label>
      ${removeBg
        ? ''
        : `<div class="notice warn small" style="margin-top:6px">Bạn đang TẮT tách nền ⇒ <strong>giữ nguyên nền gốc</strong> của ảnh; hệ thống chỉ retouch (và chỉ vẽ chữ overlay nếu hợp lệ).</div>`}
      <div class="is-sliders">${IS_PARAM_ORDER.map((name) => renderIsParam(name)).join('')}</div>
      <div class="is-overlay">
        <label for="is-overlay-text">Chữ overlay (tuỳ chọn)</label>
        <input id="is-overlay-text" type="text" maxlength="500" placeholder="Ví dụ: Bảo hành 12 tháng"
          value="${esc(overlayText)}" data-is-overlay ${busy ? 'disabled' : ''} />
        <p class="muted small" style="margin:6px 0 0">${esc(IS_OVERLAY_CLAIM_NOTE)} Chữ Hán chưa dịch cũng bị chặn.
          Vị trí chữ do máy chủ đặt mặc định (UI chưa có kéo-vẽ vị trí).</p>
      </div>
      <div class="row" style="margin-top:12px">${button}</div>
    </section>`;
}

function renderIsUpload() {
  const lim = state.config?.imagelab?.limits || {};
  const maxMb = Math.round(Number(lim.max_image_bytes || 0) / 1024 / 1024);
  const p = state.is?.pending;
  return `
    <section class="panel">
      <h3 style="margin-top:0">1 · Chọn ảnh sản phẩm (PNG)</h3>
      <div class="drop" id="is-drop" data-action="ispick">
        <div id="is-drop-text">Kéo ảnh PNG vào đây hoặc bấm để chọn</div>
      </div>
      <input id="is-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
      ${p
        ? `<div class="il-picked">
             <img src="${esc(p.dataUrl)}" alt="Ảnh đã chọn" />
             <div>
               <div class="mono small">${esc(p.name)} · ${esc(Math.round(Number(p.bytes || 0) / 1024))}KB · ${esc(p.mime || '')}</div>
               <div class="muted small">Ảnh gốc được lưu thành bản ghi BẤT BIẾN (sha256 giữ nguyên trước/sau).</div>
             </div>
           </div>`
        : ''}
      <p class="muted small" style="margin-top:10px">
        Giới hạn: ${esc(maxMb)}MB · ${esc(lim.max_pixels || 0)} pixel.
        Ảnh ra <strong>cùng kích thước</strong> ảnh gốc — hệ thống không resize / crop / bóp méo sản phẩm.
      </p>
      <div class="row">
        <button class="btn ${p ? 'ghost' : 'primary'}" data-action="ispick">${p ? 'CHỌN ẢNH KHÁC' : 'CHỌN ẢNH PNG'}</button>
        ${p ? '<button class="btn ghost" data-action="isclear">Bỏ ảnh đã chọn</button>' : ''}
      </div>
    </section>`;
}

function renderIsSteps(stage) {
  const idx = IS_STAGE_ORDER.indexOf(String(stage || '').toLowerCase());
  return `<ol class="il-steps">${IS_STAGE_STEPS.map(([key, label]) => {
    const i = IS_STAGE_ORDER.indexOf(key);
    const cls = idx < 0 ? '' : i < idx ? 'done' : i === idx ? 'current' : '';
    return `<li class="${cls}"><span class="il-dot"></span>${esc(label)}</li>`;
  }).join('')}</ol>`;
}

function renderIsJob() {
  const data = state.is?.job || {};
  const job = data.job || {};
  const stage = String(job.stage || 'queued').toLowerCase();
  const status = String(job.status || 'queued').toLowerCase();
  const running = isJobRunning(job);
  const statusCls = status === 'succeeded' ? 'ok' : status === 'failed' ? 'bad' : 'warn';
  const failCode = job.error_code ? ` (${esc(job.error_code)})` : '';
  const stageLabel = IS_STAGE_LABEL[stage] || job.stage || 'Đang xử lý';
  return `
    <section class="panel">
      <div class="spread">
        <div style="min-width:0">
          <h2 style="margin:0 0 4px">Job tạo ảnh <span class="mono small">${esc(String(job.id || '').slice(0, 8))}</span></h2>
          <div class="muted small">Bước: ${esc(stageLabel)}</div>
        </div>
        <div class="row">
          <span class="badge ${statusCls}">${esc(IS_STATUS_LABEL[status] || job.status || 'Đang chờ')}</span>
          <button class="btn ghost tiny" data-action="isrefresh">Kiểm tra lại</button>
          <button class="btn ghost tiny" data-action="isnew">Ảnh khác</button>
        </div>
      </div>
      ${running ? renderIsSteps(stage) : ''}
      ${running
        ? `<div class="status" style="margin-top:10px"><span class="spinner"></span>
             <span>${esc(stageLabel)}… <span class="muted small">(tự cập nhật mỗi 1.5 giây)</span></span></div>`
        : ''}
      ${status === 'failed'
        ? `<div class="notice error"><strong>Job thất bại${failCode}</strong>
             <p style="margin:6px 0 0">${esc(job.error_message || 'Không rõ nguyên nhân.')}</p></div>`
        : ''}
    </section>
    ${data.asset ? renderIsCompare(data) : ''}
    ${data.asset ? renderIsOptions('regenerate') : ''}
    ${renderIsWarnings(data)}`;
}

function renderIsCompare(data) {
  const asset = data?.asset;
  if (!asset) return '';
  const renderedList = Array.isArray(data.rendered) ? data.rendered : [];
  const rendered = renderedList[renderedList.length - 1] || null;
  const matting = data.matting || {};
  const rawTpl = data.compose?.template || rendered?.meta?.template || null;
  const template = typeof rawTpl === 'string'
    ? { id: rawTpl, label: rawTpl, synthetic: rendered?.meta?.synthetic_background === true }
    : rawTpl;
  const synthetic = template?.synthetic === true || rendered?.meta?.synthetic_background === true;
  const mock = matting.is_mock === true || rendered?.meta?.matting?.is_mock === true;
  const sizeMismatch = Boolean(
    asset.width && asset.height && rendered?.width && rendered?.height
      && (Number(asset.width) !== Number(rendered.width) || Number(asset.height) !== Number(rendered.height)),
  );
  const src = (a) => `/api/imagelab/assets/${encodeURIComponent(a.id)}/file`;
  const ext = (mime) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] || 'img');
  return `
    <section class="panel">
      <div class="spread">
        <h2 style="margin:0">Trước / Sau</h2>
        <div class="row">
          ${synthetic ? `<span class="badge warn">${esc(IS_SYNTHETIC_NOTE)}${template?.label ? `: ${esc(template.label)}` : ''}</span>` : ''}
          ${mock ? '<span class="badge warn">MOCK — tách nền giả lập</span>' : ''}
          ${sizeMismatch ? '<span class="badge bad">KÍCH THƯỚC KHÁC ẢNH GỐC</span>' : ''}
          ${rendered ? `<a class="btn tiny primary" href="${esc(src(rendered))}" download="taoanh-${esc(String(rendered.id).slice(0, 8))}.${esc(ext(rendered.mime))}">Tải ảnh về</a>` : ''}
        </div>
      </div>
      <div class="il-compare">
        <figure>
          <img src="${esc(src(asset))}" alt="Ảnh gốc" />
          <figcaption>
            <strong>Ảnh gốc</strong> (bất biến) · ${esc(asset.mime || '')}${asset.width ? ` · ${esc(asset.width)}×${esc(asset.height)}` : ''}<br />
            <span class="mono">sha256 ${esc(String(asset.sha256 || '').slice(0, 16))}…</span>
          </figcaption>
        </figure>
        ${rendered
          ? `<figure>
               <img src="${esc(src(rendered))}" alt="Ảnh tạo mới" />
               <figcaption>
                 <strong>Ảnh tạo mới</strong> (bản ghi mới, parent = ảnh gốc) · ${esc(rendered.mime || '')}${rendered.width ? ` · ${esc(rendered.width)}×${esc(rendered.height)}` : ''}<br />
                 <span class="mono">sha256 ${esc(String(rendered.sha256 || '').slice(0, 16))}…</span>
                 ${template?.label ? `<br />mẫu nền: ${esc(template.label)}${synthetic ? ` — ${esc(IS_SYNTHETIC_NOTE)}` : ''}` : ''}
               </figcaption>
             </figure>`
          : `<figure class="il-empty"><div class="muted small">Chưa có ảnh mới. Job đang chạy hoặc chưa tạo được ảnh — xem cảnh báo bên dưới.</div></figure>`}
      </div>
      ${renderedList.length > 1
        ? `<p class="muted small">Có ${esc(renderedList.length)} bản tạo — đang hiện bản mới nhất; các bản trước vẫn giữ nguyên trong lịch sử.</p>`
        : ''}
    </section>`;
}

/** Cảnh báo THẬT của MVP-03 — không được ẩn bất kỳ cảnh báo nào (§3.7). */
function renderIsWarnings(data) {
  data = data || {};
  const blocks = [];
  const job = data.job || {};
  const matting = data.matting || {};
  const compose = data.compose || {};
  const retouch = data.retouch || {};
  const providers = data.providers || {};
  const renderedList = Array.isArray(data.rendered) ? data.rendered : [];
  const rendered = renderedList[renderedList.length - 1] || null;
  const asset = data.asset || null;
  const requestedOverlay = String(state.is?.options?.overlay_text ?? '').trim();
  // E4 trả `last_run` = LƯỢT CHẠY MỚI NHẤT, kể cả lượt KHÔNG tạo ảnh mới (ví dụ NO_CHANGES).
  // Dữ liệu đó không thuộc về ảnh đang hiện ⇒ trình bày thành khối RIÊNG, không trộn hai lượt.
  const lastRun = data.last_run && typeof data.last_run === 'object' ? data.last_run : null;
  const lastFailures = Array.isArray(lastRun?.failures) ? lastRun.failures : [];
  const failOf = (step) => {
    const hit = lastFailures.find((f) => String(f?.step) === step && f?.code);
    return hit ? String(hit.code) : null;
  };
  const overlay = data.overlay || lastRun?.overlay || {};
  // `meta.template` có thể là object hoặc chuỗi id (E2/E3) — chuẩn hoá để KHÔNG bỏ sót nhãn MÔ PHỎNG.
  const rawTpl = compose.template || rendered?.meta?.template || lastRun?.template || null;
  const template = typeof rawTpl === 'string' ? { id: rawTpl, label: rawTpl } : rawTpl;
  const synthetic = template?.synthetic === true
    || rendered?.meta?.synthetic_background === true
    || data.synthetic_background === true
    || lastRun?.synthetic_background === true;

  // (1) MOCK — theo DẤU VẾT CỦA JOB trước, cấu hình máy chủ hiện tại chỉ là thông tin phụ (luật F-03).
  const jobMock = [];
  if (matting.is_mock === true) jobMock.push('tách nền (matting)');
  if (retouch.is_mock === true) jobMock.push('retouch');
  if (compose.is_mock === true) jobMock.push('ghép nền (compose)');
  if (!jobMock.length && rendered?.meta?.matting?.is_mock === true) jobMock.push('tách nền (matting, theo meta ảnh đã lưu)');
  const currentMock = [['matting', 'tách nền'], ['retouch', 'retouch']]
    .filter(([key]) => providers[key]?.is_mock === true)
    .map(([, label]) => label);
  if (jobMock.length) {
    blocks.push({
      cls: 'warn',
      title: `MOCK — job này đã chạy ${jobMock.join(', ')} bằng dữ liệu giả lập`,
      items: [
        'Dấu vết MOCK đọc từ chính JOB ĐÃ LƯU, không phải từ cấu hình máy chủ đang chạy.',
        'Kết quả không phải tách nền / ghép nền / retouch thật — không dùng để đánh giá chất lượng hoặc đăng bán.',
      ],
    });
  } else if (currentMock.length) {
    blocks.push({
      cls: 'warn',
      title: `MOCK — ${currentMock.join(', ')} đang chạy dữ liệu giả lập (theo cấu hình máy chủ)`,
      items: ['Provider mock tự khai is_mock = true. Kết quả không phải xử lý thật.'],
    });
  }

  // (2) Tách nền fail-closed (§0 luật 3) — nói thẳng, kèm SỐ ĐO THẬT.
  // Nếu ảnh đã tạo không có trace matting (E3 chưa ghi), đọc mã lỗi từ LƯỢT CHẠY MỚI NHẤT.
  const mattingCode = matting.error_code
    || (matting.status && matting.status !== 'OK' ? matting.status : null)
    || failOf('matting');
  if (mattingCode) {
    blocks.push({
      cls: 'warn',
      title: IS_MATTING_FAIL_TEXT[mattingCode]
        || `Không tách được nền (${mattingCode}) — ảnh chỉ được retouch, nền gốc giữ nguyên.`,
      items: [
        ...(matting.error_message ? [String(matting.error_message)] : []),
        ...isMaskItems(matting.mask),
      ],
    });
  }
  for (const w of matting.warnings || []) blocks.push({ cls: 'warn', title: 'Cảnh báo từ bước tách nền', items: [String(w)] });

  // (2a) N3 (vòng 9): SỐ ĐO BIÊN phải HIỆN RA, không chỉ nằm trong câu warnings.
  // N9 (vòng 10): số đo có thể tới từ `GET data.matting.mask`, `rendered[].meta.matting.mask` hoặc
  // `last_run.matting.mask` — đọc CẢ BA để khối này không còn "không bao giờ hiện".
  const maskSrc = matting.mask
    || rendered?.meta?.matting?.mask
    || rendered?.meta?.imagestudio?.matting?.mask
    || lastRun?.matting?.mask
    || null;
  const bd = maskSrc?.boundary_delta || null;
  const mattingMeta = matting && Object.keys(matting).length ? matting : (rendered?.meta?.matting || lastRun?.matting || {});
  if (bd || maskSrc) {
    const items = [];
    if (maskSrc?.kept_bbox_ratio !== undefined && maskSrc?.kept_bbox_ratio !== null) {
      items.push(`Hộp bao phần giữ lại chiếm ${isNumText(Number(maskSrc.kept_bbox_ratio) * 100)}% khung ảnh.`);
    }
    if (bd) {
      items.push(
        `Biên phía NỀN: Δp95 ${isNumText(bd.p95)}/255, tỉ lệ pixel nền sát sản phẩm vượt ngưỡng an toàn: ${isNumText(Number(bd.over_ratio) * 100)}%.`,
      );
      if (bd.kept_under_ratio !== undefined) {
        items.push(
          `Biên phía GIỮ LẠI: Δmin ${isNumText(bd.kept_min)}/255, tỉ lệ pixel giữ lại chỉ khác nền dưới ngưỡng dứt khoát: ${isNumText(Number(bd.kept_under_ratio) * 100)}%.`,
        );
      }
      if (bd.dirty_removed !== undefined) {
        const keptPct = bd.dirty_ratio_kept !== undefined ? ` (${isNumText(Number(bd.dirty_ratio_kept) * 100)}% diện tích vùng giữ lại)` : '';
        items.push(
          `Pixel bị coi là nền nhưng KHÔNG sạch màu nền: ${isNumText(bd.dirty_removed)} px${keptPct} — ` +
            `${isNumText(Number(bd.dirty_removed_ratio ?? 0) * 100)}% khung ảnh; nằm sâu trong hộp bao sản phẩm: ${isNumText(bd.dirty_inside_bbox ?? 0)} px.`,
        );
      }
    }
    if (mattingMeta.boundary_checked === false || maskSrc?.boundary_checked === false) {
      items.push('Provider ngoài (không phải purejs) KHÔNG đo được biên — hãy kiểm ảnh TRƯỚC|SAU.');
    }
    if (mattingMeta.ambiguous_override === true) {
      items.push('⚠️ Lượt này ĐÃ BỎ QUA cảnh báo biên nhập nhằng theo yêu cầu người dùng (có ghi vết trong meta ảnh).');
    }
    if (items.length) blocks.push({ cls: 'muted', title: 'Số đo vùng tách nền (đọc được, không phải kết luận suông)', items });
  }

  // (2b) N5 (vòng 9): BẰNG CHỨNG đã dùng để duyệt chữ overlay — truy vết được nguồn.
  const ev = overlay?.evidence_used || lastRun?.overlay?.evidence_used || rendered?.meta?.overlay?.evidence_used || null;
  if (ev && (Array.isArray(ev.sources) ? ev.sources.length : 0) > 0) {
    const label = { product_name: 'tên sản phẩm (đã lưu)', ocr_region: 'vùng chữ OCR (đã lưu)', user_region: 'vùng chữ do người dùng nhập (đã lưu)', job_notes: 'ghi chú đã lưu trong job' };
    const regions = Array.isArray(ev.region_ids) && ev.region_ids.length ? ` — vùng: ${ev.region_ids.map((r) => `#${r}`).join(', ')}` : '';
    blocks.push({
      cls: 'muted',
      title: 'Bằng chứng dùng để duyệt chữ overlay',
      items: [`Nguồn: ${ev.sources.map((x) => label[x] || x).join('; ')}${regions}. Tổng ${isNumText(ev.chars)} ký tự.`],
    });
  }

  // (2b) M03-01c (vòng 8): CẢNH BÁO NỔI BẬT cho MỌI lượt có tách nền — vùng "sản phẩm" do
  // MÁY ĐOÁN theo màu nền, không phải sự thật đã kiểm. Trước đây UI chỉ hiện khi có lỗi,
  // nên một mask ăn mất sản phẩm vẫn đi kèm lời khẳng định "pixel giữ nguyên từng byte".
  const mattingRan = Boolean(
    matting.status === 'OK'
    || failOf('matting')
    || rendered?.meta?.generator?.matting_status
    || rendered?.meta?.matting
    || lastRun?.matting
    || lastRun?.matting_status,
  );
  if (mattingRan) {
    blocks.push({
      cls: 'warn',
      title: 'Vùng tách nền do MÁY ĐOÁN theo màu nền — hãy kiểm ảnh TRƯỚC|SAU',
      items: [
        'Phần "sản phẩm giữ lại" là kết quả đoán của thuật toán (flood fill từ viền), KHÔNG phải vùng đã được xác nhận.',
        'Hãy mở ảnh TRƯỚC|SAU và soi kỹ: viền sản phẩm, bóng đổ, chi tiết cùng màu nền (đồ trắng trên nền trắng).',
        'Máy chỉ khẳng định được: pixel NGOÀI vùng đã tách giữ nguyên từng byte.',
        ...(isMaskItems(matting.mask).length ? isMaskItems(matting.mask) : []),
      ],
    });
  }

  // (3) Tham số bị KẸP: hiện TÊN + GIÁ TRỊ HIỆU LỰC (không có đường vượt ngưỡng mà im lặng).
  // Nguồn: trace của ảnh đã tạo, nếu chưa có thì lấy của LƯỢT CHẠY MỚI NHẤT (`last_run`).
  const clampedSrc = (Array.isArray(retouch.clamped) && retouch.clamped.length ? retouch.clamped : lastRun?.retouch_clamped) || [];
  const clamped = clampedSrc.map(String);
  const effectiveSrc = retouch.params_effective || lastRun?.retouch_effective || null;
  if (clamped.length) {
    blocks.push({
      cls: 'warn',
      title: `${clamped.length} tham số retouch bị KẸP về ngưỡng cho phép`,
      items: clamped.map((name) => {
        const eff = isEffectiveValue({ params_effective: effectiveSrc }, name);
        const lim = isLimitFor(name);
        return `Tham số ${IS_PARAM_LABEL[name] || name} (${name}) bị kẹp — giá trị hiệu lực: ${eff === null ? 'máy chủ không trả params_effective' : isNumText(eff)}${lim === null ? '' : ` (ngưỡng ±${lim})`}.`;
      }),
    });
  }
  const rejectedSrc = (Array.isArray(retouch.rejected) && retouch.rejected.length ? retouch.rejected : lastRun?.retouch_rejected) || [];
  const rejected = rejectedSrc.map(String);
  if (rejected.length) {
    blocks.push({
      cls: 'warn',
      title: `${rejected.length} tham số retouch bị TỪ CHỐI (không phải số hữu hạn) — coi như không truyền`,
      items: rejected,
    });
  }

  // (4) NO_CHANGES — phải nói rõ “không có gì thay đổi”, không được báo OK.
  const jobNoChanges = String(job.error_code || '').toUpperCase() === 'NO_CHANGES'
    || String(retouch.error_code || '').toUpperCase() === 'NO_CHANGES'
    || String(lastRun?.error_code || '').toUpperCase() === 'NO_CHANGES';
  const retouchNoChange = String(retouch.status || '').toUpperCase() === 'NO_CHANGES';
  if (jobNoChanges) {
    blocks.push({
      cls: 'warn',
      title: 'Không có gì thay đổi — ảnh kết quả giống ảnh gốc',
      items: [
        'Không tách được nền VÀ các tham số retouch đều bằng 0 (hoặc không có hiệu lực) nên hệ thống KHÔNG báo “OK”.',
        'Muốn có ảnh khác: bật/tắt tách nền, chọn mẫu nền khác, hoặc kéo thanh trượt rồi bấm “TẠO LẠI VỚI THAM SỐ NÀY”.',
      ],
    });
  } else if (retouchNoChange) {
    blocks.push({
      cls: 'warn',
      title: 'Retouch: không có gì thay đổi',
      items: ['Các tham số retouch đều bằng 0 nên bước retouch không sửa pixel nào.'],
    });
  }

  // (5) Overlay bị CHẶN vì thiếu bằng chứng — hiện reason + TỪNG vi phạm.
  if (overlay.applied === false) {
    blocks.push({
      cls: 'error',
      title: 'Chữ overlay bị CHẶN — không vẽ lên ảnh',
      items: [
        String(overlay.reason || 'Máy chủ không nêu lý do.'),
        ...(Array.isArray(overlay.violations) ? overlay.violations.map(isViolationText).filter(Boolean) : []),
        ...(Array.isArray(overlay.warnings) ? overlay.warnings.map(String) : []),
      ],
    });
  } else if (overlay.applied === true) {
    blocks.push({
      cls: 'ok',
      title: 'Đã vẽ chữ overlay (có kiểm chống bịa)',
      items: Array.isArray(overlay.warnings) ? overlay.warnings.map(String) : [],
    });
  } else if (requestedOverlay) {
    blocks.push({
      cls: 'warn',
      title: 'Chữ overlay bạn yêu cầu CHƯA được máy chủ xác nhận',
      items: [
        `Bạn đã nhập: “${requestedOverlay}” nhưng máy chủ không trả trường \`applied\` cho overlay (applied = ${String(overlay.applied)}) — UI KHÔNG dám khẳng định là đã vẽ. Hãy kiểm ảnh kết quả.`,
        IS_OVERLAY_CLAIM_NOTE,
      ],
    });
  }

  // (6) Nền MÔ PHỎNG phải được khai ngay tại kết quả (§0 luật 2).
  if (synthetic) {
    blocks.push({
      cls: 'warn',
      title: `Nền của ảnh này là ${IS_SYNTHETIC_NOTE}`,
      items: [
        `Mẫu nền: ${template?.label || template?.id || 'không rõ tên mẫu'}. Nền do hệ thống tự sinh, KHÔNG phải ảnh chụp thật.`,
        'Không quảng cáo ảnh này là ảnh chụp bối cảnh thật.',
      ],
    });
  }
  for (const w of compose.warnings || []) blocks.push({ cls: 'warn', title: 'Cảnh báo từ bước ghép nền', items: [String(w)] });

  // (6b) LƯỢT CHẠY MỚI NHẤT (E4 `last_run`) — kể cả lượt KHÔNG tạo ảnh mới. Trình bày riêng để
  // không trộn số liệu của lượt này với ảnh đang hiển thị (có thể là ảnh của lượt trước).
  const alreadyShown = new Set(
    [
      ...(Array.isArray(matting.warnings) ? matting.warnings : []),
      ...(Array.isArray(compose.warnings) ? compose.warnings : []),
      ...(Array.isArray(retouch.warnings) ? retouch.warnings : []),
      ...(Array.isArray(data.warnings) ? data.warnings : []),
    ].map(String),
  );
  const lastItems = [];
  const lastStageCode = String(lastRun?.error_code || '');
  const lastStatus = String(lastRun?.status || '');
  if (lastStatus) lastItems.push(`Trạng thái lượt chạy mới nhất: ${lastStatus}${lastStageCode ? ` (mã lỗi ${lastStageCode})` : ''}.`);
  else if (lastStageCode) lastItems.push(`Mã lỗi của lượt chạy mới nhất: ${lastStageCode}.`);
  if (lastRun?.error_message) lastItems.push(String(lastRun.error_message));
  for (const f of lastFailures) {
    const step = String(f?.step || '?');
    const code = String(f?.code || '?');
    const plain = IS_MATTING_FAIL_TEXT[code] ? ` ${IS_MATTING_FAIL_TEXT[code]}` : '';
    lastItems.push(`Bước ${step} lỗi: ${code}.${plain}${f?.message ? ` ${String(f.message)}` : ''}`);
  }
  for (const w of Array.isArray(lastRun?.warnings) ? lastRun.warnings : []) {
    const line = String(w);
    // Cảnh báo của lượt chạy có thể trùng với cảnh báo từng bước đã hiện ở khối trên — chỉ
    // bỏ dòng TRÙNG NGUYÊN VĂN, không bỏ bất kỳ cảnh báo nào khác.
    if (!alreadyShown.has(line)) lastItems.push(line);
  }
  if (lastItems.length && lastRun?.rendered_asset_id !== (rendered?.id ?? null)) {
    lastItems.push('Lượt chạy này KHÔNG (hoặc chưa) tạo ra ảnh mới — ảnh đang hiện thuộc lượt trước đó.');
  }
  if (lastRun && (lastItems.length || lastStatus || lastStageCode)) {
    blocks.push({ cls: lastStageCode ? 'warn' : '', title: 'Lượt chạy mới nhất của job', items: lastItems });
  }

  // (7) Cảnh báo chung của API — hiện hết.
  for (const w of data.warnings || []) blocks.push({ cls: 'warn', title: 'Cảnh báo', items: [String(w)] });

  // (8) Lưới an toàn: ảnh ra KHÁC kích thước ảnh gốc = vi phạm luật 1 ⇒ nói thẳng, không giấu.
  if (asset?.width && rendered?.width
    && (Number(asset.width) !== Number(rendered.width) || Number(asset.height) !== Number(rendered.height))) {
    blocks.unshift({
      cls: 'error',
      title: 'ẢNH RA KHÁC KÍCH THƯỚC ẢNH GỐC — vi phạm luật “không bóp méo sản phẩm”',
      items: [
        `Ảnh gốc ${asset.width}×${asset.height} nhưng ảnh tạo ${rendered.width}×${rendered.height}. Báo người điều phối; KHÔNG dùng ảnh này để đăng bán.`,
      ],
    });
  }

  if (!blocks.length) return '';
  return `<section class="panel">
    <h2>Cảnh báo thật từ hệ thống</h2>
    ${blocks
      .map(
        (b) => `<div class="notice ${b.cls}">
          <strong>${esc(b.title)}</strong>
          ${b.items && b.items.length ? `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
        </div>`,
      )
      .join('')}
  </section>`;
}

/** Thân màn “Tạo ảnh” — hàm THUẦN để test trích ra chạy không cần DOM. */
function renderImagestudioBody(exportPanel = '') {
  const cfg = state.config?.imagestudio || {};
  const available = cfg.available !== false;
  const job = state.is?.job;
  return `
    ${isHeaderPanel()}
    ${exportPanel}
    ${available ? (job ? renderIsJob() : renderIsUpload()) : isUnavailablePanel()}
    ${available && !job ? renderIsOptions('create') : ''}
    ${renderIsOverlayBlocked()}
    ${isErrorBox()}
  `;
}

function renderImagestudio() {
  state.view = 'imagestudio';
  stopPolling();
  stopIlPolling();
  // Khối “Gói xuất bản” (§4) chỉ có ở MÀN JOB; vẽ ở đây rồi BƠM xuống (xem `renderImagelab`).
  const exportPanel = state.is?.job
    ? exportPanelHtml(state.is.job.job?.id, state.is.job.job?.status, { kind: state.is.job.job?.kind || 'image_generation' })
    : '';
  // Luật #1: khách ẩn danh vẫn tạo ảnh được — chỉ thêm gợi ý nhẹ ở cuối trang, không chặn gì.
  app.innerHTML = `${renderImagestudioBody(exportPanel)}${authHintHtml()}`;
  const cfg = state.config?.imagestudio || {};
  if (cfg.available !== false && !state.is.templates && !state.is.templatesLoading && !state.is.templatesError) {
    loadImagestudioTemplates();
  }
}

/* ── Nạp mẫu nền + ngưỡng THẬT từ máy chủ ──────────────────────────────────── */

async function loadImagestudioTemplates(force) {
  if (!force && (state.is.templates || state.is.templatesLoading)) return;
  state.is.templatesLoading = true;
  if (force) state.is.templatesError = null;
  try {
    const res = await api('/api/imagestudio/templates');
    state.is.templates = Array.isArray(res?.templates) ? res.templates : [];
    state.is.limits = res?.retouch_limits || state.is.limits || state.config?.imagestudio?.retouch_limits || null;
    state.is.mattingProvider = res?.matting_provider || state.is.mattingProvider || null;
    state.is.templatesError = null;
    ensureIsTemplate();
  } catch (err) {
    // Máy chủ chưa nối module (§3.6 ⇒ 503) — thử dùng khối `imagestudio` của /api/config, KHÔNG bịa mẫu nền.
    const cfg = state.config?.imagestudio;
    if (Array.isArray(cfg?.templates) && cfg.templates.length) state.is.templates = cfg.templates;
    if (cfg?.retouch_limits && !state.is.limits) state.is.limits = cfg.retouch_limits;
    state.is.templatesError = isErrorText(err);
  } finally {
    state.is.templatesLoading = false;
  }
  if (state.view === 'imagestudio') renderImagestudio();
}

/* ── Chọn ảnh + tạo job ────────────────────────────────────────────────────── */

async function pickImagestudioFiles(files) {
  const file = [...(files || [])][0];
  if (!file) return;
  const lim = state.config?.imagelab?.limits || {};
  const allowed = lim.allowed_image_mime || ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) {
    state.is.error = `Định dạng "${file.type || 'không rõ'}" không được phép. Chỉ nhận PNG / JPEG / WebP / GIF.`;
    renderImagestudio();
    return;
  }
  if (lim.max_image_bytes && file.size > lim.max_image_bytes) {
    state.is.error = `Ảnh vượt giới hạn ${Math.round(lim.max_image_bytes / 1024 / 1024)}MB.`;
    renderImagestudio();
    return;
  }
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Không đọc được tệp ảnh.'));
      reader.readAsDataURL(file);
    });
    state.is.pending = {
      name: file.name || 'image',
      bytes: file.size,
      mime: file.type,
      base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      dataUrl,
    };
    state.is.error = null;
  } catch (err) {
    state.is.error = err.message;
  }
  renderImagestudio();
}

async function submitImagestudioJob() {
  const pending = state.is.pending;
  if (!pending || state.is.busy) return;
  state.is.busy = true;
  state.is.error = null;
  state.is.overlayBlocked = null;
  renderImagestudio();
  try {
    const res = await api('/api/imagestudio/jobs', {
      method: 'POST',
      body: { image: { base64: pending.base64, filename: pending.name }, options: isJobOptions() },
    });
    state.is.busy = false;
    state.is.pending = null;
    state.is.jobId = res.job_id;
    state.is.job = null;
    location.hash = `#/taoanh/${res.job_id}`;
    await openImagestudioJob(res.job_id);
  } catch (err) {
    state.is.busy = false;
    const blocked = isOverlayBlockedFromError(err);
    if (blocked) {
      state.is.overlayBlocked = blocked;
      state.is.error = null;
      toast('Chữ overlay bị chặn — xem vi phạm trong khối cảnh báo.');
    } else {
      state.is.error = isErrorText(err);
    }
    renderImagestudio();
  }
}

/** §3.7 — “TẠO LẠI với tham số khác” ⇒ POST /api/imagestudio/jobs/:id/generate. */
async function regenerateImagestudio() {
  const jobId = state.is?.job?.job?.id;
  if (!jobId || state.is.busy) return;
  state.is.busy = true;
  state.is.error = null;
  state.is.overlayBlocked = null;
  renderImagestudio();
  try {
    await api(`/api/imagestudio/jobs/${jobId}/generate`, { method: 'POST', body: { options: isJobOptions() } });
    state.is.busy = false;
    toast('Đang tạo lại ảnh với tham số mới…');
    startIsPolling();
    renderImagestudio();
  } catch (err) {
    state.is.busy = false;
    const blocked = isOverlayBlockedFromError(err);
    if (blocked) {
      state.is.overlayBlocked = blocked;
      toast('Chữ overlay bị chặn — xem vi phạm trong khối cảnh báo.');
    } else {
      state.is.error = isErrorText(err);
    }
    renderImagestudio();
  }
}

/* ── Theo dõi tiến trình (poll theo `stage`) ───────────────────────────────── */

function isReset() {
  stopIsPolling();
  state.is.jobId = null;
  state.is.job = null;
  state.is.pending = null;
  state.is.busy = false;
  state.is.error = null;
  state.is.overlayBlocked = null;
  state.is.providers = null;
  state.is.pollCount = 0;
  state.is.dirtyPaint = false;
}

async function openImagestudioJob(id, { force = false } = {}) {
  if (!id) return;
  if (!force && state.is.jobId === id && state.is.job) {
    renderImagestudio();
    startIsPollIfRunning();
    return;
  }
  if (!force && state.is.loading === id) return;
  state.is.loading = id;
  state.is.jobId = id;
  if (!state.is.job || state.is.job?.job?.id !== id) {
    app.innerHTML = '<section class="panel"><div class="status"><span class="spinner"></span> Đang tải job tạo ảnh…</div></section>';
  }
  try {
    const data = await api(`/api/imagestudio/jobs/${id}`);
    state.is.job = data;
    state.is.error = null;
    state.is.overlayBlocked = null;
    adoptIsMeta(data);
    syncIsOptionsFromJob(data); // tham số của job ⇒ mốc bắt đầu cho “TẠO LẠI với tham số khác”
  } catch (err) {
    state.is.job = null;
    state.is.error = isErrorText(err);
  } finally {
    state.is.loading = null;
  }
  renderImagestudio();
  startIsPollIfRunning();
}

function startIsPollIfRunning() {
  if (isJobRunning(state.is.job?.job)) startIsPolling();
  else stopIsPolling();
}

/** Đang gõ/kéo trong form tham số thì vòng poll KHÔNG vẽ lại (mất focus/thanh trượt nhảy). */
function isOptionsHasFocus() {
  const el = document.activeElement;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.tagName === 'INPUT' && el.type === 'range') return true;
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  return Boolean(el.closest?.('#is-options'));
}

function startIsPolling() {
  stopIsPolling();
  state.is.pollCount = 0;
  state.is.poll = setInterval(async () => {
    // Rời khỏi khu tạo ảnh thì tự dừng, không kéo người dùng về trang cũ.
    if (state.view !== 'imagestudio' || !state.is.jobId) {
      stopIsPolling();
      return;
    }
    state.is.pollCount += 1;
    if (state.is.pollCount > IS_MAX_POLLS) {
      stopIsPolling();
      const stage = String(state.is.job?.job?.stage || '').toLowerCase();
      state.is.error = `Job vẫn ở bước “${IS_STAGE_LABEL[stage] || stage || 'không rõ'}” sau ${IS_MAX_POLLS} lần kiểm tra — có thể job bị kẹt. Bấm “Kiểm tra lại” hoặc xem log máy chủ.`;
      renderImagestudio();
      return;
    }
    try {
      const data = await api(`/api/imagestudio/jobs/${state.is.jobId}`);
      state.is.job = data;
      adoptIsMeta(data);
      if (!isJobRunning(data.job)) stopIsPolling();
      if (isOptionsHasFocus()) state.is.dirtyPaint = true;
      else renderImagestudio();
    } catch (err) {
      stopIsPolling();
      state.is.error = `Mất kết nối khi theo dõi tiến trình: ${err.message}`;
      renderImagestudio();
    }
  }, 1500);
}

function stopIsPolling() {
  if (state.is.poll) clearInterval(state.is.poll);
  state.is.poll = null;
}

/* ── Gắn sự kiện cho khu tạo ảnh (chỉ gắn một lần) ─────────────────────────── */

/** Giữ giá trị người dùng đang chọn trong `state` để render lại KHÔNG mất tham số. */
function isSyncField(target) {
  if (!target || !target.dataset) return;
  const param = target.dataset.isParam;
  if (param) {
    const v = Number(target.value);
    state.is.options.retouch[param] = Number.isFinite(v) ? v : 0;
    const out = document.getElementById(`is-val-${param}`);
    if (out) out.textContent = isNumText(state.is.options.retouch[param]);
    return;
  }
  if (target.dataset.isTemplate !== undefined) {
    state.is.options.template = String(target.value || '');
    renderImagestudio(); // đổi mẫu nền ⇒ vẽ lại để thấy mẫu đang chọn (không mất chữ đang gõ ở ô khác)
    return;
  }
  if (target.dataset.isBg !== undefined) {
    state.is.options.remove_background = Boolean(target.checked);
    renderImagestudio();
    return;
  }
  if (target.dataset.isAmbiguous !== undefined) {
    state.is.options.matting_allow_ambiguous = Boolean(target.checked);
    renderImagestudio();
    return;
  }
  if (target.dataset.isOverlay !== undefined) {
    state.is.options.overlay_text = String(target.value ?? '');
  }
}

function wireImagestudioGlobal() {
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t instanceof HTMLInputElement && t.id === 'is-file') pickImagestudioFiles(t.files);
    isSyncField(t);
  });
  // Trong lúc người dùng đang gõ/kéo trong form tham số, vòng poll hoãn vẽ lại; rời khỏi form thì vẽ bù.
  document.addEventListener('input', (ev) => isSyncField(ev.target));
  document.addEventListener('focusout', (ev) => {
    if (!state.is.dirtyPaint) return;
    if (ev.relatedTarget?.closest?.('#is-options')) return;
    state.is.dirtyPaint = false;
    if (state.view === 'imagestudio') renderImagestudio();
  });
  for (const name of ['dragenter', 'dragover']) {
    document.addEventListener(name, (ev) => {
      if (ev.target.closest?.('#is-drop')) {
        ev.preventDefault();
        $('#is-drop')?.classList.add('hover');
      }
    });
  }
  for (const name of ['dragleave', 'drop']) {
    document.addEventListener(name, (ev) => {
      if (ev.target.closest?.('#is-drop')) {
        ev.preventDefault();
        $('#is-drop')?.classList.remove('hover');
      }
    });
  }
  document.addEventListener('drop', (ev) => {
    if (ev.target.closest?.('#is-drop')) pickImagestudioFiles(ev.dataTransfer?.files);
  });
}

/* ═════════════════════ MVP-04 — Video (videostudio) — tab thứ tư ═════════════════════
 *
 * Hợp đồng §0 (ba luật riêng) + §2.4 (API) + §2.5 (UI). Ba luật được UI NÓI THẲNG, không giấu:
 *   1. KHÔNG bóp méo ảnh — chỉ `pad` (thêm viền) hoặc `crop` (cắt bớt); UI nói RÕ cảnh nào.
 *   2. KHÔNG có tiếng thì phải NÓI RÕ — nhãn “Video KHÔNG có tiếng” nằm NGAY CẠNH kết quả và
 *      CHỈ hiện khi `audio` thật sự là null (audio khác null ⇒ KHÔNG dán nhãn đó).
 *   3. Chữ thiếu bằng chứng ⇒ máy chủ CHẶN (422 `VIDEO_TEXT_UNSUPPORTED_CLAIM`): UI hiện ĐỦ
 *      `violations`, không nuốt, không tự vẽ chữ.
 *
 * Không có `ffmpeg` trên máy này: tệp ra là GIF động (tự chạy trong <img>), KHÔNG kèm âm thanh —
 * UI không bao giờ quảng cáo đây là “video hoàn chỉnh để đăng ngay”.
 *
 * Mọi chữ đi qua `esc()` trước khi vào DOM, kể cả giá trị trong `value=""`.
 * Hàm THUẦN, dễ trích để test (không cần DOM): vsRenderBody, vsHeaderPanel, vsRenderUpload,
 * vsRenderScenes, vsRenderOptions, vsRenderJob, vsRenderResult, vsRenderWarnings, vsRenderSteps,
 * vsAudioNotice, vsTotalHtml, vsJobBody, vsJobOptions, vsSetSceneSeconds, vsMoveScene, vsRemoveScene,
 * vsClampSeconds, vsTotalSeconds, vsCanCreate, vsEncoder, vsAudio, vsTextBlockedFromError, vsErrorText.
 */

const VS_STATUS_LABEL = {
  queued: 'Đang chờ',
  running: 'Đang xử lý',
  succeeded: 'Hoàn tất',
  partial: 'Xong một phần (PARTIAL)',
  failed: 'Thất bại',
};

const VS_STAGE_LABEL = {
  queued: 'Xếp hàng chờ chạy',
  storing: 'Đang lưu ảnh gốc (bất biến)',
  planning: 'Đang lập kế hoạch khung hình',
  rendering: 'Đang render từng khung (chữ Việt + pad/crop)',
  encoding: 'Đang mã hoá GIF',
  done: 'Xong',
  failed: 'Lỗi',
};

const VS_STAGE_ORDER = ['queued', 'storing', 'planning', 'rendering', 'encoding', 'done'];

const VS_STAGE_STEPS = [['storing', 'Lưu ảnh gốc (bất biến)'], ['planning', 'Lập kế hoạch khung hình'], ['rendering', 'Render từng khung (chữ Việt, pad/crop)'], ['encoding', 'Mã hoá GIF'], ['done', 'Hoàn tất']];

/** Nhãn trung thực BẮT BUỘC (§0 luật 2) — chỉ dùng ở khối KẾT QUẢ, chỉ khi `audio === null`. */
const VS_NO_AUDIO_LABEL = 'Video KHÔNG có tiếng';

const VS_NO_AUDIO_NOTE = 'Tệp ra là GIF động nên KHÔNG mang âm thanh. Muốn có tiếng cần dịch vụ TTS/ffmpeg (chưa bật).';

const VS_FIT_NOTE = 'Ảnh gốc chỉ được THÊM VIỀN (pad) hoặc CẮT BỚT (crop) cho vừa khung — KHÔNG kéo giãn, không bóp méo.';

const VS_TEXT_CLAIM_NOTE = 'Chữ có khẳng định/số liệu mà dữ liệu ĐÃ LƯU của job (tên sản phẩm, vùng chữ OCR/bạn nhập, ghi chú) không có bằng chứng sẽ bị CHẶN, không vẽ. Sửa chữ cho khớp thứ ảnh thật có rồi gửi lại.';

/** Lỗi 5xx/4xx bị máy chủ che message ⇒ UI tự dịch mã lỗi sang câu tiếng Việt (như MVP-02/03). */
const VS_ERROR_HINT = {
  VIDEOSTUDIO_UNAVAILABLE: 'Máy chủ chưa nạp được module video. Các tab Nội dung / Dịch ảnh / Tạo ảnh vẫn dùng bình thường.',
  NOT_CONFIGURED: 'Bộ mã hoá video chưa được cấu hình trên máy chủ.',
  FFMPEG_NOT_AVAILABLE: 'Máy chủ không có ffmpeg nên KHÔNG xuất được MP4 — chỉ có GIF động (không tiếng).',
  VIDEO_TEXT_UNSUPPORTED_CLAIM: 'Chữ trên video có khẳng định không có bằng chứng trong dữ liệu job nên bị CHẶN — không vẽ.',
  JOB_ALREADY_RUNNING: 'Job này đang chạy — chờ chạy xong rồi hãy tạo lại.',
  RATE_LIMITED: 'Bạn thao tác quá nhanh — chờ một lát rồi thử lại.',
  BAD_IMAGE: 'Dữ liệu ảnh không hợp lệ (máy chủ kiểm magic bytes).',
  IMAGE_TOO_LARGE: 'Ảnh vượt giới hạn cho phép của máy chủ.',
  UNSUPPORTED_MEDIA_TYPE: 'Ảnh không hợp lệ hoặc định dạng không được phép (chỉ nhận PNG).',
  BAD_BODY: 'Dữ liệu gửi lên không hợp lệ (kiểm tra lại ảnh / số cảnh / thời lượng).',
  BAD_OPTIONS: 'Tham số gửi lên không hợp lệ (preset / scenes / texts / fit).',
  TOO_MANY_SCENES: 'Quá nhiều cảnh trong một lần gửi (máy chủ giới hạn 24) — bỏ bớt ảnh rồi thử lại.',
  TOO_MANY_TEXTS: 'Quá nhiều đoạn chữ trong một lần gửi (máy chủ giới hạn 60) — bớt chữ rồi thử lại.',
  VIDEOSTUDIO_NOT_VIDEO_JOB: 'Job này không phải job tạo video — mở đúng job video trong tab “Video”.',
  VIDEOSTUDIO_NO_ORIGINAL: 'Job này chưa có ảnh gốc — hãy tạo job mới kèm ảnh.',
  JOB_NOT_FOUND: 'Không tìm thấy job video này (có thể thuộc phiên làm việc khác).',
};

/** Số lần poll tối đa trước khi nói thẳng “có thể job bị kẹt” (1.5s × 240 ≈ 6 phút). */
const VS_MAX_POLLS = 240;

/**
 * Trần của MÁY CHỦ cho một request (§2.4): `VIDEOSTUDIO_MAX_SCENES` / `VIDEOSTUDIO_MAX_TEXTS` /
 * `VIDEOSTUDIO_TEXT_MAX` của `src/http/routes.js`. `/api/videostudio/presets` CHƯA trả ba số này
 * nên UI giữ ở MỘT chỗ, chỉ để chặn trước một lần gửi chắc chắn bị 413 — không dùng để cắt bớt
 * dữ liệu người dùng đã nhập mà không nói gì.
 */
const VS_SERVER_MAX_SCENES = 24;
const VS_SERVER_MAX_TEXTS = 60;
const VS_SERVER_TEXT_MAX = 500;

/* ── Đọc preset / tham số (KHÔNG hardcode kích thước — mọi con số lấy từ máy chủ) ─────────── */

/** Preset THẬT: ưu tiên `GET /api/videostudio/presets`, thiếu thì dùng khối `videostudio` của /api/config. */
function vsPresets() {
  const fromApi = Array.isArray(state.vs?.presets) ? state.vs.presets : null;
  const fromCfg = Array.isArray(state.config?.videostudio?.presets) ? state.config.videostudio.presets : [];
  const list = fromApi && fromApi.length ? fromApi : fromCfg;
  return (Array.isArray(list) ? list : []).filter((p) => p && typeof p === 'object' && p.id);
}

function vsPresetById(id) {
  const want = String(id ?? '');
  if (!want) return null;
  return vsPresets().find((p) => String(p.id) === want) || null;
}

/** Preset đang chọn; chưa chọn (hoặc id lạ) ⇒ preset ĐẦU TIÊN của máy chủ. Không có ⇒ null. */
function vsCurrentPreset() {
  return vsPresetById(state.vs?.preset) || vsPresets()[0] || null;
}

/** Trần thời lượng MỘT cảnh (giây) — số của máy chủ; chưa biết ⇒ null (UI không tự bịa trần). */
function vsMaxSeconds() {
  const n = Number(vsCurrentPreset()?.max_seconds);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Giới hạn số cảnh của máy chủ (`limits.max_scenes`) — chưa biết ⇒ null. */
function vsMaxScenes() {
  const n = Number(state.vs?.limits?.max_scenes);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Giới hạn dung lượng ảnh: `limits` của videostudio trước, rồi tới limits của imagelab. */
function vsMaxImageBytes() {
  const a = Number(state.vs?.limits?.max_image_bytes);
  if (Number.isFinite(a) && a > 0) return a;
  const b = Number(state.config?.imagelab?.limits?.max_image_bytes);
  return Number.isFinite(b) && b > 0 ? b : null;
}

/** Chi tiết preset in ra chip chọn tỉ lệ — chỉ in thứ MÁY CHỦ có, không bịa. */
function vsPresetDetail(preset) {
  const parts = [];
  const w = Number(preset?.width);
  const h = Number(preset?.height);
  const fps = Number(preset?.fps);
  if (Number.isFinite(w) && Number.isFinite(h)) parts.push(`${w}×${h} pixel`);
  if (Number.isFinite(fps) && fps > 0) parts.push(`${fps} khung/giây`);
  if (Number.isFinite(Number(preset?.max_seconds)) && Number(preset.max_seconds) > 0) {
    parts.push(`tối đa ${Number(preset.max_seconds)} giây/cảnh`);
  }
  return parts.join(' · ');
}

/** Số gọn cho chữ tiếng Việt: 5 · 2.5 · 0.4 (không làm tròn thành con số khác). */
function vsNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-' ? '0' : s;
}

/** Kẹp thời lượng một cảnh: sàn 1 giây (UI), trần = `max_seconds` CỦA PRESET (nếu máy chủ có). */
function vsClampSeconds(value) {
  const raw = Number(value);
  let s = Number.isFinite(raw) ? raw : 1;
  if (s < 1) s = 1;
  const max = vsMaxSeconds();
  if (max !== null && s > max) s = max;
  return Math.round(s * 10) / 10;
}

function vsSceneSeconds(scene) {
  return vsClampSeconds(scene?.seconds);
}

/** Tổng thời lượng (giây) của các cảnh đang có — con số UI hiện ra và gửi lên máy chủ. */
function vsTotalSeconds() {
  const scenes = Array.isArray(state.vs?.scenes) ? state.vs.scenes : [];
  let sum = 0;
  for (const s of scenes) sum += vsSceneSeconds(s);
  return Math.round(sum * 10) / 10;
}

function vsTotalMs() {
  const ms = Math.round(vsTotalSeconds() * 1000);
  return ms > 0 ? ms : 0;
}

function vsHasImages() {
  const scenes = Array.isArray(state.vs?.scenes) ? state.vs.scenes : [];
  return scenes.some((s) => Boolean(s?.base64));
}

/** Nút TẠO VIDEO chỉ mở khi: có ảnh · có preset THẬT của máy chủ · không đang bận. */
function vsCanCreate() {
  return Boolean(vsHasImages() && vsCurrentPreset() && !state.vs?.busy);
}

/* ── Sửa danh sách cảnh (thứ tự = thứ tự chọn ảnh) ───────────────────────────── */

function vsMoveScene(index, delta) {
  const scenes = Array.isArray(state.vs?.scenes) ? state.vs.scenes : null;
  const i = Number(index);
  const d = Number(delta);
  if (!scenes || !Number.isInteger(i) || !Number.isFinite(d)) return false;
  const j = i + (d < 0 ? -1 : 1);
  if (i < 0 || i >= scenes.length || j < 0 || j >= scenes.length) return false;
  const tmp = scenes[i];
  scenes[i] = scenes[j];
  scenes[j] = tmp;
  return true;
}

function vsRemoveScene(index) {
  const scenes = Array.isArray(state.vs?.scenes) ? state.vs.scenes : null;
  const i = Number(index);
  if (!scenes || !Number.isInteger(i) || i < 0 || i >= scenes.length) return false;
  scenes.splice(i, 1);
  return true;
}

/** Đổi thời lượng một cảnh (đã kẹp theo trần preset) — trả về số giây HIỆU LỰC + cờ bị kẹp. */
function vsSetSceneSeconds(index, value) {
  const scenes = Array.isArray(state.vs?.scenes) ? state.vs.scenes : [];
  const i = Number(index);
  const scene = scenes[i];
  if (!scene) return null;
  const raw = Number(value);
  const seconds = vsClampSeconds(raw);
  scene.seconds = seconds;
  return { seconds, clamped: Number.isFinite(raw) && Math.round(raw * 10) / 10 !== seconds };
}

/* ── Đọc dữ liệu job (audio / encoder / vi phạm chữ) ─────────────────────────── */

function vsOutputAsset(data) {
  const renderedList = Array.isArray(data?.rendered) ? data.rendered : [];
  const last = renderedList[renderedList.length - 1] || null;
  if (last) return last;
  const asset = data?.asset || null;
  if (asset && (asset.role === 'rendered' || String(asset.mime || '') === 'image/gif')) return asset;
  return null;
}

function vsSourceAsset(data) {
  const asset = data?.asset || null;
  const out = vsOutputAsset(data);
  if (!asset) return null;
  if (out && String(out.id) === String(asset.id)) return null;
  return asset;
}

/** `audio` THẬT của job. Không có thông tin ⇒ null (GIF không mang âm thanh) — luật 2. */
function vsAudio(data) {
  data = data || {};
  const out = vsOutputAsset(data);
  const holders = [data, data.job, data.encode, data.last_run, out && out.meta, data.plan];
  for (const h of holders) {
    if (h && typeof h === 'object' && Object.prototype.hasOwnProperty.call(h, 'audio')) return h.audio;
  }
  return null;
}

/** Bộ mã hoá: dấu vết của JOB trước (encode / providers.encoder / meta ảnh), cấu hình máy chủ là phụ. */
function vsEncoder(data) {
  data = data || {};
  const out = vsOutputAsset(data);
  const candidates = [
    ['encode', data.encode],
    ['providers.encoder', data.providers && data.providers.encoder],
    ['rendered.meta.encode', out && out.meta && out.meta.encode],
    ['last_run.encode', data.last_run && data.last_run.encode],
  ].filter(([, v]) => v && typeof v === 'object');
  const current = (state.vs && state.vs.encoder) || state.config?.videostudio?.encoder || null;
  // `encode_summary` của V3 khai `provider` (không phải `name`) — đọc CẢ HAI, không đoán bừa.
  const nameOf = (v) => String(v?.name || v?.provider || '').trim();
  const named = candidates.find(([, v]) => nameOf(v)) || null;
  const source = named ? named[0] : candidates.length ? candidates[0][0] : current ? 'config' : 'none';
  // Luật F-03 (MVP-03): dấu vết của JOB thắng cấu hình máy chủ đang chạy — job khai is_mock
  // thì theo job; job KHÔNG khai gì mới được phép nhìn cấu hình.
  const declared = candidates.filter(([, v]) => typeof v.is_mock === 'boolean');
  const is_mock = declared.length ? declared.some(([, v]) => v.is_mock === true) : current?.is_mock === true;
  const configured = [...candidates.map(([, v]) => v), ...(current ? [current] : [])].every((v) => v?.configured !== false);
  return {
    source,
    fromJob: candidates.length > 0,
    name: (named ? nameOf(named[1]) : '') || [...candidates.map(([, v]) => v), current].map(nameOf).find(Boolean) || 'không rõ',
    is_mock,
    configured,
  };
}

/** 422 `VIDEO_TEXT_UNSUPPORTED_CLAIM`: gom ĐỦ + khử trùng vi phạm (dùng lại bộ đọc của MVP-03). */
function vsErrorViolations(err) {
  return isErrorViolations(err);
}

function vsTextBlockedFromError(err) {
  const violations = vsErrorViolations(err);
  const code = String(err?.code || '');
  if (code !== 'VIDEO_TEXT_UNSUPPORTED_CLAIM' && violations.length === 0) return null;
  return { code: code || 'VIDEO_TEXT_UNSUPPORTED_CLAIM', reason: err?.message || 'Máy chủ không nêu lý do.', violations };
}

function vsErrorText(err) {
  if (typeof err === 'string') return err;
  const code = String(err?.code || '');
  if (code === 'INSUFFICIENT_CREDIT' || err?.status === 402) return creditShortfallText(err);
  const hint = VS_ERROR_HINT[code];
  const server = String(err?.message || (err?.status ? `HTTP ${err.status}` : 'Lỗi không xác định.'));
  if (hint) return `${code}: ${hint}${server && server !== hint ? ` (máy chủ báo: ${server})` : ''}`;
  return `${code ? `${code}: ` : ''}${server}`;
}

/* ── Tham số gửi lên API (§2.4) ──────────────────────────────────────────────── */

/**
 * `options` cho POST /jobs và POST /jobs/:id/generate.
 *
 * Hình dạng gửi lên khớp ĐÚNG `sanitizeVideostudioOptions` của V4 (§2.4):
 *   - `image` (ngoài `options`) = ẢNH ĐẦU TIÊN — V4 chỉ ingest MỘT ảnh cho mỗi job
 *     (`decodeImagelabImage(body.image)`), và V3 dựng cảnh từ chính các ảnh gốc ĐÃ LƯU của job.
 *     Vì vậy KHÔNG nhét base64 của các ảnh sau vào đây: V4 bỏ object lồng trong `scenes[]`
 *     (chỉ giữ chuỗi/số/boolean/mảng ngắn) và body chỉ được nới cho MỘT ảnh ⇒ gửi thừa là 413.
 *   - `options.scenes[]` = metadata NGUYÊN THUỶ từng cảnh (V3 nhận `text`/`subtitle`/`duration_ms`/
 *     `fit`/`filename`; `TEXT_KEYS` của V3 là texts|text|title|subtitle|price|cta).
 *   - `options.texts` = MỌI đoạn chữ sẽ vẽ (tiêu đề + phụ đề, theo thứ tự cảnh). V4 kiểm chống
 *     bịa NGAY trong request bằng danh sách này ⇒ chữ thiếu bằng chứng ra 422 TRƯỚC khi tạo job.
 */
function vsJobOptions() {
  const fit = state.vs?.fit === 'crop' ? 'crop' : 'pad';
  const preset = vsCurrentPreset();
  const scenes = Array.isArray(state.vs?.scenes) ? state.vs.scenes : [];
  const options = { preset: preset ? String(preset.id) : null, fit };
  // Không có cảnh nào trong state (job mở từ lịch sử mà chưa có plan) ⇒ KHÔNG gửi `scenes`
  // rỗng, để máy chủ dùng kế hoạch đã lưu thay vì bị ghi đè bằng danh sách trống.
  if (scenes.length) {
    options.scenes = scenes.slice(0, VS_SERVER_MAX_SCENES).map((s, i) => {
      const scene = {
        index: i,
        text: String(s?.title ?? '').slice(0, VS_SERVER_TEXT_MAX),
        subtitle: String(s?.subtitle ?? '').slice(0, VS_SERVER_TEXT_MAX),
        duration_ms: Math.round(vsSceneSeconds(s) * 1000),
        fit,
        filename: String(s?.name ?? ''),
      };
      if (s?.asset_id) scene.asset_id = String(s.asset_id);
      // §2.5 "nhiều ảnh ⇒ nhiều cảnh": ảnh của TỪNG cảnh phải đi kèm cảnh đó — máy chủ gom
      // `scenes[i].image` theo đúng thứ tự để lưu N ảnh gốc (trước đây UI chỉ gửi ảnh đầu ở
      // `image` ⇒ video luôn chỉ có 1 cảnh dù người dùng chọn nhiều ảnh).
      const base64 = String(s?.base64 ?? '');
      if (base64) scene.image = { base64, filename: String(s?.name ?? '') };
      return scene;
    });
    const texts = vsTextsForServer(scenes);
    if (texts.length) options.texts = texts;
  }
  return options;
}

/** Mọi đoạn chữ người dùng muốn VẼ (tiêu đề + phụ đề, theo thứ tự cảnh) — đã khử trùng. */
function vsTextsForServer(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  const out = [];
  const seen = new Set();
  for (const s of list) {
    for (const raw of [s?.title, s?.subtitle]) {
      const text = String(raw ?? '').trim().slice(0, VS_SERVER_TEXT_MAX);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
      if (out.length >= VS_SERVER_MAX_TEXTS) return out;
    }
  }
  return out;
}

/**
 * Máy chủ có nhận NHIỀU ảnh cho một job không?
 *
 * VÒNG GỘP (07/10/2026): ĐÃ BẬT — `POST /api/videostudio/jobs` nhận `image` (ảnh đầu, tương thích
 * ngược) **và** `options.scenes[i].image` cho từng cảnh; máy chủ gom theo thứ tự, khử trùng theo
 * sha256, dựng ĐÚNG số cảnh = số ảnh nhận được (§2.5 "nhiều ảnh ⇒ nhiều cảnh"). Trần số cảnh lấy
 * từ `GET /api/videostudio/presets → limits.max_scenes` (không hardcode).
 */
function vsServerSupportsManyImages() {
  return true;
}

/** Cảnh nào sẽ KHÔNG được gửi lên máy chủ — nay chỉ còn cảnh KHÔNG có ảnh trong trình duyệt. */
function vsUnsentSceneIndexes(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  if (vsServerSupportsManyImages()) return list.map((_, i) => i).filter((i) => !list[i]?.base64);
  return list.map((_, i) => i).filter((i) => i > 0);
}

function vsMultiImageNotice(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  const unsent = vsUnsentSceneIndexes(list);
  if (!unsent.length) return '';
  return `<div class="notice warn" id="vs-multi-image">
    <strong>${esc(unsent.length)} cảnh KHÔNG có ảnh trong trình duyệt nên sẽ không được gửi lên.</strong>
    <p style="margin:6px 0 0">Mỗi cảnh cần một ảnh: kéo-thả ảnh vào cảnh đó (hoặc xoá cảnh trống). Máy chủ dựng ĐÚNG số cảnh
      bằng số ảnh nhận được — cảnh không có ảnh sẽ bị bỏ qua, hệ thống báo thẳng nếu kế hoạch ít cảnh hơn số bạn chọn.</p>
  </div>`;
}


/**
 * Thân POST /api/videostudio/jobs.
 *
 * `image` = ẢNH ĐẦU (khoá đóng băng §2.4, giữ để tương thích ngược) và mọi cảnh gửi kèm ảnh
 * riêng trong `options.scenes[i].image` — máy chủ gom theo thứ tự, khử trùng theo sha256, và
 * dựng ĐÚNG số cảnh bằng số ảnh nhận được (§2.5).
 */
function vsJobBody() {
  const scenes = Array.isArray(state.vs?.scenes) ? state.vs.scenes : [];
  const first = scenes.find((s) => s?.base64) || scenes[0] || null;
  return {
    image: first && first.base64 ? { base64: String(first.base64 ?? ''), filename: String(first.name ?? '') } : null,
    options: vsJobOptions(),
  };
}

/* ── Khối render (thuần, không đụng DOM) ─────────────────────────────────────── */

function vsProviderBadges() {
  const enc = vsEncoder(state.vs?.job);
  const cls = enc.configured ? (enc.is_mock ? 'warn' : 'ok') : 'bad';
  const mock = enc.is_mock ? ' · MOCK' : '';
  const notReady = enc.configured ? '' : ' · chưa cấu hình';
  const where = enc.fromJob ? 'theo job đã lưu' : 'theo cấu hình máy chủ';
  return `<span class="badge ${cls}" title="${esc(`Bộ mã hoá: ${enc.name} (${where})`)}">Mã hoá: ${esc(enc.name)}${mock}${notReady}</span>
    <span class="badge">Tệp ra: GIF động · audio = ${vsAudio(state.vs?.job) === null ? 'null' : 'có'}</span>`;
}

function vsMockNotice() {
  const enc = vsEncoder(state.vs?.job);
  if (!enc.is_mock) return '';
  return `<div class="notice warn">
    <strong>MOCK — bộ mã hoá video đang chạy bằng dữ liệu giả lập (${esc(enc.name)}).</strong>
    <p style="margin:6px 0 0">Kết quả KHÔNG phải video thật (${esc(enc.fromJob ? 'theo dấu vết của job đã lưu' : 'theo cấu hình máy chủ đang chạy')}). Không dùng để đánh giá chất lượng hoặc đăng bán.</p>
  </div>`;
}

/** Nói THẬT khi chưa lấy được preset — không bịa tỉ lệ, không hardcode kích thước. */
function vsPresetsNotice() {
  if (vsPresets().length) return '';
  const err = state.vs?.presetsError;
  return `<div class="notice warn" id="vs-presets-error">
    <strong>Chưa lấy được danh sách tỉ lệ từ máy chủ (GET /api/videostudio/presets).</strong>
    <p style="margin:6px 0 0">${err ? esc(err) : 'Đang tải…'}</p>
    <p style="margin:6px 0 0">UI KHÔNG tự bịa kích thước khung — chưa có preset thì chưa tạo được video.</p>
    <button class="btn tiny" data-action="vsreload" type="button" style="margin-top:8px">THỬ LẤY LẠI TỈ LỆ</button>
  </div>`;
}

function vsHeaderPanel() {
  const cfg = state.config?.videostudio || {};
  const available = cfg.available !== false;
  const preset = vsCurrentPreset();
  return `<section class="panel">
    <div class="spread">
      <div style="min-width:0">
        <h2 style="margin:0 0 4px">Video bán hàng ngắn từ ảnh thật</h2>
        <p class="muted small" style="margin:0">
          Ghép 1 hoặc nhiều ảnh thành <strong>GIF động</strong> có nhịp theo thời lượng từng cảnh, có chữ Việt.
          ${esc(VS_FIT_NOTE)} Ảnh gốc <strong>không bị sửa</strong> (bản ghi bất biến).
        </p>
        <p class="muted small" style="margin:6px 0 0">
          Tệp ra là GIF động — <strong>không kèm âm thanh</strong>${cfg.audio === false ? ' (máy chủ khai audio = false)' : ''}.
          Đây KHÔNG phải video MP4 hoàn chỉnh để đăng ngay: hãy tự kiểm từng khung trước khi dùng.
        </p>
      </div>
      <span class="badge ${available ? 'ok' : 'bad'}">${available ? 'Sẵn sàng' : 'Chưa khả dụng'}</span>
    </div>
    <div class="row" style="margin-top:10px">${vsProviderBadges()}</div>
    ${preset ? `<div class="muted small" style="margin-top:8px">Tỉ lệ đang chọn (số của MÁY CHỦ): <strong>${esc(preset.label || preset.id)}</strong>${vsPresetDetail(preset) ? ` — ${esc(vsPresetDetail(preset))}` : ''}</div>` : ''}
    ${vsMockNotice()}
  </section>`;
}

function vsUnavailablePanel() {
  const cfg = state.config?.videostudio || {};
  const reason = cfg.reason || state.vs?.presetsError || null;
  return `<section class="panel"><div class="notice error"><strong>Tính năng video chưa sẵn sàng trên máy chủ này (VIDEOSTUDIO_UNAVAILABLE).</strong>
    <p style="margin:6px 0 0">Lý do máy chủ báo: ${esc(reason || 'không nêu lý do — xem log máy chủ (videostudio.wiring_failed).')}</p>
    <p style="margin:6px 0 0">Các tab Nội dung / Dịch ảnh / Tạo ảnh vẫn dùng bình thường.</p></div></section>`;
}

function vsErrorBox() {
  const err = state.vs?.error;
  if (!err) return '';
  // 402 có băng báo RIÊNG của MVP-05 (số cần / số có + link nạp) — hiện đúng khối đó.
  if (err && typeof err === 'object' && (err.code === 'INSUFFICIENT_CREDIT' || err.status === 402)) {
    return creditShortfallHtml(err);
  }
  return `<div class="notice error" id="vs-error">${esc(vsErrorText(err))}</div>`;
}

/** 422 khi tạo/tạo lại: hiện ĐÚNG reason + TỪNG vi phạm (đã khử trùng), không nuốt. */
function vsTextBlockedPanel() {
  const b = state.vs?.textBlocked;
  if (!b) return '';
  const violations = Array.isArray(b.violations) ? b.violations : [];
  return `<div class="notice error" id="vs-text-blocked">
    <strong>Chữ trên video bị CHẶN — không vẽ (${esc(b.code || 'VIDEO_TEXT_UNSUPPORTED_CLAIM')})</strong>
    <p style="margin:6px 0 0">${esc(b.reason || 'Máy chủ không nêu lý do.')}</p>
    ${violations.length ? `<ul>${violations.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>` : ''}
    <p class="muted small" style="margin:6px 0 0">${esc(VS_TEXT_CLAIM_NOTE)}</p>
  </div>`;
}

function vsFileErrorsHtml() {
  const list = Array.isArray(state.vs?.fileErrors) ? state.vs.fileErrors : [];
  if (!list.length) return '';
  return `<div class="notice warn" id="vs-file-errors"><strong>${esc(list.length)} tệp KHÔNG được nhận:</strong>
    <ul>${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
}

/** Bước 1 — chọn ảnh (nhiều ảnh = nhiều cảnh, thứ tự = thứ tự chọn). */
function vsRenderUpload() {
  const scenes = Array.isArray(state.vs?.scenes) ? state.vs.scenes : [];
  const maxBytes = vsMaxImageBytes();
  const maxMb = maxBytes ? Math.round(maxBytes / 1024 / 1024) : null;
  const maxScenes = vsMaxScenes();
  const busy = Boolean(state.vs?.busy || state.vs?.pendingFiles);
  return `<section class="panel">
    <h3 style="margin-top:0">1 · Chọn ảnh PNG cho các cảnh</h3>
    <div class="drop" id="vs-drop" data-action="vspick">
      <div id="vs-drop-text">Kéo 1 hoặc nhiều ảnh PNG vào đây — hoặc bấm để chọn.<br />
        <span class="muted small">Thứ tự ảnh = thứ tự cảnh (giữ đúng thứ tự bạn chọn).</span></div>
    </div>
    <input id="vs-file" type="file" accept="image/png" multiple hidden />
    <p class="muted small" style="margin-top:10px">
      Màn này nhận <strong>PNG</strong>${maxMb ? ` · tối đa ${esc(maxMb)}MB/ảnh` : ''} · gửi tối đa ${esc(maxScenes ? Math.min(maxScenes, VS_SERVER_MAX_SCENES) : VS_SERVER_MAX_SCENES)} cảnh mỗi lần.
      Máy chủ còn kiểm magic bytes lần nữa. Ảnh gốc được lưu thành bản ghi BẤT BIẾN (sha256 giữ nguyên trước/sau).
      ${vsServerSupportsManyImages() ? '' : 'API hiện nhận <strong>1 ảnh cho mỗi job</strong> — chọn nhiều ảnh vẫn giữ đủ danh sách cảnh, nhưng chỉ ảnh đầu tiên vào video (UI sẽ báo thẳng).'}
    </p>
    ${vsFileErrorsHtml()}
    <div class="row">
      <button class="btn ${scenes.length ? 'ghost' : 'primary'}" data-action="vspick" type="button" ${busy ? 'disabled' : ''}>${scenes.length ? 'THÊM ẢNH' : 'CHỌN ẢNH PNG'}</button>
      ${scenes.length ? `<button class="btn ghost" data-action="vsclear" type="button" ${busy ? 'disabled' : ''}>Xoá hết ảnh</button>` : ''}
      ${state.vs?.pendingFiles ? '<span class="status"><span class="spinner"></span> Đang đọc ảnh…</span>' : ''}
    </div>
  </section>`;
}

function vsTotalHtml() {
  const scenes = Array.isArray(state.vs?.scenes) ? state.vs.scenes : [];
  const total = vsTotalSeconds();
  const max = vsMaxSeconds();
  const preset = vsCurrentPreset();
  const over = max !== null && total > max;
  return `<div class="vs-total" id="vs-total">
    <strong>Tổng thời lượng: ${esc(vsNum(total))} giây</strong>
    <span class="muted small">· ${esc(scenes.length)} cảnh${preset ? ` · ${esc(preset.label || preset.id)}${max !== null ? ` (trần ${esc(max)} giây/cảnh)` : ''}` : ''}</span>
    ${over ? `<div class="notice warn small" style="margin:8px 0 0">Tổng ${esc(vsNum(total))} giây VƯỢT trần ${esc(max)} giây của preset ⇒ máy chủ sẽ CẮT bớt phần vượt và ghi cảnh báo (video không bao giờ dài quá trần).</div>` : ''}
  </div>`;
}

/** Bước 2 — danh sách cảnh: thứ tự, chữ tiêu đề/phụ đề, thời lượng (kẹp theo trần preset). */
function vsRenderScenes() {
  const scenes = Array.isArray(state.vs?.scenes) ? state.vs.scenes : [];
  const busy = Boolean(state.vs?.busy);
  const max = vsMaxSeconds();
  const fromPlan = scenes.length > 0 && scenes.every((s) => !s?.dataUrl);
  // Cảnh KHÔNG gửi được lên máy chủ (API hiện nhận 1 ảnh/job) — dán nhãn ngay tại dòng đó.
  const unsent = fromPlan ? [] : vsUnsentSceneIndexes(scenes);
  const rows = scenes.map((s, i) => {
    const seconds = vsSceneSeconds(s);
    const note = Math.round(Number(s?.seconds) * 10) / 10 !== seconds ? ` <span class="muted small">(đã kẹp về ${esc(vsNum(seconds))} giây)</span>` : '';
    return `<li class="vs-scene" data-index="${esc(i)}">
      <span class="vs-scene-no">Cảnh ${esc(i + 1)}</span>
      ${s?.dataUrl
        ? `<img class="vs-thumb" src="${esc(s.dataUrl)}" alt="${esc(s.name || 'ảnh cảnh')}" />`
        : `<span class="vs-thumb vs-thumb-empty" title="Ảnh gốc nằm trên máy chủ, trình duyệt không giữ lại">ảnh gốc<br />trên máy chủ</span>`}
      <div class="vs-scene-body">
        <div class="mono small">${esc(s?.name || '(không rõ tên tệp)')}${Number.isFinite(Number(s?.bytes)) && Number(s.bytes) > 0 ? ` · ${esc(Math.round(Number(s.bytes) / 1024))}KB` : ''}
          ${unsent.includes(i) ? '<span class="badge warn" title="Cảnh này không có ảnh trong trình duyệt nên không gửi lên được">chưa gửi được</span>' : ''}
          ${s?.missingText ? '<span class="badge warn" title="Plan đã lưu chỉ giữ số đoạn chữ, không giữ nội dung — nhập lại chữ nếu muốn giữ chữ">chữ cũ không đọc lại được</span>' : ''}</div>
        <label class="vs-field"><span>Chữ (tiêu đề)</span>
          <input type="text" maxlength="120" value="${esc(s?.title ?? '')}" data-vs-scene="title" data-index="${esc(i)}"
            placeholder="Ví dụ: Áo thun cotton" ${busy ? 'disabled' : ''} /></label>
        <label class="vs-field"><span>Phụ đề (tuỳ chọn)</span>
          <input type="text" maxlength="200" value="${esc(s?.subtitle ?? '')}" data-vs-scene="subtitle" data-index="${esc(i)}"
            placeholder="Ví dụ: 99.000đ" ${busy ? 'disabled' : ''} /></label>
        <label class="vs-field vs-field-sec"><span>Thời lượng (giây)</span>
          <input type="number" min="1" ${max !== null ? `max="${esc(max)}"` : ''} step="0.5" value="${esc(vsNum(seconds))}"
            data-vs-scene="seconds" data-index="${esc(i)}" ${busy ? 'disabled' : ''} />
          <span class="muted small">tối đa ${max !== null ? `${esc(max)} giây/cảnh` : 'chưa rõ (máy chủ chưa trả preset)'}</span>${note}</label>
      </div>
      <div class="vs-scene-actions">
        <button class="btn ghost tiny" data-action="vsmove" data-index="${esc(i)}" data-dir="-1" type="button"
          title="Đưa cảnh này lên" ${i === 0 || busy ? 'disabled' : ''}>↑</button>
        <button class="btn ghost tiny" data-action="vsmove" data-index="${esc(i)}" data-dir="1" type="button"
          title="Đưa cảnh này xuống" ${i === scenes.length - 1 || busy ? 'disabled' : ''}>↓</button>
        <button class="btn ghost tiny" data-action="vsremove" data-index="${esc(i)}" type="button"
          title="Xoá cảnh này" ${busy ? 'disabled' : ''}>✕</button>
      </div>
    </li>`;
  }).join('');
  return `<section class="panel">
    <h3 style="margin-top:0">2 · Cảnh, chữ và thời lượng</h3>
    ${vsMultiImageNotice(fromPlan ? [] : scenes)}
    ${scenes.length
      ? `<ol class="vs-scenes">${rows}</ol>
         ${fromPlan ? `<p class="muted small">Danh sách cảnh đọc từ PLAN đã lưu của job — trình duyệt không giữ ảnh gốc, sửa chữ/thời lượng rồi bấm TẠO LẠI.${scenes.some((s) => s?.missingText) ? ' Plan đã lưu <strong>không chứa nội dung chữ</strong> (chỉ có số đoạn chữ) nên ô chữ đang TRỐNG — nhập lại nếu muốn video mới có chữ.' : ''}</p>` : ''}`
      : `<p class="muted small">Chưa có ảnh nào. Chọn ảnh PNG ở bước 1 — mỗi ảnh là một cảnh, đúng thứ tự bạn chọn.</p>`}
    ${vsTotalHtml()}
  </section>`;
}

/** Bước 3 — tỉ lệ (từ presets của máy chủ) + fit + nút tạo/tạo lại. */
function vsRenderOptions(mode) {
  const list = vsPresets();
  const chosen = vsCurrentPreset();
  const chosenId = chosen ? String(chosen.id) : '';
  const fit = state.vs?.fit === 'crop' ? 'crop' : 'pad';
  const busy = Boolean(state.vs?.busy);
  const running = vsJobRunning(state.vs?.job?.job);
  const canCreate = vsCanCreate();
  const createBtn = mode === 'regenerate'
    ? `<button class="btn primary" data-action="vsregen" type="button" ${busy || running ? 'disabled' : ''}>${busy ? 'ĐANG GỬI…' : running ? 'ĐANG CHẠY — CHỜ XONG…' : 'TẠO LẠI'}</button>
       <button class="btn ghost" data-action="vsregenforce" type="button" ${busy || running ? 'disabled' : ''}
         title="Chạy lại dù máy chủ cho rằng chưa có gì đổi (force = true)">TẠO LẠI (force)</button>`
    : `<button class="btn primary" data-action="vscreate" type="button" ${canCreate ? '' : 'disabled'}>${busy ? 'ĐANG TẠO…' : 'TẠO VIDEO'}</button>`;
  const chips = list.map((p) => {
    const id = String(p.id);
    const detail = vsPresetDetail(p);
    return `<label class="vs-preset${chosenId === id ? ' active' : ''}">
      <input type="radio" name="vs-preset" value="${esc(id)}" data-vs-preset ${chosenId === id ? 'checked' : ''} ${busy ? 'disabled' : ''} />
      <span class="vs-preset-label">${esc(p.label || id)}</span>
      ${detail ? `<span class="mono muted small">${esc(detail)}</span>` : ''}
    </label>`;
  }).join('');
  return `<section class="panel" id="vs-options">
    <h3 style="margin-top:0">3 · Tỉ lệ khung và cách vừa khung</h3>
    ${list.length
      ? `<div class="vs-presets">${chips}</div>`
      : vsPresetsNotice()}
    <div class="vs-fit">
      <label class="vs-check">
        <input type="radio" name="vs-fit" value="pad" data-vs-fit ${fit === 'pad' ? 'checked' : ''} ${busy ? 'disabled' : ''} />
        <span><strong>PAD — thêm viền</strong> cho vừa khung; giữ nguyên toàn bộ ảnh, <strong>không</strong> kéo giãn.</span>
      </label>
      <label class="vs-check">
        <input type="radio" name="vs-fit" value="crop" data-vs-fit ${fit === 'crop' ? 'checked' : ''} ${busy ? 'disabled' : ''} />
        <span><strong>CROP — cắt bớt</strong> phần thừa cho vừa khung; <strong>không</strong> kéo giãn (một phần ảnh sẽ bị mất).</span>
      </label>
      <p class="muted small" style="margin:6px 0 0">${esc(VS_FIT_NOTE)}</p>
    </div>
    <div class="row" style="margin-top:12px">
      ${createBtn}
      ${mode === 'regenerate' ? '<span class="muted small">Lượt chạy mới dùng chữ/thời lượng/fit ở trên; ảnh gốc vẫn bất biến.</span>' : ''}
    </div>
  </section>`;
}

function vsRenderSteps(stage) {
  const idx = VS_STAGE_ORDER.indexOf(String(stage || '').toLowerCase());
  return `<ol class="il-steps">${VS_STAGE_STEPS.map(([key, label]) => {
    const i = VS_STAGE_ORDER.indexOf(key);
    const cls = idx < 0 ? '' : i < idx ? 'done' : i === idx ? 'current' : '';
    return `<li class="${cls}"><span class="il-dot"></span>${esc(label)}</li>`;
  }).join('')}</ol>`;
}

function vsStageText(stage) {
  const key = String(stage || 'queued').toLowerCase();
  const label = VS_STAGE_LABEL[key] || `Bước lạ: ${stage}`;
  const idx = VS_STAGE_ORDER.indexOf(key);
  return idx < 0 ? label : `Bước ${idx + 1}/${VS_STAGE_ORDER.length} · ${label}`;
}

/** Nhãn TRUNG THỰC về tiếng (§0 luật 2): chỉ dán “Video KHÔNG có tiếng” khi audio THẬT SỰ là null. */
function vsAudioNotice(data) {
  const audio = vsAudio(data);
  if (audio === null || audio === undefined) {
    return `<div class="notice warn" id="vs-no-audio">
      <strong>${esc(VS_NO_AUDIO_LABEL)}</strong>
      <p style="margin:6px 0 0">${esc(VS_NO_AUDIO_NOTE)}</p>
    </div>`;
  }
  const desc = typeof audio === 'object' ? (audio.format || audio.codec || audio.mime || JSON.stringify(audio)) : String(audio);
  return `<div class="notice ok" id="vs-audio">
    <strong>Có tiếng:</strong> ${esc(desc)}.
    <p style="margin:6px 0 0">Vẫn phải tự kiểm âm thanh trước khi dùng.</p>
  </div>`;
}

/** Kết quả: xem trước GIF (tự chạy) + nút tải + nhãn KHÔNG có tiếng NGAY CẠNH. */
function vsRenderResult(data) {
  data = data || {};
  const out = vsOutputAsset(data);
  const src = vsSourceAsset(data);
  const encode = data.encode && typeof data.encode === 'object' ? data.encode : {};
  const plan = data.plan && typeof data.plan === 'object' ? data.plan : null;
  const enc = vsEncoder(data);
  const assetSrc = (a) => `/api/videostudio/assets/${encodeURIComponent(String(a.id))}/file`;
  const extOf = (mime) => ({ 'image/gif': 'gif', 'video/mp4': 'mp4', 'image/png': 'png' }[String(mime || '')] || 'gif');
  const facts = [];
  if (out) {
    facts.push(`Định dạng: ${esc(out.mime || encode.mime || 'không rõ')}${out.width ? ` · ${esc(out.width)}×${esc(out.height)} pixel` : ''}`);
    if (Number.isFinite(Number(encode.frames))) facts.push(`${esc(encode.frames)} khung`);
    if (Number.isFinite(Number(plan?.duration_ms))) facts.push(`dài ${esc(vsNum(Number(plan.duration_ms) / 1000))} giây`);
    if (Number.isFinite(Number(out.bytes ?? encode.bytes))) facts.push(`${esc(Math.round(Number(out.bytes ?? encode.bytes) / 1024))}KB`);
    if (Number.isFinite(Number(encode.palette_size))) facts.push(`bảng màu ${esc(encode.palette_size)} màu`);
  }
  return `<section class="panel">
    <div class="spread">
      <h2 style="margin:0">Kết quả video</h2>
      <div class="row">
        ${enc.is_mock ? '<span class="badge warn" title="Bộ mã hoá tự khai is_mock = true">MOCK</span>' : ''}
        ${out ? `<a class="btn tiny primary" href="${esc(assetSrc(out))}" download="video-${esc(String(out.id).slice(0, 8))}.${esc(extOf(out.mime || encode.mime))}">Tải video (GIF) về</a>` : ''}
        ${out ? `<a class="btn tiny ghost" href="${esc(assetSrc(out))}" target="_blank" rel="noopener">Mở tệp trong tab mới</a>` : ''}
      </div>
    </div>
    ${out
      ? `<div class="vs-result">
           <img src="${esc(assetSrc(out))}" alt="Video GIF kết quả (tự chạy)" />
           <div class="vs-result-facts">
             <div>${facts.join(' · ')}</div>
             <div class="mono small">asset ${esc(String(out.id))}</div>
             ${src ? `<div class="muted small">Ảnh gốc của job (bất biến): <img class="vs-thumb-inline" src="${esc(assetSrc(src))}" alt="Ảnh gốc" /></div>` : ''}
           </div>
         </div>`
      : `<div class="notice warn" style="margin-top:10px">Chưa có tệp kết quả. Job đang chạy hoặc lượt chạy chưa tạo được GIF — xem cảnh báo bên dưới.</div>`}
    ${vsAudioNotice(data)}
  </section>`;
}

/**
 * Ghi chú về `fit` (luật 1): ưu tiên SỰ THẬT trong `plan.scenes[].fit` của máy chủ; chưa có plan
 * thì nói rõ là theo lựa chọn của người dùng, KHÔNG dám khẳng định.
 */
function vsFitNotes(data) {
  data = data || {};
  const plan = (data.plan && typeof data.plan === 'object' ? data.plan : null) || (data.last_run?.plan ?? null);
  const planScenes = Array.isArray(plan?.scenes) ? plan.scenes : null;
  const local = Array.isArray(state.vs?.scenes) ? state.vs.scenes : [];
  const preset = vsCurrentPreset();
  const frame = preset && Number.isFinite(Number(preset.width)) ? `${Number(preset.width)}×${Number(preset.height)}` : null;
  if (!planScenes || !planScenes.length) {
    if (!local.length) return [];
    const fit = state.vs?.fit === 'crop' ? 'crop' : 'pad';
    return [`Bạn chọn “${fit}” cho ${local.length} cảnh nhưng máy chủ CHƯA trả về plan — UI không dám khẳng định từng cảnh đã đúng; hãy tự mở GIF kiểm tra.`];
  }
  const groups = { pad: [], crop: [] };
  planScenes.forEach((s, i) => {
    const mode = String(s?.fit || '').toLowerCase();
    if (mode !== 'pad' && mode !== 'crop') return;
    // `plan_summary` KHÔNG giữ tên tệp ⇒ lùi về tên cảnh UI đang giữ, rồi tới asset_id (vẫn
    // chỉ ĐÚNG cảnh đó, không đoán cảnh khác).
    const name = s?.filename || s?.source_filename || local[i]?.name || (s?.asset_id ? `asset ${String(s.asset_id).slice(0, 8)}…` : null);
    const size = s?.source && Number.isFinite(Number(s.source.width)) ? `${Number(s.source.width)}×${Number(s.source.height)}` : null;
    groups[mode].push(`Cảnh ${i + 1}${name ? ` (${name})` : ''}${size ? ` — ảnh gốc ${size}` : ''}`);
  });
  const items = [];
  if (groups.crop.length) items.push(`${groups.crop.join(', ')}: bị CẮT BỚT (crop) cho vừa khung${frame ? ` ${frame}` : ''} — phần thừa đã mất, KHÔNG kéo giãn.`);
  if (groups.pad.length) items.push(`${groups.pad.join(', ')}: được THÊM VIỀN (pad) cho vừa khung${frame ? ` ${frame}` : ''} — ảnh gốc giữ nguyên tỉ lệ, KHÔNG kéo giãn.`);
  return items;
}

/** Thời lượng bị CẮT do vượt trần (luật: không bao giờ vượt trần, phải ghi cảnh báo). */
function vsDurationNotes(data) {
  data = data || {};
  const plan = (data.plan && typeof data.plan === 'object' ? data.plan : null) || (data.last_run?.plan ?? null);
  const planMs = Number(plan?.duration_ms);
  const reqMs = vsTotalMs();
  const max = vsMaxSeconds();
  const local = Array.isArray(state.vs?.scenes) ? state.vs.scenes : [];
  const planScenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  const items = [];
  // Thời lượng ngắn hơn yêu cầu có HAI nguyên nhân khác hẳn nhau: (1) vượt trần preset ⇒ cắt,
  // (2) máy chủ bỏ bớt cảnh (ví dụ chỉ nhận 1 ảnh/job) ⇒ số cảnh khớp mới được phép quy cho trần.
  const sameSceneCount = local.length > 0 && planScenes.length === local.length;
  if (Number.isFinite(planMs) && reqMs > 0 && planMs < reqMs && sameSceneCount) {
    items.push(`Bạn yêu cầu ${vsNum(reqMs / 1000)} giây nhưng máy chủ chỉ chạy ${vsNum(planMs / 1000)} giây — phần vượt trần${max !== null ? ` ${max} giây/cảnh` : ''} đã bị CẮT (video không bao giờ dài quá trần).`);
  } else if (Number.isFinite(planMs) && planMs > 0) {
    items.push(`Tổng thời lượng máy chủ chạy: ${vsNum(planMs / 1000)} giây (${vsNum(plan?.frame_count)} khung${Number.isFinite(Number(plan?.fps)) ? ` @ ${vsNum(plan.fps)} khung/giây` : ''}).`);
  }
  return items;
}

/** Số cảnh gửi lên vs số cảnh máy chủ lập kế hoạch — lệch thì NÓI THẲNG (có ảnh bị bỏ). */
function vsSceneCountNote(data) {
  const plan = (data?.plan && typeof data.plan === 'object' ? data.plan : null) || (data?.last_run?.plan ?? null);
  const planScenes = Array.isArray(plan?.scenes) ? plan.scenes : null;
  const local = Array.isArray(state.vs?.scenes) ? state.vs.scenes : [];
  if (!planScenes || !local.length) return [];
  if (planScenes.length === local.length) return [];
  return [`Bạn gửi ${local.length} cảnh nhưng kế hoạch của máy chủ có ${planScenes.length} cảnh — có cảnh KHÔNG được dùng. Kiểm tra lại danh sách cảnh rồi tạo lại.`];
}

/** Mọi cảnh báo THẬT (§2.5) — không giấu cảnh báo nào; chỉ bỏ dòng TRÙNG NGUYÊN VĂN. */
function vsRenderWarnings(data) {
  data = data || {};
  const audio = vsAudio(data);
  const enc = vsEncoder(data);
  const plan = data.plan && typeof data.plan === 'object' ? data.plan : null;
  const lastRun = data.last_run && typeof data.last_run === 'object' ? data.last_run : null;
  const renderedList = Array.isArray(data.rendered) ? data.rendered : [];
  const out = vsOutputAsset(data);
  const seen = new Set();
  const warnLines = [];
  const addWarn = (value) => {
    const line = String(value ?? '').trim();
    if (!line) return;
    // Nhãn “không có tiếng” đã hiện NGAY CẠNH kết quả ⇒ không in lại y hệt lần hai.
    if (audio === null && (line === VS_NO_AUDIO_LABEL || line === VS_NO_AUDIO_NOTE)) return;
    if (seen.has(line)) return;
    seen.add(line);
    warnLines.push(line);
  };
  for (const w of Array.isArray(data.warnings) ? data.warnings : []) addWarn(w);
  for (const w of Array.isArray(plan?.warnings) ? plan.warnings : []) addWarn(w);
  for (const w of Array.isArray(data.encode?.warnings) ? data.encode.warnings : []) addWarn(w);
  for (const w of Array.isArray(lastRun?.warnings) ? lastRun.warnings : []) addWarn(w);

  const blocks = [];
  if (enc.is_mock) {
    blocks.push({
      cls: 'warn',
      title: `MOCK — bộ mã hoá video đang chạy dữ liệu giả lập (${enc.name})`,
      items: [
        `Dấu vết MOCK đọc từ ${enc.fromJob ? 'chính job đã lưu' : 'cấu hình máy chủ đang chạy'}; provider tự khai is_mock = true.`,
        'Kết quả KHÔNG phải video thật — không dùng để đánh giá chất lượng hoặc đăng bán.',
      ],
    });
  }
  const fitItems = vsFitNotes(data);
  if (fitItems.length) blocks.push({ cls: 'warn', title: 'Ảnh bị pad/crop cho vừa khung (không kéo giãn)', items: fitItems });
  const durItems = vsDurationNotes(data);
  if (durItems.length) blocks.push({ cls: 'muted', title: 'Thời lượng thật của video', items: durItems });
  const countItems = vsSceneCountNote(data);
  if (countItems.length) blocks.push({ cls: 'error', title: 'Số cảnh KHÔNG khớp', items: countItems });

  const blocked = plan?.texts_blocked || data.texts_blocked || null;
  if (blocked) {
    const violations = Array.isArray(blocked.violations) ? blocked.violations.map(isViolationText).filter(Boolean) : [];
    blocks.push({
      cls: 'error',
      title: 'Chữ trên video bị CHẶN — không vẽ',
      items: [String(blocked.reason || VS_ERROR_HINT.VIDEO_TEXT_UNSUPPORTED_CLAIM), ...violations],
    });
  }
  // Mã hoá lỗi (ví dụ thiếu ffmpeg khi xuất MP4) — đọc thẳng `encode.error_code` của lượt đã lưu.
  const encode = data.encode && typeof data.encode === 'object' ? data.encode : {};
  if (encode.error_code) {
    blocks.push({
      cls: 'error',
      title: `Mã hoá video LỖI (${String(encode.error_code)})`,
      items: [vsErrorText({ code: encode.error_code, message: encode.error_message })],
    });
  }
  if (warnLines.length) blocks.push({ cls: 'warn', title: 'Cảnh báo thật từ máy chủ', items: warnLines });

  const lastItems = [];
  if (lastRun && String(lastRun.status || '') && String(lastRun.rendered_asset_id ?? '') !== String(out?.id ?? '')) {
    lastItems.push(`Lượt chạy mới nhất: ${String(lastRun.status)}${lastRun.error_code ? ` (mã lỗi ${String(lastRun.error_code)})` : ''} — lượt này KHÔNG (hoặc chưa) tạo ra GIF đang hiện.`);
  }
  if (lastRun?.error_message) lastItems.push(String(lastRun.error_message));
  if (lastItems.length) blocks.push({ cls: 'warn', title: 'Lượt chạy mới nhất của job', items: lastItems });
  if (lastRun?.error_code && !warnLines.length) {
    blocks.push({ cls: 'warn', title: `Lỗi của lượt chạy mới nhất: ${String(lastRun.error_code)}`, items: [vsErrorText({ code: lastRun.error_code, message: lastRun.error_message })] });
  }

  if (!blocks.length) return '';
  return `<section class="panel">
    <h2>Cảnh báo thật từ hệ thống</h2>
    ${blocks
      .map(
        (b) => `<div class="notice ${b.cls}">
          <strong>${esc(b.title)}</strong>
          ${b.items && b.items.length ? `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
        </div>`,
      )
      .join('')}
  </section>`;
}

function vsRenderJob() {
  const data = state.vs?.job || {};
  const job = data.job || {};
  const stage = String(job.stage || 'queued').toLowerCase();
  const status = String(job.status || 'queued').toLowerCase();
  const running = vsJobRunning(job);
  const statusCls = status === 'succeeded' ? 'ok' : status === 'failed' ? 'bad' : 'warn';
  const failCode = job.error_code ? ` (${esc(job.error_code)})` : '';
  return `
    <section class="panel">
      <div class="spread">
        <div style="min-width:0">
          <h2 style="margin:0 0 4px">Job video <span class="mono small">${esc(String(job.id || '').slice(0, 8))}</span></h2>
          <div class="muted small">Bước: ${esc(vsStageText(stage))} <span class="mono">(${esc(stage)})</span></div>
        </div>
        <div class="row">
          <span class="badge ${statusCls}">${esc(VS_STATUS_LABEL[status] || job.status || 'Đang chờ')}</span>
          <button class="btn ghost tiny" data-action="vsrefresh" type="button">Kiểm tra lại</button>
          <button class="btn ghost tiny" data-action="vsnew" type="button">Video khác</button>
        </div>
      </div>
      ${running ? vsRenderSteps(stage) : ''}
      ${running
        ? `<div class="status" style="margin-top:10px"><span class="spinner"></span>
             <span>${esc(VS_STAGE_LABEL[stage] || stage || 'Đang xử lý')}… <span class="muted small">(tự cập nhật mỗi 1.5 giây — không có tiếng ở mọi bước)</span></span></div>`
        : ''}
      ${status === 'failed'
        ? `<div class="notice error"><strong>Job thất bại${failCode}</strong>
             <p style="margin:6px 0 0">${esc(job.error_message || 'Máy chủ không nêu nguyên nhân.')}</p>
             ${VS_ERROR_HINT[String(job.error_code || '')] ? `<p style="margin:6px 0 0">${esc(VS_ERROR_HINT[String(job.error_code || '')])}</p>` : ''}</div>`
        : ''}
    </section>
    ${vsRenderResult(data)}
    ${vsRenderWarnings(data)}
    ${vsRenderScenes()}
    ${vsRenderOptions('regenerate')}`;
}

/** Thân màn “Video” — hàm THUẦN để test trích ra chạy không cần DOM. */
function vsRenderBody(exportPanel = '') {
  const cfg = state.config?.videostudio || {};
  const available = cfg.available !== false;
  if (!available) return `${vsHeaderPanel()}${vsUnavailablePanel()}${vsErrorBox()}`;
  const job = state.vs?.job;
  return `${vsHeaderPanel()}
    ${exportPanel}
    ${job ? vsRenderJob() : `${vsRenderUpload()}${vsRenderScenes()}${vsRenderOptions('create')}`}
    ${vsTextBlockedPanel()}
    ${vsErrorBox()}`;
}

/* ── Vẽ màn hình (có DOM) ────────────────────────────────────────────────────── */

function vsRenderPage() {
  state.view = 'video';
  stopPolling();
  stopIlPolling();
  stopIsPolling();
  // Khối “Gói xuất bản” (§4) chỉ có ở MÀN JOB; vẽ ở đây rồi BƠM xuống (xem `renderImagelab`).
  const exportPanel = state.vs?.job
    ? exportPanelHtml(state.vs.job.job?.id, state.vs.job.job?.status, { kind: state.vs.job.job?.kind || 'video_generation' })
    : '';
  app.innerHTML = `${vsRenderBody(exportPanel)}${authHintHtml()}`;
  const cfg = state.config?.videostudio || {};
  if (cfg.available !== false && !vsPresets().length && !state.vs.presetsLoading && !state.vs.presetsError) {
    loadVideoPresets(false);
  }
}

/* ── Nạp preset THẬT từ máy chủ ──────────────────────────────────────────────── */

/** Giữ preset đang chọn hợp lệ; chưa chọn ⇒ preset đầu tiên (không hardcode id nào). */
function ensureVsPreset() {
  const list = vsPresets();
  if (!list.length) return;
  if (vsPresetById(state.vs.preset)) return;
  state.vs.preset = String(list[0].id);
}

async function loadVideoPresets(force) {
  if (!force && (vsPresets().length || state.vs.presetsLoading)) return;
  state.vs.presetsLoading = true;
  if (force) state.vs.presetsError = null;
  try {
    const res = await api('/api/videostudio/presets');
    state.vs.presets = Array.isArray(res?.presets) ? res.presets : [];
    state.vs.encoder = res?.encoder || state.vs.encoder || null;
    state.vs.limits = res?.limits || state.vs.limits || null;
    state.vs.presetsError = null;
    ensureVsPreset();
  } catch (err) {
    // Máy chủ chưa nối module (§2.4 ⇒ 503/404) — dùng khối `videostudio` của /api/config, KHÔNG bịa tỉ lệ.
    const cfg = state.config?.videostudio || {};
    if (Array.isArray(cfg.presets) && cfg.presets.length) {
      state.vs.presets = cfg.presets;
      state.vs.encoder = cfg.encoder || state.vs.encoder || null;
      ensureVsPreset();
    }
    state.vs.presetsError = vsErrorText(err);
  } finally {
    state.vs.presetsLoading = false;
  }
  if (state.view === 'video') vsRenderPage();
}

/** GET job cũng trả `presets` + `providers` (§2.4) — dùng luôn, khỏi phụ thuộc một lần gọi. */
function vsAdoptMeta(data) {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data.presets) && data.presets.length) {
    state.vs.presets = data.presets;
    ensureVsPreset();
  }
  if (data.providers?.encoder) state.vs.encoder = data.providers.encoder;
  else if (data.encode && typeof data.encode === 'object' && data.encode.name) state.vs.encoder = data.encode;
  if (data.limits && typeof data.limits === 'object') state.vs.limits = data.limits;
}

/** Mở job đã có: dựng lại danh sách cảnh từ PLAN (không có ảnh) để “TẠO LẠI” bắt đầu từ đó. */
function vsSyncScenesFromJob(data) {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(state.vs.scenes) && state.vs.scenes.length) return;
  const plan = (data.plan && typeof data.plan === 'object' ? data.plan : null) || (data.last_run?.plan ?? null);
  const planScenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  if (!planScenes.length) return;
  state.vs.scenes = planScenes.map((s) => {
    // `plan_summary` của V3 CHỈ giữ `text_count` (không giữ nội dung chữ) ⇒ chữ đã vẽ KHÔNG đọc
    // lại được: UI nói thẳng điều đó và để người dùng nhập lại, KHÔNG bịa lại chữ cũ.
    const items = Array.isArray(s?.texts) ? s.texts : null;
    const title = items && items.length ? String(items[0]?.text ?? '') : '';
    const subtitle = items && items.length > 1 ? String(items[1]?.text ?? '') : '';
    const count = Number(s?.text_count);
    const assetName = s?.asset_id ? `asset ${String(s.asset_id).slice(0, 8)}…` : '';
    return {
      name: String(s?.filename || s?.source_filename || assetName || ''),
      bytes: 0,
      mime: 'image/png',
      base64: '',
      dataUrl: '',
      title,
      subtitle,
      seconds: Math.round((Number(s?.duration_ms) || 0) / 100) / 10 || 1,
      asset_id: s?.asset_id ? String(s.asset_id) : undefined,
      missingText: !items && Number.isFinite(count) && count > 0,
    };
  });
  if (plan?.preset_id && vsPresetById(plan.preset_id)) state.vs.preset = String(plan.preset_id);
  const firstFit = String(planScenes[0]?.fit || '').toLowerCase();
  if (firstFit === 'crop' || firstFit === 'pad') state.vs.fit = firstFit;
}

/* ── Chọn ảnh + tạo job ──────────────────────────────────────────────────────── */

async function pickVideoFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  const maxBytes = vsMaxImageBytes();
  const maxScenes = vsMaxScenes();
  const scenes = Array.isArray(state.vs.scenes) ? state.vs.scenes : (state.vs.scenes = []);
  const errors = [];
  const accepted = [];
  for (const file of list) {
    const name = String(file?.name || 'tệp không tên');
    const mime = String(file?.type || '');
    if (mime && mime !== 'image/png') {
      errors.push(`${name}: định dạng “${mime}” — màn này chỉ nhận PNG.`);
      continue;
    }
    if (maxBytes && Number(file?.size) > maxBytes) {
      errors.push(`${name}: ${Math.round(Number(file.size) / 1024 / 1024)}MB vượt giới hạn ${Math.round(maxBytes / 1024 / 1024)}MB.`);
      continue;
    }
    if (maxScenes !== null && scenes.length + accepted.length >= maxScenes) {
      errors.push(`${name}: đã đủ ${maxScenes} cảnh (giới hạn của máy chủ).`);
      continue;
    }
    accepted.push(file);
  }
  state.vs.pendingFiles = true;
  state.vs.fileErrors = errors;
  vsRenderPage();
  const read = await Promise.all(
    accepted.map(async (file) => {
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('Không đọc được tệp ảnh.'));
          reader.readAsDataURL(file);
        });
        return { ok: true, scene: {
          name: String(file.name || 'image.png'),
          bytes: Number(file.size) || 0,
          mime: String(file.type || 'image/png'),
          base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
          dataUrl,
          title: '',
          subtitle: '',
          seconds: vsClampSeconds(2),
        } };
      } catch (err) {
        return { ok: false, name: String(file?.name || 'tệp không tên'), message: String(err?.message || 'lỗi đọc tệp') };
      }
    }),
  );
  state.vs.pendingFiles = false;
  for (const item of read) {
    if (item.ok) scenes.push(item.scene);
    else errors.push(`${item.name}: ${item.message}`);
  }
  state.vs.fileErrors = errors;
  state.vs.error = null;
  vsRenderPage();
}

async function submitVideoJob() {
  if (!vsCanCreate()) {
    if (!vsHasImages()) state.vs.error = 'Hãy chọn ít nhất một ảnh PNG trước khi tạo video.';
    else if (!vsCurrentPreset()) state.vs.error = 'Chưa có tỉ lệ khung từ máy chủ — chưa tạo được video.';
    vsRenderPage();
    return;
  }
  state.vs.busy = true;
  state.vs.error = null;
  state.vs.textBlocked = null;
  vsRenderPage();
  try {
    const res = await api('/api/videostudio/jobs', { method: 'POST', body: vsJobBody() });
    state.vs.busy = false;
    state.vs.jobId = res?.job_id || null;
    state.vs.job = null;
    if (state.vs.jobId) {
      location.hash = `#/video/${state.vs.jobId}`;
      await openVideoJob(state.vs.jobId);
    } else {
      state.vs.error = 'Máy chủ nhận job nhưng không trả `job_id` — không theo dõi được tiến trình.';
      vsRenderPage();
    }
  } catch (err) {
    state.vs.busy = false;
    const blocked = vsTextBlockedFromError(err);
    if (blocked) {
      state.vs.textBlocked = blocked;
      state.vs.error = null;
      toast('Chữ trên video bị chặn — xem vi phạm trong khối cảnh báo.');
    } else {
      state.vs.error = err;
    }
    vsRenderPage();
  }
}

/** §2.4 — “TẠO LẠI” ⇒ POST /api/videostudio/jobs/:id/generate (mỗi lượt có run_key riêng). */
async function regenerateVideo(force) {
  const jobId = state.vs?.jobId || state.vs?.job?.job?.id;
  if (!jobId || state.vs.busy) return;
  state.vs.busy = true;
  state.vs.error = null;
  state.vs.textBlocked = null;
  vsRenderPage();
  try {
    await api(`/api/videostudio/jobs/${encodeURIComponent(String(jobId))}/generate`, {
      method: 'POST',
      body: { options: vsJobOptions(), force: Boolean(force) },
    });
    state.vs.busy = false;
    toast(force ? 'Đang tạo lại (force)…' : 'Đang tạo lại video với tham số này…');
    startVsPolling();
    vsRenderPage();
  } catch (err) {
    state.vs.busy = false;
    const blocked = vsTextBlockedFromError(err);
    if (blocked) {
      state.vs.textBlocked = blocked;
      toast('Chữ trên video bị chặn — xem vi phạm trong khối cảnh báo.');
    } else {
      state.vs.error = err;
    }
    vsRenderPage();
  }
}

/* ── Theo dõi tiến trình (poll theo `stage`) ─────────────────────────────────── */

function vsReset() {
  stopVsPolling();
  state.vs.jobId = null;
  state.vs.job = null;
  state.vs.busy = false;
  state.vs.error = null;
  state.vs.textBlocked = null;
  state.vs.scenes = [];
  state.vs.fileErrors = [];
  state.vs.pendingFiles = false;
  state.vs.pollCount = 0;
}

async function openVideoJob(id, { force = false } = {}) {
  if (!id) return;
  if (!force && state.vs.jobId === id && state.vs.job) {
    vsRenderPage();
    startVsPollIfRunning();
    return;
  }
  if (!force && state.vs.loading === id) return;
  state.vs.loading = id;
  state.vs.jobId = id;
  if (!state.vs.job || state.vs.job?.job?.id !== id) {
    app.innerHTML = '<section class="panel"><div class="status"><span class="spinner"></span> Đang tải job video…</div></section>';
  }
  try {
    const data = await api(`/api/videostudio/jobs/${encodeURIComponent(String(id))}`);
    state.vs.job = data;
    state.vs.error = null;
    state.vs.textBlocked = null;
    vsAdoptMeta(data);
    vsSyncScenesFromJob(data);
  } catch (err) {
    state.vs.job = null;
    state.vs.error = err;
  } finally {
    state.vs.loading = null;
  }
  vsRenderPage();
  startVsPollIfRunning();
}

function startVsPollIfRunning() {
  if (vsJobRunning(state.vs.job?.job)) startVsPolling();
  else stopVsPolling();
}

/** Đang gõ trong form cảnh thì vòng poll KHÔNG vẽ lại (mất focus/chữ đang gõ). */
function vsFormHasFocus() {
  const el = document.activeElement;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  return Boolean(el.closest?.('#vs-options') || el.dataset?.vsScene !== undefined || el.dataset?.vsPreset !== undefined || el.dataset?.vsFit !== undefined);
}

function vsJobRunning(job) {
  if (!job || typeof job !== 'object') return false;
  const stage = String(job.stage || '').toLowerCase();
  const status = String(job.status || '').toLowerCase();
  if (stage === 'done' || stage === 'failed') return false;
  if (status === 'succeeded' || status === 'failed' || status === 'partial') return false;
  return true;
}

function startVsPolling() {
  stopVsPolling();
  state.vs.pollCount = 0;
  state.vs.poll = setInterval(async () => {
    // Rời khỏi tab Video thì tự dừng, không kéo người dùng về trang cũ.
    if (state.view !== 'video' || !state.vs.jobId) {
      stopVsPolling();
      return;
    }
    state.vs.pollCount += 1;
    if (state.vs.pollCount > VS_MAX_POLLS) {
      stopVsPolling();
      const stage = String(state.vs.job?.job?.stage || '').toLowerCase();
      state.vs.error = `Job vẫn ở bước “${VS_STAGE_LABEL[stage] || stage || 'không rõ'}” sau ${VS_MAX_POLLS} lần kiểm tra — có thể job bị kẹt. Bấm “Kiểm tra lại” hoặc xem log máy chủ.`;
      vsRenderPage();
      return;
    }
    try {
      const data = await api(`/api/videostudio/jobs/${encodeURIComponent(String(state.vs.jobId))}`);
      state.vs.job = data;
      vsAdoptMeta(data);
      if (!vsJobRunning(data?.job)) stopVsPolling();
      if (vsFormHasFocus()) state.vs.dirtyPaint = true;
      else vsRenderPage();
    } catch (err) {
      stopVsPolling();
      state.vs.error = `Mất kết nối khi theo dõi tiến trình: ${vsErrorText(err)}`;
      vsRenderPage();
    }
  }, 1500);
}

function stopVsPolling() {
  if (state.vs?.poll) clearInterval(state.vs.poll);
  if (state.vs) state.vs.poll = null;
}

/* ── Gắn sự kiện cho tab Video (chỉ gắn một lần) ─────────────────────────────── */

/** Giữ giá trị người dùng đang gõ trong `state` để render lại KHÔNG mất chữ. */
function vsSyncField(target) {
  if (!target || !target.dataset) return;
  const key = target.dataset.vsScene;
  if (key !== undefined) {
    const index = Number.parseInt(target.dataset.index ?? '', 10);
    const scene = (Array.isArray(state.vs?.scenes) ? state.vs.scenes : [])[index];
    if (!scene) return;
    if (key === 'seconds') {
      const res = vsSetSceneSeconds(index, target.value);
      const out = document.getElementById('vs-total');
      if (out && res) out.innerHTML = vsTotalHtml(); // nội dung đều đã qua esc()
      return;
    }
    if (key === 'title') scene.title = String(target.value ?? '');
    if (key === 'subtitle') scene.subtitle = String(target.value ?? '');
    return;
  }
  if (target.dataset.vsPreset !== undefined) {
    state.vs.preset = String(target.value || '');
    ensureVsPreset();
    vsRenderPage();
    return;
  }
  if (target.dataset.vsFit !== undefined) {
    state.vs.fit = target.value === 'crop' ? 'crop' : 'pad';
    vsRenderPage();
  }
}

function wireVideostudioGlobal() {
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t instanceof HTMLInputElement && t.id === 'vs-file') pickVideoFiles(t.files);
    vsSyncField(t);
  });
  document.addEventListener('input', (ev) => vsSyncField(ev.target));
  document.addEventListener('focusout', (ev) => {
    if (!state.vs?.dirtyPaint) return;
    if (ev.relatedTarget?.closest?.('#vs-options') || ev.relatedTarget?.dataset?.vsScene !== undefined) return;
    state.vs.dirtyPaint = false;
    if (state.view === 'video') vsRenderPage();
  });
  for (const name of ['dragenter', 'dragover']) {
    document.addEventListener(name, (ev) => {
      if (ev.target.closest?.('#vs-drop')) {
        ev.preventDefault();
        $('#vs-drop')?.classList.add('hover');
      }
    });
  }
  for (const name of ['dragleave', 'drop']) {
    document.addEventListener(name, (ev) => {
      if (ev.target.closest?.('#vs-drop')) {
        ev.preventDefault();
        $('#vs-drop')?.classList.remove('hover');
      }
    });
  }
  document.addEventListener('drop', (ev) => {
    if (ev.target.closest?.('#vs-drop')) pickVideoFiles(ev.dataTransfer?.files);
  });
}

/* ═════════════════════ GÓI XUẤT BẢN (.zip) — hợp đồng §4 ═════════════════════
 *
 * Một nút ở CẢ BỐN màn job (MVP-01 nội dung / MVP-02 dịch ảnh / MVP-03 tạo ảnh / MVP-04 video)
 * tải `GET /api/exports/jobs/:id/bundle` bằng thẻ `<a download>` — KHÔNG nhồi base64 vào `state`.
 * Kèm nút phụ “Xem bản kê khai” gọi `GET /api/exports/jobs/:id/manifest` và in NGUYÊN VĂN (đã
 * `esc()`) thứ máy chủ khai: nhãn kiểm chứng, `mock_steps`, `missing`, `warnings` — không tô hồng.
 *
 * Trước khi tải, UI hỏi `/manifest` MỘT lần để BẮT ĐƯỢC lỗi thật (404 khác chủ/không tồn tại,
 * 400 id rác, 503 EXPORT_UNAVAILABLE) rồi mới bấm tải: thẻ `<a download>` thuần sẽ nuốt lỗi.
 */

const EXPORT_BUTTON_LABEL = 'TẢI GÓI XUẤT BẢN (.zip)';
const EXPORT_MANIFEST_LABEL = 'Xem bản kê khai';
const EXPORT_HONEST_LINE = 'Gói gồm nội dung + ảnh + video đã tạo; các bước dùng dữ liệu giả được ghi rõ trong MANIFEST.json.';
const EXPORT_RUNNING_LINE = 'Job chưa xong — gói tải về có thể thiếu phần đang chạy.';
const EXPORT_NO_ID_LINE = 'Job này không có mã định danh nên nút tải gói bị khoá — mở lại job từ Lịch sử rồi thử lại.';
const EXPORT_UNCONFIGURED_LINE = 'Máy chủ khai tính năng gói xuất bản chưa khả dụng (EXPORT_UNAVAILABLE)';
const EXPORT_NOT_MANIFEST_LINE = 'Máy chủ trả về dữ liệu KHÔNG phải bản kê khai (thiếu `manifest`) — chưa dám tải gói .zip vì có thể chỉ là trang HTML. Kiểm tra lại sau hoặc báo quản trị.';
const EXPORT_FALLBACK_LINE = 'Vẫn thử tải trực tiếp tệp .zip';

const EXPORT_ERROR_HINT = {
  EXPORT_UNAVAILABLE: 'Máy chủ chưa nạp được module gói xuất bản — phần nội dung/ảnh/video của job vẫn xem bình thường.',
  JOB_NOT_FOUND: 'Không tìm thấy job này: có thể job thuộc phiên hoặc tài khoản khác, hoặc đã bị xoá.',
  BAD_JOB_ID: 'Mã job không hợp lệ nên máy chủ từ chối.',
  // R6: trần kích thước gói và cổng giới hạn số lượt dựng gói đồng thời — nói đúng loại lỗi,
  // không gộp vào câu "thử lại" chung (thử lại y hệt vẫn vượt trần / vẫn bận).
  BUNDLE_TOO_LARGE: 'Gói vượt trần kích thước máy chủ cho phép nên bị từ chối dựng. Bớt ảnh/video của job rồi thử lại, hoặc nhờ quản trị nâng `EXPORT_MAX_BUNDLE_BYTES`.',
  EXPORT_BUSY: 'Máy chủ đang dựng một gói xuất bản khác (mỗi lúc chỉ dựng vài gói để không hết bộ nhớ) — chờ vài giây rồi bấm lại.',
};

function exportBundleUrl(jobId) {
  return `/api/exports/jobs/${encodeURIComponent(String(jobId ?? ''))}/bundle`;
}

function exportManifestUrl(jobId) {
  return `/api/exports/jobs/${encodeURIComponent(String(jobId ?? ''))}/manifest`;
}

/** Câu nói THẬT khi không tải được gói — theo mã + HTTP status máy chủ trả, không đoán bừa. */
function exportErrorText(err) {
  const code = String(err?.code || '').trim();
  const status = Number(err?.status || 0);
  const rawMsg = String(err?.payload?.message || err?.message || '').trim();
  // `api()` đặt message = `HTTP <status>` khi body không phải JSON ⇒ đừng lặp lại vô nghĩa.
  const real = rawMsg && rawMsg !== `HTTP ${status}` ? rawMsg : '';
  const server = real ? ` Máy chủ báo: “${real}”` : '';
  const hint = EXPORT_ERROR_HINT[code] || '';
  if (code === 'EXPORT_BAD_MANIFEST') return EXPORT_NOT_MANIFEST_LINE;
  // R6: 413 kèm SỐ ĐO thật trong `details` (bytes/limit) — in số ra, không nói chung chung.
  if (code === 'BUNDLE_TOO_LARGE' || status === 413) {
    const details = err?.payload?.details || {};
    const bytes = Number(details.bytes);
    const limit = Number(details.limit);
    const measured = Number.isFinite(bytes) && Number.isFinite(limit)
      ? ` Gói đo được ${Math.round(bytes / (1024 * 1024) * 10) / 10} MB, trần ${Math.round(limit / (1024 * 1024) * 10) / 10} MB (${limit} byte).`
      : '';
    return `Gói xuất bản vượt trần kích thước (413${code ? ` ${code}` : ''}).${measured} ${hint || 'Bớt dữ liệu của job rồi thử lại.'}${server}`;
  }
  // R6: 429 do QUÁ TẢI DỰNG GÓI (khác 429 rate-limit theo phiên) — nói đúng loại, có gợi ý chờ.
  if (code === 'EXPORT_BUSY') {
    const retry = Number(err?.payload?.retry_after_ms);
    const wait = Number.isFinite(retry) && retry > 0 ? ` Máy chủ đề nghị chờ ~${Math.ceil(retry / 1000)} giây.` : '';
    return `Máy chủ đang bận dựng gói xuất bản (429 ${code}).${wait} ${hint || 'Chờ một lát rồi thử lại.'}${server}`;
  }
  if (code === 'EXPORT_UNAVAILABLE' || status === 503) {
    return `Chưa tải được gói xuất bản (503${code ? ` ${code}` : ''}). ${hint || 'Máy chủ báo tính năng gói xuất bản chưa khả dụng.'}${server}`;
  }
  if (code === 'JOB_NOT_FOUND' || status === 404) {
    return `Không tải được gói xuất bản (404${code ? ` ${code}` : ''}). ${hint || 'Job không tồn tại hoặc không thuộc phiên/tài khoản này.'}${server}`;
  }
  if (status === 400) {
    return `Không tải được gói xuất bản (400${code ? ` ${code}` : ''}). ${hint || 'Mã job không hợp lệ.'}${server}`;
  }
  if (status === 429) {
    return `Chưa tải được gói xuất bản (429${code ? ` ${code}` : ''}). Bị giới hạn tần suất — chờ một lát rồi thử lại.${server}`;
  }
  const head = status ? `HTTP ${status}${code ? ` ${code}` : ''}` : code || 'lỗi không rõ';
  return `Không tải được gói xuất bản (${head})${real ? `. Máy chủ báo: “${real}”` : '.'}`;
}

/** Chuỗi hiển thị an toàn cho một giá trị bất kỳ trong manifest (nơi gọi tự `esc()`). */
function exportScalarText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => exportScalarText(v)).filter((s) => s !== '').join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Một mục của manifest (chuỗi / object / mảng) → mảng dòng chữ để in ra. */
function exportList(value) {
  const arr = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
  return arr.map((v) => exportScalarText(v)).filter((s) => s !== '');
}

/** Gộp nhiều nguồn cảnh báo/thiếu (top-level + trong manifest) — KHÔNG được giấu bớt mục nào. */
function exportUnion(...lists) {
  const out = [];
  const seen = new Set();
  for (const item of lists) {
    for (const line of exportList(item)) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

/**
 * Nhãn kiểm chứng để HIỂN THỊ — CHỈ nhận CHUỖI, giữ nguyên văn (đã trim) thứ máy chủ khai.
 *
 * R2 (phản biện vòng 2, LOW): trước đây hàm này còn đọc `v.level`/`v.label` của OBJECT ⇒
 * `verification: {level:'LIVE_VERIFIED'}` được dịch thành nhãn "LIVE_VERIFIED" và UI tô badge
 * XANH dù `live_service_called: false`. Object/kiểu lạ ⇒ coi như KHÔNG có nhãn (lý do in kèm).
 */
function exportVerificationLabel(manifest) {
  const v = manifest?.verification;
  return typeof v === 'string' ? v.trim() : '';
}

function exportVerificationText(manifest) {
  const v = manifest?.verification;
  if (v === null || v === undefined || v === '') return 'Máy chủ không khai nhãn kiểm chứng.';
  if (typeof v !== 'object') return String(v);
  const parts = Object.entries(v).map(([k, val]) => `${k}=${exportScalarText(val)}`).filter((s) => !s.endsWith('='));
  return parts.length ? parts.join(' · ') : 'Máy chủ không khai nhãn kiểm chứng.';
}

/** Khối danh sách của bản kê khai; rỗng thì NÓI THẲNG là rỗng, không bỏ im lặng. */
function exportBlockHtml(title, items, opts = {}) {
  const list = Array.isArray(items) ? items.filter((s) => String(s ?? '').trim() !== '') : [];
  const head = `<h3 style="margin:12px 0 6px">${esc(title)}</h3>`;
  if (!list.length) return `${head}<p class="muted small" style="margin:0">${esc(opts.empty || 'Máy chủ không khai mục nào.')}</p>`;
  const body = `<ul class="bullets">${list.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;
  const cls = String(opts.cls || '').trim();
  return cls ? `${head}<div class="notice ${esc(cls)}" style="margin:0">${body}</div>` : `${head}${body}`;
}

/**
 * Bản kê khai (§3 `/manifest`) — in NGUYÊN VĂN thứ máy chủ khai, đã escape: không thêm, không bớt.
 * `audio === null` là SỰ THẬT của hợp đồng §0 (“video không tiếng”) nên phải hiện thẳng.
 */
function exportManifestHtml(data) {
  const manifest = data?.manifest && typeof data.manifest === 'object' ? data.manifest : {};
  const job = manifest.job && typeof manifest.job === 'object' ? manifest.job : {};
  const label = exportVerificationLabel(manifest);
  const rawVerification = manifest.verification;
  // R2: CỔNG NHÃN ở phía UI. Badge XANH ("đã kiểm chứng bằng dịch vụ thật") chỉ được hiện khi:
  //   (a) nhãn là CHUỖI và sau khi chuẩn hoá (trim + HOA) ra ĐÚNG một mức LIVE, VÀ
  //   (b) bằng chứng máy chủ khai `verification_detail.live_service_called === true`
  //       (máy chủ chỉ đặt true khi `transport === 'http'`).
  // Nhãn KHÔNG chuẩn (`live_verified`, `LIVE_VERIFIED `, object `{level:…}`) không còn lọt badge.
  const liveLevels = ['LIVE_VERIFIED', 'AUTHENTICATED_LIVE_VERIFIED'];
  const level = label.toUpperCase();
  const liveProven = manifest?.verification_detail?.live_service_called === true;
  const isLive = liveLevels.includes(level) && liveProven;
  const labelNotes = [];
  if (!label && rawVerification !== null && rawVerification !== undefined && rawVerification !== '') {
    labelNotes.push('Máy chủ trả nhãn kiểm chứng KHÔNG phải chuỗi (object/kiểu lạ) ⇒ UI coi như KHÔNG có nhãn và không tự dịch nó thành nhãn.');
  }
  if (label && level !== label) {
    labelNotes.push(`Nhãn đã được CHUẨN HOÁ (trim + chữ hoa) để xét cổng bằng chứng: ${JSON.stringify(label)} → ${level}.`);
  }
  if (liveLevels.includes(level) && !liveProven) {
    labelNotes.push('Nhãn LIVE nhưng bằng chứng máy chủ khai KHÔNG chứng minh đã gọi dịch vụ thật (`live_service_called` không phải true) ⇒ UI KHÔNG hiện badge LIVE.');
  }
  const cls = isLive ? 'ok' : label ? 'warn' : '';
  const audio = manifest.audio === null
    ? 'audio: KHÔNG có tiếng (video không tiếng)'
    : manifest.audio === undefined
      ? 'audio: máy chủ không khai'
      : 'audio: có khối audio';
  const counts = manifest.counts && typeof manifest.counts === 'object'
    ? Object.entries(manifest.counts).map(([k, v]) => `${k}=${exportScalarText(v)}`)
    : [];
  const warnings = exportUnion(data?.warnings, manifest.warnings);
  // D1 + R5: nếu bản kê khai KHÔNG có khoá `mock_steps` (bản cũ/thiếu dữ liệu) thì UI phải nói "không
  // kiểm được", KHÔNG được khẳng định là "không có bước giả". Và mảng CÓ phần tử nhưng không đọc
  // được tên bước nào (`[null]`, `[""]`) cũng KHÔNG phải bằng chứng "không có bước giả".
  const rawMockSteps = Array.isArray(manifest.mock_steps)
    ? manifest.mock_steps
    : typeof manifest.mock_steps === 'string' && manifest.mock_steps.trim()
      ? [manifest.mock_steps]
      : Array.isArray(data?.manifest?.mock_steps)
        ? data.manifest.mock_steps
        : null;
  const mockSteps = exportList(rawMockSteps);
  const mockStepsKnown = rawMockSteps !== null;
  const mockStepsEmpty = rawMockSteps !== null && rawMockSteps.length === 0;
  const missing = exportUnion(data?.missing, manifest.missing);
  const providers = exportList(manifest.providers);
  const jobLine = `Job <span class="mono">${esc(String(job.id || '—'))}</span> · loại ${esc(String(job.kind || '—'))} · trạng thái ${esc(String(job.status || '—'))} · sinh lúc ${esc(String(manifest.generated_at || '—'))}`;
  return `<div class="notice">
    <div class="muted small">${jobLine}</div>
    <div class="row" style="margin-top:8px">
      <span class="badge ${esc(cls)}">Nhãn kiểm chứng: ${esc(label || 'máy chủ không khai')}</span>
      <span class="badge">${esc(audio)}</span>
    </div>
    ${labelNotes.length ? `<p class="muted small" style="margin:6px 0 0">${esc(labelNotes.join(' '))}</p>` : ''}
    ${exportBlockHtml('Kiểm chứng (verification)', [exportVerificationText(manifest)])}
    ${exportBlockHtml('Bước dùng dữ liệu giả (mock_steps)', mockSteps, {
      cls: mockSteps.length ? 'warn' : '',
      // D1 (phản biện Gói xuất bản, HIGH): câu này chỉ được nói khi danh sách THẬT SỰ rỗng — trước
      // đây nó in cả khi máy chủ khai thiếu (mock_steps rỗng do lỗi gom dấu vết), tức UI nói dối.
      // R5: `[null]`/`[""]` là CÓ dấu vết mock ⇒ tuyệt đối không được khẳng định "không có bước giả".
      empty: mockStepsEmpty
        ? 'Máy chủ khai KHÔNG có bước nào dùng dữ liệu giả.'
        : mockStepsKnown
          ? `Bản kê khai CÓ mục mock_steps (${rawMockSteps.length} phần tử) nhưng KHÔNG đọc được tên bước nào ⇒ KHÔNG kiểm được job có bước giả hay không.`
          : 'Bản kê khai KHÔNG có mục mock_steps ⇒ KHÔNG kiểm được job có bước giả hay không.',
    })}
    ${exportBlockHtml('Thiếu trong gói (missing)', missing, { cls: 'warn', empty: 'Máy chủ khai KHÔNG thiếu mục nào.' })}
    ${exportBlockHtml('Cảnh báo của job (warnings)', warnings, { cls: 'warn', empty: 'Máy chủ không trả cảnh báo nào.' })}
    ${counts.length ? exportBlockHtml('Số lượng trong gói (counts)', counts) : ''}
    ${exportBlockHtml('Provider đã dùng (providers)', providers, { empty: 'Máy chủ không khai provider.' })}
    <p class="muted small" style="margin:10px 0 0">Nguyên văn bản kê khai của máy chủ (đã escape) — không thêm, không bớt.</p>
  </div>`;
}

/**
 * Khối “Gói xuất bản” cho MỘT màn job (§4) — HTML thuần nên test trích ra chạy được, không cần DOM.
 * - không có `jobId` ⇒ nút KHOÁ + nói rõ lý do (§4: “khoá khi job không tồn tại/không có id”);
 * - `/api/config` khai `exports.available === false` ⇒ vẫn ĐỂ BẤM (để lỗi 503 thật hiện ra) nhưng
 *   cảnh báo trước bằng lời máy chủ khai — không giả vờ là tải được;
 * - job đang chạy ⇒ nhắc “job chưa xong, gói có thể thiếu”.
 */
function exportPanelHtml(jobId, status, opts = {}) {
  const id = String(jobId ?? '').trim();
  const cfg = state.config?.exports;
  const unavailable = Boolean(cfg) && cfg.available === false;
  const running = ['queued', 'running', 'awaiting_review'].includes(String(status ?? '').toLowerCase());
  const locked = !id;
  const disabled = locked;
  const url = id ? exportBundleUrl(id) : '';
  const notes = [`<p class="muted small" style="margin:6px 0 0">${esc(EXPORT_HONEST_LINE)}</p>`];
  if (running) notes.push(`<p class="small" style="margin:6px 0 0"><strong>⏳ ${esc(EXPORT_RUNNING_LINE)}</strong></p>`);
  if (locked) notes.push(`<p class="muted small" style="margin:6px 0 0">🔒 ${esc(EXPORT_NO_ID_LINE)}</p>`);
  // `GET /api/config` §3 chỉ khai `exports = { available, formats }` (KHÔNG có `reason`) ⇒ chỉ đọc cờ.
  if (unavailable) notes.push(`<p class="small" style="margin:6px 0 0">⚠️ ${esc(`${EXPORT_UNCONFIGURED_LINE}. Bấm nút vẫn thử và sẽ hiện đúng lỗi máy chủ trả.`)}</p>`);
  const kind = String(opts.kind || '').trim();
  return `<section class="panel export-panel" data-export-kind="${esc(kind)}">
    <div class="spread">
      <div style="min-width:0">
        <h2 style="margin:0">Gói xuất bản (.zip)</h2>
        ${notes.join('')}
      </div>
      <div class="row">
        <button class="btn primary" type="button" data-action="exportbundle" data-export-id="${esc(id)}" data-export-url="${esc(url)}"${disabled ? ' disabled aria-disabled="true"' : ''}>${esc(EXPORT_BUTTON_LABEL)}</button>
        <button class="btn ghost tiny" type="button" data-action="exportmanifest" data-export-id="${esc(id)}"${disabled ? ' disabled' : ''}>${esc(EXPORT_MANIFEST_LABEL)}</button>
      </div>
    </div>
    <div data-export-error></div>
    <div data-export-manifest hidden></div>
  </section>`;
}

/** Gợi ý tên tệp cho thẻ `<a download>` (máy chủ vẫn có thể đặt tên khác ở Content-Disposition). */
function exportDownloadName(manifest, jobId) {
  const id = String(jobId ?? '').trim().slice(0, 8);
  if (!id) return '';
  const kind = String(manifest?.job?.kind || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return kind ? `${kind}-${id}.zip` : `goi-xuat-ban-${id}.zip`;
}

/** Ghi lỗi THẬT của lần tải gói vào panel — không nuốt lỗi, không thay bằng câu chung chung. */
function exportPaintError(err, jobId) {
  const box = document.querySelector('[data-export-error]');
  const text = exportErrorText(err);
  if (!box) return text;
  const status = Number(err?.status || 0);
  const code = String(err?.code || '');
  // 503/EXPORT_UNAVAILABLE thì tải thẳng cũng hỏng ⇒ KHÔNG mời người dùng bấm thêm một lần vô ích.
  // R6: 413 (vượt trần) và 429 EXPORT_BUSY cũng vậy — tải thẳng y hệt vẫn bị từ chối.
  const canFallback = Boolean(jobId) && status !== 503 && status !== 429 && status !== 413 && code !== 'EXPORT_UNAVAILABLE' && code !== 'EXPORT_BAD_MANIFEST' && code !== 'BUNDLE_TOO_LARGE' && code !== 'EXPORT_BUSY';
  const fallback = canFallback
    ? `<p style="margin:8px 0 0"><a class="btn tiny ghost" href="${esc(exportBundleUrl(jobId))}" download rel="noopener">${esc(EXPORT_FALLBACK_LINE)}</a></p>`
    : '';
  box.innerHTML = `<div class="notice error"><strong>Không tải được gói xuất bản.</strong><p style="margin:6px 0 0">${esc(text)}</p>${fallback}</div>`;
  return text;
}

/** Bấm nút tải: hỏi `/manifest` trước để bắt lỗi thật, rồi tải `.zip` bằng thẻ `<a download>`. */
async function downloadExportBundle(jobId) {
  const id = String(jobId ?? '').trim();
  const errBox = document.querySelector('[data-export-error]');
  if (errBox) errBox.innerHTML = '';
  if (!id) {
    if (errBox) errBox.innerHTML = `<div class="notice warn">🔒 ${esc(EXPORT_NO_ID_LINE)}</div>`;
    return { ok: false, status: 0, code: '', text: EXPORT_NO_ID_LINE };
  }
  const url = exportBundleUrl(id);
  try {
    const data = await api(exportManifestUrl(id));
    const manifest = data && typeof data === 'object' ? data.manifest : null;
    if (!manifest || typeof manifest !== 'object') {
      // 200 nhưng thân không phải bản kê khai (ví dụ trang HTML) ⇒ KHÔNG tải bừa thành `.zip`.
      const bad = new Error(EXPORT_NOT_MANIFEST_LINE);
      bad.code = 'EXPORT_BAD_MANIFEST';
      bad.status = 0;
      throw bad;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = exportDownloadName(manifest, id);
    a.rel = 'noopener';
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Đang tải gói xuất bản (.zip)…');
    return { ok: true, status: 200, code: '', url };
  } catch (err) {
    const text = exportPaintError(err, id);
    toast(`Không tải được gói: ${String(err?.code || err?.message || 'lỗi không rõ')}`);
    return { ok: false, status: Number(err?.status || 0), code: String(err?.code || ''), text };
  }
}

/** Mở bản kê khai THẬT của job (verification / mock_steps / missing / warnings). */
async function openExportManifest(jobId) {
  const id = String(jobId ?? '').trim();
  const box = document.querySelector('[data-export-manifest]');
  const errBox = document.querySelector('[data-export-error]');
  if (errBox) errBox.innerHTML = '';
  if (!id) {
    if (errBox) errBox.innerHTML = `<div class="notice warn">🔒 ${esc(EXPORT_NO_ID_LINE)}</div>`;
    return { ok: false, status: 0, code: '', text: EXPORT_NO_ID_LINE };
  }
  try {
    const data = await api(exportManifestUrl(id));
    if (box) {
      box.hidden = false;
      box.innerHTML = exportManifestHtml(data);
    }
    return { ok: true, status: 200, code: '', data };
  } catch (err) {
    const text = exportPaintError(err, id);
    if (box) {
      box.hidden = true;
      box.innerHTML = '';
    }
    return { ok: false, status: Number(err?.status || 0), code: String(err?.code || ''), text };
  }
}

/* ═════════════════════ MVP-05 — Tài khoản + Ví credit ═════════════════════
 *
 * LUẬT #1 của hợp đồng §0: KHÔNG chặn tính năng với người chưa đăng nhập. Mọi thứ ở khối này là
 * TUỲ CHỌN — chưa đăng nhập vẫn dán link / dịch ảnh / tạo ảnh bình thường, chỉ kém phần “lưu
 * lịch sử theo tài khoản” và ví credit. Giao diện chỉ hiện gợi ý nhẹ, KHÔNG khoá tab nào.
 *
 * Nhãn trung thực (§3.5 + §6): credit là CREDIT NỘI BỘ, không phải tiền thật; giai đoạn này chỉ
 * quản trị cấp tay, CHƯA có cổng thanh toán (MVP-06) — giao diện không hứa gì hơn thế.
 */

const LEDGER_REASON_LABEL = {
  grant: 'Tặng',
  admin_grant: 'Quản trị cấp',
  job_hold: 'Giữ cho job',
  job_settle: 'Quyết toán',
  job_refund: 'Hoàn tiền',
  adjustment: 'Điều chỉnh',
};

const ROLE_LABEL = { owner: 'Chủ sở hữu', admin: 'Quản trị', member: 'Thành viên' };

const USER_STATUS_LABEL = { active: 'Đang hoạt động', disabled: 'Đã khoá' };

const USAGE_GROUP_LABEL = { day: 'Theo ngày', operation: 'Theo thao tác', user: 'Theo người dùng' };

// Bảng giá / thống kê: chỉ những thao tác có trong hợp đồng §2.1 — không bịa thêm.
const OPERATION_LABEL = {
  SOURCE_EXTRACT: 'Trích xuất dữ liệu sản phẩm',
  VISION_ANALYSIS: 'Phân tích ảnh (vision)',
  TRANSLATION: 'Dịch chữ trong ảnh',
  CONTENT_GENERATE: 'Sinh nội dung tiếng Việt',
  CONTENT_REPAIR: 'Sửa lại nội dung',
  OCR_DETECT: 'Đọc chữ trong ảnh (OCR)',
  IMAGE_RENDER: 'Render ảnh đã dịch',
  IMAGE_MATTING: 'Tách nền ảnh',
  IMAGE_COMPOSE: 'Ghép nền',
  IMAGE_RETOUCH: 'Retouch ảnh',
};

// Câu tiếng Việt cho mã lỗi xác thực §3.3. `WEAK_PASSWORD` cần độ dài tối thiểu lấy từ
// `/api/config` nên được ghép ĐỘNG trong `authErrorText()` — KHÔNG hardcode con số.
const AUTH_ERROR_HINT = {
  EMAIL_TAKEN: 'Email này đã được dùng cho một tài khoản khác.',
  WEAK_PASSWORD: 'Mật khẩu quá yếu.',
  BAD_BODY: 'Dữ liệu gửi lên không hợp lệ (kiểm tra lại email / mật khẩu).',
  BAD_EMAIL: 'Email không hợp lệ.',
  INVALID_CREDENTIALS: 'Sai email hoặc mật khẩu.',
  UNAUTHENTICATED: 'Bạn chưa đăng nhập (hoặc phiên đã hết hạn) — hãy đăng nhập lại.',
  FORBIDDEN: 'Bạn không có quyền làm việc này (chỉ owner/admin).',
  AUTH_DISABLED: 'Chức năng tài khoản đang tắt trên máy chủ này.',
  RATE_LIMITED: 'Bạn thao tác quá nhanh — chờ một lát rồi thử lại.',
  USER_NOT_FOUND: 'Không tìm thấy người dùng này.',
  INSUFFICIENT_CREDIT: 'Không đủ credit để chạy thao tác này.',
};

// Nói thẳng, không hứa hẹn: credit nội bộ, chưa có cổng thanh toán.
const CREDIT_HONEST_NOTE = 'Credit nội bộ — KHÔNG phải tiền thật. Số dư = tổng sổ (append-only), không sửa tay được.';
const CREDIT_TOPUP_HINT = 'Giai đoạn này CHƯA có cổng thanh toán: credit chỉ do quản trị viên cấp tay (trang Quản trị). Không có khoản thanh toán nào được thực hiện ở đây.';

const LEDGER_PAGE_SIZE = 50;
const ADMIN_PAGE_SIZE = 50;

/** Nhãn cột cho bảng usage — body của `/api/admin/usage` chưa đóng băng từng field, nên
 *  giao diện hiện ĐÚNG những cột máy chủ trả về (tên lạ thì giữ nguyên tên, không bịa).
 *  Cột NHÓM của A2/A3 là `group` (bản cũ hơn dùng `bucket`) — cả hai đều là “Nhóm”, vì cùng
 *  một cột chứa ngày / operation / user_id tuỳ `group_by`. */
const USAGE_COLUMN_LABEL = {
  group: 'Nhóm', bucket: 'Nhóm', day: 'Ngày', date: 'Ngày', bucket_day: 'Ngày', period: 'Kỳ',
  operation: 'Thao tác', user_id: 'Người dùng', owner_id: 'Người dùng (id)', user: 'Người dùng', email: 'Email',
  events: 'Số lần', count: 'Số lần', jobs: 'Số job', runs: 'Số lần', total: 'Số lần',
  estimated_cost: 'Chi phí ước tính (credit)', cost: 'Chi phí', total_cost: 'Tổng chi phí', total_amount: 'Tổng credit',
  amount: 'Credit', credits: 'Credit', input_units: 'Đơn vị vào', output_units: 'Đơn vị ra',
  tokens: 'Token', total_tokens: 'Tổng token', users: 'Số người dùng', sessions: 'Số phiên',
};

function currentUser() {
  return state.auth?.me?.user || null;
}

function isAdminRole(role) {
  return role === 'owner' || role === 'admin';
}

function canAdmin() {
  return isAdminRole(currentUser()?.role);
}

/** `/api/config` báo chức năng tài khoản có bật không (A1/A3). Thiếu khối ⇒ coi như có, để
 *  trang đăng nhập vẫn gọi được API và hiện LỖI THẬT thay vì tự khoá giao diện. */
function authEnabled() {
  if (state.config?.accounts?.available === false) return false;
  return state.config?.auth?.enabled !== false;
}

function accountsUnavailableText() {
  const acc = state.config?.accounts;
  if (acc && acc.available === false && acc.reason) return String(acc.reason);
  if (state.config?.auth?.enabled === false) return 'Máy chủ đặt AUTH_ENABLED=false.';
  return 'không rõ lý do — xem log máy chủ (accounts.wiring_failed).';
}

/** Độ dài mật khẩu tối thiểu LẤY TỪ `/api/config` (auth.password_min_length) — không hardcode.
 *  Chưa tải được cấu hình ⇒ trả null và UI nói thật là chưa biết. */
function passwordMinLength() {
  const n = Number(state.config?.auth?.password_min_length);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function passwordRuleText() {
  const min = passwordMinLength();
  return min
    ? `Mật khẩu cần ít nhất ${min} ký tự (theo cấu hình máy chủ).`
    : 'Độ dài mật khẩu tối thiểu do máy chủ quy định — chưa tải được cấu hình, hãy dùng mật khẩu dài.';
}

/* ── Định dạng số / thời gian (dùng chung cho sổ, bảng giá, quản trị) ───────── */

function fmtAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 10000) / 10000);
}

function creditText(balance) {
  if (!balance || balance.amount === null || balance.amount === undefined) return 'chưa rõ số dư';
  const cur = balance.currency ? ` (${balance.currency})` : '';
  return `${fmtAmount(balance.amount)} credit${cur}`;
}

function fmtTime(value) {
  const raw = String(value ?? '');
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString('vi-VN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function ledgerReasonLabel(reason) {
  const key = String(reason ?? '');
  if (!key) return 'Không rõ';
  return LEDGER_REASON_LABEL[key] || key;
}

function ledgerAmountText(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '+';
  const cur = currency ? ` ${String(currency)}` : '';
  return `${sign}${fmtAmount(Math.abs(n))}${cur}`;
}

function ledgerAmountClass(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n === 0) return 'credit-zero';
  return n > 0 ? 'credit-plus' : 'credit-minus';
}

function operationLabel(operation) {
  const key = String(operation ?? '');
  if (!key) return '—';
  return OPERATION_LABEL[key] || key;
}

function roleLabel(role) {
  const key = String(role ?? '');
  return key ? ROLE_LABEL[key] || key : '—';
}

function userStatusLabel(status) {
  const key = String(status ?? '');
  return key ? USER_STATUS_LABEL[key] || key : '—';
}

/* ── Lỗi: nói thật, không nuốt thông điệp của máy chủ ─────────────────────── */

function authErrorText(err, opts = {}) {
  const form = opts.mode === 'login' || opts.mode === 'register';
  const code = String(err?.code || '');
  const server = String(err?.message || '').trim();
  const min = passwordMinLength();
  let head = '';
  if (form && (err?.status === 401 || err?.status === 403) && code !== 'AUTH_DISABLED') {
    // Đang ở form đăng nhập/đăng ký: 401/403 nghĩa là sai thông tin hoặc bị khoá, KHÁC 401 do
    // phiên hết hạn ở các trang gọi API khác.
    head = 'Sai email hoặc mật khẩu (hoặc tài khoản đã bị khoá).';
  } else if (code === 'WEAK_PASSWORD') {
    head = min ? `Mật khẩu quá yếu — cần ít nhất ${min} ký tự.` : 'Mật khẩu quá yếu — hãy dùng mật khẩu dài hơn.';
  } else if (code === 'EMAIL_TAKEN' || err?.status === 409) {
    head = AUTH_ERROR_HINT.EMAIL_TAKEN;
  } else if (code === 'BAD_BODY' || code === 'BAD_EMAIL' || err?.status === 400) {
    head = AUTH_ERROR_HINT.BAD_BODY;
  } else if (code === 'AUTH_DISABLED' || err?.status === 503) {
    head = AUTH_ERROR_HINT.AUTH_DISABLED;
  } else if (code === 'INSUFFICIENT_CREDIT' || err?.status === 402) {
    head = creditShortfallText(err);
  } else if (code === 'FORBIDDEN' || err?.status === 403) {
    head = AUTH_ERROR_HINT.FORBIDDEN;
  } else if (code === 'UNAUTHENTICATED' || err?.status === 401) {
    head = AUTH_ERROR_HINT.UNAUTHENTICATED;
  } else if (AUTH_ERROR_HINT[code]) {
    head = AUTH_ERROR_HINT[code];
  }
  if (!head) head = server || 'Không rõ lỗi từ máy chủ.';
  return server && server !== head ? `${head} (máy chủ báo: ${server})` : head;
}

/** Câu lỗi cho các trang gọi API (tài khoản / quản trị) — khác form đăng nhập ở chỗ 401 là
 *  “phiên hết hạn”, không phải “sai mật khẩu”. */
function apiErrorText(err) {
  const code = String(err?.code || '');
  if (code === 'INSUFFICIENT_CREDIT' || err?.status === 402) return creditShortfallText(err);
  if (AUTH_ERROR_HINT[code]) return `${code}: ${AUTH_ERROR_HINT[code]}`;
  if (err?.status >= 500) return `${code || `HTTP ${err.status}`}: máy chủ lỗi — thử lại sau (xem log máy chủ).`;
  return String(err?.message || 'Lỗi không xác định.');
}

/**
 * Đọc “số cần / số đang có” từ lỗi 402. Hợp đồng §3.3 đóng băng MÃ lỗi nhưng chưa đóng băng
 * body chi tiết, nên đọc nhiều tên field hợp lý; máy chủ không kèm số thì nói THẬT là không có số
 * (không bịa). `have` có thể lấy từ số dư gần nhất giao diện biết — khi đó có cờ `haveCached`.
 */
function creditShortfall(err) {
  const details = err?.payload?.details || err?.body?.error?.details || err?.body?.details || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const need = num(details.required ?? details.needed ?? details.required_amount ?? details.amount ?? details.cost);
  let have = num(details.balance ?? details.available ?? details.current_balance ?? details.balance_after);
  let haveCached = false;
  if (have === null) {
    const cached = num(state.auth?.me?.balance?.amount);
    if (cached !== null) {
      have = cached;
      haveCached = true;
    }
  }
  const currency = String(details.currency || state.auth?.me?.balance?.currency || '');
  const short = need !== null && have !== null ? Math.round((need - have) * 10000) / 10000 : null;
  return { need, have, haveCached, short, currency };
}

function creditShortfallText(err) {
  const s = creditShortfall(err);
  const cur = s.currency ? ` ${s.currency}` : '';
  if (s.need !== null && s.have !== null) {
    const short = s.short !== null && s.short > 0 ? ` — thiếu ${fmtAmount(s.short)}${cur}` : '';
    const src = s.haveCached ? ' (số dư gần nhất giao diện biết)' : '';
    return `Không đủ credit: cần ${fmtAmount(s.need)}${cur}, bạn đang có ${fmtAmount(s.have)}${cur}${src}${short}.`;
  }
  if (s.need !== null) return `Không đủ credit: thao tác này cần ${fmtAmount(s.need)}${cur}, số dư hiện có không đủ.`;
  if (s.have !== null) {
    const src = s.haveCached ? ' (số dư gần nhất giao diện biết)' : '';
    return `Không đủ credit cho thao tác này — số dư hiện có ${fmtAmount(s.have)}${cur}${src}.`;
  }
  return 'Không đủ credit cho thao tác này (máy chủ không kèm số cần / số đang có).';
}

function creditAlertBox(text) {
  return `<div class="notice error credit-short" id="credit-short">
    <strong>${esc(text)}</strong>
    <p class="small" style="margin:6px 0 0">${esc(CREDIT_HONEST_NOTE)}</p>
    <p class="small" style="margin:6px 0 0">${esc(CREDIT_TOPUP_HINT)}</p>
    <div class="row" style="margin-top:8px">
      <button class="btn tiny" data-action="account" type="button">Xem cách nạp credit &amp; số dư</button>
      <button class="btn tiny ghost" data-action="creditdismiss" type="button">Đã hiểu</button>
    </div>
  </div>`;
}

function creditShortfallHtml(err) {
  return creditAlertBox(creditShortfallText(err));
}

function renderCreditAlert() {
  const a = state.creditAlert;
  return a && a.text ? creditAlertBox(a.text) : '';
}

function paintCreditAlert() {
  const el = $('#credit-alert');
  if (el) el.innerHTML = renderCreditAlert();
}

/** Gặp 402 ở BẤT KỲ thao tác nào (kể cả trong `api()`) ⇒ băng báo số cần / số đang có + link nạp. */
function noteCreditAlert(err) {
  state.creditAlert = { text: creditShortfallText(err), code: err?.code || 'INSUFFICIENT_CREDIT', at: Date.now() };
  paintCreditAlert();
}

function dismissCreditAlert() {
  state.creditAlert = null;
  paintCreditAlert();
}

/* ── Header: khách ẩn danh ⇄ tài khoản ────────────────────────────────────── */

function renderAccountBar() {
  const me = state.auth?.me;
  const user = me?.user || null;
  if (!user) {
    const probeError = me?.error
      ? `<span class="badge warn" title="${esc(me.error)}">chưa kiểm tra được phiên</span>`
      : '';
    return `<div class="account-bar">
      <span class="badge">Khách ẩn danh</span>
      <span class="muted small">Dữ liệu chỉ theo phiên trình duyệt này.</span>
      ${probeError}
      <button class="btn ghost tiny" data-action="login" type="button">Đăng nhập</button>
      <button class="btn ghost tiny" data-action="account" type="button">Tài khoản</button>
    </div>`;
  }
  const adminBtn = isAdminRole(user.role)
    ? `<button class="btn ghost tiny" data-action="admin" type="button">Quản trị</button>`
    : '';
  return `<div class="account-bar">
    <span class="badge ok" title="Vai trò: ${esc(roleLabel(user.role))}">${esc(user.email || '(không có email)')}</span>
    <span class="muted small">· <strong>${esc(creditText(me?.balance))}</strong></span>
    <button class="btn ghost tiny" data-action="account" type="button">Tài khoản</button>
    ${adminBtn}
    <button class="btn ghost tiny" data-action="logout" type="button">Đăng xuất</button>
  </div>`;
}

function paintAccountBar() {
  const el = $('#account-bar');
  if (el) el.innerHTML = renderAccountBar();
}

/** Gợi ý NHẸ cho khách ẩn danh (luật #1: không chặn tab nào). Đã đăng nhập ⇒ không hiện gì. */
function authHintHtml() {
  if (currentUser()) return '';
  return `<div class="notice hint-inline" id="auth-hint">
    <span><strong>Bạn đang là khách ẩn danh.</strong> Dữ liệu chỉ theo phiên trình duyệt này.</span>
    <button class="btn ghost tiny" data-action="login" type="button">Đăng nhập để lưu lịch sử và dùng credit</button>
  </div>`;
}

/* ── Trang Đăng nhập / Đăng ký (#/dangnhap) ───────────────────────────────── */

function renderAuthBody() {
  const a = state.auth;
  const register = a.mode === 'register';
  const min = passwordMinLength();
  const form = a.form || {};
  const minAttr = min ? ` minlength="${min}"` : '';
  const autocomplete = register ? 'new-password' : 'current-password';
  const errorBox = a.formError ? `<div class="notice error" id="auth-error">${esc(a.formError)}</div>` : '';
  const noticeBox = a.formNotice ? `<div class="notice ok" id="auth-notice">${esc(a.formNotice)}</div>` : '';
  const gate = authEnabled()
    ? ''
    : `<div class="notice warn" id="auth-disabled">
        <strong>Máy chủ chưa bật chức năng tài khoản (AUTH_DISABLED).</strong>
        <p class="small" style="margin:6px 0 0">Lý do: ${esc(accountsUnavailableText())}</p>
        <p class="small" style="margin:6px 0 0">Bạn vẫn dùng được Nội dung / Dịch ảnh / Tạo ảnh ở chế độ khách ẩn danh
        (không có ví credit, dữ liệu chỉ theo phiên trình duyệt này).</p>
      </div>`;
  return `<section class="panel auth-panel">
    <div class="tabs auth-tabs">
      <button class="tab ${register ? '' : 'active'}" data-action="authmode" data-mode="login" type="button">Đăng nhập</button>
      <button class="tab ${register ? 'active' : ''}" data-action="authmode" data-mode="register" type="button">Đăng ký</button>
    </div>
    <h2>${register ? 'Đăng ký tài khoản' : 'Đăng nhập'}</h2>
    <p class="muted small">
      Tài khoản để <strong>lưu lịch sử theo bạn</strong> và dùng <strong>credit nội bộ</strong>.
      Đăng nhập là TUỲ CHỌN: chưa đăng nhập vẫn dán link và chạy được, chỉ là dữ liệu chỉ theo phiên trình duyệt này.
    </p>
    ${gate}${errorBox}${noticeBox}
    <form id="auth-form" novalidate>
      <div class="field">
        <div class="field-head"><label for="auth-email">Email</label></div>
        <input class="text-input" id="auth-email" name="email" type="email" autocomplete="username"
               value="${esc(form.email || '')}" placeholder="ban@example.com" />
      </div>
      <div class="field">
        <div class="field-head"><label for="auth-password">Mật khẩu</label></div>
        <input class="text-input" id="auth-password" name="password" type="password" autocomplete="${autocomplete}"${minAttr} />
        <p class="hint" style="margin:6px 0 0">${esc(passwordRuleText())}</p>
      </div>
      ${register ? `<div class="field">
        <div class="field-head"><label for="auth-name">Tên hiển thị (không bắt buộc)</label></div>
        <input class="text-input" id="auth-name" name="display_name" type="text" maxlength="80"
               value="${esc(form.display_name || '')}" placeholder="Ví dụ: Nguyễn Văn A" />
      </div>` : ''}
      <div class="row">
        <button class="btn primary" type="submit" id="auth-submit"${a.busy || !authEnabled() ? ' disabled' : ''}>
          ${a.busy ? 'ĐANG GỬI…' : register ? 'ĐĂNG KÝ' : 'ĐĂNG NHẬP'}
        </button>
        <button class="btn ghost" type="button" data-action="home">Để sau — dùng ẩn danh</button>
      </div>
    </form>
    <p class="hint">Mật khẩu chỉ được máy chủ lưu dưới dạng băm (scrypt). Giao diện KHÔNG lưu mật khẩu của bạn.</p>
  </section>`;
}

function renderAuthPage() {
  state.view = 'auth';
  stopPolling();
  stopIlPolling();
  stopIsPolling();
  app.innerHTML = renderAuthBody();
}

async function openAuth() {
  state.auth.formError = null;
  renderAuthPage();
  if (!state.auth.loaded) {
    await loadMe();
    if (state.view === 'auth') renderAuthPage();
  }
}

async function submitAuthForm() {
  const a = state.auth;
  if (a.busy) return;
  const register = a.mode === 'register';
  const email = String($('#auth-email')?.value ?? a.form.email ?? '').trim();
  const password = String($('#auth-password')?.value ?? '');
  const displayName = String($('#auth-name')?.value ?? a.form.display_name ?? '').trim();
  // Giữ email/tên đã gõ để render lại không mất chữ; KHÔNG giữ mật khẩu trong state.
  a.form = { email, display_name: displayName };
  a.formError = null;
  a.formNotice = null;
  if (!email) {
    a.formError = 'Hãy nhập email.';
    renderAuthPage();
    return;
  }
  if (!password) {
    a.formError = 'Hãy nhập mật khẩu.';
    renderAuthPage();
    return;
  }
  const min = passwordMinLength();
  if (register && min && password.length < min) {
    a.formError = `Mật khẩu cần ít nhất ${min} ký tự (theo cấu hình máy chủ).`;
    renderAuthPage();
    return;
  }
  a.busy = true;
  renderAuthPage();
  try {
    const body = register ? { email, password, ...(displayName ? { display_name: displayName } : {}) } : { email, password };
    const res = await api(register ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body });
    a.me = { user: res?.user || null, anonymous: !res?.user, balance: null };
    a.loaded = true;
    a.busy = false;
    a.form = { email: '', display_name: '' };
    toast(register ? 'Đã tạo tài khoản.' : 'Đã đăng nhập.');
    await loadMe(); // số dư THẬT từ máy chủ, không đoán
    if (state.view === 'auth') {
      location.hash = '#/taikhoan';
      await openAccount(); // đổi hash có thể không phát hashchange ⇒ mở trang tài khoản ngay
    }
  } catch (err) {
    a.busy = false;
    a.formError = authErrorText(err, { mode: register ? 'register' : 'login' });
    renderAuthPage();
  }
}

/* ── Trang Tài khoản (#/taikhoan) ─────────────────────────────────────────── */

function renderLedgerTable(items) {
  if (items === null || items === undefined) return '<p class="muted small">Đang tải sổ credit…</p>';
  if (!Array.isArray(items) || items.length === 0) return '<p class="muted small">Sổ credit còn trống — chưa có dòng nào.</p>';
  const rows = items.map((it) => `<tr>
      <td class="mono small">${esc(fmtTime(it?.created_at))}</td>
      <td>${esc(ledgerReasonLabel(it?.reason))}${it?.operation ? `<div class="muted small">${esc(operationLabel(it.operation))}</div>` : ''}</td>
      <td class="mono ${ledgerAmountClass(it?.amount)}">${esc(ledgerAmountText(it?.amount, it?.currency))}</td>
      <td class="mono small">${it?.job_id ? esc(it.job_id) : '<span class="muted">—</span>'}</td>
      <td class="mono small">${esc(fmtAmount(it?.balance_after))}</td>
    </tr>`).join('');
  return `<div class="il-tablewrap"><table class="evidence ledger-table">
    <thead><tr><th>Thời gian</th><th>Lý do</th><th>Số tiền</th><th>Job</th><th>Số dư sau</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderPricingTable(pricing) {
  if (pricing === null || pricing === undefined) return '<p class="muted small">Đang tải bảng giá…</p>';
  if (!Array.isArray(pricing) || pricing.length === 0) {
    return '<p class="muted small">Máy chủ chưa trả về bảng giá nào. Ví vẫn trừ credit theo đơn giá cấu hình của máy chủ.</p>';
  }
  const rows = pricing.map((p) => `<tr>
      <td>${esc(operationLabel(p?.operation))}<div class="muted small mono">${esc(p?.operation)}</div></td>
      <td class="mono">${esc(fmtAmount(p?.unit_price))}</td>
      <td>${esc(p?.currency || '—')}</td>
      <td class="small">${p?.note ? esc(p.note) : '<span class="muted">—</span>'}</td>
    </tr>`).join('');
  return `<div class="il-tablewrap"><table class="evidence pricing-table">
    <thead><tr><th>Thao tác</th><th>Đơn giá</th><th>Tiền tệ</th><th>Ghi chú</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderAccountBody() {
  const a = state.auth;
  const me = a.me || {};
  const user = me.user || null;
  if (!user) {
    return `<section class="panel">
      <h2>Tài khoản</h2>
      <div class="notice warn">
        <strong>Bạn chưa đăng nhập — đang ở chế độ khách ẩn danh.</strong>
        <p class="small" style="margin:6px 0 0">Dữ liệu chỉ theo phiên trình duyệt này và KHÔNG có ví credit.
        Mọi tính năng (Nội dung / Dịch ảnh / Tạo ảnh) vẫn chạy bình thường.</p>
      </div>
      ${a.error ? `<div class="notice error">${esc(a.error)}</div>` : ''}
      <div class="row">
        <button class="btn primary" data-action="login" type="button">Đăng nhập / Đăng ký</button>
        <button class="btn ghost" data-action="home" type="button">Về trang chủ</button>
      </div>
    </section>`;
  }
  const errorBox = a.error ? `<div class="notice error">${esc(a.error)}</div>` : '';
  return `<section class="panel">
    <div class="spread">
      <div style="min-width:0">
        <h2 style="margin:0 0 4px">Tài khoản</h2>
        <p class="muted small" style="margin:0">${esc(CREDIT_HONEST_NOTE)}</p>
      </div>
      <span class="badge ok">${esc(roleLabel(user.role))}</span>
    </div>
    <dl class="kv" style="margin-top:12px">
      <dt>Email</dt><dd>${esc(user.email)}</dd>
      <dt>Tên hiển thị</dt><dd>${user.display_name ? esc(user.display_name) : '<span class="muted">chưa đặt</span>'}</dd>
      <dt>Vai trò</dt><dd>${esc(roleLabel(user.role))}</dd>
      <dt>Trạng thái</dt><dd>${esc(userStatusLabel(user.status))}</dd>
      <dt>Số dư credit</dt><dd><strong>${esc(creditText(me.balance))}</strong></dd>
    </dl>
    <div class="notice warn" style="margin-top:12px">
      <strong>Nạp credit thế nào?</strong>
      <p class="small" style="margin:6px 0 0">${esc(CREDIT_TOPUP_HINT)}</p>
    </div>
  </section>
  ${errorBox}
  <section class="panel">
    <div class="spread">
      <h2 style="margin:0">Lịch sử sổ credit</h2>
      <div class="row">
        <button class="btn ghost tiny" data-action="ledgerreload" type="button">Tải lại</button>
      </div>
    </div>
    ${renderLedgerTable(a.ledger)}
    ${a.ledgerMore ? `<div class="row" style="margin-top:8px"><button class="btn tiny" data-action="ledgerMore" type="button">Tải thêm</button></div>` : ''}
  </section>
  <section class="panel">
    <div class="spread">
      <h2 style="margin:0">Giá theo thao tác</h2>
      <button class="btn ghost tiny" data-action="pricingreload" type="button">Tải lại</button>
    </div>
    <p class="muted small">Đơn giá credit cho từng thao tác (máy chủ là nguồn giá duy nhất).</p>
    ${renderPricingTable(a.pricing)}
  </section>`;
}

function renderAccountPage() {
  state.view = 'account';
  app.innerHTML = renderAccountBody();
}

async function openAccount() {
  state.view = 'account';
  stopPolling();
  stopIlPolling();
  stopIsPolling();
  // Hỏi máy chủ MỖI lần vào trang: phiên có thể đã hết hạn hoặc số dư vừa đổi — không đoán.
  await loadMe();
  renderAccountPage();
  await Promise.all([loadLedger(true), loadPricing(true)]);
}

async function loadLedger(reset = false) {
  const a = state.auth;
  if (a.ledgerLoading) return;
  if (!currentUser()) {
    a.ledger = [];
    if (state.view === 'account') renderAccountPage();
    return;
  }
  a.ledgerLoading = true;
  if (reset) {
    a.ledger = null;
    a.ledgerOffset = 0;
    a.ledgerMore = false;
  }
  try {
    const data = await api(`/api/billing/ledger?limit=${LEDGER_PAGE_SIZE}&offset=${a.ledgerOffset}`);
    const items = Array.isArray(data?.items) ? data.items : [];
    a.ledger = a.ledger ? [...a.ledger, ...items] : items;
    a.ledgerOffset = a.ledger.length;
    a.ledgerMore = items.length >= LEDGER_PAGE_SIZE;
    if (data?.balance) {
      a.me = { ...(a.me || { user: currentUser(), anonymous: false }), balance: data.balance };
      paintAccountBar();
    }
    a.error = null;
  } catch (err) {
    a.error = apiErrorText(err);
    if (err?.status === 401) {
      // Phiên THẬT SỰ hết hạn ⇒ không giữ giao diện ở trạng thái “đã đăng nhập” nữa.
      a.me = { user: null, anonymous: true, balance: null };
      a.loaded = true;
      a.ledger = [];
      a.formNotice = 'Phiên đăng nhập đã hết hạn — hãy đăng nhập lại.';
      paintAccountBar();
    }
  } finally {
    a.ledgerLoading = false;
  }
  if (state.view === 'account') renderAccountPage();
}

async function loadPricing(force = false) {
  const a = state.auth;
  if (a.pricingLoading) return;
  if (!force && a.pricing) return;
  a.pricingLoading = true;
  try {
    const data = await api('/api/billing/pricing');
    a.pricing = Array.isArray(data?.pricing) ? data.pricing : [];
  } catch (err) {
    a.pricing = [];
    a.error = apiErrorText(err);
  } finally {
    a.pricingLoading = false;
  }
  if (state.view === 'account') renderAccountPage();
}

/* ── Trang Quản trị (#/quantri) — CHỈ owner/admin ─────────────────────────── */

function usageColumns(rows) {
  const cols = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) if (!cols.includes(key)) cols.push(key);
    if (cols.length >= 8) break;
  }
  return cols;
}

function usageColumnLabel(key) {
  const k = String(key ?? '');
  return USAGE_COLUMN_LABEL[k] || k;
}

/** Một ô của bảng usage. `opts.group` cho biết cột nhóm (`group`/`bucket`) đang chứa gì — A2/A3
 *  dùng CHUNG một cột nhóm cho cả 3 kiểu gộp — và `opts.emailOf` để đổi user_id thành email. */
function usageCellText(key, value, opts = {}) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return fmtAmount(value);
  if (typeof value === 'boolean') return value ? 'có' : 'không';
  const k = String(key || '').toLowerCase();
  const group = String(opts.group || '');
  const isGroupCol = k === 'group' || k === 'bucket';
  const isUserCol = k === 'user_id' || k === 'owner_id' || (isGroupCol && group === 'user');
  if (k === 'operation' || (isGroupCol && group === 'operation')) return operationLabel(value);
  if (isUserCol) return String((typeof opts.emailOf === 'function' ? opts.emailOf(value) : null) || value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function usageDateDefaults() {
  const now = new Date();
  const from = new Date(now.getTime() - 6 * 24 * 3600 * 1000);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(from), to: iso(now) };
}

function renderAdminUsers() {
  const a = state.auth;
  if (a.users === null || a.users === undefined) return '<p class="muted small">Đang tải danh sách người dùng…</p>';
  if (!a.users.length) return '<p class="muted small">Chưa có người dùng nào.</p>';
  const rows = a.users.map((u) => {
    const id = String(u?.id || '');
    const balance = u?.balance !== undefined && u?.balance !== null
      ? (typeof u.balance === 'object' ? u.balance : { amount: u.balance, currency: u.currency })
      : null;
    const roles = ['owner', 'admin', 'member'];
    const selected = a.roleDraft?.[id] || u?.role || 'member';
    const options = roles.map((r) => `<option value="${esc(r)}"${r === selected ? ' selected' : ''}>${esc(roleLabel(r))}</option>`).join('');
    return `<tr>
      <td>${esc(u?.email)}${u?.display_name ? `<div class="muted small">${esc(u.display_name)}</div>` : ''}</td>
      <td><span class="badge ${isAdminRole(u?.role) ? 'ok' : ''}">${esc(roleLabel(u?.role))}</span></td>
      <td>${esc(userStatusLabel(u?.status))}${balance ? `<div class="muted small">${esc(creditText(balance))}</div>` : ''}</td>
      <td class="mono small">${esc(id)}</td>
      <td>
        <div class="row">
          <select class="text-input mini" data-role-user="${esc(id)}" aria-label="Vai trò của ${esc(u?.email)}">${options}</select>
          <button class="btn tiny" data-action="rolesave" data-user="${esc(id)}" type="button">Lưu vai trò</button>
          <button class="btn tiny ghost" data-action="creditopen" data-user="${esc(id)}" data-email="${esc(u?.email || id)}" type="button">Cấp credit</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  return `<div class="il-tablewrap"><table class="evidence admin-table">
    <thead><tr><th>Email</th><th>Vai trò</th><th>Trạng thái</th><th>ID</th><th>Hành động</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderAdminCreditForm() {
  const a = state.auth;
  const target = a.creditTarget;
  if (!target) return '';
  const draft = a.creditDraft || { amount: '', note: '' };
  const confirmBox = a.creditConfirm
    ? `<div class="notice warn" id="credit-confirm">
        <strong>Xác nhận: cấp ${esc(fmtAmount(a.creditConfirm.amount))} credit cho ${esc(a.creditConfirm.email)}?</strong>
        <p class="small" style="margin:6px 0 0">Ghi chú: ${esc(a.creditConfirm.note || '(không có)')}</p>
        <p class="small" style="margin:6px 0 0">Việc này ghi THÊM một dòng sổ (append-only) — không sửa, không xoá được.
        Số dư không bao giờ âm: máy chủ từ chối nếu khoản trừ làm số dư âm.</p>
        <div class="row" style="margin-top:8px">
          <button class="btn primary tiny" data-action="creditgrant" data-user="${esc(target.userId)}" type="button"${a.adminBusy ? ' disabled' : ''}>XÁC NHẬN CẤP</button>
          <button class="btn ghost tiny" data-action="creditcancel" type="button">Huỷ</button>
        </div>
      </div>`
    : `<div class="row" style="margin-top:6px">
        <button class="btn tiny" data-action="creditreview" type="button">Xem lại &amp; xác nhận</button>
        <button class="btn ghost tiny" data-action="creditcancel" type="button">Đóng</button>
      </div>`;
  return `<section class="panel" id="credit-form">
    <h2>Cấp credit cho ${esc(target.email || target.userId)}</h2>
    <p class="muted small">${esc(CREDIT_HONEST_NOTE)}</p>
    <div class="field">
      <div class="field-head"><label for="credit-amount">Số credit (dương = cấp thêm, âm = điều chỉnh giảm)</label></div>
      <input class="text-input" id="credit-amount" type="number" step="0.01" value="${esc(draft.amount)}" />
    </div>
    <div class="field">
      <div class="field-head"><label for="credit-note">Ghi chú (vì sao cấp)</label></div>
      <input class="text-input" id="credit-note" type="text" maxlength="200" value="${esc(draft.note)}" placeholder="Ví dụ: tặng credit thử nghiệm" />
    </div>
    ${confirmBox}
  </section>`;
}

function renderAdminUsage() {
  const a = state.auth;
  const rows = a.usage;
  if (rows === null || rows === undefined) return '<p class="muted small">Đang tải số liệu sử dụng…</p>';
  if (!rows.length) return '<p class="muted small">Không có số liệu trong khoảng đã chọn.</p>';
  const cols = usageColumns(rows);
  if (!cols.length) return '<p class="muted small">Máy chủ trả về dữ liệu không có cột nào để hiện.</p>';
  const group = a.usageGroup || 'day';
  // Có danh sách người dùng ⇒ đổi user_id thành email cho dễ đọc (không có thì hiện id thật).
  const emailOf = (id) => (Array.isArray(a.users) ? a.users.find((u) => u?.id === id)?.email || null : null);
  const head = cols.map((c) => `<th>${esc(usageColumnLabel(c))}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => `<td class="small">${esc(usageCellText(c, r?.[c], { group, emailOf }))}</td>`).join('')}</tr>`).join('');
  return `<div class="il-tablewrap"><table class="evidence admin-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderAdminBody() {
  const user = currentUser();
  if (!user) {
    return `<section class="panel">
      <h2>Quản trị</h2>
      <div class="notice error"><strong>Bạn chưa đăng nhập (401).</strong>
        <p class="small" style="margin:6px 0 0">Trang quản trị yêu cầu tài khoản vai trò owner/admin.</p></div>
      <div class="row">
        <button class="btn primary" data-action="login" type="button">Đăng nhập</button>
        <button class="btn ghost" data-action="home" type="button">Về trang chủ</button>
      </div>
    </section>`;
  }
  if (!isAdminRole(user.role)) {
    return `<section class="panel">
      <h2>Quản trị</h2>
      <div class="notice error"><strong>Không có quyền (403).</strong>
        <p class="small" style="margin:6px 0 0">Tài khoản ${esc(user.email)} có vai trò ${esc(roleLabel(user.role))} —
        chỉ owner/admin mới vào được trang này. Giao diện ẩn link “Quản trị” với vai trò member;
        vào bằng URL trực tiếp thì máy chủ vẫn chặn (403).</p></div>
      <button class="btn ghost" data-action="account" type="button">Về trang Tài khoản</button>
    </section>`;
  }
  const a = state.auth;
  const noticeBox = a.adminNotice ? `<div class="notice ok" id="admin-notice">${esc(a.adminNotice)}</div>` : '';
  const errorBox = a.adminError ? `<div class="notice error" id="admin-error">${esc(a.adminError)}</div>` : '';
  const groups = ['day', 'operation', 'user'].map((g) =>
    `<option value="${esc(g)}"${g === a.usageGroup ? ' selected' : ''}>${esc(USAGE_GROUP_LABEL[g] || g)}</option>`).join('');
  return `<section class="panel">
    <div class="spread">
      <div style="min-width:0">
        <h2 style="margin:0 0 4px">Quản trị</h2>
        <p class="muted small" style="margin:0">${esc(CREDIT_HONEST_NOTE)}</p>
      </div>
      <span class="badge ok">${esc(user.email)} · ${esc(roleLabel(user.role))}</span>
    </div>
  </section>
  ${noticeBox}${errorBox}
  <section class="panel">
    <div class="spread">
      <h2 style="margin:0">Người dùng${a.usersTotal !== null && a.usersTotal !== undefined ? ` (${esc(fmtAmount(a.usersTotal))})` : ''}</h2>
      <button class="btn ghost tiny" data-action="usersreload" type="button">Tải lại</button>
    </div>
    ${renderAdminUsers()}
    ${a.usersMore ? `<div class="row" style="margin-top:8px"><button class="btn tiny" data-action="usersMore" type="button">Tải thêm</button></div>` : ''}
  </section>
  ${renderAdminCreditForm()}
  <section class="panel">
    <h2>Số liệu sử dụng</h2>
    <div class="row">
      <label class="small muted" for="admin-usage-group">Nhóm theo</label>
      <select class="text-input mini" id="admin-usage-group">${groups}</select>
      <label class="small muted" for="admin-usage-from">Từ ngày</label>
      <input class="text-input mini" id="admin-usage-from" type="date" value="${esc(a.usageFrom)}" />
      <label class="small muted" for="admin-usage-to">Đến ngày</label>
      <input class="text-input mini" id="admin-usage-to" type="date" value="${esc(a.usageTo)}" />
      <button class="btn tiny" data-action="usageload" type="button">Xem</button>
    </div>
    ${renderAdminUsage()}
  </section>`;
}

function renderAdminPage() {
  state.view = 'admin';
  app.innerHTML = renderAdminBody();
}

async function openAdmin() {
  state.view = 'admin';
  stopPolling();
  stopIlPolling();
  stopIsPolling();
  // Vai trò có thể vừa bị đổi ở nơi khác ⇒ luôn hỏi máy chủ trước khi quyết định có gọi API quản trị.
  await loadMe();
  const d = usageDateDefaults();
  if (!state.auth.usageFrom) state.auth.usageFrom = d.from;
  if (!state.auth.usageTo) state.auth.usageTo = d.to;
  renderAdminPage();
  if (canAdmin()) await Promise.all([loadAdminUsers(true), loadAdminUsage(true)]);
}

async function loadAdminUsers(reset = false) {
  const a = state.auth;
  if (a.usersLoading) return;
  a.usersLoading = true;
  if (reset) {
    a.users = null;
    a.usersOffset = 0;
  }
  try {
    const data = await api(`/api/admin/users?limit=${ADMIN_PAGE_SIZE}&offset=${a.usersOffset}`);
    const items = Array.isArray(data?.items) ? data.items : [];
    const hadList = Array.isArray(a.users);
    a.users = hadList && !reset ? [...a.users, ...items] : items;
    a.usersOffset = a.users.length;
    a.usersTotal = Number.isFinite(Number(data?.total)) ? Number(data.total) : a.users.length;
    a.usersMore = items.length >= ADMIN_PAGE_SIZE;
    a.adminError = null;
  } catch (err) {
    a.adminError = apiErrorText(err);
    a.users = [];
    a.usersMore = false;
    if (err?.status === 401) a.formNotice = 'Phiên đăng nhập đã hết hạn — hãy đăng nhập lại.';
  } finally {
    a.usersLoading = false;
  }
  if (state.view === 'admin') renderAdminPage();
}

async function loadAdminUsage(reset = false) {
  const a = state.auth;
  if (a.usageLoading) return;
  a.usageLoading = true;
  if (reset) a.usage = null;
  const params = new URLSearchParams({ group_by: a.usageGroup || 'day' });
  if (a.usageFrom) params.set('from', a.usageFrom);
  if (a.usageTo) params.set('to', a.usageTo);
  try {
    const data = await api(`/api/admin/usage?${params.toString()}`);
    a.usage = Array.isArray(data?.rows) ? data.rows : [];
    a.adminError = null;
  } catch (err) {
    a.adminError = apiErrorText(err);
    a.usage = [];
  } finally {
    a.usageLoading = false;
  }
  if (state.view === 'admin') renderAdminPage();
}

function openCreditForm(userId, email) {
  if (!userId) return;
  state.auth.creditTarget = { userId: String(userId), email: String(email || userId) };
  state.auth.creditDraft = { amount: '', note: '' };
  state.auth.creditConfirm = null;
  state.auth.adminError = null;
  state.auth.adminNotice = null;
  renderAdminPage();
}

function reviewCreditGrant() {
  const a = state.auth;
  const target = a.creditTarget;
  if (!target) return;
  const amountRaw = String($('#credit-amount')?.value ?? a.creditDraft?.amount ?? '').trim();
  const note = String($('#credit-note')?.value ?? a.creditDraft?.note ?? '').trim();
  a.creditDraft = { amount: amountRaw, note };
  const amount = Number(amountRaw.replace(',', '.'));
  if (!amountRaw || !Number.isFinite(amount) || amount === 0) {
    a.adminError = 'Số credit phải là một số khác 0 (ví dụ 5 hoặc -2.5).';
    a.creditConfirm = null;
    renderAdminPage();
    return;
  }
  a.adminError = null;
  a.adminNotice = null;
  a.creditConfirm = { userId: target.userId, email: target.email || target.userId, amount, note };
  renderAdminPage();
}

async function grantCredit(userId) {
  const a = state.auth;
  const conf = a.creditConfirm;
  if (!conf || a.adminBusy) return;
  a.adminBusy = true;
  a.adminError = null;
  a.adminNotice = null;
  renderAdminPage();
  try {
    const res = await api(`/api/admin/users/${encodeURIComponent(userId)}/credit`, {
      method: 'POST',
      body: { amount: conf.amount, note: conf.note || '' },
    });
    a.adminNotice = `Đã cấp ${fmtAmount(conf.amount)} credit cho ${conf.email}. Số dư mới: ${creditText(res?.balance)}.`;
    a.creditConfirm = null;
    a.creditTarget = null;
    a.creditDraft = { amount: '', note: '' };
    a.users = null; // danh sách có thể kèm số dư ⇒ nạp lại cho thật
    await loadMe();
  } catch (err) {
    a.adminError = apiErrorText(err);
    if (err?.code === 'INSUFFICIENT_CREDIT') a.creditConfirm = null;
  } finally {
    a.adminBusy = false;
  }
  renderAdminPage();
  paintAccountBar();
}

async function saveRole(userId) {
  const a = state.auth;
  if (!userId || a.adminBusy) return;
  const user = (Array.isArray(a.users) ? a.users : []).find((u) => u?.id === userId) || null;
  const role = a.roleDraft?.[userId] || user?.role || '';
  if (!role) {
    a.adminError = 'Hãy chọn vai trò trước khi lưu.';
    renderAdminPage();
    return;
  }
  if (user && role === user.role) {
    a.adminError = null;
    a.adminNotice = `Vai trò của ${user.email} vẫn là ${roleLabel(role)} — không có gì thay đổi.`;
    renderAdminPage();
    return;
  }
  a.adminBusy = true;
  a.adminError = null;
  a.adminNotice = null;
  renderAdminPage();
  try {
    const res = await api(`/api/admin/users/${encodeURIComponent(userId)}/role`, { method: 'POST', body: { role } });
    const updated = res?.user || { ...(user || { id: userId }), role };
    if (Array.isArray(a.users)) a.users = a.users.map((u) => (u?.id === updated.id ? { ...u, ...updated } : u));
    if (a.roleDraft) delete a.roleDraft[userId];
    a.adminNotice = `Đã đổi vai trò của ${updated.email || userId} thành ${roleLabel(updated.role)}.`;
    if (currentUser()?.id === updated.id) await loadMe();
  } catch (err) {
    a.adminError = apiErrorText(err);
  } finally {
    a.adminBusy = false;
  }
  renderAdminPage();
  paintAccountBar();
}

/* ── Phiên: tải / đăng xuất ───────────────────────────────────────────────── */

async function loadMe() {
  const a = state.auth;
  a.loading = true;
  try {
    const data = await api('/api/auth/me');
    a.me = { user: data?.user || null, anonymous: data?.anonymous !== false, balance: data?.balance || null };
    a.error = null;
    a.loaded = true;
  } catch (err) {
    // Chưa nối được API xác thực (A4 chưa xong / mạng lỗi) ⇒ vẫn là khách ẩn danh, nhưng NÓI THẬT
    // là chưa kiểm tra được phiên — không im lặng giả vờ.
    if (!a.me?.user) a.me = { user: null, anonymous: true, balance: null };
    a.loaded = true;
    a.error = apiErrorText(err);
  } finally {
    a.loading = false;
  }
  paintAccountBar();
  return a.me;
}

/** Đăng xuất: gọi API THẬT + xoá state riêng tư (không để lại dữ liệu của người vừa thoát). */
function clearPrivateState() {
  const a = state.auth;
  a.me = { user: null, anonymous: true, balance: null };
  a.loaded = true;
  a.ledger = null;
  a.ledgerOffset = 0;
  a.ledgerMore = false;
  a.pricing = null;
  a.users = null;
  a.usersOffset = 0;
  a.usersTotal = null;
  a.usage = null;
  a.creditTarget = null;
  a.creditConfirm = null;
  a.creditDraft = { amount: '', note: '' };
  a.roleDraft = {};
  a.form = { email: '', display_name: '' };
  a.formError = null;
  a.formNotice = null;
  a.adminError = null;
  a.adminNotice = null;
  state.job = null;
  state.jobId = null;
  state.history = [];
  state.il.job = null;
  state.il.jobId = null;
  state.il.pending = null;
  isReset();
  ilManualReset();
  state.creditAlert = null;
}

async function doLogout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    toast(`Máy chủ báo lỗi khi đăng xuất: ${apiErrorText(err)}`);
  }
  clearPrivateState();
  paintAccountBar();
  paintCreditAlert();
  toast('Đã đăng xuất — bạn đang ở chế độ khách ẩn danh.');
  // Về trang chủ: đổi hash cho lịch sử trình duyệt, VÀ tự vẽ (có trình duyệt không phát hashchange).
  if (String(location.hash || '') !== '#/' && String(location.hash || '') !== '') location.hash = '#/';
  renderHome();
}

/* ── Nối sự kiện cho khối tài khoản (chỉ gắn một lần) ─────────────────────── */

function wireAuthGlobal() {
  document.addEventListener('submit', (ev) => {
    if (ev.target?.id === 'auth-form') {
      ev.preventDefault();
      submitAuthForm();
    }
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t?.id) return;
    // Giữ bản nháp để render lại không mất chữ. Mật khẩu KHÔNG bao giờ vào state.
    if (t.id === 'auth-email') state.auth.form.email = String(t.value ?? '');
    else if (t.id === 'auth-name') state.auth.form.display_name = String(t.value ?? '');
    else if (t.id === 'credit-amount') state.auth.creditDraft.amount = String(t.value ?? '');
    else if (t.id === 'credit-note') state.auth.creditDraft.note = String(t.value ?? '');
    // MVP-08 — giữ bản nháp form đăng sàn (`mk-<ten-truong>` → `state.mk.draft.<ten_truong>`).
    else if (t.id === 'mk-reject-reason') state.mk.rejectDraft = String(t.value ?? '');
    else if (t.id.startsWith('mk-')) {
      const key = t.id.slice(3).replace(/-/g, '_');
      if (Object.prototype.hasOwnProperty.call(state.mk.draft, key)) state.mk.draft[key] = String(t.value ?? '');
    }
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.dataset?.roleUser) {
      state.auth.roleDraft[t.dataset.roleUser] = String(t.value || '');
      return;
    }
    if (t.id === 'admin-usage-group') {
      state.auth.usageGroup = String(t.value || 'day');
      loadAdminUsage(true);
    } else if (t.id === 'admin-usage-from') {
      state.auth.usageFrom = String(t.value || '');
    } else if (t.id === 'admin-usage-to') {
      state.auth.usageTo = String(t.value || '');
    }
  });
}

boot();

/* ═════════════════════ MVP-08 — Tab “Đăng sàn” (hợp đồng §5) ═════════════════════
 *
 * Luật UI (docs/UI-HANDOVER.md §3): không dependency, `esc()` mọi text động (tiêu đề, mã lỗi của sàn,
 * `issues[]`, `external_id`…), KHÔNG nói quá sự thật (kênh `dry-run` ⇒ băng “CHẾ ĐỘ THỬ — không đăng
 * thật”; kênh chưa cấu hình ⇒ “chưa có token…”), nút khoá kèm LÝ DO khi thiếu quyền/thiếu điều kiện,
 * lỗi thật hiện ra (mã + câu tiếng Việt), `issues[]` hiện TỪNG DÒNG.
 */

const MK_STATUS_LABEL = {
  draft: 'Nháp',
  pending_review: 'Chờ duyệt',
  approved: 'Đã duyệt — chưa đăng',
  publishing: 'Đang đăng…',
  published: 'Đã đăng',
  failed: 'Đăng lỗi',
  rejected: 'Bị từ chối',
};
const MK_STATUS_CLASS = { draft: '', pending_review: 'warn', approved: 'ok', publishing: 'warn', published: 'ok', failed: 'error', rejected: 'error' };

const MK_DRY_RUN_BANNER = 'CHẾ ĐỘ THỬ — không đăng thật';

const MK_ERROR_HINT = {
  PREFLIGHT_FAILED: 'Chưa đủ dữ liệu để đăng — xem từng dòng lỗi kiểm tra bên dưới.',
  CHANNEL_NOT_CONFIGURED: 'Kênh này chưa có token (cần tài khoản người bán được duyệt).',
  CHANNEL_UNKNOWN: 'Kênh không hợp lệ.',
  NOT_APPROVED: 'Bài phải được DUYỆT trước khi đăng.',
  LISTING_ALREADY_DECIDED: 'Bài đã được quyết định trước đó.',
  PUBLISH_IN_PROGRESS: 'Bài đang được đăng bởi một lượt khác — chờ rồi tải lại.',
  ATTEMPTS_EXCEEDED: 'Đã thử đăng quá số lần cho phép — dừng để không spam sàn.',
  MARKETPLACE_ERROR: 'Sàn từ chối — xem mã lỗi và nội dung nguyên văn bên dưới.',
  LISTING_NOT_FOUND: 'Không tìm thấy bài này.',
  SYNC_UNAVAILABLE: 'Bài chưa có mã trên sàn nên chưa đồng bộ được.',
  MARKETPLACE_UNAVAILABLE: 'Máy chủ chưa bật được chức năng đăng sàn.',
  REASON_REQUIRED: 'Từ chối phải có lý do.',
  BAD_JOB_ID: 'Hãy chọn một job nguồn.',
};

/** Khối `/api/config.marketplace` — `null` ⇒ máy chủ chưa nạp được module (UI nói thật). */
function mkConfig() {
  const m = state.config?.marketplace;
  return m && typeof m === 'object' ? m : null;
}

function mkChannelInfo(name) {
  const list = Array.isArray(mkConfig()?.channels) ? mkConfig().channels : [];
  return list.find((c) => c?.name === name) || null;
}

function mkStatusLabel(status) {
  const key = String(status ?? '');
  return MK_STATUS_LABEL[key] || key || 'Không rõ';
}

function mkVnd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n).toLocaleString('vi-VN')} ₫`;
}

/** Câu tiếng Việt cho lỗi MVP-08; mã lạ ⇒ dùng câu THẬT của máy chủ. */
function mkErrorText(err) {
  const hint = MK_ERROR_HINT[String(err?.code ?? '')];
  const server = apiErrorText(err);
  return hint ? `${hint} (${server})` : server;
}

/**
 * Băng nói thật cho một kênh: `dry-run` ⇒ “CHẾ ĐỘ THỬ — không đăng thật”; chưa cấu hình ⇒ câu của
 * máy chủ (“chưa có token Shopee/TikTok Shop…”); có cấu hình nhưng chưa bật live ⇒ nói rõ.
 */
function mkBannerHtml(channel) {
  const info = mkChannelInfo(channel);
  if (!info) return `<div class="notice warn"><strong>Kênh ${esc(channel || '?')}:</strong> máy chủ không khai kênh này.</div>`;
  if (info.is_mock) {
    // Câu của máy chủ thường đã mở đầu bằng đúng băng này ⇒ bỏ phần trùng để không lặp hai lần.
    const rest = String(info.notice || 'Không gửi gì lên sàn; mã bài có tiền tố "dry-".').replace(/^CHẾ ĐỘ THỬ — không đăng thật\.?\s*/i, '');
    return `<div class="notice warn" data-mk-banner="dry-run"><strong>${esc(MK_DRY_RUN_BANNER)}.</strong> ${esc(rest)}</div>`;
  }
  if (info.error) {
    return `<div class="notice error" data-mk-banner="broken"><strong>Kênh ${esc(info.name)} lỗi khởi tạo (${esc(info.error.code)}).</strong> ${esc(info.error.message || '')}</div>`;
  }
  if (!info.configured) {
    return `<div class="notice error" data-mk-banner="not-configured"><strong>Kênh ${esc(info.name)}: ${esc(info.notice || 'chưa có token')}.</strong> Tạo được bài và duyệt được, nhưng KHÔNG đăng được cho tới khi quản trị cấu hình.</div>`;
  }
  if (mkConfig()?.live_enabled !== true) {
    return `<div class="notice warn" data-mk-banner="live-off"><strong>Kênh ${esc(info.name)} đã có cấu hình nhưng chưa bật gọi sàn thật</strong> (MARKETPLACE_LIVE_ENABLED=false). ${esc(info.notice || '')}</div>`;
  }
  return `<div class="notice ok" data-mk-banner="live"><strong>Kênh ${esc(info.name)} — gọi API THẬT.</strong> ${esc(info.notice || '')} Mỗi lần ĐĂNG là một lời gọi lên sàn thật.</div>`;
}

/** `issues[]` hiện TỪNG DÒNG: trường · mã · câu. */
function mkIssuesHtml(issues) {
  const list = Array.isArray(issues) ? issues : [];
  if (!list.length) return '';
  const rows = list.map((i) => `<li class="small${i?.severity === 'warn' ? ' muted' : ''}" data-mk-issue="${esc(i?.field || '')}">
      <strong>${esc(i?.field || '?')}</strong> · <span class="mono">${esc(i?.code || '')}</span> — ${esc(i?.message || '')}${i?.severity === 'warn' ? ' <em>(cảnh báo, không chặn)</em>' : ''}
    </li>`).join('');
  return `<ul class="mk-issues" style="margin:6px 0 0;padding-left:18px">${rows}</ul>`;
}

function renderMkChannels() {
  const cfg = mkConfig();
  if (!cfg) {
    return `<div class="notice error"><strong>Máy chủ chưa bật được chức năng đăng sàn</strong> (không có khối <span class="mono">marketplace</span> trong /api/config).</div>`;
  }
  const chips = (cfg.channels || []).map((c) => {
    const cls = c.is_mock ? 'warn' : c.error ? 'error' : c.configured ? 'ok' : '';
    const text = c.is_mock ? 'chế độ thử' : c.error ? 'lỗi khởi tạo' : c.configured ? (cfg.live_enabled ? 'sẵn sàng (live)' : 'có cấu hình, live tắt') : 'chưa có token';
    return `<span class="badge ${esc(cls)}" title="${esc(c.notice || '')}">${esc(c.name)} · ${esc(text)}</span>`;
  }).join(' ');
  return `<div class="row" style="gap:6px;flex-wrap:wrap">${chips}</div>`;
}

function renderMkJobOptions() {
  const jobs = Array.isArray(state.mk.jobs) ? state.mk.jobs : [];
  const picked = String(state.mk.draft.job_id || '');
  const opts = jobs.map((jb) => `<option value="${esc(jb.id)}"${jb.id === picked ? ' selected' : ''}>${esc(jb.product_name || jb.source_url || jb.id)} · ${esc(jb.status || '')}</option>`).join('');
  return `<option value=""${picked ? '' : ' selected'}>— chọn job nguồn —</option>${opts}`;
}

function renderMkForm() {
  const m = state.mk;
  const cfg = mkConfig();
  if (!cfg) return '';
  const d = m.draft;
  const channels = (cfg.channels || []).map((c) => `<option value="${esc(c.name)}"${c.name === (d.channel || cfg.default_channel) ? ' selected' : ''}>${esc(c.name)}${c.is_mock ? ' (chế độ thử)' : c.configured ? '' : ' (chưa có token)'}</option>`).join('');
  const noticeBox = m.notice ? `<div class="notice ok" id="mk-notice">${esc(m.notice)}</div>` : '';
  const errorBox = m.error ? `<div class="notice error" id="mk-error">${esc(m.error)}${mkIssuesHtml(m.issues)}</div>` : '';
  const field = (id, label, type = 'text', extra = '') => `<div class="field">
      <div class="field-head"><label for="mk-${id}">${esc(label)}</label></div>
      <input class="text-input" id="mk-${id}" type="${type}" value="${esc(d[id.replace(/-/g, '_')] ?? '')}" ${extra} />
    </div>`;
  return `<section class="panel" id="mk-form">
    <h2>Tạo bài đăng sàn từ một job</h2>
    <p class="muted small">Tên và mô tả lấy từ nội dung tiếng Việt của job (MVP-01). <strong>Giá bán VND, tồn kho, cân nặng, mã danh mục</strong>
      là dữ liệu của người bán — hệ thống KHÔNG tự quy đổi giá CNY, KHÔNG đoán danh mục. Thiếu là bị chặn, không điền mặc định.</p>
    ${mkBannerHtml(d.channel || cfg.default_channel)}
    ${noticeBox}${errorBox}
    <div class="field">
      <div class="field-head"><label for="mk-job-id">Job nguồn</label></div>
      <select class="text-input" id="mk-job-id">${renderMkJobOptions()}</select>
    </div>
    <div class="field">
      <div class="field-head"><label for="mk-channel">Kênh</label></div>
      <select class="text-input" id="mk-channel">${channels}</select>
    </div>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${field('price-vnd', 'Giá bán (VND, số nguyên)', 'number', 'step="1" min="0" inputmode="numeric"')}
      ${field('stock', 'Tồn kho (cái)', 'number', 'step="1" min="0" inputmode="numeric"')}
      ${field('weight-g', 'Cân nặng (gram)', 'number', 'step="1" min="0" inputmode="numeric"')}
      ${field('category-id', 'Mã danh mục của sàn', 'text', 'placeholder="lấy từ Seller Center"')}
    </div>
    <details><summary class="small">Tuỳ chọn: thương hiệu, SKU, kích thước gói (cm), ghi đè tên/mô tả</summary>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px">
        ${field('brand', 'Thương hiệu')}
        ${field('sku', 'SKU của bạn')}
        ${field('length-cm', 'Dài (cm)', 'number', 'step="0.1" min="0"')}
        ${field('width-cm', 'Rộng (cm)', 'number', 'step="0.1" min="0"')}
        ${field('height-cm', 'Cao (cm)', 'number', 'step="0.1" min="0"')}
      </div>
      ${field('title', 'Ghi đè tên sản phẩm (để trống = lấy từ job)')}
      ${field('description', 'Ghi đè mô tả (để trống = lấy marketplace_description của job)')}
    </details>
    <div class="row" style="margin-top:8px">
      <button class="btn primary" data-action="mkcreate" type="button"${m.busy ? ' disabled' : ''}>TẠO BÀI (kiểm tra trước khi đăng)</button>
      <button class="btn ghost tiny" data-action="mkreload" type="button">Tải lại danh sách</button>
    </div>
  </section>`;
}

/** Nút kèm LÝ DO khi khoá (title + data-mk-reason) — người dùng phải biết vì sao không bấm được. */
function mkButton(action, id, label, { enabled, reason = '', cls = 'btn tiny', busy = false } = {}) {
  const off = !enabled || busy;
  return `<button class="${esc(cls)}" data-action="${esc(action)}" data-id="${esc(id)}" type="button"${off ? ' disabled' : ''}${!enabled && reason ? ` title="${esc(reason)}" data-mk-reason="${esc(reason)}"` : ''}>${esc(label)}</button>`;
}

function renderMkTable(items, { isAdmin = false } = {}) {
  if (items === null || items === undefined) return '<p class="muted small">Đang tải bài đăng sàn…</p>';
  if (!Array.isArray(items) || !items.length) return '<p class="muted small">Chưa có bài đăng sàn nào.</p>';
  const m = state.mk;
  const rows = items.map((it) => {
    const id = String(it?.id || '');
    const st = String(it?.status || '');
    const info = mkChannelInfo(it?.channel);
    const configured = Boolean(info?.configured);
    const canApprove = isAdmin && st === 'pending_review';
    const canReject = isAdmin && ['pending_review', 'approved', 'failed'].includes(st);
    const canPublish = ['approved', 'failed'].includes(st) && !it?.external_id && configured;
    const canSync = Boolean(it?.external_id) && configured && Boolean(info?.capabilities?.readListing);
    const approveReason = !isAdmin ? 'Chỉ owner/admin được duyệt' : st !== 'pending_review' ? `Bài đang ở trạng thái "${mkStatusLabel(st)}", không duyệt được` : '';
    const rejectReason = !isAdmin ? 'Chỉ owner/admin được từ chối' : `Bài đang ở trạng thái "${mkStatusLabel(st)}", không từ chối được`;
    const publishReason = it?.external_id ? 'Bài đã có mã trên sàn — không đăng lại' : !configured ? `Kênh ${it?.channel} chưa cấu hình (${info?.notice || 'chưa có token'})` : st === 'pending_review' ? 'Bài chưa được DUYỆT' : st === 'rejected' ? 'Bài đã bị từ chối' : st === 'publishing' ? 'Đang đăng' : '';
    const syncReason = !it?.external_id ? 'Chưa có mã trên sàn' : !configured ? 'Kênh chưa cấu hình' : 'Kênh không hỗ trợ đọc';
    const ext = it?.external_id
      ? (it.external_url ? `<a href="${esc(it.external_url)}" target="_blank" rel="noopener noreferrer" class="mono small">${esc(it.external_id)}</a>` : `<span class="mono small">${esc(it.external_id)}</span>`)
      : '<span class="muted">—</span>';
    const mock = it?.is_mock ? ' <span class="badge warn" title="Kết quả của chế độ thử, không có bài thật">THỬ</span>' : '';
    const err = it?.error_code ? `<div class="small" style="color:#b91c1c"><span class="mono">${esc(it.error_code)}</span> — ${esc(it.last_error || '')}</div>` : '';
    const rejectBox = m.rejectId === id
      ? `<div class="notice error" style="margin-top:6px"><strong>Lý do từ chối (bắt buộc)</strong>
          <input class="text-input" id="mk-reject-reason" type="text" maxlength="300" value="${esc(m.rejectDraft)}" />
          <div class="row" style="margin-top:6px">
            ${mkButton('mkreject', id, 'TỪ CHỐI', { enabled: true, busy: m.busy, cls: 'btn tiny' })}
            <button class="btn ghost tiny" data-action="mkcancel" type="button">Huỷ</button>
          </div></div>`
      : '';
    const snap = it?.remote_snapshot
      ? `<div class="small muted">Sàn: giá ${esc(mkVnd(it.remote_snapshot.price))} · tồn ${esc(it.remote_snapshot.stock ?? '—')}${it.remote_snapshot.is_mock ? ' (thử)' : ''} · ${esc(fmtTime(it.synced_at))}</div>`
      : '';
    return `<tr data-mk-listing="${esc(id)}">
      <td class="small">${esc(it?.title || it?.job_id || '—')}<div class="muted small mono">${esc(String(it?.job_id || '').slice(0, 8))}…</div></td>
      <td class="small">${esc(it?.channel || '')}${info?.is_mock ? ' <span class="badge warn">thử</span>' : ''}</td>
      <td><span class="badge ${esc(MK_STATUS_CLASS[st] ?? '')}">${esc(mkStatusLabel(st))}</span>${mock}${err}${mkIssuesHtml(it?.issues)}${it?.reject_reason ? `<div class="small">Lý do: ${esc(it.reject_reason)}</div>` : ''}</td>
      <td class="small mono">${esc(mkVnd(it?.price_vnd))}<br>tồn ${esc(it?.stock ?? '—')}</td>
      <td>${ext}${snap}</td>
      <td>
        <div class="row" style="gap:4px;flex-wrap:wrap">
          ${mkButton('mkpayload', id, 'XEM PAYLOAD', { enabled: true, cls: 'btn ghost tiny' })}
          ${mkButton('mkapprove', id, 'DUYỆT', { enabled: canApprove, reason: approveReason, busy: m.busy })}
          ${mkButton('mkrejectopen', id, 'TỪ CHỐI', { enabled: canReject, reason: rejectReason, busy: m.busy, cls: 'btn ghost tiny' })}
          ${mkButton('mkpublish', id, 'ĐĂNG', { enabled: canPublish, reason: publishReason, busy: m.busy, cls: 'btn primary tiny' })}
          ${mkButton('mksync', id, 'ĐỒNG BỘ', { enabled: canSync, reason: syncReason, busy: m.busy, cls: 'btn ghost tiny' })}
        </div>
        ${rejectBox}
      </td>
    </tr>`;
  }).join('');
  return `<div class="il-tablewrap"><table class="evidence mk-table">
    <thead><tr><th>Sản phẩm (job)</th><th>Kênh</th><th>Trạng thái</th><th>Giá · tồn</th><th>Mã trên sàn</th><th>Hành động</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

/** Hộp XEM PAYLOAD: payload giữ NGUYÊN + trường không ánh xạ + mặc định đã áp + vết sự kiện. */
function renderMkPayload() {
  const m = state.mk;
  if (!m.payloadId) return '';
  const d = m.payloadData;
  if (!d) return `<section class="panel" id="mk-payload"><p class="muted small">Đang tải payload…</p></section>`;
  const l = d.listing || {};
  const unmapped = (Array.isArray(l.unmapped) ? l.unmapped : []).map((u) => `<li class="small"><strong>${esc(u.field)}</strong>${u.channel ? ` <span class="muted">(${esc(u.channel)})</span>` : ''} — ${esc(u.reason)}</li>`).join('');
  const defaults = (Array.isArray(l.defaults_applied) ? l.defaults_applied : []).map((u) => `<li class="small"><strong>${esc(u.field)}</strong> = <span class="mono">${esc(String(u.value))}</span>${u.channel ? ` <span class="muted">(${esc(u.channel)})</span>` : ''} — ${esc(u.reason)}</li>`).join('');
  const events = (Array.isArray(d.events) ? d.events : []).map((e) => `<li class="small mono">${esc(fmtTime(e.created_at))} · ${esc(e.kind)}${e.to_status ? ` → ${esc(e.to_status)}` : ''}${e.detail?.error_code ? ` · ${esc(e.detail.error_code)}` : ''}</li>`).join('');
  return `<section class="panel" id="mk-payload">
    <div class="spread">
      <h2 style="margin:0">Payload gửi sàn — ${esc(l.channel || '')} · ${esc(l.title || l.id || '')}</h2>
      <button class="btn ghost tiny" data-action="mkpayloadclose" type="button">Đóng</button>
    </div>
    ${mkBannerHtml(l.channel)}
    <p class="muted small">Payload giữ NGUYÊN như sẽ gửi (trường tiền tố <span class="mono">_vps_</span> chỉ để soi, provider thật bỏ đi trước khi gửi).
      Tên trường theo tài liệu công khai của sàn, <strong>chưa đo với API thật</strong> — xem VERIFICATION.md §27.</p>
    <pre class="mono small" style="white-space:pre-wrap;max-height:360px;overflow:auto">${esc(JSON.stringify(l.payload ?? null, null, 2))}</pre>
    ${unmapped ? `<h3 class="small">Trường KHÔNG ánh xạ được (phải xử tay khi có token)</h3><ul>${unmapped}</ul>` : ''}
    ${defaults ? `<h3 class="small">Mặc định đã áp (không phải dữ liệu từ nguồn)</h3><ul>${defaults}</ul>` : ''}
    ${mkIssuesHtml(l.issues)}
    ${events ? `<h3 class="small">Vết</h3><ul>${events}</ul>` : ''}
  </section>`;
}

function renderMarketplaceBody() {
  const user = currentUser();
  if (!user) {
    return `<section class="panel">
      <h2>Đăng sàn</h2>
      <div class="notice warn"><strong>Đăng sàn cần tài khoản.</strong>
        <p class="small" style="margin:6px 0 0">Đăng lên Shopee/TikTok Shop là hành động ra ngoài, phải có người chịu trách nhiệm — khách ẩn danh không dùng được tab này (máy chủ trả 401).</p></div>
      <div class="row">
        <button class="btn primary" data-action="login" type="button">Đăng nhập / Đăng ký</button>
        <button class="btn ghost" data-action="home" type="button">Về trang chủ</button>
      </div>
    </section>`;
  }
  const m = state.mk;
  const isAdmin = isAdminRole(user.role);
  const statuses = ['', 'pending_review', 'approved', 'published', 'failed', 'rejected'].map((s) => `<option value="${esc(s)}"${s === (m.filter.status || '') ? ' selected' : ''}>${s ? esc(mkStatusLabel(s)) : 'Mọi trạng thái'}</option>`).join('');
  return `<section class="panel">
    <div class="spread">
      <div style="min-width:0">
        <h2 style="margin:0 0 4px">Đăng sàn — Shopee / TikTok Shop</h2>
        <p class="muted small" style="margin:0">Mọi bài phải được <strong>DUYỆT TAY</strong> (owner/admin) trước khi đăng. Hệ thống không bao giờ tự đăng.
          ${isAdmin ? 'Bạn là owner/admin: thấy bài của mọi người và duyệt được.' : 'Bạn chỉ thấy bài của mình; cần owner/admin duyệt.'}</p>
      </div>
    </div>
    <div style="margin-top:8px">${renderMkChannels()}</div>
  </section>
  ${renderMkForm()}
  ${renderMkPayload()}
  <section class="panel">
    <div class="spread">
      <h2 style="margin:0">Bài đăng sàn${m.total !== null && m.total !== undefined ? ` (${esc(fmtAmount(m.total))})` : ''}</h2>
      <div class="row">
        <select class="text-input mini" id="mk-filter-status">${statuses}</select>
        <button class="btn ghost tiny" data-action="mkreload" type="button">Tải lại</button>
      </div>
    </div>
    ${m.listError ? `<div class="notice error">${esc(m.listError)}</div>` : ''}
    ${renderMkTable(m.listings, { isAdmin })}
  </section>`;
}

function renderMarketplacePage() {
  state.view = 'marketplace';
  app.innerHTML = renderMarketplaceBody();
}

async function openMarketplace() {
  state.view = 'marketplace';
  stopPolling();
  stopIlPolling();
  stopIsPolling();
  await loadMe();
  renderMarketplacePage();
  if (!currentUser()) return;
  await Promise.all([loadMkJobs(), loadMkListings(true)]);
}

async function loadMkJobs() {
  const m = state.mk;
  try {
    const data = await api('/api/jobs?limit=50');
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data?.jobs) ? data.jobs : [];
    // Chỉ job NỘI DUNG đã chạy xong mới có tên + mô tả tiếng Việt để đăng.
    m.jobs = items.filter((jb) => !jb?.kind || jb.kind === 'content');
  } catch (err) {
    m.jobs = [];
    m.error = mkErrorText(err);
  }
  if (state.view === 'marketplace') renderMarketplacePage();
}

async function loadMkListings(reset = false) {
  const m = state.mk;
  if (m.loading) return;
  m.loading = true;
  if (reset) m.listings = null;
  const params = new URLSearchParams({ limit: '100' });
  if (m.filter.status) params.set('status', m.filter.status);
  try {
    const data = await api(`/api/marketplace/listings?${params.toString()}`);
    m.listings = Array.isArray(data?.items) ? data.items : [];
    m.total = Number.isFinite(Number(data?.total)) ? Number(data.total) : m.listings.length;
    m.listError = null;
  } catch (err) {
    m.listings = [];
    m.listError = err?.status === 503 ? null : mkErrorText(err);
  } finally {
    m.loading = false;
  }
  if (state.view === 'marketplace') renderMarketplacePage();
}

/** Đọc form vào bản nháp (giữ chữ khi render lại) rồi gửi `POST /api/marketplace/listings`. */
async function submitMkListing() {
  const m = state.mk;
  if (m.busy) return;
  const read = (id) => String($(`#mk-${id}`)?.value ?? m.draft[id.replace(/-/g, '_')] ?? '').trim();
  const d = {
    job_id: read('job-id'), channel: read('channel'), price_vnd: read('price-vnd'), stock: read('stock'), weight_g: read('weight-g'),
    category_id: read('category-id'), brand: read('brand'), sku: read('sku'), length_cm: read('length-cm'), width_cm: read('width-cm'),
    height_cm: read('height-cm'), title: read('title'), description: read('description'),
  };
  m.draft = { ...m.draft, ...d };
  if (!d.job_id) {
    m.error = MK_ERROR_HINT.BAD_JOB_ID;
    m.issues = null;
    m.notice = null;
    renderMarketplacePage();
    return;
  }
  const num = (v) => (v === '' ? undefined : Number(v));
  const overrides = {
    ...(d.price_vnd !== '' ? { price_vnd: num(d.price_vnd) } : {}),
    ...(d.stock !== '' ? { stock: num(d.stock) } : {}),
    ...(d.weight_g !== '' ? { weight_g: num(d.weight_g) } : {}),
    ...(d.category_id ? { category_id: d.category_id } : {}),
    ...(d.brand ? { brand: d.brand } : {}),
    ...(d.sku ? { sku: d.sku } : {}),
    ...(d.length_cm !== '' ? { length_cm: num(d.length_cm) } : {}),
    ...(d.width_cm !== '' ? { width_cm: num(d.width_cm) } : {}),
    ...(d.height_cm !== '' ? { height_cm: num(d.height_cm) } : {}),
    ...(d.title ? { title: d.title } : {}),
    ...(d.description ? { description: d.description } : {}),
  };
  m.busy = true;
  m.error = null;
  m.issues = null;
  m.notice = null;
  renderMarketplacePage();
  try {
    const data = await api('/api/marketplace/listings', { method: 'POST', body: { job_id: d.job_id, channel: d.channel || undefined, overrides } });
    const warns = Array.isArray(data?.issues) ? data.issues.length : 0;
    m.notice = data?.idempotent
      ? `Bài cho job này trên kênh ${d.channel || mkConfig()?.default_channel} đã có từ trước — trả lại bài cũ (không tạo trùng).`
      : `Đã tạo bài (${mkStatusLabel(data?.listing?.status)})${warns ? ` — ${warns} cảnh báo không chặn, xem ở bảng` : ''}. Chờ owner/admin DUYỆT rồi mới ĐĂNG được.`;
  } catch (err) {
    m.error = mkErrorText(err);
    // 422 PREFLIGHT_FAILED: issues[] nằm trong details — hiện TỪNG DÒNG ngay dưới form.
    m.issues = Array.isArray(err?.payload?.details?.issues) ? err.payload.details.issues : null;
  } finally {
    m.busy = false;
  }
  renderMarketplacePage();
  await loadMkListings(true);
}

async function mkDecide(id, { reject = false } = {}) {
  const m = state.mk;
  if (!id || m.busy) return;
  const reason = reject ? String($('#mk-reject-reason')?.value ?? m.rejectDraft ?? '').trim() : '';
  if (reject && !reason) {
    m.listError = MK_ERROR_HINT.REASON_REQUIRED;
    renderMarketplacePage();
    return;
  }
  m.busy = true;
  m.listError = null;
  renderMarketplacePage();
  try {
    const data = await api(`/api/marketplace/listings/${encodeURIComponent(id)}/${reject ? 'reject' : 'approve'}`, { method: 'POST', body: reject ? { reason } : {} });
    m.notice = reject ? `Đã TỪ CHỐI bài ${id}.` : `Đã DUYỆT bài ${id} — giờ mới bấm ĐĂNG được (${mkStatusLabel(data?.listing?.status)}).`;
    m.rejectId = null;
    m.rejectDraft = '';
  } catch (err) {
    m.listError = mkErrorText(err);
  } finally {
    m.busy = false;
  }
  renderMarketplacePage();
  await loadMkListings(true);
}

async function mkPublish(id) {
  const m = state.mk;
  if (!id || m.busy) return;
  m.busy = true;
  m.listError = null;
  renderMarketplacePage();
  try {
    const data = await api(`/api/marketplace/listings/${encodeURIComponent(id)}/publish`, { method: 'POST' });
    const info = mkChannelInfo(data?.listing?.channel);
    m.notice = data?.idempotent
      ? `Bài ${id} đã có mã trên sàn từ trước (${data?.external_id}) — không gọi sàn lại.`
      : data?.is_mock
        ? `${MK_DRY_RUN_BANNER}: đã "đăng" ở chế độ thử, mã ${data?.external_id}. KHÔNG có bài thật trên sàn nào.`
        : `Đã đăng lên ${info?.name || data?.listing?.channel}: mã ${data?.external_id}${data?.url ? ` · ${data.url}` : ''}.`;
  } catch (err) {
    // 502 MARKETPLACE_ERROR: giữ mã + nguyên văn của sàn, không nuốt.
    const raw = err?.payload?.details?.raw;
    const code = err?.payload?.details?.error_code;
    m.listError = `${mkErrorText(err)}${code ? ` · mã sàn: ${code}` : ''}${raw ? ` · nguyên văn: ${JSON.stringify(raw).slice(0, 400)}` : ''}`;
  } finally {
    m.busy = false;
  }
  renderMarketplacePage();
  await loadMkListings(true);
}

async function mkSync(id) {
  const m = state.mk;
  if (!id || m.busy) return;
  m.busy = true;
  m.listError = null;
  renderMarketplacePage();
  try {
    const data = await api(`/api/marketplace/listings/${encodeURIComponent(id)}/sync`, { method: 'POST' });
    const s = data?.snapshot || {};
    m.notice = `Đã đọc từ sàn${data?.is_mock ? ' (chế độ thử)' : ''}: giá ${mkVnd(s.price)} · tồn ${s.stock ?? '—'}. Hệ thống chỉ ĐỌC để đối chiếu, không sửa gì trên sàn.`;
  } catch (err) {
    m.listError = mkErrorText(err);
  } finally {
    m.busy = false;
  }
  renderMarketplacePage();
  await loadMkListings(true);
}

async function mkShowPayload(id) {
  const m = state.mk;
  if (!id) return;
  m.payloadId = id;
  m.payloadData = null;
  renderMarketplacePage();
  try {
    m.payloadData = await api(`/api/marketplace/listings/${encodeURIComponent(id)}`);
  } catch (err) {
    m.payloadId = null;
    m.listError = mkErrorText(err);
  }
  renderMarketplacePage();
  $('#mk-payload')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}
