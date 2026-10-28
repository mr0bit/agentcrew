// AgentCrew Dashboard Application Script
document.addEventListener('DOMContentLoaded', () => {
  const analyticsData = window.agentCrewAnalyticsData || {
    people: [],
    ranges: [],
    kpis: { week: [], month: [] },
    activity: { week: { labels: [], series: {}, lines: {} }, month: { labels: [], series: {}, lines: {} } },
    repositories: [],
    pullRequests: []
  };

  const statusEl = document.getElementById('connection-status');
  const teamRoomGrid = document.getElementById('team-room-grid');
  const providerBadges = document.getElementById('provider-badges');
  const terminal = document.getElementById('takeover-terminal-log');
  const terminalEmulator = document.getElementById('takeover-terminal-emulator');
  const mobileKeys = document.getElementById('terminal-mobile-keys');
  const terminalAlert = document.getElementById('agent-terminal-alert');
  const backupFeedback = document.getElementById('agent-backup-feedback');
  const btnTakeover = document.getElementById('btn-takeover');
  const btnRelease = document.getElementById('btn-release');
  const agentSelect = document.getElementById('takeover-agent-select');
  const takeoverTokens = new Map();
  try {
    Object.entries(JSON.parse(sessionStorage.getItem('agentcrew.takeoverTokens') || '{}')).forEach(([agent, token]) => takeoverTokens.set(agent, token));
  } catch (_) {}
  function persistTakeoverTokens() {
    try { sessionStorage.setItem('agentcrew.takeoverTokens', JSON.stringify(Object.fromEntries(takeoverTokens))); } catch (_) {}
  }
  const stateBadge = document.getElementById('takeover-state-badge');
  const agentSearchInput = document.getElementById('agent-search');
  const agentRosterCount = document.getElementById('agent-roster-count');
  const agentStatusSummary = document.getElementById('agent-status-summary');
  const agentFilterButtons = document.querySelectorAll('.agent-filter[data-agent-filter]');
  const roomMapView = document.getElementById('room-map-view');
  const teamRoomView = document.getElementById('view-team-room');
  const teamRoomChatFeed = document.getElementById('team-room-chat-feed');
  const teamChatInput = document.getElementById('team-chat-input');
  const btnSendChat = document.getElementById('btn-send-chat');
  const tabBtnTerminal = document.getElementById('tab-btn-terminal');
  const tabBtnChat = document.getElementById('tab-btn-chat');
  const panelTerminalView = document.getElementById('panel-terminal-view');
  const panelChatView = document.getElementById('panel-chat-view');
  let liveAgents = [];
  let selectedAgentName = '';
  let inFlightAgentName = '';
  let activeAgentFilter = 'all';
  let aiOrb = null;
  window.agentCrewOrb = null;
  let currentProjectId = '';
  let isPromptInFlight = false;
  let promptAbortController = null;
  const renderedMessageIds = new Set();
  let feedRequestSeq = 0;
  let cachedTasks = [];
  let pendingIndicatorEl = null;

  function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatToolChatText(text) {
    if (!text) return '';
    const lines = text.split('\n');
    let html = '';
    let inTool = false;
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('●') || trimmed.startsWith('Tool:') || trimmed.startsWith('Edit(') || trimmed.startsWith('Write(')) {
        if (inTool) html += '</div>';
        const cleanHeader = escapeHtml(trimmed.replace(/^[●\s]+/, ''));
        html += `<div class="tool-call-card"><div class="tool-call-header"><span class="tool-dot">●</span> <strong>${cleanHeader}</strong></div>`;
        inTool = true;
      } else if (inTool && trimmed.startsWith('└')) {
        const cleanBody = escapeHtml(trimmed);
        html += `<div class="tool-call-body">${cleanBody}</div></div>`;
        inTool = false;
      } else if (trimmed.startsWith('└ done') || trimmed.includes('tok/s')) {
        if (inTool) { html += '</div>'; inTool = false; }
        const cleanMetrics = escapeHtml(trimmed);
        html += `<div class="tool-metrics">${cleanMetrics}</div>`;
      } else {
        if (inTool) { html += '</div>'; inTool = false; }
        if (trimmed) html += `<div class="chat-paragraph">${escapeHtml(trimmed)}</div>`;
      }
    });
    if (inTool) html += '</div>';
    return html;
  }

  function appendRoomMessage(messageOrSender, text, isAgent = false, avatarLetter = null) {
    if (!teamRoomChatFeed) return;

    let sender = '';
    let bodyText = '';
    let isAgentMsg = false;
    let initial = '';
    let msgId = '';
    let timeStr = '';

    if (typeof messageOrSender === 'object' && messageOrSender !== null) {
      const msg = messageOrSender;
      msgId = msg.id || '';
      sender = msg.sender_name || (msg.sender_type === 'human' ? 'You' : (msg.sender_id || 'Agent'));
      bodyText = msg.text || '';
      isAgentMsg = msg.sender_type === 'agent' || isAgent;
      initial = (sender ? sender.charAt(0) : '?').toUpperCase();
      timeStr = msg.created_at ? new Date(msg.created_at).toLocaleTimeString() : new Date().toLocaleTimeString();
    } else {
      sender = String(messageOrSender || '');
      bodyText = String(text || '');
      isAgentMsg = !!isAgent;
      initial = (avatarLetter || (sender ? sender.charAt(0) : '?')).toUpperCase();
      timeStr = new Date().toLocaleTimeString();
    }

    if (msgId && renderedMessageIds.has(msgId)) {
      return; // Deduplicate
    }
    if (msgId) {
      renderedMessageIds.add(msgId);
    }

    // Remove empty state if present
    const emptyState = document.getElementById('chat-empty-state');
    if (emptyState) emptyState.remove();

    const msgEl = document.createElement('div');
    msgEl.className = `chat-msg ${isAgentMsg ? 'agent' : 'human'}`;
    if (msgId) msgEl.dataset.messageId = msgId;

    if (typeof messageOrSender === 'object' && messageOrSender !== null) {
      const clientTurnId = messageOrSender.client_turn_id || messageOrSender.metadata?.turn_id || messageOrSender.metadata?.client_turn_id || messageOrSender.turn_id;
      if (clientTurnId) msgEl.dataset.clientTurnId = clientTurnId;
    }

    const safeSender = escapeHtml(sender);
    const safeInitial = escapeHtml(initial);
    const safeTime = escapeHtml(timeStr);

    let contentHtml = '';
    if (isAgentMsg) {
      contentHtml = formatToolChatText(bodyText);
    } else {
      contentHtml = `<div class="chat-text">${escapeHtml(bodyText)}</div>`;
    }

    msgEl.innerHTML = `
      <div class="chat-avatar">${safeInitial}</div>
      <div class="chat-body">
        <div class="chat-meta">
          <span class="chat-sender">${safeSender}</span>
          <span class="chat-time">${safeTime}</span>
        </div>
        ${contentHtml}
      </div>
    `;

    teamRoomChatFeed.appendChild(msgEl);
    const autoscrollPref = localStorage.getItem('agentcrew-pref-autoscroll') ?? localStorage.getItem('agentcrew_autoscroll') ?? localStorage.getItem('agentcrew-autoscroll');
    if (autoscrollPref !== 'false') {
      teamRoomChatFeed.scrollTop = teamRoomChatFeed.scrollHeight;
    }
    return msgEl;
  }
  const appendChatMessage = appendRoomMessage;

  function appendPendingIndicator(agentName) {
    removePendingIndicator();
    if (!teamRoomChatFeed) return;
    const item = document.createElement('div');
    item.className = 'chat-msg agent pending';
    item.id = 'chat-pending-msg';
    const initials = escapeHtml((agentName || 'AG').slice(0, 2).toUpperCase());
    item.innerHTML = `
      <div class="chat-avatar">${initials}</div>
      <div class="chat-body">
        <div class="chat-meta">
          <span class="chat-sender">${escapeHtml(agentName || 'Agent')}</span>
          <span class="chat-time">thinking...</span>
        </div>
        <div class="chat-paragraph">
          Processing request<span class="thinking-dots"><span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span></span>
        </div>
        <div id="chat-streaming-delta" class="chat-streaming-delta" hidden></div>
      </div>
    `;
    teamRoomChatFeed.appendChild(item);
    teamRoomChatFeed.scrollTop = teamRoomChatFeed.scrollHeight;
    pendingIndicatorEl = item;
  }

  function removePendingIndicator() {
    if (pendingIndicatorEl && pendingIndicatorEl.parentNode) {
      pendingIndicatorEl.remove();
    }
    const old = document.getElementById('chat-pending-msg');
    if (old) old.remove();
    pendingIndicatorEl = null;
  }

  function setPromptInFlight(inFlight, statusText = '') {
    isPromptInFlight = inFlight;
    if (btnSendChat) btnSendChat.hidden = inFlight;
    const btnCancel = document.getElementById('btn-cancel-chat');
    if (btnCancel) btnCancel.hidden = !inFlight;

    const elTurnsCount = document.getElementById('topbar-turns-count');

    if (inFlight) {
      if (window.agentCrewOrb) window.agentCrewOrb.setActivity(0.85);
      const orbStatusText = document.getElementById('orb-status-text');
      if (orbStatusText) orbStatusText.textContent = statusText || 'WORKING · PROMPT IN FLIGHT';
      if (elTurnsCount) {
        const curTurns = parseInt(elTurnsCount.textContent || '0', 10);
        if (curTurns === 0) elTurnsCount.textContent = '1';
      }
    } else {
      inFlightAgentName = '';
      if (window.agentCrewOrb) window.agentCrewOrb.setActivity(0.0);
      const orbStatusText = document.getElementById('orb-status-text');
      if (orbStatusText) orbStatusText.textContent = 'IDLE · STANDBY';
      removePendingIndicator();
      promptAbortController = null;
      if (elTurnsCount && Array.isArray(liveAgents)) {
        const workingCount = liveAgents.filter(a => getAgentStatus(a) === 'working').length;
        elTurnsCount.textContent = String(workingCount);
      }
    }
  }

  function cancelPendingPrompt() {
    if (promptAbortController) {
      promptAbortController.abort();
      promptAbortController = null;
    }
    inFlightAgentName = '';
    setPromptInFlight(false);
  }

  function renderChatEmptyState(agent) {
    if (!teamRoomChatFeed) return;
    teamRoomChatFeed.replaceChildren();
    renderedMessageIds.clear();
    if (!agent) {
      const emptyBox = document.createElement('div');
      emptyBox.className = 'chat-empty-state';
      emptyBox.id = 'chat-empty-state';
      emptyBox.innerHTML = `
        <div class="chat-empty-icon">💬</div>
        <h3 class="chat-empty-name">Team Room Feed</h3>
        <p class="chat-empty-hint">Select an agent from the roster to start collaborating or review activity.</p>
      `;
      teamRoomChatFeed.appendChild(emptyBox);
      return;
    }
    const name = escapeHtml(agent.name || 'Agent');
    const role = escapeHtml(agent.role || 'Team Member');
    const provider = escapeHtml(agent.provider || 'configured');
    const model = escapeHtml(agent.model ? ` (${agent.model})` : '');
    const color = getAgentColor ? getAgentColor(agent) : '#0284c7';
    const initials = escapeHtml((agent.name || 'AG').slice(0, 2).toUpperCase());
    const owned = isAgentHumanOwned ? isAgentHumanOwned(agent) : false;
    const statusMeta = (typeof agentStatusMeta !== 'undefined' && getAgentStatus) ? agentStatusMeta[getAgentStatus(agent)] : { label: 'Available' };
    const statusLabel = owned ? 'Human Owned' : (statusMeta?.label || 'Available');

    const container = document.createElement('div');
    container.className = 'chat-empty-state';
    container.id = 'chat-empty-state';
    container.innerHTML = `
      <div class="chat-empty-avatar" style="background:${color};">${initials}</div>
      <h3 class="chat-empty-name">${name}</h3>
      <div class="chat-empty-role">${role}</div>
      <div class="chat-empty-provider">
        <span class="provider-pill">${provider}${model}</span>
        <span class="status-pill">${statusLabel}</span>
      </div>
      <div class="chat-empty-divider"></div>
      <p class="chat-empty-hint">No messages yet with <strong>${name}</strong>. Send a prompt below to assign work, discuss changes, or orchestrate tasks.</p>
    `;
    teamRoomChatFeed.appendChild(container);
  }

  async function loadAgentRoomFeed(agent) {
    if (!teamRoomChatFeed) return;
    const seq = ++feedRequestSeq;
    const agentName = agent?.name || selectedAgentName;
    teamRoomChatFeed.replaceChildren();
    renderedMessageIds.clear();

    try {
      const qs = new URLSearchParams();
      qs.set('channel', 'team-activity');
      if (currentProjectId) qs.set('project_id', currentProjectId);
      const res = await fetch(`/api/v1/room/messages?${qs.toString()}`);
      if (seq !== feedRequestSeq) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== feedRequestSeq) return;
      const messages = Array.isArray(data.messages) ? data.messages : [];

      const relevant = messages.filter(m => {
        if (!agentName) return true;
        const lowerName = agentName.toLowerCase();
        const sender = (m.sender_name || '').toLowerCase();
        const senderId = (m.sender_id || '').toLowerCase();
        const text = (m.text || '').toLowerCase();
        const target = (m.metadata?.target_agent || '').toLowerCase();
        return sender === lowerName || senderId === lowerName || text.includes('@' + lowerName) || target === lowerName;
      });

      if (relevant.length === 0) {
        if (!teamRoomChatFeed.querySelector('.chat-msg:not(.pending)')) {
          renderChatEmptyState(agent);
        }
      } else {
        relevant.forEach(msg => appendRoomMessage(msg));
      }
    } catch (err) {
      if (seq !== feedRequestSeq) return;
      console.warn('Could not load room messages:', err);
      if (!teamRoomChatFeed.querySelector('.chat-msg:not(.pending)')) {
        renderChatEmptyState(agent);
      }
    }
  }

  function log(text, type = 'system') {
    if (terminal) {
      const line = document.createElement('div');
      line.className = `term-line ${type}`;
      line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
      terminal.appendChild(line);
      terminal.scrollTop = terminal.scrollHeight;
    }
  }

  // --- Theme & Appearance Accent Management ---
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const mobileThemeBtn = document.getElementById('mobile-theme-btn');
  const themeLabelText = document.getElementById('theme-label-text');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motionEase = 'cubic-bezier(0.16, 1, 0.3, 1)';
  let themeTransitionTimer = null;

  function applyTheme(theme, animate = false) {
    if (animate) {
      document.body.classList.add('theme-transitioning');
      window.clearTimeout(themeTransitionTimer);
      themeTransitionTimer = window.setTimeout(() => {
        document.body.classList.remove('theme-transitioning');
      }, 220);
    }
    document.documentElement.setAttribute('data-theme', theme);
    if (themeLabelText) {
      themeLabelText.textContent = theme === 'dark' ? 'Theme: Dark' : 'Theme: Light';
    }
    if (pixelRenderer) {
      pixelRenderer.setTheme(theme);
    }
    try {
      localStorage.setItem('agentcrew_theme', theme);
    } catch (_) {}
  }

  let initialTheme = 'light';
  try {
    initialTheme = localStorage.getItem('agentcrew_theme') || 'light';
  } catch (_) {}

  // Appearance Accent Color
  const accentSwatches = document.querySelectorAll('.accent-swatch');
  function applyAccent(accent) {
    document.documentElement.setAttribute('data-accent', accent);
    accentSwatches.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.accent === accent);
    });
    try {
      localStorage.setItem('agentcrew_accent', accent);
    } catch (_) {}
  }

  let initialAccent = 'blue';
  try {
    initialAccent = localStorage.getItem('agentcrew_accent') || 'blue';
  } catch (_) {}
  applyAccent(initialAccent);

  accentSwatches.forEach(btn => {
    btn.addEventListener('click', () => {
      applyAccent(btn.dataset.accent);
      log(`Changed appearance accent color to ${btn.dataset.accent}`, 'system');
    });
  });

  // --- Pixel Room Canvas ---
  const canvas = document.getElementById('pixel-room-canvas');
  const pixelWrapper = document.getElementById('pixel-room-wrapper');
  const btnTogglePixel = document.getElementById('toggle-pixel-view');
  const btnToggleList = document.getElementById('toggle-list-view');

  let pixelRenderer = null;
  if (canvas && window.PixelRoomRenderer) {
    pixelRenderer = new PixelRoomRenderer(canvas, {
      theme: initialTheme,
      onAgentClick: (agent) => {
        selectAgentByName(agent.name);
        log(`Inspecting ${agent.name} (${agent.role}) via isometric station`, 'system');
      }
    });
  }

  applyTheme(initialTheme);

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next, true);
      log(`Switched interface theme to ${next}`, 'system');
    });
  }

  if (mobileThemeBtn) {
    mobileThemeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      applyTheme(current === 'dark' ? 'light' : 'dark', true);
    });
  }

  // --- Full-Screen Navigation Tabs ---
  const navTabs = document.querySelectorAll('.nav-tab, .mobile-nav-tab[data-view]');
  const views = document.querySelectorAll('.fullscreen-view');
  const appSidebar = document.getElementById('app-sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const mobileMoreBtn = document.getElementById('mobile-more-btn');
  const mobileSidebarClose = document.getElementById('mobile-sidebar-close');
  const mobileViewTitle = document.getElementById('mobile-view-title');
  const viewLabels = {
    'view-overview': 'Overview',
    'view-team-room': 'Agent Room',
    'view-reviews': 'Code Review',
    'view-kanban': 'Tasks & Flow',
    'view-repositories': 'Repositories',
    'view-observability': 'Observability',
    'view-settings': 'Settings'
  };
  const viewOrder = Object.keys(viewLabels);
  let viewAnimation = null;

  function animateElement(element, keyframes, options) {
    if (!element || typeof element.animate !== 'function') return null;
    return element.animate(keyframes, { easing: motionEase, fill: 'none', ...options });
  }

  function setMobileDrawer(open) {
    if (!appSidebar) return;
    appSidebar.classList.toggle('open', open);
    document.body.classList.toggle('mobile-drawer-open', open);
    if (sidebarBackdrop) sidebarBackdrop.classList.toggle('visible', open);
    if (mobileMenuBtn) mobileMenuBtn.setAttribute('aria-expanded', String(open));
    if (mobileMoreBtn) mobileMoreBtn.setAttribute('aria-expanded', String(open));
  }

  function switchView(targetViewId) {
    if (targetViewId === 'view-code-review') targetViewId = 'view-reviews';
    const currentView = document.querySelector('.fullscreen-view.active');
    if (!document.getElementById(targetViewId) || currentView?.id === targetViewId) {
      setMobileDrawer(false);
      return;
    }
    const direction = viewOrder.indexOf(targetViewId) >= viewOrder.indexOf(currentView?.id) ? 1 : -1;
    if (targetViewId !== 'view-reviews' && typeof selectedPR !== 'undefined' && selectedPR) {
      closePRPanel();
    }
    views.forEach(v => {
      v.classList.toggle('active', v.id === targetViewId);
    });
    navTabs.forEach(t => {
      t.classList.toggle('active', t.dataset.view === targetViewId);
      if (t.dataset.view === targetViewId) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    document.body.classList.toggle('in-team-room', targetViewId === 'view-team-room');
    document.querySelectorAll('.topbar-view-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.view === targetViewId);
    });
    if (mobileViewTitle) mobileViewTitle.textContent = viewLabels[targetViewId] || 'AgentCrew';
    if (mobileMoreBtn) {
      const secondaryViews = ['view-repositories', 'view-observability', 'view-settings'];
      mobileMoreBtn.classList.toggle('active', secondaryViews.includes(targetViewId));
    }
    setMobileDrawer(false);
    const dashboard = document.querySelector('.dashboard-container');
    if (dashboard) dashboard.scrollTo({ top: 0, behavior: 'auto' });

    const targetView = document.getElementById(targetViewId);
    if (viewAnimation) viewAnimation.cancel();
    viewAnimation = animateElement(
      targetView,
      reducedMotion.matches
        ? [{ opacity: 0.72 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: `translateX(${direction * 12}px)`, clipPath: 'inset(0 0 7% 0 round 12px)' },
            { opacity: 1, transform: 'translateX(0)', clipPath: 'inset(0 0 0 0 round 12px)' }
          ],
      { duration: reducedMotion.matches ? 90 : 180, fill: 'none' }
    );
    if (viewAnimation) {
      viewAnimation.onfinish = () => {
        try { viewAnimation.cancel(); } catch (_) {}
      };
    }
  }

  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      switchView(tab.dataset.view);
    });
  });

  document.querySelectorAll('.topbar-view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchView(tab.dataset.view);
    });
  });

  if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', () => setMobileDrawer(true));
  if (mobileMoreBtn) mobileMoreBtn.addEventListener('click', () => setMobileDrawer(true));
  if (mobileSidebarClose) mobileSidebarClose.addEventListener('click', () => setMobileDrawer(false));
  if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => setMobileDrawer(false));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && appSidebar && appSidebar.classList.contains('open')) {
      setMobileDrawer(false);
      if (mobileMenuBtn) mobileMenuBtn.focus();
    }
  });

  window.matchMedia('(min-width: 901px)').addEventListener('change', event => {
    if (event.matches) setMobileDrawer(false);
  });

  if (btnTogglePixel && roomMapView && teamRoomView) {
    btnTogglePixel.addEventListener('click', () => {
      const openMap = roomMapView.hidden;
      roomMapView.hidden = !openMap;
      teamRoomView.classList.toggle('map-view-active', openMap);
      btnTogglePixel.setAttribute('aria-expanded', String(openMap));
      btnTogglePixel.textContent = openMap ? 'Back to agent room' : 'Open room map';
      if (openMap) {
        pixelWrapper.style.display = 'flex';
        animateElement(
          roomMapView,
          reducedMotion.matches
            ? [{ opacity: 0.8 }, { opacity: 1 }]
            : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
          { duration: reducedMotion.matches ? 90 : 180 }
        );
      }
    });
  }

  // --- Overview: Range Switcher & Sparklines ---
  let activeRange = 'week';
  const rangeBtns = document.querySelectorAll('.btn-range');
  const overviewCaption = document.getElementById('overview-caption');

  function generateSparkSvg(dataPoints, strokeColor = '#0284c7') {
    if (!dataPoints || dataPoints.length < 2) return '';
    const min = Math.min(...dataPoints);
    const max = Math.max(...dataPoints);
    const range = max - min || 1;
    const w = 72;
    const h = 24;

    const coords = dataPoints.map((val, idx) => {
      const x = (idx / (dataPoints.length - 1)) * (w - 4) + 2;
      const y = h - ((val - min) / range) * (h - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    return `<svg class="spark-svg" viewBox="0 0 ${w} ${h}">
      <polyline points="${coords.join(' ')}" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function updateOverview(range) {
    activeRange = range;
    rangeBtns.forEach(b => b.classList.toggle('active', b.dataset.range === range));

    const rangeObj = analyticsData.ranges.find(r => r.id === range);
    if (rangeObj && overviewCaption) {
      overviewCaption.textContent = rangeObj.caption;
    }

    const kpiList = analyticsData.kpis[range] || [];
    const cycleKpi = kpiList.find(k => k.id === 'cycle-time');
    const passKpi = kpiList.find(k => k.id === 'qa-pass');
    const concKpi = kpiList.find(k => k.id === 'concurrency');
    const delivKpi = kpiList.find(k => k.id === 'delivered');

    if (cycleKpi) {
      const el = document.getElementById('kpi-val-cycle');
      if (el) el.textContent = cycleKpi.value;
      const sparkEl = document.getElementById('spark-cycle');
      if (sparkEl) sparkEl.innerHTML = generateSparkSvg(cycleKpi.spark, '#16a34a');
    }

    if (passKpi) {
      const el = document.getElementById('kpi-val-pass');
      if (el) el.textContent = passKpi.value;
      const sparkEl = document.getElementById('spark-pass');
      if (sparkEl) sparkEl.innerHTML = generateSparkSvg(passKpi.spark, '#0284c7');
    }

    if (concKpi) {
      const el = document.getElementById('kpi-val-conc');
      if (el) el.textContent = concKpi.value;
      const sparkEl = document.getElementById('spark-conc');
      if (sparkEl) sparkEl.innerHTML = generateSparkSvg(concKpi.spark, '#9333ea');
    }

    if (delivKpi) {
      const el = document.getElementById('kpi-val-tasks');
      if (el) el.textContent = delivKpi.value;
      const sparkEl = document.getElementById('spark-tasks');
      if (sparkEl) sparkEl.innerHTML = generateSparkSvg(delivKpi.spark, '#d97706');
    }

    renderActivityChart(range);
  }

  rangeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.range === activeRange) return;
      updateOverview(btn.dataset.range);
      const overview = document.getElementById('view-overview');
      overview?.querySelectorAll('.kpi-card').forEach((card, index) => {
        animateElement(
          card,
          reducedMotion.matches
            ? [{ opacity: 0.78 }, { opacity: 1 }]
            : [{ opacity: 0.55, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }],
          { duration: reducedMotion.matches ? 90 : 160, delay: reducedMotion.matches ? 0 : index * 18 }
        );
      });
      const chart = document.querySelector('.activity-chart-card');
      animateElement(
        chart,
        reducedMotion.matches
          ? [{ opacity: 0.8 }, { opacity: 1 }]
          : [{ opacity: 0.65, clipPath: 'inset(0 3% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 0)' }],
        { duration: reducedMotion.matches ? 90 : 200 }
      );
    });
  });

  // --- SVG Activity Chart ---
  function renderActivityChart(range) {
    const act = analyticsData.activity[range];
    const chartPaths = document.getElementById('chart-series-paths');
    const legendContainer = document.getElementById('contributor-legend-pills');
    if (!act || !chartPaths) return;

    chartPaths.innerHTML = '';
    if (legendContainer) legendContainer.innerHTML = '';

    const seriesKeys = Object.keys(act.series);
    const labels = act.labels;
    const numPoints = labels.length;

    let globalMax = 1;
    seriesKeys.forEach(k => {
      const arr = act.series[k];
      arr.forEach(v => { if (v > globalMax) globalMax = v; });
    });

    const w = 900;
    const h = 200;
    const padX = 70;
    const padTop = 25;
    const padBottom = 20;
    const plotW = w - padX * 2;
    const plotH = h - padTop - padBottom;

    seriesKeys.forEach(key => {
      const person = analyticsData.people.find(p => p.handle === key) || { color: '#0284c7', name: key };
      const values = act.series[key];

      const points = values.map((val, idx) => {
        const x = padX + (idx / (numPoints - 1)) * plotW;
        const y = padTop + plotH - (val / globalMax) * plotH;
        return { x, y };
      });

      // Bezier curve string
      let d = `M ${points[0].x} ${points[0].y}`;
      for (let i = 0; i < points.length - 1; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;
        d += ` Q ${points[i].x} ${points[i].y}, ${xc} ${yc}`;
      }
      d += ` T ${points[points.length - 1].x} ${points[points.length - 1].y}`;

      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', d);
      pathEl.setAttribute('class', 'chart-curve');
      pathEl.setAttribute('stroke', person.color);
      chartPaths.appendChild(pathEl);

      // Points
      points.forEach(pt => {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', pt.x);
        dot.setAttribute('cy', pt.y);
        dot.setAttribute('r', '3.5');
        dot.setAttribute('fill', person.color);
        chartPaths.appendChild(dot);
      });

      // Legend Pill
      if (legendContainer) {
        const pill = document.createElement('div');
        pill.className = 'legend-item';
        const linesInfo = act.lines[key] ? ` (+${act.lines[key].added} / -${act.lines[key].removed})` : '';
        pill.innerHTML = `
          <span class="legend-dot" style="background:${escapeHtml(person.color || '#0284c7')};"></span>
          <strong>${escapeHtml(person.name || key)}</strong>
          <span style="font-size:0.7rem; color:var(--text-muted);">${escapeHtml(linesInfo)}</span>
        `;
        legendContainer.appendChild(pill);
      }
    });
  }

  // --- Top Contributors Grid (Overview) ---
  function renderOverviewContributors() {
    const grid = document.getElementById('overview-contributors-grid');
    if (!grid) return;
    grid.innerHTML = '';

    analyticsData.people.forEach(p => {
      const item = document.createElement('div');
      item.className = 'contributor-item';
      item.style.setProperty('--avatar-color', p.color || '#0284c7');
      item.innerHTML = `
        <img class="contributor-avatar" src="${escapeHtml(p.avatar)}" alt="${escapeHtml(p.name)}">
        <div class="contributor-info">
          <span class="contributor-name">${escapeHtml(p.name)}</span>
          <span class="contributor-role">${escapeHtml(p.role)}</span>
        </div>
      `;
      grid.appendChild(item);
    });
  }

  // --- Code Review Queue & Docked Details Panel ---
  let selectedPR = null;
  const prItemsList = document.getElementById('pr-items-list');
  const detailsPanel = document.getElementById('pr-details-panel');
  const prPanelBackdrop = document.getElementById('pr-panel-backdrop');
  const closeDockBtn = document.getElementById('close-pr-panel-btn');
  let prPanelReturnFocus = null;
  let activeFilter = 'all';

  if (detailsPanel && window.matchMedia('(max-width: 1180px)').matches) {
    detailsPanel.setAttribute('aria-hidden', 'true');
  }

  function renderPRList(filter = 'all') {
    activeFilter = filter;
    if (!prItemsList) return;
    prItemsList.innerHTML = '';

    const prs = analyticsData.pullRequests.filter(pr => {
      if (filter === 'all') return true;
      const kind = pr.status?.kind || pr.status || pr.state || 'open';
      return kind === filter;
    });

    prs.forEach(pr => {
      const author = analyticsData.people.find(p => p.handle === pr.author) || {
        name: pr.author,
        avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${pr.author}`
      };
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `pr-card-item ${selectedPR && selectedPR.number === pr.number ? 'selected' : ''}`;
      card.dataset.number = pr.number;
      card.setAttribute('aria-label', `Open pull request ${pr.number}: ${pr.title}`);

      const statusKind = pr.status?.kind || pr.status || pr.state || 'open';
      const statusLabel = pr.status?.label || pr.status || pr.state || 'open';
      const statusBadgeClass = statusKind === 'merged' ? 'badge-success' : (statusKind === 'review' ? 'badge-warning' : '');

      card.innerHTML = `
        <div class="pr-card-header">
          <span class="badge ${escapeHtml(statusBadgeClass)}">${escapeHtml(statusLabel)}</span>
          <span style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(pr.age || '')} ago</span>
        </div>
        <div class="pr-title-text">${escapeHtml(pr.title || '')}</div>
        <div class="pr-meta-row">
          <div class="pr-author-chip">
            <img class="author-avatar-sm" src="${escapeHtml(author.avatar)}" alt="${escapeHtml(author.name)}">
            <span>@${escapeHtml(pr.author)}</span>
          </div>
          <span>·</span>
          <span>${escapeHtml(pr.repository || '')}</span>
          <div class="pr-diff-tags">
            <span class="diff-add">+${Number(pr.additions) || 0}</span>
            <span class="diff-del">-${Number(pr.deletions) || 0}</span>
          </div>
        </div>
      `;

      card.addEventListener('click', () => {
        selectPR(pr);
      });

      prItemsList.appendChild(card);
    });
  }

  function selectPR(pr) {
    if (typeof pr === 'number' || typeof pr === 'string') {
      const found = (Array.isArray(analyticsData.pullRequests) ? analyticsData.pullRequests : []).find(p => Number(p.number) === Number(pr));
      if (found) pr = found;
    }
    if (!pr || typeof pr !== 'object') return;
    prPanelReturnFocus = document.activeElement;
    selectedPR = pr;
    document.querySelectorAll('.pr-card-item').forEach(el => {
      el.classList.toggle('selected', Number(el.dataset.number) === pr.number);
    });

    const author = analyticsData.people.find(p => p.handle === pr.author) || {
      name: pr.author,
      avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${pr.author}`
    };

    const statusLabel = typeof pr.status === 'object' ? (pr.status?.label || pr.status?.name || 'open') : (pr.status || pr.state || 'open');
    document.getElementById('pr-panel-title').textContent = pr.title || '';
    document.getElementById('pr-panel-status').textContent = statusLabel;
    document.getElementById('pr-panel-opened').textContent = pr.opened ? `Opened ${pr.opened}` : '';
    document.getElementById('pr-panel-author-avatar').src = author.avatar;
    document.getElementById('pr-panel-author-handle').textContent = `@${pr.author || 'unknown'} (${author.name})`;
    document.getElementById('pr-panel-repo').textContent = pr.repository || '';
    document.getElementById('pr-panel-additions').textContent = `+${pr.additions || 0}`;
    document.getElementById('pr-panel-deletions').textContent = `-${pr.deletions || 0}`;
    document.getElementById('pr-panel-comments').textContent = `${pr.comments ?? 0} comments`;

    const probEl = document.getElementById('pr-panel-problem');
    const problems = Array.isArray(pr.problem) ? pr.problem : [pr.problem || 'No description provided.'];
    if (probEl) {
      probEl.replaceChildren();
      problems.forEach(p => {
        const pEl = document.createElement('p');
        pEl.textContent = p;
        probEl.appendChild(pEl);
      });
    }

    const appEl = document.getElementById('pr-panel-approach');
    const approaches = Array.isArray(pr.approach) ? pr.approach : [pr.approach || 'No approach summary provided.'];
    if (appEl) {
      appEl.replaceChildren();
      approaches.forEach(a => {
        const aEl = document.createElement('p');
        aEl.textContent = a;
        appEl.appendChild(aEl);
      });
    }

    // Reset Assistant response
    const respBox = document.getElementById('assistant-response-card');
    if (respBox) respBox.style.display = 'none';

    if (detailsPanel) {
      detailsPanel.style.removeProperty('display');
      if (!window.matchMedia('(max-width: 1180px)').matches) {
        detailsPanel.style.display = 'flex';
      }
      detailsPanel.setAttribute('aria-hidden', 'false');
      if (window.matchMedia('(max-width: 1180px)').matches) {
        document.body.classList.add('pr-panel-open');
        if (closeDockBtn) closeDockBtn.focus();
      }
    }
  }

  function closePRPanel() {
    selectedPR = null;
    document.querySelectorAll('.pr-card-item').forEach(el => el.classList.remove('selected'));
    if (detailsPanel) {
      detailsPanel.setAttribute('aria-hidden', 'true');
      if (!window.matchMedia('(max-width: 1180px)').matches) {
        detailsPanel.style.display = 'none';
      } else {
        detailsPanel.style.removeProperty('display');
      }
    }
    document.body.classList.remove('pr-panel-open');
    if (prPanelReturnFocus && typeof prPanelReturnFocus.focus === 'function') {
      prPanelReturnFocus.focus();
    }
    prPanelReturnFocus = null;
  }

  if (closeDockBtn) {
    closeDockBtn.addEventListener('click', closePRPanel);
  }
  if (prPanelBackdrop) {
    prPanelBackdrop.addEventListener('click', closePRPanel);
  }

  // Filter Pills click
  document.querySelectorAll('#pr-filter-pills .pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#pr-filter-pills .pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderPRList(btn.dataset.filter);
    });
  });

  // --- Assistant Composer Q&A ---
  const assistantInput = document.getElementById('assistant-input');
  const btnAsk = document.getElementById('btn-ask-assistant');
  const assistantCard = document.getElementById('assistant-response-card');
  const assistantShimmer = document.getElementById('assistant-shimmer');
  const assistantAnswerText = document.getElementById('assistant-answer-text');

  async function askAssistant(question) {
    if (!selectedPR || !question.trim()) return;
    const targetPrNumber = selectedPR.number;

    assistantCard.style.display = 'block';
    assistantShimmer.style.display = 'flex';
    assistantAnswerText.textContent = '';

    // Determine target agent persona based on question or PR reviewer
    let targetAgent = 'Arthur (Architect)';
    const q = question.toLowerCase();
    if (q.includes('test') || q.includes('coverage') || q.includes('qa')) {
      targetAgent = 'QA Lead';
    } else if (q.includes('author') || q.includes('why')) {
      targetAgent = selectedPR.author || 'Dev-1';
    }

    try {
      const res = await fetch('/api/v1/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command_type: 'agent.ask',
          payload: {
            agent_id: targetAgent,
            pr_number: selectedPR.number,
            pr_title: selectedPR.title,
            question: question.trim(),
            author: selectedPR.author,
          }
        })
      });

      const data = await res.json();
      assistantShimmer.style.display = 'none';
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (!data.result?.answer) throw new Error('Provider returned no review answer');
      if (selectedPR?.number === targetPrNumber) {
        assistantAnswerText.textContent = data.result.answer;
        assistantAnswerText.style.color = '';
      }
    } catch (err) {
      assistantShimmer.style.display = 'none';
      if (selectedPR?.number === targetPrNumber) {
        assistantAnswerText.textContent = `Failed to query agent: ${err.message}`;
        assistantAnswerText.style.color = 'var(--danger)';
      }
    }
  }

  if (btnAsk && assistantInput) {
    btnAsk.addEventListener('click', () => {
      askAssistant(assistantInput.value);
      assistantInput.value = '';
    });
  }

  document.querySelectorAll('.assistant-chips .chip-btn').forEach(chip => {
    chip.addEventListener('click', () => {
      if (assistantInput) assistantInput.value = chip.dataset.query;
      askAssistant(chip.dataset.query);
    });
  });

  // --- Searchable Repositories Grid ---
  const repoSearchInput = document.getElementById('repo-search-input');
  const reposCardsGrid = document.getElementById('repos-cards-grid');

  function renderRepositories(search = '') {
    if (!reposCardsGrid) return;
    reposCardsGrid.innerHTML = '';

    const query = search.toLowerCase();
    const repos = (analyticsData.repositories || []).filter(r => {
      const name = (r.name || '').toLowerCase();
      const desc = (r.description || '').toLowerCase();
      const branch = (r.branch || 'main').toLowerCase();
      return name.includes(query) || desc.includes(query) || branch.includes(query);
    });

    if (!repos.length) {
      const empty = document.createElement('p');
      empty.className = 'repos-empty-state';
      empty.textContent = 'No repositories found';
      reposCardsGrid.appendChild(empty);
      return;
    }

    repos.forEach(repo => {
      const card = document.createElement('div');
      card.className = 'repo-card card';
      card.innerHTML = `
        <div class="repo-card-top">
          <div>
            <h4 class="repo-card-name">${escapeHtml(repo.name || '')}</h4>
            <p class="repo-card-desc">${escapeHtml(repo.description || '')}</p>
          </div>
          <span class="badge badge-success">${escapeHtml(repo.status || '')}</span>
        </div>
        <div class="repo-card-footer">
          <span class="branch-pill">🌿 ${escapeHtml(repo.branch || 'main')}</span>
          <span>${escapeHtml(String(repo.worktreesCount || 0))} active worktrees</span>
          <span style="color:var(--text-muted);">${escapeHtml(repo.lastSync || '')}</span>
        </div>
      `;
      reposCardsGrid.appendChild(card);
    });
  }

  if (repoSearchInput) {
    repoSearchInput.addEventListener('input', (e) => {
      renderRepositories(e.target.value);
    });
  }

  // --- Load Workspace and Roster from API ---
  async function loadWorkspace() {
    try {
      const res = await fetch('/api/v1/workspace');
      const data = await res.json();
      log(`Workspace loaded: ${data.workspace.name} (${data.agents.length} agents)`);
      const warning = document.getElementById('remote-http-warning');
      const isDismissed = sessionStorage.getItem('agentcrew_remote_warning_dismissed') === '1';
      if (warning) {
        if (data.public_http_warning && !isDismissed) {
          warning.hidden = false;
        } else {
          warning.hidden = true;
        }
      }

      const btnDismiss = document.getElementById('btn-dismiss-remote-warning');
      if (btnDismiss && !btnDismiss.dataset.wired) {
        btnDismiss.dataset.wired = 'true';
        btnDismiss.addEventListener('click', () => {
          if (warning) {
            warning.classList.add('toast-hiding');
            setTimeout(() => {
              warning.hidden = true;
              warning.classList.remove('toast-hiding');
            }, 200);
          }
          sessionStorage.setItem('agentcrew_remote_warning_dismissed', '1');
        });
      }

      // Update brand name & current project title
      if (data.workspace?.id) {
        currentProjectId = data.workspace.id;
      }
      const brandTitle = document.getElementById('brand-title');
      if (brandTitle && data.workspace?.name) {
        brandTitle.textContent = data.workspace.name;
      }
      const brandSub = document.querySelector('.brand-sub');
      if (brandSub && data.workspace?.name) {
        brandSub.textContent = `Active: ${data.workspace.name}`;
      }
      const topbarProjName = document.getElementById('topbar-project-name');
      if (topbarProjName && data.workspace?.name) {
        topbarProjName.textContent = data.workspace.name;
      }
      const projAsstTitle = document.getElementById('project-assistant-title');
      if (projAsstTitle && data.workspace?.name) {
        projAsstTitle.textContent = `${data.workspace.name} assistant`;
      }
    } catch (err) {
      log(`Error loading workspace: ${err.message}`, 'action');
    }
  }

  const agentStatusMeta = {
    'needs-you': { label: 'Needs you', group: 'Needs you' },
    working: { label: 'Working', group: 'Working' },
    review: { label: 'To review', group: 'To review' },
    available: { label: 'Ready', group: 'Available' }
  };

  function getAgentStatus(agent) {
    if (agent.provider_status === 'disconnected' && !agent.active_provider) return 'needs-you';
    const raw = String(agent.activity_badge || agent.state || 'idle').toLowerCase().replace(/[ _]+/g, '-');
    if (/takeover|human-owned|waiting|blocked|stuck|needs-input|needs-you/.test(raw)) return 'needs-you';
    if (/review|approval/.test(raw)) return 'review';
    if (/working|running|active|thinking/.test(raw)) return 'working';
    return 'available';
  }

  function isAgentHumanOwned(agent) {
    const raw = String(agent?.state || agent?.activity_badge || '').toLowerCase().replace(/[ _]+/g, '-');
    return raw === 'takeover' || raw === 'human-owned' || raw === 'human-owned-session';
  }

  function getAgentColor(agent) {
    const person = analyticsData.people.find(p => p.name.toLowerCase() === String(agent.name).toLowerCase());
    return person?.color || 'var(--accent-primary)';
  }

  function updateAgentWorkspace(agent) {
    if (!agent) return;
    const nameEl = document.getElementById('selected-agent-name');
    const avatarEl = document.getElementById('selected-agent-avatar');
    const statusEl = document.getElementById('selected-agent-status');
    const owned = isAgentHumanOwned(agent);
    const status = getAgentStatus(agent);
    const statusLabel = agent.provider_status === 'disconnected' && !agent.active_provider ? 'Disconnected'
      : owned ? 'Human owned' : agentStatusMeta[status].label;
    const stateText = document.getElementById('agent-session-state');

    if (nameEl) nameEl.textContent = agent.name;
    if (avatarEl) {
      avatarEl.textContent = agent.name.slice(0, 2).toUpperCase();
      avatarEl.style.setProperty('--agent-avatar-color', getAgentColor(agent));
    }
    if (statusEl) {
      statusEl.textContent = statusLabel;
      statusEl.dataset.state = status;
      statusEl.classList.toggle('is-human-owned', owned);
    }
    const roleEl = document.getElementById('selected-agent-role');
    if (roleEl) roleEl.textContent = agent.role || 'Full-Stack Developer';
    const providerEl = document.getElementById('selected-agent-provider');
    if (providerEl) providerEl.textContent = String(agent.active_provider || agent.provider || 'Provider').toUpperCase();
    const providerStatusEl = document.getElementById('selected-agent-provider-status');
    if (providerStatusEl) providerStatusEl.textContent = agent.active_provider && agent.active_provider !== agent.provider
      ? `Backup active · ${agent.provider} disconnected`
      : agent.provider_status === 'disconnected' ? 'Disconnected · CLI unavailable' : 'CLI detected · sign-in unverified';
    const modelEl = document.getElementById('selected-agent-model');
    if (modelEl) modelEl.textContent = agent.model || 'opus';
    const taskEl = document.getElementById('selected-agent-task');
    const taskId = agent.active_task_id || agent.activeTaskId;
    if (taskEl) taskEl.textContent = taskId ? `Task ${taskId}` : 'No active task assigned';
    const idEl = document.getElementById('selected-agent-id');
    if (idEl) idEl.textContent = agent.id ? `ID ${String(agent.id).slice(0, 8)}` : '';
    const guidanceEl = document.getElementById('selected-agent-guidance');
    if (guidanceEl) guidanceEl.textContent = owned
      ? 'You control the native CLI. Type in the terminal; Shell is separate.'
      : 'Take over to open this agent’s CLI. Shell commands use a separate channel.';
    const captionEl = document.getElementById('agent-session-caption');
    if (captionEl) captionEl.textContent = owned
      ? terminalReady ? 'Connected to the selected agent’s live terminal.' : 'Takeover acquired; connecting to the CLI…'
      : 'Live output appears here when a session is connected.';
    if (stateBadge) stateBadge.textContent = owned ? 'Human owned' : 'Auto';
    if (btnTakeover) btnTakeover.disabled = owned;
    if (btnRelease) btnRelease.disabled = !owned;
    if (cmdInput) cmdInput.disabled = !owned;
    if (btnSendCmd) btnSendCmd.disabled = !owned;
    if (stateText) stateText.textContent = owned ? (terminalReady ? 'Connected' : 'Connecting') : statusLabel;
    if (agentSelect && agentSelect.value !== agent.name) agentSelect.value = agent.name;
    const backupSelect = document.getElementById('agent-backup-provider');
    const backupModel = document.getElementById('agent-backup-model');
    if (backupSelect) {
      [...backupSelect.options].forEach(option => { option.disabled = option.value === agent.provider; });
      backupSelect.value = agent.backup_provider || '';
    }
    if (backupModel) backupModel.value = agent.backup_model || '';

    // Load real persisted messages for selected agent or honest empty state
    loadAgentRoomFeed(agent);
    if (teamChatInput) {
      teamChatInput.placeholder = `Ask ${agent.name} to code, review, or orchestrate... (Enter to send, Shift+Enter for new line)`;
    }
  }

  function renderAgentRoster() {
    if (!teamRoomGrid) return;
    teamRoomGrid.replaceChildren();
    const query = (agentSearchInput?.value || '').trim().toLowerCase();
    const filtered = liveAgents.filter(agent => {
      const status = getAgentStatus(agent);
      const matchesFilter = activeAgentFilter === 'all' || activeAgentFilter === 'groups' || status === activeAgentFilter;
      const text = `${agent.name} ${agent.role} ${agent.provider} ${agent.model}`.toLowerCase();
      return matchesFilter && (!query || text.includes(query));
    });

    let renderedGroups = [];
    if (activeAgentFilter === 'groups') {
      const roleCategories = [
        {
          id: 'planning',
          label: 'PLANNING & ARCHITECTURE',
          filter: (a) => /architect|product|business|analyst/i.test(a.role || '')
        },
        {
          id: 'engineering',
          label: 'ENGINEERING',
          filter: (a) => /developer|engineer|full-stack/i.test(a.role || '')
        },
        {
          id: 'qa-delivery',
          label: 'QA & DELIVERY',
          filter: (a) => /tester|qa|integrator|devops/i.test(a.role || '') || !(/architect|product|business|analyst|developer|engineer|full-stack/i.test(a.role || ''))
        }
      ];
      roleCategories.forEach(cat => {
        const agents = filtered.filter(cat.filter);
        if (!agents.length) return;
        renderedGroups.push({ status: cat.id, label: cat.label, agents });
      });
    } else {
      const statusGroups = [
        ['needs-you', 'NEEDS YOU'],
        ['review', 'TO REVIEW'],
        ['working', 'WORKING'],
        ['available', 'AVAILABLE']
      ];
      statusGroups.forEach(([status, label]) => {
        const agents = filtered.filter(agent => getAgentStatus(agent) === status);
        if (!agents.length) return;
        renderedGroups.push({ status, label, agents });
      });
    }

    renderedGroups.forEach(({ status, label, agents }) => {
      const group = document.createElement('section');
      group.className = `agent-status-group status-${status}`;
      const heading = document.createElement('h4');
      heading.className = `agent-status-heading agentsroom-group-heading ${status}`;
      heading.innerHTML = `<span>⌄ ${label}</span><span class="group-count">${agents.length}</span>`;
      group.appendChild(heading);

      agents.forEach(agent => {
        const row = document.createElement('button');
        const humanOwned = isAgentHumanOwned(agent);
        const cardStatus = getAgentStatus(agent);
        row.type = 'button';
        row.className = `agent-roster-row agentsroom-agent-card ${agent.name === selectedAgentName ? 'selected' : ''}`;
        row.dataset.agentName = agent.name;
        row.dataset.agentId = agent.id || agent.name;
        row.dataset.status = cardStatus;
        row.setAttribute('aria-pressed', String(agent.name === selectedAgentName));
        row.setAttribute('aria-label', `${agent.name}, ${agent.role || 'Agent'}, ${humanOwned ? 'human owned' : (agentStatusMeta[cardStatus]?.label || cardStatus)}`);

        const avatar = document.createElement('span');
        avatar.className = 'agent-roster-avatar agent-card-avatar';
        avatar.textContent = agent.name.slice(0, 2).toUpperCase();
        const color = getAgentColor(agent);
        avatar.style.setProperty('--agent-avatar-color', color);
        avatar.style.background = color;
        avatar.setAttribute('aria-hidden', 'true');
        if (cardStatus === 'needs-you') {
          const badge = document.createElement('span');
          badge.className = 'agent-card-badge';
          badge.textContent = '✦';
          avatar.appendChild(badge);
        }

        const identity = document.createElement('span');
        identity.className = 'agent-roster-identity agent-card-details';
        const name = document.createElement('strong');
        name.className = 'agent-card-name';
        name.textContent = agent.name;
        const meta = document.createElement('span');
        meta.className = 'agent-card-status';
        meta.textContent = agent.state ? `${agent.state.charAt(0).toUpperCase() + agent.state.slice(1)}` : 'Ready';
        identity.append(name, meta);

        const presence = document.createElement('i');
        presence.className = `agent-presence-dot ${humanOwned ? 'human-owned' : ''}`;
        presence.setAttribute('aria-hidden', 'true');

        row.append(avatar, identity, presence);
        row.addEventListener('click', () => selectAgent(agent));
        group.appendChild(row);
      });
      teamRoomGrid.appendChild(group);
    });

    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'agent-roster-empty';
      empty.textContent = liveAgents.length ? 'No agents match this filter.' : 'No agents are available.';
      teamRoomGrid.appendChild(empty);
    }

    if (agentRosterCount) {
      agentRosterCount.textContent = `${liveAgents.length} ${liveAgents.length === 1 ? 'agent' : 'agents'}`;
    }

    const needsYouCount = liveAgents.filter(a => getAgentStatus(a) === 'needs-you').length;
    const toReviewCount = liveAgents.filter(a => getAgentStatus(a) === 'review').length;
    const workingCount = liveAgents.filter(a => getAgentStatus(a) === 'working').length;

    const elCountNeedsYou = document.getElementById('count-needs-you');
    const elCountToReview = document.getElementById('count-to-review');
    const elCountWorking = document.getElementById('count-working');
    const elNeedsInputCount = document.getElementById('needs-input-count');
    const elTurnsCount = document.getElementById('topbar-turns-count');

    if (elCountNeedsYou) elCountNeedsYou.textContent = String(needsYouCount);
    if (elCountToReview) elCountToReview.textContent = String(toReviewCount);
    if (elCountWorking) elCountWorking.textContent = String(workingCount || 2);
    if (elNeedsInputCount) elNeedsInputCount.textContent = String(needsYouCount);
    if (elTurnsCount) elTurnsCount.textContent = String(workingCount || (isPromptInFlight ? 1 : 0));

    // Preserve existing agent-status-summary DOM nodes and dispatch rendered event for cockpit
    window.dispatchEvent(new CustomEvent('agentcrew:roster-rendered'));
  }

  function selectAgent(agentOrName) {
    const agent = (typeof agentOrName === 'string')
      ? liveAgents.find(item => item.name === agentOrName)
      : agentOrName;
    if (!agent) return;
    const changedAgent = selectedAgentName && selectedAgentName !== agent.name;
    if (changedAgent && ptySocket) disconnectPty();
    if (changedAgent && backupFeedback) backupFeedback.textContent = '';
    selectedAgentName = agent.name;
    window.agentCrewCurrentAgent = agent;
    updateAgentWorkspace(agent);
    renderAgentRoster();
    if (takeoverTokens.has(agent.name) && (!ptySocket || changedAgent)) connectPty(agent.name);
  }

  window.agentCrewSelectedAgent = () => {
    return liveAgents.find(item => item.name === selectedAgentName) || window.agentCrewCurrentAgent || liveAgents[0] || null;
  };
  window.agentCrewRefreshAgents = loadAgents;

  function selectAgentByName(name) {
    selectAgent(name);
  }

  agentFilterButtons.forEach(button => {
    button.addEventListener('click', () => {
      activeAgentFilter = button.dataset.agentFilter;
      agentFilterButtons.forEach(item => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      renderAgentRoster();
    });
  });

  if (agentSearchInput) agentSearchInput.addEventListener('input', renderAgentRoster);
  if (agentSelect) agentSelect.addEventListener('change', () => selectAgentByName(agentSelect.value));

  // Load Agent Stations
  async function loadAgents() {
    try {
      const res = await fetch('/api/v1/agents');
      const data = await res.json();
      liveAgents = Array.isArray(data.agents) ? data.agents : [];

      if (agentSelect) {
        const current = selectedAgentName || agentSelect.value;
        agentSelect.replaceChildren();
        liveAgents.forEach(agent => {
          const option = document.createElement('option');
          option.value = agent.name;
          option.textContent = `${agent.name} · ${agent.role || agent.provider}`;
          agentSelect.appendChild(option);
        });
        if (liveAgents.some(agent => agent.name === current)) agentSelect.value = current;
      }

      if (pixelRenderer && data.agents) {
        pixelRenderer.updateAgentStates(data.agents);
      }

      if (teamRoomGrid && data.agents) {
        renderAgentRoster();
        const selected = liveAgents.find(agent => agent.name === selectedAgentName) ||
          liveAgents.find(agent => agent.name === agentSelect?.value) ||
          liveAgents.find(agent => agent.name === 'Dev-1') || liveAgents[0];
        if (selected) selectAgent(selected);
      }
    } catch (err) {
      log(`Error loading agents: ${err.message}`, 'action');
    }
  }

  // Load Readiness Check
  async function loadReadiness() {
    try {
      const res = await fetch('/api/v1/readiness');
      const data = await res.json();
      const list = data.providers || [];

      if (providerBadges) {
        providerBadges.innerHTML = '';
        list.forEach(p => {
          const badge = document.createElement('span');
          const statusLabel = p.status === 'available' ? 'Available'
            : p.status === 'quota_limited' ? 'Quota limited' : 'Unavailable';
          badge.className = `badge ${p.status === 'available' ? 'badge-success' : 'badge-warning'}`;
          const reset = p.reset_at ? ` · resets ${new Date(p.reset_at).toLocaleTimeString()}` : '';
          badge.textContent = `Provider ${p.name}: ${statusLabel}${reset}`;
          const affectedAgents = p.agents?.length ? ` Assigned agents: ${p.agents.join(', ')}.` : '';
          badge.title = `${p.reason || `${p.name} runner detected`}${affectedAgents}`;
          providerBadges.appendChild(badge);
        });
      }

      // Update provider cards dynamically in #view-observability
      document.querySelectorAll('#view-observability .provider-box').forEach(box => {
        const strong = box.querySelector('strong')?.textContent.toLowerCase() || '';
        const badge = box.querySelector('.provider-header .badge');
        if (!badge) return;
        const matched = list.find(p => strong.includes(p.name.toLowerCase()));
        if (matched) {
          const isAvail = matched.status === 'available';
          badge.className = `badge ${isAvail ? 'badge-success' : (matched.status === 'quota_limited' ? 'badge-warning' : 'badge-danger')}`;
          badge.textContent = isAvail ? 'Qualified' : (matched.status === 'quota_limited' ? 'Quota Limited' : 'Unavailable');
        }
      });
    } catch (err) {
      log(`Readiness probe failed: ${err.message}`, 'action');
    }
  }

  // Connect SSE Stream
  function connectSSE() {
    const sse = new EventSource('/api/v1/events');
    const concDisplay = document.getElementById('concurrency-display');

    sse.addEventListener('agent.updated', async () => {
      await loadAgents();
    });

    sse.addEventListener('task.updated', async () => {
      await loadTasks();
    });

    sse.addEventListener('popup_created', async () => {
      await Promise.all([loadTasks(), loadPopups()]);
    });

    sse.addEventListener('agent.delta', (e) => {
      try {
        const data = JSON.parse(e.data);
        const deltaText = data.delta || data.text || '';
        if (!deltaText) return;
        const pendingMsg = document.getElementById('chat-pending-msg');
        if (pendingMsg) {
          let deltaContainer = pendingMsg.querySelector('#chat-streaming-delta');
          if (!deltaContainer) {
            deltaContainer = document.createElement('div');
            deltaContainer.id = 'chat-streaming-delta';
            deltaContainer.className = 'chat-streaming-delta';
            const chatBody = pendingMsg.querySelector('.chat-body') || pendingMsg;
            chatBody.appendChild(deltaContainer);
          }
          deltaContainer.hidden = false;
          deltaContainer.textContent += deltaText;
          if (teamRoomChatFeed) teamRoomChatFeed.scrollTop = teamRoomChatFeed.scrollHeight;
        }
      } catch (_) {}
    });

    sse.addEventListener('turn_concurrency', (e) => {
      const data = JSON.parse(e.data);
      if (concDisplay) {
        concDisplay.textContent = `${data.running} / ${data.max}`;
      }
      if (aiOrb) {
        aiOrb.setActivity(data.running > 0 ? 0.85 : 0.0);
      }
      const orbStatusText = document.getElementById('orb-status-text');
      if (orbStatusText) {
        orbStatusText.textContent = data.running > 0 ? `WORKING · ${data.running} TURNS` : 'IDLE · STANDBY';
      }
    });

    sse.addEventListener('takeover_quiesced', (e) => {
      const data = JSON.parse(e.data);
      log(`Remote Event: Agent ${data.agent_id} quiesced under takeover`, 'action');
      if (stateBadge) stateBadge.textContent = 'Human Owned';
      if (btnTakeover) btnTakeover.disabled = true;
      if (btnRelease) btnRelease.disabled = false;
      loadAgents();
    });

    sse.addEventListener('takeover_released', (e) => {
      const data = JSON.parse(e.data);
      log(`Remote Event: Agent ${data.agent_id} released to auto`, 'success');
      if (stateBadge) stateBadge.textContent = 'Auto';
      if (btnTakeover) btnTakeover.disabled = false;
      if (btnRelease) btnRelease.disabled = true;
      loadAgents();
    });

    sse.addEventListener('agent_answered', (e) => {
      const data = JSON.parse(e.data);
      loadReadiness();
      if (pixelRenderer && data.agent_id) {
        const bubblePreview = data.answer.replace(/\[\d+m/g, '').replace(/[\r\n]+/g, ' ').slice(0, 28);
        pixelRenderer.showSpeechBubble(data.agent_id, bubblePreview, 5000);
      }
      if (data.pr_number && data.pr_number !== 'live') {
        log(`[${data.agent_id}] Response regarding PR #${data.pr_number}: ${data.question}`, 'success');
      }
    });

    sse.addEventListener('room.message', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!data || !data.text) return;

        // Optimistic reconciliation: if this is a human message that matches client turn id,
        // attach real server message id and prevent duplicate bubble
        const turnId = data.metadata?.turn_id || data.metadata?.client_turn_id || data.turn_id;
        if (data.sender_type === 'human' && turnId) {
          const existingBubble = document.querySelector(`[data-client-turn-id="${turnId}"]`);
          if (existingBubble) {
            if (data.id) {
              existingBubble.dataset.messageId = data.id;
              renderedMessageIds.add(data.id);
            }
            return;
          }
        }

        if (data.id && renderedMessageIds.has(data.id)) return;

        const isAgent = data.sender_type === 'agent';
        const sender = data.sender_name || data.sender_id || 'Agent';
        const currentAgent = (selectedAgentName || '').toLowerCase();

        const matchesAgent = !selectedAgentName ||
          sender.toLowerCase() === currentAgent ||
          (data.text && data.text.toLowerCase().includes('@' + currentAgent)) ||
          (data.metadata?.target_agent && data.metadata.target_agent.toLowerCase() === currentAgent);

        if (matchesAgent) {
          appendRoomMessage(data);
          if (isAgent) {
            const matchesInFlight = Boolean(inFlightAgentName && (data.sender_name || data.sender_id || '').toLowerCase() === inFlightAgentName.toLowerCase());
            if (matchesInFlight) {
              removePendingIndicator();
              setPromptInFlight(false);
            }
            if (pixelRenderer) {
              const preview = data.text.replace(/\[\d+m/g, '').replace(/[\r\n]+/g, ' ').slice(0, 28);
              pixelRenderer.showSpeechBubble(sender, preview, 5000);
            }
          }
        }
      } catch (err) {
        console.warn('Error processing SSE room.message:', err);
      }
    });

    sse.addEventListener('agent_thinking', (e) => {
      const data = JSON.parse(e.data);
      pixelRenderer?.updateAgentStates([{ name: data.agent_id, state: 'thinking' }]);
    });

    sse.addEventListener('agent.thinking_started', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (window.agentCrewOrb) window.agentCrewOrb.setActivity(0.9);
        const orbStatusText = document.getElementById('orb-status-text');
        if (orbStatusText) orbStatusText.textContent = `WORKING · ${(data.agent_id || 'AGENT').toUpperCase()} THINKING`;
        pixelRenderer?.updateAgentStates([{ name: data.agent_id, state: 'thinking' }]);
      } catch (_) {}
    });

    const handleThinkingEnded = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (Boolean(data.agent_id && inFlightAgentName && data.agent_id.toLowerCase() === inFlightAgentName.toLowerCase())) {
          setPromptInFlight(false);
        }
        pixelRenderer?.updateAgentStates([{ name: data.agent_id, state: data.state || 'idle' }]);
      } catch (_) {}
    };
    sse.addEventListener('agent_thinking_ended', handleThinkingEnded);
    sse.addEventListener('agent.thinking_ended', handleThinkingEnded);

    sse.addEventListener('command_executed', (e) => {
      const data = JSON.parse(e.data);
      if (pixelRenderer && data.agent_id) {
        pixelRenderer.showSpeechBubble(data.agent_id, `Cmd: ${data.command.slice(0, 15)}`, 3000);
      }
    });

    sse.addEventListener('project.activated', async (e) => {
      const data = JSON.parse(e.data);
      currentProjectId = data.project?.id || data.project_id || currentProjectId;
      log(`Active project changed to ${data.project?.name || data.project_id}`, 'system');
      switchView('view-team-room');
      await loadProjects();
      await loadWorkspace();
      await loadAgents();
      await loadTasks();
      await loadRealRepositoryData();
      if (liveAgents.length > 0) {
        selectAgent(liveAgents[0]);
      }
    });

    sse.onerror = () => {
      if (statusEl) {
        statusEl.className = 'status-indicator disconnected';
        statusEl.querySelector('.label').textContent = 'Reconnecting...';
      }
    };
  }

  // Interactive Browser Takeover Cycle
  document.getElementById('save-agent-backup')?.addEventListener('click', async () => {
    const agentId = selectedAgentName;
    const backupProvider = document.getElementById('agent-backup-provider')?.value || null;
    const backupModel = document.getElementById('agent-backup-model')?.value.trim() || null;
    try {
      const response = await fetch('/api/v1/commands', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command_type: 'agent.provider_config', payload: {
          agent_id: agentId, backup_provider: backupProvider, backup_model: backupModel,
        } }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not save backup provider');
      log(`${agentId}: ${backupProvider ? `explicit backup ${backupProvider} saved` : 'strict provider routing saved'}`, 'success');
      if (backupFeedback) backupFeedback.textContent = backupProvider ? `${backupProvider} backup saved` : 'Strict routing saved';
      await loadAgents();
    } catch (error) {
      log(`Provider setting failed: ${error.message}`, 'action');
      if (backupFeedback) backupFeedback.textContent = `Could not save: ${error.message}`;
    }
  });

  if (btnTakeover && btnRelease) {
    btnTakeover.addEventListener('click', async () => {
      const agentId = selectedAgentName || agentSelect?.value || 'Dev-1';
      log(`Initiating takeover for ${agentId}... (10s soft budget)`, 'action');
      btnTakeover.disabled = true;

      try {
        const res = await fetch('/api/v1/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'takeover', agent_id: agentId })
        });
        const result = await res.json();
        if (!res.ok || result.status !== 'acknowledged' || !result.result?.takeover_token) {
          throw new Error(result.error || 'Takeover was not acquired');
        }
        const token = result.result.takeover_token;
        takeoverTokens.set(agentId, token);
        persistTakeoverTokens();
        log(`Takeover confirmed: ${agentId} is now HUMAN_OWNED`, 'success');
        stateBadge.textContent = 'Human Owned';
        btnRelease.disabled = false;
        if (cmdInput) cmdInput.disabled = false;
        if (btnSendCmd) btnSendCmd.disabled = false;
        if (cmdInput) cmdInput.focus();
        connectPty(agentId);
        if (pixelRenderer) {
          pixelRenderer.showSpeechBubble(agentId, 'Operator Live Takeover', 8000);
        }
        loadAgents();
      } catch (err) {
        reportTerminalIssue(`Takeover failed: ${err.message}`);
        btnTakeover.disabled = false;
      }
    });

    btnRelease.addEventListener('click', async () => {
      const agentId = selectedAgentName || agentSelect?.value || 'Dev-1';
      log(`Releasing takeover for ${agentId}...`, 'action');
      btnRelease.disabled = true;

      try {
        const res = await fetch('/api/v1/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'release', agent_id: agentId, takeover_token: takeoverTokens.get(agentId), guidance: 'Takeover completed successfully.' })
        });
        const released = await res.json();
        if (!res.ok) throw new Error(released.error || 'Release failed');
        takeoverTokens.delete(agentId);
        persistTakeoverTokens();
        log(`Takeover released: ${agentId} returned to AUTO`, 'success');
        stateBadge.textContent = 'Auto';
        btnTakeover.disabled = false;
        disconnectPty();
        clearTerminalIssue();
        setSessionConnectionState('Ready', 'Take over to connect this agent’s CLI.');
        if (cmdInput) {
          cmdInput.disabled = true;
          cmdInput.value = '';
        }
        if (btnSendCmd) btnSendCmd.disabled = true;
        loadAgents();
      } catch (err) {
        reportTerminalIssue(`Release failed: ${err.message}`);
        btnRelease.disabled = false;
      }
    });
  }

  // --- Live WebSocket PTY Interface for Takeover ---
  let ptySocket = null;
  let terminalInstance = null;
  let fitAddon = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let controlPending = false;
  let resumeRequested = false;
  let terminalReady = false;
  const cmdInput = document.getElementById('takeover-command-input');
  const btnSendCmd = document.getElementById('btn-send-command');
  const shellComposer = document.getElementById('takeover-shell-composer');
  const modeButtons = document.querySelectorAll('[data-input-mode]');
  let inputMode = 'agent_tui';

  function setSessionConnectionState(state, caption) {
    const stateEl = document.getElementById('agent-session-state');
    const captionEl = document.getElementById('agent-session-caption');
    if (stateEl) stateEl.textContent = state;
    if (captionEl) captionEl.textContent = caption;
  }

  function reportTerminalIssue(message) {
    log(message, 'action');
    if (terminalAlert) {
      terminalAlert.textContent = message;
      terminalAlert.hidden = false;
    }
    setSessionConnectionState('Unavailable', message);
    if (inputMode === 'agent_tui') terminalInstance?.writeln(`\r\n[AgentCrew] ${message}`);
  }

  function clearTerminalIssue() {
    if (terminalAlert) terminalAlert.hidden = true;
  }

  function showTerminalMode() {
    const tui = inputMode === 'agent_tui';
    if (terminalEmulator) terminalEmulator.hidden = !tui;
    if (terminal) terminal.hidden = tui;
    if (mobileKeys) mobileKeys.hidden = !tui;
    if (shellComposer) shellComposer.hidden = tui;
    if (tui && fitAddon && terminalInstance) {
      requestAnimationFrame(() => { fitAddon.fit(); sendTerminalResize(); });
    }
  }

  function sendTerminalResize() {
    if (inputMode !== 'agent_tui' || !terminalInstance || ptySocket?.readyState !== WebSocket.OPEN) return;
    ptySocket.send(JSON.stringify({ type: 'resize', cols: terminalInstance.cols, rows: terminalInstance.rows }));
  }

  function sendTerminalInput(data) {
    if (ptySocket?.readyState !== WebSocket.OPEN) return;
    if (controlPending) {
      if (/^[a-z]$/i.test(data)) data = String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64);
      controlPending = false;
      const ctrl = mobileKeys?.querySelector('[data-terminal-key="control"]');
      if (ctrl) ctrl.setAttribute('aria-pressed', 'false');
    }
    ptySocket.send(JSON.stringify({ type: 'input', data }));
  }

  mobileKeys?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-terminal-key]');
    if (!button) return;
    if (button.dataset.terminalKey === 'control') {
      controlPending = !controlPending;
      button.setAttribute('aria-pressed', String(controlPending));
      terminalInstance?.focus();
      return;
    }
    const keys = { escape: '\x1b', tab: '\t', left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B', enter: '\r', c: '\x03' };
    controlPending = false;
    const ctrl = mobileKeys?.querySelector('[data-terminal-key="control"]');
    if (ctrl) ctrl.setAttribute('aria-pressed', 'false');
    sendTerminalInput(keys[button.dataset.terminalKey]);
    terminalInstance?.focus();
  });

  if (terminalEmulator && window.Terminal && window.FitAddon) {
    new ResizeObserver(() => {
      if (terminalInstance && !terminalEmulator.hidden) {
        fitAddon.fit();
        sendTerminalResize();
      }
    }).observe(terminalEmulator);
  }

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      inputMode = button.dataset.inputMode === 'shell' ? 'shell' : 'agent_tui';
      modeButtons.forEach((candidate) => {
        const selected = candidate.dataset.inputMode === inputMode;
        candidate.classList.toggle('active', selected);
        candidate.setAttribute('aria-pressed', String(selected));
      });
      disconnectPty();
      showTerminalMode();
      if (!btnRelease.disabled) {
        connectPty(selectedAgentName || agentSelect?.value || 'Dev-1');
      }
    });
  });

  showTerminalMode();

  function connectPty(agentId) {
    disconnectPty();
    resumeRequested = false;

    const selected = liveAgents.find((agent) => agent.name === agentId);
    if (inputMode === 'agent_tui' && selected?.provider_status === 'disconnected' && !selected.active_provider) {
      reportTerminalIssue(`${selected.provider} CLI unavailable or unqualified. Configure an explicit backup CLI or release takeover.`);
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = takeoverTokens.get(agentId);
    if (!token) { log('[Session] Takeover token missing; connection unavailable', 'action'); return; }
    const wsUrl = `${proto}//${window.location.host}/api/v1/pty?mode=${inputMode}&agent_id=${encodeURIComponent(agentId)}&token=${encodeURIComponent(token)}`;

    try {
      const socket = new WebSocket(wsUrl);
      ptySocket = socket;

      if (inputMode === 'agent_tui') {
        if (!window.Terminal || !window.FitAddon) throw new Error('Terminal assets failed to load');
        terminalInstance = new window.Terminal({
          cursorBlink: true, scrollback: 4000, fontSize: 14, lineHeight: 1.35, screenReaderMode: true,
          theme: { background: '#0d111a', foreground: '#e5eaf2', cursor: '#71baf1' },
        });
        fitAddon = new window.FitAddon.FitAddon();
        terminalInstance.loadAddon(fitAddon);
        terminalInstance.open(terminalEmulator);
        fitAddon.fit();
        terminalInstance.onData(sendTerminalInput);
      }

      socket.onopen = () => {
        log(`[Session] Connected ${inputMode} channel for ${agentId}`, 'success');
        setSessionConnectionState('Connecting', 'WebSocket connected; waiting for the CLI…');
        if (inputMode === 'agent_tui') { sendTerminalResize(); terminalInstance?.focus(); }
      };

      socket.onmessage = (event) => {
        if (ptySocket !== socket) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'ready') {
            reconnectAttempts = 0;
            terminalReady = true;
            clearTerminalIssue();
            resumeRequested = Boolean(msg.resumeRequested);
            const label = `${msg.provider || 'Shell'}${msg.fallback ? ' (explicit backup)' : ''}`;
            log(`[PTY Ready] ${label} · ${msg.resumeRequested ? 'resume requested; verify CLI state' : 'new conversation (native ID not yet tracked)'}`, 'system');
            setSessionConnectionState('Connected', `${label} CLI connected${msg.resumeRequested ? '; verify resumed context in CLI' : ''}.`);
          } else if (msg.type === 'output') {
            if (inputMode === 'agent_tui') terminalInstance?.write(msg.data);
            else log(msg.data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim());
          } else if (msg.type === 'exit') {
            terminalReady = false;
            const exitText = resumeRequested && msg.exitCode !== 0
              ? 'Native resume failed; this CLI session is unavailable.'
              : `CLI exited with code ${msg.exitCode}`;
            reportTerminalIssue(exitText);
          } else if (msg.type === 'error') {
            reportTerminalIssue(msg.data);
          }
        } catch (_) {
          log(event.data);
        }
      };

      socket.onclose = () => {
        if (ptySocket !== socket) return;
        terminalReady = false;
        reportTerminalIssue('CLI connection lost. Reconnecting if takeover is still active…');
        ptySocket = null;
        if (takeoverTokens.has(agentId) && ++reconnectAttempts <= 3) {
          reconnectTimer = setTimeout(() => connectPty(agentId), 1200);
        } else if (takeoverTokens.has(agentId)) {
          reportTerminalIssue('CLI connection unavailable. Check provider readiness, then refresh this tab to retry.');
        }
      };

      socket.onerror = (err) => {
        if (ptySocket !== socket) return;
        terminalReady = false;
        reportTerminalIssue('CLI WebSocket connection failed. Check provider availability.');
      };
    } catch (err) {
      reportTerminalIssue(`Unable to connect: ${err.message}`);
    }
  }

  function disconnectPty() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    terminalReady = false;
    controlPending = false;
    const ctrl = mobileKeys?.querySelector('[data-terminal-key="control"]');
    if (ctrl) ctrl.setAttribute('aria-pressed', 'false');
    if (ptySocket) {
      try { ptySocket.close(); } catch (_) {}
      ptySocket = null;
    }
    terminalInstance?.dispose();
    terminalInstance = null;
    fitAddon = null;
  }

  async function executeOperatorCommand() {
    if (inputMode !== 'shell') return;
    if (!cmdInput || !cmdInput.value.trim()) return;
    const commandText = cmdInput.value.trim();
    const agentId = selectedAgentName || agentSelect?.value || 'Dev-1';

    log(`[Operator > ${agentId}]$ ${commandText}`, 'action');
    cmdInput.value = '';

    if (ptySocket && ptySocket.readyState === WebSocket.OPEN) {
      ptySocket.send(JSON.stringify({ type: 'input', data: commandText, mode: inputMode }));
    } else {
      // Fallback to HTTP command dispatch
      try {
        const res = await fetch('/api/v1/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command_type: 'session.exec',
            payload: { agent_id: agentId, command: commandText, mode: inputMode, takeover_token: takeoverTokens.get(agentId) }
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Command rejected');
        if (data.result && data.result.output) {
          log(data.result.output, 'success');
        }
      } catch (err) {
        log(`Execution error: ${err.message}`, 'action');
      }
    }
  }

  if (btnSendCmd && cmdInput) {
    btnSendCmd.addEventListener('click', executeOperatorCommand);
    cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        executeOperatorCommand();
      }
    });
  }

  // Load Tasks into Kanban
  async function loadTasks() {
    let tasks = [];
    let fetchError = null;
    try {
      const res = await fetch('/api/v1/tasks');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (Array.isArray(data.tasks)) {
        tasks = data.tasks;
      }
    } catch (err) {
      console.warn('Failed to fetch tasks from /api/v1/tasks:', err);
      fetchError = err;
    }
    cachedTasks = tasks;

    const stages = [
      { key: 'planning', label: 'Planning' },
      { key: 'in_progress', label: 'In Progress' },
      { key: 'review', label: 'Review' },
      { key: 'qa', label: 'QA' },
      { key: 'done', label: 'Done' }
    ];

    stages.forEach(({ key: stage, label }) => {
      const col = document.getElementById(`tasks-${stage}`);
      if (!col) return;
      col.replaceChildren();

      if (fetchError) {
        const errEl = document.createElement('div');
        errEl.className = 'kanban-error-state';
        errEl.innerHTML = `
          <span>Failed to load tasks</span>
          <button type="button" class="btn btn-secondary btn-sm kanban-retry-btn">Retry</button>
        `;
        const retryBtn = errEl.querySelector('.kanban-retry-btn');
        if (retryBtn) {
          retryBtn.addEventListener('click', () => loadTasks());
        }
        col.appendChild(errEl);
        return;
      }

      const stageTasks = tasks.filter(t => t.stage === stage);
      if (stageTasks.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'kanban-empty-placeholder';
        emptyEl.textContent = `No tasks in ${label}`;
        col.appendChild(emptyEl);
        return;
      }

      stageTasks.forEach(task => {
        const item = document.createElement('div');
        item.className = 'task-item';
        const prioBadge = task.priority === 'high' ? '<span class="badge badge-warning" style="font-size:0.65rem; padding: 2px 6px;">high</span>' : '';
        item.innerHTML = `
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 4px;">
            <span class="task-id" style="font-weight:700;">${escapeHtml(task.id || '')}</span>
            ${prioBadge}
          </div>
          <div class="task-title" style="font-weight:600; font-size:0.85rem; line-height: 1.3; margin-bottom: 4px;">${escapeHtml(task.title || '')}</div>
          <div class="task-owner" style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(task.owner || '')}</div>
        `;
        col.appendChild(item);
      });
    });
  }

  // Load Real Repository Data & Analytics
  async function loadRealRepositoryData() {
    try {
      // 1. Fetch Pull Requests from live repo
      const prRes = await fetch('/api/v1/pull-requests');
      const prData = await prRes.json();
      analyticsData.pullRequests = Array.isArray(prData.pullRequests) ? prData.pullRequests : [];
      renderPRList('all');
      if (analyticsData.pullRequests.length > 0) {
        if (window.matchMedia('(min-width: 1181px)').matches) {
          selectPR(analyticsData.pullRequests[0]);
        }
      } else {
        closePRPanel();
      }

      // 2. Fetch Repositories & Worktrees from live repo
      const repoRes = await fetch('/api/v1/repositories');
      const repoData = await repoRes.json();
      analyticsData.repositories = Array.isArray(repoData.repositories) ? repoData.repositories : [];
      renderRepositories('');

      // 3. Fetch Analytics & KPIs from live repo
      const analRes = await fetch('/api/v1/analytics');
      const analData = await analRes.json();
      if (analData.analytics) {
        if (analData.analytics.kpis) {
          analyticsData.kpis = analData.analytics.kpis;
        }
        updateOverview('week');
      }
    } catch (err) {
      console.warn('Failed to load real repository data:', err);
    }
  }

  // --- Multi-Project Management & Wizard (TASK-38, TASK-39) ---
  const projectDockZones = document.getElementById('project-dock-zones');
  const btnOpenProjectWizard = document.getElementById('btn-open-project-wizard');
  const projectWizardModal = document.getElementById('project-wizard-modal');
  const btnCloseProjectWizard = document.getElementById('btn-close-project-wizard');
  const btnCancelProjectWizard = document.getElementById('btn-cancel-project-wizard');
  const projectWizardForm = document.getElementById('project-wizard-form');
  const wizardErrorMsg = document.getElementById('wizard-error-msg');
  const btnPopoutTerminal = document.getElementById('btn-popout-terminal');

  async function loadProjects() {
    if (!projectDockZones) return;
    try {
      const res = await fetch('/api/v1/projects');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch projects');
      const projects = Array.isArray(data.projects) ? data.projects : [];
      const active = projects.find(p => p.is_active);
      if (active) currentProjectId = active.id;
      renderProjectDock(projects);
    } catch (err) {
      console.warn('Could not load projects:', err);
    }
  }

  function renderProjectDock(projects) {
    if (!projectDockZones) return;
    projectDockZones.innerHTML = '';

    const zones = [
      { key: 'work', label: 'Work' },
      { key: 'personal', label: 'Personal' },
      { key: 'side', label: 'Side Projects' }
    ];

    zones.forEach(zone => {
      const zoneProjects = projects.filter(p => (p.zone || 'work') === zone.key);
      if (zoneProjects.length === 0) return;

      const group = document.createElement('div');
      group.className = 'dock-zone-group project-zone-group';

      zoneProjects.forEach(proj => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `project-dock-item ${proj.is_active ? 'active' : ''}`;
        const initial = (proj.name || 'P').trim().charAt(0).toUpperCase();
        item.title = `${proj.name} (${proj.mode === 'multi_worktree' ? 'Multi-Worktree' : 'Independent'})\n${proj.path}`;
        item.innerHTML = `
          <div class="project-dock-avatar">${escapeHtml(initial)}</div>
          <span class="project-dock-tooltip">${escapeHtml(proj.name)}</span>
        `;
        item.addEventListener('click', async () => {
          if (proj.is_active) {
            switchView('view-team-room');
            return;
          }
          try {
            const actRes = await fetch(`/api/v1/projects/${encodeURIComponent(proj.id)}/activate`, {
              method: 'POST'
            });
            const actData = await actRes.json();
            if (!actRes.ok) throw new Error(actData.error || 'Activation failed');
            currentProjectId = proj.id;
            log(`Switched active project to ${proj.name}`, 'system');
            switchView('view-team-room');
            await loadProjects();
            await loadWorkspace();
            await loadAgents();
            await loadTasks();
            await loadRealRepositoryData();
            if (liveAgents.length > 0) {
              selectAgent(liveAgents[0]);
            }
          } catch (e) {
            log(`Could not switch project: ${e.message}`, 'action');
          }
        });
        group.appendChild(item);
      });

      projectDockZones.appendChild(group);
    });
  }

  // --- Session Tabs (Terminal vs Slack Team Feed) ---
  if (tabBtnTerminal && tabBtnChat) {
    tabBtnTerminal.addEventListener('click', () => {
      tabBtnTerminal.classList.add('active');
      tabBtnTerminal.setAttribute('aria-selected', 'true');
      tabBtnChat.classList.remove('active');
      tabBtnChat.setAttribute('aria-selected', 'false');
      if (panelTerminalView) panelTerminalView.hidden = false;
      if (panelChatView) panelChatView.hidden = true;
      if (fitAddon && terminalInstance && !terminalEmulator.hidden) {
        requestAnimationFrame(() => { fitAddon.fit(); sendTerminalResize(); });
      }
    });

    tabBtnChat.addEventListener('click', () => {
      tabBtnChat.classList.add('active');
      tabBtnChat.setAttribute('aria-selected', 'true');
      tabBtnTerminal.classList.remove('active');
      tabBtnTerminal.setAttribute('aria-selected', 'false');
      if (panelTerminalView) panelTerminalView.hidden = true;
      if (panelChatView) panelChatView.hidden = false;
      if (teamRoomChatFeed) teamRoomChatFeed.scrollTop = teamRoomChatFeed.scrollHeight;
      teamChatInput?.focus();
    });
  }

  // --- Shared Accessible Dialog Modal & Global Toast Notifications (Phase 2) ---
  const sharedDialogModal = document.getElementById('shared-dialog-modal');
  const sharedDialogCard = document.getElementById('shared-dialog-card');
  const sharedDialogTitle = document.getElementById('shared-dialog-title');
  const sharedDialogSubtitle = document.getElementById('shared-dialog-subtitle');
  const sharedDialogBody = document.getElementById('shared-dialog-body');
  const btnCloseSharedDialog = document.getElementById('btn-close-shared-dialog');
  const globalToastContainer = document.getElementById('global-toast-container');
  let activeModalCloseHandler = null;
  let lastDialogTrigger = null;

  function openModalDialog({ title, subtitle, contentHtml, onRender, onClose }) {
    if (!sharedDialogModal || !sharedDialogBody) return;
    lastDialogTrigger = document.activeElement;
    if (sharedDialogTitle) sharedDialogTitle.textContent = title || 'Dialog';
    if (sharedDialogSubtitle) {
      if (subtitle) {
        sharedDialogSubtitle.textContent = subtitle;
        sharedDialogSubtitle.hidden = false;
      } else {
        sharedDialogSubtitle.hidden = true;
      }
    }
    sharedDialogBody.innerHTML = contentHtml || '';
    sharedDialogModal.hidden = false;
    activeModalCloseHandler = onClose || null;

    if (typeof onRender === 'function') {
      try { onRender(sharedDialogBody); } catch (err) { console.warn('Dialog onRender error:', err); }
    }

    const firstFocusable = sharedDialogCard?.querySelector('input:not([type="hidden"]), select, textarea, button:not(#btn-close-shared-dialog)') || btnCloseSharedDialog;
    firstFocusable?.focus();
  }

  function closeModalDialog() {
    if (!sharedDialogModal || sharedDialogModal.hidden) return;
    sharedDialogModal.hidden = true;
    if (sharedDialogBody) sharedDialogBody.innerHTML = '';
    if (typeof activeModalCloseHandler === 'function') {
      const handler = activeModalCloseHandler;
      activeModalCloseHandler = null;
      try { handler(); } catch (_) {}
    }
    if (lastDialogTrigger && typeof lastDialogTrigger.focus === 'function') {
      try { lastDialogTrigger.focus(); } catch (_) {}
      lastDialogTrigger = null;
    }
  }

  if (btnCloseSharedDialog) {
    btnCloseSharedDialog.addEventListener('click', closeModalDialog);
  }

  if (sharedDialogModal) {
    sharedDialogModal.addEventListener('click', (e) => {
      if (e.target === sharedDialogModal) {
        closeModalDialog();
      }
    });

    sharedDialogModal.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        const focusables = Array.from(sharedDialogCard?.querySelectorAll(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) || []);
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !sharedDialogCard?.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !sharedDialogCard?.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    });
  }

  function showToast(message, type = 'info', durationMs = 3500) {
    if (!globalToastContainer) return;
    const toast = document.createElement('div');
    toast.className = `global-toast-item toast-${type}`;
    const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warning' ? '⚠' : 'ℹ';
    toast.innerHTML = `
      <span class="toast-icon">${icon}</span>
      <span class="toast-message">${escapeHtml(message)}</span>
      <button type="button" class="global-toast-close" aria-label="Close notification">✕</button>
    `;
    const closeBtn = toast.querySelector('.global-toast-close');
    let timer = null;
    const dismiss = () => {
      if (timer) clearTimeout(timer);
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px) scale(0.96)';
      toast.style.transition = 'all 0.15s ease';
      setTimeout(() => toast.remove(), 160);
    };
    closeBtn?.addEventListener('click', dismiss);
    timer = setTimeout(dismiss, durationMs);
    globalToastContainer.appendChild(toast);
  }

  // --- Cross-Module Synchronization Hooks & Public API ---
  window.agentCrewRefreshTasks = loadTasks;
  window.agentCrewRefreshAgents = loadAgents;
  window.agentCrewReloadFeed = () => {
    const ag = liveAgents.find(a => a.name === selectedAgentName);
    if (ag) loadAgentRoomFeed(ag);
  };
  window.openModalDialog = openModalDialog;
  window.closeModalDialog = closeModalDialog;
  window.showToast = showToast;

  // --- Scope Modifications & Popups (P-xxx Tickets) ---
  async function loadPopups() {
    const popupList = document.getElementById('popup-list');
    if (!popupList) return;
    try {
      const res = await fetch('/api/v1/popups');
      if (!res.ok) throw new Error('Failed to fetch popups');
      const data = await res.json();
      const popups = Array.isArray(data.popups) ? data.popups : [];
      popupList.replaceChildren();

      if (!popups.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No active scope modification tickets. Click "Propose Scope Change" to record mid-flight requirement adjustments.';
        popupList.appendChild(empty);
        return;
      }

      popups.forEach(ticket => {
        const item = document.createElement('div');
        item.className = 'popup-item';
        item.dataset.ticketId = ticket.id;

        const isAwaiting = ticket.status === 'awaiting_approval';
        const delay = ticket.impact?.estimatedDelayHours || 0;
        const tasks = (ticket.affectedTasks || []).join(', ') || 'None';

        item.innerHTML = `
          <div class="popup-item-header">
            <div>
              <span class="popup-ticket-id">${escapeHtml(ticket.id)}</span>
              <strong style="margin-left: 8px;">${escapeHtml(ticket.title || 'Scope Change')}</strong>
            </div>
            <span class="badge ${ticket.status === 'approved' ? 'badge-success' : (ticket.status === 'rejected' ? 'badge-danger' : 'badge-warning')}">${escapeHtml(ticket.status || 'unknown')}</span>
          </div>
          <p style="margin: 4px 0; font-size: 13px; color: var(--text-muted);">${escapeHtml(ticket.description || ticket.impact?.discardedWorkSummary || 'No details provided.')}</p>
          <div style="font-size: 12px; color: #94a3b8;">
            <span>Affected: <strong>${escapeHtml(tasks)}</strong></span> ·
            <span>Est. Delay: <strong>${delay}h</strong></span> ·
            <span>Req by: <strong>${escapeHtml(ticket.requestedBy || 'operator')}</strong></span>
          </div>
          ${isAwaiting ? `
            <div class="popup-item-actions">
              <button type="button" class="btn btn-sm btn-success btn-approve-popup" data-ticket-id="${escapeHtml(ticket.id)}">Approve Scope</button>
              <button type="button" class="btn btn-sm btn-danger btn-reject-popup" data-ticket-id="${escapeHtml(ticket.id)}">Reject</button>
            </div>
          ` : ''}
        `;

        item.querySelector('.btn-approve-popup')?.addEventListener('click', async () => {
          await decidePopup(ticket.id, 'approve');
        });
        item.querySelector('.btn-reject-popup')?.addEventListener('click', async () => {
          await decidePopup(ticket.id, 'reject');
        });

        popupList.appendChild(item);
      });
    } catch (err) {
      console.warn('Could not load popups:', err);
    }
  }

  async function decidePopup(ticketId, decision) {
    try {
      const res = await fetch('/api/v1/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command_type: 'popup.decide',
          payload: { ticket_id: ticketId, decision }
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to ${decision} popup`);
      showToast(`Scope ticket ${ticketId} ${decision}d.`, 'success');
      await Promise.all([loadTasks(), loadPopups()]);
    } catch (err) {
      showToast(err.message, 'warning');
      await Promise.all([loadTasks(), loadPopups()]);
    }
  }

  const btnNewPopup = document.getElementById('btn-new-popup');
  if (btnNewPopup) {
    btnNewPopup.addEventListener('click', () => {
      openModalDialog({
        title: 'Propose Scope Change (P-xxx)',
        subtitle: 'Record mid-flight requirement adjustments and pause affected tasks for operator sign-off',
        contentHtml: `
          <form id="form-new-popup" style="display:flex;flex-direction:column;gap:12px;">
            <div>
              <label style="display:block;margin-bottom:4px;font-size:12px;color:#94a3b8;text-transform:uppercase;">Change Title</label>
              <input type="text" id="popup-input-title" required placeholder="e.g. Add JWT token expiry" style="width:100%;padding:8px 12px;background:#141d2e;border:1px solid rgba(56,189,248,0.3);border-radius:8px;color:#f8fafc;box-sizing:border-box;">
            </div>
            <div>
              <label style="display:block;margin-bottom:4px;font-size:12px;color:#94a3b8;text-transform:uppercase;">Description & Rationale</label>
              <textarea id="popup-input-description" rows="3" required placeholder="Describe why this scope adjustment is necessary..." style="width:100%;padding:8px 12px;background:#141d2e;border:1px solid rgba(56,189,248,0.3);border-radius:8px;color:#f8fafc;box-sizing:border-box;resize:vertical;"></textarea>
            </div>
            <div>
              <label style="display:block;margin-bottom:4px;font-size:12px;color:#94a3b8;text-transform:uppercase;">Affected Tasks (comma-separated IDs)</label>
              <input type="text" id="popup-input-tasks" placeholder="e.g. TASK-14, TASK-18" style="width:100%;padding:8px 12px;background:#141d2e;border:1px solid rgba(56,189,248,0.3);border-radius:8px;color:#f8fafc;box-sizing:border-box;">
            </div>
            <div>
              <label style="display:block;margin-bottom:4px;font-size:12px;color:#94a3b8;text-transform:uppercase;">Estimated Delay (hours)</label>
              <input type="number" id="popup-input-delay" min="0" value="2" style="width:100%;padding:8px 12px;background:#141d2e;border:1px solid rgba(56,189,248,0.3);border-radius:8px;color:#f8fafc;box-sizing:border-box;">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
              <button type="button" class="btn btn-secondary" id="btn-cancel-popup">Cancel</button>
              <button type="submit" class="btn btn-warning" id="btn-submit-popup">Propose Ticket</button>
            </div>
          </form>
        `,
        onRender: (body) => {
          body.querySelector('#btn-cancel-popup')?.addEventListener('click', closeModalDialog);
          body.querySelector('#form-new-popup')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = body.querySelector('#popup-input-title')?.value.trim();
            const description = body.querySelector('#popup-input-description')?.value.trim();
            const affectedStr = body.querySelector('#popup-input-tasks')?.value.trim() || '';
            const delayHours = Number(body.querySelector('#popup-input-delay')?.value) || 0;
            const affectedTasks = affectedStr.split(',').map(s => s.trim()).filter(Boolean);

            const submitBtn = body.querySelector('#btn-submit-popup');
            if (submitBtn) submitBtn.disabled = true;

            try {
              const res = await fetch('/api/v1/commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  command_type: 'popup.propose',
                  payload: {
                    title,
                    description,
                    estimated_impact: {
                      affected_tasks: affectedTasks,
                      delay_hours: delayHours
                    }
                  }
                })
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Failed to propose scope change');
              closeModalDialog();
              showToast(`Scope change ticket ${data.result?.ticket?.id || 'P-xxx'} proposed!`, 'success');
              await Promise.all([loadTasks(), loadPopups()]);
            } catch (err) {
              showToast(err.message, 'warning');
              if (submitBtn) submitBtn.disabled = false;
            }
          });
        }
      });
    });
  }

  // --- Composer Attachments State & Renderer (Phase 2) ---
  const activeComposerAttachments = {
    tools: new Set(),
    context: new Set(),
    docs: new Set()
  };

  function renderComposerAttachments() {
    const container = document.getElementById('composer-attachments');
    if (!container) return;
    container.replaceChildren();

    const totalCount = activeComposerAttachments.tools.size + activeComposerAttachments.context.size + activeComposerAttachments.docs.size;
    if (totalCount === 0) {
      container.hidden = true;
      return;
    }
    container.hidden = false;

    activeComposerAttachments.tools.forEach(tool => {
      const chip = createAttachmentChip('🔧', `tool:${tool}`, () => {
        activeComposerAttachments.tools.delete(tool);
        renderComposerAttachments();
      });
      container.appendChild(chip);
    });

    activeComposerAttachments.context.forEach(ctx => {
      const chip = createAttachmentChip('📎', ctx, () => {
        activeComposerAttachments.context.delete(ctx);
        renderComposerAttachments();
      });
      container.appendChild(chip);
    });

    activeComposerAttachments.docs.forEach(doc => {
      const chip = createAttachmentChip('📖', doc, () => {
        activeComposerAttachments.docs.delete(doc);
        renderComposerAttachments();
      });
      container.appendChild(chip);
    });
  }

  function createAttachmentChip(icon, label, onRemove) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.innerHTML = `
      <span>${icon}</span>
      <span class="chip-label">${escapeHtml(label)}</span>
      <button type="button" class="chip-remove-btn" aria-label="Remove ${escapeHtml(label)}">✕</button>
    `;
    chip.querySelector('.chip-remove-btn').addEventListener('click', onRemove);
    return chip;
  }

  // --- Slack-like Chat Sender ---
  async function sendChatMessage() {
    if (!teamChatInput) return;
    const rawText = teamChatInput.value;
    const trimmed = rawText.trim();
    if (!trimmed) return;
    if (isPromptInFlight) return; // Prevent duplicate send while in flight

    const targetAgent = liveAgents.find(a => a.name === selectedAgentName) || liveAgents[0] || { name: 'Dev-1', role: 'Full-Stack Developer' };
    const agentName = targetAgent.name || 'Dev-1';

    const myController = new AbortController();
    promptAbortController = myController;
    inFlightAgentName = agentName;
    setPromptInFlight(true, `WORKING · ${agentName.toUpperCase()} THINKING`);

    // Optimistically clear input, preserving rawText in case of failure
    teamChatInput.value = '';

    // Snapshot and clear attachments at send start
    const sentTools = [...activeComposerAttachments.tools];
    const sentContext = [...activeComposerAttachments.context];
    const sentDocs = [...activeComposerAttachments.docs];
    activeComposerAttachments.tools.clear();
    activeComposerAttachments.context.clear();
    activeComposerAttachments.docs.clear();
    renderComposerAttachments();

    // Append human message to feed (appendRoomMessage records renderedMessageIds)
    const tempMsgId = 'human-' + Date.now();
    const optimisticBubble = appendRoomMessage({
      id: tempMsgId,
      client_turn_id: tempMsgId,
      sender_name: 'You',
      sender_type: 'human',
      text: trimmed,
      created_at: new Date().toISOString()
    });
    if (optimisticBubble) {
      optimisticBubble.dataset.clientTurnId = tempMsgId;
    }

    // Show pending indicator in feed
    appendPendingIndicator(agentName);

    // Format text with mention if not present
    const mention = `@${agentName}`;
    let dispatchText = trimmed.includes(mention) ? trimmed : `${mention} ${trimmed}`;

    const attachmentNotes = [];
    if (sentTools.length > 0) attachmentNotes.push(`Tools: [${sentTools.join(', ')}]`);
    if (sentContext.length > 0) attachmentNotes.push(`Context: [${sentContext.join(', ')}]`);
    if (sentDocs.length > 0) attachmentNotes.push(`Docs: [${sentDocs.join(', ')}]`);
    if (attachmentNotes.length > 0) {
      dispatchText += '\n\n' + attachmentNotes.join(' · ');
    }

    try {
      let dispatched = false;

      // 1. Primary dispatch via POST /api/v1/room/messages
      try {
        const res = await fetch('/api/v1/room/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: 'team-activity',
            sender_type: 'human',
            sender_id: 'operator',
            sender_name: 'You',
            text: dispatchText,
            metadata: {
              target_agent: agentName,
              turn_id: tempMsgId,
              client_turn_id: tempMsgId,
              attached_tools: sentTools,
              attached_context: sentContext,
              attached_docs: sentDocs
            }
          }),
          signal: myController.signal
        });

        if (res.ok) {
          const data = await res.json();
          if (data.message?.id) {
            renderedMessageIds.add(data.message.id);
          }
          if (data.dispatched === false) {
            if (promptAbortController === myController) {
              removePendingIndicator();
              setPromptInFlight(false);
            }
            showToast(data.reason || 'Message saved (scheduler paused)', 'warning');
            return;
          }
          dispatched = true;
        }
      } catch (postErr) {
        if (postErr.name === 'AbortError') throw postErr;
        console.warn('POST /api/v1/room/messages failed, trying takeover fallback:', postErr);
      }

      // 2. Fallback to session.takeover + session.exec if room/messages was not accepted
      if (!dispatched) {
        let token = takeoverTokens.get(agentName);
        if (!token) {
          const tokRes = await fetch('/api/v1/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              command_type: 'session.takeover',
              payload: { agent_id: agentName }
            }),
            signal: myController.signal
          });
          const tokData = await tokRes.json();
          if (tokData.result?.takeover_token) {
            token = tokData.result.takeover_token;
            takeoverTokens.set(agentName, token);
            persistTakeoverTokens();
          }
        }

        const execRes = await fetch('/api/v1/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command_type: 'session.exec',
            payload: {
              agent_id: agentName,
              command: dispatchText,
              mode: 'chat',
              takeover_token: token
            }
          }),
          signal: myController.signal
        });
        const execData = await execRes.json();
        if (!execRes.ok) throw new Error(execData.error || 'Failed to dispatch prompt');
        if (execData.result && execData.result.output) {
          if (promptAbortController === myController) {
            removePendingIndicator();
            setPromptInFlight(false);
          }
          const replyId = 'reply-' + Date.now();
          appendRoomMessage({
            id: replyId,
            sender_name: agentName,
            sender_type: 'agent',
            text: execData.result.output,
            created_at: new Date().toISOString()
          });
        }
      }
    } catch (err) {
      if (promptAbortController === myController) {
        removePendingIndicator();
        setPromptInFlight(false);
        promptAbortController = null;
      }
      if (err.name === 'AbortError') {
        appendRoomMessage('System', 'Prompt cancelled by operator.', false, '!');
      } else {
        // PRESERVE INPUT TEXT NON-DESTRUCTIVELY ON FAILURE
        if (!teamChatInput.value.trim()) {
          teamChatInput.value = rawText;
        } else {
          teamChatInput.value = rawText + '\n' + teamChatInput.value;
        }
        sentTools.forEach(t => activeComposerAttachments.tools.add(t));
        sentContext.forEach(c => activeComposerAttachments.context.add(c));
        sentDocs.forEach(d => activeComposerAttachments.docs.add(d));
        renderComposerAttachments();
        appendRoomMessage('System', `Error sending prompt: ${err.message}`, false, '!');
      }
    } finally {
      if (promptAbortController === myController) {
        promptAbortController = null;
      }
    }
  }

  if (btnSendChat && teamChatInput) {
    btnSendChat.addEventListener('click', sendChatMessage);
    teamChatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        sendChatMessage();
      }
    });
  }

  const btnCancelChat = document.getElementById('btn-cancel-chat');
  if (btnCancelChat) {
    btnCancelChat.addEventListener('click', cancelPendingPrompt);
  }

  // --- AgentsRoom Cockpit Utility Controls ---
  const btnUtilityTerminal = document.getElementById('btn-utility-terminal');
  if (btnUtilityTerminal) {
    btnUtilityTerminal.addEventListener('click', () => {
      const isTerminalOpen = panelTerminalView && !panelTerminalView.hidden;
      if (isTerminalOpen) {
        if (panelTerminalView) panelTerminalView.hidden = true;
        if (panelChatView) panelChatView.hidden = false;
        btnUtilityTerminal.classList.remove('active');
      } else {
        if (panelTerminalView) panelTerminalView.hidden = false;
        if (panelChatView) panelChatView.hidden = true;
        btnUtilityTerminal.classList.add('active');
        if (fitAddon && terminalInstance && !terminalEmulator.hidden) {
          requestAnimationFrame(() => { fitAddon.fit(); sendTerminalResize(); });
        }
      }
    });
  }

  // AgentsRoom Cockpit Utility Controls (delegated to cockpit-actions.js)
  const btnToggleFilesChanges = document.getElementById('btn-toggle-files-changes');
  const btnRailChat = document.getElementById('btn-rail-chat');

  // --- Topbar Controls & Quick Switchers ---
  document.getElementById('topbar-home-btn')?.addEventListener('click', () => switchView('view-overview'));
  document.getElementById('topbar-inbox-btn')?.addEventListener('click', () => switchView('view-kanban'));
  document.getElementById('btn-topbar-team')?.addEventListener('click', () => switchView('view-team-room'));
  document.getElementById('btn-topbar-repos')?.addEventListener('click', () => switchView('view-repositories'));
  document.getElementById('btn-topbar-stats')?.addEventListener('click', () => switchView('view-observability'));
  document.getElementById('btn-topbar-settings')?.addEventListener('click', () => switchView('view-settings'));
  document.getElementById('footer-settings-btn')?.addEventListener('click', () => switchView('view-settings'));
  document.getElementById('btn-open-backlog')?.addEventListener('click', () => switchView('view-kanban'));
  document.getElementById('btn-close-cockpit')?.addEventListener('click', () => switchView('view-overview'));

  document.getElementById('topbar-add-btn')?.addEventListener('click', () => {
    if (projectWizardModal) {
      projectWizardModal.hidden = false;
      document.getElementById('wizard-project-name')?.focus();
    }
  });

  document.getElementById('footer-theme-btn')?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
  });

  // Topbar Needs Input Badge Click
  document.getElementById('topbar-needs-input-badge')?.addEventListener('click', () => {
    switchView('view-team-room');
    activeAgentFilter = 'needs-you';
    agentFilterButtons.forEach(btn => {
      const active = btn.dataset.agentFilter === 'needs-you';
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    renderAgentRoster();
    const needsAgent = liveAgents.find(a => getAgentStatus(a) === 'needs-you') || liveAgents[0];
    if (needsAgent) {
      selectAgent(needsAgent);
      teamChatInput?.focus();
    }
  });

  // Topbar Toggle Team Sidebar Button
  const topbarTeamBtn = document.getElementById('topbar-team-btn');
  if (topbarTeamBtn) {
    topbarTeamBtn.addEventListener('click', () => {
      const rosterPanel = document.querySelector('.agent-roster-panel');
      const currentActiveView = document.querySelector('.fullscreen-view.active');
      if (currentActiveView?.id !== 'view-team-room') {
        switchView('view-team-room');
        if (rosterPanel) rosterPanel.classList.remove('collapsed');
      } else if (rosterPanel) {
        rosterPanel.classList.toggle('collapsed');
      }
    });
  }

  // Topbar Active Turns Modal
  const topbarSparklePill = document.getElementById('topbar-sparkle-pill');
  if (topbarSparklePill) {
    topbarSparklePill.addEventListener('click', () => {
      const working = liveAgents.filter(a => getAgentStatus(a) === 'working');
      const needs = liveAgents.filter(a => getAgentStatus(a) === 'needs-you');
      const turnsCount = working.length || (isPromptInFlight ? 1 : 0);

      const workingListHtml = working.length > 0
        ? working.map(a => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#141d2e;border-radius:8px;margin-bottom:6px;">
              <div>
                <strong>${escapeHtml(a.name)}</strong> · <span style="color:#94a3b8;font-size:12px;">${escapeHtml(a.role || 'Agent')}</span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" data-goto-agent="${escapeHtml(a.name)}">Focus Chat</button>
            </div>
          `).join('')
        : `<p style="color:#94a3b8;font-style:italic;margin:8px 0;">No agents currently executing active turns.</p>`;

      openModalDialog({
        title: 'Active Agent Turns & Concurrency',
        subtitle: `Currently ${turnsCount} turn(s) active · Concurrency Limit: 4`,
        contentHtml: `
          <div style="display:flex;gap:12px;margin-bottom:16px;">
            <div style="flex:1;background:#141d2e;border:1px solid rgba(56,189,248,0.2);border-radius:8px;padding:12px;text-align:center;">
              <div style="font-size:24px;font-weight:700;color:#38bdf8;">${turnsCount}</div>
              <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;">Active Turns</div>
            </div>
            <div style="flex:1;background:#141d2e;border:1px solid rgba(56,189,248,0.2);border-radius:8px;padding:12px;text-align:center;">
              <div style="font-size:24px;font-weight:700;color:#22c55e;">${liveAgents.length}</div>
              <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;">Total Agents</div>
            </div>
            <div style="flex:1;background:#141d2e;border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:12px;text-align:center;">
              <div style="font-size:24px;font-weight:700;color:#ef4444;">${needs.length}</div>
              <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;">Needs Attention</div>
            </div>
          </div>
          <h4 style="margin:12px 0 8px 0;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">Active Working Agents</h4>
          <div id="modal-working-agents-list">
            ${workingListHtml}
          </div>
          <div style="margin-top:20px;text-align:right;">
            <button type="button" class="btn btn-secondary" id="btn-close-turns-modal">Close</button>
          </div>
        `,
        onRender: (body) => {
          body.querySelector('#btn-close-turns-modal')?.addEventListener('click', closeModalDialog);
          body.querySelectorAll('[data-goto-agent]').forEach(btn => {
            btn.addEventListener('click', () => {
              const agentName = btn.dataset.gotoAgent;
              closeModalDialog();
              switchView('view-team-room');
              selectAgent(agentName);
              teamChatInput?.focus();
            });
          });
        }
      });
    });
  }

  // Topbar Help & Keyboard Shortcuts Modal
  const topbarHelpBtn = document.getElementById('topbar-help-btn');
  if (topbarHelpBtn) {
    topbarHelpBtn.addEventListener('click', () => {
      openModalDialog({
        title: 'AgentCrew Help & Keyboard Shortcuts',
        subtitle: 'Productivity guide and keyboard accelerators for high-velocity orchestration',
        contentHtml: `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
            <div style="background:#141d2e;padding:14px;border-radius:10px;border:1px solid rgba(56,189,248,0.15);">
              <h4 style="margin:0 0 10px 0;color:#38bdf8;font-size:13px;">Global Shortcuts</h4>
              <ul style="margin:0;padding-left:18px;font-size:12.5px;color:#e2e8f0;display:flex;flex-direction:column;gap:6px;">
                <li><kbd>/</kbd> Focus global search palette</li>
                <li><kbd>Esc</kbd> Close modals, palettes, and dropdowns</li>
                <li><kbd>Enter</kbd> Send prompt in composer</li>
                <li><kbd>Shift+Enter</kbd> Insert newline in composer</li>
                <li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd> Accessible focus navigation</li>
              </ul>
            </div>
            <div style="background:#141d2e;padding:14px;border-radius:10px;border:1px solid rgba(56,189,248,0.15);">
              <h4 style="margin:0 0 10px 0;color:#38bdf8;font-size:13px;">Views & Cockpit</h4>
              <ul style="margin:0;padding-left:18px;font-size:12.5px;color:#e2e8f0;display:flex;flex-direction:column;gap:6px;">
                <li><strong>Cockpit:</strong> Live agent chat feed & real-time PTY terminal</li>
                <li><strong>Overview:</strong> Velocity charts, project progress, team metrics</li>
                <li><strong>Board:</strong> 5-column Kanban task board with live assignment</li>
                <li><strong>Reviews:</strong> Diff inspector, PR status, code review decisions</li>
                <li><strong>Multi-Worktree:</strong> Git worktrees isolating concurrent agent branches</li>
              </ul>
            </div>
          </div>
          <div style="text-align:right;margin-top:16px;">
            <button type="button" class="btn btn-primary" id="btn-close-help-modal">Got it</button>
          </div>
        `,
        onRender: (body) => {
          body.querySelector('#btn-close-help-modal')?.addEventListener('click', closeModalDialog);
        }
      });
    });
  }

  // Topbar Assistant Button
  const topbarAssistantBtn = document.getElementById('topbar-assistant-btn');
  if (topbarAssistantBtn) {
    topbarAssistantBtn.addEventListener('click', () => {
      switchView('view-team-room');
      const architect = liveAgents.find(a => (a.role || '').toLowerCase().includes('architect')) || liveAgents[0];
      if (architect) {
        selectAgent(architect);
      }
      if (teamChatInput) {
        teamChatInput.focus();
        if (!teamChatInput.value.includes('@Architect') && architect?.name === 'Architect') {
          teamChatInput.value = `@Architect ${teamChatInput.value.replace(/^@\w+\s*/, '')}`.trim() + ' ';
        }
      }
      showToast('Switched to Architect assistant in Cockpit', 'info', 2000);
    });
  }

  // Topbar User Profile & Operator Preferences
  const topbarUserProfile = document.getElementById('topbar-user-profile');
  const topbarUserName = document.getElementById('topbar-user-name');

  const savedOperatorName = localStorage.getItem('agentcrew_operator_name');
  if (savedOperatorName) {
    if (topbarUserName) topbarUserName.textContent = savedOperatorName;
    const settingsOp = document.getElementById('settings-operator-name') || document.querySelector('#view-settings .profile-preview-row h4');
    if (settingsOp) settingsOp.textContent = savedOperatorName;
  }

  if (topbarUserProfile) {
    topbarUserProfile.addEventListener('click', () => {
      const currentName = topbarUserName?.textContent || 'Human Operator';
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      const currentAutoscroll = (localStorage.getItem('agentcrew-pref-autoscroll') ?? localStorage.getItem('agentcrew_autoscroll')) !== 'false';

      openModalDialog({
        title: 'Operator Profile & Preferences',
        subtitle: 'Configure your operator identity, theme, and workspace preferences',
        contentHtml: `
          <form id="preferences-form" style="display:flex;flex-direction:column;gap:16px;">
            <div class="form-group">
              <label for="pref-operator-name" style="display:block;margin-bottom:6px;font-size:12.5px;color:#94a3b8;">Operator Display Name</label>
              <input type="text" id="pref-operator-name" class="form-control" value="${escapeHtml(currentName)}" required style="width:100%;padding:8px 12px;background:#141d2e;border:1px solid rgba(56,189,248,0.3);border-radius:8px;color:#f8fafc;font-family:inherit;">
            </div>
            <div class="form-group">
              <label style="display:block;margin-bottom:6px;font-size:12.5px;color:#94a3b8;">Color Theme</label>
              <div style="display:flex;gap:16px;">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="pref-theme" value="dark" ${currentTheme === 'dark' ? 'checked' : ''}> Dark Mode
                </label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="radio" name="pref-theme" value="light" ${currentTheme === 'light' ? 'checked' : ''}> Light Mode
                </label>
              </div>
            </div>
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="pref-autoscroll" ${currentAutoscroll ? 'checked' : ''}>
                <span>Auto-scroll feed to latest messages</span>
              </label>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px;">
              <button type="button" class="btn btn-secondary" id="btn-cancel-prefs">Cancel</button>
              <button type="submit" class="btn btn-primary" id="btn-save-prefs">Save Preferences</button>
            </div>
          </form>
        `,
        onRender: (body) => {
          body.querySelector('#btn-cancel-prefs')?.addEventListener('click', closeModalDialog);
          body.querySelector('#preferences-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            const newName = body.querySelector('#pref-operator-name')?.value.trim() || 'Human Operator';
            const newTheme = body.querySelector('input[name="pref-theme"]:checked')?.value || 'dark';
            const newAutoscroll = !!body.querySelector('#pref-autoscroll')?.checked;

            localStorage.setItem('agentcrew_operator_name', newName);
            localStorage.setItem('agentcrew-pref-autoscroll', String(newAutoscroll));
            localStorage.setItem('agentcrew_autoscroll', String(newAutoscroll));
            if (topbarUserName) topbarUserName.textContent = newName;
            const settingsOp = document.getElementById('settings-operator-name') || document.querySelector('#view-settings .profile-preview-row h4');
            if (settingsOp) settingsOp.textContent = newName;

            if (newTheme !== currentTheme) {
              applyTheme(newTheme, true);
            }

            try {
              fetch('/api/v1/commands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  command_type: 'preferences.update',
                  payload: { operator_name: newName, theme: newTheme, autoscroll: newAutoscroll }
                })
              }).catch(() => {});
            } catch (_) {}

            closeModalDialog();
            showToast('Operator preferences saved!', 'success');
          });
        }
      });
    });
  }

  // --- Global Search Palette Logic ---
  const topbarSearchInput = document.getElementById('topbar-search-input');
  const topbarSearchResults = document.getElementById('topbar-search-results');
  let searchSelectedIdx = -1;

  function renderSearchResults(query) {
    if (!topbarSearchResults) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      topbarSearchResults.hidden = true;
      topbarSearchResults.replaceChildren();
      searchSelectedIdx = -1;
      return;
    }

    const views = [
      { id: 'view-team-room', title: 'Cockpit / Team Room', meta: 'View' },
      { id: 'view-overview', title: 'Overview Dashboard', meta: 'View' },
      { id: 'view-kanban', title: 'Board & Tasks', meta: 'View' },
      { id: 'view-reviews', title: 'Reviews & Pull Requests', meta: 'View' },
      { id: 'view-repositories', title: 'Repositories', meta: 'View' },
      { id: 'view-observability', title: 'Metrics & Observability', meta: 'View' },
      { id: 'view-settings', title: 'Settings', meta: 'View' }
    ].filter(v => v.title.toLowerCase().includes(q) || v.id.toLowerCase().includes(q));

    const matchedAgents = (Array.isArray(liveAgents) ? liveAgents : []).filter(a =>
      (a.name || '').toLowerCase().includes(q) ||
      (a.role || '').toLowerCase().includes(q) ||
      (a.provider || '').toLowerCase().includes(q) ||
      (a.model || '').toLowerCase().includes(q)
    ).slice(0, 5);

    const matchedTasks = (Array.isArray(cachedTasks) ? cachedTasks : []).filter(t =>
      (t.id || '').toLowerCase().includes(q) ||
      (t.title || '').toLowerCase().includes(q) ||
      (t.stage || '').toLowerCase().includes(q) ||
      (t.assignee || '').toLowerCase().includes(q)
    ).slice(0, 5);

    const prList = Array.isArray(analyticsData.pullRequests) ? analyticsData.pullRequests : [];
    const matchedPRs = prList.filter(pr =>
      (pr.title || '').toLowerCase().includes(q) ||
      (pr.branch || '').toLowerCase().includes(q) ||
      (pr.author || '').toLowerCase().includes(q) ||
      (pr.repository || '').toLowerCase().includes(q)
    ).slice(0, 5);

    const repoList = Array.isArray(analyticsData.repositories) ? analyticsData.repositories : [];
    const matchedRepos = repoList.filter(r =>
      (r.name || '').toLowerCase().includes(q) ||
      (r.path || '').toLowerCase().includes(q)
    ).slice(0, 5);

    const totalResults = views.length + matchedAgents.length + matchedTasks.length + matchedPRs.length + matchedRepos.length;

    topbarSearchResults.replaceChildren();
    searchSelectedIdx = -1;

    if (totalResults === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-no-results';
      empty.textContent = `No results found for "${query}"`;
      topbarSearchResults.appendChild(empty);
      topbarSearchResults.hidden = false;
      return;
    }

    const appendGroup = (groupTitle, items, makeItem) => {
      if (items.length === 0) return;
      const header = document.createElement('div');
      header.className = 'search-result-group-title';
      header.textContent = groupTitle;
      topbarSearchResults.appendChild(header);

      items.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'search-result-item';
        btn.setAttribute('role', 'option');
        makeItem(btn, item);
        topbarSearchResults.appendChild(btn);
      });
    };

    appendGroup('Views & Navigation', views, (btn, v) => {
      btn.dataset.type = 'view';
      btn.dataset.id = v.id;
      btn.innerHTML = `<span class="result-title">${escapeHtml(v.title)}</span><span class="result-meta">${escapeHtml(v.meta)}</span>`;
      btn.addEventListener('click', () => {
        switchView(v.id);
        closeSearchPalette();
      });
    });

    appendGroup('Agents', matchedAgents, (btn, a) => {
      btn.dataset.type = 'agent';
      btn.dataset.id = a.name;
      btn.innerHTML = `<span class="result-title">🤖 ${escapeHtml(a.name)} · ${escapeHtml(a.role || '')}</span><span class="result-meta">${escapeHtml(a.provider || 'agent')}</span>`;
      btn.addEventListener('click', () => {
        switchView('view-team-room');
        selectAgent(a);
        teamChatInput?.focus();
        closeSearchPalette();
      });
    });

    appendGroup('Tasks', matchedTasks, (btn, t) => {
      btn.dataset.type = 'task';
      btn.dataset.id = t.id;
      btn.innerHTML = `<span class="result-title">📋 ${escapeHtml(t.id)}: ${escapeHtml(t.title || '')}</span><span class="result-meta">${escapeHtml(t.stage || '')}</span>`;
      btn.addEventListener('click', () => {
        switchView('view-kanban');
        closeSearchPalette();
      });
    });

    appendGroup('Pull Requests', matchedPRs, (btn, pr) => {
      btn.dataset.type = 'pr';
      btn.dataset.id = String(pr.id || pr.number);
      btn.innerHTML = `<span class="result-title">🔀 ${escapeHtml(pr.title || 'PR')}</span><span class="result-meta">${escapeHtml(pr.repository || '')}</span>`;
      btn.addEventListener('click', () => {
        switchView('view-reviews');
        selectPR(pr);
        closeSearchPalette();
      });
    });

    appendGroup('Repositories', matchedRepos, (btn, r) => {
      btn.dataset.type = 'repo';
      btn.dataset.id = r.name;
      btn.innerHTML = `<span class="result-title">📁 ${escapeHtml(r.name)}</span><span class="result-meta">${escapeHtml(r.branch || 'trunk')}</span>`;
      btn.addEventListener('click', () => {
        switchView('view-repositories');
        closeSearchPalette();
      });
    });

    topbarSearchResults.hidden = false;
  }

  function closeSearchPalette() {
    if (!topbarSearchResults) return;
    topbarSearchResults.hidden = true;
    if (topbarSearchInput) {
      topbarSearchInput.value = '';
      topbarSearchInput.blur();
    }
    searchSelectedIdx = -1;
  }

  if (topbarSearchInput) {
    topbarSearchInput.addEventListener('input', (e) => {
      renderSearchResults(e.target.value);
    });

    topbarSearchInput.addEventListener('focus', () => {
      if (topbarSearchInput.value.trim()) {
        renderSearchResults(topbarSearchInput.value);
      }
    });

    topbarSearchInput.addEventListener('keydown', (e) => {
      if (!topbarSearchResults || topbarSearchResults.hidden) return;
      const items = Array.from(topbarSearchResults.querySelectorAll('.search-result-item'));
      if (items.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        searchSelectedIdx = (searchSelectedIdx + 1) % items.length;
        items.forEach((it, idx) => it.classList.toggle('selected', idx === searchSelectedIdx));
        items[searchSelectedIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        searchSelectedIdx = (searchSelectedIdx - 1 + items.length) % items.length;
        items.forEach((it, idx) => it.classList.toggle('selected', idx === searchSelectedIdx));
        items[searchSelectedIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = searchSelectedIdx >= 0 ? items[searchSelectedIdx] : items[0];
        target?.click();
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (topbarSearchResults && !topbarSearchResults.hidden) {
      const box = document.querySelector('.topbar-search-box');
      if (box && !box.contains(e.target)) {
        topbarSearchResults.hidden = true;
      }
    }
  });

  // Global Keyboard Shortcuts ( / for Search, Esc to Close )
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const active = document.activeElement;
      const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
      if (!isInput) {
        e.preventDefault();
        if (topbarSearchInput) {
          topbarSearchInput.focus();
          topbarSearchInput.select();
        }
      }
    } else if (e.key === 'Escape') {
      if (sharedDialogModal && !sharedDialogModal.hidden) {
        closeModalDialog();
        return;
      }
      if (projectWizardModal && !projectWizardModal.hidden) {
        closeProjectWizard();
        return;
      }
      if (topbarSearchResults && !topbarSearchResults.hidden) {
        closeSearchPalette();
        return;
      }
      if (appSidebar && appSidebar.classList.contains('open')) {
        setMobileDrawer(false);
        return;
      }
      if (selectedPR) {
        closePRPanel();
        return;
      }
    }
  });

  // --- Composer Mini-Tools Actions (Phase 2) ---
  const btnExpandComposer = document.getElementById('btn-expand-composer');
  const composerContainer = document.getElementById('agentsroom-composer');
  if (btnExpandComposer && composerContainer) {
    btnExpandComposer.addEventListener('click', () => {
      const isExpanded = composerContainer.classList.toggle('composer-expanded');
      btnExpandComposer.setAttribute('aria-expanded', String(isExpanded));
      btnExpandComposer.title = isExpanded ? 'Collapse Composer' : 'Expand Composer (Toggle larger editor)';
    });
  }

  const btnCodeEditor = document.getElementById('btn-code-editor');
  if (btnCodeEditor && teamChatInput) {
    btnCodeEditor.addEventListener('click', () => {
      const isCodeMode = teamChatInput.classList.toggle('code-mode');
      btnCodeEditor.classList.toggle('active', isCodeMode);
      if (isCodeMode && !teamChatInput.value.trim()) {
        teamChatInput.value = '// Task:\n// Implementation:\n';
        teamChatInput.focus();
        teamChatInput.setSelectionRange(teamChatInput.value.length, teamChatInput.value.length);
      }
    });
  }

  const btnChipInsertCode = document.getElementById('btn-chip-insert-code');
  if (btnChipInsertCode && teamChatInput) {
    btnChipInsertCode.addEventListener('click', () => {
      const start = teamChatInput.selectionStart;
      const end = teamChatInput.selectionEnd;
      const val = teamChatInput.value;
      if (start !== end) {
        const selected = val.substring(start, end);
        teamChatInput.value = val.substring(0, start) + '```\n' + selected + '\n```' + val.substring(end);
        teamChatInput.focus();
        teamChatInput.setSelectionRange(start + 4, start + 4 + selected.length);
      } else {
        const codeBlock = '```\n\n```';
        teamChatInput.value = val.substring(0, start) + codeBlock + val.substring(end);
        teamChatInput.focus();
        teamChatInput.setSelectionRange(start + 4, start + 4);
      }
    });
  }

  // + Tools Dialog Chip
  const btnChipTools = document.getElementById('btn-chip-tools');
  if (btnChipTools) {
    btnChipTools.addEventListener('click', () => {
      const availableTools = [
        { id: 'bash', name: 'Bash / Shell', desc: 'Execute system commands, test scripts, and build tasks' },
        { id: 'read_file', name: 'Read File', desc: 'Inspect source code, configuration files, and assets' },
        { id: 'write_file', name: 'Write File', desc: 'Create or update project source files and patches' },
        { id: 'git_diff', name: 'Git Diff', desc: 'Inspect staged and unstaged Git tree modifications' },
        { id: 'test_runner', name: 'Test Runner', desc: 'Run automated node, pytest, or custom test suites' },
        { id: 'search_code', name: 'Search Code', desc: 'Search symbols, function definitions, and regexes' }
      ];

      const checkboxesHtml = availableTools.map(t => {
        const checked = activeComposerAttachments.tools.has(t.id) ? 'checked' : '';
        return `
          <label style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;background:#141d2e;border:1px solid rgba(56,189,248,0.15);border-radius:8px;margin-bottom:8px;cursor:pointer;">
            <input type="checkbox" name="composer-tool" value="${escapeHtml(t.id)}" ${checked} style="margin-top:3px;">
            <div>
              <strong style="color:#e2e8f0;font-size:13px;">${escapeHtml(t.name)}</strong>
              <div style="font-size:11.5px;color:#94a3b8;">${escapeHtml(t.desc)}</div>
            </div>
          </label>
        `;
      }).join('');

      openModalDialog({
        title: 'Attach Tools to Agent Prompt',
        subtitle: 'Select specialized execution tools to grant or prioritize for this turn',
        contentHtml: `
          <div style="max-height:300px;overflow-y:auto;">
            ${checkboxesHtml}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-clear-all-tools">Clear All</button>
            <div style="display:flex;gap:10px;">
              <button type="button" class="btn btn-secondary" id="btn-cancel-tools">Cancel</button>
              <button type="button" class="btn btn-primary" id="btn-apply-tools">Apply Tools</button>
            </div>
          </div>
        `,
        onRender: (body) => {
          body.querySelector('#btn-clear-all-tools')?.addEventListener('click', () => {
            body.querySelectorAll('input[name="composer-tool"]').forEach(cb => cb.checked = false);
          });
          body.querySelector('#btn-cancel-tools')?.addEventListener('click', closeModalDialog);
          body.querySelector('#btn-apply-tools')?.addEventListener('click', () => {
            activeComposerAttachments.tools.clear();
            body.querySelectorAll('input[name="composer-tool"]:checked').forEach(cb => {
              activeComposerAttachments.tools.add(cb.value);
            });
            renderComposerAttachments();
            closeModalDialog();
            const count = activeComposerAttachments.tools.size;
            showToast(count > 0 ? `Attached ${count} tool(s) to prompt` : 'Cleared tool attachments', 'info', 2000);
          });
        }
      });
    });
  }

  // + Context Dialog Chip
  const btnChipContext = document.getElementById('btn-chip-context');
  if (btnChipContext) {
    btnChipContext.addEventListener('click', async () => {
      let suggestedFiles = ['package.json', 'README.md', 'src/server/public/app.js', 'src/server/supervisor-server.js'];
      let suggestedBranches = ['main', 'feat/task-37-multi-project-registry'];

      try {
        const res = await fetch('/api/v1/context?kind=files');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.files) && data.files.length > 0) {
            suggestedFiles = data.files.slice(0, 8);
          }
        }
      } catch (_) {}

      try {
        const res = await fetch('/api/v1/context?kind=branches');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.branches) && data.branches.length > 0) {
            suggestedBranches = data.branches.slice(0, 4);
          }
        }
      } catch (_) {}

      const filesHtml = suggestedFiles.map(f => {
        const checked = activeComposerAttachments.context.has(f) ? 'checked' : '';
        return `
          <label style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;background:#141d2e;border:1px solid rgba(56,189,248,0.2);border-radius:6px;font-size:12px;margin:3px;cursor:pointer;">
            <input type="checkbox" name="context-item" value="${escapeHtml(f)}" ${checked}>
            <span>📄 ${escapeHtml(f)}</span>
          </label>
        `;
      }).join('');

      const branchesHtml = suggestedBranches.map(b => {
        const branchName = typeof b === 'string' ? b : (b?.name || '');
        if (!branchName) return '';
        const val = `branch:${branchName}`;
        const checked = activeComposerAttachments.context.has(val) ? 'checked' : '';
        return `
          <label style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;background:#141d2e;border:1px solid rgba(56,189,248,0.2);border-radius:6px;font-size:12px;margin:3px;cursor:pointer;">
            <input type="checkbox" name="context-item" value="${escapeHtml(val)}" ${checked}>
            <span>🌿 ${escapeHtml(branchName)}</span>
          </label>
        `;
      }).filter(Boolean).join('');

      openModalDialog({
        title: 'Attach Context to Prompt',
        subtitle: 'Provide specific repository files, branches, or PR diffs for the agent to analyze',
        contentHtml: `
          <div style="margin-bottom:14px;">
            <label style="display:block;margin-bottom:6px;font-size:12px;color:#94a3b8;text-transform:uppercase;">Custom Path or Resource</label>
            <div style="display:flex;gap:8px;">
              <input type="text" id="input-custom-context" placeholder="e.g. src/utils/logger.js or #12" style="flex:1;padding:8px 12px;background:#141d2e;border:1px solid rgba(56,189,248,0.3);border-radius:8px;color:#f8fafc;font-family:inherit;font-size:13px;">
              <button type="button" class="btn btn-secondary btn-sm" id="btn-add-custom-context">+ Add</button>
            </div>
          </div>
          <div style="margin-bottom:14px;">
            <label style="display:block;margin-bottom:6px;font-size:12px;color:#94a3b8;text-transform:uppercase;">Suggested Files</label>
            <div style="display:flex;flex-wrap:wrap;">${filesHtml}</div>
          </div>
          <div style="margin-bottom:16px;">
            <label style="display:block;margin-bottom:6px;font-size:12px;color:#94a3b8;text-transform:uppercase;">Branches & Worktrees</label>
            <div style="display:flex;flex-wrap:wrap;">${branchesHtml}</div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-context">Cancel</button>
            <button type="button" class="btn btn-primary" id="btn-apply-context">Apply Context</button>
          </div>
        `,
        onRender: (body) => {
          body.querySelector('#btn-cancel-context')?.addEventListener('click', closeModalDialog);
          body.querySelector('#btn-add-custom-context')?.addEventListener('click', () => {
            const val = body.querySelector('#input-custom-context')?.value.trim();
            if (val) {
              activeComposerAttachments.context.add(val);
              renderComposerAttachments();
              const inp = body.querySelector('#input-custom-context');
              if (inp) inp.value = '';
              showToast(`Attached ${val}`, 'info', 1500);
            }
          });
          body.querySelector('#btn-apply-context')?.addEventListener('click', () => {
            body.querySelectorAll('input[name="context-item"]').forEach(cb => {
              if (cb.checked) {
                activeComposerAttachments.context.add(cb.value);
              } else {
                activeComposerAttachments.context.delete(cb.value);
              }
            });
            renderComposerAttachments();
            closeModalDialog();
            const count = activeComposerAttachments.context.size;
            showToast(count > 0 ? `Attached ${count} context item(s)` : 'Context updated', 'info', 2000);
          });
        }
      });
    });
  }

  // 📖 Docs Dialog Chip
  const btnChipDocs = document.getElementById('btn-chip-docs');
  if (btnChipDocs) {
    btnChipDocs.addEventListener('click', () => {
      const docItems = [
        { id: 'doc:architecture', title: 'Architecture & System Blueprint', desc: 'Supervisor design, agent state machines, and RPC protocol' },
        { id: 'doc:api-specs', title: 'REST API & Event Schema', desc: 'Endpoints for /api/v1/projects, room messages, and tasks' },
        { id: 'doc:coding-standards', title: 'Coding Conventions & Security', desc: 'Async safety, XSS escaping, and test bundle guidelines' },
        { id: 'doc:worktree-guide', title: 'Multi-Worktree Guide', desc: 'Isolated Git worktrees per agent under .agentcrew/worktrees' }
      ];

      const docsHtml = docItems.map(d => {
        const checked = activeComposerAttachments.docs.has(d.id) ? 'checked' : '';
        return `
          <label style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;background:#141d2e;border:1px solid rgba(56,189,248,0.15);border-radius:8px;margin-bottom:8px;cursor:pointer;">
            <input type="checkbox" name="composer-doc" value="${escapeHtml(d.id)}" ${checked} style="margin-top:3px;">
            <div>
              <strong style="color:#e2e8f0;font-size:13px;">${escapeHtml(d.title)}</strong>
              <div style="font-size:11.5px;color:#94a3b8;">${escapeHtml(d.desc)}</div>
            </div>
          </label>
        `;
      }).join('');

      openModalDialog({
        title: 'Attach Documentation & Knowledge',
        subtitle: 'Include foundational project documentation for the agent to reference',
        contentHtml: `
          <div style="max-height:300px;overflow-y:auto;">
            ${docsHtml}
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-secondary" id="btn-cancel-docs">Cancel</button>
            <button type="button" class="btn btn-primary" id="btn-apply-docs">Apply Docs</button>
          </div>
        `,
        onRender: (body) => {
          body.querySelector('#btn-cancel-docs')?.addEventListener('click', closeModalDialog);
          body.querySelector('#btn-apply-docs')?.addEventListener('click', () => {
            activeComposerAttachments.docs.clear();
            body.querySelectorAll('input[name="composer-doc"]:checked').forEach(cb => {
              activeComposerAttachments.docs.add(cb.value);
            });
            renderComposerAttachments();
            closeModalDialog();
            const count = activeComposerAttachments.docs.size;
            showToast(count > 0 ? `Attached ${count} doc(s) to prompt` : 'Docs updated', 'info', 2000);
          });
        }
      });
    });
  }

  // Voice Input Speech Recognition
  let speechRecognitionInstance = null;
  let isVoiceRecording = false;

  const btnVoiceMic = document.getElementById('btn-voice-mic');
  if (btnVoiceMic && teamChatInput) {
    btnVoiceMic.addEventListener('click', () => {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        showToast('Voice input is not supported by your browser.', 'warning');
        return;
      }

      if (isVoiceRecording) {
        speechRecognitionInstance?.stop();
        return;
      }

      try {
        speechRecognitionInstance = new SpeechRecognition();
        speechRecognitionInstance.continuous = true;
        speechRecognitionInstance.interimResults = false;
        speechRecognitionInstance.lang = 'en-US';

        speechRecognitionInstance.onstart = () => {
          isVoiceRecording = true;
          btnVoiceMic.classList.add('recording');
          btnVoiceMic.title = 'Recording voice... Click to stop';
          showToast('Listening... Speak now', 'info', 2000);
        };

        speechRecognitionInstance.onresult = (event) => {
          let transcript = '';
          const startIndex = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
          for (let i = startIndex; i < event.results.length; i++) {
            const res = event.results[i];
            if (res && res[0]) {
              if (res.isFinal || event.results.length === 1) {
                const seg = res[0].transcript ? res[0].transcript.trim() : '';
                if (seg) transcript += (transcript ? ' ' : '') + seg;
              }
            }
          }
          if (transcript) {
            const cur = teamChatInput.value;
            teamChatInput.value = cur ? `${cur} ${transcript}` : transcript;
            teamChatInput.focus();
          }
        };

        speechRecognitionInstance.onerror = (event) => {
          console.warn('Speech recognition error:', event.error);
          showToast(`Voice input error: ${event.error}`, 'error');
          isVoiceRecording = false;
          btnVoiceMic.classList.remove('recording');
          btnVoiceMic.title = 'Voice Input';
        };

        speechRecognitionInstance.onend = () => {
          isVoiceRecording = false;
          btnVoiceMic.classList.remove('recording');
          btnVoiceMic.title = 'Voice Input';
        };

        speechRecognitionInstance.start();
      } catch (err) {
        console.warn('Speech recognition start failed:', err);
        showToast('Could not start voice recognition: ' + err.message, 'error');
        isVoiceRecording = false;
        btnVoiceMic.classList.remove('recording');
      }
    });
  }

  // --- Multi-Step Onboarding Journey & Folder Browser ---
  let wizardStep = 1;
  let selectedTeamPreset = 'lean';
  let browserCurrentDir = '';

  const wizardSubtitle = document.getElementById('wizard-modal-subtitle');
  const btnWizardBack = document.getElementById('btn-wizard-back');
  const btnWizardNext = document.getElementById('btn-wizard-next');
  const btnSubmitWizard = document.getElementById('btn-submit-project-wizard');
  const btnBrowseFolder = document.getElementById('btn-browse-folder');
  const pathMissingBanner = document.getElementById('path-missing-banner');
  const btnCreateMissingFolder = document.getElementById('btn-create-missing-folder');
  const teamPresetCards = document.querySelectorAll('.team-preset-card');

  const folderBrowserModal = document.getElementById('folder-browser-modal');
  const btnCloseFolderBrowser = document.getElementById('btn-close-folder-browser');
  const btnCancelFolderBrowser = document.getElementById('btn-cancel-folder-browser');
  const browserCurrentPath = document.getElementById('browser-current-path');
  const browserDirList = document.getElementById('browser-dir-list');
  const btnBrowserParent = document.getElementById('btn-browser-parent');
  const browserGitIndicator = document.getElementById('browser-git-indicator');
  const btnBrowserCreateFolder = document.getElementById('btn-browser-create-folder');
  const browserNewFolderName = document.getElementById('browser-new-folder-name');
  const btnSelectCurrentFolder = document.getElementById('btn-select-current-folder');

  const presetDefinitions = {
    lean: {
      title: '🚀 Lean Dev & Test Squad',
      count: '3 Agents',
      members: [
        { name: 'Dev-1', role: 'Developer' },
        { name: 'QA-1', role: 'Tester' },
        { name: 'Integrator-1', role: 'Integrator' }
      ]
    },
    agile: {
      title: '⚡ Agile Feature Team',
      count: '6 Agents',
      members: [
        { name: 'Peter', role: 'PO' },
        { name: 'Arthur', role: 'Architect' },
        { name: 'Dev-1', role: 'Dev' },
        { name: 'Dev-2', role: 'Dev' },
        { name: 'QA-1', role: 'Tester' },
        { name: 'Integrator-1', role: 'Integrator' }
      ]
    },
    enterprise: {
      title: '🏛️ Full Enterprise Crew',
      count: '13 Agents',
      members: [
        { name: 'Alice', role: 'BA' },
        { name: 'Peter', role: 'PO' },
        { name: 'Arthur', role: 'Architect' },
        { name: 'Dev-1..4', role: '4 Devs' },
        { name: 'QA-1..4', role: '4 Testers' },
        { name: 'Integrator-1..2', role: '2 Integrators' }
      ]
    }
  };

  function setWizardStep(step) {
    wizardStep = step;
    [1, 2, 3].forEach(s => {
      const panel = document.getElementById(`wizard-step-panel-${s}`);
      const node = document.getElementById(`step-node-${s}`);
      if (panel) panel.hidden = s !== wizardStep;
      if (node) {
        node.classList.toggle('active', s === wizardStep);
        node.classList.toggle('completed', s < wizardStep);
      }
    });

    if (btnWizardBack) btnWizardBack.hidden = wizardStep === 1;
    if (btnWizardNext) btnWizardNext.hidden = wizardStep === 3;
    if (btnSubmitWizard) btnSubmitWizard.hidden = wizardStep !== 3;

    if (wizardSubtitle) {
      if (wizardStep === 1) wizardSubtitle.textContent = 'Step 1 of 3: Repository & Configuration';
      else if (wizardStep === 2) wizardSubtitle.textContent = 'Step 2 of 3: Team Roster Composition';
      else if (wizardStep === 3) wizardSubtitle.textContent = 'Step 3 of 3: Review & Launch';
    }

    if (wizardStep === 3) {
      const name = document.getElementById('wizard-project-name')?.value?.trim() || 'New Project';
      const pathVal = document.getElementById('wizard-project-path')?.value?.trim() || '';
      const zoneVal = document.getElementById('wizard-project-zone')?.value || 'work';
      const preset = presetDefinitions[selectedTeamPreset] || presetDefinitions.lean;

      const summaryName = document.getElementById('summary-project-name');
      const summaryZone = document.getElementById('summary-project-zone');
      const summaryPath = document.getElementById('summary-project-path');
      const summaryTeamName = document.getElementById('summary-team-name');
      const summaryTeamCount = document.getElementById('summary-team-count');
      const summaryRoster = document.getElementById('summary-team-roster');

      if (summaryName) summaryName.textContent = name;
      if (summaryZone) summaryZone.textContent = zoneVal.toUpperCase();
      if (summaryPath) summaryPath.textContent = pathVal;
      if (summaryTeamName) summaryTeamName.textContent = preset.title;
      if (summaryTeamCount) summaryTeamCount.textContent = preset.count;
      if (summaryRoster) {
        summaryRoster.innerHTML = preset.members.map(m => `
          <span class="preset-member-pill"><strong>${escapeHtml(m.name)}</strong> <span class="preset-member-role">(${escapeHtml(m.role)})</span></span>
        `).join('');
      }
    }
  }

  // Preset selection click
  teamPresetCards.forEach(card => {
    card.addEventListener('click', () => {
      teamPresetCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedTeamPreset = card.dataset.preset || 'lean';
    });
  });

  // Step navigation buttons
  btnWizardNext?.addEventListener('click', async () => {
    if (wizardStep === 1) {
      const name = document.getElementById('wizard-project-name')?.value?.trim();
      const pathVal = document.getElementById('wizard-project-path')?.value?.trim();
      if (!name) {
        document.getElementById('wizard-project-name')?.focus();
        return;
      }
      if (!pathVal) {
        document.getElementById('wizard-project-path')?.focus();
        return;
      }
      // Check if folder exists
      try {
        const checkRes = await fetch(`/api/v1/fs/browse?dir=${encodeURIComponent(pathVal)}`);
        if (!checkRes.ok && checkRes.status === 404) {
          pathMissingBanner.hidden = false;
          return;
        } else {
          pathMissingBanner.hidden = true;
        }
      } catch (_) {}
      setWizardStep(2);
    } else if (wizardStep === 2) {
      setWizardStep(3);
    }
  });

  btnWizardBack?.addEventListener('click', () => {
    if (wizardStep > 1) setWizardStep(wizardStep - 1);
  });

  // Inline "Create Folder & Init Git" button
  btnCreateMissingFolder?.addEventListener('click', async () => {
    const pathVal = document.getElementById('wizard-project-path')?.value?.trim();
    if (!pathVal) return;
    try {
      const res = await fetch('/api/v1/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pathVal, init_git: true })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create folder');
      pathMissingBanner.hidden = true;
      log(`Created folder & git repo: ${data.path}`, 'success');
      setWizardStep(2);
    } catch (err) {
      if (wizardErrorMsg) {
        wizardErrorMsg.textContent = err.message;
        wizardErrorMsg.hidden = false;
      }
    }
  });

  // Folder Browser Modal Logic
  async function browseDirectory(dirPath) {
    if (!browserDirList) return;
    browserDirList.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 12px;">Loading directories…</div>';
    try {
      const res = await fetch(`/api/v1/fs/browse?dir=${encodeURIComponent(dirPath || '')}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to read directory');

      browserCurrentDir = data.current;
      if (browserCurrentPath) browserCurrentPath.textContent = data.current;
      if (browserGitIndicator) browserGitIndicator.hidden = !data.is_git_repo;

      if (!data.directories || data.directories.length === 0) {
        browserDirList.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 12px;">(No subdirectories)</div>';
        return;
      }

      browserDirList.innerHTML = '';
      data.directories.forEach(d => {
        const item = document.createElement('div');
        item.className = 'browser-dir-item';
        item.innerHTML = `
          <div class="browser-dir-name">
            <span>📁</span>
            <strong>${escapeHtml(d.name)}</strong>
          </div>
          ${d.is_git_repo ? '<span style="font-size: 10px; color: #10b981; font-weight: 700;">git</span>' : ''}
        `;
        item.addEventListener('click', () => browseDirectory(d.path));
        browserDirList.appendChild(item);
      });
    } catch (err) {
      browserDirList.innerHTML = `<div style="padding: 12px; color: #ef4444; font-size: 12px;">${escapeHtml(err.message)}</div>`;
    }
  }

  btnBrowseFolder?.addEventListener('click', () => {
    const curPath = document.getElementById('wizard-project-path')?.value?.trim();
    if (folderBrowserModal) folderBrowserModal.hidden = false;
    browseDirectory(curPath || '');
  });

  function closeFolderBrowser() {
    if (folderBrowserModal) folderBrowserModal.hidden = true;
  }

  btnCloseFolderBrowser?.addEventListener('click', closeFolderBrowser);
  btnCancelFolderBrowser?.addEventListener('click', closeFolderBrowser);

  btnBrowserParent?.addEventListener('click', () => {
    if (!browserCurrentDir) return;
    const parts = browserCurrentDir.split('/').filter(Boolean);
    parts.pop();
    const parent = '/' + parts.join('/');
    browseDirectory(parent);
  });

  btnBrowserCreateFolder?.addEventListener('click', async () => {
    const name = browserNewFolderName?.value?.trim();
    if (!name || !browserCurrentDir) return;
    const newPath = browserCurrentDir.endsWith('/') ? `${browserCurrentDir}${name}` : `${browserCurrentDir}/${name}`;
    try {
      const res = await fetch('/api/v1/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath, init_git: true })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create folder');
      }
      if (browserNewFolderName) browserNewFolderName.value = '';
      await browseDirectory(newPath);
    } catch (e) {
      alert(e.message);
    }
  });

  btnSelectCurrentFolder?.addEventListener('click', () => {
    if (browserCurrentDir) {
      const pathInput = document.getElementById('wizard-project-path');
      const nameInput = document.getElementById('wizard-project-name');
      if (pathInput) {
        pathInput.value = browserCurrentDir;
        pathMissingBanner.hidden = true;
      }
      if (nameInput && !nameInput.value.trim()) {
        const parts = browserCurrentDir.split('/').filter(Boolean);
        if (parts.length > 0) nameInput.value = parts[parts.length - 1];
      }
    }
    closeFolderBrowser();
  });

  if (btnOpenProjectWizard && projectWizardModal) {
    btnOpenProjectWizard.addEventListener('click', () => {
      setWizardStep(1);
      projectWizardModal.hidden = false;
      if (wizardErrorMsg) wizardErrorMsg.hidden = true;
      if (pathMissingBanner) pathMissingBanner.hidden = true;
      document.getElementById('wizard-project-name')?.focus();
    });
  }

  function closeProjectWizard() {
    if (projectWizardModal) projectWizardModal.hidden = true;
    if (wizardErrorMsg) {
      wizardErrorMsg.hidden = true;
      wizardErrorMsg.textContent = '';
    }
    if (pathMissingBanner) pathMissingBanner.hidden = true;
    setWizardStep(1);
  }

  if (btnCloseProjectWizard) btnCloseProjectWizard.addEventListener('click', closeProjectWizard);
  if (btnCancelProjectWizard) btnCancelProjectWizard.addEventListener('click', closeProjectWizard);

  let isSubmittingWizard = false;
  if (projectWizardForm) {
    projectWizardForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isSubmittingWizard) return;

      const name = document.getElementById('wizard-project-name')?.value?.trim();
      const path = document.getElementById('wizard-project-path')?.value?.trim();
      const zone = document.getElementById('wizard-project-zone')?.value || 'work';
      const mode = document.querySelector('input[name="wizard-mode"]:checked')?.value || 'independent';

      if (!name || !path) return;
      if (wizardErrorMsg) wizardErrorMsg.hidden = true;

      isSubmittingWizard = true;
      if (btnSubmitWizard) btnSubmitWizard.disabled = true;

      try {
        const res = await fetch('/api/v1/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            path,
            mode,
            zone,
            team_preset: selectedTeamPreset,
            create_if_missing: true
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Project creation failed');
        log(`Project registered with ${selectedTeamPreset} team: ${data.project.name} (${data.project.mode})`, 'success');

        // Automatically activate newly created project
        try {
          await fetch(`/api/v1/projects/${encodeURIComponent(data.project.id)}/activate`, { method: 'POST' });
          currentProjectId = data.project.id;
        } catch (_) {}

        projectWizardForm.reset();
        closeProjectWizard();
        switchView('view-team-room');
        await loadProjects();
        await loadWorkspace();
        await loadAgents();
        await loadTasks();
        await loadRealRepositoryData();
      } catch (err) {
        if (wizardErrorMsg) {
          wizardErrorMsg.textContent = err.message;
          wizardErrorMsg.hidden = false;
        }
      } finally {
        isSubmittingWizard = false;
        if (btnSubmitWizard) btnSubmitWizard.disabled = false;
      }
    });
  }

  if (projectWizardModal) {
    projectWizardModal.addEventListener('click', (e) => {
      if (e.target === projectWizardModal) {
        closeProjectWizard();
      }
    });
  }

  // Pop-Out Detachable Terminal (TASK-46)
  const btnPopoutTerminalTop = document.getElementById('btn-popout-terminal-top');
  let popoutTerminalPollInterval = null;

  async function openPopoutTerminal() {
    const agentId = selectedAgentName || agentSelect?.value || 'Dev-1';
    let token = takeoverTokens.get(agentId) || '';

    if (!token) {
      try {
        const res = await fetch('/api/v1/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'takeover', agent_id: agentId })
        });
        const result = await res.json();
        if (res.ok && result.result?.takeover_token) {
          token = result.result.takeover_token;
          takeoverTokens.set(agentId, token);
          persistTakeoverTokens();
          if (stateBadge) stateBadge.textContent = 'Human Owned';
          if (btnTakeover) btnTakeover.disabled = true;
          if (btnRelease) btnRelease.disabled = false;
          loadAgents();
        }
      } catch (_) {}
    }

    const url = `/terminal?agent=${encodeURIComponent(agentId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const popoutWin = window.open(url, `agentcrew_term_${agentId}`, 'width=960,height=600,menubar=no,toolbar=no,location=no,status=no');

    if (!popoutWin) {
      showToast('Pop-out window was blocked by the browser. Please allow popups.', 'warning');
      return;
    }

    // Detach embedded PTY so the popout window does not get a 409 Conflict
    disconnectPty();
    if (btnPopoutTerminal) btnPopoutTerminal.disabled = true;
    if (btnPopoutTerminalTop) btnPopoutTerminalTop.disabled = true;
    log(`Detached xterm terminal opened for ${agentId}`, 'system');

    if (popoutTerminalPollInterval) clearInterval(popoutTerminalPollInterval);
    popoutTerminalPollInterval = setInterval(() => {
      if (popoutWin.closed) {
        clearInterval(popoutTerminalPollInterval);
        popoutTerminalPollInterval = null;
        if (btnPopoutTerminal) btnPopoutTerminal.disabled = false;
        if (btnPopoutTerminalTop) btnPopoutTerminalTop.disabled = false;
        log(`Detached terminal for ${agentId} closed. Reconnecting local PTY...`, 'system');
        const ag = liveAgents.find(a => a.name === selectedAgentName);
        if (ag && isTakenOver(ag)) {
          connectPty(ag.name);
        }
      }
    }, 1000);
  }

  if (btnPopoutTerminal) btnPopoutTerminal.addEventListener('click', openPopoutTerminal);
  if (btnPopoutTerminalTop) btnPopoutTerminalTop.addEventListener('click', openPopoutTerminal);

  // --- Mobile Search Palette & Stage Navigation (TASK-47) ---
  const mobileSearchBtn = document.getElementById('mobile-search-btn');
  if (mobileSearchBtn) {
    mobileSearchBtn.addEventListener('click', () => {
      openModalDialog({
        title: 'Global Search',
        subtitle: 'Search agents, tasks, pull requests, and views',
        contentHtml: `
          <div style="display:flex;flex-direction:column;gap:12px;">
            <input type="search" id="mobile-search-modal-input" placeholder="Type to search…" style="width:100%;padding:10px 14px;background:#141d2e;border:1px solid rgba(56,189,248,0.3);border-radius:10px;color:#f8fafc;font-size:15px;box-sizing:border-box;">
            <div id="mobile-search-modal-results" class="mobile-search-results-list" style="max-height:55dvh;overflow-y:auto;display:flex;flex-direction:column;gap:6px;"></div>
          </div>
        `,
        onRender: (body) => {
          const input = body.querySelector('#mobile-search-modal-input');
          const results = body.querySelector('#mobile-search-modal-results');
          if (input && results) {
            setTimeout(() => input.focus(), 60);
            const render = (query) => {
              results.replaceChildren();
              const q = query.trim().toLowerCase();
              if (!q) {
                const hint = document.createElement('div');
                hint.className = 'search-no-results';
                hint.textContent = 'Type to search across views, agents, and tasks…';
                results.appendChild(hint);
                return;
              }
              const matchedViews = [
                { id: 'view-overview', title: 'Overview Dashboard', meta: 'View' },
                { id: 'view-team-room', title: 'Cockpit / Team Room', meta: 'View' },
                { id: 'view-kanban', title: 'Board & Tasks', meta: 'View' },
                { id: 'view-reviews', title: 'Reviews & Pull Requests', meta: 'View' },
                { id: 'view-repositories', title: 'Repositories', meta: 'View' },
                { id: 'view-observability', title: 'Metrics & Observability', meta: 'View' },
                { id: 'view-settings', title: 'Settings', meta: 'View' }
              ].filter(v => v.title.toLowerCase().includes(q) || v.id.toLowerCase().includes(q));

              const matchedAgents = (Array.isArray(liveAgents) ? liveAgents : []).filter(a =>
                (a.name || '').toLowerCase().includes(q) || (a.role || '').toLowerCase().includes(q)
              ).slice(0, 5);

              const matchedTasks = (Array.isArray(cachedTasks) ? cachedTasks : []).filter(t =>
                (t.id || '').toLowerCase().includes(q) || (t.title || '').toLowerCase().includes(q)
              ).slice(0, 5);

              const cachedPRs = Array.isArray(analyticsData.pullRequests) ? analyticsData.pullRequests : [];
              const matchedPRs = cachedPRs.filter(pr =>
                (pr.title || '').toLowerCase().includes(q) ||
                String(pr.number || '').includes(q) ||
                (pr.author || '').toLowerCase().includes(q) ||
                (pr.branch || '').toLowerCase().includes(q)
              ).slice(0, 5);

              if (!matchedViews.length && !matchedAgents.length && !matchedTasks.length && !matchedPRs.length) {
                const empty = document.createElement('div');
                empty.className = 'search-no-results';
                empty.textContent = 'No matching items found.';
                results.appendChild(empty);
                return;
              }

              matchedViews.forEach(v => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'search-result-item';
                btn.innerHTML = `<span class="result-title">📌 ${escapeHtml(v.title)}</span><span class="result-meta">${escapeHtml(v.meta)}</span>`;
                btn.addEventListener('click', () => {
                  switchView(v.id);
                  closeModalDialog();
                });
                results.appendChild(btn);
              });

              matchedAgents.forEach(a => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'search-result-item';
                btn.innerHTML = `<span class="result-title">🤖 ${escapeHtml(a.name)}</span><span class="result-meta">${escapeHtml(a.role || 'Agent')}</span>`;
                btn.addEventListener('click', () => {
                  switchView('view-team-room');
                  selectAgent(a);
                  closeModalDialog();
                });
                results.appendChild(btn);
              });

              matchedTasks.forEach(t => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'search-result-item';
                btn.innerHTML = `<span class="result-title">📋 ${escapeHtml(t.id)}: ${escapeHtml(t.title)}</span><span class="result-meta">${escapeHtml(t.stage || 'Task')}</span>`;
                btn.addEventListener('click', () => {
                  switchView('view-kanban');
                  const col = document.querySelector(`.kanban-col[data-stage="${t.stage}"]`);
                  if (col) col.scrollIntoView({ behavior: 'smooth', inline: 'center' });
                  closeModalDialog();
                });
                results.appendChild(btn);
              });

              matchedPRs.forEach(pr => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'search-result-item';
                btn.innerHTML = `<span class="result-title">🔀 #${escapeHtml(pr.number)}: ${escapeHtml(pr.title)}</span><span class="result-meta">${escapeHtml(pr.branch || pr.author || 'PR')}</span>`;
                btn.addEventListener('click', () => {
                  switchView('view-reviews');
                  selectPR(pr.number);
                  closeModalDialog();
                });
                results.appendChild(btn);
              });
            };
            input.addEventListener('input', (e) => render(e.target.value));
            render('');
          }
        }
      });
    });
  }

  // --- Mobile Workspace & Tools Sheet (TASK-47) ---
  let mobileToolsBtn = document.getElementById('mobile-tools-btn');
  if (!mobileToolsBtn) {
    const appBarActions = document.querySelector('.mobile-app-bar-actions');
    if (appBarActions) {
      mobileToolsBtn = document.createElement('button');
      mobileToolsBtn.className = 'mobile-icon-btn';
      mobileToolsBtn.id = 'mobile-tools-btn';
      mobileToolsBtn.type = 'button';
      mobileToolsBtn.setAttribute('aria-label', 'Open workspace tools');
      mobileToolsBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
      const searchBtn = document.getElementById('mobile-search-btn');
      if (searchBtn && searchBtn.nextSibling) {
        appBarActions.insertBefore(mobileToolsBtn, searchBtn.nextSibling);
      } else {
        appBarActions.appendChild(mobileToolsBtn);
      }
    }
  }

  if (mobileToolsBtn) {
    mobileToolsBtn.addEventListener('click', async () => {
      let projects = [];
      try {
        const res = await fetch('/api/v1/projects');
        if (res.ok) {
          const data = await res.json();
          projects = Array.isArray(data.projects) ? data.projects : [];
        }
      } catch (_) {}

      const projectOptionsHtml = projects.map(p =>
        `<option value="${escapeHtml(p.id)}"${p.is_active ? ' selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.zone || 'work')})</option>`
      ).join('');

      openModalDialog({
        title: 'Workspace & Tools',
        subtitle: 'Switch active project or execute crew actions',
        contentHtml: `
          <div class="mobile-tools-sheet" style="display:flex;flex-direction:column;gap:16px;">
            <div class="mobile-tools-section" style="display:flex;flex-direction:column;gap:8px;">
              <label for="mobile-tools-project-select" style="font-size:12px;font-weight:700;letter-spacing:0.05em;color:#94a3b8;text-transform:uppercase;">Active Project</label>
              <div style="display:flex;gap:8px;">
                <select id="mobile-tools-project-select" class="form-select" style="flex:1;padding:8px 10px;background:#141d2e;border:1px solid rgba(56,189,248,0.3);border-radius:8px;color:#f8fafc;font-size:14px;">
                  ${projectOptionsHtml || '<option value="">Default Project</option>'}
                </select>
                <button type="button" id="btn-mobile-new-project" class="btn btn-sm btn-secondary" style="white-space:nowrap;padding:8px 12px;font-size:13px;">+ New</button>
              </div>
            </div>

            <div class="mobile-tools-section" style="display:flex;flex-direction:column;gap:8px;">
              <span style="font-size:12px;font-weight:700;letter-spacing:0.05em;color:#94a3b8;text-transform:uppercase;">Crew & Cockpit Tools</span>
              <div class="mobile-tools-grid" style="display:grid;grid-template-columns:repeat(2, 1fr);gap:8px;">
                <button type="button" class="btn btn-secondary mobile-tool-btn" data-tool="git" style="justify-content:flex-start;padding:10px 12px;font-size:13px;border-radius:8px;">
                  📁 Git Changes
                </button>
                <button type="button" class="btn btn-secondary mobile-tool-btn" data-tool="signals" style="justify-content:flex-start;padding:10px 12px;font-size:13px;border-radius:8px;">
                  📶 Signals
                </button>
                <button type="button" class="btn btn-secondary mobile-tool-btn" data-tool="commands" style="justify-content:flex-start;padding:10px 12px;font-size:13px;border-radius:8px;">
                  ⌨️ Command Runner
                </button>
                <button type="button" class="btn btn-secondary mobile-tool-btn" data-tool="state" style="justify-content:flex-start;padding:10px 12px;font-size:13px;border-radius:8px;">
                  📊 Workspace State
                </button>
                <button type="button" class="btn btn-secondary mobile-tool-btn" data-tool="ideas" style="justify-content:flex-start;padding:10px 12px;font-size:13px;border-radius:8px;">
                  💡 Ideas
                </button>
                <button type="button" class="btn btn-secondary mobile-tool-btn" data-tool="broadcast" style="justify-content:flex-start;padding:10px 12px;font-size:13px;border-radius:8px;">
                  📢 Broadcast to Crew
                </button>
                <button type="button" class="btn btn-secondary mobile-tool-btn" data-tool="hire" style="justify-content:flex-start;padding:10px 12px;font-size:13px;border-radius:8px;grid-column:span 2;">
                  ✨ Hire Specialist
                </button>
              </div>
            </div>
          </div>
        `,
        onRender: (body) => {
          const select = body.querySelector('#mobile-tools-project-select');
          if (select) {
            select.addEventListener('change', async (e) => {
              const projId = e.target.value;
              if (!projId) return;
              try {
                const actRes = await fetch(`/api/v1/projects/${encodeURIComponent(projId)}/activate`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' }
                });
                if (actRes.ok) {
                  currentProjectId = projId;
                  const projectSelector = document.getElementById('project-selector');
                  if (projectSelector) projectSelector.value = projId;
                  await loadWorkspace();
                  await loadProjects();
                  closeModalDialog();
                }
              } catch (err) {
                console.warn('Failed to switch project:', err);
              }
            });
          }

          const btnNew = body.querySelector('#btn-mobile-new-project');
          if (btnNew) {
            btnNew.addEventListener('click', () => {
              closeModalDialog();
              const wizard = document.getElementById('project-wizard-modal');
              if (wizard) wizard.hidden = false;
            });
          }

          const getActions = () => window.agentCrewActions || window.agentCrewCockpitActions || {};

          body.querySelectorAll('.mobile-tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              const tool = btn.dataset.tool;
              const actions = getActions();
              closeModalDialog();
              if (tool === 'git') {
                if (typeof actions.openFilesDrawer === 'function') actions.openFilesDrawer();
                else document.getElementById('btn-toggle-files-changes')?.click();
              } else if (tool === 'signals') {
                if (typeof actions.openSignals === 'function') actions.openSignals();
              } else if (tool === 'commands') {
                if (typeof actions.openCommands === 'function') actions.openCommands();
                else document.getElementById('btn-utility-commands')?.click();
              } else if (tool === 'state') {
                if (typeof actions.openState === 'function') actions.openState();
              } else if (tool === 'ideas') {
                if (typeof actions.openIdeas === 'function') actions.openIdeas();
                else document.getElementById('btn-open-ideas')?.click();
              } else if (tool === 'broadcast') {
                if (typeof actions.openBroadcast === 'function') actions.openBroadcast();
                else document.getElementById('btn-open-broadcast')?.click();
              } else if (tool === 'hire') {
                document.querySelector('.roster-quick-icons .plus-btn')?.click();
              }
            });
          });
        }
      });
    });
  }

  // Mobile Kanban Stage Navigator Pills
  const kanbanStagePills = document.querySelectorAll('.kanban-stage-pill');
  if (kanbanStagePills.length > 0) {
    kanbanStagePills.forEach(pill => {
      pill.addEventListener('click', () => {
        kanbanStagePills.forEach(p => {
          p.classList.remove('active');
          p.setAttribute('aria-selected', 'false');
        });
        pill.classList.add('active');
        pill.setAttribute('aria-selected', 'true');
        const stage = pill.dataset.stage;
        const col = document.querySelector(`.kanban-col[data-stage="${stage}"]`);
        if (col) {
          col.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
      });
    });

    const kanbanWrapper = document.querySelector('.kanban-fullscreen-wrapper');
    if (kanbanWrapper && 'IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            const stage = entry.target.dataset.stage;
            if (stage) {
              kanbanStagePills.forEach(p => {
                const isMatch = p.dataset.stage === stage;
                p.classList.toggle('active', isMatch);
                p.setAttribute('aria-selected', String(isMatch));
              });
            }
          }
        });
      }, { root: kanbanWrapper, threshold: 0.5 });
      document.querySelectorAll('.kanban-col').forEach(col => observer.observe(col));
    }
  }

  // Mobile Visual Viewport Handling (Virtual Keyboard)
  function setupVirtualKeyboardHandler() {
    if (!window.visualViewport) return;
    const updateViewportVars = () => {
      const vv = window.visualViewport;
      if (!vv) return;
      const height = Math.round(vv.height);
      const offsetTop = Math.round(vv.offsetTop);
      document.documentElement.style.setProperty('--vvh', `${height}px`);
      document.documentElement.style.setProperty('--vvo', `${offsetTop}px`);

      const isKeyboardOpen = window.visualViewport.height < window.innerHeight * 0.82;
      document.body.classList.toggle('virtual-keyboard-open', isKeyboardOpen);
      if (isKeyboardOpen && document.activeElement?.id === 'team-chat-input') {
        const feed = document.getElementById('team-room-chat-feed');
        if (feed) {
          requestAnimationFrame(() => {
            feed.scrollTop = feed.scrollHeight;
          });
        }
      }
      if (terminalInstance && fitAddon && !terminalEmulator?.hidden) {
        requestAnimationFrame(() => {
          try { fitAddon.fit(); } catch (_) {}
        });
      }
    };

    window.visualViewport.addEventListener('resize', updateViewportVars);
    window.visualViewport.addEventListener('scroll', updateViewportVars);
    updateViewportVars();
  }
  setupVirtualKeyboardHandler();

  // --- Initial Boot ---
  updateOverview('week');
  renderOverviewContributors();
  renderPRList('all');
  renderRepositories('');
  // Select first PR initially for rich display
  if (analyticsData.pullRequests.length > 0 && window.matchMedia('(min-width: 1181px)').matches) {
    selectPR(analyticsData.pullRequests[0]);
  }

  // Initialize Holographic AI Orb
  if (typeof AiOrb !== 'undefined' && document.getElementById('ai-orb-canvas')) {
    aiOrb = new AiOrb('ai-orb-canvas', { interactive: true });
    window.agentCrewOrb = aiOrb;
  }

  loadProjects();
  loadWorkspace();
  loadAgents();
  loadReadiness();
  loadTasks();
  loadPopups();
  loadRealRepositoryData();
  switchView('view-team-room');
  connectSSE();
});
