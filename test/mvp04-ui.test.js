/**
 * TEST — MVP-04 · V5 “UI tab Video” (`public/app.js`, hợp đồng §2.5) — trích hàm THẬT, không DOM.
 *
 * Khoá lại những điểm hợp đồng §2.5 nói rõ:
 *   · escape XSS ở MỌI chữ (tên tệp, tiêu đề, phụ đề, cả trong `value=""`);
 *   · nhãn “Video KHÔNG có tiếng” CHỈ hiện khi `audio === null` (đối chứng âm: audio khác null ⇒ không dán);
 *   · 422 ⇒ hiện ĐỦ `violations`; 402 ⇒ hiện số cần / số đang có;
 *   · `encoder.is_mock` ⇒ nhãn MOCK (không giả vờ là video thật);
 *   · danh sách cảnh giữ ĐÚNG thứ tự, tổng thời lượng đúng khi đổi thời lượng, kẹp theo `max_seconds`;
 *   · nút TẠO VIDEO KHOÁ khi chưa có ảnh.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadVsUi, makeVsState, vsConfigBlock, VS_TEST_PRESETS, esc } from './mvp04-ui-helpers.js';

const stateWith = (vs = {}, config = null) => makeVsState({ config, vs });
const baseVs = () => ({ presets: VS_TEST_PRESETS, preset: 'vuong-1x1', limits: { max_scenes: 24 } });

/** Nội dung thẻ mở của nút TẠO VIDEO (để kiểm `disabled` đúng chỗ, không lẫn nút khác). */
const createButton = (html) => {
  const match = /<button class="btn primary" data-action="vscreate" type="button"([^>]*)>/.exec(html);
  assert.ok(match, `không tìm thấy nút TẠO VIDEO trong HTML: ${html.slice(0, 400)}`);
  return match[1];
};

describe('MVP-04 · V5 — UI tab “Video” (§2.5)', () => {
  test('escape XSS: tên tệp / tiêu đề / phụ đề / value="" đều không thoát ra HTML thô', () => {
    const payload = {
      name: '<img src=x onerror=alert(1)>.png',
      title: '"><script>alert(1)</script>',
      subtitle: '</value><b onmouseover=alert(2)>x</b>',
      seconds: 3,
      base64: 'AAA=',
      dataUrl: '',
    };
    const state = stateWith({ ...baseVs(), scenes: [payload] });
    const ui = loadVsUi(state);
    const html = ui.vsRenderScenes();

    assert.ok(!html.includes('<script>'), 'KHÔNG được để <script> thô lọt vào HTML');
    assert.ok(!html.includes('onerror=alert(1)>'), 'KHÔNG được để thuộc tính onerror thô lọt vào HTML');
    assert.ok(!html.includes('</value>'), 'KHÔNG được để thẻ đóng thô lọt vào value=""');
    assert.ok(!html.includes('<b onmouseover'), 'KHÔNG được để thẻ mở thô lọt vào HTML');

    assert.ok(html.includes(esc(payload.name)), 'tên tệp phải được escape');
    assert.ok(html.includes(`value="${esc(payload.title)}"`), 'tiêu đề phải nằm trong value="" đã escape');
    assert.ok(html.includes(`value="${esc(payload.subtitle)}"`), 'phụ đề phải nằm trong value="" đã escape');

    // Lỗi đọc tệp cũng phải escape (hiện nguyên lý do, không nuốt, không để chạy mã).
    const withErrors = stateWith({ ...baseVs(), scenes: [], fileErrors: ['<script>alert(3)</script> sai định dạng'] });
    const errorsHtml = loadVsUi(withErrors).vsRenderUpload();
    assert.ok(!errorsHtml.includes('<script>'), 'danh sách lỗi tệp phải được escape');
    assert.ok(errorsHtml.includes('&lt;script&gt;'), 'lý do lỗi vẫn phải đọc được sau khi escape');
  });

  test('“Video KHÔNG có tiếng” hiện khi audio = null và KHÔNG hiện khi audio khác null (đối chứng âm)', () => {
    const silentUi = loadVsUi(stateWith(baseVs()));
    const noAudio = silentUi.vsAudioNotice({ audio: null });
    assert.ok(noAudio.includes('Video KHÔNG có tiếng'), 'audio null ⇒ PHẢI dán nhãn trung thực');
    assert.ok(noAudio.includes('id="vs-no-audio"'));

    const audioUi = loadVsUi(stateWith(baseVs()));
    const withAudio = audioUi.vsAudioNotice({ audio: { format: 'mp3', codec: 'aac' } });
    assert.ok(!withAudio.includes('Video KHÔNG có tiếng'), 'audio khác null ⇒ KHÔNG được dán nhãn “không có tiếng”');
    assert.ok(withAudio.includes('Có tiếng'), 'phải nói thật là có tiếng');

    // Đối chứng âm ở tầng MÀN HÌNH: cùng một job, chỉ khác `audio`.
    const job = { id: 'job-1', status: 'succeeded', stage: 'done' };
    const asset = { id: 'asset-1', role: 'rendered', mime: 'image/gif', width: 900, height: 900, bytes: 1234, meta: {} };
    const nullAudio = loadVsUi(
      stateWith({ ...baseVs(), job: { job, rendered: [asset], audio: null, plan: { duration_ms: 250, frame_count: 3 } } }),
    ).vsRenderBody();
    assert.ok(nullAudio.includes('Video KHÔNG có tiếng'), 'màn kết quả với audio null phải có nhãn');

    const hasAudio = loadVsUi(
      stateWith({
        ...baseVs(),
        job: { job, rendered: [{ ...asset, meta: { audio: { format: 'mp3' } } }], audio: { format: 'mp3' } },
      }),
    ).vsRenderBody();
    assert.ok(!hasAudio.includes('Video KHÔNG có tiếng'), 'audio khác null ⇒ màn kết quả KHÔNG được có nhãn');
  });

  test('422 VIDEO_TEXT_UNSUPPORTED_CLAIM ⇒ hiện ĐỦ violations + mã lỗi, không nuốt', () => {
    const err = {
      code: 'VIDEO_TEXT_UNSUPPORTED_CLAIM',
      message: 'Chữ trên video có 2 khẳng định không có bằng chứng.',
      status: 422,
      payload: {
        details: {
          violations: [
            { rule: 'CLAIM_WORD_UNSUPPORTED', text: 'Bảo hành 12 tháng', detail: 'Khẳng định “bảo hành” không có trong dữ liệu đã lưu.' },
            'Số liệu "12" không có trong dữ liệu đã lưu của job.',
          ],
        },
      },
    };
    const state = stateWith({ ...baseVs(), textBlocked: null });
    const ui = loadVsUi(state);

    const blocked = ui.vsTextBlockedFromError(err);
    assert.equal(blocked.code, 'VIDEO_TEXT_UNSUPPORTED_CLAIM');
    assert.equal(blocked.violations.length, 2, `phải gom đủ 2 vi phạm, nhận ${JSON.stringify(blocked.violations)}`);

    state.vs.textBlocked = blocked;
    const panel = ui.vsTextBlockedPanel();
    assert.ok(panel.includes('VIDEO_TEXT_UNSUPPORTED_CLAIM'));
    for (const violation of blocked.violations) {
      assert.ok(panel.includes(esc(violation)), `panel phải hiện vi phạm “${violation}”`);
    }
    assert.ok(loadVsUi(state).vsRenderBody().includes('vs-text-blocked'), 'màn hình phải hiện khối chữ bị chặn');

    // Không có vi phạm ⇒ không dựng khối 422 (tránh báo oan).
    assert.equal(loadVsUi(stateWith(baseVs())).vsTextBlockedFromError({ code: 'KHAC', message: 'lỗi khác' }), null);
    assert.ok(loadVsUi(stateWith(baseVs())).vsErrorText({ code: 'VIDEO_TEXT_UNSUPPORTED_CLAIM' }).includes('CHẶN'));
  });

  test('402 INSUFFICIENT_CREDIT ⇒ hiện số CẦN và số ĐANG CÓ (không nói chung chung)', () => {
    const err = {
      status: 402,
      code: 'INSUFFICIENT_CREDIT',
      message: 'Không đủ credit.',
      payload: { details: { required: 0.0083, balance: 0, currency: 'USD' } },
    };
    const state = stateWith({ ...baseVs(), error: err });
    const ui = loadVsUi(state);

    const text = ui.vsErrorText(err);
    assert.ok(text.includes('0.0083'), `phải nêu số CẦN: ${text}`);
    assert.ok(text.includes('bạn đang có 0 USD'), `phải nêu số ĐANG CÓ: ${text}`);

    const box = ui.vsErrorBox();
    assert.ok(box.includes('0.0083') && box.includes('bạn đang có 0 USD'));
    assert.ok(box.includes('id="credit-short"'), 'phải dùng đúng khối cảnh báo credit của MVP-05');
    assert.ok(box.includes('nạp credit'), 'phải có đường nạp credit (link/hướng dẫn)');
    assert.ok(ui.vsRenderBody().includes('credit-short'), 'màn hình phải hiện khối 402');

    // Đối chứng: lỗi KHÁC 402 không được đội lốt cảnh báo credit.
    const other = stateWith({ ...baseVs(), error: { status: 500, code: 'VIDEO_FAILED', message: 'lỗi khác' } });
    assert.ok(!loadVsUi(other).vsErrorBox().includes('credit-short'));
  });

  test('encoder.is_mock ⇒ nhãn MOCK ở badge, khối cảnh báo và màn kết quả; is_mock=false ⇒ không có', () => {
    const mockState = stateWith({ ...baseVs(), encoder: { name: 'mock', is_mock: true, configured: true } });
    const mockUi = loadVsUi(mockState);
    assert.ok(mockUi.vsProviderBadges().includes('MOCK'), 'badge phải nói rõ MOCK');
    assert.ok(mockUi.vsMockNotice().includes('MOCK'), 'phải có khối cảnh báo MOCK');
    assert.ok(mockUi.vsMockNotice().includes('KHÔNG phải video thật'));
    assert.ok(mockUi.vsRenderBody().includes('MOCK'));

    // Dấu vết của JOB thắng cấu hình (F-03): encode.provider = mock + is_mock = true.
    const jobState = stateWith({
      ...baseVs(),
      job: {
        job: { id: 'j', status: 'succeeded', stage: 'done' },
        encode: { provider: 'mock', is_mock: true, configured: true, frames: 2, mime: 'image/gif' },
        rendered: [{ id: 'a', role: 'rendered', mime: 'image/gif', meta: {} }],
      },
    });
    const jobUi = loadVsUi(jobState);
    assert.equal(jobUi.vsEncoder(jobState.vs.job).is_mock, true);
    assert.equal(jobUi.vsEncoder(jobState.vs.job).name, 'mock');
    assert.ok(jobUi.vsRenderWarnings(jobState.vs.job).includes('MOCK'), 'cảnh báo phải đọc dấu vết job');
    assert.ok(jobUi.vsRenderResult(jobState.vs.job).includes('MOCK'));

    const realState = stateWith({
      ...baseVs(),
      encoder: { name: 'purejs', is_mock: false, configured: true },
      job: {
        job: { id: 'j', status: 'succeeded', stage: 'done' },
        encode: { provider: 'purejs', is_mock: false, configured: true },
        rendered: [{ id: 'a', role: 'rendered', mime: 'image/gif', meta: {} }],
      },
    });
    const realUi = loadVsUi(realState);
    assert.ok(!realUi.vsMockNotice().includes('MOCK'), 'provider thật ⇒ KHÔNG được dán nhãn MOCK');
    assert.ok(!realUi.vsProviderBadges().includes('MOCK'));
  });

  test('danh sách cảnh giữ ĐÚNG thứ tự + tổng thời lượng đúng khi đổi thời lượng + kẹp theo max_seconds', () => {
    const scenes = [
      { name: 'A.png', title: 'Ao thun', subtitle: '', seconds: 1, base64: 'AAA=' },
      { name: 'B.png', title: 'Quan jean', subtitle: '', seconds: 2, base64: 'BBB=' },
      { name: 'C.png', title: 'Giay dep', subtitle: '', seconds: 3, base64: 'CCC=' },
    ];
    const state = stateWith({ ...baseVs(), scenes });
    const ui = loadVsUi(state);

    assert.equal(ui.vsTotalSeconds(), 6, '1+2+3 = 6 giây');
    assert.equal(ui.vsTotalMs(), 6000);

    // Đổi thứ tự: cảnh #1 ⇄ #2.
    assert.equal(ui.vsMoveScene(0, 1), true);
    assert.deepEqual(state.vs.scenes.map((s) => s.name), ['B.png', 'A.png', 'C.png']);
    assert.equal(ui.vsMoveScene(0, -1), false, 'không thể vượt biên');
    assert.equal(ui.vsMoveScene(2, 1), false, 'không thể vượt biên');

    const ordered = ui.vsRenderScenes();
    assert.ok(
      ordered.indexOf('Cảnh 1') < ordered.indexOf('B.png') &&
        ordered.indexOf('B.png') < ordered.indexOf('Cảnh 2') &&
        ordered.indexOf('Cảnh 2') < ordered.indexOf('A.png') &&
        ordered.indexOf('A.png') < ordered.indexOf('Cảnh 3') &&
        ordered.indexOf('Cảnh 3') < ordered.indexOf('C.png'),
      'danh sách cảnh phải theo ĐÚNG thứ tự mảng (thứ tự người dùng chọn)',
    );

    // Kẹp theo trần preset: 999 giây ⇒ 30 giây.
    // (Sau khi đổi thứ tự, cảnh #1 là B: 30s + A 1s + C 3s = 34s.)
    const clamped = ui.vsSetSceneSeconds(0, 999);
    assert.deepEqual(clamped, { seconds: 30, clamped: true });
    assert.equal(state.vs.scenes[0].seconds, 30);
    assert.equal(ui.vsTotalSeconds(), 34, '30+1+3');
    assert.ok(ui.vsTotalHtml().includes('Tổng thời lượng: 34 giây'));
    assert.ok(ui.vsTotalHtml().includes('VƯỢT trần 30 giây'), 'tổng vượt trần ⇒ cảnh báo sẽ bị CẮT');

    // Sàn 1 giây của UI.
    assert.deepEqual(ui.vsSetSceneSeconds(1, 0.2), { seconds: 1, clamped: true });

    // Thân gửi lên API: thời lượng ĐÃ kẹp + ảnh của TỪNG cảnh đi kèm cảnh đó (§2.5 nhiều ảnh).
    const options = ui.vsJobOptions();
    assert.deepEqual(options.scenes.map((s) => s.duration_ms), [30000, 1000, 3000]);
    assert.deepEqual(options.scenes.map((s) => s.filename), ['B.png', 'A.png', 'C.png']);
    assert.deepEqual(options.scenes.map((s) => s.image.base64), ['BBB=', 'AAA=', 'CCC=']);
    const body = ui.vsJobBody();
    assert.equal(body.image.base64, 'BBB=', '`image` = ảnh của CẢNH ĐẦU (tương thích ngược §2.4)');
    assert.equal(body.options.scenes[2].image.base64, 'CCC=');

    // Cảnh mở lại từ plan có số THÔ vượt trần (45s) ⇒ UI kẹp khi hiển thị/gửi VÀ nói RÕ là đã kẹp.
    state.vs.scenes.push({ name: 'D.png', title: '', subtitle: '', seconds: 45, base64: 'DDD=' });
    assert.ok(ui.vsRenderScenes().includes('đã kẹp về 30 giây'), 'phải NÓI RÕ là đã kẹp, không im lặng');
    assert.equal(ui.vsTotalSeconds(), 64, '34 + 30 (D bị kẹp)');
    assert.equal(ui.vsJobOptions().scenes[3].duration_ms, 30000, 'gửi lên máy chủ số ĐÃ kẹp');
  });

  test('nút TẠO VIDEO KHOÁ khi chưa có ảnh (và mở khi có ảnh + preset + không bận)', () => {
    const empty = stateWith(baseVs());
    const emptyUi = loadVsUi(empty);
    assert.equal(emptyUi.vsHasImages(), false);
    assert.equal(emptyUi.vsCanCreate(), false);
    assert.ok(createButton(emptyUi.vsRenderOptions('create')).includes('disabled'), 'chưa có ảnh ⇒ nút phải KHOÁ');
    assert.ok(emptyUi.vsRenderBody().includes('Chưa có ảnh nào'));

    const withImage = stateWith({ ...baseVs(), scenes: [{ name: 'a.png', seconds: 1, base64: 'AAA=' }] });
    const readyUi = loadVsUi(withImage);
    assert.equal(readyUi.vsHasImages(), true);
    assert.equal(readyUi.vsCanCreate(), true);
    assert.ok(!createButton(readyUi.vsRenderOptions('create')).includes('disabled'), 'có ảnh ⇒ nút phải mở');

    // Đang bận ⇒ khoá lại (không cho bấm hai lần).
    const busy = stateWith({ ...baseVs(), scenes: [{ name: 'a.png', seconds: 1, base64: 'AAA=' }], busy: true });
    const busyUi = loadVsUi(busy);
    assert.equal(busyUi.vsCanCreate(), false);
    assert.ok(createButton(busyUi.vsRenderOptions('create')).includes('disabled'));

    // Chưa có preset THẬT của máy chủ ⇒ cũng khoá (UI không bịa tỉ lệ).
    const noPreset = stateWith({ presets: null, preset: null, scenes: [{ name: 'a.png', seconds: 1, base64: 'AAA=' }] });
    const noPresetUi = loadVsUi(noPreset);
    assert.equal(noPresetUi.vsCanCreate(), false);
    assert.ok(noPresetUi.vsRenderOptions('create').includes('vs-presets-error'));
  });

  test('job video đang chạy: hiện bước THẬT + nút TẠO LẠI khoá; xong thì mở', () => {
    const running = stateWith({
      ...baseVs(),
      job: { job: { id: 'j1', status: 'running', stage: 'rendering' }, rendered: [] },
    });
    const runningUi = loadVsUi(running);
    assert.equal(runningUi.vsJobRunning(running.vs.job.job), true);
    const html = runningUi.vsRenderJob();
    assert.ok(html.includes('Render từng khung'), 'phải hiện ĐÚNG nhãn bước đang chạy');
    assert.ok(/data-action="vsregen"[^>]*disabled/.test(html), 'đang chạy ⇒ nút TẠO LẠI phải khoá');

    const done = stateWith({
      ...baseVs(),
      job: { job: { id: 'j1', status: 'succeeded', stage: 'done' }, rendered: [] },
    });
    const doneUi = loadVsUi(done);
    assert.equal(doneUi.vsJobRunning(done.vs.job.job), false);
    assert.ok(!/data-action="vsregen"[^>]*disabled/.test(doneUi.vsRenderJob()), 'xong ⇒ nút TẠO LẠI mở');
  });

  test('chưa khả dụng (config.available = false) ⇒ panel nói thật + các tab khác vẫn dùng được', () => {
    const state = stateWith({}, { videostudio: vsConfigBlock({ available: false, reason: 'Không nạp được module MVP-04.' }) });
    const html = loadVsUi(state).vsRenderBody();
    assert.ok(html.includes('VIDEOSTUDIO_UNAVAILABLE'));
    assert.ok(html.includes('Không nạp được module MVP-04.'));
    assert.ok(html.includes('Các tab Nội dung / Dịch ảnh / Tạo ảnh vẫn dùng bình thường'));
  });
});
