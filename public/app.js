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
  // MVP-03 (§3.7) — tab thứ ba “Tạo ảnh”, route hash riêng: `#/taoanh` và `#/taoanh/:id`.
  const isMatch = /^#\/taoanh(?:\/([A-Za-z0-9_-]+))?/.exec(hash);
  if (isMatch) {
    stopPolling();
    stopIlPolling();
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
    openJob(jobMatch[1]);
    return;
  }
  if (hash.startsWith('#/history')) {
    renderHistory();
    return;
  }
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
  const mockSteps = Array.isArray(item.mock_steps) ? item.mock_steps : [];
  const mockBadge = (item.mock || mockSteps.length)
    ? `<span class="badge warn" title="${esc(`Bước chạy provider MOCK: ${mockSteps.join(', ') || 'có'}`)}">MOCK</span>`
    : '';
  const kindBadge = isImagelab ? '<span class="badge">Dịch ảnh</span>' : '';
  return `
    <button class="hist-item" data-action="openjob" data-id="${esc(item.id)}">
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
        ? renderIlJob()
        : renderIlUpload()
      : `<section class="panel"><div class="notice error"><strong>Tính năng dịch ảnh chưa sẵn sàng trên máy chủ này (IMAGELAB_UNAVAILABLE).</strong>
           <p style="margin:6px 0 0">Lý do máy chủ báo: ${esc(il.reason || 'không nêu lý do — xem log máy chủ (imagelab.wiring_failed).')}</p>
           <p style="margin:6px 0 0">Các tính năng MVP-01 vẫn dùng bình thường.</p></div></section>`}
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

function renderIlJob() {
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
function renderImagestudioBody() {
  const cfg = state.config?.imagestudio || {};
  const available = cfg.available !== false;
  const job = state.is?.job;
  return `
    ${isHeaderPanel()}
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
  app.innerHTML = renderImagestudioBody();
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

boot();
