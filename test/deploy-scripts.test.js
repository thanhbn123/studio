// Bộ thử cho lớp triển khai (deploy/).
//
// Toàn bộ phép đo nằm ở `deploy/tests/thu-deploy.sh` — thứ được kiểm là bash,
// nên phép kiểm viết bằng bash. File này chỉ đưa bộ đó vào đường chạy mặc định
// của `npm test`: một bộ thử nằm ngoài đường chạy là bộ thử sẽ mục đi mà không
// ai biết.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = path.join(REPO, 'deploy', 'tests', 'thu-deploy.sh');
const SCRIPTS = ['common.sh', 'staging.sh', 'production.sh', 'rollback.sh', 'backup.sh', 'verify.sh'];

test('bộ thử triển khai đạt toàn bộ', () => {
  assert.ok(existsSync(SUITE), `thiếu ${SUITE}`);
  const r = spawnSync('bash', [SUITE], { cwd: REPO, encoding: 'utf8', timeout: 300_000 });
  assert.equal(r.status, 0, `bộ thử deploy KHÔNG đạt:\n${r.stdout}\n${r.stderr}`);
  // Chốt rằng nó thật sự chạy các ca, không phải thoát sớm với 0 ca.
  assert.match(r.stdout, /KẾT QUẢ:/);
  assert.match(r.stdout, / 0 không đạt/);
});

for (const s of SCRIPTS) {
  test(`cú pháp deploy/${s}`, () => {
    const p = path.join(REPO, 'deploy', s);
    assert.ok(existsSync(p), `thiếu ${p}`);
    const r = spawnSync('bash', ['-n', p], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${s} lỗi cú pháp:\n${r.stderr}`);
  });
}
