/**
 * PROBE (KHÔNG phải test tự động — không có hậu tố `.test.js` nên `npm test` KHÔNG chạy nó):
 * chứng minh **mã nguồn sai**: thứ tự cảnh KHÔNG bám thứ tự ảnh người dùng gửi khi nhiều ảnh
 * được lưu trong CÙNG một mili-giây.
 *
 * Hợp đồng §2.4/§2.5 (vòng gộp) chốt: "`options.scenes[i].image` là NGUỒN THỨ TỰ — N ảnh ⇒ N cảnh,
 * thứ tự = thứ tự chọn". Nhưng:
 *   · `ingest()` ghi `meta.scene_index` 0,1,2… ĐÚNG thứ tự tải lên;
 *   · `#originalAssets()` đọc `store.listImageAssets(jobId, { role:'original' })`;
 *   · `listImageAssets` sắp `ORDER BY created_at ASC, id ASC` — khi `created_at` BẰNG NHAU
 *     (ba ảnh lưu trong cùng 1ms) thì thứ tự rơi vào `id` = UUID NGẪU NHIÊN, không phải thứ tự tải lên.
 *
 * Cách probe làm cho ca lỗi TRỞ THÀNH TẤT ĐỊNH (không phụ thuộc may rủi):
 *   1. tự đặt `assetId` theo thứ tự ngược với thứ tự tải lên;
 *   2. ép `created_at` của cả ba ảnh về CÙNG một mốc.
 * ⇒ `plan.scenes[].asset_id` phải KHÁC thứ tự tải lên; probe in ra bằng chứng và thoát mã 1.
 *
 * Chạy: `node test/mvp04-scene-order.probe.mjs`
 */

import { startImagelabApp, makeTestImage } from './imagelab-helpers.js';
import { VIDEOSTUDIO_KIND } from '../src/videostudio/pipeline.js';

const SID = 'sess-probe-scene-order';
const png = (rgb) => makeTestImage({ width: 120, height: 90, background: [...rgb, 255] });

const ctx = await startImagelabApp({ configOverrides: { RATE_LIMIT_MAX_JOBS: '2000' } });
try {
  const jobId = await ctx.store.createJob({ sessionId: SID, kind: VIDEOSTUDIO_KIND });
  const pipeline = ctx.app.videostudioPipeline;

  // Thứ tự NGƯỜI DÙNG gửi: đỏ → xanh lá → xanh dương.
  const upload = [
    { image: png([200, 30, 30]), assetId: 'ffffffff-0000-4000-8000-000000000001' },
    { image: png([30, 200, 30]), assetId: 'aaaaaaaa-0000-4000-8000-000000000002' },
    { image: png([30, 30, 200]), assetId: 'cccccccc-0000-4000-8000-000000000003' },
  ];
  const order = [];
  for (const item of upload) {
    const ingested = await pipeline.ingest(jobId, {
      image: item.image,
      sessionId: SID,
      options: { assetId: item.assetId },
    });
    order.push({ asset_id: ingested.asset_id, scene_index: ingested.scene_index });
  }

  // Ép mọi ảnh về CÙNG một `created_at` ⇒ tái hiện đúng ca "lưu trong cùng 1ms" (ca đã làm test flaky).
  const stamp = '2026-01-01T00:00:00.000Z';
  await ctx.store.driver.run('UPDATE image_assets SET created_at = ? WHERE job_id = ?', [stamp, jobId]);
  const stored = await ctx.store.listImageAssets(jobId, { role: 'original' });

  const result = await pipeline.generate(jobId, {
    sessionId: SID,
    options: { preset: 'vuong-1x1', scenes: upload.map(() => ({ duration_ms: 250 })) },
  });

  const uploadOrder = order.map((item) => item.asset_id);
  const sceneOrder = result.plan.scenes.map((scene) => scene.asset_id);
  const bySceneIndex = [...stored].sort((a, b) => Number(a.meta?.scene_index ?? 0) - Number(b.meta?.scene_index ?? 0)).map((a) => a.id);

  console.log('thứ tự TẢI LÊN (nguồn thứ tự của hợp đồng) :', uploadOrder.join(', '));
  console.log('meta.scene_index do ingest ghi (0,1,2)     :', order.map((item) => item.scene_index).join(', '));
  console.log('listImageAssets trả về (created_at,id)     :', stored.map((a) => a.id).join(', '));
  console.log('plan.scenes[].asset_id (thứ tự THẬT)       :', sceneOrder.join(', '));
  console.log('sắp theo meta.scene_index (ĐÚNG hợp đồng)  :', bySceneIndex.join(', '));

  const ok = sceneOrder.length === uploadOrder.length && sceneOrder.every((id, i) => id === uploadOrder[i]);
  if (!ok) {
    console.error('\n❌ MÃ NGUỒN SAI: thứ tự cảnh KHÔNG bám thứ tự ảnh gửi lên khi created_at bằng nhau.');
    console.error('   Sửa đúng: `#originalAssets()` phải sắp theo `meta.scene_index` (đã có sẵn, ingest ghi đúng),');
    console.error('   hoặc `listImageAssets` phải có khoá sắp ổn định theo thứ tự chèn.');
    process.exitCode = 1;
  } else {
    console.log('\n✅ Thứ tự cảnh khớp thứ tự tải lên.');
  }
} finally {
  await ctx.close();
}
