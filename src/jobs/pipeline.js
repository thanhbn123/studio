/**
 * Pipeline — nhạc trưởng của toàn bộ luồng MVP-01.
 *
 *   link → detect → connector (G01–G05) → Product Master (G06)
 *        → Vision (G07) → Merge (G08) → Content (G09) → Evidence (G14) → History (G12)
 *
 * Hai nguyên tắc chi phối file này:
 *
 *  1. KHÔNG BAO GIỜ chết giữa đường. Nếu connector bị chặn, pipeline chuyển sang
 *     trạng thái `needs_manual` (G11) và VẪN chạy được Content Engine nếu có dữ
 *     liệu thủ công. Các sàn không được là điểm chết duy nhất.
 *
 *  2. Mọi bước đều ghi `usage_event` (G13) và mọi kết luận đều kèm bằng chứng (G14).
 *     Không có chuyện "AI đã lấy xong" mà không chứng minh được nguồn.
 */

import { JOB_STATUS, VERIFICATION_LEVELS } from '../store/index.js';
import { validateMaster, evidenceTable, mergeMasters, createEmptyMaster, STATUS } from '../product-master.js';
import { mergeKnowledge } from '../merge/knowledge-merge.js';
import { addWarning, recomputeEvidence } from '../product-master.js';
import { sanitizeText, sanitizeUrl, sanitizeImageRef } from '../security/sanitize.js';
import { detectSource } from '../sources/detect.js';

/** Mức độ bằng chứng của một lần trích xuất — verifier PHẢI phân biệt được. */
export function determineVerificationLevel(master, { isMock = false } = {}) {
  if (isMock) return 'MOCK_VERIFIED';
  const st = master?.extraction?.field_status || {};
  const anyFound = (master?.images?.length || 0) > 0 || Boolean(master?.title_original);
  if (master?.extraction?.error_code === 'UNSUPPORTED_SOURCE' || st.title_original === STATUS.UNSUPPORTED) {
    return 'UNSUPPORTED';
  }
  if (!anyFound) return 'BLOCKED';
  // Có dữ liệu thật + có session => mức cao nhất
  if (master?.extraction?.used_session) return 'AUTHENTICATED_LIVE_VERIFIED';
  return 'LIVE_VERIFIED';
}

export class Pipeline {
  constructor({ config, logger, store, registry, visionProvider, contentEngine, usage }) {
    this.config = config;
    this.logger = logger;
    this.store = store;
    this.registry = registry;
    this.visionProvider = visionProvider;
    this.contentEngine = contentEngine;
    this.usage = usage;
  }

  /** Ghi một usage_event, không bao giờ để lỗi ghi làm hỏng pipeline. */
  async #usage(jobId, sessionId, operation, { provider = '', model = '', inputUnits = 0, outputUnits = 0, estimatedCost = 0, meta = null } = {}) {
    try {
      await this.store.recordUsage({
        jobId,
        sessionId,
        operation,
        provider,
        model,
        inputUnits,
        outputUnits,
        estimatedCost,
        currency: this.config?.cost?.currency || 'USD',
        meta,
      });
    } catch (err) {
      this.logger?.warn('pipeline.usage_record_failed', { operation, error: err });
    }
  }

  async #setStage(jobId, stage, patch = {}) {
    await this.store.updateJob(jobId, { stage, ...patch });
  }

  /**
   * @param {string} jobId
   * @param {object} input { url?, manual?, style?, length?, sessionId? }
   */
  async run(jobId, input = {}) {
    const startedAt = Date.now();
    const sessionId = input.sessionId || '';
    const style = input.style;
    const length = input.length;
    const log = this.logger?.child({ job_id: jobId });

    await this.store.updateJob(jobId, { status: JOB_STATUS.RUNNING, stage: 'starting' });

    /* ── 1. Trích xuất nguồn (G01–G06) ───────────────────────────────────── */
    let master = null;
    let detection = null;
    const url = sanitizeUrl(input.url || '');

    if (url) {
      try {
        detection = detectSource(url);
      } catch (err) {
        detection = null;
        log?.warn('pipeline.detect_failed', { code: err.code });
      }
    }

    if (url) {
      await this.#setStage(jobId, 'extracting');
      const t0 = Date.now();
      master = await this.registry.extract(url, {});
      const ms = Date.now() - t0;
      await this.#usage(jobId, sessionId, 'SOURCE_EXTRACT', {
        provider: master?.source || 'unknown',
        model: 'http',
        inputUnits: master?.extraction?.bytes || 0,
        outputUnits: (master?.images?.length || 0) + (master?.attributes?.length || 0),
        estimatedCost: this.config?.cost?.SOURCE_EXTRACT ?? 0,
        meta: {
          connector: master?.extraction?.connector,
          method: master?.extraction?.method,
          ms,
          http_status: master?.extraction?.http_status,
        },
      });
      log?.info('pipeline.extract_done', {
        source: master?.source,
        method: master?.extraction?.method,
        images: master?.images?.length || 0,
        ms,
      });
    } else {
      // Không có link (chỉ thủ công) → tạo master rỗng nguồn 'manual'
      master = createEmptyMaster({ source: 'manual', sourceUrl: '', canonicalUrl: '', sourceProductId: '' });
      master.extraction.connector = 'Manual';
      master.extraction.method = 'manual-input';
    }

    /* ── 2. Gộp dữ liệu thủ công (G11) ──────────────────────────────────── */
    const manual = input.manual;
    if (manual && (manual.title || (manual.notes && manual.notes.length) || (manual.images && manual.images.length))) {
      master = mergeMasters(master, this.#buildManualMaster(manual));
      master.extraction.method = url ? `${master.extraction.method}+manual` : 'manual-input';
      log?.info('pipeline.manual_merged', {
        title: Boolean(manual.title),
        images: manual.images?.length || 0,
        notes: Boolean(manual.notes),
      });
    }

    master = recomputeEvidence(master);

    /* ── 3. Kiểm tra đủ dữ liệu để chạy tiếp? ───────────────────────────── */
    const hasUsableData =
      Boolean(master.title_original) || master.images.length > 0 || Boolean(manual?.notes);

    if (!hasUsableData) {
      const evidence = evidenceTable(master);
      const verification = determineVerificationLevel(master);
      evidence.verification = verification;
      evidence.found_fields = master.extraction.found_fields || [];
      evidence.missing_fields = master.extraction.missing_fields || [];
      evidence.warnings = master.extraction.warnings || [];
      evidence.connector = master.extraction.connector || master.source;
      evidence.extraction_method = master.extraction.method || '';
      evidence.vision_provider = '';
      evidence.content_provider = '';
      await this.store.recordEvidence({
        jobId,
        connector: evidence.connector,
        extractionMethod: evidence.extraction_method,
        verification,
        httpStatus: master.extraction.http_status,
        bytes: master.extraction.bytes || 0,
        loginRequired: Boolean(master.extraction.login_required),
        blockedReason: master.extraction.blocked_reason || '',
        foundFields: master.extraction.found_fields || [],
        missingFields: master.extraction.missing_fields || [],
      });
      await this.store.updateJob(jobId, {
        status: JOB_STATUS.NEEDS_MANUAL,
        stage: 'needs_manual',
        product_master: master,
        evidence,
        product_name: master.title_original || '',
        error_code: master.extraction.error_code || 'INSUFFICIENT_DATA',
        error_message:
          master.extraction.blocked_reason ||
          'Không thể tự lấy đầy đủ dữ liệu từ link này.',
        finished_at: new Date().toISOString(),
      });
      log?.info('pipeline.needs_manual', { reason: master.extraction.blocked_reason, verification });
      return { status: JOB_STATUS.NEEDS_MANUAL, master, evidence, verification };
    }

    return this.#continueFromMaster(jobId, {
      master,
      sessionId,
      style,
      length,
      input,
      log,
      startedAt,
      detection,
    });
  }

  /**
   * Chạy tiếp từ một Product Master đã có (dùng chung cho luồng link và luồng thủ công).
   */
  async #continueFromMaster(jobId, { master, sessionId, style, length, input, log, startedAt, detection }) {
    const validation = validateMaster(master);

    /* ── 4. Vision (G07) ────────────────────────────────────────────────── */
    let vision = null;
    const imagesForVision = master.images
      .filter((i) => i.status === STATUS.FOUND && i.url)
      .slice(0, this.config?.vision?.maxImages ?? 6);

    if (imagesForVision.length > 0 && this.visionProvider?.configured) {
      await this.#setStage(jobId, 'vision');
      const t0 = Date.now();
      try {
        vision = await this.visionProvider.analyzeImages(
          imagesForVision.map((i) => ({ url: i.url })),
          { productContext: master.title_original },
        );
        await this.#usage(jobId, sessionId, 'VISION_ANALYSIS', {
          provider: vision.provider,
          model: vision.model,
          inputUnits: imagesForVision.length,
          outputUnits: (vision.analysis?.visible_features?.length || 0) + (vision.analysis?.colors?.length || 0),
          estimatedCost: vision.usage
            ? undefined
            : (this.config?.cost?.VISION_ANALYSIS ?? 0),
          meta: { used: vision.used, skipped: vision.skipped, ms: Date.now() - t0, status: vision.status },
        });
        log?.info('pipeline.vision_done', { used: vision.used, ms: Date.now() - t0 });
      } catch (err) {
        // Vision hỏng KHÔNG được làm hỏng cả pipeline.
        vision = {
          analysis: null,
          used: 0,
          skipped: imagesForVision.length,
          provider: this.visionProvider?.name || '',
          model: this.visionProvider?.model || '',
          warnings: [`Vision thất bại: ${err.message}`],
          status: 'FAILED',
          error_code: err.code || err.name,
        };
        addWarning(master, `Phân tích ảnh thất bại: ${err.message}`);
        log?.warn('pipeline.vision_failed', { error: err });
      }
    } else {
      log?.info('pipeline.vision_skipped', {
        images: imagesForVision.length,
        configured: Boolean(this.visionProvider?.configured),
      });
    }

    /* ── 5. Dịch (TRANSLATION) + Merge (G08) ────────────────────────────── */
    await this.#setStage(jobId, 'merging');
    let translation = null;
    if (this.contentEngine?.configured && master.title_original) {
      try {
        const t0 = Date.now();
        translation = await this.contentEngine.translate(master);
        if (!translation.skipped) {
          await this.#usage(jobId, sessionId, 'TRANSLATION', {
            provider: translation.provider || this.contentEngine.providerName,
            model: translation.model || this.contentEngine.model,
            inputUnits: (master.title_original || '').length + (master.description_original || '').length,
            outputUnits: (translation.title_vi || '').length + (translation.description_vi || '').length,
            estimatedCost: this.config?.cost?.TRANSLATION ?? 0,
            meta: { ms: Date.now() - t0 },
          });
        }
      } catch (err) {
        addWarning(master, `Dịch thất bại: ${err.message}`);
        log?.warn('pipeline.translate_failed', { error: err });
      }
    }

    const knowledge = mergeKnowledge(master, vision, {
      translation,
      warnings: master.extraction.warnings || [],
    });
    knowledge.vision = vision;

    /* ── 6. Content Engine (G09) ────────────────────────────────────────── */
    await this.#setStage(jobId, 'generating');
    let content = null;
    let contentMeta = null;
    let guardrails = null;

    if (!this.contentEngine?.configured) {
      addWarning(master, 'Chưa cấu hình AI provider — không sinh được nội dung tiếng Việt.');
      await this.#setStage(jobId, 'no_ai_provider');
    } else {
      try {
        const t0 = Date.now();
        const gen = await this.contentEngine.generate(master, knowledge, {
          style,
          length,
          extraInstructions: input.extraInstructions || input.manual?.notes || '',
        });
        content = gen.content;
        contentMeta = gen.meta;
        guardrails = gen.guardrails;

        await this.#usage(jobId, sessionId, 'CONTENT_GENERATE', {
          provider: gen.meta.provider,
          model: gen.meta.model,
          inputUnits: gen.usage?.first?.prompt_tokens ?? 0,
          outputUnits: gen.usage?.first?.completion_tokens ?? 0,
          estimatedCost: gen.meta.estimated_cost,
          meta: {
            style: gen.meta.style,
            length: gen.meta.length,
            ms: Date.now() - t0,
            repair_attempted: gen.meta.repair_attempted,
            guardrails_passed: gen.guardrails.passed,
          },
        });
        if (gen.meta.repair_attempted && gen.usage?.repair) {
          await this.#usage(jobId, sessionId, 'CONTENT_REPAIR', {
            provider: gen.meta.provider,
            model: gen.meta.model,
            inputUnits: gen.usage.repair.prompt_tokens ?? 0,
            outputUnits: gen.usage.repair.completion_tokens ?? 0,
            estimatedCost: 0,
            meta: { violations_before: gen.guardrails.violations.length },
          });
        }
        log?.info('pipeline.content_done', {
          guardrails_passed: gen.guardrails.passed,
          violations: gen.guardrails.violations.length,
          ms: Date.now() - t0,
        });
      } catch (err) {
        addWarning(master, `Sinh nội dung thất bại: ${err.message}`);
        log?.error('pipeline.content_failed', { error: err });
        contentMeta = { error: err.message, error_code: err.code || err.name };
      }
    }

    /* ── 7. Bằng chứng (G14) + lưu (G12) ───────────────────────────────── */
    const evidence = evidenceTable(master);
    evidence.verification = determineVerificationLevel(master, { isMock: contentMeta?.is_mock });
    evidence.vision_provider = vision?.provider || '';
    evidence.content_provider = contentMeta?.provider || this.contentEngine?.providerName || '';
    evidence.connector = master.extraction.connector || master.source;
    evidence.extraction_method = master.extraction.method || '';
    evidence.login_required = Boolean(master.extraction.login_required);
    evidence.blocked_reason = master.extraction.blocked_reason || '';
    evidence.found_fields = master.extraction.found_fields || [];
    evidence.missing_fields = master.extraction.missing_fields || [];
    evidence.warnings = master.extraction.warnings || [];
    evidence.guardrails = guardrails;
    evidence.products_master_valid = validation.valid;
    evidence.validation_errors = validation.errors;
    evidence.duration_ms = Date.now() - startedAt;

    await this.store.recordEvidence({
      jobId,
      connector: evidence.connector,
      extractionMethod: evidence.extraction_method,
      verification: evidence.verification,
      httpStatus: master.extraction.http_status,
      bytes: master.extraction.bytes || 0,
      loginRequired: evidence.login_required,
      blockedReason: evidence.blocked_reason,
      foundFields: evidence.found_fields,
      missingFields: evidence.missing_fields,
      visionProvider: evidence.vision_provider,
      contentProvider: evidence.content_provider,
    });

    const status = content ? JOB_STATUS.SUCCEEDED : JOB_STATUS.FAILED;
    await this.store.updateJob(jobId, {
      status,
      stage: status === JOB_STATUS.SUCCEEDED ? 'done' : 'content_failed',
      product_name:
        content?.product_name ||
        knowledge?.product_name_vi ||
        master.title_original ||
        '',
      product_master: master,
      vision,
      knowledge,
      content,
      content_meta: contentMeta,
      evidence,
      finished_at: new Date().toISOString(),
      error_code: content ? null : contentMeta?.error_code || 'CONTENT_FAILED',
      error_message: content ? null : contentMeta?.error || 'Không sinh được nội dung.',
    });

    log?.info('pipeline.done', { status, duration_ms: evidence.duration_ms });
    return { status, master, vision, knowledge, content, contentMeta, guardrails, evidence };
  }

  /**
   * Chạy pipeline cho một job đã có sẵn Product Master (dùng cho "thử lại" và
   * cho luồng manual-only).
   */
  async resumeFromMaster(jobId, master, { sessionId = '', style, length, extraInstructions = '' } = {}) {
    await this.store.updateJob(jobId, { status: JOB_STATUS.RUNNING, stage: 'resuming' });
    return this.#continueFromMaster(jobId, {
      master: recomputeEvidence(master),
      sessionId,
      style,
      length,
      input: { extraInstructions, manual: null },
      log: this.logger?.child({ job_id: jobId }),
      startedAt: Date.now(),
      detection: null,
    });
  }

  /** Dựng Product Master từ dữ liệu người dùng nhập tay (G11). */
  #buildManualMaster(manual) {
    const m = createEmptyMaster({ source: 'manual', sourceUrl: '', canonicalUrl: '', sourceProductId: '' });
    m.extraction.connector = 'Manual';
    if (manual.title) {
      m.title_original = sanitizeText(manual.title, { maxLength: 500 });
      m.title_original_status = STATUS.FOUND;
      // Với dữ liệu thủ công, "nguyên bản" chính là tiếng Việt người dùng nhập.
      m.extraction.field_status = { ...(m.extraction.field_status || {}), title_original: STATUS.FOUND };
    }
    if (Array.isArray(manual.images)) {
      for (const img of manual.images.slice(0, this.config?.net?.maxUploadFiles ?? 12)) {
        const url = typeof img === 'string' ? img : img?.url;
        if (url) {
          m.images.push({
            // Dùng sanitizeImageRef (KHÔNG phải sanitizeUrl) để giữ được data:image —
            // nếu dùng sanitizeUrl thì ảnh người dùng tải lên bị xoá rỗng và bước
            // Vision âm thầm không bao giờ chạy.
            url: sanitizeImageRef(url),
            type: 'gallery',
            status: STATUS.FOUND,
            provenance: 'user',
          });
        }
      }
    }
    if (manual.notes) {
      m.description_original = sanitizeText(manual.notes, { maxLength: 20000 });
      m.description_original_status = STATUS.FOUND;
    }
    if (manual.price) {
      m.price = {
        raw: sanitizeText(manual.price, { maxLength: 120 }),
        currency: 'VND',
        status: STATUS.FOUND,
        kind: 'fixed',
        tiers: [],
      };
    }
    if (manual.attributes && typeof manual.attributes === 'object') {
      for (const [name, value] of Object.entries(manual.attributes)) {
        if (!name || value === undefined || value === null) continue;
        m.attributes.push({
          name: sanitizeText(name, { maxLength: 200 }),
          value: sanitizeText(String(value), { maxLength: 1000 }),
          status: STATUS.FOUND,
          provenance: 'user',
        });
      }
    }
    m.extraction.method = 'manual-input';
    m.extraction.extracted_at = new Date().toISOString();
    return m;
  }
}

export default Pipeline;
