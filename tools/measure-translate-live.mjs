#!/usr/bin/env node
/**
 * ĐO DỊCH THẬT BẰNG PROVIDER TRẢ TIỀN (harness một lần, chạy lại được).
 *
 * Mục đích: lần đầu gọi provider THẬT để đo chất lượng dịch + chi phí + guardrails,
 * rồi ghi nhãn `LIVE_VERIFIED` ĐÚNG SỰ THẬT. Không bịa: mọi số trong báo cáo đều do
 * file này in ra từ phản hồi thật của API.
 *
 * LUẬT TIỀN (trần cứng, không vượt được bằng cấu hình sai):
 *   - `--max-calls` (mặc định 5): quá trần ⇒ NÉM LỖI, không gọi nữa.
 *   - `--max-output-tokens` (mặc định 2048 = đúng trần sản phẩm đang dùng ở ai.js).
 *   - `--max-input-tokens` (mặc định 3000): ước tính trước khi gọi, vượt ⇒ từ chối gọi.
 *   - `--budget-usd` (mặc định 0.8): tổng chi phí ước tính vượt ⇒ DỪNG NGAY, không gọi tiếp.
 *
 * ĐƯỜNG ĐI ĐƯỢC ĐO: `createTranslator()` của sản phẩm với `TRANSLATE_PROVIDER=ai`.
 * Harness KHÔNG tự gọi HTTP thô. Nó chỉ BỌC provider thật (`createProvider`) bằng một
 * lớp đo/chặn tiền (`BudgetGuard`) rồi bơm vào `createTranslator` qua `aiProvider`.
 * Mọi thứ còn lại — prompt, chia lô, parse JSON, guardrails — là mã sản phẩm.
 *
 * BẢO MẬT: API key chỉ dùng để tạo header. Mọi nơi in ra đều dùng `maskKey()`.
 *
 * Dùng:
 *   node tools/measure-translate-live.mjs --dry-run                 # mock, 0 đồng
 *   node tools/measure-translate-live.mjs --env-file /path/to/.env  # gọi thật
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createProvider } from '../src/ai/provider.js';
import { createTranslator, enforceTranslationGuardrails } from '../src/imagelab/translate/index.js';

/* ─────────────────────────── Bảng giá (có nguồn) ─────────────────────────── */

/**
 * Giá DeepSeek, USD / 1 TRIỆU token.
 * NGUỒN: https://api-docs.deepseek.com/quick_start/pricing
 * NGÀY ĐỌC NGUỒN: 2026-10-09. Bảng giá này có hiệu lực từ 04:00 UTC 2026-09-10
 *   (https://api-docs.deepseek.com/news/news260910).
 * Giờ cao điểm: 01:00–04:00 và 06:00–10:00 UTC, Thứ Hai–Thứ Sáu. Ngoài ra là thấp điểm,
 *   giá thấp điểm = một nửa giá cao điểm (footnote (2) của trang trên).
 *
 * ⚠️ `deepseek-chat` KHÔNG còn trong danh sách model: changelog 2026-04-24 khai tử
 *    `deepseek-chat`/`deepseek-reasoner` từ 2026-07-24. Giữ lại ở đây CHỈ để probe.
 */
export const DEEPSEEK_PRICES = Object.freeze({
  'deepseek-flash': {
    peak: { in_miss: 0.3, in_hit: 0.006, out: 1.2 },
    offpeak: { in_miss: 0.15, in_hit: 0.003, out: 0.6 },
  },
  'deepseek-v4-pro': {
    peak: { in_miss: 1.32, in_hit: 0.044, out: 3.96 },
    offpeak: { in_miss: 0.66, in_hit: 0.022, out: 1.98 },
  },
});

export const PRICE_SOURCE = Object.freeze({
  url: 'https://api-docs.deepseek.com/quick_start/pricing',
  read_on: '2026-10-09',
  effective_since: '2026-09-10T04:00:00Z',
  note: 'Giá thấp điểm = 1/2 giá cao điểm. Cao điểm: 01:00-04:00 và 06:00-10:00 UTC, Mon-Fri.',
});

/** Giờ này là cao điểm hay thấp điểm theo đúng định nghĩa của DeepSeek. */
export function peakWindowAt(date = new Date()) {
  const day = date.getUTCDay(); // 0=CN, 6=T7
  const hour = date.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  const inWindow = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
  // Lưu ý: không trừ ngày lễ Trung Quốc ⇒ có thể ĐẮT HƠN thực tế, tức ước tính an toàn.
  return weekday && inWindow ? 'peak' : 'offpeak';
}

/**
 * Chi phí một lời gọi, từ usage THẬT do API trả về.
 * DeepSeek trả `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`; thiếu thì coi
 * như MISS hết (đắt hơn ⇒ ước tính an toàn, không bao giờ báo rẻ hơn thực tế).
 */
export function costOfUsage(model, usage, window) {
  const key = Object.keys(DEEPSEEK_PRICES).find((k) => String(model || '').includes(k));
  if (!key || !usage) return null;
  const p = DEEPSEEK_PRICES[key][window];
  const prompt = Number(usage.prompt_tokens ?? 0);
  const hit = Number(usage.prompt_cache_hit_tokens ?? 0);
  const miss = Number(usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit));
  const out = Number(usage.completion_tokens ?? 0);
  return {
    price_key: key,
    window,
    in_hit_tokens: hit,
    in_miss_tokens: miss,
    out_tokens: out,
    usd: (hit / 1e6) * p.in_hit + (miss / 1e6) * p.in_miss + (out / 1e6) * p.out,
  };
}

/* ───────────────────────────── Tiện ích an toàn ───────────────────────────── */

/** Che key: chỉ còn tiền tố + 4 ký tự cuối. KHÔNG BAO GIỜ in key đầy đủ. */
export function maskKey(key) {
  const s = String(key || '');
  if (!s) return '(rỗng)';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

/** Đọc .env thủ công — không thêm dependency. */
export function readEnvFile(path) {
  const out = {};
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Không đọc được file env "${path}": ${err.code || err.message}`);
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Ước tính token TRƯỚC khi gọi (để chặn, không để báo cáo).
 * Chữ Hán ≈ 1 token/ký tự; Latin ≈ 1 token/4 ký tự. Cố tình ước CAO để chặn sớm.
 */
export function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[㐀-䶿一-鿿豈-﫿]/g) || []).length;
  const rest = s.length - cjk;
  return cjk + Math.ceil(rest / 3);
}

/* ────────────────────── Lớp bọc đo + chặn tiền (trần cứng) ────────────────── */

export class BudgetExceeded extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BudgetExceeded';
    this.code = 'HARNESS_BUDGET_STOP';
    this.details = details;
  }
}

/**
 * Bọc provider THẬT. Không đổi prompt, không đổi endpoint — chỉ:
 *   đếm lời gọi · siết maxTokens · chặn input quá to · cộng chi phí · dừng khi quá trần.
 */
export class BudgetGuard {
  constructor(inner, limits) {
    this.inner = inner;
    this.limits = limits;
    this.calls = [];
    this.totalUsd = 0;
    this.stopped = null;
  }

  get name() { return this.inner.name; }
  get model() { return this.inner.model; }
  get configured() { return this.inner.configured; }

  get billedCalls() { return this.calls.filter((c) => c.billed).length; }

  async chat(messages, opts = {}) {
    if (this.stopped) {
      throw new BudgetExceeded(`Harness đã dừng: ${this.stopped}`, { reason: this.stopped });
    }
    if (this.billedCalls >= this.limits.maxCalls) {
      this.stopped = `đã dùng hết trần ${this.limits.maxCalls} lời gọi`;
      throw new BudgetExceeded(`Vượt trần ${this.limits.maxCalls} lời gọi — từ chối gọi thêm.`, {
        maxCalls: this.limits.maxCalls,
      });
    }
    if (this.totalUsd >= this.limits.budgetUsd) {
      this.stopped = `tổng chi phí ${this.totalUsd.toFixed(6)} USD đạt trần ${this.limits.budgetUsd} USD`;
      throw new BudgetExceeded(`Tổng chi phí đạt trần ${this.limits.budgetUsd} USD — DỪNG.`, {
        totalUsd: this.totalUsd,
      });
    }

    const promptChars = messages.reduce((n, m) => n + String(m.text || '').length, 0);
    // Bằng chứng vùng nào THỰC SỰ được gửi đi: rút `region_id:` ra khỏi prompt sản phẩm dựng.
    const joined = messages.map((m) => String(m.text || '')).join('\n');
    const sentIds = [...joined.matchAll(/region_id:\s*(\S+)/g)].map((m) => m[1]);
    const estIn = messages.reduce((n, m) => n + estimateTokens(m.text), 0);
    if (estIn > this.limits.maxInputTokens) {
      this.stopped = `input ước tính ${estIn} token > trần ${this.limits.maxInputTokens}`;
      throw new BudgetExceeded(
        `Input ước tính ${estIn} token vượt trần ${this.limits.maxInputTokens} — từ chối gọi.`,
        { estIn, maxInputTokens: this.limits.maxInputTokens },
      );
    }

    // Siết trần output: không bao giờ cho phép lớn hơn trần harness.
    const askedMax = Number(opts.maxTokens ?? 4096);
    const cappedMax = Math.min(askedMax, this.limits.maxOutputTokens);

    const t0 = performance.now();
    let res = null;
    let error = null;
    try {
      res = await this.inner.chat(messages, { ...opts, maxTokens: cappedMax });
    } catch (err) {
      error = err;
    }
    const ms = performance.now() - t0;

    const window = peakWindowAt(new Date());
    const cost = res ? costOfUsage(res.model || this.inner.model, res.usage, window) : null;
    // Lời gọi bị API từ chối (4xx) KHÔNG phát sinh token ⇒ không tính là billed.
    const billed = Boolean(res);
    if (cost) this.totalUsd += cost.usd;

    this.calls.push({
      index: this.calls.length + 1,
      billed,
      ms: Number(ms.toFixed(1)),
      model: res?.model ?? this.inner.model,
      prompt_chars: promptChars,
      sent_region_ids: sentIds,
      est_input_tokens: estIn,
      max_tokens_asked: askedMax,
      max_tokens_sent: cappedMax,
      usage: res?.usage ?? null,
      finish_reason: res?.finish_reason ?? null,
      cost,
      error: error ? { code: error.code || error.name, message: String(error.message).slice(0, 300) } : null,
    });

    if (error) throw error;
    if (this.totalUsd > this.limits.budgetUsd) {
      this.stopped = `tổng chi phí ${this.totalUsd.toFixed(6)} USD vượt trần ${this.limits.budgetUsd} USD`;
    }
    return res;
  }
}

/* ───────────────────────── 5 sản phẩm mẫu (tiếng Trung) ──────────────────── */

/**
 * Năm sản phẩm tự soạn theo kiểu hàng thật trên Taobao/1688: tiêu đề + 5 điểm bán +
 * mô tả ngắn. Mỗi sản phẩm còn mang MỘT "mẫu thử guardrail" để đo luật trên dữ liệu thật:
 *
 *   probe.brand       — chứa 官方 ⇒ phải SKIPPED_BRAND, KHÔNG được gửi cho provider
 *   probe.cert        — chứa 质检/认证 ⇒ phải SKIPPED_CERTIFICATION, KHÔNG được gửi
 *   probe.price       — chứa ￥ + số ⇒ phải SKIPPED_PRICE, KHÔNG được gửi
 *   probe.warranty    — 保修12个月: CÓ khẳng định trong bản gốc ⇒ dịch được, KHÔNG bị tố oan
 *   probe.genuine     — 正品行货: CÓ khẳng định trong bản gốc ⇒ dịch được, KHÔNG bị tố oan
 *   probe.digits      — 5000mAh/72小时: số phải được giữ nguyên, lệch số ⇒ phải bị chặn
 */
export const PRODUCTS = Object.freeze([
  {
    sku: 'P1-juicer',
    context: 'Máy ép trái cây mini cầm tay, ảnh trang chi tiết Taobao',
    regions: [
      { id: 'r1', kind: 'descriptive', text: '便携式迷你榨汁机家用小型多功能果汁杯' },
      { id: 'r2', kind: 'descriptive', text: '一键启动，六叶刀头快速打碎水果' },
      { id: 'r3', kind: 'descriptive', text: '容量300ml，一人份刚好够喝' },
      { id: 'r4', kind: 'descriptive', text: 'USB充电，充满一次可用八杯' },
      { id: 'r5', kind: 'descriptive', text: '食品级材质，杯体可拆洗' },
      { id: 'r6', kind: 'descriptive', text: '底部防滑垫，放在桌上不晃动' },
      { id: 'r7', kind: 'descriptive', text: '上班族早餐、健身人群代餐都能用，办公室也放得下。' },
      { id: 'g-genuine', kind: 'descriptive', text: '正品行货，支持七天无理由退换', probe: 'genuine' },
      { id: 'g-brand', text: '官方旗舰店授权销售', probe: 'brand' },
    ],
  },
  {
    sku: 'P2-earbuds',
    context: 'Tai nghe không dây Bluetooth, ảnh trang chi tiết',
    regions: [
      { id: 'r1', kind: 'descriptive', text: '无线蓝牙耳机入耳式降噪运动跑步专用' },
      { id: 'r2', kind: 'descriptive', text: '蓝牙5.3芯片，连接稳定不断线' },
      { id: 'r3', kind: 'descriptive', text: '单耳重量仅4克，久戴不累' },
      { id: 'r4', kind: 'descriptive', text: '触控操作，轻点两下切换歌曲' },
      { id: 'r5', kind: 'descriptive', text: '双麦克风通话，风噪明显减少' },
      { id: 'r6', kind: 'descriptive', text: '充电仓可再充四次，出门不用带线' },
      { id: 'r7', kind: 'descriptive', text: '适合通勤、健身房和日常通话，安卓苹果手机都能连。' },
      { id: 'g-digits', kind: 'descriptive', text: '电池容量5000mAh，续航72小时', probe: 'digits' },
      { id: 'g-cert', text: '已通过质检，附检测报告与合格证', probe: 'cert' },
    ],
  },
  {
    sku: 'P3-dress',
    context: 'Váy liền thân lụa nữ, ảnh trang chi tiết',
    regions: [
      { id: 'r1', kind: 'descriptive', text: '女士真丝连衣裙夏季新款气质长裙' },
      { id: 'r2', kind: 'descriptive', text: '桑蚕丝面料，垂感好不贴身' },
      { id: 'r3', kind: 'descriptive', text: '收腰设计，显腰线又不紧绷' },
      { id: 'r4', kind: 'descriptive', text: '裙长115厘米，适合身高160至170' },
      { id: 'r5', kind: 'descriptive', text: '隐形侧拉链，穿脱方便' },
      { id: 'r6', kind: 'descriptive', text: '三个颜色可选：藏青、米白、豆绿' },
      { id: 'r7', kind: 'descriptive', text: '上班、约会、度假都好搭，建议手洗或送干洗。' },
      { id: 'g-price', text: '原价￥299 现价￥199 券后到手价更低', probe: 'price' },
    ],
  },
  {
    sku: 'P4-thermos',
    context: 'Bình giữ nhiệt inox, ảnh trang chi tiết',
    regions: [
      { id: 'r1', kind: 'descriptive', text: '不锈钢保温杯大容量便携车载水杯' },
      { id: 'r2', kind: 'descriptive', text: '内胆316不锈钢，不生锈无异味' },
      { id: 'r3', kind: 'descriptive', text: '保温六小时后水温仍有55度' },
      { id: 'r4', kind: 'descriptive', text: '杯口直径5厘米，放得进冰块' },
      { id: 'r5', kind: 'descriptive', text: '杯盖双层密封，倒放也不漏水' },
      { id: 'r6', kind: 'descriptive', text: '容量500毫升，车门储物格放得下' },
      { id: 'r7', kind: 'descriptive', text: '上班通勤、开车出差、户外爬山都合适，手洗即可。' },
      { id: 'g-warranty', kind: 'descriptive', text: '保修12个月，杯体破损可换新', probe: 'warranty' },
    ],
  },
  {
    sku: 'P5-smartwatch',
    context: 'Đồng hồ thông minh, ảnh trang chi tiết',
    regions: [
      { id: 'r1', kind: 'descriptive', text: '智能手表运动计步心率监测多功能腕表' },
      { id: 'r2', kind: 'descriptive', text: '1.85英寸高清屏，阳光下也看得清' },
      { id: 'r3', kind: 'descriptive', text: '支持二十种运动模式记录' },
      { id: 'r4', kind: 'descriptive', text: '心率与血氧每五分钟测一次' },
      { id: 'r5', kind: 'descriptive', text: '表带可换，硅胶和金属两种' },
      { id: 'r6', kind: 'descriptive', text: '充电两小时，日常使用约七天' },
      { id: 'r7', kind: 'descriptive', text: '来电和消息直接在手表上看，跑步时不用掏手机。' },
      { id: 'g-digits2', kind: 'descriptive', text: '待机时长可达30天，充电口为磁吸式', probe: 'digits' },
    ],
  },
]);

/* ─────────── Lớp C: bắt BỊA — tiêm khẳng định/số vào bản dịch THẬT ─────────── */

/**
 * Lấy bản dịch THẬT của model rồi cố tình tiêm thêm khẳng định / con số không có
 * trong bản gốc, chạy lại `enforceTranslationGuardrails` để xem luật có bắt không.
 * Đây là đột biến NHÂN TẠO trên dữ liệu THẬT — báo cáo phải nói rõ như vậy.
 */
export const MUTATIONS = Object.freeze([
  { id: 'M1-warranty', suffix: ' — bảo hành 24 tháng', expect: ['bảo hành', '24'] },
  { id: 'M2-genuine', suffix: ' — hàng chính hãng', expect: ['chính hãng'] },
  { id: 'M3-number', suffix: ' — dùng được 15 năm', expect: ['15'] },
  { id: 'M4-cert', suffix: ' — đã đạt chuẩn ISO 9001', expect: ['chứng nhận|đạt chuẩn|ISO'] },
]);

export function runMutationProbes(lines) {
  // Chọn những dòng ĐÃ dịch được, bản gốc KHÔNG chứa khẳng định tương ứng.
  const candidates = lines.filter(
    (l) => l.text_vi && l.status === 'TRANSLATED' && (l.violations || []).length === 0,
  );
  const out = [];
  for (const mut of MUTATIONS) {
    const base = candidates[out.length % Math.max(1, candidates.length)];
    if (!base) break;
    const mutated = { ...base, text_vi: `${base.text_vi}${mut.suffix}`, violations: [] };
    const { line, violations } = enforceTranslationGuardrails(mutated, {
      region: { kind: base.kind || 'descriptive', text: base.text_original },
    });
    out.push({
      mutation: mut.id,
      region_id: base.region_id ?? base.id,
      text_original: base.text_original,
      text_vi_real: base.text_vi,
      text_vi_mutated: mutated.text_vi,
      status_after: line.status,
      violations,
      caught: violations.length > 0 && line.status === 'NEEDS_REVIEW',
    });
  }
  return out;
}

/* ─────────────────────────────────── main ────────────────────────────────── */

function parseArgs(argv) {
  const a = {
    envFile: '.env',
    model: 'deepseek-flash',
    maxCalls: 5,
    maxInputTokens: 3000,
    maxOutputTokens: 2048,
    budgetUsd: 0.8,
    out: '',
    dryRun: false,
    probeLegacy: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--env-file': a.envFile = v; i += 1; break;
      case '--model': a.model = v; i += 1; break;
      case '--max-calls': a.maxCalls = Number(v); i += 1; break;
      case '--max-input-tokens': a.maxInputTokens = Number(v); i += 1; break;
      case '--max-output-tokens': a.maxOutputTokens = Number(v); i += 1; break;
      case '--budget-usd': a.budgetUsd = Number(v); i += 1; break;
      case '--out': a.out = v; i += 1; break;
      case '--dry-run': a.dryRun = true; break;
      case '--probe-legacy-model': a.probeLegacy = true; break;
      default:
        if (k.startsWith('--')) throw new Error(`Tham số không hiểu: ${k}`);
    }
  }
  return a;
}

/** Luật guardrail mong đợi cho từng mẫu thử, theo đúng thiết kế đã đọc trong mã. */
const PROBE_EXPECT = {
  brand: { status: 'SKIPPED_BRAND', sent: false },
  cert: { status: 'SKIPPED_CERTIFICATION', sent: false },
  price: { status: 'SKIPPED_PRICE', sent: false },
  warranty: { status: 'TRANSLATED', sent: true, noViolations: true },
  genuine: { status: 'TRANSLATED', sent: true, noViolations: true },
  digits: { status: 'TRANSLATED', sent: true, noViolations: true },
};

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date();

  // ── Khoá tiền: in rõ trần trước khi gọi bất cứ thứ gì.
  const limits = {
    maxCalls: args.maxCalls,
    maxInputTokens: args.maxInputTokens,
    maxOutputTokens: args.maxOutputTokens,
    budgetUsd: args.budgetUsd,
  };
  console.log('── TRẦN CỨNG ─────────────────────────────────────────');
  console.log(`  max_calls          = ${limits.maxCalls}`);
  console.log(`  max_input_tokens   = ${limits.maxInputTokens} (ước tính trước khi gọi)`);
  console.log(`  max_output_tokens  = ${limits.maxOutputTokens}`);
  console.log(`  budget_usd         = ${limits.budgetUsd} (vượt ⇒ DỪNG NGAY)`);
  console.log(`  khung giá hiện tại = ${peakWindowAt(startedAt)} (UTC ${startedAt.toISOString()})`);

  // ── Provider: mock khi --dry-run, còn lại là provider THẬT của sản phẩm.
  let transport;
  let keyMasked = '(không dùng)';
  let providerName;
  let modelUsed;

  if (args.dryRun) {
    transport = createProvider({ provider: 'mock' });
    providerName = 'mock';
    modelUsed = 'mock-1';
    console.log('\n⚠️  --dry-run: dùng MockProvider, KHÔNG gọi mạng, KHÔNG tốn tiền.');
  } else {
    const env = readEnvFile(resolve(args.envFile));
    const apiKey = env.TRANSLATE_API_KEY || env.AI_API_KEY || env.DEEPSEEK_API_KEY || '';
    if (!apiKey) {
      console.error(
        `\n✖ CHƯA CÓ KEY: file "${args.envFile}" không có TRANSLATE_API_KEY / AI_API_KEY / DEEPSEEK_API_KEY.\n` +
          '  DỪNG — không đo được. KHÔNG ghi LIVE_VERIFIED, không giả vờ đã đo.',
      );
      process.exit(2);
    }
    keyMasked = maskKey(apiKey);
    providerName = (env.TRANSLATE_PROVIDER || env.AI_PROVIDER || 'deepseek').toLowerCase();
    if (providerName === 'ai') providerName = (env.AI_PROVIDER || 'deepseek').toLowerCase();
    modelUsed = args.model;

    // Cấu hình đi ĐÚNG đường sản phẩm: config.translate.provider = 'ai'.
    const config = {
      translate: { provider: 'ai' },
      ai: {
        provider: providerName,
        apiKey,
        baseUrl: env.AI_BASE_URL || '',
        model: modelUsed,
        timeoutMs: 180000,
      },
    };
    const resolved = config.ai;
    transport = createProvider(
      { provider: resolved.provider, apiKey: resolved.apiKey, baseUrl: resolved.baseUrl, model: resolved.model, timeoutMs: resolved.timeoutMs },
      {},
    );
    console.log(`\n  provider           = ${providerName}`);
    console.log(`  model              = ${modelUsed}`);
    console.log(`  base_url           = ${transport.baseUrl}`);
    console.log(`  api_key            = ${keyMasked}  ← đã che, không bao giờ in đủ`);
  }

  const guard = new BudgetGuard(transport, limits);
  // Translator THẬT của sản phẩm; `aiProvider` chỉ để chèn lớp đo/chặn tiền vào giữa.
  const translator = createTranslator({ translate: { provider: 'ai' } }, { aiProvider: guard });
  console.log(`  translator.provider= ${translator.name}   translator.is_mock = ${translator.isMock}`);

  /* ── Probe tuỳ chọn: model cũ `deepseek-chat` còn sống không? (4xx ⇒ 0 token) ── */
  const legacyProbe = { ran: false };
  if (args.probeLegacy && !args.dryRun) {
    console.log('\n── PROBE model cũ `deepseek-chat` (lỗi 4xx không phát sinh token) ──');
    const legacy = createProvider(
      { provider: 'deepseek', apiKey: transport.apiKey, baseUrl: transport.baseUrl, model: 'deepseek-chat', timeoutMs: 60000 },
      {},
    );
    legacy.maxRetries = 0;
    legacyProbe.ran = true;
    legacyProbe.model = 'deepseek-chat';
    try {
      const r = await legacy.chat([{ role: 'user', text: 'ping' }], { maxTokens: 1 });
      legacyProbe.alive = true;
      legacyProbe.usage = r.usage || null;
      console.log(`  ⚠️  deepseek-chat VẪN trả lời. usage=${JSON.stringify(r.usage)}`);
    } catch (err) {
      legacyProbe.alive = false;
      legacyProbe.error_code = err.code || err.name;
      legacyProbe.error_message = String(err.message).slice(0, 300);
      legacyProbe.http_status = err.details?.status ?? null;
      console.log(`  ✓ deepseek-chat ĐÃ CHẾT: ${legacyProbe.error_code} / HTTP ${legacyProbe.http_status}`);
      console.log(`    ${legacyProbe.error_message}`);
    }
  }

  /* ─────────────────────── Đo 5 sản phẩm: 1 lời gọi/sản phẩm ─────────────────── */
  const results = [];
  let stoppedEarly = null;

  for (const product of PRODUCTS) {
    if (guard.stopped) { stoppedEarly = guard.stopped; break; }
    const callsBefore = guard.calls.length;
    const t0 = performance.now();
    const res = await translator.translateRegions(product.regions, { context: product.context });
    const wallMs = Number((performance.now() - t0).toFixed(1));
    const myCalls = guard.calls.slice(callsBefore);
    const sentIds = new Set(myCalls.flatMap((c) => c.sent_region_ids || []));

    const lines = res.lines.map((l) => ({
      region_id: l.region_id ?? l.id,
      kind: l.kind ?? '',
      text_original: l.text_original ?? '',
      text_vi: l.text_vi ?? '',
      status: l.status,
      provenance: l.provenance,
      confidence: l.confidence,
      violations: l.violations || [],
      notes: l.notes || '',
      sent_to_provider: sentIds.has(String(l.region_id ?? l.id)),
    }));

    // Chấm từng mẫu thử guardrail: đúng thiết kế hay không.
    const probes = product.regions
      .filter((r) => r.probe)
      .map((r) => {
        const line = lines.find((l) => l.region_id === r.id);
        const exp = PROBE_EXPECT[r.probe];
        const okStatus = line?.status === exp.status;
        const okSent = Boolean(line?.sent_to_provider) === exp.sent;
        const okViol = exp.noViolations ? (line?.violations.length ?? 1) === 0 : true;
        return {
          probe: r.probe,
          region_id: r.id,
          text_original: r.text,
          expect: exp,
          got: { status: line?.status, sent_to_provider: line?.sent_to_provider, violations: line?.violations ?? [] },
          text_vi: line?.text_vi ?? '',
          pass: okStatus && okSent && okViol,
        };
      });

    results.push({
      sku: product.sku,
      status: res.status,
      provider: res.provider,
      model: res.model,
      is_mock: res.is_mock,
      error_code: res.error_code,
      error_message: res.error_message,
      wall_ms: wallMs,
      api_calls: myCalls,
      lines,
      probes,
      warnings: res.warnings,
    });

    const c = myCalls[0];
    const usd = myCalls.reduce((s, x) => s + (x.cost?.usd ?? 0), 0);
    console.log(
      `\n[${product.sku}] ${res.status} · ${res.model} · ${myCalls.length} lời gọi · ${wallMs} ms` +
        ` · in ${c?.usage?.prompt_tokens ?? '?'} / out ${c?.usage?.completion_tokens ?? '?'} tok` +
        ` · ${usd.toFixed(6)} USD · tổng ${guard.totalUsd.toFixed(6)} USD`,
    );
    if (res.error_code) console.log(`   ✖ ${res.error_code}: ${res.error_message}`);
    for (const p of probes) {
      console.log(`   guardrail ${p.pass ? '✓' : '✖'} ${p.probe}: ${p.got.status} · gửi provider=${p.got.sent_to_provider}` +
        (p.got.violations.length ? ` · ${p.got.violations.length} vi phạm` : ''));
    }
  }

  /* ──────────────── Lớp C: tiêm khẳng định/số vào bản dịch THẬT ──────────────── */
  const allLines = results.flatMap((r) => r.lines);
  const mutations = runMutationProbes(allLines);
  console.log('\n── LỚP C: tiêm khẳng định/số vào bản dịch THẬT (0 đồng) ──');
  for (const m of mutations) {
    console.log(`  ${m.caught ? '✓ CHẶN' : '✖ LỌT'} ${m.mutation}: "${m.text_vi_mutated}" ⇒ ${m.status_after} (${m.violations.length} vi phạm)`);
    for (const v of m.violations) console.log(`      · ${v}`);
  }

  /* ────────────────────────────── Tổng kết ────────────────────────────── */
  const probesAll = results.flatMap((r) => r.probes);
  const summary = {
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    dry_run: args.dryRun,
    limits,
    price_source: PRICE_SOURCE,
    price_window: peakWindowAt(startedAt),
    provider: providerName,
    model: modelUsed,
    api_key_masked: keyMasked,
    legacy_probe: legacyProbe,
    billed_calls: guard.billedCalls,
    total_calls_recorded: guard.calls.length,
    total_usd: Number(guard.totalUsd.toFixed(6)),
    stopped_early: stoppedEarly,
    guard_stopped: guard.stopped,
    products_measured: results.length,
    probes_pass: probesAll.filter((p) => p.pass).length,
    probes_total: probesAll.length,
    mutations_caught: mutations.filter((m) => m.caught).length,
    mutations_total: mutations.length,
  };

  console.log('\n══ TỔNG KẾT ════════════════════════════════════════');
  console.log(`  sản phẩm đo được : ${summary.products_measured}/${PRODUCTS.length}`);
  console.log(`  lời gọi tính tiền: ${summary.billed_calls} (trần ${limits.maxCalls})`);
  console.log(`  TỔNG CHI PHÍ     : ${summary.total_usd} USD (trần ${limits.budgetUsd} USD)`);
  console.log(`  guardrail mẫu thử: ${summary.probes_pass}/${summary.probes_total} đúng thiết kế`);
  console.log(`  tiêm bịa bị chặn : ${summary.mutations_caught}/${summary.mutations_total}`);
  if (summary.guard_stopped) console.log(`  ⚠️  đã dừng sớm: ${summary.guard_stopped}`);

  const payload = { summary, products: results, mutations };
  if (args.out) {
    writeFileSync(resolve(args.out), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`\n  số liệu thô ⇒ ${args.out}`);
  }
  return payload;
}

main().catch((err) => {
  console.error(`\n✖ HARNESS LỖI: ${err.code || err.name}: ${err.message}`);
  process.exitCode = 1;
});
