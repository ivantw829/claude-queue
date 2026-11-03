/*
 * 輸入框（ProseMirror 富文字編輯器）的讀取、清空、填入。
 *
 * 為什麼不能直接改 innerHTML / value：
 *   ProseMirror 以自己的 document model 為準，直接改 DOM 會被下一次重繪蓋掉，
 *   React 端的「是否可送出」狀態也不會更新（送出按鈕維持 disabled）。
 *
 * 填入策略（依序嘗試，每一步都會讀回比對，成功才停）：
 *   A. execCommand('insertText')：整段一次插入。
 *      瀏覽器會產生真實的 beforeinput/input 事件與 DOM 變更，ProseMirror 的
 *      DOMObserver 會把變更讀回 model，行為最接近使用者打字。雖然 execCommand
 *      已標示為 deprecated，Chrome 仍完整支援，且是目前唯一能產生「可信」輸入的方式。
 *   B. 逐行 insertText + insertParagraph：A 在多行文字時偶爾會把換行合併，
 *      改為每行插入後再插入段落分隔。
 *   C. 合成 paste 事件（ClipboardEvent + DataTransfer text/plain）：
 *      ProseMirror 的 paste handler 會正確解析多行文字；但 claude.ai 會把長文字
 *      貼上轉成「附件」，所以只在文字長度 ≤ 2000 字時使用。
 *   全部失敗 → 回報失敗，由 UI 提供「複製文字」讓使用者手動貼上（不會遺失內容）。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const log = CQ.logger.createLogger('editor');
  const { normalizeForCompare } = CQ.text;

  function getEditor() {
    return CQ.selectors.find('editor');
  }

  /**
   * 讀取輸入框純文字。ProseMirror 每段是一個 <p>，hard break 是 <br>。
   * innerText 會在 <p> 之間產生兩個換行，所以自己走訪。
   */
  function getText(editor = getEditor()) {
    if (!editor) return '';
    const blocks = Array.from(editor.children);
    if (blocks.length && blocks.every((b) => b.tagName === 'P')) {
      return blocks
        .map((p) => {
          if (p.querySelector('br.ProseMirror-trailingBreak') && !p.textContent) return '';
          let out = '';
          p.childNodes.forEach(function walk(node) {
            if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
            else if (node.nodeName === 'BR') {
              if (!node.classList.contains('ProseMirror-trailingBreak')) out += '\n';
            } else node.childNodes.forEach(walk);
          });
          return out;
        })
        .join('\n')
        .replace(/ /g, ' ')
        .trim();
    }
    return (editor.innerText || '').replace(/\n\n/g, '\n').trim();
  }

  function isEmpty(editor = getEditor()) {
    return !getText(editor);
  }

  function hasAttachments() {
    const composer = CQ.selectors.getComposer();
    if (!composer) return false;
    const editor = getEditor();
    return CQ.selectors.findAll('attachment', composer).some((el) => !editor || !editor.contains(el));
  }

  function selectAll(editor) {
    editor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  async function clear(editor = getEditor()) {
    if (!editor) return false;
    selectAll(editor);
    document.execCommand('delete', false);
    await tick();
    if (!isEmpty(editor)) {
      // 備援：送出 beforeinput deleteContentBackward
      selectAll(editor);
      editor.dispatchEvent(
        new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true })
      );
      await tick();
    }
    const ok = isEmpty(editor);
    if (!ok) log.warn('clear editor failed');
    return ok;
  }

  function matches(editor, text) {
    return normalizeForCompare(getText(editor)) === normalizeForCompare(text);
  }

  async function methodInsertText(editor, text) {
    selectAll(editor);
    document.execCommand('insertText', false, text);
    await tick(80);
  }

  async function methodPerLine(editor, text) {
    await clear(editor);
    editor.focus();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) document.execCommand('insertText', false, lines[i]);
      if (i < lines.length - 1) document.execCommand('insertParagraph', false);
    }
    await tick(80);
  }

  async function methodPaste(editor, text) {
    await clear(editor);
    editor.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await tick(120);
  }

  /**
   * 把文字填入輸入框（會先覆蓋原有內容）。
   * @returns {Promise<{ok: boolean, method?: string}>}
   */
  async function fill(text, editor = getEditor()) {
    if (!editor) return { ok: false, method: null };
    const methods = [
      ['insertText', methodInsertText],
      ['perLine', methodPerLine]
    ];
    if (text.length <= CQ.LIMITS.PASTE_FALLBACK_MAX_CHARS) methods.push(['paste', methodPaste]);

    for (const [name, fn] of methods) {
      try {
        await fn(editor, text);
        if (matches(editor, text)) {
          log.info('fill succeeded', { method: name, length: text.length });
          moveCaretToEnd(editor);
          return { ok: true, method: name };
        }
        log.warn('fill mismatch, trying next method', { method: name, got: getText(editor).length });
      } catch (e) {
        log.warn('fill method threw', { method: name, error: e.message });
      }
    }
    await clear(editor);
    return { ok: false, method: null };
  }

  function moveCaretToEnd(editor) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  CQ.editor = { getEditor, getText, isEmpty, hasAttachments, clear, fill };
})(globalThis);
