(() => {
  'use strict';

  // 1. Theme Toggle (Light / Dark with system preference fallback)
  const root = document.documentElement;
  const themeBtn = document.getElementById('theme-toggle');
  const THEME_KEY = 'claude-queue-docs-theme';

  function getPreferredTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    if (themeBtn) {
      themeBtn.setAttribute('aria-label', theme === 'dark' ? '切換至淺色模式' : '切換至深色模式');
      themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
  }

  applyTheme(getPreferredTheme());

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });
  }

  // 2. Mobile Navigation Menu
  const menuBtn = document.getElementById('mobile-menu-btn');
  const navLinks = document.getElementById('nav-links');
  if (menuBtn && navLinks) {
    menuBtn.addEventListener('click', () => {
      const isOpen = navLinks.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', String(isOpen));
    });
    navLinks.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        navLinks.classList.remove('open');
        menuBtn.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // 3. Interactive Hero Simulator (Queued -> Reset Ready -> Sent)
  const simBtns = document.querySelectorAll('[data-sim-state]');
  const simStatusPill = document.getElementById('sim-status-pill');
  const simSessionPct = document.getElementById('sim-session-pct');
  const simSessionBar = document.getElementById('sim-session-bar');
  const simSessionSub = document.getElementById('sim-session-sub');
  const simQueueItem = document.getElementById('sim-queue-item');
  const simBadge = document.getElementById('sim-badge');
  const simActionBtn = document.getElementById('sim-action-btn');
  const simToastText = document.getElementById('sim-toast-text');

  const SIM_STATES = {
    full: {
      pillText: '已達上限',
      pillClass: 'sim-status-pill full',
      pct: '100%',
      barWidth: '100%',
      barClass: 'sim-fill full',
      sub: '預計 18:30 重置（剩餘 24 分鐘）',
      itemReady: false,
      badgeText: '等待重置',
      badgeClass: 'sim-badge waiting',
      actionText: '立即嘗試',
      toast: '<strong>已排入佇列：</strong>確認存檔成功，將於 18:30 重置後通知你。',
    },
    ready: {
      pillText: '額度已恢復',
      pillClass: 'sim-status-pill ready',
      pct: '0%',
      barWidth: '4%',
      barClass: 'sim-fill ok',
      sub: '5 小時工作階段已重置，可開始送出',
      itemReady: true,
      badgeText: '可送出',
      badgeClass: 'sim-badge ready',
      actionText: '開啟原對話並填回',
      toast: '<strong>🔔 桌面通知：</strong>Claude 額度已重置！點擊自動填回文字與附件。',
    },
    sent: {
      pillText: '運作正常',
      pillClass: 'sim-status-pill ready',
      pct: '8%',
      barWidth: '8%',
      barClass: 'sim-fill accent',
      sub: '新工作階段倒數中（4 小時 59 分後重置）',
      itemReady: false,
      badgeText: '已送出',
      badgeClass: 'sim-badge sent',
      actionText: '重新示範',
      toast: '<strong>✓ 送出完成：</strong>已確認訊息出現在對話中，並清除本機暫存附件。',
    },
  };

  function setSimState(stateKey) {
    const s = SIM_STATES[stateKey];
    if (!s) return;
    simBtns.forEach((b) => b.classList.toggle('active', b.dataset.simState === stateKey));
    if (simStatusPill) {
      simStatusPill.textContent = s.pillText;
      simStatusPill.className = s.pillClass;
    }
    if (simSessionPct) simSessionPct.textContent = s.pct;
    if (simSessionBar) {
      simSessionBar.style.width = s.barWidth;
      simSessionBar.className = s.barClass;
    }
    if (simSessionSub) simSessionSub.textContent = s.sub;
    if (simQueueItem) simQueueItem.classList.toggle('is-ready', s.itemReady);
    if (simBadge) {
      simBadge.textContent = s.badgeText;
      simBadge.className = s.badgeClass;
    }
    if (simActionBtn) {
      simActionBtn.textContent = s.actionText;
      simActionBtn.dataset.nextState =
        stateKey === 'full' ? 'ready' : stateKey === 'ready' ? 'sent' : 'full';
    }
    if (simToastText) simToastText.innerHTML = s.toast;
  }

  simBtns.forEach((btn) => {
    btn.addEventListener('click', () => setSimState(btn.dataset.simState));
  });

  if (simActionBtn) {
    simActionBtn.addEventListener('click', () => {
      setSimState(simActionBtn.dataset.nextState || 'ready');
    });
  }

  // 4. Installation Method Tabs
  const tabBtns = document.querySelectorAll('[data-tab]');
  const tabPanels = document.querySelectorAll('[data-tab-panel]');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach((b) => {
        const active = b.dataset.tab === target;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      });
      tabPanels.forEach((p) => {
        p.classList.toggle('active', p.dataset.tabPanel === target);
      });
    });
  });

  // 5. Copy-to-Clipboard Buttons
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = '已複製 ✓';
        setTimeout(() => {
          btn.textContent = orig;
        }, 1600);
      } catch {
        // Fallback for older browsers
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        const orig = btn.textContent;
        btn.textContent = '已複製 ✓';
        setTimeout(() => {
          btn.textContent = orig;
        }, 1600);
      }
    });
  });
})();
