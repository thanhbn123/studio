/**
 * TEST — MVP-04 · V1 “Kịch bản/khung hình” (`src/videostudio/plan/**`, hợp đồng §2.1 + §3).
 *
 * Khoá lại TỪNG bất biến mà hợp đồng gọi là "XONG":
 *   · `sum(scenes[].duration_ms) === duration_ms`; `frame_count === round(duration_ms/1000*fps) === sum(frames)`;
 *   · tổng vượt trần preset ⇒ **CẮT** (không bao giờ vượt) và `warnings` nói RÕ số ms;
 *   · `fit_box` giữ đúng tỉ lệ ảnh nguồn (sai số ≤ 1px) và LUÔN nằm trong khung — cho cả `pad` và `crop`;
 *   · mọi đầu vào không đủ tự tin (preset lạ, rỗng, thiếu `source`, `fit` lạ) ⇒ `VideoError` fail-closed;
 *   · chữ rỗng bị BỎ + có cảnh báo.
 *
 * Test thuần, tất định, không I/O — chạy được offline.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVideoPlan,
  planFrameCount,
  VIDEO_PRESETS,
  VideoError,
  VIDEO_CODES,
  FIT_MODES,
  fitImageInFrame,
  VIDEO_AUDIO_WARNING,
} from '../src/videostudio/plan/index.js';

/** Ba cảnh với tỉ lệ ảnh nguồn KHÁC NHAU (4:3 · 1:1 · dọc) và thời lượng khác nhau. */
const SCENES = [
  { asset_id: 'a1', source: { width: 640, height: 480 }, duration_ms: 3000, text: 'Ao thun nam' },
  { asset_id: 'a2', source: { width: 1000, height: 1000 }, duration_ms: 250, text: 'Chat cotton' },
  { asset_id: 'a3', source: { width: 333, height: 777 }, duration_ms: 6000 },
];

const insideFrame = (box, width, height) =>
  box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0 && box.x + box.w <= width && box.y + box.h <= height;

describe('MVP-04 · V1 — kịch bản/khung hình (§2.1)', () => {
  for (const preset of VIDEO_PRESETS) {
    test(`preset ${preset.id}: tổng thời lượng = duration_ms, khung = round(ms/1000*fps) = tổng khung cảnh`, () => {
      const plan = buildVideoPlan({ scenes: SCENES, preset: preset.id });

      assert.equal(plan.preset_id, preset.id);
      assert.equal(plan.width, preset.width);
      assert.equal(plan.height, preset.height);
      assert.equal(plan.fps, preset.fps);
      assert.equal(plan.loop, 0);
      assert.equal(plan.synthetic, false);

      const sumDurations = plan.scenes.reduce((sum, scene) => sum + scene.duration_ms, 0);
      assert.equal(sumDurations, plan.duration_ms, 'sum(scenes[].duration_ms) PHẢI bằng duration_ms');
      assert.equal(plan.duration_ms, 9250, '3 cảnh 3000+250+6000ms');

      const expectedFrames = Math.round((plan.duration_ms / 1000) * plan.fps);
      assert.equal(plan.frame_count, expectedFrames, 'frame_count = round(duration_ms/1000*fps)');
      assert.equal(plan.frame_count, Math.round((9250 / 1000) * 12), '= 111 khung ở 12fps');
      const sumFrames = plan.scenes.reduce((sum, scene) => sum + scene.frames, 0);
      assert.equal(plan.frame_count, sumFrames, 'frame_count PHẢI bằng tổng frames của các cảnh');
      assert.ok(plan.scenes.every((scene) => scene.frames >= 1), 'mỗi cảnh phải có ít nhất 1 khung');

      // Mốc thời gian liên tục, không khe hở, không chồng lấn.
      let cursor = 0;
      for (const scene of plan.scenes) {
        assert.equal(scene.start_ms, cursor, 'start_ms phải nối tiếp cảnh trước');
        assert.equal(scene.end_ms, scene.start_ms + scene.duration_ms);
        cursor = scene.end_ms;
      }
      assert.equal(cursor, plan.duration_ms);

      // §0 luật 2 — không có tiếng thì phải NÓI RÕ.
      assert.equal(plan.audio, null, 'mọi plan MVP-04 mang audio = null');
      assert.ok(plan.warnings.includes(VIDEO_AUDIO_WARNING), 'plan phải mang cảnh báo KHÔNG có tiếng của V1');
    });
  }

  test('tổng VƯỢT TRẦN ⇒ CẮT (không bao giờ vượt) + warnings nêu ĐÚNG số ms yêu cầu/trần/đã cắt', () => {
    const preset = VIDEO_PRESETS.find((p) => p.id === 'vuong-1x1');
    const plan = buildVideoPlan({
      scenes: [
        { source: { width: 900, height: 900 }, duration_ms: 20000 },
        { source: { width: 900, height: 900 }, duration_ms: 20000 },
      ],
      preset: preset.id,
    });

    assert.equal(preset.max_seconds, 30);
    assert.ok(
      plan.duration_ms <= preset.max_seconds * 1000,
      `duration_ms (${plan.duration_ms}) KHÔNG được vượt trần ${preset.max_seconds * 1000}ms`,
    );
    assert.equal(plan.duration_ms, 30000, 'ngân sách bị cắt còn ĐÚNG trần');
    assert.equal(plan.scenes.reduce((sum, s) => sum + s.duration_ms, 0), 30000);
    assert.equal(plan.frame_count, 360, '30s × 12fps');
    assert.equal(plan.scenes.reduce((sum, s) => sum + s.frames, 0), plan.frame_count);

    const cut = plan.warnings.find((w) => /vượt trần/.test(w) && /40000/.test(w));
    assert.ok(cut, `phải có cảnh báo cắt nêu tổng yêu cầu; warnings = ${JSON.stringify(plan.warnings)}`);
    assert.match(cut, /40000ms/, 'nêu tổng ĐÃ YÊU CẦU');
    assert.match(cut, /30000ms/, 'nêu TRẦN của preset');
    assert.match(cut, /cắt 10000ms/, 'nêu số ms ĐÃ CẮT');
  });

  test('thời lượng MỘT cảnh bị kẹp: vượt trần preset ⇒ kẹp + cảnh báo; dưới sàn ⇒ nâng + cảnh báo', () => {
    const over = buildVideoPlan({
      scenes: [{ source: { width: 720, height: 1280 }, duration_ms: 45000 }],
      preset: 'doc-9x16',
    });
    assert.equal(over.scenes[0].duration_ms, 30000, 'trần một cảnh = max_seconds × 1000');
    assert.equal(over.duration_ms, 30000);
    assert.ok(
      over.warnings.some((w) => /45000ms/.test(w) && /30000ms/.test(w)),
      `phải cảnh báo kẹp thời lượng; warnings = ${JSON.stringify(over.warnings)}`,
    );

    const under = buildVideoPlan({
      scenes: [{ source: { width: 720, height: 1280 }, duration_ms: 10 }],
      preset: 'doc-9x16',
    });
    assert.ok(under.scenes[0].duration_ms >= Math.ceil(1000 / under.fps), 'sàn hiệu dụng ≥ 1 khung');
    assert.equal(under.scenes[0].duration_ms, 250, 'sàn mặc định 250ms');
    assert.ok(
      under.warnings.some((w) => /10ms/.test(w) && /250ms/.test(w)),
      `phải cảnh báo nâng sàn; warnings = ${JSON.stringify(under.warnings)}`,
    );
  });

  test('fit_box giữ ĐÚNG tỉ lệ ảnh nguồn (≤ 1px) và nằm TRONG khung — cho cả pad và crop', () => {
    const sources = [
      { width: 640, height: 480 },
      { width: 1000, height: 1000 },
      { width: 333, height: 777 },
      { width: 1280, height: 720 },
    ];
    for (const preset of VIDEO_PRESETS) {
      for (const fit of FIT_MODES) {
        for (const source of sources) {
          const plan = buildVideoPlan({
            scenes: [{ source, duration_ms: 1000, fit }],
            preset: preset.id,
          });
          const scene = plan.scenes[0];
          const label = `${preset.id}/${fit}/${source.width}x${source.height}`;

          assert.equal(scene.fit, fit, label);
          assert.ok(
            insideFrame(scene.fit_box, plan.width, plan.height),
            `${label}: fit_box ${JSON.stringify(scene.fit_box)} phải nằm trong khung ${plan.width}x${plan.height}`,
          );

          if (fit === 'pad') {
            // CONTAIN: fit_box CHÍNH LÀ ảnh đã phóng ⇒ tỉ lệ phải bằng tỉ lệ ảnh nguồn.
            const expectedW = scene.fit_box.h * (source.width / source.height);
            assert.ok(
              Math.abs(scene.fit_box.w - expectedW) <= 1,
              `${label}: sai số tỉ lệ ${Math.abs(scene.fit_box.w - expectedW)}px > 1px`,
            );
            // Ảnh nhỏ hơn khung theo một chiều ⇒ có viền pad (hoặc khớp tuyệt đối).
            assert.ok(
              scene.fit_box.w <= plan.width && scene.fit_box.h <= plan.height,
              `${label}: pad không được phóng tràn khung`,
            );
          } else {
            // COVER: ảnh đã phóng phủ kín khung ⇒ fit_box = phần NHÌN THẤY = cả khung.
            assert.equal(scene.fit_box.w, plan.width, `${label}: crop phải phủ kín bề rộng`);
            assert.equal(scene.fit_box.h, plan.height, `${label}: crop phải phủ kín bề cao`);

            // Phần ảnh nguồn tương ứng phải được phóng bằng MỘT hệ số cho cả hai trục
            // (đây là điều kiện "không bóp méo" của crop).
            const geometry = fitImageInFrame({
              source_width: source.width,
              source_height: source.height,
              width: plan.width,
              height: plan.height,
              fit: 'crop',
            });
            const scaleX = geometry.fit_box.w / geometry.source_region.w;
            const scaleY = geometry.fit_box.h / geometry.source_region.h;
            assert.ok(
              Math.abs(scaleX - scaleY) <= 1e-9,
              `${label}: crop phải dùng MỘT hệ số phóng (${scaleX} ≠ ${scaleY}) — không kéo giãn`,
            );
            const expectedW = geometry.scaled.h * (source.width / source.height);
            assert.ok(
              Math.abs(geometry.scaled.w - expectedW) <= 1,
              `${label}: ảnh đã phóng lệch tỉ lệ nguồn ${Math.abs(geometry.scaled.w - expectedW)}px > 1px`,
            );
          }
        }
      }
    }
  });

  test('preset LẠ ⇒ UNKNOWN_PRESET (kèm danh sách preset có thật) — KHÔNG đoán tỉ lệ', () => {
    for (const preset of ['khong-co', '', null, undefined, 42, { id: 'la-hoac' }]) {
      assert.throws(
        () => buildVideoPlan({ scenes: SCENES, preset }),
        (err) => {
          assert.ok(err instanceof VideoError, 'phải là VideoError');
          assert.equal(err.code, VIDEO_CODES.UNKNOWN_PRESET);
          assert.deepEqual(err.details.available, VIDEO_PRESETS.map((p) => p.id));
          return true;
        },
        `preset ${JSON.stringify(preset)} phải bị từ chối`,
      );
    }
  });

  test('scenes RỖNG (hoặc không phải mảng) ⇒ NO_SCENES', () => {
    for (const scenes of [[], null, undefined, 'khong-phai-mang', {}]) {
      assert.throws(
        () => buildVideoPlan({ scenes, preset: 'vuong-1x1' }),
        (err) => err instanceof VideoError && err.code === VIDEO_CODES.NO_SCENES,
        `scenes ${JSON.stringify(scenes)} phải bị từ chối`,
      );
    }
  });

  test('cảnh THIẾU kích thước nguồn ⇒ BAD_SOURCE (fail-closed, có index)', () => {
    const bad = [
      {},
      { source: {} },
      { source: { width: 100 } },
      { source: { width: 0, height: 100 } },
      { source: { width: 100, height: -5 } },
    ];
    for (const scene of bad) {
      assert.throws(
        () => buildVideoPlan({ scenes: [SCENES[0], scene], preset: 'vuong-1x1' }),
        (err) => {
          assert.ok(err instanceof VideoError);
          assert.equal(err.code, VIDEO_CODES.BAD_SOURCE);
          assert.equal(err.details.index, 1, 'phải chỉ ĐÚNG cảnh thiếu dữ liệu');
          return true;
        },
        `cảnh ${JSON.stringify(scene)} phải bị từ chối`,
      );
    }
  });

  test('fit LẠ ⇒ BAD_FIT (đoán sai ở đây là BÓP MÉO ảnh)', () => {
    for (const fit of ['stretch', 'fill', 'contain', 'COVER', 1, true]) {
      assert.throws(
        () => buildVideoPlan({ scenes: [{ ...SCENES[0], fit }], preset: 'vuong-1x1' }),
        (err) => {
          assert.ok(err instanceof VideoError);
          assert.equal(err.code, VIDEO_CODES.BAD_FIT);
          assert.deepEqual(err.details.available, [...FIT_MODES]);
          return true;
        },
        `fit ${JSON.stringify(fit)} phải bị từ chối`,
      );
    }
  });

  test('chữ RỖNG bị BỎ khỏi plan + có cảnh báo (không tạo text rỗng cho V2 vẽ)', () => {
    const plan = buildVideoPlan({
      scenes: [
        {
          source: { width: 900, height: 900 },
          duration_ms: 1000,
          texts: ['   ', '', { text: '  ' }, { text: 'Ao thun nam' }],
        },
      ],
      preset: 'vuong-1x1',
    });
    const texts = plan.scenes[0].texts;
    assert.equal(texts.length, 1, `chỉ giữ chữ có nội dung, nhận ${JSON.stringify(texts)}`);
    assert.equal(texts[0].text, 'Ao thun nam');
    assert.ok(
      plan.warnings.some((w) => /chữ rỗng/.test(w)),
      `phải có cảnh báo bỏ chữ rỗng; warnings = ${JSON.stringify(plan.warnings)}`,
    );
  });

  test('planFrameCount: khớp plan; plan hỏng ⇒ BAD_PLAN (không ghi usage bằng số lệch)', () => {
    const plan = buildVideoPlan({ scenes: SCENES, preset: 'doc-9x16' });
    assert.equal(planFrameCount(plan), plan.frame_count);
    assert.equal(planFrameCount(plan), Math.round((plan.duration_ms / 1000) * plan.fps));

    const broken = { ...plan, scenes: plan.scenes.map((scene, i) => (i === 0 ? { ...scene, frames: 1 } : scene)) };
    assert.throws(
      () => planFrameCount(broken),
      (err) => err instanceof VideoError && err.code === VIDEO_CODES.BAD_PLAN,
      'tổng khung cảnh lệch frame_count phải bị từ chối',
    );
    assert.throws(() => planFrameCount(null), (err) => err.code === VIDEO_CODES.BAD_PLAN);
    assert.throws(() => planFrameCount({}), (err) => err.code === VIDEO_CODES.BAD_PLAN);
    assert.equal(planFrameCount({ duration_ms: 1000, fps: 12 }), 12, 'thiếu frame_count ⇒ suy từ duration_ms × fps');
  });

  test('cùng đầu vào ⇒ cùng plan (tất định, không phụ thuộc thời gian)', () => {
    const a = buildVideoPlan({ scenes: SCENES, preset: 'ngang-16x9' });
    const b = buildVideoPlan({ scenes: SCENES, preset: 'ngang-16x9' });
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  });
});
