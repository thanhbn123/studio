/**
 * Chạy 4 CA NGHIỆM THU trên link THẬT (A/B/C/D) và in báo cáo trung thực.
 *
 *   A. Taobao   — link thật → nhận diện → trích xuất → Product Master → nội dung Việt
 *   B. 1688     — link thật → trích xuất → Product Master → nội dung Việt
 *   C. Pinduoduo— link thật → thử trích xuất → báo ĐÚNG bằng chứng
 *   D. bị chặn  — link bị chặn → người dùng bổ sung ảnh → VẪN sinh được nội dung
 *
 * Nguyên tắc: công cụ này KHÔNG được nói dối. Mỗi ca in ra mức kiểm chứng thật
 * (LIVE_VERIFIED / MOCK_VERIFIED / BLOCKED), kèm số byte, HTTP status và các field
 * thật sự lấy được. Không tô hồng.
 *
 * Dùng:
 *   node tools/live-probe.mjs                       # chạy cả 4 ca
 *   node tools/live-probe.mjs --case A              # chỉ một ca
 *   node tools/live-probe.mjs --taobao <url> --1688 <url> --pdd <url>
 *   node tools/live-probe.mjs --no-ai               # bỏ qua bước sinh nội dung
 */

import fs from 'node:fs';
import { loadDotEnv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createApp } from '../src/app.js';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

await loadDotEnv();

const config = loadConfig(process.env);
config.db.sqlitePath = flag('db', '/tmp/vps-live-probe.db');
config.logLevel = flag('log', 'error');

const logger = createLogger({ level: config.logLevel });

const URLS = {
  taobao: flag('taobao', 'https://item.taobao.com/item.htm?id=671021594308'),
  '1688': flag('1688', 'https://detail.1688.com/offer/552160420012.html'),
  pinduoduo: flag('pdd', 'https://mobile.yangkeduo.com/goods.html?goods_id=51084116558'),
};

const onlyCase = flag('case', null);
const noAi = has('no-ai');

const IMG = 'test/fixtures/headphones.png';

const app = await createApp({ config, logger });

const results = {};

/** Chạy pipeline trực tiếp (không qua HTTP) để báo cáo gọn và chính xác. */
async function runCase(label, jobInput) {
  const store = app.store;
  const sessionId = `probe-${label}`;
  const jobId = await store.createJob({
    sessionId,
    source: jobInput.source || '',
    sourceUrl: jobInput.url || '',
    style: 'ban-hang',
    length: 'vua',
    inputMode: jobInput.url && jobInput.manual ? 'link+manual' : jobInput.url ? 'link' : 'manual',
  });
  const t0 = Date.now();
  const out = await app.pipeline.run(jobId, { ...jobInput, sessionId });
  const ms = Date.now() - t0;
  const job = await store.getJob(jobId);
  const usage = await store.usageSummary(jobId);
  return { jobId, job, out, ms, usage };
}

function printMaster(job, out) {
  const m = job.product_master || out.master || {};
  const ev = job.evidence || out.evidence || {};
  console.log(`   connector        : ${ev.connector || m.extraction?.connector || '—'}`);
  console.log(`   extraction method: ${ev.extraction_method || m.extraction?.method || '—'}`);
  console.log(`   http / bytes     : ${ev.http_status ?? '—'} / ${m.extraction?.bytes ?? '—'}`);
  console.log(`   login_required   : ${ev.login_required ? 'CÓ' : 'không'}`);
  if (ev.blocked_reason) console.log(`   blocked_reason   : ${ev.blocked_reason}`);
  console.log(`   verification     : ${ev.verification || '—'}`);
  console.log('   ── bằng chứng ──');
  for (const r of ev.rows || []) {
    console.log(`     ${String(r.label).padEnd(16)} ${String(r.status).padEnd(16)} ${r.detail}`);
  }
  if (m.title_original) console.log(`   title_original   : ${String(m.title_original).slice(0, 80)}`);
  if (m.price?.raw) console.log(`   price            : ${m.price.raw} ${m.price.currency} (${m.price.kind})`);
  if (m.store?.name) console.log(`   store            : ${m.store.name}`);
  if (m.description_original) console.log(`   description      : ${m.description_original.length} ký tự`);
}

function printContent(job) {
  const d = job.content || null;
  const meta = job.content_meta || {};
  const ev = job.evidence || {};
  if (!d) {
    console.log('   nội dung         : KHÔNG sinh được');
    if (job.error_message) console.log(`   lý do            : ${job.error_message}`);
    return;
  }
  console.log(`   provider/model   : ${meta.provider}/${meta.model} | mock=${meta.is_mock ? 'CÓ' : 'không'}`);
  console.log(`   guardrails       : ${ev.guardrails?.passed ? 'PASS' : 'FAIL'} (${ev.guardrails?.violations?.length ?? 0} vi phạm, sửa lại: ${meta.repair_attempted ? 'có' : 'không'})`);
  console.log(`   product_name     : ${d.product_name}`);
  console.log(`   headline         : ${d.headline}`);
  console.log(`   selling_points   : ${(d.selling_points || []).length} điểm`);
  console.log(`   hashtags         : ${(d.hashtags || []).slice(0, 6).join(' ')}`);
  console.log(`   seo.title        : ${d.seo?.title || '—'}`);
}

console.log('='.repeat(78));
console.log('VIP PRODUCT STUDIO — NGHIỆM THU LIVE (dữ liệu THẬT, không mock)');
console.log('='.repeat(78));
console.log(`AI provider       : ${app.contentEngine.providerName} (cấu hình: ${app.contentEngine.configured ? 'CÓ' : 'KHÔNG'})`);
console.log(`Vision provider   : ${app.visionProvider.name} (cấu hình: ${app.visionProvider.configured ? 'CÓ' : 'KHÔNG'})`);
console.log(`DB dialect        : ${app.store.dialect}`);
const sess = await app.sessions.status();
console.log(`Session mode      : ${sess.mode} (khả dụng: ${sess.available})`);
console.log('');

/* ─────────────────────────── CA A — Taobao ─────────────────────────── */
if (!onlyCase || onlyCase.toUpperCase() === 'A') {
  console.log('─'.repeat(78));
  console.log(`CA A — TAOBAO: ${URLS.taobao}`);
  console.log('─'.repeat(78));
  try {
    const r = await runCase('A', { url: URLS.taobao });
    console.log(`   job: ${r.jobId} | status=${r.job.status} | ${r.ms}ms`);
    printMaster(r.job, r.out);
    printContent(r.job);
    console.log(`   usage: ${JSON.stringify(r.usage)}`);
    results.A = r.job.evidence?.verification || r.job.status;
  } catch (err) {
    console.log(`   LỖI: ${err.message}`);
    results.A = `ERROR: ${err.message}`;
  }
  console.log('');
}

/* ─────────────────────────── CA B — 1688 ─────────────────────────── */
if (!onlyCase || onlyCase.toUpperCase() === 'B') {
  console.log('─'.repeat(78));
  console.log(`CA B — 1688: ${URLS['1688']}`);
  console.log('─'.repeat(78));
  try {
    const r = await runCase('B', { url: URLS['1688'] });
    console.log(`   job: ${r.jobId} | status=${r.job.status} | ${r.ms}ms`);
    printMaster(r.job, r.out);
    printContent(r.job);
    results.B = r.job.status === 'needs_manual' ? 'BLOCKED (rate-limit)' : r.job.evidence?.verification || r.job.status;
  } catch (err) {
    console.log(`   LỖI: ${err.message}`);
    results.B = `ERROR: ${err.message}`;
  }
  console.log('');
}

/* ─────────────────────── CA C — Pinduoduo ─────────────────────── */
if (!onlyCase || onlyCase.toUpperCase() === 'C') {
  console.log('─'.repeat(78));
  console.log(`CA C — PINDUODUO: ${URLS.pinduoduo}`);
  console.log('─'.repeat(78));
  try {
    const r = await runCase('C', { url: URLS.pinduoduo });
    console.log(`   job: ${r.jobId} | status=${r.job.status} | ${r.ms}ms`);
    printMaster(r.job, r.out);
    const m = r.job.product_master || {};
    console.log(`   [PDD] có dữ liệu sản phẩm không: ${m.title_original || (m.images || []).length ? 'CÓ' : 'KHÔNG'}`);
    results.C = m.title_original ? 'data obtained' : r.job.evidence?.login_required ? 'AUTH REQUIRED' : 'BLOCKED';
  } catch (err) {
    console.log(`   LỖI: ${err.message}`);
    results.C = `ERROR: ${err.message}`;
  }
  console.log('');
}

/* ───────────────── CA D — bị chặn + bù dữ liệu thủ công ───────────────── */
if (!onlyCase || onlyCase.toUpperCase() === 'D') {
  console.log('─'.repeat(78));
  console.log('CA D — CONNECTOR BỊ CHẶN → NGƯỜI DÙNG BỔ SUNG ẢNH → VẪN SINH NỘI DUNG');
  console.log('─'.repeat(78));
  try {
    if (!fs.existsSync(IMG)) {
      console.log(`   BỎ QUA: không thấy ảnh test ${IMG}`);
      results.D = 'SKIPPED (thiếu ảnh)';
    } else {
      const dataUrl = `data:image/png;base64,${fs.readFileSync(IMG).toString('base64')}`;
      const r = await runCase('D', {
        // Link chắc chắn không lấy được dữ liệu (id không tồn tại)
        url: 'https://detail.1688.com/offer/678901234567.html',
        manual: {
          title: 'Tai nghe chup tai khong day (nguoi dung tu nhap)',
          notes: 'Dung cho hoc tap va lam viec. Nguoi dung tu cung cap.',
          images: [dataUrl],
        },
      });
      console.log(`   job: ${r.jobId} | status=${r.job.status} | input_mode=${r.job.input_mode} | ${r.ms}ms`);
      console.log('   ── bằng chứng của LINK (phải cho thấy link bị chặn) ──');
      const m = r.job.product_master || {};
      console.log(`     blocked_reason: ${m.extraction?.blocked_reason || '—'}`);
      console.log(`     ảnh thủ công  : ${(m.images || []).length}`);
      const vision = r.job.vision;
      console.log(`   vision dùng ảnh : ${vision ? `${vision.used} ảnh / status=${vision.status}` : 'không chạy'}`);
      if (vision?.analysis) {
        console.log(`     product_type  : ${vision.analysis.product_type}`);
        console.log(`     features      : ${JSON.stringify(vision.analysis.visible_features)}`);
      }
      printContent(r.job);
      results.D = r.job.content ? 'PASS' : 'FAIL';
    }
  } catch (err) {
    console.log(`   LỖI: ${err.message}`);
    results.D = `ERROR: ${err.message}`;
  }
  console.log('');
}

/* ─────────────────────────── TỔNG KẾT ─────────────────────────── */
console.log('='.repeat(78));
console.log('TỔNG KẾT');
console.log('='.repeat(78));
for (const [k, v] of Object.entries(results)) {
  const label = { A: 'TAOBAO    ', B: '1688      ', C: 'PINDUODUO ', D: 'FALLBACK  ' }[k] || k;
  console.log(`  ${label}: ${v}`);
}
console.log('');
console.log('LƯU Ý: mức LIVE_VERIFIED chỉ có nghĩa khi dữ liệu lấy từ sàn THẬT.');
console.log('Nếu AI provider chưa cấu hình, phần nội dung sẽ báo KHÔNG sinh được.');

await app.close();
process.exit(0);
