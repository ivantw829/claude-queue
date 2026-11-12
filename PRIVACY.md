# Claude Queue 隱私權政策 / Privacy Policy

最後更新 / Last updated：2026-11-12

> 本頁同時提供繁體中文與英文版本，供 Chrome Web Store 審核與使用者參考。
> This page provides both Traditional Chinese and English versions for Chrome Web Store review and user reference.

---

## 繁體中文

### 本擴充功能是什麼

Claude Queue 是一個非官方的社群 Chrome 擴充功能，用於 claude.ai 網頁聊天。當你的用量（5 小時 session 或每週額度）達到上限時，它會攔下你要送出的訊息（文字與你加入的附件）、存入本機佇列，並在額度重置後提醒你送出。

本專案與 Anthropic 沒有隸屬、合作或背書關係。「Claude」是 Anthropic 的商標，這裡僅用於說明本工具適用的網站。

### 我們收集哪些資料

**我們（開發者）完全不收集任何資料。** 本擴充功能沒有自己的伺服器，不會把任何資料傳送給開發者或任何第三方。

擴充功能會在**你自己的瀏覽器裝置上**，使用 Chrome 的 `storage.local` API 儲存以下內容，僅供擴充功能本身運作使用：

| 資料 | 用途 | 儲存位置 |
|---|---|---|
| 你排入佇列的訊息文字 | 額度重置後自動填回輸入框 | 本機 `chrome.storage.local` |
| 你排入佇列的訊息附件（檔案內容、檔名、類型、大小） | 額度重置後透過 claude.ai 頁面的上傳按鈕加回輸入框 | 本機擴充功能的 IndexedDB；訊息送出或刪除時一併刪除 |
| claude.ai 回報的用量百分比與重置時間 | 顯示用量條、判斷何時可以送出 | 本機 `chrome.storage.local` |
| 你的設定（是否自動送出、通知開關、輪詢頻率等） | 記住你的偏好 | 本機 `chrome.storage.local` |
| 除錯紀錄（事件名稱、項目 id、文字長度、狀態） | 協助你自行除錯；**不含訊息內容** | 本機 `chrome.storage.local`，最多 500 筆，可在設定頁清除 |

### 資料如何被使用、是否會離開你的裝置

- 擴充功能發出的網路請求只有兩種，都不會呼叫分析服務、不會送出你的任何資料：
  1. 向 `claude.ai` 自身查詢用量的 **同源 GET 請求**（使用你既有的登入狀態）。
  2. **新版本檢查**：只有從 GitHub 原始碼安裝（開發人員模式）時，每天一次讀取 GitHub 上公開的 `manifest.json`（`raw.githubusercontent.com`）比較版本號。這是不帶任何參數、不帶 cookie 的 GET 請求；GitHub 只會看到一般網路請求都有的 IP 位址與瀏覽器資訊。可在設定頁「更新」關閉；從 Chrome 線上應用程式商店安裝時完全不會發出這個請求。
- 擴充功能只會在你按下「送出」、且系統判斷「用量已達上限」時，才讀取輸入框的文字內容，用途僅限於存入佇列。
- 為了判斷訊息是否已成功送出、避免重複送出，擴充功能會在本機比對目前對話中**你自己最近幾則訊息**的文字；這項比對只在本機進行，結果不會被保存成可識別的紀錄，也不會傳送到任何地方。
- 所有資料都留在 `chrome.storage.local` 與擴充功能自己的 IndexedDB，不會同步到 Google 帳號、不會上傳到任何伺服器、不會賣給或分享給第三方、不會用於廣告或與本擴充功能無關的目的。

### 權限使用說明

| 權限 | 用途 |
|---|---|
| `storage` | 在本機儲存佇列、用量快照、設定與除錯紀錄 |
| `alarms` | 排程「額度重置時間＋30 秒」的檢查，確認是否真的重置 |
| `notifications` | 額度重置、需要你確認送出等情況發送桌面通知 |
| Host 權限：`https://claude.ai/*` | 讀取頁面上的用量資訊、填入與送出佇列中的訊息；不會用於其他網站 |

### 你的控制權

- 設定頁提供「清除所有資料」，會立即刪除佇列、快照、設定與除錯紀錄。
- 移除擴充功能會刪除 Chrome 為它保留的所有本機資料。
- 你可以隨時在佇列中編輯或刪除個別項目。

### 政策異動

若本政策有重大變更（例如開始收集新類型的資料），會更新本頁面的「最後更新」日期，並在擴充功能更新說明中註明。

---

## English

### What this extension is

Claude Queue is an unofficial, community-built Chrome extension for the claude.ai web chat. When your usage limit (5-hour session or weekly quota) is reached, it intercepts the message you were about to send (its text and any files you attached), stores it in a local queue, and reminds you to send it once your quota resets.

This project is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic, used here only to describe the site this tool works with.

### What data we collect

**We (the developer) do not collect any data at all.** The extension has no server of its own and never transmits any data to the developer or any third party.

The extension stores the following, locally on your own browser device, using Chrome's `storage.local` API, solely so the extension itself can function:

| Data | Purpose | Where it's stored |
|---|---|---|
| The text of messages you queue | Auto-filled back into the composer after your quota resets | Local `chrome.storage.local` |
| Files attached to messages you queue (content, name, type, size) | Re-attached through claude.ai's own upload control after your quota resets | The extension's local IndexedDB; deleted when the message is sent or removed |
| Usage percentages and reset times reported by claude.ai | Shown in the usage bar; used to decide when sending is allowed | Local `chrome.storage.local` |
| Your settings (auto-send toggle, notification toggle, polling interval, etc.) | Remembers your preferences | Local `chrome.storage.local` |
| Debug log (event name, item id, text length, status) | Lets you debug issues yourself; **never includes message content** | Local `chrome.storage.local`, capped at 500 entries, clearable from the options page |

### How data is used, and whether it ever leaves your device

- The extension makes only two kinds of network requests. Neither calls an analytics service, and neither sends any of your data:
  1. A **same-origin GET request to claude.ai itself**, to read your usage (using your existing login session).
  2. **New-version check**: only when installed from the GitHub source (developer mode), once a day it reads the public `manifest.json` on GitHub (`raw.githubusercontent.com`) to compare version numbers. It is a GET request with no parameters and no cookies; GitHub only sees what any web request carries (IP address and browser information). It can be turned off under "Update" in settings, and it is never made when installed from the Chrome Web Store.
- The extension only reads the text in the composer when you press send and the system determines your usage limit has been reached — solely to store it in the queue.
- To confirm a message was actually sent and to avoid duplicate sends, the extension compares the text of **your own most recent messages** in the current conversation, locally on your device. This comparison happens only on-device; the result is not kept as an identifiable record and is never transmitted anywhere.
- All data stays in `chrome.storage.local` and the extension's own IndexedDB: it is never synced to your Google account, never uploaded to any server, never sold or shared with third parties, and never used for advertising or any purpose unrelated to the extension's function.

### Permissions

| Permission | Why it's needed |
|---|---|
| `storage` | Store the queue, usage snapshot, settings, and debug log locally |
| `alarms` | Schedule a check at "reset time + 30 seconds" to confirm the quota actually reset |
| `notifications` | Notify you when your quota resets or when a queued message needs your confirmation to send |
| Host permission: `https://claude.ai/*` | Read usage info from the page, and fill/send your queued message; not used on any other site |

### Your controls

- The options page has a "clear all data" action that immediately deletes the queue, usage snapshot, settings, and debug log.
- Removing the extension deletes all local data Chrome kept for it.
- You can edit or delete individual queued items at any time.

### Changes to this policy

If this policy changes materially (e.g. a new category of data begins being collected), the "Last updated" date above will change, and the update will be noted in the extension's release notes.

---

**聯絡方式 / Contact：** 請透過 GitHub Issues 回報問題或疑問 / Please use GitHub Issues to report questions or concerns:
<https://github.com/ivantw829/claude-queue/issues>
