/**
 * AI provider abstraction.
 *
 * MỘT abstraction, NHIỀU provider — không hardcode provider nào vào toàn ứng dụng.
 * Vision (G07) và Content Engine (G09) dùng CHUNG lớp này; chúng khác nhau ở
 * prompt và ở việc có gửi ảnh hay không, không khác ở tầng vận chuyển.
 *
 * Định dạng message nội bộ (đã chuẩn hoá, provider tự dịch sang API của mình):
 *   { role: 'system'|'user'|'assistant', text: string, images?: [{mimeType, base64}] }
 *
 * Bảo mật: API key chỉ được dùng để tạo header, KHÔNG BAO GIỜ vào log/DB/response.
 */

import { redact } from '../logger.js';

export class AiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.details = details;
  }
}

/** Bảng giá tham khảo (USD / 1 triệu token). Dùng để ƯỚC TÍNH, không phải hoá đơn. */
export const PRICE_TABLE = {
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'claude-3-5-sonnet': { in: 3, out: 15 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'gemini-1.5-pro': { in: 1.25, out: 5 },
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
};

export function estimateCostFromUsage(model, usage) {
  const m = String(model || '').toLowerCase();
  // Phải khớp khoá DÀI NHẤT trước: nếu không, 'gpt-4o' sẽ khớp trước và nuốt
  // luôn 'gpt-4o-mini', cho ra đơn giá sai gấp ~16 lần.
  const key = Object.keys(PRICE_TABLE)
    .filter((k) => m.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key || !usage) return null;
  const p = PRICE_TABLE[key];
  const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

/** Rút JSON ra khỏi văn bản model trả về (kể cả khi bọc ```json). */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    /* thử cắt từ { hoặc [ đầu tiên */
  }
  const firstBrace = s.search(/[[{]/);
  if (firstBrace === -1) return null;
  const open = s[firstBrace];
  const close = open === '{' ? '}' : ']';
  const lastClose = s.lastIndexOf(close);
  if (lastClose <= firstBrace) return null;
  try {
    return JSON.parse(s.slice(firstBrace, lastClose + 1));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AiProvider {
  constructor({ name, apiKey, baseUrl, model, timeoutMs = 120000, maxRetries = 2, logger } = {}) {
    this.name = name;
    this.apiKey = apiKey || '';
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.model = model || '';
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.logger = logger;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  /** @abstract */
  // eslint-disable-next-line no-unused-vars
  async chat(messages, opts = {}) {
    throw new AiError('NOT_IMPLEMENTED', `${this.name}: chat() chưa được cài đặt.`);
  }

  /** Gọi HTTP có retry + timeout. Không log body (có thể chứa dữ liệu). */
  async requestJson(url, { method = 'POST', headers = {}, body, timeoutMs = this.timeoutMs } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* giữ null */
        }
        if (!res.ok) {
          const detail = json?.error?.message || json?.message || text.slice(0, 300);
          const retryable = res.status === 429 || res.status >= 500;
          if (retryable && attempt < this.maxRetries) {
            lastErr = new AiError('AI_HTTP_ERROR', `${this.name} HTTP ${res.status}: ${detail}`, {
              status: res.status,
            });
            await sleep(400 * 2 ** attempt);
            continue;
          }
          throw new AiError('AI_HTTP_ERROR', `${this.name} HTTP ${res.status}: ${detail}`, {
            status: res.status,
            provider: this.name,
          });
        }
        return { json, text };
      } catch (err) {
        if (err instanceof AiError && err.code === 'AI_HTTP_ERROR' && err.details?.status && err.details.status < 500) {
          throw err;
        }
        lastErr = err;
        const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        if (attempt < this.maxRetries) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        if (isTimeout) {
          throw new AiError('AI_TIMEOUT', `${this.name} không phản hồi trong ${timeoutMs}ms.`);
        }
        throw new AiError('AI_NETWORK_ERROR', `${this.name} lỗi mạng: ${redact(err.message)}`);
      }
    }
    throw lastErr || new AiError('AI_UNKNOWN', `${this.name}: lỗi không xác định.`);
  }
}

/* ─────────────────── OpenAI-compatible (DeepSeek, OpenAI) ─────────────────── */

export class OpenAiCompatibleProvider extends AiProvider {
  toApiMessages(messages) {
    return messages.map((m) => {
      if (!m.images || m.images.length === 0) return { role: m.role, content: m.text || '' };
      const parts = [];
      if (m.text) parts.push({ type: 'text', text: m.text });
      for (const img of m.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` },
        });
      }
      return { role: m.role, content: parts };
    });
  }

  async chat(messages, { jsonMode = false, maxTokens = 4096, temperature = 0.4, timeoutMs } = {}) {
    if (!this.configured) throw new AiError('AI_NOT_CONFIGURED', `${this.name}: thiếu API key.`);
    const body = {
      model: this.model,
      messages: this.toApiMessages(messages),
      max_tokens: maxTokens,
      temperature,
      stream: false,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const { json } = await this.requestJson(`${this.baseUrl}/chat/completions`, {
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body,
      timeoutMs: timeoutMs ?? this.timeoutMs,
    });

    const content = json?.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model: json?.model || this.model,
      usage: json?.usage || null,
      provider: this.name,
      finish_reason: json?.choices?.[0]?.finish_reason ?? null,
    };
  }
}

/* ─────────────────────────────── Anthropic ─────────────────────────────── */

export class AnthropicProvider extends AiProvider {
  async chat(messages, { maxTokens = 4096, temperature = 0.4, timeoutMs } = {}) {
    if (!this.configured) throw new AiError('AI_NOT_CONFIGURED', 'Anthropic: thiếu API key.');

    const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.text);
    const rest = messages.filter((m) => m.role !== 'system').map((m) => {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const img of m.images || []) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.base64 },
        });
      }
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
    });

    const { json } = await this.requestJson(`${this.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: {
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        system: systemParts.join('\n\n') || undefined,
        messages: rest,
      },
      timeoutMs: timeoutMs ?? this.timeoutMs,
    });

    const content = (json?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return {
      content,
      model: json?.model || this.model,
      usage: json?.usage
        ? { prompt_tokens: json.usage.input_tokens, completion_tokens: json.usage.output_tokens }
        : null,
      provider: 'anthropic',
      finish_reason: json?.stop_reason ?? null,
    };
  }
}

/* ──────────────────────────────── Gemini ──────────────────────────────── */

export class GeminiProvider extends AiProvider {
  async chat(messages, { maxTokens = 4096, temperature = 0.4, timeoutMs } = {}) {
    if (!this.configured) throw new AiError('AI_NOT_CONFIGURED', 'Gemini: thiếu API key.');
    const base = this.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';

    const systemText = messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [
          ...(m.text ? [{ text: m.text }] : []),
          ...(m.images || []).map((img) => ({
            inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.base64 },
          })),
        ],
      }));

    const { json } = await this.requestJson(
      `${base}/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        headers: { 'content-type': 'application/json' },
        body: {
          contents,
          systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
          generationConfig: { maxOutputTokens: maxTokens, temperature },
        },
        timeoutMs: timeoutMs ?? this.timeoutMs,
      },
    );

    const content = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    return {
      content,
      model: this.model,
      usage: json?.usageMetadata
        ? {
            prompt_tokens: json.usageMetadata.promptTokenCount,
            completion_tokens: json.usageMetadata.candidatesTokenCount,
          }
        : null,
      provider: 'gemini',
      finish_reason: json?.candidates?.[0]?.finishReason ?? null,
    };
  }
}

/* ──────────────────────────────── Mock ──────────────────────────────── */

/**
 * Provider giả — CHỈ dùng cho test/CI offline.
 * Mọi kết quả sinh ra từ đây phải được đánh dấu `mock: true`, và tầng báo cáo
 * phải thể hiện là MOCK VERIFIED, không được nhập nhằng với LIVE.
 */
export class MockProvider extends AiProvider {
  constructor(opts = {}) {
    super({ name: 'mock', model: 'mock-1', ...opts });
    this.calls = [];
    this.responses = opts.responses || [];
  }

  /** Provider giả KHÔNG cần API key, nên luôn ở trạng thái "đã cấu hình". */
  get configured() {
    return true;
  }

  async chat(messages, opts = {}) {
    this.calls.push({ messages: redact(messages), opts });
    const scripted = this.responses[this.calls.length - 1];
    if (scripted !== undefined) {
      return {
        content: typeof scripted === 'string' ? scripted : JSON.stringify(scripted),
        model: 'mock-1',
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        provider: 'mock',
        finish_reason: 'stop',
        mock: true,
      };
    }
    return {
      content: JSON.stringify({ mock: true, note: 'Phản hồi giả lập cho test.' }),
      model: 'mock-1',
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      provider: 'mock',
      finish_reason: 'stop',
      mock: true,
    };
  }
}

/* ─────────────────────────────── Factory ─────────────────────────────── */

export const PROVIDER_NAMES = ['deepseek', 'openai', 'anthropic', 'gemini', 'mock'];

const DEFAULTS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' },
  mock: { baseUrl: '', model: 'mock-1' },
};

/**
 * Tạo provider từ cấu hình.
 * @param {{provider:string, apiKey:string, baseUrl:string, model:string, timeoutMs:number}} cfg
 */
export function createProvider(cfg = {}, { logger } = {}) {
  const name = String(cfg.provider || 'deepseek').toLowerCase();
  const defaults = DEFAULTS[name] || DEFAULTS.deepseek;

  if (name === 'mock') return new MockProvider({ logger });

  const common = {
    name,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl || defaults.baseUrl,
    model: cfg.model || defaults.model,
    timeoutMs: cfg.timeoutMs ?? 120000,
    logger,
  };

  switch (name) {
    case 'openai':
    case 'deepseek':
      return new OpenAiCompatibleProvider(common);
    case 'anthropic':
      return new AnthropicProvider(common);
    case 'gemini':
      return new GeminiProvider(common);
    default:
      throw new AiError('UNKNOWN_PROVIDER', `Provider không được hỗ trợ: ${name}`, {
        supported: PROVIDER_NAMES,
      });
  }
}

export default createProvider;
