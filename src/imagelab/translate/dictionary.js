/**
 * C2 — Bộ dịch MOCK: từ điển thuật ngữ + ghép cơ học.
 *
 * Vì sao tồn tại: hợp đồng yêu cầu provider `mock` chạy được offline, `is_mock = true`,
 * KHÔNG gọi mạng, KHÔNG bịa. Cách làm ở đây:
 *   1. Khớp nguyên cụm với GLOSSARY (hoặc glossary_extra của người dùng) → bản dịch từ điển;
 *   2. Nếu không khớp nguyên cụm: thay thế tham lam theo cụm DÀI NHẤT bằng từ điển;
 *   3. Ký tự Hán nào từ điển không biết thì GIỮ NGUYÊN (không đoán) — guardrail (b) sẽ bắt
 *      "CHƯA DỊCH" và đẩy dòng đó sang NEEDS_REVIEW.
 *
 * Nhờ vậy mọi chữ trong `text_vi` đều truy được về một mục từ điển: không có chỗ cho bịa.
 */

import { GLOSSARY } from './glossary.js';

/**
 * Từ vựng bổ sung cho mock (những từ rất hay gặp trên ảnh sản phẩm Trung Quốc).
 * Giá trị rỗng '' = cố ý bỏ (trợ từ), không phải lỗi dữ liệu.
 */
export const MOCK_EXTRA_TERMS = Object.freeze({
  // Trợ từ / hư từ
  的: '',
  和: 'và',
  与: 'và',
  及: 'và',
  可: 'có thể',
  不: 'không',
  适用: 'phù hợp',
  适合: 'phù hợp',
  采用: 'sử dụng',
  支持: 'hỗ trợ',
  本: 'này',
  该: 'này',
  请: 'vui lòng',
  含: 'gồm',
  有: 'có',
  // Quần áo
  T恤: 'Áo thun',
  // Cụm hoàn chỉnh hay gặp trên ảnh (mock ghép sẵn cho câu Việt đọc được ngay)
  纯棉短袖T恤: 'Áo thun tay ngắn cotton',
  短袖T恤: 'Áo thun tay ngắn',
  长袖T恤: 'Áo thun tay dài',
  纯棉T恤: 'Áo thun cotton',
  夏季新款: 'Mẫu mới mùa hè',
  冬季新款: 'Mẫu mới mùa đông',
  男士短袖: 'Áo tay ngắn nam',
  女士短袖: 'Áo tay ngắn nữ',
  男装: 'Thời trang nam',
  女装: 'Thời trang nữ',
  童装: 'Thời trang trẻ em',
  卫衣: 'Áo nỉ',
  衬衫: 'Sơ mi',
  外套: 'Áo khoác',
  毛衣: 'Áo len',
  裤子: 'Quần',
  裙子: 'Váy',
  袜子: 'Tất',
  帽子: 'Mũ',
  围巾: 'Khăn',
  手套: 'Găng tay',
  背包: 'Ba lô',
  钱包: 'Ví',
  腰带: 'Thắt lưng',
  眼镜: 'Kính',
  口罩: 'Khẩu trang',
  鞋: 'Giày',
  拖鞋: 'Dép',
  服装: 'Quần áo',
  纯色: 'Màu trơn',
  条纹: 'Sọc',
  印花: 'In hoa văn',
  格子: 'Kẻ ô',
  宽松: 'Rộng rãi',
  修身: 'Ôm dáng',
  显瘦: 'Tôn dáng',
  百搭: 'Dễ phối đồ',
  潮流: 'Xu hướng',
  韩版: 'Phong cách Hàn',
  立领: 'Cổ đứng',
  连帽: 'Có mũ',
  口袋: 'Có túi',
  长款: 'Dáng dài',
  中长款: 'Dáng trung dài',
  短款: 'Dáng ngắn',
  均码: 'Cỡ tự do',
  尺码表: 'Bảng kích cỡ',
  加大: 'Size lớn hơn',
  男: 'Nam',
  女: 'Nữ',
  男士: 'Nam',
  女士: 'Nữ',
  男女: 'Nam nữ',
  学生: 'Học sinh',
  情侣: 'Cặp đôi',
  儿童款: 'Bản trẻ em',
  // Chất liệu / đặc tính vải
  亲肤: 'Êm da',
  吸汗: 'Thấm hút mồ hôi',
  速干: 'Nhanh khô',
  免烫: 'Không cần là',
  抗皱: 'Chống nhăn',
  加绒: 'Lót lông',
  双面: 'Hai mặt',
  棉: 'Cotton',
  涤纶: 'Polyester',
  尼龙: 'Nylon',
  硅胶: 'Silicon',
  塑料: 'Nhựa',
  玻璃: 'Thuỷ tinh',
  陶瓷: 'Gốm sứ',
  木质: 'Gỗ',
  金属: 'Kim loại',
  铝合金: 'Hợp kim nhôm',
  皮革: 'Da',
  羊毛: 'Len',
  麻: 'Vải lanh',
  // Màu sắc
  颜色: 'Màu sắc',
  白色: 'Màu trắng',
  黑色: 'Màu đen',
  红色: 'Màu đỏ',
  蓝色: 'Màu xanh dương',
  绿色: 'Màu xanh lá',
  灰色: 'Màu xám',
  粉色: 'Màu hồng',
  黄色: 'Màu vàng',
  紫色: 'Màu tím',
  棕色: 'Màu nâu',
  橙色: 'Màu cam',
  米色: 'Màu be',
  卡其色: 'Màu kaki',
  // Mùa / kích thước chung
  夏季: 'Mùa hè',
  冬季: 'Mùa đông',
  春季: 'Mùa xuân',
  秋季: 'Mùa thu',
  大: 'Lớn',
  小: 'Nhỏ',
  长: 'Dài',
  短: 'Ngắn',
  宽: 'Rộng',
  高: 'Cao',
  轻: 'Nhẹ',
  重: 'Nặng',
  // Đồ gia dụng / đời sống
  保温杯: 'Bình giữ nhiệt',
  水杯: 'Cốc nước',
  餐具: 'Dụng cụ ăn uống',
  毛巾: 'Khăn',
  枕头: 'Gối',
  床单: 'Ga giường',
  挂钩: 'Móc treo',
  台灯: 'Đèn bàn',
  玩具: 'Đồ chơi',
  文具: 'Văn phòng phẩm',
  笔记本: 'Sổ tay',
  // Điện tử
  充电器: 'Củ sạc',
  音箱: 'Loa',
  鼠标: 'Chuột',
  键盘: 'Bàn phím',
  支架: 'Giá đỡ',
  保护壳: 'Ốp bảo vệ',
  贴膜: 'Miếng dán màn hình',
  // Đơn vị / số lượng
  毫米: 'mm',
  厘米: 'cm',
  米: 'm',
  毫升: 'ml',
  升: 'l',
  毫安: 'mAh',
  瓦: 'W',
  伏: 'V',
  千克: 'kg',
  公斤: 'kg',
  克: 'g',
  英寸: 'inch',
  小时: 'giờ',
  分钟: 'phút',
  天: 'ngày',
  个月: 'tháng',
  年: 'năm',
  件: 'chiếc',
  个: 'chiếc',
  只: 'chiếc',
  双: 'đôi',
  套: 'bộ',
  盒: 'hộp',
  张: 'tờ',
  片: 'miếng',
  包: 'gói',
  瓶: 'chai',
});

/** Dấu câu toàn phần / khoảng trắng toàn phần → dạng tiếng Việt. */
const PUNCT_MAP = Object.freeze({
  '，': ', ',
  '。': '. ',
  '、': ', ',
  '；': '; ',
  '：': ': ',
  '！': '! ',
  '？': '? ',
  '（': ' (',
  '）': ') ',
  '【': ' [',
  '】': '] ',
  '《': ' “',
  '》': '” ',
  '～': '-',
  '×': 'x',
  '＋': '+',
  '　': ' ',
});

/**
 * Dựng bảng tra cuối cùng: MOCK_EXTRA (nền) → GLOSSARY (chuẩn) → glossaryExtra (người dùng đè lên).
 * @returns {Map<string,string>}
 */
export function buildDictionary(glossaryExtra = {}) {
  const dict = new Map(Object.entries(MOCK_EXTRA_TERMS));
  for (const [zh, vi] of GLOSSARY) dict.set(zh, vi);
  for (const [zh, vi] of normalizeGlossaryExtra(glossaryExtra)) dict.set(zh, vi);
  return dict;
}

/**
 * Chuẩn hoá `glossaryExtra` về các cặp [Trung, Việt].
 * Chấp nhận: object {zh: vi}, mảng [zh, vi], mảng {zh, vi} / {source, target} / {term, value}.
 */
export function normalizeGlossaryExtra(glossaryExtra) {
  const out = [];
  const push = (zh, vi) => {
    const k = String(zh ?? '').trim();
    const v = String(vi ?? '').trim();
    if (k) out.push([k, v]);
  };
  if (!glossaryExtra) return out;
  if (Array.isArray(glossaryExtra)) {
    for (const item of glossaryExtra) {
      if (Array.isArray(item)) push(item[0], item[1]);
      else if (item && typeof item === 'object') push(item.zh ?? item.source ?? item.term, item.vi ?? item.target ?? item.value);
    }
    return out;
  }
  if (typeof glossaryExtra === 'object') {
    for (const [k, v] of Object.entries(glossaryExtra)) push(k, v);
  }
  return out;
}

/** Bỏ khoảng trắng + dấu câu hai đầu để so khớp nguyên cụm. */
function normalizeForLookup(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/^[，。、；：！？·\-—]+|[，。、；：！？·\-—]+$/g, '');
}

function tidy(text) {
  let s = String(text ?? '');
  s = s.replace(/[，。、；：！？（）【】《》～×＋　]/g, (c) => PUNCT_MAP[c] ?? c);
  s = s.replace(/\s+([,.;:!?)\]])/g, '$1');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

/**
 * Dịch cơ học bằng từ điển.
 * @returns {{text_vi:string, exact:boolean, matched:Array<[string,string]>, untranslated:string[]}}
 */
export function translateWithDictionary(text, glossaryExtra = {}, dict = null) {
  const table = dict ?? buildDictionary(glossaryExtra);
  const raw = String(text ?? '').trim();
  const matched = [];
  const seen = new Set();

  const exactVi = table.get(normalizeForLookup(raw));
  if (exactVi !== undefined && exactVi !== '') {
    return { text_vi: tidy(exactVi), exact: true, matched: [[normalizeForLookup(raw), exactVi]], untranslated: [] };
  }

  // Cụm dài nhất trước để "保温杯" không bị "保温" cắt trước.
  const keys = [...table.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const chars = [...raw];
  const parts = [];
  const untranslated = [];
  let i = 0;
  while (i < chars.length) {
    let hit = null;
    const rest = chars.slice(i).join('');
    for (const key of keys) {
      if (key.length === 0) continue;
      if (rest.startsWith(key)) {
        hit = key;
        break;
      }
    }
    if (hit) {
      const vi = table.get(hit);
      if (vi) parts.push(vi);
      if (!seen.has(hit)) {
        seen.add(hit);
        matched.push([hit, vi ?? '']);
      }
      i += [...hit].length;
      continue;
    }
    const ch = chars[i];
    parts.push(ch);
    // Chỉ ghi nhận ký tự Hán là "chưa dịch" — dấu câu/ASCII thì không cần dịch.
    if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(ch) && !untranslated.includes(ch)) {
      untranslated.push(ch);
    }
    i += 1;
  }

  return { text_vi: tidy(parts.join(' ')), exact: false, matched, untranslated };
}

export default translateWithDictionary;
