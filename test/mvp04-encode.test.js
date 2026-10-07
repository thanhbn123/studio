/**
 * TEST — MVP-04 · V2 “Mã hoá GIF + chuỗi khung” (`src/videostudio/encode/**`, hợp đồng §2.2 + §3).
 *
 * Điểm mấu chốt: file GIF do `encodeGif` ghi ra phải được **bộ đọc ĐỘC LẬP** trong
 * `test/mvp04-helpers.js` (tự parse khối + tự giải LZW, KHÔNG dùng `lzw.js`/`inspect.js` của
 * repo) xác nhận: số khung, kích thước, loop, bảng màu VÀ chỉ số màu từng điểm ảnh.
 *
 * Ngoài ra khoá lại: file cụt ⇒ `valid:false` + lý do; LZW round-trip trên dữ liệu ngẫu nhiên
 * (kể cả đường TỪ ĐIỂN ĐẦY 4096 ⇒ reset); `renderFrames` giữ kích thước khung + ảnh gốc bất biến;
 * `writeFrameSequence` chặn ghi ngoài `IMAGELAB_DIR`; provider `ffmpeg` thiếu binary ⇒ thất bại
 * thật thà (`output === null`, KHÔNG bịa MP4).
 *
 * Toàn bộ chạy offline, tất định — không mạng, không ffmpeg.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

import {
  encodeGif,
  inspectGif,
  decodeLzwCount,
  encodeLzw,
  writeFrameSequence,
  createVideoEncoder,
  renderFrames,
  PureJsVideoEncoder,
  MockVideoEncoder,
  FFmpegVideoEncoder,
  VideoEncodeError,
  ENCODE_CODES,
} from '../src/videostudio/encode/index.js';
import { buildHistogram, medianCutPalette, buildIndexLut, mapFrames } from '../src/videostudio/encode/index.js';
import { buildVideoPlan, fitImageInFrame } from '../src/videostudio/plan/index.js';
import { tmpDir, makeTestImage } from './imagelab-helpers.js';
import {
  decodeGifFile,
  lcg,
  noisyRgba,
  rgbaFromColors,
  solidRgba,
  EXACT_COLORS,
  pngSize,
} from './mvp04-helpers.js';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

describe('MVP-04 · V2 — mã hoá GIF thật + bộ đọc độc lập (§2.2)', () => {
  test('1 / 5 / 30 khung: inspectGif VÀ bộ đọc độc lập cùng khớp số khung, kích thước, loop, version 89a', () => {
    const cases = [
      { frames: 1, width: 24, height: 16, loop: 0, delayMs: 100 },
      { frames: 5, width: 16, height: 16, loop: 0, delayMs: 120 },
      { frames: 30, width: 16, height: 16, loop: 3, delayMs: 80 },
    ];
    for (const spec of cases) {
      const frames = Array.from({ length: spec.frames }, (_, index) =>
        rgbaFromColors({ width: spec.width, height: spec.height, seed: 100 + index, colors: EXACT_COLORS }),
      );
      const gif = encodeGif({
        frames,
        width: spec.width,
        height: spec.height,
        delayMs: spec.delayMs,
        loop: spec.loop,
      });

      assert.equal(gif.mime, 'image/gif');
      assert.equal(gif.buffer.toString('latin1', 0, 6), 'GIF89a', 'magic bytes phải là GIF89a');
      assert.equal(gif.buffer[gif.buffer.length - 1], 0x3b, 'byte cuối phải là trailer 0x3B');

      const info = inspectGif(gif.buffer);
      assert.equal(info.valid, true, `inspectGif phải hợp lệ: ${JSON.stringify(info.errors)}`);
      assert.equal(info.version, '89a');
      assert.equal(info.width, spec.width);
      assert.equal(info.height, spec.height);
      assert.equal(info.frames, spec.frames);
      assert.equal(info.loop, spec.loop);
      assert.deepEqual(info.errors, []);
      assert.equal(info.bytes, gif.buffer.length);

      // Bộ đọc ĐỘC LẬP: số khung + kích thước khung ảnh + delay THẬT trong Graphic Control Extension.
      const parsed = decodeGifFile(gif.buffer);
      assert.equal(parsed.trailer, true);
      assert.equal(parsed.width, spec.width);
      assert.equal(parsed.height, spec.height);
      assert.equal(parsed.loop, spec.loop);
      assert.equal(parsed.frames.length, spec.frames);
      for (const frame of parsed.frames) {
        assert.equal(frame.width, spec.width);
        assert.equal(frame.height, spec.height);
        assert.equal(frame.indices.length, spec.width * spec.height, 'mỗi khung phải giải đủ điểm ảnh');
        assert.equal(frame.delayCs, Math.round(spec.delayMs / 10), 'delay trong GCE = round(ms/10)');
      }
      assert.equal(gif.frames, spec.frames);
      assert.equal(gif.width, spec.width);
      assert.equal(gif.height, spec.height);
      assert.equal(gif.bytes, gif.buffer.length);
    }
  });

  test('delay riêng từng khung được ghi đúng (GCE theo khung)', () => {
    const delays = [100, 250, 40];
    const gif = encodeGif({
      frames: delays.map((delayMs, index) => ({ rgba: solidRgba(12, 8, [index * 60, 20, 200]), delayMs })),
      width: 12,
      height: 8,
      delayMs: 999, // bị delay riêng từng khung ghi đè
    });
    const parsed = decodeGifFile(gif.buffer);
    assert.deepEqual(parsed.frames.map((f) => f.delayCs), [10, 25, 4]);
    assert.equal(inspectGif(gif.buffer).valid, true);
  });

  test('file CỤT / rác ⇒ inspectGif valid:false + errors có LÝ DO (không im lặng)', () => {
    const gif = encodeGif({
      frames: [rgbaFromColors({ width: 32, height: 24, seed: 3 }), rgbaFromColors({ width: 32, height: 24, seed: 4 })],
      width: 32,
      height: 24,
      delayMs: 100,
    });
    const cases = [
      ['chỉ header', gif.buffer.subarray(0, 6)],
      ['header + LSD thiếu bảng màu', gif.buffer.subarray(0, 13)],
      ['cụt giữa dữ liệu ảnh', gif.buffer.subarray(0, Math.floor(gif.buffer.length * 0.6))],
      ['mất trailer', gif.buffer.subarray(0, gif.buffer.length - 1)],
      ['rác', Buffer.from('day khong phai la GIF gi ca')],
    ];
    for (const [label, buffer] of cases) {
      const info = inspectGif(buffer);
      assert.equal(info.valid, false, `${label}: KHÔNG được coi là hợp lệ`);
      assert.ok(info.errors.length > 0, `${label}: phải có errors[] nêu lý do`);
      assert.ok(
        info.errors.every((e) => typeof e === 'string' && e.trim() !== ''),
        `${label}: mọi lý do phải là câu đọc được, nhận ${JSON.stringify(info.errors)}`,
      );
    }
    // Đối chứng: file NGUYÊN VẸN vẫn hợp lệ (không phải bộ đọc từ chối tất).
    assert.equal(inspectGif(gif.buffer).valid, true);
  });

  test('LZW round-trip: pixel trong file PHẢI bằng ảnh gốc (màu nằm đúng ô histogram 5-bit)', () => {
    const width = 64;
    const height = 48;
    const source = rgbaFromColors({ width, height, seed: 42, colors: EXACT_COLORS });
    const gif = encodeGif({ frames: [source], width, height, delayMs: 80, paletteSize: 16, loop: 2 });
    const parsed = decodeGifFile(gif.buffer);

    assert.equal(parsed.frames.length, 1);
    assert.equal(parsed.gctEntries, 8, '8 màu ⇒ bảng màu toàn cục 8 mục');
    assert.equal(gif.palette_size, 8, 'giữ ĐÚNG 8 màu, không bịa thêm');

    let mismatch = 0;
    let firstBad = null;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const index = parsed.frames[0].indices[y * width + x];
        const p = index * 3;
        const got = [parsed.gct[p], parsed.gct[p + 1], parsed.gct[p + 2]];
        const want = [source[i], source[i + 1], source[i + 2]];
        if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) {
          mismatch += 1;
          if (!firstBad) firstBad = { x, y, want, got };
        }
      }
    }
    assert.equal(mismatch, 0, `LZW/lượng tử hoá làm sai ${mismatch} điểm ảnh, ví dụ ${JSON.stringify(firstBad)}`);
    assert.equal(inspectGif(gif.buffer).valid, true);
  });

  test('LZW TỪ ĐIỂN ĐẦY 4096 ⇒ reset giữa dòng (khung lớn, dữ liệu ngẫu nhiên) và vẫn round-trip', () => {
    const width = 128;
    const height = 128;
    const source = noisyRgba({ width, height, seed: 11, levels: 256 });

    // (a) Đường thô: encodeLzw + decodeLzwCount của repo báo có clear GIỮA dòng.
    const indices = new Uint8Array(width * height);
    const rand = lcg(11);
    for (let i = 0; i < indices.length; i += 1) indices[i] = Math.floor(rand() * 256) & 0xff;
    const decoded = decodeLzwCount(Buffer.from(encodeLzw(indices, 8)), 8, { maxSymbols: indices.length });
    assert.equal(decoded.error, null);
    assert.equal(decoded.count, indices.length, 'giải ra ĐỦ số điểm ảnh');
    assert.ok(decoded.resets >= 1, `từ điển phải đầy rồi reset ít nhất 1 lần, nhận ${decoded.resets}`);

    // (b) Đường file thật: chỉ số màu giải ra PHẢI khớp ánh xạ kỳ vọng của bộ lượng tử hoá.
    const { hist } = buildHistogram([source], { width, height, background: [0, 0, 0] });
    const { palette, colors } = medianCutPalette(hist, 256);
    const lut = buildIndexLut(hist, palette, colors);
    const expected = mapFrames([source], {
      width,
      height,
      palette,
      colors,
      lut,
      background: [0, 0, 0],
      dither: false,
    }).indices[0];

    const gif = encodeGif({ frames: [source], width, height, delayMs: 100 });
    const parsed = decodeGifFile(gif.buffer);
    assert.equal(parsed.frames.length, 1);
    assert.ok(parsed.frames[0].resets >= 1, 'bộ đọc ĐỘC LẬP cũng phải thấy đường reset từ điển');
    let bad = 0;
    for (let i = 0; i < expected.length; i += 1) {
      if (parsed.frames[0].indices[i] !== expected[i]) bad += 1;
    }
    assert.equal(bad, 0, `${bad} chỉ số màu lệch giữa file và ánh xạ kỳ vọng`);
    assert.equal(inspectGif(gif.buffer).valid, true);
  });

  test('GIF MỘT MÀU: mọi điểm ảnh giữ đúng màu; GIF NHIỀU MÀU: bảng màu tối đa 256', () => {
    // Màu nằm ĐÚNG ô histogram 5-bit ⇒ lượng tử hoá không mất màu, phép so là so ĐÚNG.
    const exact = [231, 255, 33];
    const one = solidRgba(32, 24, exact);
    const oneGif = encodeGif({ frames: [one], width: 32, height: 24, delayMs: 100 });
    const oneParsed = decodeGifFile(oneGif.buffer);
    assert.equal(oneGif.palette_size, 1, 'ảnh một màu ⇒ bảng màu 1 màu (không bịa thêm)');
    const colorsSeen = new Set();
    for (let i = 0; i < 32 * 24; i += 1) {
      const index = oneParsed.frames[0].indices[i];
      colorsSeen.add(`${oneParsed.gct[index * 3]},${oneParsed.gct[index * 3 + 1]},${oneParsed.gct[index * 3 + 2]}`);
    }
    assert.deepEqual([...colorsSeen], [exact.join(',')], 'GIF một màu phải giữ ĐÚNG màu gốc');
    assert.equal(inspectGif(oneGif.buffer).valid, true);

    // Màu KHÔNG nằm trên lưới 5-bit: sai số làm tròn lưới là chấp nhận được (≤ 7/kênh) và
    // KHÔNG được vượt ngưỡng cảnh báo màu — nói cách khác: cấm "đổi màu tuỳ tiện".
    const offGrid = [200, 30, 40];
    const offGif = encodeGif({ frames: [solidRgba(16, 16, offGrid)], width: 16, height: 16, delayMs: 100 });
    const offIndex = offGif.buffer && decodeGifFile(offGif.buffer).gct;
    const offColor = [offIndex[0], offIndex[1], offIndex[2]];
    offColor.forEach((value, channel) => {
      assert.ok(
        Math.abs(value - offGrid[channel]) <= 7,
        `kênh ${channel}: lệch ${Math.abs(value - offGrid[channel])} > 7 (màu ${offColor} vs ${offGrid})`,
      );
    });
    assert.equal(
      offGif.warnings.some((w) => /Sai số màu/.test(w)),
      false,
      `sai số lưới nhỏ KHÔNG được cảnh báo sai số màu: ${JSON.stringify(offGif.warnings)}`,
    );

    const many = noisyRgba({ width: 64, height: 64, seed: 5, levels: 256 });
    const manyGif = encodeGif({ frames: [many], width: 64, height: 64, delayMs: 100 });
    assert.ok(manyGif.palette_size > 1 && manyGif.palette_size <= 256, `palette_size=${manyGif.palette_size}`);
    const manyParsed = decodeGifFile(manyGif.buffer);
    assert.equal(manyParsed.frames[0].indices.length, 64 * 64);
    assert.equal(inspectGif(manyGif.buffer).valid, true);
    for (const index of manyParsed.frames[0].indices) {
      assert.ok(index < manyGif.palette_size, 'chỉ số màu không được vượt bảng màu');
    }

    // paletteSize vượt trần GIF ⇒ kẹp về 256 + NÓI RÕ trong warnings.
    const clamped = encodeGif({ frames: [many], width: 64, height: 64, delayMs: 100, paletteSize: 999 });
    assert.ok(clamped.palette_size <= 256);
    assert.ok(
      clamped.warnings.some((w) => /vượt trần GIF 256/.test(w)),
      `phải cảnh báo kẹp bảng màu; warnings = ${JSON.stringify(clamped.warnings)}`,
    );
  });

  test('renderFrames: mọi khung CÙNG kích thước, đủ số khung, ảnh nguồn KHÔNG đổi sha256', async () => {
    const frameSize = { width: 150, height: 150 };
    const scenes = [
      { asset_id: 'img-1', source: { width: 400, height: 300 }, duration_ms: 250, fit: 'pad' },
      { asset_id: 'img-2', source: { width: 300, height: 300 }, duration_ms: 500, fit: 'crop' },
      { asset_id: 'img-3', source: { width: 400, height: 300 }, duration_ms: 250, fit: 'pad' },
    ];
    // Plan THẬT của V1 (900×900, 12 khung) — rồi thu nhỏ khung bằng CHÍNH `fitImageInFrame` của V1
    // để test chạy nhanh mà vẫn dùng hình học thật (không chép lại công thức vào test).
    const plan = buildVideoPlan({ scenes, preset: 'vuong-1x1' });
    const small = {
      ...plan,
      ...frameSize,
      scenes: plan.scenes.map((scene, index) => ({
        ...scene,
        source: scenes[index].source,
        fit_box: fitImageInFrame({
          source_width: scenes[index].source.width,
          source_height: scenes[index].source.height,
          width: frameSize.width,
          height: frameSize.height,
          fit: scene.fit,
        }).fit_box,
      })),
    };

    const pngs = {
      'img-1': makeTestImage({ width: 400, height: 300, background: [220, 40, 40, 255] }),
      'img-2': makeTestImage({ width: 300, height: 300, background: [40, 200, 40, 255] }),
      'img-3': makeTestImage({ width: 400, height: 300, background: [40, 40, 220, 255] }),
    };
    const before = Object.fromEntries(Object.entries(pngs).map(([id, buffer]) => [id, sha256(buffer)]));
    const loads = [];
    const loadImage = async (assetId) => {
      loads.push(assetId);
      return pngs[assetId];
    };

    const frames = await renderFrames(small, { loadImage });
    assert.equal(frames.length, small.frame_count, 'số khung phải bằng frame_count của plan');
    assert.equal(small.frame_count, Math.round((1000 / 1000) * 12), '1s ⇒ 12 khung');
    for (const frame of frames) {
      assert.equal(frame.width, frameSize.width, 'KHÔNG được đổi kích thước khung giữa các khung');
      assert.equal(frame.height, frameSize.height);
      assert.equal(frame.rgba.length, frameSize.width * frameSize.height * 4);
      assert.ok(Buffer.isBuffer(frame.rgba));
    }
    // Mỗi ảnh nguồn chỉ nạp MỘT lần; cả ba cảnh đều được dựng.
    assert.deepEqual([...new Set(loads)].sort(), ['img-1', 'img-2', 'img-3']);

    // Ảnh gốc BẤT BIẾN: sha256 trước/sau y hệt.
    for (const [id, buffer] of Object.entries(pngs)) {
      assert.equal(sha256(buffer), before[id], `ảnh gốc ${id} KHÔNG được bị sửa`);
    }

    // Cảnh 1 (đỏ) và cảnh 3 (xanh dương) phải cho pixel khác nhau — chứng minh có vẽ ảnh thật.
    const pixelAt = (frame, x, y) => {
      const i = (y * frame.width + x) * 4;
      return [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]];
    };
    const p1 = pixelAt(frames[0], 75, 75);
    const p3 = pixelAt(frames[frames.length - 1], 75, 75);
    assert.notDeepEqual(p1, p3, `hai cảnh khác ảnh phải cho pixel khác nhau (${p1} vs ${p3})`);
    // Ảnh 4:3 pad vào khung vuông ⇒ góc trên-trái là màu viền đen (không kéo giãn ảnh).
    assert.deepEqual(pixelAt(frames[0], 0, 0), [0, 0, 0], 'vùng viền pad phải là pad_color');
  });

  test('renderFrames: chuyển cảnh `fade` pha trộn THẬT và `motion` zoom-in đổi pixel theo khung', async () => {
    const frameSize = { width: 160, height: 120 };
    const red = makeTestImage({ width: 160, height: 120, background: [220, 20, 20, 255] });
    const blue = makeTestImage({ width: 160, height: 120, background: [20, 20, 220, 255] });
    const sources = [
      { asset_id: 'fade-1', source: { width: 160, height: 120 }, duration_ms: 250, fit: 'pad' },
      { asset_id: 'fade-2', source: { width: 160, height: 120 }, duration_ms: 750, fit: 'pad', transition_in: 'fade', transition_ms: 300 },
    ];
    const plan = buildVideoPlan({ scenes: sources, preset: 'vuong-1x1' });
    const small = {
      ...plan,
      ...frameSize,
      scenes: plan.scenes.map((scene, index) => ({
        ...scene,
        source: sources[index].source,
        fit_box: fitImageInFrame({
          source_width: sources[index].source.width,
          source_height: sources[index].source.height,
          width: frameSize.width,
          height: frameSize.height,
          fit: scene.fit,
        }).fit_box,
      })),
    };
    const pngs = { 'fade-1': red, 'fade-2': blue };
    const frames = await renderFrames(small, { loadImage: async (id) => pngs[id] });
    const pixelAt = (frame, x, y) => {
      const i = (y * frame.width + x) * 4;
      return [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]];
    };

    // Khung GIỮA cửa sổ fade (t = 333ms, cảnh 2 bắt đầu 250ms, fade 300ms) phải là PHA TRỘN:
    // vừa còn đỏ của cảnh trước, vừa đã có xanh của cảnh sau — không phải cắt thẳng.
    const mid = pixelAt(frames[4], 80, 60);
    assert.ok(mid[0] > 0 && mid[2] > 0, `khung giữa fade phải là pha trộn đỏ+xanh, nhận ${mid}`);
    assert.notDeepEqual(mid, [20, 20, 220], 'không được là cảnh sau nguyên bản (như "cut")');
    assert.notDeepEqual(mid, [220, 20, 20], 'không được là cảnh trước nguyên bản');
    // Sau khi fade xong (t = 916ms) thì phải là cảnh sau THUẦN.
    assert.deepEqual(pixelAt(frames[frames.length - 1], 80, 60), [20, 20, 220], 'hết fade ⇒ cảnh sau thuần');

    // motion zoom-in: cùng một ảnh nguồn nhưng khung đầu và khung cuối KHÁC pixel (đã nội suy).
    const zoomPlan = buildVideoPlan({
      scenes: [{ asset_id: 'zoom-1', source: { width: 160, height: 120 }, duration_ms: 1000, motion: 'zoom-in' }],
      preset: 'vuong-1x1',
    });
    const zoomSmall = {
      ...zoomPlan,
      ...frameSize,
      scenes: zoomPlan.scenes.map((scene) => ({
        ...scene,
        fit_box: fitImageInFrame({
          source_width: 160,
          source_height: 120,
          width: frameSize.width,
          height: frameSize.height,
          fit: 'pad',
        }).fit_box,
      })),
    };
    // Ảnh nguồn có hoa văn (nửa trái đỏ, nửa phải vàng) để zoom làm đổi pixel.
    const patterned = makeTestImage({
      width: 160,
      height: 120,
      background: [220, 20, 20, 255],
      fills: [{ box: { x: 80, y: 0, w: 80, h: 120 }, rgba: [240, 200, 20, 255] }],
    });
    const zoomFrames = await renderFrames(zoomSmall, { loadImage: async () => patterned });
    let changed = 0;
    for (let i = 0; i < zoomFrames[0].rgba.length; i += 4) {
      if (zoomFrames[0].rgba[i] !== zoomFrames[zoomFrames.length - 1].rgba[i]) changed += 1;
    }
    assert.ok(changed > 0, 'zoom-in phải làm pixel đổi giữa các khung (nội suy THẬT, không đứng yên)');
  });

  test('renderFrames: ảnh nguồn không phải PNG ⇒ IMAGE_UNSUPPORTED (fail-closed)', async () => {
    const plan = buildVideoPlan({
      scenes: [{ asset_id: 'x', source: { width: 300, height: 300 }, duration_ms: 250 }],
      preset: 'vuong-1x1',
    });
    await assert.rejects(
      () => renderFrames(plan, { loadImage: async () => Buffer.from('khong-phai-png') }),
      (err) => err instanceof VideoEncodeError && err.code === ENCODE_CODES.IMAGE_UNSUPPORTED,
    );
  });

  test('writeFrameSequence: ghi RA NGOÀI IMAGELAB_DIR ⇒ UNSAFE_PATH (kể cả đường `..`)', () => {
    const root = tmpDir('vps-vs-root-');
    const outside = tmpDir('vps-vs-outside-');
    const frame = { rgba: solidRgba(8, 6, [10, 20, 30]), width: 8, height: 6 };

    for (const dir of [path.join(outside, 'frames'), path.join(root, '..', path.basename(outside))]) {
      assert.throws(
        () => writeFrameSequence({ frames: [frame], dir, rootDir: root }),
        (err) => {
          assert.ok(err instanceof VideoEncodeError, 'phải là VideoEncodeError');
          assert.equal(err.code, ENCODE_CODES.UNSAFE_PATH);
          assert.match(err.message, /IMAGELAB_DIR/);
          return true;
        },
        `phải chặn "${dir}"`,
      );
    }
    assert.equal(fs.existsSync(path.join(outside, 'frames')), false, 'KHÔNG được tạo thư mục ngoài');

    // Đối chứng: trong thư mục gốc thì ghi được, file là PNG thật, tên đúng mẫu `%04d`.
    const target = path.join(root, 'frames');
    const written = writeFrameSequence({
      frames: [frame, { rgba: solidRgba(8, 6, [99, 88, 77]), width: 8, height: 6 }],
      dir: target,
      rootDir: root,
    });
    assert.equal(written.files.length, 2);
    assert.deepEqual(
      written.files.map((file) => path.basename(file)),
      ['frame_0001.png', 'frame_0002.png'],
    );
    let total = 0;
    for (const file of written.files) {
      const buffer = fs.readFileSync(file);
      total += buffer.length;
      assert.deepEqual(pngSize(buffer), { width: 8, height: 6 }, `${file} phải là PNG 8×6`);
    }
    assert.equal(written.bytes, total, 'bytes trả về = tổng byte đã ghi');
  });

  test('provider ffmpeg khi máy KHÔNG có binary ⇒ FAILED + FFMPEG_NOT_AVAILABLE + output === null (không bịa MP4)', async () => {
    const encoder = new FFmpegVideoEncoder({ binaryPath: 'vps-khong-co-ffmpeg-nay-12345' });
    assert.equal(encoder.name, 'ffmpeg');
    assert.equal(encoder.mime, 'video/mp4');
    const probe = await encoder.probe();
    assert.equal(probe.available, false, 'máy này không có ffmpeg ⇒ probe phải nói thật');

    const plan = buildVideoPlan({
      scenes: [{ asset_id: 'x', source: { width: 300, height: 300 }, duration_ms: 250 }],
      preset: 'vuong-1x1',
    });
    const frames = [solidRgba(plan.width, plan.height, [1, 2, 3]), solidRgba(plan.width, plan.height, [4, 5, 6])];
    const result = await encoder.encode({ plan, frames });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error_code, 'FFMPEG_NOT_AVAILABLE');
    assert.equal(result.provider, 'ffmpeg');
    assert.equal(result.is_mock, false);
    assert.equal(result.output, null, 'KHÔNG được trả file MP4 giả');
    assert.ok(
      result.warnings.some((w) => /ffmpeg/i.test(w)),
      `warnings phải nói rõ thiếu ffmpeg: ${JSON.stringify(result.warnings)}`,
    );
  });

  test('factory: mặc định purejs (GIF thật); mock khai is_mock; provider lạ/enabled=false ⇒ fail-closed', async () => {
    const pure = createVideoEncoder({});
    assert.equal(pure.name, 'purejs');
    assert.equal(pure.isMock, false);
    assert.equal(pure.configured, true);
    assert.equal(pure.mime, 'image/gif');
    assert.ok(pure instanceof PureJsVideoEncoder);

    const mock = createVideoEncoder({ videostudio: { encoder: { provider: 'mock' } } });
    assert.ok(mock instanceof MockVideoEncoder);
    assert.equal(mock.isMock, true);
    const mockPlan = buildVideoPlan({
      scenes: [{ source: { width: 60, height: 40 }, duration_ms: 250 }],
      preset: 'vuong-1x1',
    });
    const mockResult = await mock.encode({ plan: mockPlan, frames: [] });
    assert.equal(mockResult.status, 'OK');
    assert.equal(mockResult.is_mock, true);
    assert.equal(mockResult.output.mime, 'image/gif');
    const mockParsed = decodeGifFile(mockResult.output.buffer);
    assert.equal(mockParsed.frames.length, 2, 'mock là GIF 2 khung màu (và NÓI RÕ là mock)');

    assert.throws(
      () => createVideoEncoder({ videostudio: { encoder: { provider: 'khong-co' } } }),
      (err) => err instanceof VideoEncodeError && err.code === ENCODE_CODES.UNKNOWN_PROVIDER,
    );

    const off = createVideoEncoder({ videostudio: { enabled: false } });
    assert.equal(off.name, 'none');
    assert.equal(off.configured, false);
    const offResult = await off.encode({ plan: mockPlan, frames: [] });
    assert.equal(offResult.status, 'FAILED');
    assert.equal(offResult.error_code, ENCODE_CODES.NOT_CONFIGURED);
    assert.equal(offResult.output, null);
  });
});
