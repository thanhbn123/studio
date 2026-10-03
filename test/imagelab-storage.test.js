/**
 * MVP-02 — STORAGE: CÁC NHÁNH AN TOÀN VÀ NHÁNH LỖI.
 *
 * `src/imagelab/storage.js` là nơi duy nhất ghi/đọc file ảnh, nên đây là bề mặt BẢO MẬT:
 * nếu nó nhận đường dẫn từ DB/người dùng mà không kiểm, kẻ tấn công đọc/ghi được file ngoài
 * `imagelab.dir`. Phản biện đã cố phá và không phá được — file này biến lần kiểm đó thành
 * test thường trực, đồng thời phủ các nhánh lỗi (file mất, ghi hỏng, buffer sai kiểu).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createImageStorage } from '../src/imagelab/storage.js';
import { silent } from './helpers.js';
import { imagelabConfig, tmpDir } from './imagelab-helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('MVP-02 storage · an toàn đường dẫn', () => {
  let storage;
  let dir;

  before(() => {
    dir = tmpDir();
    storage = createImageStorage(imagelabConfig({ IMAGELAB_DIR: dir }), { logger: silent });
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('ghi rồi đọc lại đúng byte, và file nằm trong imagelab.dir', async () => {
    const jobId = randomUUID();
    const assetId = randomUUID();
    const saved = await storage.save({ jobId, assetId, ext: 'png', buffer: PNG });

    assert.equal(saved.storage_path, `${jobId}/${assetId}.png`);
    assert.equal(saved.bytes, PNG.length);
    assert.equal(saved.sha256.length, 64);

    const back = await storage.read({ storage_path: saved.storage_path });
    assert.deepEqual(back, PNG, 'đọc lại phải đúng từng byte');
    assert.equal(await storage.exists({ storage_path: saved.storage_path }), true);
  });

  test('jobId/assetId có ký tự lạ ⇒ TỪ CHỐI (không tạo đường dẫn)', async () => {
    for (const bad of ['../thoat-ra-ngoai', 'a/b', 'a\\b', 'co cham.', '', 'x'.repeat(65)]) {
      await assert.rejects(
        () => storage.save({ jobId: bad, assetId: randomUUID(), ext: 'png', buffer: PNG }),
        (err) => ['INVALID_ID', 'UNSAFE_PATH', 'INVALID_PATH'].includes(err.code),
        `jobId ${JSON.stringify(bad)} phải bị từ chối`,
      );
    }
  });

  test('storage_path có `..` / tuyệt đối ra ngoài / quá 2 đoạn ⇒ TỪ CHỐI khi đọc', async () => {
    for (const evil of [
      '../bi-mat.txt',
      'a/../../etc/passwd',
      'a/b/c.png',
      '/etc/passwd',
    ]) {
      await assert.rejects(
        () => storage.read({ storage_path: evil }),
        (err) => ['UNSAFE_PATH', 'INVALID_PATH'].includes(err.code),
        `storage_path ${JSON.stringify(evil)} phải bị từ chối`,
      );
    }
  });

  test('đường dẫn 2 đoạn NẰM TRONG thư mục là hợp lệ — file không có thì NOT_FOUND (không phải lỗi bảo mật)', async () => {
    // Ghi chú để người sau không hiểu nhầm: `job/asset.txt` KHÔNG phải tấn công traversal — nó
    // chỉ trỏ vào một file (không tồn tại) bên trong imagelab.dir, nên đúng phải là NOT_FOUND.
    await assert.rejects(
      () => storage.read({ storage_path: 'job/asset.txt' }),
      (err) => err.code === 'NOT_FOUND',
    );
  });

  test('storage_path chứa ký tự NUL ⇒ UNSAFE_PATH', async () => {
    await assert.rejects(
      () => storage.read({ storage_path: `job/asset\0.png` }),
      (err) => err.code === 'UNSAFE_PATH',
    );
  });

  test('asset thiếu storage_path ⇒ INVALID_PATH (không đoán bừa)', async () => {
    await assert.rejects(() => storage.read({}), (err) => err.code === 'INVALID_PATH');
    await assert.rejects(() => storage.read({ storage_path: '   ' }), (err) => err.code === 'INVALID_PATH');
  });

  test('file đã bị xoá trên đĩa ⇒ NOT_FOUND; exists() trả false; remove() idempotent', async () => {
    const jobId = randomUUID();
    const assetId = randomUUID();
    const saved = await storage.save({ jobId, assetId, ext: 'png', buffer: PNG });
    assert.equal(await storage.exists(saved), true);

    await fs.rm(path.join(dir, saved.storage_path));
    assert.equal(await storage.exists(saved), false);
    await assert.rejects(() => storage.read(saved), (err) => err.code === 'NOT_FOUND');

    // Xoá lần hai không được ném lỗi (idempotent).
    await storage.remove(saved);
    await storage.remove(saved);
  });

  test('buffer sai kiểu / rỗng ⇒ TỪ CHỐI, không tạo file rác', async () => {
    const jobId = randomUUID();
    await assert.rejects(
      () => storage.save({ jobId, assetId: randomUUID(), ext: 'png', buffer: 'khong-phai-buffer' }),
      (err) => err.code === 'INVALID_BUFFER',
    );
  });

  test('ext lạ ⇒ INVALID_EXT (chỉ nhận phần mở rộng ảnh đã biết)', async () => {
    await assert.rejects(
      () => storage.save({ jobId: randomUUID(), assetId: randomUUID(), ext: '../sh', buffer: PNG }),
      (err) => ['INVALID_EXT', 'INVALID_ID', 'UNSAFE_PATH'].includes(err.code),
    );
  });

  test('ghi đè lên file đã tồn tại vẫn an toàn (ghi tạm rồi đổi tên)', async () => {
    const jobId = randomUUID();
    const assetId = randomUUID();
    const first = await storage.save({ jobId, assetId, ext: 'png', buffer: PNG });
    const second = await storage.save({ jobId, assetId, ext: 'png', buffer: Buffer.concat([PNG, Buffer.from([1, 2, 3])]) });

    assert.equal(first.storage_path, second.storage_path);
    const back = await storage.read(second);
    assert.equal(back.length, PNG.length + 3, 'nội dung mới phải thay nội dung cũ');
    // Không còn file tạm `.tmp` nào sót lại.
    const files = await fs.readdir(path.join(dir, jobId));
    assert.deepEqual(files.filter((f) => f.includes('.tmp')), [], 'không được để lại file tạm');
  });
});
