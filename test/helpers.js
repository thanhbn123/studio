/**
 * Tiện ích dùng chung cho test.
 *
 * Nguyên tắc: test KHÔNG được cần mạng và KHÔNG được cần API key. Mọi thứ đi ra
 * ngoài đều được thay bằng fixture hoặc fetcher giả.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { ContentEngine } from '../src/content/engine.js';
import { VisionProvider } from '../src/vision/vision-provider.js';
import { MockProvider } from '../src/ai/provider.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, 'fixtures');

export function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

export function fixtureBuffer(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

/** Cấu hình test: DB in-memory, không có AI thật. */
export function testConfig(overrides = {}) {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    AI_PROVIDER: 'mock',
    ...overrides,
  });
  return cfg;
}

export const silent = createLogger({ level: 'silent' });

/**
 * Fetcher giả: trả về HTML ứng với từng URL theo bảng ánh xạ.
 * Cho phép test connector mà không chạm mạng.
 */
export function fakeFetcher(routes = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const route = key ? routes[key] : null;
    if (!route) {
      const err = new Error(`fakeFetcher: không có route cho ${url}`);
      err.code = 'NO_ROUTE';
      throw err;
    }
    const html = typeof route === 'string' ? route : route.html || '';
    const status = (typeof route === 'object' && route.status) || 200;
    return {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Buffer.from(html, 'utf8'),
      finalUrl: (typeof route === 'object' && route.finalUrl) || url,
      redirects: (typeof route === 'object' && route.redirects) || [],
    };
  };
  fn.calls = calls;
  return fn;
}

/** ContentEngine giả lập — trả nội dung hợp lệ, không gọi mạng. */
export function fakeContentEngine({ content, guardrails } = {}) {
  const defaultContent = {
    product_name: 'Sản phẩm thử nghiệm',
    headline: 'Tiêu đề thử nghiệm',
    short_description: 'Mô tả ngắn thử nghiệm cho sản phẩm.',
    selling_points: ['Điểm 1', 'Điểm 2', 'Điểm 3', 'Điểm 4'],
    detailed_description: 'Mô tả chi tiết thử nghiệm.',
    facebook_caption: 'Bài Facebook thử nghiệm',
    tiktok_caption: 'Caption TikTok thử nghiệm',
    marketplace_description: 'Mô tả marketplace thử nghiệm',
    hashtags: ['#test', '#thunghiem'],
    seo: { title: 'SEO title', meta_description: 'Meta description', keywords: ['test'] },
  };
  const c = content || defaultContent;
  return {
    providerName: 'mock',
    model: 'mock-1',
    configured: true,
    async translate() {
      return { title_vi: 'Tên dịch', description_vi: 'Mô tả dịch', usage: null, skipped: false, provider: 'mock', model: 'mock-1' };
    },
    async generate() {
      return {
        content: c,
        usage: { first: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, repair: null, total_tokens: 30 },
        meta: {
          style: 'ban-hang',
          style_label: 'Bán hàng',
          length: 'vua',
          length_label: 'Vừa',
          provider: 'mock',
          model: 'mock-1',
          repair_attempted: false,
          estimated_cost: 0.001,
          generated_at: new Date().toISOString(),
          is_mock: true,
        },
        guardrails: guardrails || { passed: true, violations: [], warnings: [], checked_rules: [] },
      };
    },
  };
}

/** VisionProvider giả lập. */
export function fakeVisionProvider({ analysis, used = 1 } = {}) {
  return {
    name: 'mock',
    model: 'mock-1',
    configured: true,
    async analyzeImages() {
      return {
        analysis: analysis || {
          product_type: 'tai nghe chụp tai',
          visible_features: ['vành đen', 'đệm xanh dương'],
          visible_text: [],
          colors: ['đen', 'xanh dương'],
          likely_use_cases: ['nghe nhạc'],
          uncertain_claims: [],
        },
        used,
        skipped: 0,
        provider: 'mock',
        model: 'mock-1',
        usage: null,
        warnings: [],
        status: 'OK',
      };
    },
  };
}

/** ContentEngine THẬT + MockProvider — dùng để test guardrails thật. */
export function realContentEngineWithMock(responses) {
  return new ContentEngine({
    provider: new MockProvider({ responses }),
    logger: silent,
    config: testConfig(),
  });
}

/** VisionProvider THẬT + MockProvider. */
export function realVisionProviderWithMock(responses, config = testConfig()) {
  return new VisionProvider({
    provider: new MockProvider({ responses }),
    maxImages: config.vision.maxImages,
    logger: silent,
    config,
  });
}

/** Tạo Product Master tối thiểu hợp lệ để test các tầng sau. */
export function sampleMaster(overrides = {}) {
  return {
    source: '1688',
    source_url: 'https://detail.1688.com/offer/552160420012.html',
    canonical_url: 'https://detail.1688.com/offer/552160420012.html',
    source_product_id: '552160420012',
    title_original: '厂家定制高品质七彩毛毛虫千足玩具公仔',
    title_original_status: 'FOUND',
    images: [{ url: 'https://cbu01.alicdn.com/img/ibank/a.jpg', type: 'cover', status: 'FOUND', provenance: 'source' }],
    videos: [],
    variants: [{ sku_id: '1', name: '40cm', attributes: {}, price_raw: '12.5', status: 'FOUND' }],
    attributes: [{ name: '产地', value: '广东东莞', status: 'FOUND', provenance: 'source' }],
    price: { raw: '12.5', currency: 'CNY', status: 'FOUND', kind: 'tier', tiers: [{ min_quantity: 2, max_quantity: 99, price: 12.5 }] },
    description_original: '厂家定制毛绒玩具',
    description_original_status: 'FOUND',
    store: { name: '东莞市爱笙玩具有限公司', id: '3020167582', url: '', status: 'FOUND' },
    extraction: {
      method: 'html-inline-json',
      connector: '1688',
      extracted_at: new Date().toISOString(),
      warnings: [],
      missing_fields: [],
      found_fields: [],
      login_required: false,
      blocked_reason: '',
      http_status: 200,
      final_url: '',
      bytes: 171586,
      field_status: {},
    },
    vision: null,
    knowledge: null,
    ...overrides,
  };
}

/** Khởi động app test trên cổng ngẫu nhiên; trả về base URL + hàm dọn dẹp. */
export async function startTestServer(app) {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await app.close();
    },
  };
}
