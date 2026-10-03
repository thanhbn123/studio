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
  return `
    <button class="hist-item" data-action="openjob" data-id="${esc(item.id)}">
      <span style="min-width:0">
        <span class="hist-name">${esc(item.product_name || item.source_url || '(chưa có tên)')}</span>
        <span class="hist-sub">${esc(SOURCE_LABEL[item.source] || item.source || '—')} · ${esc(new Date(item.created_at).toLocaleString('vi-VN'))}</span>
      </span>
      <span class="badge ${cls}">${esc(STATUS_LABEL[st] || st)}</span>
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

boot();
