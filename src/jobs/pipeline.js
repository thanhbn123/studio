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

/**
 * Mức độ bằng chứng của một lần trích xuất — verifier PHẢI phân biệt được.
 *
 * LUẬT: mức này do **NGUỒN GỐC DỮ LIỆU** quyết định, KHÔNG phải do "có lấy được field hay không".
 *
 * Bản trước chỉ nhìn `isMock` (vốn chỉ nói về provider SINH NỘI DUNG) và xem master có
 * tiêu đề/ảnh hay không. Hệ quả đã bị verifier độc lập bắt: một Product Master dựng HOÀN TOÀN
 * từ fixture trong test, qua fetcher giả, KHÔNG hề mở socket nào — vẫn bị ghi là
 * `LIVE_VERIFIED`. Đó đúng là kiểu "thứ dùng để kiểm chứng lại tự nó không trung thực".
 *
 * Nay cổng chặn là `extraction.transport`:
 *   'http'    → dữ liệu thật sự đi qua mạng  → mới được xét LIVE
 *   'manual'  → người dùng tự nhập            → MANUAL_INPUT
 *   khác/none → fixture, fetcher giả, hoặc không tải được → MOCK_VERIFIED
 */
export function determineVerificationLevel(master, { usedSession = false } = {}) {
  const ex = master?.extraction || {};
  const transport = ex.transport || 'unknown';

  // UNSUPPORTED phải xét TRƯỚC cổng transport: nguồn không được hỗ trợ thì không có
  // transport nào cả, nên nếu xét transport trước sẽ trả nhầm MOCK_VERIFIED.
  if (ex.error_code === 'UNSUPPORTED_SOURCE') return 'UNSUPPORTED';

  if (transport === 'manual') return 'MANUAL_INPUT';
  if (transport !== 'http') return 'MOCK_VERIFIED';

  const anyFound = (master?.images?.length || 0) > 0 || Boolean(master?.title_original);
  if (!anyFound) return 'BLOCKED';

  if (usedSession || ex.used_session) return 'AUTHENTICATED_LIVE_VERIFIED';
  return 'LIVE_VERIFIED';
}

export class Pipeline {
  /** Cảnh báo `billing.disabled` chỉ được ghi MỘT LẦN cho mỗi pipeline (không spam log). */
  #billingDisabledLogged = false;

  /**
   * BR-07 (vòng 3) — `run_key` của LƯỢT CHẠY đang chạy cho mỗi job. Không có nó thì
   * `recordUsage` ghi chi phí mà không quy được về lượt nào ⇒ `afterJob` settle theo usage
   * TÍCH LUỸ của cả job (thu thừa các lượt trước). Khoá theo `jobId` nên nhiều job chạy song
   * song vẫn đúng; dọn ở cuối lượt.
   */
  #runKeys = new Map();

  constructor({ config, logger, store, registry, visionProvider, contentEngine, usage, billingService = null, billingHook = null }) {
    this.config = config;
    this.logger = logger;
    this.store = store;
    this.registry = registry;
    this.visionProvider = visionProvider;
    this.contentEngine = contentEngine;
    this.usage = usage;
    // MVP-05: dịch vụ ví credit (A2) và hook dùng chung với route (§3.4b). Cả hai `null`
    // ⇒ hook tính tiền bỏ qua hoàn toàn.
    this.billingService = billingService || null;
    this.billingHook = billingHook || null;
  }

  /* ═════════════════ MVP-05 — HOOK TÍNH TIỀN (hợp đồng §3.4) ═════════════════
   *
   * LUẬT #1 — ẨN DANH KHÔNG BỊ PHÁ: job không có `user_id` (khách chưa đăng nhập) đi thẳng
   * vào thân pipeline, KHÔNG gọi một hàm billing nào. Toàn bộ MVP-01 vẫn "dán link là chạy".
   *
   * LUẬT #2 — SỔ APPEND-ONLY: mỗi lượt chạy của một job có tài khoản là MỘT chu kỳ
   * `app.billingHook.beforeJob` (giữ tiền trước) → `afterJob` (quyết toán theo usage THẬT,
   * hoặc hoàn 100% khi job hỏng). Bên dưới hook là `holdForJob`/`settleForJob`/`refundForJob`
   * của A2. Chu kỳ đã khép lại thì không thu lại lần nữa (idempotent theo `jobId`).
   *
   * FAIL-CLOSED Ở ĐÚNG MỘT CHỖ: thiếu credit (`INSUFFICIENT_CREDIT`) khi giữ tiền ⇒ NÉM ra
   * để job KHÔNG chạy (route map thành 402). Mọi lỗi billing khác chỉ ghi log mức warn —
   * không được biến một sự cố ví tiền thành một job hỏng.
   */

  /** Ước tính các operation lượt chạy này sẽ dùng (cơ sở để giữ tiền trước). */
  #estimateOperations(input = {}) {
    const ops = [];
    if (input?.url) ops.push('SOURCE_EXTRACT');
    if (this.visionProvider?.configured && (input?.url || (input?.manual?.images?.length || 0) > 0)) {
      ops.push('VISION_ANALYSIS');
    }
    if (this.contentEngine?.configured) {
      ops.push('TRANSLATION', 'CONTENT_GENERATE');
    }
    return ops;
  }

  /** Ghi log lỗi billing ở mức warn — KHÔNG bao giờ làm hỏng job vì một sự cố ví tiền. */
  #warnHook(step, jobId, err) {
    this.logger?.warn('billing.hook_failed', {
      job_id: jobId,
      step,
      error_name: err?.name || 'Error',
      error_code: err?.code || null,
      error_message: String(err?.message || err).slice(0, 300),
    });
  }

  /** Chi phí THẬT của job = tổng `estimated_cost` của mọi `usage_events` (hợp đồng §3.4). */
  async #actualCost(jobId) {
    try {
      const summary = await this.store?.usageSummary?.(jobId, { runKey: this.#runKeys.get(jobId) ?? null });
      return Number(summary?.estimated_cost ?? 0);
    } catch (err) {
      this.#warnHook('usage_summary', jobId, err);
      return 0;
    }
  }

  /** Giữ tiền khi pipeline tự dựng với BillingService thô (test/demo) — không giữ hai lần. */
  async #holdDirect(billing, userId, jobId, operations) {
    if (typeof this.store?.listLedger === 'function') {
      const rows = await this.store.listLedger({ userId, jobId, limit: 200 });
      if (Array.isArray(rows) && rows.some((r) => r?.reason === 'job_hold')) return;
    }
    const estimate = await billing.estimate({ userId, operations });
    await billing.holdForJob({ userId, jobId, estimate, operations });
  }

  /** Kết thúc chu kỳ khi dùng BillingService thô — bỏ qua nếu job đã settle/refund. */
  async #closeDirect(billing, userId, jobId, { failed = false, actualCost = 0 } = {}) {
    let rows = [];
    if (typeof this.store?.listLedger === 'function') {
      rows = await this.store.listLedger({ userId, jobId, limit: 200 }) || [];
    }
    if (rows.some((r) => r?.reason === 'job_settle' || r?.reason === 'job_refund')) return;
    if (failed) {
      if (!rows.some((r) => r?.reason === 'job_hold')) return; // chưa giữ gì ⇒ không có gì để hoàn
      await billing.refundForJob({ userId, jobId, reason: 'JOB_FAILED' });
      return;
    }
    await billing.settleForJob({ userId, jobId, actualCost });
  }

  /**
   * Bọc một lượt chạy job bằng chu kỳ: giữ tiền (nếu chưa giữ) → chạy → quyết toán/hoàn tiền.
   *
   * Nguồn ví ưu tiên `billingHook` — CHÍNH object mà A4 gọi trong request (§3.4b). Nhờ dùng
   * chung một object, việc "route đã giữ tiền rồi" được phát hiện bằng một lần ĐỌC SỔ THẬT
   * theo `jobId` (xem `app.billingHook.beforeJob`), nên KHÔNG bao giờ giữ tiền hai lần; lần
   * gọi ở đây là lưới an toàn cho đường không đi qua route (tool/demo) và cho job được xếp
   * hàng trước khi hook ra đời. Không có hook (test dựng pipeline trực tiếp) ⇒ dùng
   * `billingService` thô với cùng luật.
   */
  async #withBilling(jobId, operations, run, userIdHint = null) {
    const hook = this.billingHook;
    const billing = this.billingService;
    if (!hook && !billing) {
      // Không có dịch vụ ví (module A2 chưa nạp được / bị tắt) ⇒ KHÔNG chặn ai. Cảnh báo
      // đúng MỘT LẦN cho mỗi pipeline để log không bị spam theo từng job.
      if (!this.#billingDisabledLogged) {
        this.#billingDisabledLogged = true;
        this.logger?.warn('billing.disabled', {
          reason: 'Không có billingService — hook tính tiền bị bỏ qua, job vẫn chạy và không ai bị chặn.',
        });
      }
      return run();
    }

    // Chủ sở hữu job: ưu tiên `userId` do route truyền vào, còn lại đọc `jobs.user_id`.
    let job = null;
    if (!userIdHint) {
      try {
        job = await this.store?.getJob?.(jobId);
      } catch (err) {
        this.#warnHook('read_job', jobId, err);
        return run();
      }
    }
    const userId = userIdHint || job?.user_id || null;
    if (!userId) return run(); // ẩn danh ⇒ bỏ qua HOÀN TOÀN (luật #1)

    // ── Giữ tiền TRƯỚC khi chạy ────────────────────────────────────────────
    let began = null; // BR-07: kết quả `beforeJob` (mang `run_key` của lượt chạy này)
    try {
      if (hook) {
        began = await hook.beforeJob({
          userId,
          jobId,
          kind: job?.kind || 'content',
          sessionId: job?.session_id || '',
          operations,
        });
        this.#runKeys.set(jobId, (began && began.run_key) || (typeof hook.runKeyForJob === 'function' ? (await hook.runKeyForJob({ userId, jobId }))?.run_key : null) || null);
      } else {
        await this.#holdDirect(billing, userId, jobId, operations);
      }
    } catch (err) {
      if (err?.code === 'INSUFFICIENT_CREDIT') throw err; // fail-closed có chủ ý (route map thành 402)
      this.#warnHook('before_job', jobId, err);
      return run();
    }

    // ── Chạy job ──────────────────────────────────────────────────────────
    let result;
    let failure = null;
    try {
      result = await run();
    } catch (err) {
      failure = err;
    }

    // Trạng thái THẬT lấy từ DB: pipeline có thể tự đánh dấu `failed` mà không ném lỗi.
    let status = failure ? JOB_STATUS.FAILED : (result?.status ?? null);
    if (!failure) {
      try {
        const fresh = await this.store?.getJob?.(jobId);
        status = fresh?.status ?? status;
      } catch {
        /* không đọc được trạng thái ⇒ dùng status pipeline trả về */
      }
    }
    const actualCost = await this.#actualCost(jobId);

    // ── Kết thúc chu kỳ ───────────────────────────────────────────────────
    try {
      if (hook) {
        await hook.afterJob({ userId, jobId, runKey: this.#runKeys.get(jobId) ?? null, status: status || JOB_STATUS.SUCCEEDED, actualCost });
      } else {
        await this.#closeDirect(billing, userId, jobId, { failed: status === JOB_STATUS.FAILED, actualCost });
      }
    } catch (err) {
      // Bước kết thúc chỉ ghi log: job đã chạy xong, lỗi ví KHÔNG được làm hỏng kết quả.
      this.#warnHook('after_job', jobId, err);
    }

    this.#runKeys.delete(jobId); // BR-07: dọn ngữ cảnh lượt chạy
    if (failure) throw failure;
    return result;
  }

  /** Ghi một usage_event, không bao giờ để lỗi ghi làm hỏng pipeline. */
  async #usage(jobId, sessionId, operation, { provider = '', model = '', inputUnits = 0, outputUnits = 0, estimatedCost = 0, meta = null } = {}) {
    try {
      await this.store.recordUsage({
        jobId,
        runKey: this.#runKeys.get(jobId) ?? null,
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
   * Chạy pipeline cho một job (đã được tạo TRƯỚC đó bởi route).
   *
   * MVP-05 §3.4: đây là một "lượt chạy job" ⇒ bọc bằng hook tính tiền. Job ẩn danh
   * (`user_id = NULL`) đi thẳng vào thân hàm, không chạm tới ví.
   *
   * @param {string} jobId
   * @param {object} input { url?, manual?, style?, length?, sessionId? }
   */
  async run(jobId, input = {}) {
    // `input.userId` do route (A4) truyền khi đã đăng nhập — khỏi phải đọc lại job chỉ để biết chủ.
    return this.#withBilling(jobId, this.#estimateOperations(input), () => this.#runJob(jobId, input), input.userId || null);
  }

  /** Thân của `run()` — chỉ gọi qua `run()` để mọi lượt chạy đều đi qua hook tính tiền. */
  async #runJob(jobId, input = {}) {
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
    evidence.verification = determineVerificationLevel(master);
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
   * cho luồng manual-only). Cũng là một lượt chạy job ⇒ đi qua hook tính tiền;
   * job đã có chu kỳ settle/refund thì hook tự bỏ qua (không thu hai lần).
   */
  async resumeFromMaster(jobId, master, { sessionId = '', style, length, extraInstructions = '', userId = null } = {}) {
    const operations = [];
    if (this.visionProvider?.configured) operations.push('VISION_ANALYSIS');
    if (this.contentEngine?.configured) operations.push('TRANSLATION', 'CONTENT_GENERATE');
    return this.#withBilling(
      jobId,
      operations,
      () => this.#resumeJob(jobId, master, { sessionId, style, length, extraInstructions }),
      userId || null,
    );
  }

  /** Thân của `resumeFromMaster()` — chỉ gọi qua đó để luôn đi qua hook tính tiền. */
  async #resumeJob(jobId, master, { sessionId = '', style, length, extraInstructions = '' } = {}) {
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
    // Dữ liệu người dùng tự nhập KHÔNG BAO GIỜ được coi là LIVE_VERIFIED.
    m.extraction.transport = 'manual';
    m.extraction.extracted_at = new Date().toISOString();
    return m;
  }
}

export default Pipeline;
