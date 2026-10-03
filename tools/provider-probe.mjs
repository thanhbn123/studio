/**
 * Thăm dò năng lực provider AI — dùng cho verifier.
 *
 * Trả lời hai câu hỏi tách biệt, vì một provider có thể giỏi text mà KHÔNG có vision:
 *   1. Text/JSON có chạy không?
 *   2. Vision (ảnh) có chạy không?
 *
 * Kết quả được in ra dạng JSON để đưa thẳng vào báo cáo nghiệm thu.
 * Không bao giờ in API key.
 *
 * Dùng: node tools/provider-probe.mjs [--image test/fixtures/headphones.png]
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from '../src/env.js';

const args = process.argv.slice(2);
const imageArgIdx = args.indexOf('--image');
const imagePath = imageArgIdx >= 0 ? args[imageArgIdx + 1] : 'test/fixtures/headphones.png';

await loadDotEnv();

const baseUrl = (process.env.AI_BASE_URL || '').replace(/\/+$/, '');
const apiKey = process.env.AI_API_KEY || '';
const model = process.env.AI_MODEL || 'deepseek-chat';

if (!apiKey) {
  console.error(JSON.stringify({ ok: false, error: 'AI_API_KEY chưa được cấu hình' }, null, 2));
  process.exit(2);
}

async function chat(messages, { maxTokens = 300 } = {}) {
  const started = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* giữ null */
  }
  return {
    status: res.status,
    ms: Date.now() - started,
    content: json?.choices?.[0]?.message?.content ?? null,
    error: json?.error?.message ?? (json ? null : raw.slice(0, 200)),
    usage: json?.usage ?? null,
  };
}

const result = {
  base_url: baseUrl,
  model,
  text: null,
  json_mode: null,
  vision: null,
  image_tested: null,
};

// 1) Text cơ bản
result.text = await chat([{ role: 'user', content: 'Trả lời đúng một từ: OK' }], { maxTokens: 10 });

// 2) Sinh JSON có cấu trúc (Content Engine phụ thuộc vào việc này)
result.json_mode = await chat(
  [
    {
      role: 'user',
      content:
        'Trả về DUY NHẤT một object JSON hợp lệ, không giải thích, theo mẫu {"ten":"","diem_ban":[""]} cho sản phẩm: tai nghe chụp tai.',
    },
  ],
  { maxTokens: 300 },
);
if (result.json_mode.content) {
  const cleaned = result.json_mode.content.replace(/^```(?:json)?|```$/gm, '').trim();
  try {
    result.json_mode.parsed_ok = Boolean(JSON.parse(cleaned));
  } catch {
    result.json_mode.parsed_ok = false;
  }
}

// 3) Vision
if (fs.existsSync(imagePath)) {
  result.image_tested = imagePath;
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  result.vision = await chat(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Mô tả ngắn gọn vật thể chính trong ảnh. Nêu màu sắc nhìn thấy.' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ],
    { maxTokens: 400 },
  );
} else {
  result.vision = { status: null, error: `Không tìm thấy ảnh: ${imagePath}` };
}

console.log(JSON.stringify(result, null, 2));

const visionOk = result.vision?.status === 200 && Boolean(result.vision?.content);
const textOk = result.text?.status === 200 && Boolean(result.text?.content);
process.exit(textOk ? (visionOk ? 0 : 1) : 2);
