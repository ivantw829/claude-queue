/*
 * ⚠️ claude.ai 改版時可能需要修改的檔案。
 *
 * 自動重設送出前，把專用對話的模型切到設定的模型與投入程度（例如 Haiku／中），
 * 避免用上次的 Opus 送一則只是用來開始工作階段的訊息。
 *
 * 只操作頁面上的模型選單（和你自己點選一樣），不改任何請求。
 * 2026-11 實測：
 *  - 在既有對話切換只影響該對話（之後打開仍是 Haiku，下次就不用再切）；
 *    在新對話（/new）切換會改到全域預設模型，所以呼叫端在 /new 不切換。
 *  - 選單是 Base UI，需要完整的 pointer/mouse 事件序列才會打開。
 *  - 新對話頁的主選單直接列出主要模型；既有對話的主選單只有目前模型，其餘在「更多模型」子選單。
 *  - 投入程度子選單的選項依序為 低、中、高、超高、最高（用位置對應，不依介面語言）。
 * 任何一步找不到都只回報失敗，由呼叫端決定（自動重設會照樣用目前模型送出）。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});
  const log = CQ.logger.createLogger('model');

  const MODELS = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const MODEL_NAME_RE = /\b(haiku|sonnet|opus|fable)\b/i;
  const STEP_TIMEOUT_MS = 3000;
  const SETTLE_MS = 800;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = STEP_TIMEOUT_MS) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(100);
    }
  }

  /** Base UI 的選單只認完整的指標事件序列 */
  function press(el) {
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: 1,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      view: window
    };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new P('pointerdown', ptr));
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new P('pointerup', { ...ptr, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
  }

  const menus = () => Array.from(document.querySelectorAll('[role="menu"]'));
  const radios = (menu) => Array.from(menu.querySelectorAll('[role="menuitemradio"]'));
  const submenuTriggers = (menu) =>
    Array.from(menu.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]'));
  const textOf = (el) => (el.textContent || '').trim();

  function trigger() {
    return CQ.selectors.find('modelSelector');
  }

  function label() {
    const t = trigger();
    return t ? t.getAttribute('aria-label') || textOf(t) : '';
  }

  /** 目前選單按鈕顯示的模型是不是目標模型（例如 "模型：Haiku 5.5 中"） */
  function isCurrent(model) {
    return new RegExp('\\b' + MODELS[model] + '\\b', 'i').test(label());
  }

  async function closeMenus() {
    for (let i = 0; i < 3 && menus().length; i++) {
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await sleep(150);
    }
    if (menus().length && trigger()) press(trigger());
    await waitFor(() => !menus().length, 1000);
  }

  async function openMenu() {
    const t = trigger();
    if (!t) return null;
    if (!menus().length) press(t);
    return waitFor(() => menus()[0] || null);
  }

  /** 打開子選單，回傳新出現的選單 */
  async function openSubmenu(item) {
    const before = new Set(menus());
    press(item);
    return waitFor(() => menus().find((m) => !before.has(m)) || null);
  }

  /** 模型項目：名稱開頭符合，且是可選的 menuitemradio（Fable 等需要點數的項目是 menuitem，不會選到） */
  function findModelItem(menu, model) {
    const re = new RegExp('^' + MODELS[model] + '\\b', 'i');
    return radios(menu).find((e) => re.test(textOf(e)) && e.getAttribute('aria-disabled') !== 'true') || null;
  }

  async function selectModel(model) {
    const main = await openMenu();
    if (!main) return 'menu-not-opened';
    let item = findModelItem(main, model);
    if (!item) {
      // 既有對話：其他模型在「更多模型」子選單裡（子選單的項目是模型名稱）
      for (const sub of submenuTriggers(main)) {
        const m = await openSubmenu(sub);
        if (!m) continue;
        if (radios(m).some((e) => MODEL_NAME_RE.test(textOf(e)))) {
          item = findModelItem(m, model);
          break;
        }
      }
    }
    if (!item) {
      await closeMenus();
      return 'model-not-found';
    }
    press(item);
    const ok = await waitFor(() => !menus().length && isCurrent(model));
    if (!ok) {
      await closeMenus();
      return isCurrent(model) ? null : 'model-not-applied';
    }
    return null;
  }

  async function selectEffort(effort) {
    const index = EFFORTS.indexOf(effort);
    const main = await openMenu();
    if (!main) return 'menu-not-opened';
    // 投入程度子選單：選項不是模型名稱、而且剛好是 5 個等級
    let options = null;
    for (const sub of submenuTriggers(main)) {
      const m = await openSubmenu(sub);
      if (!m) continue;
      const r = radios(m);
      if (r.length === EFFORTS.length && !r.some((e) => MODEL_NAME_RE.test(textOf(e)))) {
        options = r;
        break;
      }
    }
    if (!options) {
      await closeMenus();
      return 'effort-not-found';
    }
    const target = options[index];
    if (target.getAttribute('aria-checked') === 'true') {
      await closeMenus();
      return null;
    }
    if (target.getAttribute('aria-disabled') === 'true') {
      await closeMenus();
      return 'effort-unavailable';
    }
    press(target);
    await waitFor(() => !menus().length, STEP_TIMEOUT_MS);
    if (menus().length) await closeMenus();
    return null;
  }

  /**
   * 把模型與投入程度切到指定值。
   * @param {{model: 'none'|'haiku'|'sonnet'|'opus', effort: 'none'|'low'|'medium'|'high'|'xhigh'|'max'}} want
   * @returns {Promise<{ok: boolean, changed: boolean, reason?: string}>}
   */
  async function ensure({ model = 'none', effort = 'none' } = {}) {
    const wantModel = MODELS[model] ? model : 'none';
    const wantEffort = EFFORTS.includes(effort) ? effort : 'none';
    if (wantModel === 'none' && wantEffort === 'none') return { ok: true, changed: false, reason: 'off' };
    if (!trigger()) {
      log.warn('model selector not found');
      return { ok: false, changed: false, reason: 'no-selector' };
    }
    let changed = false;
    try {
      if (wantModel !== 'none' && !isCurrent(wantModel)) {
        const err = await selectModel(wantModel);
        if (err) {
          log.warn('model switch failed', { reason: err, model: wantModel });
          return { ok: false, changed: false, reason: err };
        }
        changed = true;
      }
      if (wantEffort !== 'none') {
        const err = await selectEffort(wantEffort);
        if (err) {
          log.warn('effort switch failed', { reason: err, effort: wantEffort });
          return { ok: false, changed, reason: err };
        }
      }
      // 2026-11 實測：切換後按鈕文字可能短暫顯示舊模型，等它穩定再確認一次
      if (changed) {
        await sleep(SETTLE_MS);
        if (!(await waitFor(() => isCurrent(wantModel)))) {
          log.warn('model switch did not stick', { model: wantModel });
          return { ok: false, changed, reason: 'model-not-applied' };
        }
      }
    } catch (e) {
      log.warn('model switch error', { error: e.message });
      await closeMenus().catch(() => {});
      return { ok: false, changed, reason: 'error' };
    }
    log.info('model ready', { model: wantModel, effort: wantEffort, changed });
    return { ok: true, changed };
  }

  CQ.model = { ensure, label, MODELS, EFFORTS };
})(globalThis);
