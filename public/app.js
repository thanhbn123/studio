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
  const ilMatch = /^#\/imagelab(?:\/([A-Za-z0-9_-]+))?/.exec(hash);
  if (ilMatch) {
    stopPolling();
    if (ilMatch[1]) {
      openImagelabJob(ilMatch[1]);
    } else {
      stopIlPolling();
      state.il.job = null;
      state.il.jobId = null;
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
    ilnew: () => {
      stopIlPolling();
      state.il.job = null;
      state.il.jobId = null;
      state.il.pending = null;
      state.il.overrides = new Set();
      state.il.lastSave = null;
      state.il.renderBlocked = null;
      location.hash = '#/imagelab';
      renderImagelab();
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
      renderImagelab();
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

  const dropped = (ocr.dropped || []).map(
    (d) => `${d?.text ? `“${d.text}” — ` : ''}${d?.reason || 'không rõ lý do'}`,
  );
  if (dropped.length) blocks.push({ cls: 'warn', title: `${dropped.length} vùng chữ bị bỏ khi OCR`, items: dropped });

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

boot();
