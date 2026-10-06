/**
 * Provider `ffmpeg` — chuỗi PNG tạm → `ffmpeg` → `video/mp4` (hợp đồng MVP-04 §2.2).
 *
 * LUẬT TRUNG THỰC: máy này **KHÔNG có `ffmpeg`** (hợp đồng §0 đã kiểm). Provider KHÔNG được
 * bịa MP4: nó dò binary trước, không thấy thì trả `error_code = 'FFMPEG_NOT_AVAILABLE'` và
 * KHÔNG ghi file rác nào. Khi có ffmpeg thật, đường chạy là:
 *   - ghi chuỗi `<IMAGELAB_DIR>/videostudio-<stamp>/frames/frame_0001.png…` (qua
 *     `writeFrameSequence` nên vẫn bị chặn ghi ra ngoài `IMAGELAB_DIR`);
 *   - `ffmpeg -framerate <fps> -i frame_%04d.png -c:v libx264 … out.mp4`;
 *   - đọc mp4 vào bộ nhớ, trả `output {buffer, mime:'video/mp4', ext:'mp4', sha256, bytes}`;
 *   - dọn thư mục tạm (cả khi lỗi).
 *
 * `configured` phản ánh CẤU HÌNH (có khai binary không) — tình trạng binary thật do `probe()`
 * và `encode()` quyết định. V4 nên gọi `probe()` để nói thật `configured` trên `/api/config`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { VideoEncodeError, ENCODE_CODES, ENCODE_STATUS } from '../errors.js';
import {
  AUDIO_WARNING,
  VideoEncoder,
  collectFrameWarnings,
  createEncodeOutput,
  normalizeFrames,
  resolvePlanGeometry,
} from '../encoder.js';
import { resolveSequenceRoot, writeFrameSequence } from '../sequence.js';

/** Thời gian tối đa cho một lần ffmpeg (ms). */
export const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Chạy một tiến trình và gom stdout/stderr (không dùng shell ⇒ không có chuyện shell injection).
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, error:Error|null, timedOut:boolean}>}
 */
export function runProcess(binary, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: err, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 1 << 20) stdout = stdout.slice(-(1 << 20));
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 1 << 20) stderr = stderr.slice(-(1 << 20));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: err, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error: null, timedOut });
    });
  });
}

export class FFmpegVideoEncoder extends VideoEncoder {
  #binary;
  #fps;
  #probeCache = null;

  constructor({ model = 'ffmpeg/libx264', binaryPath = 'ffmpeg', fps, limits, logger } = {}) {
    super({
      name: 'ffmpeg',
      model,
      mime: 'video/mp4',
      isMock: false,
      // `configured` = mức CẤU HÌNH: có khai binary để gọi hay không.
      configured: typeof binaryPath === 'string' && binaryPath.trim() !== '',
      limits,
      logger,
    });
    this.#binary = String(binaryPath || 'ffmpeg');
    this.#fps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : null;
  }

  get binaryPath() {
    return this.#binary;
  }

  /** Dò binary (có cache). `{ available, version }` — dùng cho `/api/config` của V4. */
  async probe() {
    if (!this.configured) return { available: false, version: null };
    if (this.#probeCache) return this.#probeCache;
    const res = await runProcess(this.#binary, ['-version'], { timeoutMs: 5000 });
    const available = !res.error && res.code === 0;
    this.#probeCache = {
      available,
      version: available ? String(res.stdout.split('\n')[0] ?? '').trim() || null : null,
    };
    return this.#probeCache;
  }

  async _encode({ plan, frames, options }) {
    const limits = this.limits;
    const list = normalizeFrames(frames, { limits });
    const geo = resolvePlanGeometry(plan, list, options);
    const fps = this.#fps ?? geo.fps;

    const probe = await this.probe();
    if (!probe.available) {
      throw new VideoEncodeError(
        ENCODE_CODES.FFMPEG_NOT_AVAILABLE,
        `Không có ffmpeg ("${this.#binary}") trên máy này — từ chối tạo MP4 giả. ` +
          'Hãy dùng provider purejs (GIF thật) hoặc cài ffmpeg.',
        { binary: this.#binary },
      );
    }

    const root = resolveSequenceRoot(options.rootDir ?? options.imagelabDir);
    const runId = `videostudio-${Date.now()}-${process.pid}`;
    const runDir = path.join(root, runId);
    const framesDir = path.join(runDir, 'frames');
    const outPath = path.join(runDir, 'out.mp4');
    const prefix = 'frame';
    const digits = 4;

    try {
      const written = writeFrameSequence({
        frames: list,
        dir: framesDir,
        prefix,
        digits,
        width: geo.width,
        height: geo.height,
        rootDir: root,
      });
      // yuv420p cần kích thước CHẴN; khung lẻ thì giữ nguyên kích thước và đổi pix_fmt
      // (KHÔNG được scale để tránh bóp méo tỉ lệ preset).
      const even = geo.width % 2 === 0 && geo.height % 2 === 0;
      const args = [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-framerate',
        String(fps),
        '-start_number',
        '1',
        '-i',
        path.join(framesDir, `${prefix}_%0${digits}d.png`),
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '20',
        '-pix_fmt',
        even ? 'yuv420p' : 'yuv444p',
        '-movflags',
        '+faststart',
        outPath,
      ];
      const res = await runProcess(this.#binary, args, { timeoutMs: FFMPEG_TIMEOUT_MS });
      if (res.error) {
        throw new VideoEncodeError(
          res.error.code === 'ENOENT' ? ENCODE_CODES.FFMPEG_NOT_AVAILABLE : ENCODE_CODES.FFMPEG_FAILED,
          `Không chạy được ffmpeg: ${res.error.message}`,
          { binary: this.#binary },
        );
      }
      if (res.code !== 0) {
        throw new VideoEncodeError(
          ENCODE_CODES.FFMPEG_FAILED,
          `ffmpeg thoát với mã ${res.code}${res.timedOut ? ' (quá thời gian)' : ''}: ${res.stderr.trim().slice(-400)}`,
          { code: res.code, timed_out: res.timedOut },
        );
      }
      let buffer;
      try {
        buffer = fs.readFileSync(outPath);
      } catch (err) {
        throw new VideoEncodeError(
          ENCODE_CODES.FFMPEG_FAILED,
          `ffmpeg báo thành công nhưng không đọc được file ra: ${err.message}`,
          { out: outPath },
        );
      }
      if (buffer.length === 0) {
        throw new VideoEncodeError(ENCODE_CODES.FFMPEG_FAILED, 'ffmpeg tạo file 0 byte.', { out: outPath });
      }
      return {
        status: ENCODE_STATUS.OK,
        output: createEncodeOutput({ buffer, mime: 'video/mp4', ext: 'mp4' }),
        width: geo.width,
        height: geo.height,
        frames: written.files.length,
        palette_size: 0, // MP4/H.264 không có bảng màu
        warnings: [
          AUDIO_WARNING,
          ...collectFrameWarnings(frames),
          'MP4 tạo bằng ffmpeg/libx264 — cần đo lại chất lượng trên máy có ffmpeg.',
        ],
        error_code: null,
      };
    } finally {
      // Dọn thư mục tạm (kể cả khi lỗi) — không để rác trong IMAGELAB_DIR.
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* không che lỗi chính bằng lỗi dọn dẹp */
      }
    }
  }
}

export default FFmpegVideoEncoder;
