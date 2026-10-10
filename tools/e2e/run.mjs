/**
 * E2E TRÊN TRÌNH DUYỆT THẬT — Google Chrome qua CDP, KHÔNG thêm dependency.
 *
 * Vì sao có file này: toàn bộ UI trước đây chỉ được kiểm bằng cách trích hàm render
 * rồi chạy trong Node (xem `test/*-ui.test.js`) — chưa lần nào có DOM thật, chuột
 * thật, FileList thật, XHR thật hay tải tệp thật. File này bịt đúng lỗ hổng đó.
 *
 *   npm run test:e2e            # mở cửa sổ Chrome thật
 *   E2E_HEADLESS=1 npm run test:e2e
 *   E2E_KEEP=1 npm run test:e2e # giữ Chrome mở sau khi chạy để soi bằng mắt
 *
 * Script tự dựng máy chủ riêng (cổng rảnh, SQLite + thư mục dữ liệu riêng trong
 * `.e2e-data/`, provider mock) nên không đụng dữ liệu phát triển.
 * Bằng chứng ghi ra `docs/assets/e2e/`: ảnh chụp PNG + log console + report JSON.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { launchChrome, Cdp, Page, waitFor, sleep } from './cdp.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, 'docs/assets/e2e');
const DOWNLOADS = join(ROOT, '.e2e-data/downloads');
const FIXTURE = join(ROOT, 'test/fixtures/headphones.png');

/** Lỗi console được PHÉP bỏ qua, kèm lý do — danh sách này phải ngắn và có lý. */
const IGNORED_CONSOLE = [
  // favicon dạng data: URI của trang; Chrome đôi khi báo lỗi giải mã, không liên quan luồng.
  /favicon/i,
];

const results = [];
let page;
/** Lỗi console được PHÉP trong ĐÚNG MỘT luồng vì luồng đó cố ý gây ra (ghi lý do vào báo cáo). */
const INTENTIONAL_CONSOLE = [];

/**
 * DỮ LIỆU GIEO SẴN cho f5–f8 (MVP-06/07/08 + gói .zip).
 *
 * Vì sao phải gieo: tạo job NỘI DUNG qua giao diện bắt buộc dán link Taobao/1688 rồi máy chủ tải trang
 * thật ⇒ e2e sẽ gọi mạng ra ngoài và chập chờn theo sàn. Nên job nội dung (đã xong, có ảnh https + mô tả
 * cho sàn) được ghi THẲNG vào SQLite riêng của e2e trước khi bật máy chủ. Owner được tạo bằng ĐÚNG đường
 * `accounts.bootstrapOwner()` mà `npm run make-owner` dùng. Mọi bước còn lại đi qua giao diện bằng chuột
 * và bàn phím thật. Mật khẩu là chuỗi ngẫu nhiên sinh MỖI lần chạy, chỉ nằm trong bộ nhớ, không ghi ra file.
 */
const SEED = {
  ownerEmail: 'owner-e2e@example.test',
  ownerPassword: `e2e-owner-${randomBytes(9).toString('hex')}`,
  memberEmail: 'member-e2e@example.test',
  memberPassword: `e2e-member-${randomBytes(9).toString('hex')}`,
  bankName: 'NGÂN HÀNG THỬ (E2E)',
  bankAccount: '0000000000',
  jobId: null,
};

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

function serverEnv(port) {
  const env = { ...process.env };
  delete env.DATABASE_URL; // cạm bẫy đã ghi trong HANDOVER.md: PG trong shell đã tắt
  Object.assign(env, {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: join(ROOT, '.e2e-data/e2e.db'),
    AI_PROVIDER: 'mock',
    OCR_PROVIDER: 'mock',
    IMAGELAB_DIR: './.e2e-data/imagelab',
    IMAGESTUDIO_DIR: './.e2e-data/imagestudio',
    VIDEOSTUDIO_DIR: './.e2e-data/videostudio',
    SCHEDULER_ENABLED: 'false',
    LOG_LEVEL: 'warn',
    // MVP-06: hướng dẫn chuyển khoản là DỮ LIỆU CẤU HÌNH — e2e dùng giá trị THỬ ghi rõ là thử.
    TOPUP_BANK_NAME: SEED.bankName,
    TOPUP_BANK_ACCOUNT_NUMBER: SEED.bankAccount,
    TOPUP_BANK_ACCOUNT_HOLDER: 'TAI KHOAN THU E2E',
    TOPUP_TRANSFER_NOTE: 'E2E <email>',
    TOPUP_RATE_VND_PER_CREDIT: '26000',
    // MVP-07/08: mặc định đã là dry-run; khai rõ để report.json ghi đúng cấu hình đã đo.
    PUBLISH_PROVIDER: 'dry-run',
    MARKETPLACE_LIVE_ENABLED: 'false',
  });
  return env;
}

/** Gieo owner + một job nội dung đã xong vào SQLite e2e (xem chú thích `SEED`). */
async function seedFixtures(env) {
  const { loadConfig } = await import('../../src/config.js');
  const { createStore } = await import('../../src/store/index.js');
  const { createAccountService } = await import('../../src/accounts/index.js');
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  quiet.child = () => quiet;
  const config = loadConfig(env);
  const store = await createStore(config, quiet);
  try {
    await store.init?.();
    const accounts = createAccountService(config, { store, logger: quiet });
    const boot = await accounts.bootstrapOwner({ email: SEED.ownerEmail, password: SEED.ownerPassword });
    const ownerId = boot?.user?.id;
    if (!ownerId) throw new Error(`không tạo được owner e2e: ${JSON.stringify({ created: boot?.created, reason: boot?.reason })}`);
    const jobId = randomUUID();
    await store.createJob({
      id: jobId, sessionId: 'e2e-seed-session-000001', userId: ownerId, kind: 'content', source: '1688',
      sourceUrl: 'https://detail.1688.com/offer/e2e-0001.html', canonicalUrl: 'https://detail.1688.com/offer/e2e-0001.html', sourceProductId: 'e2e-0001',
    });
    await store.updateJob(jobId, {
      status: 'succeeded',
      stage: 'done',
      product_name: 'Tai nghe chụp tai không dây (dữ liệu gieo e2e)',
      content: {
        product_name: 'Tai nghe chụp tai không dây (dữ liệu gieo e2e)',
        headline: 'Nghe rõ, đeo êm cả ngày',
        short_description: 'Tai nghe chụp tai không dây, gập gọn. Dữ liệu gieo cho e2e.',
        selling_points: ['Đệm tai mềm', 'Gập gọn bỏ túi'],
        marketplace_description: '- Tai nghe chụp tai không dây\n- Đệm tai mềm, gập gọn\n- Dữ liệu gieo e2e, người bán tự kiểm lại trước khi đăng.',
        facebook_caption: 'Tai nghe chụp tai không dây — dữ liệu gieo e2e.',
        hashtags: ['#tainghe', '#e2e'],
      },
      product_master: {
        source: '1688', canonical_url: 'https://detail.1688.com/offer/e2e-0001.html', source_product_id: 'e2e-0001',
        images: [{ url: 'https://img.example.com/e2e/tai-nghe-1.jpg', type: 'cover', status: 'FOUND', provenance: 'source' }],
        price: { raw: '¥38.00', currency: 'CNY', status: 'FOUND', kind: 'fixed', tiers: [] },
        variants: [], attributes: [],
      },
    });
    SEED.jobId = jobId;
    return { ownerId, jobId };
  } finally {
    await store.close?.();
  }
}

async function startServer(port, env) {
  const logFile = join(OUT, 'server.log');
  const proc = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const cap = (d) => {
    log += String(d);
    writeFileSync(logFile, log);
  };
  proc.stdout.on('data', cap);
  proc.stderr.on('data', cap);

  await waitFor(
    'máy chủ trả /api/health = ok',
    async () => {
      if (proc.exitCode !== null) throw new Error(`máy chủ chết (exit ${proc.exitCode}):\n${log.slice(-800)}`);
      const r = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
      if (!r || !r.ok) return null;
      const j = await r.json();
      return j.status === 'ok' ? j : null;
    },
    { timeoutMs: 30000, everyMs: 300 },
  );
  return { proc, logFile };
}

/** Một luồng = một mục trong báo cáo. Mọi khẳng định đi qua `expect`. */
async function flow(id, title, fn, { allowConsole = [], allowReason = '' } = {}) {
  const rec = { id, title, status: 'running', checks: [], shots: [], started: new Date().toISOString() };
  if (allowConsole.length) {
    rec.allowedConsole = { patterns: allowConsole.map(String), reason: allowReason };
    INTENTIONAL_CONSOLE.push(...allowConsole);
  }
  const ignore = [...IGNORED_CONSOLE, ...allowConsole];
  results.push(rec);
  const before = page ? page.console.length : 0;
  const expect = (ok, label, detail = '') => {
    rec.checks.push({ ok: Boolean(ok), label, detail: String(detail).slice(0, 400) });
    if (!ok) throw new Error(`KHẲNG ĐỊNH SAI [${id}] ${label} — ${detail}`);
    process.stdout.write(`    ✓ ${label}\n`);
    return ok;
  };
  const shot = async (name) => {
    const f = join(OUT, `${id}-${name}.png`);
    await page.screenshot(f);
    rec.shots.push(`docs/assets/e2e/${id}-${name}.png`);
    return f;
  };
  process.stdout.write(`\n[${id}] ${title}\n`);
  try {
    await fn({ expect, shot });
    // Lỗi console phát sinh TRONG luồng này
    const errs = page.realErrors({ ignore });
    const mine = errs.filter((e) => page.console.indexOf(e) >= before);
    rec.consoleErrors = mine;
    if (mine.length) {
      rec.status = 'failed';
      rec.error = `có ${mine.length} lỗi console: ${mine.map((e) => e.text).join(' | ').slice(0, 500)}`;
      process.stdout.write(`  ✗ LỖI CONSOLE: ${rec.error}\n`);
    } else {
      rec.status = 'passed';
      rec.checks.push({ ok: true, label: 'không có lỗi console trong luồng này', detail: '' });
      process.stdout.write(`  ✓ PASS (0 lỗi console)\n`);
    }
  } catch (err) {
    rec.status = 'failed';
    rec.error = err.message;
    rec.consoleErrors = page ? page.realErrors({ ignore }).slice(before) : [];
    process.stdout.write(`  ✗ FAIL: ${err.message}\n`);
    if (page) {
      try {
        await shot('that-bai');
      } catch { /* ignore */ }
    }
  }
  rec.finished = new Date().toISOString();
  return rec;
}

/** Đăng nhập (hoặc đăng ký) bằng FORM THẬT: gõ phím vào ô email/mật khẩu rồi bấm nút gửi. */
async function uiLogin(email, password, { register = false, name = '' } = {}) {
  await page.eval('location.hash = "#/dangnhap";');
  await waitFor('form đăng nhập hiện ra', () => page.eval('return Boolean(document.querySelector("#auth-email"));'), { timeoutMs: 10000 });
  // Form NHỚ chế độ lần trước (state.auth.mode) ⇒ luôn chọn rõ chế độ, nếu không lượt "đăng nhập"
  // sau một lượt "đăng ký" sẽ gửi nhầm sang /api/auth/register (409 EMAIL_TAKEN — đã vấp lượt chạy đầu).
  await page.click(`[data-action="authmode"][data-mode="${register ? 'register' : 'login'}"]`);
  await waitFor(`chuyển sang chế độ ${register ? 'đăng ký' : 'đăng nhập'}`,
    () => page.eval(`return ${register ? '' : '!'}Boolean(document.querySelector("#auth-name"));`), { timeoutMs: 5000 });
  await page.eval('for (const id of ["auth-email","auth-password","auth-name"]) { const el = document.getElementById(id); if (el) el.value = ""; }');
  await page.type('#auth-email', email);
  await page.type('#auth-password', password);
  if (register && name) await page.type('#auth-name', name);
  await page.click('#auth-submit');
  await waitFor(`đăng nhập xong (${email})`, () => page.eval(`return (document.querySelector("#account-bar")?.innerText || "").includes(${JSON.stringify(email)});`), { timeoutMs: 15000 });
}

async function uiLogout() {
  if (!(await page.eval('return Boolean(document.querySelector(\'[data-action="logout"]\'));'))) return;
  await page.click('[data-action="logout"]');
  await waitFor('đăng xuất xong', () => page.eval('return !document.querySelector(\'[data-action="logout"]\');'), { timeoutMs: 10000 });
}

/** Kiểm tệp tải về có MỞ ĐƯỢC thật bằng python3 (không chỉ xem đuôi tệp). */
function verifyFileOpens(file) {
  const script = `
import sys, struct, zlib
p = sys.argv[1]
d = open(p, 'rb').read()
if d[:8] == b'\\x89PNG\\r\\n\\x1a\\n':
    w, h = struct.unpack('>II', d[16:24])
    idat = b''
    i = 8
    chunks = []
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]; typ = d[i+4:i+8]
        chunks.append(typ.decode())
        if typ == b'IDAT': idat += d[i+8:i+8+ln]
        i += 12 + ln
    raw = zlib.decompress(idat)
    print('PNG OK bytes=%d %dx%d idat_raw=%d chunks=%s' % (len(d), w, h, len(raw), ','.join(chunks)))
elif d[:6] in (b'GIF89a', b'GIF87a'):
    w, h = struct.unpack('<HH', d[6:10])
    frames = d.count(b'\\x00\\x21\\xf9\\x04')
    print('GIF OK bytes=%d %dx%d frames=%d trailer=%s' % (len(d), w, h, frames, d[-1:] == b';'))
    assert frames >= 1 and d[-1:] == b';'
elif d[:2] == b'PK':
    import zipfile
    z = zipfile.ZipFile(p)
    bad = z.testzip()
    print('ZIP OK bytes=%d entries=%d testzip=%s' % (len(d), len(z.namelist()), bad))
    assert bad is None
else:
    raise SystemExit('KHONG NHAN DANG DUOC: %r' % d[:12])
`;
  return execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' }).trim();
}

function newestDownload(before) {
  const files = readdirSync(DOWNLOADS)
    .map((f) => join(DOWNLOADS, f))
    .filter((f) => statSync(f).isFile() && !f.endsWith('.crdownload') && !before.has(f));
  return files.length ? files[files.length - 1] : null;
}

async function clickDownload(page, selector, { expect, label }) {
  const before = new Set(
    readdirSync(DOWNLOADS).map((f) => join(DOWNLOADS, f)),
  );
  const knownGuids = new Set(page.downloads.map((d) => d.guid));
  await page.click(selector);
  // Bám vào sự kiện tải của CHÍNH trang (Page.downloadWillBegin → downloadProgress=completed): Chrome
  // tự tải tệp thành phần (CRX, đầu "Cr24") vào cùng thư mục, nên "tệp mới nhất trong thư mục" có thể
  // là tệp KHÔNG do nút này sinh ra (đã vấp ở f5 lượt chạy đầu). Không có sự kiện thì mới rơi về cách cũ.
  const file = await waitFor(
    `tệp tải về xuất hiện (${label})`,
    () => {
      const d = page.downloads.find((x) => !knownGuids.has(x.guid) && x.state === 'completed');
      if (d) {
        const f = join(DOWNLOADS, d.guid);
        try { if (statSync(f).isFile()) return f; } catch { /* chưa ghi xong */ }
      }
      const anyMine = page.downloads.some((x) => !knownGuids.has(x.guid));
      return anyMine ? null : newestDownload(before);
    },
    { timeoutMs: 20000, everyMs: 300 },
  );
  const out = verifyFileOpens(file);
  expect(/OK/.test(out), `tệp ${label} tải về MỞ ĐƯỢC bằng python3`, `${file} → ${out}`);
  return { file, out };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  rmSync(DOWNLOADS, { recursive: true, force: true });
  mkdirSync(DOWNLOADS, { recursive: true });
  rmSync(join(ROOT, '.e2e-data/e2e.db'), { force: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  process.stdout.write(`▸ dựng máy chủ: ${base}\n`);
  const env = serverEnv(port);
  process.stdout.write('▸ gieo owner + 1 job nội dung vào SQLite e2e (xem chú thích SEED)…\n');
  const seeded = await seedFixtures(env);
  process.stdout.write(`  job gieo: ${seeded.jobId}\n`);
  const server = await startServer(port, env);

  process.stdout.write('▸ bật Google Chrome thật (CDP)…\n');
  const chrome = await launchChrome({ port: 9444, downloadDir: DOWNLOADS });
  process.stdout.write(`  Chrome: ${chrome.version['Browser']} · ${chrome.chromeBinary}\n`);
  const cdp = await Cdp.connect(chrome.version.webSocketDebuggerUrl);
  page = await Page.open(cdp, { downloadDir: DOWNLOADS });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  const meta = {
    at: new Date().toISOString(),
    chrome: chrome.version['Browser'],
    chromeBinary: chrome.chromeBinary,
    userAgent: chrome.version['User-Agent'],
    headless: process.env.E2E_HEADLESS === '1',
    node: process.version,
    base,
    fixture: FIXTURE,
    seeded: { owner_email: SEED.ownerEmail, member_email: SEED.memberEmail, job_id: SEED.jobId, note: 'owner + job nội dung gieo thẳng vào SQLite e2e; mật khẩu ngẫu nhiên mỗi lần chạy, không ghi ra file' },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // LUỒNG 1 — 4 tab + Tài khoản + Quản trị đều render, không lỗi console
  // ───────────────────────────────────────────────────────────────────────────
  await flow('f1', '6 tab + Tài khoản + Quản trị render trên DOM thật, không lỗi console', async ({ expect, shot }) => {
    await page.goto(base, { waitMs: 1500 });
    const ua = await page.eval('return navigator.userAgent;');
    expect(/Chrome\//.test(ua), 'trang chạy trong Chrome thật', ua);
    expect(
      await page.eval('return document.title;'),
      'trang nạp được tiêu đề',
      await page.eval('return document.title;'),
    );

    const tabs = [
      { hash: '#/', name: 'noi-dung', want: /Dán link|Sản phẩm|link sản phẩm/i, label: 'Nội dung' },
      { hash: '#/imagelab', name: 'dich-anh', want: /Dịch (chữ )?Trung|ảnh sản phẩm/i, label: 'Dịch ảnh' },
      { hash: '#/taoanh', name: 'tao-anh', want: /Chọn ảnh sản phẩm|Tách nền/i, label: 'Tạo ảnh' },
      { hash: '#/video', name: 'video', want: /GIF|Video/i, label: 'Video' },
      { hash: '#/dangbai', name: 'dang-bai', want: /Đăng bài|đăng nhập|Facebook/i, label: 'Đăng bài' },
      { hash: '#/dangsan', name: 'dang-san', want: /Đăng sàn cần tài khoản/i, label: 'Đăng sàn (ẩn danh)' },
      { hash: '#/dangnhap', name: 'tai-khoan', want: /Đăng nhập|Đăng ký|mật khẩu/i, label: 'Tài khoản' },
      { hash: '#/quantri', name: 'quan-tri', want: /Quản trị|owner|admin/i, label: 'Quản trị' },
    ];
    for (const t of tabs) {
      await page.eval(`location.hash = ${JSON.stringify(t.hash)};`);
      await sleep(900);
      const txt = await page.text('#app');
      expect(txt.length > 50, `tab ${t.label} (${t.hash}) vẽ ra nội dung`, `${txt.length} ký tự`);
      expect(t.want.test(txt), `tab ${t.label} có chữ đặc trưng`, txt.slice(0, 160).replace(/\s+/g, ' '));
      await shot(t.name);
    }
    // Nút điều hướng thật trên thanh trên cùng cũng phải đổi được tab
    await page.click('[data-action="video"]');
    await sleep(800);
    expect(
      (await page.eval('return location.hash;')) === '#/video',
      'bấm CHUỘT THẬT vào nút "Video" trên thanh nav đổi được route',
      await page.eval('return location.hash;'),
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // LUỒNG 2 — Tạo ảnh (MVP-03): KÉO-THẢ ảnh thật → chọn mẫu nền → TẠO ẢNH
  // ───────────────────────────────────────────────────────────────────────────
  await flow('f2', 'Tạo ảnh (MVP-03): kéo-thả PNG → mẫu nền → TẠO ẢNH → TRƯỚC|SAU → tải được', async ({ expect, shot }) => {
    await page.eval('location.hash = "#/taoanh";');
    await sleep(1000);

    // KÉO-THẢ THẬT: Input.dispatchDragEvent mang tệp, đi đúng đường dataTransfer.files
    await page.dropFiles('#is-drop', [FIXTURE]);
    const picked = await waitFor(
      'ảnh hiện trong khối "đã chọn" sau khi KÉO-THẢ',
      async () => (await page.eval('return document.querySelectorAll(".il-picked img").length;')) > 0,
      { timeoutMs: 10000 },
    );
    expect(picked, 'KÉO-THẢ tệp PNG thật vào #is-drop được UI nhận', 'xuất hiện .il-picked img');
    await shot('01-da-keo-tha-anh');

    const tpl = await waitFor(
      'danh sách mẫu nền nạp xong',
      () => page.eval('return [...document.querySelectorAll(\'input[data-is-template]\')].map(i => i.value);'),
      { timeoutMs: 15000 },
    );
    expect(tpl.length > 0, 'máy chủ trả danh sách mẫu nền', JSON.stringify(tpl));
    await page.click(`input[data-is-template][value="${tpl[0]}"]`);
    await sleep(400);
    expect(
      await page.eval(`return document.querySelector('input[data-is-template][value=${JSON.stringify(tpl[0])}]').checked;`),
      `chọn được mẫu nền "${tpl[0]}" bằng chuột thật`,
    );
    await shot('02-da-chon-mau-nen');

    await page.click('[data-action="issubmit"]');
    await waitFor('job tạo ảnh chuyển sang màn job', () => page.eval('return /^#\\/taoanh\\/.+/.test(location.hash);'), {
      timeoutMs: 20000,
    });
    const jobHash = await page.eval('return location.hash;');
    expect(true, 'bấm TẠO ẢNH tạo job và điều hướng tới màn job', jobHash);

    // ⚠️ KHÔNG dựa vào chữ "TRƯỚC|SAU" trong #app: chuỗi đó CŨNG nằm trong phần trợ giúp của
    // bảng tham số, nên nó khớp ngay cả khi job còn đang chạy (đã vấp đúng bẫy này một lần).
    // Khẳng định phải bám vào KHỐI KẾT QUẢ THẬT: hai <figure> có ảnh trong `.il-compare`.
    await waitFor(
      'job tạo ảnh chạy xong và vẽ đủ cặp ảnh Trước/Sau',
      () => page.eval("return document.querySelectorAll('.il-compare figure img').length >= 2;"),
      { timeoutMs: 120000, everyMs: 800 },
    );
    const capTxt = await page.text('.il-compare');
    expect(/Ảnh gốc/.test(capTxt) && /Ảnh tạo mới/.test(capTxt),
      'màn job hiện cặp "Ảnh gốc" | "Ảnh tạo mới"', capTxt.slice(0, 180).replace(/\s+/g, ' '));
    // Ảnh TRƯỚC|SAU của MVP-03 dùng CHUNG kho ảnh của ImageLab (`imagestudio.wired storage=imagelab`)
    // nên đường dẫn là /api/imagelab/assets/:id/file — không phải /api/imagestudio/.
    const imgs = await page.eval(`
      return [...document.querySelectorAll('.il-compare figure img')]
        .map(i => ({ src: new URL(i.src, location.href).pathname, w: i.naturalWidth, h: i.naturalHeight }));
    `);
    expect(imgs.length >= 2, 'khối Trước/Sau có >= 2 ảnh', JSON.stringify(imgs));
    expect(
      imgs.every((i) => /\/api\/image(lab|studio)\/assets\/[^/]+\/file$/.test(i.src)),
      'cả hai ảnh đều lấy từ endpoint asset thật của máy chủ',
      JSON.stringify(imgs.map((i) => i.src)),
    );
    expect(
      imgs.every((i) => i.w > 0 && i.h > 0),
      'cả hai ảnh đều naturalWidth/Height > 0 — TRÌNH DUYỆT GIẢI MÃ THẬT, không phải link vỡ',
      JSON.stringify(imgs),
    );
    expect(
      imgs[0].src !== imgs[1].src,
      'ảnh SAU là BẢN GHI MỚI (asset id khác ảnh gốc) — ảnh gốc bất biến',
      JSON.stringify(imgs.map((i) => i.src)),
    );
    await page.scrollTo('.il-compare');
    await shot('03-truoc-sau');

    const dl = await clickDownload(page, 'a[download^="taoanh-"]', { expect, label: 'ảnh tạo (PNG)' });
    results.at(-1).downloads = [{ what: 'ảnh tạo', ...dl }];
    await shot('04-sau-khi-tai');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // LUỒNG 3 — Video (MVP-04): 2 ảnh PNG → TẠO VIDEO → GIF + "Video KHÔNG có tiếng"
  // ───────────────────────────────────────────────────────────────────────────
  await flow('f3', 'Video (MVP-04): 2 PNG → TẠO VIDEO → GIF chạy + "Video KHÔNG có tiếng" + tải được', async ({ expect, shot }) => {
    await page.eval('location.hash = "#/video";');
    await sleep(1200);
    // Ảnh thứ hai phải KHÁC THẬT. Nếu copy y hệt ảnh 1, máy chủ gộp lại còn 1 cảnh và UI báo
    // "Số cảnh KHÔNG khớp" — khi đó test chỉ đang đo đường gộp trùng, không đo video 2 cảnh.
    const second = join(ROOT, '.e2e-data/anh-2.png');
    const { encodePng } = await import('../make-test-image.mjs');
    writeFileSync(
      second,
      encodePng(320, 320, (x, y) => (((x >> 5) + (y >> 5)) % 2 === 0 ? [240, 180, 40] : [20, 30, 60])),
    );

    await page.setFiles('#vs-file', [FIXTURE, second]);
    const n = await waitFor(
      'UI nhận 2 tệp PNG',
      async () => {
        const t = await page.text('#app');
        return /2\s*ảnh|2\s*cảnh|2\s*tệp/i.test(t) ? t : null;
      },
      { timeoutMs: 10000 },
    );
    expect(true, 'chọn 2 tệp PNG qua FileList thật của Chrome', n.match(/.{0,70}(2\s*(ảnh|cảnh|tệp)).{0,70}/i)?.[0] || '');
    await shot('01-da-chon-2-anh');

    await page.click('[data-action="vscreate"]');
    await waitFor('job video chuyển sang màn job', () => page.eval('return /^#\\/video\\/.+/.test(location.hash);'), {
      timeoutMs: 25000,
    });

    await waitFor(
      'tệp GIF kết quả hiện ra',
      async () => {
        const t = await page.text('#app');
        return /Kết quả video/.test(t) && (await page.eval(`
          return [...document.querySelectorAll('img')].some(i => /videostudio\\/assets/.test(i.src) && i.naturalWidth > 0);
        `)) ? t : null;
      },
      { timeoutMs: 180000, everyMs: 1000 },
    );
    const gif = await page.eval(`
      const i = [...document.querySelectorAll('img')].find(x => /videostudio\\/assets/.test(x.src));
      return i ? { src: new URL(i.src, location.href).pathname, w: i.naturalWidth, h: i.naturalHeight } : null;
    `);
    expect(gif && gif.w > 0, 'trình duyệt GIẢI MÃ và PHÁT được GIF trong <img>', JSON.stringify(gif));

    const txt = await page.text('#app');
    expect(
      !/Số cảnh KHÔNG khớp/.test(txt),
      'máy chủ DÙNG ĐỦ cả 2 cảnh (không có cảnh bị bỏ)',
      txt.match(/.{0,140}Số cảnh KHÔNG khớp.{0,140}/s)?.[0] || 'không có cảnh báo số cảnh',
    );
    expect(/Video KHÔNG có tiếng/.test(txt), 'câu "Video KHÔNG có tiếng" hiện NGAY CẠNH kết quả', 'khớp nguyên văn');
    expect(
      await page.eval('return Boolean(document.querySelector("#vs-no-audio"));'),
      'nhãn không-tiếng đúng là khối #vs-no-audio của hợp đồng MVP-04',
    );
    await shot('02-gif-ket-qua');
    await page.scrollTo('#vs-no-audio');
    await shot('03-nhan-khong-co-tieng');

    const dl = await clickDownload(page, 'a[download^="video-"]', { expect, label: 'video (GIF)' });
    expect(/GIF OK/.test(dl.out), 'tệp tải về là GIF hợp lệ, nhiều khung, có trailer', dl.out);
    results.at(-1).downloads = [{ what: 'video GIF', ...dl }];
  });

  // ───────────────────────────────────────────────────────────────────────────
  // LUỒNG 4 — Dịch ảnh (MVP-02 + IL-08): tải ảnh → nhập vùng chữ tay → LƯU VÙNG & DỊCH
  // ───────────────────────────────────────────────────────────────────────────
  await flow('f4', 'Dịch ảnh (MVP-02): tải ảnh → nhập vùng chữ TAY (IL-08) → LƯU VÙNG & DỊCH → bảng duyệt', async ({ expect, shot }) => {
    await page.eval('location.hash = "#/imagelab";');
    await sleep(1000);
    await page.dropFiles('#il-drop', [FIXTURE]);
    await waitFor('ảnh hiện trong khối đã chọn', () => page.eval('return document.querySelectorAll(".il-picked img").length > 0;'), {
      timeoutMs: 10000,
    });
    expect(true, 'KÉO-THẢ ảnh thật vào #il-drop được nhận');
    await page.click('[data-action="ilsubmit"]');
    await waitFor('job dịch ảnh chuyển sang màn job', () => page.eval('return /^#\\/imagelab\\/.+/.test(location.hash);'), {
      timeoutMs: 25000,
    });
    await waitFor('khối nhập vùng tay (#il-manual) có mặt', () => page.eval('return Boolean(document.querySelector("#il-manual"));'), {
      timeoutMs: 90000, everyMs: 800,
    });
    // ⚠️ Nút "LƯU VÙNG & DỊCH" bị DISABLED khi job còn chạy OCR/dịch (UI ghi rõ "JOB ĐANG CHẠY —
    // CHỜ XONG"). Bấm sớm là bấm vào hư không: test từng im lặng chờ 90s vì lý do này.
    await waitFor(
      'job OCR/dịch chạy xong (nút LƯU VÙNG & DỊCH hết disabled)',
      () => page.eval('return Boolean(document.querySelector(\'[data-action="ilmanualsave"]:not([disabled])\'));'),
      { timeoutMs: 120000, everyMs: 800 },
    );
    await shot('01-man-job');

    // Khối IL-08 có thể đang THU GỌN, hoặc đang MỞ nhưng chưa có dòng nào (tuỳ OCR mock trả ra
    // bao nhiêu vùng). Phải phân biệt hai trạng thái, nếu không cú bấm "Mở ra" sẽ ĐÓNG mất khối.
    const hasAdd = () => page.eval('return Boolean(document.querySelector(\'[data-action="ilmanualadd"]\'));');
    const hasRow = () => page.eval('return Boolean(document.querySelector(\'input[data-mfield="x"]\'));');
    if (!(await hasAdd())) {
      await page.click('[data-action="ilmanualtoggle"]');
      await waitFor('khối IL-08 mở ra', hasAdd, { timeoutMs: 10000 });
    }
    expect(await hasAdd(), 'khối NHẬP VÙNG CHỮ TAY (IL-08) mở được bằng chuột thật');
    if (!(await hasRow())) {
      await page.click('[data-action="ilmanualadd"]');
      await waitFor('bấm "Thêm vùng" sinh ra một dòng trống', hasRow, { timeoutMs: 10000 });
    }
    expect(await hasRow(), 'bảng nhập vùng tay có ít nhất một dòng để gõ');

    // Gõ BÀN PHÍM THẬT vào từng ô toạ độ + chữ Trung
    const cells = [['x', '40'], ['y', '40'], ['w', '160'], ['h', '48']];
    for (const [f, v] of cells) {
      await page.eval(`document.querySelector('input[data-mrow="0"][data-mfield=${JSON.stringify(f)}]').value = '';`);
      await page.type(`input[data-mrow="0"][data-mfield="${f}"]`, v);
    }
    await page.eval(`document.querySelector('input[data-mrow="0"][data-mfield="text"]').value = '';`);
    await page.type('input[data-mrow="0"][data-mfield="text"]', '无线蓝牙耳机');
    const row = await page.eval(`
      const g = (f) => document.querySelector('input[data-mrow="0"][data-mfield="' + f + '"]').value;
      return { x: g('x'), y: g('y'), w: g('w'), h: g('h'), text: g('text') };
    `);
    expect(
      row.x === '40' && row.text === '无线蓝牙耳机',
      'gõ được toạ độ + chữ Trung bằng BÀN PHÍM THẬT',
      JSON.stringify(row),
    );
    await shot('02-da-nhap-vung-tay');

    expect(
      await page.eval('return Boolean(document.querySelector(\'[data-action="ilmanualsave"]:not([disabled])\'));'),
      'nút LƯU VÙNG & DỊCH đang BẤM ĐƯỢC (không disabled) ngay trước khi bấm',
    );
    await page.click('[data-action="ilmanualsave"]');
    const lines = await waitFor(
      'bảng duyệt từng dòng hiện ra sau khi LƯU VÙNG & DỊCH',
      async () => {
        const has = await page.eval('return Boolean(document.querySelector("#il-lines"));');
        if (!has) return null;
        const t = await page.text('#il-lines');
        return /无线蓝牙耳机/.test(t) ? t : null;
      },
      { timeoutMs: 90000, everyMs: 800 },
    ).catch(async (err) => {
      const diag = await page.text('#il-manual');
      throw new Error(`${err.message}\n  ↳ nội dung khối IL-08 lúc hỏng: ${diag.slice(0, 500).replace(/\s+/g, ' ')}`);
    });
    expect(true, 'bảng duyệt (#il-lines) hiện và chứa đúng chữ Trung đã nhập tay', lines.slice(0, 200).replace(/\s+/g, ' '));
    const kinds = await page.eval(`
      return [...document.querySelectorAll('#il-lines tbody tr')].length;
    `);
    expect(kinds >= 1, 'bảng duyệt có >= 1 dòng', `${kinds} dòng`);
    await page.scrollTo('#il-lines');
    await shot('03-bang-duyet');

    // Render ảnh dịch rồi tải về — chứng minh vòng đời đầy-đủ của MVP-02
    if (await page.eval('return Boolean(document.querySelector(\'[data-action="ilrender"]\'));')) {
      await page.click('[data-action="ilrender"]');
      const ok = await waitFor(
        'ảnh dịch render xong, có link tải',
        () => page.eval('return Boolean(document.querySelector(\'a[download^="imagelab-"]\'));'),
        { timeoutMs: 90000, everyMs: 800 },
      ).catch(() => false);
      if (ok) {
        await shot('04-anh-da-render');
        const dl = await clickDownload(page, 'a[download^="imagelab-"]', { expect, label: 'ảnh dịch (PNG)' });
        results.at(-1).downloads = [{ what: 'ảnh dịch', ...dl }];
      } else {
        results.at(-1).notes = ['RENDER ẢNH không hoàn tất trong 90s — không coi là PASS cho bước tải ảnh dịch'];
      }
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // LUỒNG 5 — Gói xuất bản .zip (đã gộp từ PR #26/#27): owner đăng nhập → màn job → TẢI GÓI
  // ───────────────────────────────────────────────────────────────────────────
  await flow('f5', 'Gói xuất bản (.zip): owner đăng nhập bằng bàn phím thật → màn job nội dung → TẢI GÓI → zip mở được, có MANIFEST.json', async ({ expect, shot }) => {
    await uiLogin(SEED.ownerEmail, SEED.ownerPassword);
    expect(await page.eval('return Boolean(document.querySelector(\'[data-action="logout"]\'));'), 'đăng nhập owner bằng form thật thành công');
    await page.eval(`location.hash = ${JSON.stringify(`#/job/${SEED.jobId}`)};`);
    await waitFor('panel gói xuất bản hiện ra và nút TẢI GÓI bấm được',
      () => page.eval('const b = document.querySelector(\'[data-action="exportbundle"]\'); return Boolean(b && !b.disabled);'),
      { timeoutMs: 20000, everyMs: 400 });
    await page.scrollTo('[data-action="exportbundle"]');
    await shot('01-panel-goi-xuat-ban');
    const dl = await clickDownload(page, '[data-action="exportbundle"]', { expect, label: 'gói xuất bản (.zip)' });
    const names = execFileSync('python3', ['-I', '-c', 'import sys,zipfile,json; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', dl.file], { encoding: 'utf8' });
    const list = JSON.parse(names);
    expect(list.includes('MANIFEST.json'), 'gói có MANIFEST.json (tự khai bước nào là dữ liệu giả)', names.slice(0, 300));
    const manifest = JSON.parse(execFileSync('python3', ['-I', '-c', 'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("MANIFEST.json").decode())', dl.file], { encoding: 'utf8' }));
    expect(String(manifest.job_id || manifest.job?.id || '') === SEED.jobId, 'MANIFEST.json khai đúng job_id của job đã mở', JSON.stringify(manifest).slice(0, 200));
    results.at(-1).downloads = [{ what: 'gói xuất bản', ...dl, entries: list }];
    await shot('02-sau-khi-tai-goi');
  }, {
    allowConsole: [/ERR_NAME_NOT_RESOLVED https:\/\/img\.example\.com\//],
    allowReason: 'job gieo dùng ảnh https://img.example.com/… (tên miền DÀNH RIÊNG theo RFC 2606, không bao giờ phân giải) để e2e không tải ảnh từ CDN sàn thật; màn job vẽ ảnh sản phẩm nên Chrome ghi một dòng ERR_NAME_NOT_RESOLVED.',
  });

  // ───────────────────────────────────────────────────────────────────────────
  // LUỒNG 6 — Nạp credit thủ công (MVP-06): member gửi yêu cầu → owner XÁC NHẬN / TỪ CHỐI → ví đổi đúng
  // ───────────────────────────────────────────────────────────────────────────
  await flow('f6', 'Nạp credit (MVP-06): member gửi 2 yêu cầu → ví CHƯA đổi → owner XÁC NHẬN 1 + TỪ CHỐI 1 → member thấy +10 credit', async ({ expect, shot }) => {
    await uiLogout();
    await uiLogin(SEED.memberEmail, SEED.memberPassword, { register: true, name: 'Thành viên E2E' });
    await page.eval('location.hash = "#/taikhoan";');
    await waitFor('khối Nạp credit hiện ra', () => page.eval('return Boolean(document.querySelector("#topup-amount"));'), { timeoutMs: 15000 });
    const panel = await page.text('#topup-panel');
    expect(/Tiền vào ví chỉ sau khi quản trị xác nhận/.test(panel), 'câu nói thật "Tiền vào ví chỉ sau khi quản trị xác nhận" hiện ở tab Tài khoản', panel.slice(0, 200).replace(/\s+/g, ' '));
    expect(panel.includes(SEED.bankName) && panel.includes(SEED.bankAccount), 'hướng dẫn chuyển khoản lấy từ CẤU HÌNH máy chủ (TOPUP_BANK_*)', panel.slice(0, 400).replace(/\s+/g, ' '));
    expect(/26\.000/.test(panel), 'tỷ giá hiện đúng cấu hình 26.000 ₫ = 1 credit', '');

    const send = async (amount, ref) => {
      await page.eval('for (const id of ["topup-amount","topup-reference","topup-note"]) { const el = document.getElementById(id); if (el) el.value = ""; }');
      await page.type('#topup-amount', String(amount));
      await page.type('#topup-reference', ref);
      await page.type('#topup-note', 'chuyển thử trong e2e');
      await page.click('[data-action="topupsubmit"]');
      await waitFor(`yêu cầu ${ref} hiện trong bảng của tôi`, () => page.eval(`return (document.querySelector('#app')?.innerText || '').includes(${JSON.stringify(ref)});`), { timeoutMs: 15000 });
    };
    await send(260000, 'E2E-FT-0001');
    const notice = await page.text('#topup-notice');
    expect(/ví CHƯA đổi/.test(notice), 'sau khi gửi: thông báo nói rõ "ví CHƯA đổi, chờ quản trị xác nhận"', notice);
    await send(52000, 'E2E-FT-0002');
    const bar1 = await page.text('#account-bar');
    expect(/\b0 credit/.test(bar1), 'số dư VẪN 0 credit sau 2 yêu cầu (luật #1: không tự cộng tiền)', bar1.replace(/\s+/g, ' '));
    expect((await page.text('#app')).split('Chờ quản trị xác nhận').length - 1 >= 2, 'bảng của tôi có 2 dòng "Chờ quản trị xác nhận"', '');
    await page.scrollTo('#topup-panel');
    await shot('01-member-gui-yeu-cau');

    await uiLogout();
    await uiLogin(SEED.ownerEmail, SEED.ownerPassword);
    await page.eval('location.hash = "#/quantri";');
    await waitFor('danh sách yêu cầu chờ duyệt có 2 dòng', () => page.eval('return document.querySelectorAll(\'[data-action="topupreview"]\').length >= 2;'), { timeoutMs: 15000 });
    const idOf = (ref) => page.eval(`
      const tr = [...document.querySelectorAll('tr')].find((r) => r.innerText.includes(${JSON.stringify(ref)}));
      return tr ? tr.querySelector('[data-action="topupreview"]')?.dataset.id || null : null;`);
    const okId = await idOf('E2E-FT-0001');
    const noId = await idOf('E2E-FT-0002');
    expect(okId && noId, 'tìm được hai yêu cầu theo mã giao dịch trên trang Quản trị', `${okId} · ${noId}`);
    expect((await page.text('#app')).includes(SEED.memberEmail), 'bảng Quản trị hiện EMAIL người nạp (không phải UUID)', '');

    await page.click(`[data-action="topupreview"][data-id="${okId}"]`);
    await waitFor('hộp xác nhận hiện ra', () => page.eval('return Boolean(document.querySelector(\'[data-action="topupconfirm"]\'));'), { timeoutMs: 8000 });
    const box = await page.eval('return document.querySelector(\'[data-action="topupconfirm"]\').closest(".notice").innerText;');
    expect(/cộng 10 credit/.test(box) && /26\.000/.test(box), 'XÁC NHẬN hiện số credit sẽ cộng (10) + tỷ giá đang dùng (26.000 ₫)', box.replace(/\s+/g, ' '));
    await shot('02-owner-hop-xac-nhan');
    await page.click(`[data-action="topupconfirm"][data-id="${okId}"]`);
    await waitFor('thông báo đã cộng credit', () => page.eval('return /Đã cộng 10 credit/.test(document.querySelector("#admin-notice")?.innerText || "");'), { timeoutMs: 15000 });
    expect(true, 'owner XÁC NHẬN ⇒ "Đã cộng 10 credit"', await page.text('#admin-notice'));

    await waitFor('nút TỪ CHỐI… của yêu cầu thứ hai còn đó', () => page.eval(`return Boolean(document.querySelector('[data-action="topuprejectopen"][data-id="${noId}"]'));`), { timeoutMs: 15000 });
    await page.click(`[data-action="topuprejectopen"][data-id="${noId}"]`);
    await waitFor('ô lý do từ chối hiện ra', () => page.eval('return Boolean(document.querySelector("#topup-reject-reason"));'), { timeoutMs: 8000 });
    await page.type('#topup-reject-reason', 'không thấy giao dịch này trong sao kê');
    await page.click(`[data-action="topupreject"][data-id="${noId}"]`);
    await waitFor('thông báo đã từ chối', () => page.eval('return /TỪ CHỐI/.test(document.querySelector("#admin-notice")?.innerText || "");'), { timeoutMs: 15000 });
    expect(/KHÔNG có dòng sổ nào/.test(await page.text('#admin-notice')), 'TỪ CHỐI ⇒ nói rõ KHÔNG có dòng sổ nào được ghi', await page.text('#admin-notice'));
    await shot('03-owner-da-duyet');

    await uiLogout();
    await uiLogin(SEED.memberEmail, SEED.memberPassword);
    await page.eval('location.hash = "#/taikhoan";');
    await waitFor('bảng yêu cầu của tôi nạp xong', () => page.eval('return /Đã cộng credit/.test(document.querySelector("#app")?.innerText || "");'), { timeoutMs: 15000 });
    const txt = await page.text('#app');
    expect(/Đã cộng credit/.test(txt) && /Bị từ chối/.test(txt), 'member thấy một yêu cầu "Đã cộng credit" và một "Bị từ chối"', '');
    const bar2 = await page.text('#account-bar');
    expect(/\b10 credit/.test(bar2), 'số dư member = 10 credit (đúng 260.000 ₫ / 26.000)', bar2.replace(/\s+/g, ' '));
    await page.scrollTo('#topup-panel');
    await shot('04-member-thay-so-du');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // LUỒNG 7 — Đăng bài Facebook (MVP-07, dry-run): owner tạo & gửi duyệt → DUYỆT → ĐĂNG ⇒ id thử
  // ───────────────────────────────────────────────────────────────────────────
  await flow('f7', 'Đăng bài (MVP-07): băng "CHẾ ĐỘ THỬ" → TẠO & GỬI DUYỆT → DUYỆT → ĐĂNG ⇒ "id thử — không có bài thật"', async ({ expect, shot }) => {
    await uiLogout();
    await uiLogin(SEED.ownerEmail, SEED.ownerPassword);
    await page.eval('location.hash = "#/dangbai";');
    await waitFor('ô chọn job nguồn có job đã gieo', () => page.eval(`return Boolean(document.querySelector('#pub-job option[value="${SEED.jobId}"]'));`), { timeoutMs: 15000 });
    expect(/CHẾ ĐỘ THỬ — không đăng thật/.test(await page.text('#app')), 'băng "CHẾ ĐỘ THỬ — không đăng thật" hiện ở tab Đăng bài', '');
    await page.setSelect('#pub-job', SEED.jobId);
    await shot('01-tab-dang-bai');
    await page.click('[data-action="pubcreatesubmit"]');
    await waitFor('bài mới hiện với nút DUYỆT', () => page.eval('return Boolean(document.querySelector(\'[data-action="pubapprove"]:not([disabled])\'));'), { timeoutMs: 15000 });
    const pid = await page.eval('return document.querySelector(\'[data-action="pubapprove"]:not([disabled])\').dataset.id;');
    expect(pid, 'TẠO & GỬI DUYỆT tạo ra một bài chờ duyệt', pid);
    await page.click(`[data-action="pubapprove"][data-id="${pid}"]`);
    await waitFor('nút ĐĂNG bấm được sau khi duyệt', () => page.eval(`const b = document.querySelector('[data-action="pubpublish"][data-id="${pid}"]'); return Boolean(b && !b.disabled);`), { timeoutMs: 15000 });
    await page.click(`[data-action="pubpublish"][data-id="${pid}"]`);
    await waitFor('kết quả đăng hiện mã bài', () => page.eval('return /id thử — không có bài thật/.test(document.querySelector("#app")?.innerText || "");'), { timeoutMs: 20000 });
    const card = await page.eval(`return document.querySelector('[data-pub-item="${pid}"]')?.innerText || document.querySelector('#app').innerText;`);
    expect(/dry-[0-9a-f]+/.test(card), 'mã bài có tiền tố "dry-" và được ghi rõ "id thử — không có bài thật"', card.slice(0, 300).replace(/\s+/g, ' '));
    expect(!/mở bài trên Facebook/.test(card), 'KHÔNG có link "mở bài trên Facebook" cho bài thử', '');
    await page.scrollTo(`[data-pub-item="${pid}"]`);
    await shot('02-da-dang-thu');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // LUỒNG 8 — Đăng sàn (MVP-08, dry-run): thiếu trường ⇒ 422 từng dòng → bổ sung → DUYỆT → ĐĂNG → ĐỒNG BỘ → PAYLOAD
  // ───────────────────────────────────────────────────────────────────────────
  await flow('f8', 'Đăng sàn (MVP-08): TẠO BÀI thiếu trường ⇒ issues[] từng dòng → bổ sung → DUYỆT → ĐĂNG (dry-) → ĐỒNG BỘ → XEM PAYLOAD', async ({ expect, shot }) => {
    // Luồng tự đăng nhập lại: không dựa vào trạng thái phiên do luồng trước để lại.
    await uiLogout();
    await uiLogin(SEED.ownerEmail, SEED.ownerPassword);
    await page.eval('location.hash = "#/dangsan";');
    await waitFor('ô chọn job nguồn của tab Đăng sàn có job đã gieo', () => page.eval(`return Boolean(document.querySelector('#mk-job-id option[value="${SEED.jobId}"]'));`), { timeoutMs: 15000 });
    expect(Boolean(await page.eval('return document.querySelector(\'[data-mk-banner="dry-run"]\');')), 'băng "CHẾ ĐỘ THỬ — không đăng thật" (data-mk-banner=dry-run) hiện ở form', '');
    const chips = await page.text('#app');
    expect(/shopee · chưa có token/.test(chips) && /tiktokshop · chưa có token/.test(chips), 'Shopee/TikTok Shop hiện "chưa có token" — không giả vờ sẵn sàng', '');
    await page.setSelect('#mk-job-id', SEED.jobId);
    await page.click('[data-action="mkcreate"]');
    await waitFor('422 hiện danh sách lỗi kiểm tra', () => page.eval('return document.querySelectorAll("#mk-error [data-mk-issue]").length > 0;'), { timeoutMs: 15000 });
    const fields = await page.eval('return [...document.querySelectorAll("#mk-error [data-mk-issue]")].map((li) => li.dataset.mkIssue);');
    for (const f of ['price_vnd', 'stock', 'weight_g', 'category_id']) expect(fields.includes(f), `issues[] nêu đúng trường thiếu "${f}" thành MỘT DÒNG riêng`, JSON.stringify(fields));
    await page.scrollTo('#mk-error');
    await shot('01-422-tung-dong');

    await page.type('#mk-price-vnd', '199000');
    await page.type('#mk-stock', '5');
    await page.type('#mk-weight-g', '250');
    await page.type('#mk-category-id', '100001');
    await page.click('[data-action="mkcreate"]');
    await waitFor('bài đăng sàn được tạo', () => page.eval('return /Đã tạo bài/.test(document.querySelector("#mk-notice")?.innerText || "");'), { timeoutMs: 15000 });
    const lid = await waitFor('dòng listing hiện trong bảng', () => page.eval('return document.querySelector("[data-mk-listing]")?.dataset.mkListing || null;'), { timeoutMs: 10000 });
    const reason = await page.eval(`return document.querySelector('[data-action="mkpublish"][data-id="${lid}"]').dataset.mkReason || '';`);
    expect(/chưa được DUYỆT/.test(reason), 'nút ĐĂNG khoá kèm lý do "Bài chưa được DUYỆT"', reason);
    await page.click(`[data-action="mkapprove"][data-id="${lid}"]`);
    await waitFor('nút ĐĂNG mở khoá sau khi duyệt', () => page.eval(`const b = document.querySelector('[data-action="mkpublish"][data-id="${lid}"]'); return Boolean(b && !b.disabled);`), { timeoutMs: 15000 });
    await page.click(`[data-action="mkpublish"][data-id="${lid}"]`);
    await waitFor('thông báo đã "đăng" ở chế độ thử', () => page.eval('return /đã "đăng" ở chế độ thử/.test(document.querySelector("#mk-notice")?.innerText || "");'), { timeoutMs: 20000 });
    const row = await page.eval(`return document.querySelector('[data-mk-listing="${lid}"]').innerText;`);
    expect(/dry-[0-9a-f]{16}/.test(row) && /THỬ/.test(row), 'dòng listing có mã dry-… và nhãn THỬ', row.slice(0, 300).replace(/\s+/g, ' '));
    await shot('02-da-dang-thu');
    await page.click(`[data-action="mksync"][data-id="${lid}"]`);
    await waitFor('đồng bộ xong', () => page.eval('return /Đã đọc từ sàn/.test(document.querySelector("#mk-notice")?.innerText || "");'), { timeoutMs: 15000 });
    expect(/199\.000/.test(await page.text('#mk-notice')), 'ĐỒNG BỘ đọc về đúng giá 199.000 ₫ (chế độ thử)', await page.text('#mk-notice'));
    await page.click(`[data-action="mkpayload"][data-id="${lid}"]`);
    await waitFor('hộp payload nạp xong', () => page.eval('return /previews/.test(document.querySelector("#mk-payload")?.innerText || "");'), { timeoutMs: 15000 });
    // textContent, không innerText: tiêu đề h3 bị CSS viết HOA nên innerText ra "ÁNH XẠ" (đã vấp lượt 2).
    const pl = await page.eval('return document.querySelector("#mk-payload")?.textContent || "";');
    expect(/KHÔNG ánh xạ được/.test(pl) && /logistic_info/.test(pl), 'XEM PAYLOAD hiện payload + danh sách trường KHÔNG ánh xạ được', '');
    await page.scrollTo('#mk-payload');
    await shot('03-xem-payload');
  }, { allowConsole: [/status of 422/], allowReason: 'f8 CỐ Ý bấm TẠO BÀI khi thiếu trường để kiểm 422 PREFLIGHT_FAILED; Chrome tự ghi một dòng "Failed to load resource … 422".' });

  // ── Báo cáo ───────────────────────────────────────────────────────────────
  const summary = {
    meta,
    totals: {
      flows: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      not_implemented: results.filter((r) => r.status === 'not_implemented').length,
    },
    consoleAll: page.console,
    // Lỗi console toàn phiên, ĐÃ bỏ các dòng mà một luồng khai là cố ý gây ra (xem `flows[].allowedConsole`).
    consoleErrorsAll: page.realErrors({ ignore: [...IGNORED_CONSOLE, ...INTENTIONAL_CONSOLE] }),
    consoleErrorsIntentional: page.realErrors({ ignore: IGNORED_CONSOLE }).filter((e) => INTENTIONAL_CONSOLE.some((re) => re.test(e.text))),
    network4xx5xx: page.network.filter((n) => n.status >= 400),
    downloads: page.downloads,
    flows: results,
  };
  writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    join(OUT, 'console.log'),
    page.console.map((c) => `[${c.level}] ${c.kind}: ${c.text}`).join('\n') || '(trống — không có dòng console nào)',
  );

  process.stdout.write('\n' + '─'.repeat(72) + '\n');
  for (const r of results) {
    const mark = { passed: 'PASS', failed: 'FAIL', not_implemented: 'CHƯA CÓ TÍNH NĂNG' }[r.status] || r.status;
    process.stdout.write(`${mark.padEnd(20)} ${r.id}  ${r.title}\n`);
    if (r.error) process.stdout.write(`                     ↳ ${r.error.slice(0, 300)}\n`);
  }
  process.stdout.write('─'.repeat(72) + '\n');
  process.stdout.write(
    `Chrome: ${meta.chrome} (headless=${meta.headless}) · ${summary.totals.passed} PASS · ${summary.totals.failed} FAIL · ` +
      `${summary.totals.not_implemented} chưa có tính năng\n`,
  );
  process.stdout.write(`Lỗi console toàn phiên: ${summary.consoleErrorsAll.length}\n`);
  process.stdout.write(`HTTP >= 400 toàn phiên: ${summary.network4xx5xx.length} ${JSON.stringify(summary.network4xx5xx.slice(0, 5))}\n`);
  process.stdout.write(`Bằng chứng: docs/assets/e2e/ (ảnh chụp + report.json + console.log + server.log)\n`);

  if (process.env.E2E_KEEP === '1') {
    process.stdout.write('\nE2E_KEEP=1 → giữ Chrome + máy chủ. Ctrl-C để đóng.\n');
    await new Promise(() => {});
  }
  cdp.close();
  chrome.proc.kill('SIGTERM');
  server.proc.kill('SIGTERM');
  await sleep(500);
  process.exit(summary.totals.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`\nE2E sập: ${err.stack || err.message}\n`);
  process.exit(2);
});
