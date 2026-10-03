/**
 * Chuẩn hoá `RenderOp` (hợp đồng 3.4) trước khi thực thi.
 *
 * Luật: op hỏng KHÔNG được làm sập cả ảnh — nó vào `skipped` kèm lý do máy đọc được,
 * các op còn lại vẫn chạy. Không bao giờ đoán bừa nội dung chữ.
 */

/** Các action hợp lệ (đóng băng theo hợp đồng 3.4). */
export const RENDER_ACTIONS = Object.freeze(['erase', 'draw_text', 'erase_and_draw']);

/** Op nào cần chữ để vẽ. */
export function actionNeedsText(action) {
  return action === 'draw_text' || action === 'erase_and_draw';
}

function defaultRegionId(index) {
  return `op_${index}`;
}

/**
 * @param {unknown} ops
 * @returns {{ops:Array<{index:number,region_id:string,action:string,box:object|null,text:string,style:object,raw:object}>, skipped:Array<{region_id:string,reason:string}>}}
 */
export function normalizeOps(ops) {
  const out = [];
  const skipped = [];
  if (ops === undefined || ops === null) return { ops: out, skipped };
  if (!Array.isArray(ops)) {
    skipped.push({ region_id: '*', reason: 'BAD_OPS' });
    return { ops: out, skipped };
  }
  ops.forEach((raw, index) => {
    const regionId =
      raw && typeof raw.region_id === 'string' && raw.region_id.trim() ? raw.region_id : defaultRegionId(index);
    if (!raw || typeof raw !== 'object') {
      skipped.push({ region_id: regionId, reason: 'BAD_OP' });
      return;
    }
    const text = raw.text === undefined || raw.text === null ? '' : String(raw.text);
    let action = raw.action === undefined || raw.action === null ? '' : String(raw.action).toLowerCase().trim();
    if (!action) action = text ? 'erase_and_draw' : 'erase'; // suy ra khi người gọi bỏ trống
    if (!RENDER_ACTIONS.includes(action)) {
      skipped.push({ region_id: regionId, reason: 'UNSUPPORTED_ACTION' });
      return;
    }
    if (actionNeedsText(action) && !text.trim()) {
      skipped.push({ region_id: regionId, reason: 'NO_TEXT' });
      return;
    }
    const style = raw.style && typeof raw.style === 'object' ? raw.style : {};
    out.push({
      index,
      region_id: regionId,
      action,
      box: raw.box && typeof raw.box === 'object' ? raw.box : null,
      text,
      style,
      raw,
    });
  });
  return { ops: out, skipped };
}

export default normalizeOps;
