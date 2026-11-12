/*
 * ⚠️ 依賴 claude.ai 的附件 DOM（選擇器在 selectors.js 的 attachmentItem / attachmentRemove /
 *    attachmentUploading / fileInput）。
 *
 * 附件排隊：
 *   - 捕捉：在 capture 階段記下你「親手」加入的檔案（選檔、拖放、貼上圖片）。只記錄 isTrusted 的事件，
 *     所以還原時我們自己觸發的事件不會被記錄。頁面上看不到 File 物件，只能在加入的當下記住。
 *   - collect()：攔截送出時，把輸入區的附件卡片與記下的檔案一一對應。
 *     對不上（例如 Google Drive 附件、長文字貼上轉成的附件、擴充功能載入前就加入的檔案）就回報失敗，
 *     由 interceptor 照原本行為放行，不冒險排一則少了附件的訊息。
 *   - attach()：還原時用頁面上真正的 <input type="file"> 把檔案加回去（備援：合成拖放），
 *     並等到上傳完成。不偽造任何 claude.ai 的請求。
 *
 * debug log 只記數量與大小，不記檔名與內容。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const log = CQ.logger.createLogger('attachments');
  const { TIMING, LIMITS } = CQ;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 你加入的檔案（依加入順序） */
  let tracked = [];

  function scope() {
    return CQ.selectors.getComposer() || document;
  }

  // ─────────── 輸入區的附件卡片 ───────────

  /** 合併所有候選選擇器的結果，只留最內層、不在輸入框內、不是按鈕或 input 的元素 */
  function items() {
    const sc = scope();
    const editor = CQ.editor.getEditor();
    const found = new Set();
    for (const sel of CQ.selectors.SELECTORS.attachmentItem) {
      let els = [];
      try {
        els = Array.from(sc.querySelectorAll(sel));
      } catch (_) {}
      for (const el of els) {
        if (el.closest('button, input')) continue;
        if (editor && editor.contains(el)) continue;
        found.add(el);
      }
    }
    const all = Array.from(found);
    const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
    if (inner.length) return sortByDom(inner);
    // 備援：一個附件一個「移除」按鈕
    return sortByDom(
      CQ.selectors.findAll('attachmentRemove', sc).filter((b) => !editor || !editor.contains(b))
    );
  }

  function sortByDom(els) {
    return els.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  function count() {
    return items().length;
  }

  function uploading() {
    const sc = scope();
    const editor = CQ.editor.getEditor();
    return CQ.selectors.findAll('attachmentUploading', sc).some((el) => !editor || !editor.contains(el));
  }

  function labelOf(el) {
    const parts = [el.textContent || '', el.getAttribute('title') || '', el.getAttribute('aria-label') || ''];
    el.querySelectorAll('[title], [aria-label], img[alt]').forEach((x) => {
      parts.push(x.getAttribute('title') || '', x.getAttribute('aria-label') || '', x.getAttribute('alt') || '');
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** 卡片上的文字是否指向這個檔名（claude.ai 可能截斷長檔名，所以也比對去掉副檔名的開頭） */
  function nameMatches(label, name) {
    if (!label || !name) return false;
    const n = name.toLowerCase();
    if (label.includes(n)) return true;
    const base = n.replace(/\.[^.]+$/, '');
    return base.length >= 6 && label.includes(base.slice(0, 20));
  }

  const looksLikeFileName = (label) => /[^\s/\\]+\.[a-z0-9]{1,5}\b/i.test(label);

  // ─────────── 捕捉你加入的檔案 ───────────

  function record(fileList, via) {
    const files = Array.from(fileList || []).filter((f) => f instanceof File);
    if (!files.length) return;
    // 輸入區原本沒有附件 → 先前記下的都已經送出或移除了
    if (count() === 0) tracked = [];
    tracked.push(...files);
    log.debug('files tracked', { via, added: files.length, total: tracked.length });
  }

  function onChange(e) {
    if (!e.isTrusted) return;
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'file') record(t.files, 'input');
  }

  function onDrop(e) {
    if (!e.isTrusted || !e.dataTransfer) return;
    record(e.dataTransfer.files, 'drop');
  }

  function onPaste(e) {
    if (!e.isTrusted || !e.clipboardData) return;
    if (!CQ.selectors.closestEditor(e.target)) return;
    record(e.clipboardData.files, 'paste');
  }

  function reset() {
    tracked = [];
  }

  /**
   * 同步取得輸入區附件對應的檔案（interceptor 必須在事件當下決定是否攔截）。
   * @returns {{ok: true, files: File[]} | {ok: false, reason: 'untracked'|'too-large'|'too-many'}}
   */
  function collect() {
    const cards = items();
    if (!cards.length) return { ok: true, files: [] };
    if (cards.length > LIMITS.MAX_FILES_PER_ITEM) return { ok: false, reason: 'too-many' };

    const pool = tracked.slice();
    const out = new Array(cards.length);
    const labels = cards.map(labelOf);
    // 1. 卡片上看得到檔名 → 依檔名對應
    labels.forEach((lbl, i) => {
      const k = pool.findIndex((f) => nameMatches(lbl, f.name));
      if (k >= 0) out[i] = pool.splice(k, 1)[0];
    });
    // 2. 剩下的（例如只有縮圖的圖片）→ 數量剛好相同才依順序對應；卡片上寫著別的檔名就不是我們記下的
    const rest = [];
    for (let i = 0; i < cards.length; i++) if (!out[i]) rest.push(i);
    if (rest.length) {
      if (pool.length !== rest.length || rest.some((i) => looksLikeFileName(labels[i]))) {
        log.info('attachments not matched', { cards: cards.length, tracked: tracked.length });
        return { ok: false, reason: 'untracked' };
      }
      rest.forEach((i, j) => (out[i] = pool[j]));
    }
    if (out.some((f) => f.size > LIMITS.MAX_FILE_BYTES)) return { ok: false, reason: 'too-large' };
    return { ok: true, files: out };
  }

  // ─────────── 存進佇列 / 從佇列取回 ───────────

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || '');
        resolve(s.slice(s.indexOf(',') + 1));
      };
      r.onerror = () => reject(r.error || new Error('read failed'));
      r.readAsDataURL(file);
    });
  }

  /** 逐一交給 SW 暫存，回傳 stage id 陣列；失敗回傳 { error } */
  async function stageAll(files) {
    const ids = [];
    for (const f of files) {
      const data = await readBase64(f);
      const res = await CQ.bg.send(CQ.MSG.FILE_STAGE, {
        file: { name: f.name, type: f.type, size: f.size, lastModified: f.lastModified, data }
      });
      if (!res || !res.ok) return { error: (res && res.error) || 'stage-failed' };
      ids.push(res.id);
    }
    return { ids };
  }

  function base64ToFile(rec) {
    const bin = atob(rec.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], rec.name, { type: rec.type, lastModified: rec.lastModified });
  }

  /** 取回佇列項目的附件。任何一個缺少 → { ok: false } */
  async function load(item) {
    const files = [];
    for (const a of item.attachments || []) {
      let res = null;
      try {
        res = await CQ.bg.send(CQ.MSG.FILE_GET, { id: item.id, fileId: a.fileId });
      } catch (_) {}
      if (!res || !res.ok || !res.file) return { ok: false };
      files.push(base64ToFile(res.file));
    }
    return { ok: true, files };
  }

  // ─────────── 加回輸入區 ───────────

  async function waitFor(fn, timeoutMs, interval = 200) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (fn()) return true;
      await sleep(interval);
    }
    return fn();
  }

  function findFileInput() {
    const sc = scope();
    return (sc !== document && CQ.selectors.find('fileInput', sc)) || CQ.selectors.find('fileInput');
  }

  function viaInput(files) {
    const input = findFileInput();
    if (!input) return false;
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function viaDrop(files) {
    const target = CQ.editor.getEditor() || scope();
    if (!target || target === document) return false;
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    return true;
  }

  /** 附件數到齊且沒有上傳中 */
  function ready(expected) {
    return count() >= expected && !uploading();
  }

  /**
   * 把檔案加回輸入區並等上傳完成。
   * @returns {Promise<{ok: boolean, reason?: string, added?: number}>}
   */
  async function attach(files) {
    if (!files.length) return { ok: true };
    const before = count();
    const expected = before + files.length;
    let method = null;
    try {
      if (viaInput(files)) method = 'input';
    } catch (e) {
      log.warn('attach via input threw', { error: e.message });
    }
    let appeared = method && (await waitFor(() => count() >= expected, TIMING.ATTACH_APPEAR_WAIT_MS));
    // 一個都沒加進去才改用拖放（加了一部分再拖放會重複）
    if (!appeared && count() === before) {
      try {
        if (viaDrop(files)) method = 'drop';
      } catch (e) {
        log.warn('attach via drop threw', { error: e.message });
      }
      appeared = await waitFor(() => count() >= expected, TIMING.ATTACH_APPEAR_WAIT_MS);
    }
    const added = count() - before;
    if (!appeared) {
      log.warn('attach failed', { expected: files.length, added, method });
      return { ok: false, reason: 'not-attached', added };
    }
    // 上傳完成：附件數到齊、沒有上傳中的指示，且維持 0.5 秒
    const end = Date.now() + TIMING.ATTACH_UPLOAD_WAIT_MS;
    let stableSince = 0;
    while (Date.now() < end) {
      if (ready(expected)) {
        if (!stableSince) stableSince = Date.now();
        else if (Date.now() - stableSince >= 500) {
          log.info('attachments ready', { count: files.length, method });
          return { ok: true, added };
        }
      } else stableSince = 0;
      await sleep(200);
    }
    log.warn('attachment upload timeout', { expected: files.length, added });
    return { ok: false, reason: 'upload-timeout', added };
  }

  /** 點每張卡片的移除按鈕，讓輸入區恢復乾淨。回傳是否全部移除 */
  async function removeAll() {
    for (let round = 0; round < 3 && count() > 0; round++) {
      const editor = CQ.editor.getEditor();
      const sc = scope();
      const btns = CQ.selectors
        .findAll('attachmentRemove', sc)
        .filter((b) => !editor || !editor.contains(b));
      if (!btns.length) break;
      for (const b of btns) {
        b.click();
        await sleep(60);
      }
      await waitFor(() => count() === 0, 1500);
    }
    const ok = count() === 0;
    if (ok) reset();
    else log.warn('remove attachments failed', { left: count() });
    return ok;
  }

  /** 手動備援：讓你把附件存到電腦，再自己加入 */
  function download(files) {
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.style.display = 'none';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    }
  }

  function install() {
    window.addEventListener('change', onChange, true);
    window.addEventListener('drop', onDrop, true);
    window.addEventListener('paste', onPaste, true);
  }

  CQ.attachments = {
    install,
    reset,
    count,
    uploading,
    ready,
    collect,
    stageAll,
    load,
    attach,
    removeAll,
    download,
    // 測試頁用（合成事件不是 isTrusted，無法走正常的捕捉路徑）
    _record: record,
    _tracked: () => tracked.slice()
  };
})(globalThis);
