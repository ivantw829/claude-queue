# Chrome Web Store 上架資料

這份文件整理「開發人員主控台」表單需要填的所有文字與數值，照抄貼上即可。最後更新：2026-11-03。

## 1. 基本資訊

| 欄位 | 值 |
|---|---|
| 名稱 | Claude Queue |
| 類別 (Category) | Productivity（生產力工具） |
| 語言 (Language) | 繁體中文（主要），可另外加 English |
| 版本 | 0.2.0（照 `manifest.json`） |

## 2. 單一用途說明（Single purpose）

審核表單會要求一句話說明「這個擴充功能只做一件事」。填：

> 在 claude.ai 用量達到上限時，自動保存你要送出的訊息，並在額度重置後協助你送出。
>
> (EN) Saves the message you tried to send when claude.ai's usage limit is reached, and helps you send it once your quota resets.

## 3. 簡短描述（Short description，上限 132 字元）

**繁體中文**（目前 `_locales/zh_TW/messages.json` 的 `extDescription`，可直接沿用）：

```
claude.ai 用量達上限時保存你要送出的訊息，額度重置後協助你送出。
```

**English**：

```
Saves messages you try to send when claude.ai usage is maxed out, and helps you send them after the limit resets.
```

## 4. 詳細描述（Detailed description，上限 16,000 字元）

### 繁體中文版

```
⚠️ 這是非官方的社群專案，與 Anthropic 沒有隸屬、合作或背書關係。「Claude」是 Anthropic 的商標，這裡僅用來說明本工具適用的網站。

Claude Queue 解決一個 claude.ai 重度使用者都遇過的麻煩：訊息打到一半，才發現 5 小時額度或每週額度已經用完，辛苦寫好的提示詞卡在輸入框裡，還要自己記得等一下回來重新送出。

【運作方式】
1. 當你送出訊息時，如果偵測到用量已達上限，Claude Queue 會攔下這則訊息（不會送到伺服器），存入本機佇列，並清空輸入框。
2. 額度重置後，發出桌面通知。
3. 點通知會開啟原本的對話、自動把文字填回輸入框，並顯示確認列：你可以按「送出」、「取消」（放回輸入框、不排隊），或「保留在佇列」。
4. 也可以在設定頁開啟「重置後自動送出」（預設關閉，開啟前會有明顯警告），不需要手動確認。

【特色】
- 完全在本機運作：沒有外部伺服器，不上傳任何資料，不載入遠端程式碼
- 只處理純文字訊息；含附件的訊息會照原本的方式處理，不會被攔截（並提示你）
- 用量條顯示 5 小時 session 與每週用量百分比、重置倒數
- 佇列可以直接編輯、刪除，或手動立即嘗試送出
- 支援多個 claude.ai 分頁協調，避免同一則訊息被送出兩次
- 介面為繁體中文，程式碼已預留英文介面（開發中）

【權限說明】
- storage／alarms／notifications：用於本機儲存佇列與設定、排程重置檢查、發送提醒通知
- 僅要求 https://claude.ai/* 的網站權限，不會在其他網站上執行任何動作

【隱私】
所有資料只存在你自己瀏覽器的本機儲存空間，開發者完全不會收到任何資料。詳細隱私權政策：
https://github.com/ivantw829/claude-queue/blob/main/PRIVACY.md

【原始碼與開發方式】
本專案開源（MIT 授權），原始碼與完整說明文件：
https://github.com/ivantw829/claude-queue

本專案完全由 Anthropic 的 Claude（Opus 5.5）在 Claude Code 中開發完成，作者提供需求規格。

【社群】
問題回報、功能建議請用 GitHub Issues，或加入 Discord：
https://discord.gg/yEpS7vSJtv

【已知限制】
- 只支援 claude.ai 網頁聊天（含 Projects），不支援 Claude Code、桌面 App、行動版
- 用量端點與頁面結構不是公開 API，claude.ai 改版時可能需要更新才能繼續運作
```

### English version

```
⚠️ This is an unofficial, community-built project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic, used here only to describe the site this tool works with.

Claude Queue fixes a problem every heavy claude.ai user has run into: you finish typing a message, hit send, and only then find out your 5-hour or weekly usage limit is maxed out. Your carefully written prompt is stuck in the composer, and you have to remember to come back and resend it later.

HOW IT WORKS
1. When you send a message and Claude Queue detects your usage limit has been reached, it intercepts the message (nothing is sent to any server), saves it to a local queue, and clears the composer.
2. Once your quota resets, you get a desktop notification.
3. Clicking the notification opens the original conversation, fills your text back into the composer, and shows a confirmation bar: Send, Cancel (puts the text back in the composer, removes it from the queue), or Keep in queue.
4. Optionally, enable "auto-send after reset" in settings (off by default, with a clear warning) to skip manual confirmation.

FEATURES
- Fully local: no external server, no data upload, no remote code loading
- Handles plain-text messages only; messages with attachments are left untouched (and you're notified) rather than queued
- Usage bar shows your 5-hour session and weekly usage percentage, plus a countdown to reset
- Queue items can be edited, deleted, or sent immediately on demand
- Coordinates across multiple claude.ai tabs to avoid double-sending

PERMISSIONS
- storage / alarms / notifications: used to store the queue and settings locally, schedule reset checks, and send reminder notifications
- Only requests access to https://claude.ai/*; it does not act on any other site

PRIVACY
All data stays in your own browser's local storage. The developer never receives any data. Full privacy policy:
https://github.com/ivantw829/claude-queue/blob/main/PRIVACY.md

SOURCE CODE
This project is open source (MIT license). Source and full documentation:
https://github.com/ivantw829/claude-queue

This project was built entirely by Anthropic's Claude (Opus 5.5) inside Claude Code, from requirements provided by the author.

COMMUNITY
Report issues or suggest features via GitHub Issues, or join the Discord:
https://discord.gg/yEpS7vSJtv

KNOWN LIMITATIONS
- Only supports the claude.ai web chat (including Projects); does not support Claude Code, desktop app, or mobile
- The usage endpoint and page structure are not a public API, so a claude.ai redesign may require an update before this keeps working
```

## 5. 隱私權政策網址（Privacy policy URL）

上架表單「隱私權」頁籤要填一個公開網址。先把 `PRIVACY.md` push 到 GitHub（已經是這個 repo 的一部分），填：

```
https://github.com/ivantw829/claude-queue/blob/main/PRIVACY.md
```

> 若想要更正式、渲染更好看的頁面，可以之後用 GitHub Pages 把它發佈成一個獨立網頁，但 GitHub 直接渲染 Markdown 的頁面也符合「公開可讀的隱私權政策網址」的要求。

## 6. 權限理由（Permission justification，表單會逐一要求填寫）

| 權限 | 理由（可直接貼） |
|---|---|
| `storage` | 需要在使用者本機儲存待送出的訊息佇列、用量快照與使用者設定，才能在額度重置後正確還原並送出訊息。不涉及任何伺服器端儲存。 |
| `alarms` | 需要在預估的額度重置時間排程一次檢查（並在未重置時定期重試），才能即時通知使用者，而不需要持續輪詢消耗效能。 |
| `notifications` | 用量重置或有佇列項目需要使用者確認送出時，透過桌面通知提醒使用者，這是這個擴充功能的核心功能。 |
| Host permission `https://claude.ai/*` | 擴充功能只在 claude.ai 網頁聊天上運作：需要讀取頁面上的用量資訊、攔截使用者在額度已滿時的送出動作、並在重置後把文字填回輸入框。不會存取或執行於任何其他網域。 |

## 7. 資料使用揭露（Data usage / "Are you using any of the following..." 表單）

CWS 的隱私權頁籤會問是否收集以下類別資料。因為本擴充功能**完全在本機運作、不傳送任何資料出裝置**，以下項目應全部勾選「否／不適用」：

- 個人識別資訊：否
- 健康資訊：否
- 財務與付款資訊：否
- 身分驗證資訊（密碼等）：否
- 個人通訊內容：否（訊息文字只存在本機 `chrome.storage.local`，不會被傳送出裝置）
- 網站內容：否
- 使用者活動（瀏覽紀錄、點擊等）：否
- 網站使用紀錄：否

並勾選聲明：
- 「我不會把使用者資料用於與本擴充功能核心功能無關的用途」：是
- 「我不會把使用者資料出售給第三方」：是
- 「我不會把使用者資料用於與核准用途無關的信用評分或放貸決策」：是

## 8. 截圖與圖示需求

| 素材 | 規格 | 狀態 |
|---|---|---|
| Store icon | 128×128 PNG，已有 `icons/icon128.png` | ✅ 已有，建議上架前再檢查一次邊角辨識度（見下方商標風險備註） |
| 螢幕截圖 | 1280×800 或 640×400 PNG/JPEG（不可有 alpha 透明通道），最少 1 張、最多 5 張 | ❌ 待拍攝，見下方清單 |
| 小型宣傳圖（Small tile） | 440×280，選填但建議 | ❌ 待製作 |
| 行銷橫幅（Marquee） | 1400×560，只有被 Chrome 精選時才需要 | 可先略過 |

### 建議拍攝的 5 張截圖（依優先順序）

1. **用量達上限被攔截**：claude.ai 對話頁，輸入框下方或附近顯示「已存入佇列」的 toast 提示，搭配用量已達 100% 的畫面
2. **Popup 用量條 + 佇列列表**：點擴充功能圖示，顯示 5 小時／每週用量百分比、倒數計時，以及佇列中 1-2 筆項目
3. **重置後的確認列**：還原流程跑完後，輸入框已填入文字、下方出現「送出／取消／保留在佇列」確認列
4. **設定頁**：顯示自動送出開關（含警告文字）、通知設定、輪詢頻率
5. **桌面通知**：macOS/Windows 系統通知彈出「額度已重置」的畫面截圖

> 這些都需要真的登入 claude.ai 的帳號才能拍，建議跟 HANDOFF.md 第 9 節「在真實 claude.ai 上測試」一起做。

## 9. 商標與命名風險備註

- README 已有非官方聲明（第 9 行），詳細描述文字（本文件第 4 節）也放了同樣聲明在最前面 —— 這是 Google impersonation 政策要求的「不得暗示官方授權／背書／製作」最直接的因應方式，應該保留並放在每個使用者會看到的入口（store 描述開頭、README 開頭、選項頁 footer 都已經有或建議加）。
- 名稱「Claude Queue」直接使用了 Anthropic 的商標「Claude」。Google 的 impersonation 政策條文本身沒有明文禁止在名稱中使用第三方商標，重點在「是否暗示官方關係」；但這類名稱仍可能被 Anthropic 以商標申訴方式要求下架（Google 有提供 DMCA/商標申訴管道），風險無法完全排除。
- 圖示目前是橘色底＋放大鏡圖案（`icons/icon128.png`），橘色與 Anthropic 的品牌色系相近，但圖形本身不是 Anthropic 的 logo，整體仍算是低風險的原創圖示。
- **建議**：先以目前名稱＋明確非官方聲明送審；若被 Chrome Web Store 或 Anthropic 要求修改，備用方案是改名為不含「Claude」的名稱（例如「Queue Helper for AI Chat」「額度排隊小幫手」），並在描述裡改用「適用於 claude.ai」的說法。不建議現在就預防性改名，因為目前的聲明已經符合 Google 政策字面要求，等實際收到異議再改成本更低。
