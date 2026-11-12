# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Claude Queue: a Chrome MV3 extension in plain JavaScript (no build step, no dependencies). When claude.ai's 5-hour or weekly usage limit is hit, it intercepts the outgoing message, stores it in a local queue, and restores it (or auto-sends it) after the quota resets. Optional "auto reset" sends a short message when a session ends so the next 5-hour session starts immediately.

The UI is Traditional Chinese (`_locales/zh_TW` is the default locale and holds every string). Communicate with the user in Traditional Chinese.

## Commands

```bash
node --test test/                                   # service worker tests (Node built-in runner)
node --test --test-name-pattern="RESTORE_RETRY" test/   # run a single test by name
for f in $(find src -name '*.js'); do node --check "$f"; done   # syntax check
python3 -m http.server 8765                         # then open http://localhost:8765/test/harness/index.html
```

- `test/sw.test.js` loads the real `service-worker.js` into a `vm` context with in-memory `chrome.*` stubs.
- `test/harness/index.html` runs the real content scripts against a fake claude.ai page with a real ProseMirror editor. Every case should show PASS at the bottom of the page.
- Load the extension in Chrome via `chrome://extensions` → Developer mode → Load unpacked (pick the repo root), then reload any open claude.ai tabs.
- `TESTING.md` has the manual checklist. It also explains how to simulate "usage full": settings page → 模擬用量已滿.

## Architecture

**Shared code via `globalThis.CQ`.** Everything is a classic script that attaches to `CQ` (`CQ.STORAGE_KEYS`, `CQ.MSG`, `CQ.settings`, `CQ.t`, …). The service worker loads `src/shared/*` with `importScripts`. Popup and options pages load them with `<script>` tags. Content scripts load in the exact order listed in `manifest.json`, and later files depend on earlier ones, so new content files must be inserted in the right position.

**Service worker is the single writer of the queue.** Every queue mutation goes through a message handler in `src/background/service-worker.js` (the `handlers` map keyed by `CQ.MSG.*`) and is serialized by the `locked()` promise mutex. Content scripts and the popup never write `queue` to storage directly. They send messages, and they read state through `chrome.storage.onChanged`.

**Restoring a queued message:**
1. `alarms` (`cq-reset-check`) fires at the reset time + 30s.
2. The SW asks a tab for usage (`USAGE_REFRESH`), then runs `markReady` → `openNext` → `openItem`.
3. `openItem` focuses or creates the tab and writes `pendingRestore`, or sends `RESTORE_START` directly to a tab that is already loaded.
4. `src/content/restore.js` runs the flow:
   - verify it is in the right conversation (`conversationKey`)
   - re-check usage
   - check for a duplicate message
   - handle a draft already in the editor
   - fill the editor
   - show the confirm bar, or a 3s countdown in auto mode
   - `QUEUE_CLAIM` (gets a token) → click send → `QUEUE_MARK_SENT` (with the token)

**Duplicate-send protection is the core invariant:**
- Sending requires a claim token.
- Sent ids are recorded in `sentIds`.
- `pendingRestore` can only be claimed once.
- Auto mode never sends to a conversation other than the item's own: it reopens the right one, or gives up and notifies.
- An "uncertain" send is marked failed and never retried.

Keep these guarantees when changing the send path.

**Queue item flags with special handling across SW, restore, and popup:**
- `draft`: never auto-sent.
- `newChatGroup` / `awaitRebind`: several messages queued on `/new` are sent in order into the conversation the first one creates.
- `restoring`: the item is assigned to a tab and must not be opened twice.
- `keepalive`: an auto-reset message. It is removed instead of being marked failed or waiting, and it is excluded from the badge and from manual `openNext`. State lives in the `keepalive` storage key: `conversationUrl`, `lastSentAt`, `lastKnownEnd`, `failCount`, `lastCheck` (shown on the options page even without debug log).

Whether to send an auto-reset message is decided by `CQ.session.keepaliveCheck()` in `src/shared/session.js`, shared by the SW, restore flow and popup. It reads only the usage API buckets, never the page's limit banner: a stale banner stays on an unrefreshed tab after the session ends, and its reset time re-parses as the next day. After a session ends the API may return `five_hour: null`, `{0, null}`, or 100% with a past `resets_at`; all count as idle (`test/keepalive.test.js` covers each).

**Usage detection** (`src/content/usage.js`) runs in the page with the user's cookies:
- `GET /api/organizations` → `/api/organizations/{uuid}/usage`, reading `five_hour` / `seven_day` `utilization` and `resets_at`.
- Falls back to scanning the page for limit text.
- Snapshots are stored in `usage` and shared by all tabs. The foreground tab polls first.

The `interceptor.js` blocking decision must be synchronous (`preventDefault`), so it relies on the latest snapshot plus the page's limit banner.

## Fragile parts (claude.ai changes)

All DOM selectors live in `src/content/selectors.js`, each as a list of fallbacks; when a selector breaks, add the new one at the front of its list. Endpoint paths and response-field aliases live in `usage.js` (`ENDPOINTS`, `FIELD_ALIASES`). Editor filling (`editor.js`) uses `execCommand('insertText')` first because ProseMirror ignores direct DOM edits. The README section "claude.ai 改版時最容易壞的地方" maps symptoms to files.

## Constraints from the original spec

- Permissions stay minimal: `storage`, `alarms`, `notifications`, host `https://claude.ai/*`.
- No external servers, no remote code, no data upload.
- Never forge or replay claude.ai's internal chat requests. Sending is always done by filling the editor and clicking the real send button.
- Only plain text is queued. Messages with attachments are left alone.
- Debug logs must not contain message content.
- New UI strings go in `_locales/zh_TW/messages.json`. They use named `{placeholder}` syntax, substituted by `CQ.t`, not chrome's `$1`.
- Commits and README credit the project as developed by Claude Opus 5.5, with the `Co-Authored-By` trailer.

`HANDOFF.md` (untracked) is a running Chinese-language log of decisions, unverified risks, and open TODOs. Read it when picking up work.
