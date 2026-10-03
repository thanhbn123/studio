// Kiểm chứng cục bộ; không gọi provider AI hoặc connector trên mạng.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

function scripts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return scripts(path);
    return /\.(?:js|mjs)$/.test(entry.name) ? [path] : [];
  }).sort();
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

const files = ['src', 'public', 'tools', 'test'].flatMap(dir => scripts(join(root, dir)));
console.log(`Kiểm cú pháp ${files.length} file…`);
for (const file of files) run(['--check', relative(root, file)]);

const tests = readdirSync(join(root, 'test'))
  .filter(name => name.endsWith('.test.js')).sort()
  .map(name => join('test', name));
if (!tests.length) throw new Error('Không tìm thấy test để kiểm chứng.');
console.log('Chạy bộ test (PostgreSQL chỉ chạy khi có DATABASE_URL)…');
run(['--test', '--test-concurrency=1', ...tests]);
console.log('Kiểm chứng cục bộ hoàn tất. Kết quả này không xác nhận trích xuất live hoặc triển khai.');
