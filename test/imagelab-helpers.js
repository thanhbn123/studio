/**
 * Tiện ích dùng chung cho bộ test MVP-02 (ImageLab).
 *
 * Nguyên tắc giống `test/helpers.js`: KHÔNG cần mạng, KHÔNG cần API key.
 * Mọi provider đều là bản thật chạy offline (mock OCR fixture, mock translator,
 * purejs render) hoặc bản giả do test tự dựng — trừ server HTTP nội bộ trên
 * 127.0.0.1 (giống `test/api.test.js`).
 *
 * File này KHÔNG có hậu tố `.test.js` nên `node --test test/*.test.js` không chạy nó.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/app.js';
import { createStore } from '../src/store/index.js';
import { ProductSourceConnector } from '../src/sources/base-connector.js';
import { STATUS } from '../src/product-master.js';
import { createImageStorage } from '../src/imagelab/storage.js';
import { createOcrProvider } from '../src/imagelab/ocr/index.js';
import { createTranslator } from '../src/imagelab/translate/index.js';
import { createRenderProvider, decodePng, encodePng, toRgba } from '../src/imagelab/render/index.js';
import { ImageTranslationPipeline } from '../src/imagelab/pipeline.js';
import { testConfig, silent, fakeContentEngine, fakeVisionProvider, fixtureBuffer } from './helpers.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Ảnh PNG thật 320×320 RGB dùng chung cho mọi test pixel. */
export const headphones = () => fixtureBuffer('headphones.png');

/* ───────────────────────── thư mục tạm ───────────────────────── */

const tempDirs = [];

/** Thư mục tạm NGOÀI repo — test không được ghi vào cây mã nguồn. */
export function tmpDir(prefix = 'vps-imagelab-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTmp() {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* dọn dẹp là best-effort */
    }
  }
}

/* ───────────────────────── HTTP tiện ích ───────────────────────── */

export async function j(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
}

export const cookie = (sid) => ({ cookie: `sid=${sid}` });
export const jsonHeaders = (sid) => ({ 'content-type': 'application/json', ...cookie(sid) });

export const postJson = (base, url, body, sid) =>
  fetch(`${base}${url}`, { method: 'POST', headers: jsonHeaders(sid), body: JSON.stringify(body) });

export const putJson = (base, url, body, sid) =>
  fetch(`${base}${url}`, { method: 'PUT', headers: jsonHeaders(sid), body: JSON.stringify(body) });

/** Chờ job rời khỏi trạng thái đang chạy (poll như UI thật). */
export async function waitJob(base, id, sid, { tries = 100, delay = 25, until } = {}) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    const res = await fetch(`${base}/api/imagelab/jobs/${id}`, { headers: cookie(sid) });
    last = await j(res);
    const status = last?.job?.status ?? last?.status;
    if (until ? until(last) : !['queued', 'running'].includes(status)) return last;
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`job ${id} không kết thúc kịp: ${JSON.stringify(last)?.slice(0, 300)}`);
}

/* ───────────────────────── cấu hình + stack ───────────────────────── */

/** Cấu hình test có thư mục ảnh riêng trong tmp (không đụng `data/imagelab`). */
export function imagelabConfig(overrides = {}) {
  return testConfig({ IMAGELAB_DIR: tmpDir(), ...overrides });
}

/**
 * Dựng đủ 5 mảnh của MVP-02 với provider THẬT chạy offline:
 * OCR mock (fixture), translator mock (từ điển), render purejs, storage tmp.
 */
export function makeImagelabStack(config = imagelabConfig(), { store } = {}) {
  const storage = createImageStorage(config, { logger: silent });
  const ocrProvider = createOcrProvider(config, { logger: silent });
  const translator = createTranslator(config, { logger: silent });
  const renderProvider = createRenderProvider(config, { logger: silent });
  const pipeline = new ImageTranslationPipeline({
    config,
    logger: silent,
    store,
    storage,
    ocrProvider,
    translator,
    renderProvider,
  });
  return { config, store, storage, ocrProvider, translator, renderProvider, pipeline };
}

/** Connector giả tối thiểu — chỉ để chứng minh MVP-01 còn chạy sau khi thêm MVP-02. */
export class FakeImagelabConnector extends ProductSourceConnector {
  static source = '1688';

  static displayName = 'FakeImagelabConnector';

  async fetchProduct() {
    return { html: '<html></html>', status: 200, finalUrl: this.homeUrl(), redirects: [], bytes: 10, method: 'fake' };
  }

  normalize(raw, master) {
    master.title_original = 'Sản phẩm giả lập MVP-01';
    master.title_original_status = STATUS.FOUND;
    master.images.push({ url: 'https://cbu01.alicdn.com/a.jpg', type: 'cover', status: STATUS.FOUND, provenance: 'source' });
    master.attributes.push({ name: 'Chất liệu', value: 'vải', status: STATUS.FOUND, provenance: 'source' });
    master.price = { raw: '12.5', currency: 'CNY', status: STATUS.FOUND, kind: 'fixed', tiers: [] };
    master.store = { name: 'Nhà máy giả lập', id: '1', url: '', status: STATUS.FOUND };
    return master;
  }
}

/**
 * Dựng app THẬT (server thật, SQLite in-memory) có gắn khối ImageLab.
 * `wireImagelab: false` mô phỏng lúc MVP-02 không khả dụng.
 */
export async function startImagelabApp({ configOverrides = {}, wireImagelab = true, config: provided } = {}) {
  const config = provided || imagelabConfig(configOverrides);
  const store = await createStore(config, silent);
  const opts = {
    config,
    logger: silent,
    store,
    connectors: [FakeImagelabConnector],
    visionProvider: fakeVisionProvider(),
    contentEngine: fakeContentEngine(),
  };

  let stack = { config, store };
  if (wireImagelab) {
    stack = { ...stack, ...makeImagelabStack(config, { store }) };
    opts.ocrProvider = stack.ocrProvider;
    opts.translator = stack.translator;
    opts.renderProvider = stack.renderProvider;
    opts.storage = stack.storage;
    opts.imagelabPipeline = stack.pipeline;
  }

  const app = await createApp(opts);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return {
    ...stack,
    app,
    base: `http://127.0.0.1:${app.server.address().port}`,
    async close() {
      await app.close();
      cleanupTmp();
    },
  };
}

/* ───────────────────────── provider giả cho test ───────────────────────── */

/**
 * Provider AI giả: ghi lại NGUYÊN VĂN messages để test kiểm được prompt
 * (đặc biệt: chuỗi vùng bị khoá KHÔNG được xuất hiện trong prompt).
 */
export function fakeAiProvider({ lines = [], model = 'fake-ai-1', fail = null } = {}) {
  const calls = [];
  return {
    name: 'fake-ai',
    model,
    configured: true,
    calls,
    async chat(messages, opts = {}) {
      calls.push({ messages, opts });
      if (fail) throw fail;
      return {
        content: JSON.stringify({ lines }),
        model,
        usage: { prompt_tokens: 11, completion_tokens: 7 },
        provider: 'fake-ai',
        finish_reason: 'stop',
      };
    },
  };
}

/** OCR provider giả: trả đúng vùng test yêu cầu, có thể ghi lại input. */
export function fakeOcrProvider({ regions = [], status = 'OK', model = 'fake-ocr-1', isMock = true, fail = null, errorCode = null } = {}) {
  const calls = [];
  return {
    name: 'fake-ocr',
    model,
    isMock,
    configured: true,
    calls,
    async detect(input = {}, options = {}) {
      calls.push({ input, options });
      if (fail) throw fail;
      if (errorCode) {
        return {
          status,
          provider: 'fake-ocr',
          model,
          is_mock: isMock,
          regions: [],
          dropped: [],
          warnings: [],
          usage: null,
          error_code: errorCode,
          error_message: 'OCR giả lập lỗi có mã.',
        };
      }
      return {
        status,
        provider: 'fake-ocr',
        model,
        is_mock: isMock,
        regions,
        dropped: [],
        warnings: [],
        usage: {
          input_units: (Number(input.width) || 0) * (Number(input.height) || 0),
          output_units: regions.length,
        },
        error_code: null,
        error_message: null,
      };
    },
  };
}

/** Render provider giả: trả lỗi có mã, hoặc ném lỗi — để test job không bị treo. */
export function fakeRenderProvider({ result = null, fail = null, name = 'fake-render', model = 'fake-1', isMock = false } = {}) {
  return {
    name,
    model,
    isMock,
    configured: true,
    async probe() {
      return null;
    },
    async render(params = {}) {
      if (fail) throw fail;
      return result ?? {
        status: 'OK',
        provider: name,
        model,
        is_mock: isMock,
        output: null,
        original_sha256: '',
        applied: [],
        skipped: [],
        unsupported_glyphs: [],
        warnings: [],
        elapsed_ms: 1,
        error_code: null,
        error_message: null,
      };
    },
    lastParams: null,
  };
}

/* ───────────────────── pixel: ảnh tổng hợp + đếm pixel đổi ─────────────────────
 *
 * Dùng cho test hồi quy F-01/F-02: phải ĐẾM PIXEL THẬT trong buffer PNG, không chỉ
 * tin vào danh sách `applied`/`skipped` mà hệ thống tự báo (luật #1: không bịa).
 */

/**
 * Ảnh PNG tổng hợp: nền `background` (mặc định trắng đục), tô đặc các hộp trong `fills`.
 */
export function makeTestImage({ width = 320, height = 320, background = [255, 255, 255, 255], fills = [] } = {}) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = background[0];
    data[i * 4 + 1] = background[1];
    data[i * 4 + 2] = background[2];
    data[i * 4 + 3] = background[3] ?? 255;
  }
  for (const { box, rgba } of fills) {
    for (let y = Math.max(0, box.y); y < Math.min(height, box.y + box.h); y += 1) {
      for (let x = Math.max(0, box.x); x < Math.min(width, box.x + box.w); x += 1) {
        const i = (y * width + x) * 4;
        data[i] = rgba[0];
        data[i + 1] = rgba[1];
        data[i + 2] = rgba[2];
        data[i + 3] = rgba[3] ?? 255;
      }
    }
  }
  return encodePng({ width, height, data, channels: 4 });
}

/**
 * Đếm số pixel BỊ ĐỔI trong `box` giữa hai ảnh PNG (RGBA, so cả alpha).
 * @returns {{changed:number, total:number, first:{x:number,y:number,before:number[],after:number[]}|null}}
 */
export function countChangedPixels(pngBefore, pngAfter, box) {
  const before = decodePng(pngBefore);
  const after = decodePng(pngAfter);
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`hai ảnh khác kích thước: ${before.width}×${before.height} vs ${after.width}×${after.height}`);
  }
  const a = toRgba(before);
  const b = toRgba(after);
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(before.width, Math.round(box.x + box.w));
  const y1 = Math.min(before.height, Math.round(box.y + box.h));
  let changed = 0;
  let first = null;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * before.width + x) * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
        changed += 1;
        if (!first) {
          first = { x, y, before: [a[i], a[i + 1], a[i + 2], a[i + 3]], after: [b[i], b[i + 1], b[i + 2], b[i + 3]] };
        }
      }
    }
  }
  const total = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return { changed, total, first };
}

/** Vùng OCR đúng hợp đồng 3.2 (để test pipeline mà không phụ thuộc fixture). */
export function region({ id, text, kind, box, translatable, confidence = 0.9, lang = 'zh-Hans', reason = '' }) {
  return {
    id,
    box,
    box_normalized: {
      x: box.x / 1000,
      y: box.y / 1000,
      w: box.w / 1000,
      h: box.h / 1000,
    },
    text,
    lang,
    confidence,
    kind,
    kind_reason: reason || `kind=${kind}`,
    translatable: translatable ?? kind === 'descriptive',
    source: 'ocr',
  };
}
