/**
 * PB-03 (vòng 2) — CLI tạo/nâng OWNER đầu tiên: `npm run make-owner -- <email> [mật khẩu]`.
 *
 * Vì sao cần: tự đăng ký luôn là `member`, mọi route `/api/admin/*` đòi `owner|admin`, và
 * mặc định `BILLING_DEFAULT_GRANT=0` ⇒ trên cài đặt mới KHÔNG ai cấp được credit ⇒ ví vĩnh
 * viễn 0 ⇒ mọi job 402. Lệnh này là đường bootstrap CÓ CHỦ ĐÍCH, idempotent:
 *   - đã có owner/admin ⇒ chỉ in trạng thái, KHÔNG hạ cấp ai;
 *   - user đã tồn tại ⇒ nâng lên `owner`;
 *   - chưa tồn tại ⇒ tạo mới; mật khẩu (đối số thứ 2, hoặc NGẪU NHIÊN) in ra ĐÚNG MỘT LẦN.
 *
 * Cách chạy:
 *   npm run make-owner -- owner@example.com
 *   npm run make-owner -- owner@example.com 'MatKhauTuChon123'
 */

import { loadConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { createAccountService } from '../src/accounts/index.js';
import { createLogger } from '../src/logger.js';

const [emailArg, passwordArg] = process.argv.slice(2);

if (!emailArg || emailArg === '--help' || emailArg === '-h') {
  console.log('Dùng: npm run make-owner -- <email> [mật khẩu]');
  console.log('  - email   : email của owner đầu tiên (bắt buộc)');
  console.log('  - mật khẩu: bỏ trống ⇒ hệ thống sinh mật khẩu tạm và in ra MỘT LẦN');
  process.exit(emailArg ? 0 : 2);
}

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const store = await createStore(config, logger);

try {
  await store.init?.();
  const accounts = createAccountService(config, { store, logger });
  const result = await accounts.bootstrapOwner({
    email: emailArg,
    password: typeof passwordArg === 'string' && passwordArg ? passwordArg : null,
  });

  if (result.reason === 'NO_OWNER_EMAIL') {
    console.error('❌ Thiếu email. Dùng: npm run make-owner -- <email>');
    process.exitCode = 2;
  } else if (!result.created && !result.promoted) {
    console.log(`ℹ️  Hệ thống đã có owner (${result.owners ?? '≥1'}) — không thay đổi gì.`);
    if (result.user) console.log(`   owner hiện tại: ${result.user.email}`);
  } else if (result.promoted) {
    console.log(`✅ Đã NÂNG ${result.user?.email} lên owner (mật khẩu cũ giữ nguyên).`);
  } else {
    console.log(`✅ Đã TẠO owner ${result.user?.email}.`);
    console.log(`   MẬT KHẨU TẠM (chỉ in lần này): ${result.password}`);
    console.log('   ⚠️  Hãy đăng nhập và ĐỔI MẬT KHẨU ngay.');
  }
} finally {
  await store.close?.();
}
