/*
 * 佇列附件的檔案存放（只有 service worker 使用）。
 *
 * 為什麼用 IndexedDB：chrome.storage.local 沒有 unlimitedStorage 權限時只有 10MB，
 * 放不下圖片或 PDF。擴充功能自己的 IndexedDB 不需要額外權限，資料只在這台電腦上。
 *
 * 流程：
 *   1. content script 逐一把檔案送來（FILE_STAGE）→ stage()，先存成「暫存」（itemId = null）
 *   2. QUEUE_ADD 成功建立項目時 link()，把暫存檔案指向該項目
 *   3. 每次寫入佇列後 gc()：刪掉項目已不在佇列的檔案，以及太久沒被連結的暫存
 *
 * 檔案內容以 base64 字串保存（content script 與 SW 之間只能傳 JSON），
 * 讀取時原樣交回，由 content script 還原成 File。
 */
(function (root) {
  const CQ = (root.CQ = root.CQ || {});

  const DB_NAME = 'cq-files';
  const STORE = 'files';
  const STAGE_TTL_MS = 60 * 60 * 1000; // 暫存超過 1 小時沒被連結就刪除

  // ─────────── 後端：IndexedDB ───────────
  function idbBackend() {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          dbp = null;
          reject(req.error);
        };
      });
      return dbp;
    }
    function run(mode, fn) {
      return open().then(
        (db) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const store = tx.objectStore(STORE);
            let result;
            Promise.resolve(fn(store, (v) => (result = v))).catch(reject);
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
          })
      );
    }
    const reqP = (req) => new Promise((res, rej) => ((req.onsuccess = () => res(req.result)), (req.onerror = () => rej(req.error))));
    return {
      put: (rec) => run('readwrite', (s) => s.put(rec)),
      get: (id) => run('readonly', async (s, set) => set((await reqP(s.get(id))) || null)),
      delete: (ids) => run('readwrite', (s) => ids.forEach((id) => s.delete(id))),
      clear: () => run('readwrite', (s) => s.clear()),
      // 只列中繼資料（不含 data），用游標逐筆讀
      listMeta: () =>
        run('readonly', (s, set) => {
          const out = [];
          set(out);
          const req = s.openCursor();
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return;
            const { data, ...meta } = cur.value;
            out.push(meta);
            cur.continue();
          };
        })
    };
  }

  // ─────────── 後端：記憶體（Node 測試環境沒有 indexedDB） ───────────
  function memoryBackend() {
    const m = new Map();
    const copy = (v) => (v ? { ...v } : null);
    return {
      _map: m,
      async put(rec) {
        m.set(rec.id, copy(rec));
      },
      async get(id) {
        return copy(m.get(id));
      },
      async delete(ids) {
        ids.forEach((id) => m.delete(id));
      },
      async clear() {
        m.clear();
      },
      async listMeta() {
        return Array.from(m.values()).map(({ data, ...meta }) => meta);
      }
    };
  }

  let backend = typeof indexedDB === 'undefined' ? memoryBackend() : idbBackend();

  function newId() {
    return CQ.text && CQ.text.uuid ? CQ.text.uuid() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /** 存一個暫存檔案，回傳 id */
  async function stage(meta, data, now = Date.now()) {
    const rec = {
      id: newId(),
      itemId: null,
      stagedAt: now,
      name: String(meta.name || 'file').slice(0, 255),
      type: String(meta.type || 'application/octet-stream').slice(0, 128),
      size: Number(meta.size) || 0,
      lastModified: Number(meta.lastModified) || now,
      data
    };
    await backend.put(rec);
    return rec.id;
  }

  /**
   * 把暫存檔案連結到佇列項目。任何一個不存在或已被連結 → 全部不動，回傳 null。
   * @returns {Promise<Array<{fileId,name,type,size}>|null>}
   */
  async function link(stageIds, itemId) {
    const recs = [];
    for (const id of stageIds) {
      const rec = await backend.get(id);
      if (!rec || rec.itemId) return null;
      recs.push(rec);
    }
    for (const rec of recs) await backend.put({ ...rec, itemId });
    return recs.map((r) => ({ fileId: r.id, name: r.name, type: r.type, size: r.size }));
  }

  async function get(id) {
    return backend.get(id);
  }

  async function totalSize() {
    return (await backend.listMeta()).reduce((s, r) => s + (r.size || 0), 0);
  }

  /** 刪除不屬於 keepItemIds 的檔案，以及逾時的暫存。回傳刪除的數量 */
  async function gc(keepItemIds, now = Date.now()) {
    const keep = new Set(keepItemIds);
    const drop = (await backend.listMeta())
      .filter((r) => (r.itemId ? !keep.has(r.itemId) : now - (r.stagedAt || 0) > STAGE_TTL_MS))
      .map((r) => r.id);
    if (drop.length) await backend.delete(drop);
    return drop.length;
  }

  async function clear() {
    await backend.clear();
  }

  CQ.fileStore = {
    stage,
    link,
    get,
    gc,
    totalSize,
    clear,
    STAGE_TTL_MS,
    memoryBackend,
    useBackend(b) {
      backend = b;
    },
    _backend: () => backend
  };
})(globalThis);
