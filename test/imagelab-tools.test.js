/**
 * TEST MVP-02 · CÔNG CỤ CHỨNG MINH — `tools/imagelab-demo.mjs`.
 *
 * Chạy công cụ thật (spawn tiến trình con, chờ kết thúc) và khẳng định:
 *  - exit code 0, có trạng thái `succeeded` và nhãn `MOCK_VERIFIED` (nói thật là dữ liệu mock);
 *  - không có nhãn `LIVE_VERIFIED`;
 *  - ẢNH FIXTURE GỐC KHÔNG BỊ ĐỔI sau khi chạy (so sha256 trước/sau).
 *
 * Mọi thứ ghi ra đều nằm trong thư mục tạm (`--out`, `IMAGELAB_DIR`, DB in-memory),
 * nên test không để lại rác trong repo. Công cụ chạy offline (mock + purejs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { sha256 } from '../src/imagelab/render/index.js';
import { ROOT, headphones, tmpDir } from './imagelab-helpers.js';

const FIXTURE_REL = 'test/fixtures/headphones.png';

describe('MVP-02 tools — imagelab-demo.mjs chạy thật, ảnh gốc bất biến', () => {
  test('exit 0 + `succeeded` + MOCK_VERIFIED, và ảnh fixture không đổi', () => {
    const fixturePath = path.join(ROOT, FIXTURE_REL);
    const beforeHash = sha256(fs.readFileSync(fixturePath));
    const beforeStat = fs.statSync(fixturePath);

    const dir = tmpDir('vps-imagelab-demo-');
    const outPath = path.join(dir, 'rendered.png');

    const run = spawnSync(
      process.execPath,
      ['tools/imagelab-demo.mjs', '--image', FIXTURE_REL, '--out', outPath, '--db', ':memory:'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          // Ép chạy offline, không phụ thuộc `.env` của máy lập trình viên.
          OCR_PROVIDER: 'mock',
          RENDER_PROVIDER: 'purejs',
          AI_PROVIDER: 'mock',
          TRANSLATE_PROVIDER: 'mock',
          IMAGELAB_ENABLED: 'true',
          IMAGELAB_DIR: dir,
          LOG_LEVEL: 'error',
        },
      },
    );

    const stdout = String(run.stdout || '');
    const stderr = String(run.stderr || '');
    assert.equal(run.status, 0, `demo phải exit 0, nhận ${run.status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
    assert.equal(run.signal, null, 'demo không được bị timeout/kill');

    assert.match(stdout, /succeeded/, 'output phải có trạng thái job succeeded');
    assert.match(stdout, /MOCK_VERIFIED/, 'phải có nhãn MOCK_VERIFIED (provider giả tự khai)');
    assert.ok(!stdout.includes('LIVE_VERIFIED'), 'MVP-02 KHÔNG BAO GIỜ được gắn nhãn LIVE_VERIFIED');
    assert.match(stdout, /Ảnh gốc trên đĩa không đổi/, 'demo phải tự chứng minh ảnh gốc không đổi');

    // ẢNH FIXTURE GỐC: cùng hash, cùng kích thước, cùng thời điểm sửa.
    const afterHash = sha256(fs.readFileSync(fixturePath));
    assert.equal(afterHash, beforeHash, 'ẢNH FIXTURE GỐC ĐÃ BỊ ĐỔI sau khi chạy demo');
    const afterStat = fs.statSync(fixturePath);
    assert.equal(afterStat.size, beforeStat.size);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'file fixture không được bị ghi đè');

    // Ảnh kết quả là file PNG MỚI, khác ảnh gốc, nằm trong thư mục tạm.
    assert.ok(fs.existsSync(outPath), 'demo phải tạo ảnh kết quả');
    const outBuf = fs.readFileSync(outPath);
    assert.deepEqual([...outBuf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'ảnh kết quả phải là PNG');
    assert.notEqual(sha256(outBuf), beforeHash, 'ảnh kết quả phải là bản mới, không phải ảnh gốc');

    // Mọi thứ ghi ra đều nằm trong thư mục tạm: có BẢN LƯU ảnh gốc đúng byte fixture
    // và ảnh render mới (chứng minh luồng lưu trữ thật đã chạy, không phải chỉ in chữ).
    const saved = [];
    for (const jobDir of fs.readdirSync(dir)) {
      const full = path.join(dir, jobDir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        saved.push({ file: path.join(full, f), hash: sha256(fs.readFileSync(path.join(full, f))) });
      }
    }
    assert.ok(
      saved.some((s) => s.hash === beforeHash),
      'phải có bản lưu ảnh gốc (byte-identical với fixture) trong IMAGELAB_DIR tạm',
    );
    assert.ok(saved.some((s) => s.hash === sha256(outBuf)), 'ảnh render phải được lưu trong IMAGELAB_DIR tạm');
  });
});
