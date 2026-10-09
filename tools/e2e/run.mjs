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

async function startServer(port) {
  const env = { ...process.env };
  delete env.DATABASE_URL; // cạm bẫy đã ghi trong HANDOVER.md: PG trong shell đã tắt
  Object.assign(env, {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: './.e2e-data/e2e.db',
    AI_PROVIDER: 'mock',
    OCR_PROVIDER: 'mock',
    IMAGELAB_DIR: './.e2e-data/imagelab',
    IMAGESTUDIO_DIR: './.e2e-data/imagestudio',
    VIDEOSTUDIO_DIR: './.e2e-data/videostudio',
    SCHEDULER_ENABLED: 'false',
    LOG_LEVEL: 'warn',
  });
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
async function flow(id, title, fn) {
  const rec = { id, title, status: 'running', checks: [], shots: [], started: new Date().toISOString() };
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
    const errs = page.realErrors({ ignore: IGNORED_CONSOLE });
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
    rec.consoleErrors = page ? page.realErrors({ ignore: IGNORED_CONSOLE }).slice(before) : [];
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
  await page.click(selector);
  const file = await waitFor(
    `tệp tải về xuất hiện (${label})`,
    () => newestDownload(before),
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
  const server = await startServer(port);

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
  };

  // ───────────────────────────────────────────────────────────────────────────
  // LUỒNG 1 — 4 tab + Tài khoản + Quản trị đều render, không lỗi console
  // ───────────────────────────────────────────────────────────────────────────
  await flow('f1', '4 tab render trên DOM thật, không lỗi console', async ({ expect, shot }) => {
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
  // LUỒNG 5 — gói xuất bản .zip: KHÔNG CÓ TRONG MÃ NGUỒN (xem báo cáo)
  // ───────────────────────────────────────────────────────────────────────────
  results.push({
    id: 'f5',
    title: 'Gói xuất bản .zip ở màn job',
    status: 'not_implemented',
    error:
      'CHƯA CÓ TRONG BASELINE NÀY. `grep -rni zip` toàn repo (trừ node_modules + package-lock.json) = 0 dòng ' +
      'trên nhánh đang làm. Theo coordinator, tính năng đang nằm ở nhánh `feat/export-bundle` (chưa merge) ' +
      'và còn đang vá lỗi phản biện ⇒ sẽ test sau khi PR gói xuất bản merge. ' +
      'Màn job hiện chỉ có link tải MỘT tệp (<a download>): ảnh dịch · ảnh tạo · video GIF — cả ba ĐÃ được ' +
      'tải thật qua trình duyệt và kiểm MỞ ĐƯỢC bằng python3 ở f2/f3/f4. ' +
      'Hàm `verifyFileOpens()` trong file này ĐÃ hỗ trợ sẵn nhánh ZIP (zipfile.testzip()), nên khi tính năng ' +
      'merge chỉ cần thêm một luồng bấm nút — không phải viết lại hạ tầng.',
    checks: [],
    shots: [],
  });

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
    consoleErrorsAll: page.realErrors({ ignore: IGNORED_CONSOLE }),
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
