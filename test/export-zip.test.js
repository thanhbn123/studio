/**
 * TEST MVP-06 · X1 — ZIP THẬT (`src/exports/crc32.js`, `create-zip.js`, `inspect-zip.js`).
 *
 * Ba đường kiểm chứng ĐỘC LẬP nhau, không đường nào dùng lại đường kia:
 *   1. `inspectZip` — bộ đọc của X1 (parse central directory, CRC bản KHÔNG BẢNG);
 *   2. `readZipEntries` — bộ đọc viết tay trong test (chỉ `node:zlib`), đọc lại NỘI DUNG;
 *   3. `python3` + `zipfile` — CÔNG CỤ NGOÀI (không phải mã của repo) mở gói và đọc từng file.
 *
 * Phủ: CRC32 theo vector chuẩn, ZIP 1/5/50 entry TÊN CÓ DẤU TIẾNG VIỆT, entry 0 byte,
 * entry ~1 MB, method store/deflate (auto chỉ nén khi NHỎ HƠN thật), file bị CẮT 30%/90%,
 * rác ⇒ `valid: false` kèm lý do, và ZIP do Python ghi ra phải được `inspectZip` đọc đúng.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';

import { crc32, crc32Bitwise } from '../src/exports/crc32.js';
import { createZip, normalizeZipName, ZIP_FLAG_UTF8 } from '../src/exports/create-zip.js';
import { inspectZip } from '../src/exports/inspect-zip.js';
import { ExportError } from '../src/exports/errors.js';
import { outDir, readZipEntries, sha256Hex } from './export-helpers.js';

/* ───────────────────── dữ liệu tất định (không Math.random) ───────────────────── */

/** Bộ sinh byte giả ngẫu nhiên TẤT ĐỊNH — cùng seed ⇒ cùng dãy byte giữa mọi lần chạy. */
function prngBytes(length, seed = 1) {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

const VI_TEXT = 'Gói xuất bản — nội dung tiếng Việt có dấu: ăn uống, đậm đà, sản phẩm mới.';

/** 1 entry: tên có dấu + nội dung UTF-8 (số ký tự ≠ số byte). */
const oneEntry = () => [{ name: 'nội-dung/nội-dung.txt', data: VI_TEXT }];

/** 5 entry: trộn store/deflate, có ảnh nhị phân và tên thư mục tiếng Việt. */
const fiveEntries = () => [
  { name: 'MANIFEST.json', data: `${JSON.stringify({ job: { id: 'x' }, ghi_chú: 'bản kê khai' }, null, 2)}\n` },
  { name: 'nội-dung/nội-dung.json', data: `${JSON.stringify({ headline: 'Tiêu đề' })}\n` },
  { name: 'ảnh/ảnh-gốc-1.png', data: prngBytes(4096, 7) },
  { name: 'ảnh/ảnh-tạo-1.png', data: prngBytes(2048, 9), method: 'deflate' },
  { name: 'video/video-1.gif', data: Buffer.from('GIF89a-test', 'utf8'), method: 'store' },
];

/** 50 entry: tên có dấu, xen kẽ nén/không nén, kích thước khác nhau. */
const fiftyEntries = () => {
  const list = [];
  for (let i = 1; i <= 50; i += 1) {
    const mau = i % 3 === 0 ? 'đỏ' : i % 3 === 1 ? 'xanh-lá' : 'vàng';
    const name = i % 2 === 0 ? `thư-mục/ảnh-${i}-${mau}.png` : `dữ-liệu/tệp-${i}-${mau}.txt`;
    const data = i % 4 === 0
      ? prngBytes(256 * i, i)
      : Buffer.from(`# ${i}\n${VI_TEXT}\n`.repeat(i), 'utf8');
    list.push({ name, data });
  }
  return list;
};

/* ───────────────────── python3 — công cụ NGOÀI ───────────────────── */

const PY_AVAILABLE = (() => {
  const probe = spawnSync('python3', ['-c', 'import zipfile'], { encoding: 'utf8' });
  return probe.status === 0;
})();

const PY_INSPECT = `
import hashlib, json, sys, zipfile, zlib
z = zipfile.ZipFile(sys.argv[1])
out = {'testzip': z.testzip(), 'names': z.namelist(), 'entries': {}}
for n in z.namelist():
    d = z.read(n)
    info = z.getinfo(n)
    out['entries'][n] = {
        'size': len(d),
        'crc': zlib.crc32(d) & 0xffffffff,
        'sha256': hashlib.sha256(d).hexdigest(),
        'method': info.compress_type,
    }
print(json.dumps(out, ensure_ascii=False))
`;

/** Chạy `python3` đọc một file .zip đã ghi ra đĩa (KHÔNG chạm mạng). */
function pythonInspect(filePath) {
  const run = spawnSync('python3', ['-c', PY_INSPECT, filePath], { encoding: 'utf8' });
  assert.equal(run.status, 0, `python3 thất bại: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

const OUT = outDir();
const writeZip = (name, data) => {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, data);
  return file;
};

/* ═══════════════════════════════ CRC32 ═══════════════════════════════ */

describe('MVP-06 · CRC32 — vector chuẩn IEEE 802.3', () => {
  test('các mẫu đã biết trên toàn thế giới đều khớp', () => {
    // Vector kinh điển của CRC-32/ISO-HDLC (đa thức 0xEDB88320) — tra được ở bất kỳ tài liệu CRC nào.
    assert.equal(crc32('123456789'), 0xcbf43926, 'CRC32("123456789") phải = 0xCBF43926');
    assert.equal(crc32(''), 0, 'CRC32 của chuỗi rỗng phải = 0');
    assert.equal(crc32('a'), 0xe8b7be43);
    assert.equal(crc32('abc'), 0x352441c2);
    assert.equal(crc32('The quick brown fox jumps over the lazy dog'), 0x414fa339);
    // UTF-8: chuỗi tiếng Việt phải được băm trên BYTE UTF-8 (không phải UTF-16).
    assert.equal(crc32('đậm đà'), crc32(Buffer.from('đậm đà', 'utf8')));
  });

  test('luôn trả số nguyên KHÔNG DẤU và bằng bản không-bảng', () => {
    const samples = [Buffer.alloc(0), Buffer.from([0xff]), prngBytes(1000, 3), Buffer.from(VI_TEXT, 'utf8')];
    for (const buf of samples) {
      const value = crc32(buf);
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, `CRC32 phải là số không dấu, nhận ${value}`);
      assert.equal(value, crc32Bitwise(buf), 'hai cách tính CRC32 phải khớp nhau');
    }
    // Dữ liệu toàn 0xFF là ca dễ ra số âm nếu quên `>>> 0`.
    assert.ok(crc32(Buffer.alloc(64, 0xff)) > 0);
  });

  test('đầu vào không phải Buffer/Uint8Array/string ⇒ TypeError có mã', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      assert.throws(() => crc32(bad), (err) => err instanceof TypeError && err.code === 'INVALID_BUFFER', `nhận ${String(bad)}`);
    }
  });
});

/* ═══════════════════════ ZIP 1/5/50 entry (tên tiếng Việt) ═══════════════════════ */

describe('MVP-06 · createZip + inspectZip — 1/5/50 entry tên CÓ DẤU', () => {
  for (const [label, make] of [['1 entry', oneEntry], ['5 entry', fiveEntries], ['50 entry', fiftyEntries]]) {
    test(`${label}: inspectZip khớp tên/kích thước/CRC/method + bộ đọc thứ hai đọc đúng nội dung`, () => {
      const entries = make();
      const buffer = createZip({ entries, date: new Date('2026-10-07T10:20:30Z') });
      assert.equal(buffer.subarray(0, 4).toString('latin1'), 'PK\x03\x04', 'phải bắt đầu bằng chữ ký local header');

      const check = inspectZip(buffer);
      assert.deepEqual(check.errors, [], `inspectZip phải sạch lỗi: ${check.errors.join(' · ')}`);
      assert.equal(check.valid, true);
      assert.equal(check.bytes, buffer.length);
      assert.equal(check.entries.length, entries.length, 'số entry phải khớp');
      entries.forEach((entry, i) => {
        const got = check.entries[i];
        assert.equal(got.name, entry.name, `tên entry #${i} (tiếng Việt) phải giữ nguyên`);
        assert.equal(got.size, Buffer.byteLength(entry.data), `size entry #${i}`);
        assert.equal(got.crc32, crc32(entry.data), `CRC32 entry #${i}`);
        assert.ok([0, 8].includes(got.method), `method entry #${i} chỉ được là 0|8, nhận ${got.method}`);
      });

      // Bộ đọc thứ hai (viết tay trong test): nội dung từng file phải NGUYÊN VẸN.
      const read = readZipEntries(buffer);
      assert.deepEqual([...read.keys()], entries.map((e) => e.name), 'thứ tự + tên entry');
      for (const entry of entries) {
        const got = read.get(entry.name);
        assert.equal(sha256Hex(got.data), sha256Hex(Buffer.from(entry.data)), `nội dung ${entry.name} phải nguyên vẹn`);
        assert.equal(got.size, Buffer.byteLength(entry.data));
        assert.equal(got.crc32, crc32(entry.data));
      }

      // Cờ bit 11 (tên UTF-8) phải bật ở CẢ local header LẪN central directory.
      assert.ok((buffer.readUInt16LE(6) & ZIP_FLAG_UTF8) !== 0, 'local header phải bật cờ UTF-8 (bit 11)');
      for (const entry of read.values()) assert.ok((entry.flags & ZIP_FLAG_UTF8) !== 0, `central record ${entry.name} phải bật cờ UTF-8`);
    });
  }

  test('method: "auto" CHỈ nén khi nhỏ hơn thật; "deflate"/"store" được tôn trọng', () => {
    const text = Buffer.from(VI_TEXT.repeat(50), 'utf8');
    const noise = prngBytes(4096, 11);
    const buffer = createZip({
      entries: [
        { name: 'nén/van-ban.txt', data: text },
        { name: 'nén/nhiễu.bin', data: noise },
        { name: 'nén/bắt-buộc.txt', data: Buffer.from('aaaa'), method: 'deflate' },
        { name: 'nén/không-nén.txt', data: text, method: 'store' },
      ],
      date: new Date('2026-10-07T10:20:30Z'),
    });
    const check = inspectZip(buffer);
    assert.equal(check.valid, true, check.errors.join(' · '));
    const byName = new Map(check.entries.map((e) => [e.name, e]));
    assert.equal(byName.get('nén/van-ban.txt').method, 8, 'văn bản lặp lại ⇒ auto phải chọn deflate');
    assert.equal(byName.get('nén/nhiễu.bin').method, 0, 'dữ liệu ngẫu nhiên ⇒ auto phải giữ store (nén phình hơn)');
    assert.equal(byName.get('nén/bắt-buộc.txt').method, 8, 'method: deflate phải được tôn trọng');
    assert.equal(byName.get('nén/không-nén.txt').method, 0, 'method: store phải được tôn trọng');

    // Nén thật: kích thước trong ZIP của entry deflate phải NHỎ HƠN dữ liệu gốc.
    const read = readZipEntries(buffer);
    assert.ok(read.get('nén/van-ban.txt').data.length === text.length);
    assert.ok(buffer.length < text.length * 4 + noise.length, 'ZIP phải nhỏ hơn tổng dữ liệu thô (chứng minh có nén thật)');
  });

  test('entry 0 byte và entry ~1 MB vẫn đúng (cả CRC)', () => {
    const big = prngBytes(1024 * 1024, 13);
    const buffer = createZip({
      entries: [
        { name: 'rỗng/trống.txt', data: Buffer.alloc(0) },
        { name: 'lớn/dữ-liệu-lớn.bin', data: big },
      ],
      date: new Date('2026-10-07T10:20:30Z'),
    });
    const check = inspectZip(buffer);
    assert.equal(check.valid, true, check.errors.join(' · '));
    const empty = check.entries.find((e) => e.name === 'rỗng/trống.txt');
    assert.equal(empty.size, 0);
    assert.equal(empty.crc32, 0);
    const large = check.entries.find((e) => e.name === 'lớn/dữ-liệu-lớn.bin');
    assert.equal(large.size, big.length);
    assert.equal(large.crc32, crc32(big));

    const read = readZipEntries(buffer);
    assert.equal(sha256Hex(read.get('lớn/dữ-liệu-lớn.bin').data), sha256Hex(big));
    assert.equal(read.get('rỗng/trống.txt').data.length, 0);
  });

  test('tên entry nguy hiểm bị CHẶN (zip-slip, tuyệt đối, NUL, trùng tên)', () => {
    const cases = [
      ['../thoát-ra-ngoài.txt', 'ZIP_NAME_INVALID'],
      ['/etc/passwd', 'ZIP_NAME_INVALID'],
      ['C:/Windows/system32', 'ZIP_NAME_INVALID'],
      ['a//b.txt', 'ZIP_NAME_INVALID'],
      ['thư-mục/', 'ZIP_NAME_INVALID'],
      ['', 'ZIP_NAME_INVALID'],
      ['x\0y.txt', 'ZIP_NAME_INVALID'],
    ];
    for (const [name, code] of cases) {
      assert.throws(
        () => createZip({ entries: [{ name, data: 'x' }] }),
        (err) => err instanceof ExportError && err.code === code,
        `tên ${JSON.stringify(name)} phải bị chặn với mã ${code}`,
      );
    }
    assert.throws(
      () => createZip({ entries: [{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }] }),
      (err) => err.code === 'ZIP_DUPLICATE_NAME',
    );
    assert.equal(normalizeZipName('thư-mục/tệp.txt'), 'thư-mục/tệp.txt');
  });
});

/* ═══════════════════ file hỏng: CẮT 30%/90%, rác, quá ngắn ═══════════════════ */

describe('MVP-06 · inspectZip — file ZIP bị CẮT và rác ⇒ valid:false + LÝ DO', () => {
  const full = createZip({ entries: fiftyEntries(), date: new Date('2026-10-07T10:20:30Z') });

  test('cắt 30% và 90% đều bị từ chối kèm lý do cụ thể', () => {
    for (const ratio of [0.3, 0.9]) {
      const cut = full.subarray(0, Math.floor(full.length * ratio));
      const check = inspectZip(cut);
      assert.equal(check.valid, false, `ZIP cắt ${ratio * 100}% KHÔNG được coi là hợp lệ`);
      assert.ok(check.errors.length > 0, 'phải có lý do, không được im lặng');
      assert.ok(
        check.errors.some((e) => /End Of Central Directory|bị cắt|vượt biên|hỏng/i.test(e)),
        `lý do phải nói rõ file hỏng/cụt, nhận: ${check.errors.join(' · ')}`,
      );
      assert.equal(check.bytes, cut.length);
    }
  });

  test('rác thuần (byte ngẫu nhiên / văn bản) ⇒ valid:false, không ném lỗi, không treo', () => {
    for (const junk of [prngBytes(4096, 17), Buffer.from(VI_TEXT.repeat(200), 'utf8'), Buffer.from('PK\x03\x04 nhưng không phải ZIP')]) {
      const check = inspectZip(junk);
      assert.equal(check.valid, false);
      assert.ok(check.errors.length > 0);
    }
  });

  test('file quá ngắn / không phải Buffer ⇒ valid:false + lý do', () => {
    const tiny = inspectZip(Buffer.alloc(10));
    assert.equal(tiny.valid, false);
    assert.match(tiny.errors.join(' '), /quá ngắn/i);
    const notBuffer = inspectZip('không phải buffer');
    assert.equal(notBuffer.valid, false);
    assert.ok(notBuffer.errors.length > 0);
  });

  test('sửa 1 byte CRC trong central directory ⇒ CRC mismatch bị phát hiện', () => {
    const damaged = Buffer.from(full);
    // EOCD nằm ở 22 byte cuối; central directory bắt đầu tại offset ghi trong EOCD.
    const cdOffset = damaged.readUInt32LE(damaged.length - 22 + 16);
    damaged.writeUInt32LE((damaged.readUInt32LE(cdOffset + 16) ^ 0xff) >>> 0, cdOffset + 16);
    const check = inspectZip(damaged);
    assert.equal(check.valid, false, 'CRC sai phải bị phát hiện');
    assert.ok(check.errors.some((e) => /CRC|khác central/i.test(e)), check.errors.join(' · '));
  });
});

/* ═══════════════════ CÔNG CỤ NGOÀI: python3 zipfile ═══════════════════ */

describe('MVP-06 · CÔNG CỤ NGOÀI (python3 zipfile) mở gói và đọc lại nội dung', () => {
  test('python3 có mặt (nếu thiếu, các test dưới sẽ skip rõ ràng)', { skip: !PY_AVAILABLE && 'máy này không có python3' }, () => {
    assert.equal(PY_AVAILABLE, true);
  });

  test('ZIP 5 entry tên tiếng Việt: testzip() = None + đọc lại ĐÚNG nội dung từng file',
    { skip: !PY_AVAILABLE && 'máy này không có python3' }, () => {
      const entries = fiveEntries();
      const buffer = createZip({ entries, date: new Date('2026-10-07T10:20:30Z') });
      const file = writeZip('goi-5-entry.zip', buffer);
      const result = pythonInspect(file);

      // BẰNG CHỨNG in ra ở báo cáo: testzip = None nghĩa là mọi CRC đều đúng theo công cụ ngoài.
      assert.equal(result.testzip, null, `zipfile.testzip() phải trả None, nhận ${result.testzip}`);
      assert.deepEqual(result.names, entries.map((e) => e.name), 'python phải đọc ĐÚNG tên tiếng Việt, đúng thứ tự');
      for (const entry of entries) {
        const got = result.entries[entry.name];
        const want = Buffer.from(entry.data);
        assert.equal(got.size, want.length, `kích thước ${entry.name}`);
        assert.equal(got.crc, crc32(want), `CRC32 ${entry.name} do python tính phải khớp bộ ghi của repo`);
        assert.equal(got.sha256, sha256Hex(want), `NỘI DUNG ${entry.name} phải đọc lại y hệt`);
      }
      // eslint-disable-next-line no-console
      console.log(`[python3 zipfile] testzip=${result.testzip} · ${result.names.length} entry · ${result.names.join(' | ')}`);
    });

  test('ZIP 50 entry (có entry 0 byte + ảnh nhị phân): python đọc được từng file',
    { skip: !PY_AVAILABLE && 'máy này không có python3' }, () => {
      const entries = [...fiftyEntries(), { name: 'rỗng/trống.txt', data: Buffer.alloc(0) }];
      const buffer = createZip({ entries, date: new Date('2026-10-07T10:20:30Z') });
      const file = writeZip('goi-50-entry.zip', buffer);
      const result = pythonInspect(file);
      assert.equal(result.testzip, null);
      assert.equal(result.names.length, 51);
      for (const entry of entries) {
        assert.equal(result.entries[entry.name].sha256, sha256Hex(Buffer.from(entry.data)), entry.name);
      }
      console.log(`[python3 zipfile] 50+1 entry: testzip=${result.testzip}, tổng byte=${buffer.length}`);
    });

  test('inspectZip đọc được ZIP do CHÍNH python3 ghi (kiểm ngược bộ đọc)', { skip: !PY_AVAILABLE && 'máy này không có python3' }, () => {
    const a = Buffer.from(`${VI_TEXT}\n`, 'utf8');
    const b = prngBytes(5000, 23);
    const file = path.join(OUT, 'python-tu-ghi.zip');
    const binFile = writeZip('python-nguon.bin', b);
    // Dữ liệu nhị phân đi qua FILE (argv không nhận byte NUL).
    const script = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('nội-dung/hợp-đồng.txt', sys.argv[2].encode('utf-8'))
    with open(sys.argv[3], 'rb') as fh:
        z.writestr('nhị-phân/dữ-liệu.bin', fh.read(), compress_type=zipfile.ZIP_STORED)
`;
    const run = spawnSync('python3', ['-c', script, file, a.toString('utf8'), binFile], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const check = inspectZip(fs.readFileSync(file));
    assert.equal(check.valid, true, `inspectZip phải đọc được ZIP của python: ${check.errors.join(' · ')}`);
    const byName = new Map(check.entries.map((e) => [e.name, e]));
    assert.equal(byName.get('nội-dung/hợp-đồng.txt').crc32, crc32(a));
    assert.equal(byName.get('nội-dung/hợp-đồng.txt').method, 8);
    assert.equal(byName.get('nhị-phân/dữ-liệu.bin').crc32, crc32(b));
    assert.equal(byName.get('nhị-phân/dữ-liệu.bin').method, 0);
    assert.equal(byName.get('nhị-phân/dữ-liệu.bin').size, b.length);
  });
});
