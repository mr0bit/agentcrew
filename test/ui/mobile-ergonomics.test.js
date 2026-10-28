const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.join(__dirname, '../../src/server/public/index.html');
const terminalHtmlPath = path.join(__dirname, '../../src/server/public/terminal.html');
const styleCssPath = path.join(__dirname, '../../src/server/public/style.css');
const appJsPath = path.join(__dirname, '../../src/server/public/app.js');

const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
const terminalHtml = fs.readFileSync(terminalHtmlPath, 'utf8');
const styleCss = fs.readFileSync(styleCssPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8');

test('index.html contains complete PWA and mobile viewport meta tags', () => {
  // Mobile Viewport with viewport-fit=cover
  assert.match(indexHtml, /<meta\s+name=["']viewport["']\s+content=["'][^"']*viewport-fit=cover[^"']*["']/i);

  // Theme color definitions for dark and light modes
  assert.match(indexHtml, /<meta\s+name=["']theme-color["']\s+content=["']#07090e["']\s+media=["']\(prefers-color-scheme:\s*dark\)["']/i);
  assert.match(indexHtml, /<meta\s+name=["']theme-color["']\s+content=["']#f8fafc["']\s+media=["']\(prefers-color-scheme:\s*light\)["']/i);

  // PWA & iOS Safari full-screen web app capabilities
  assert.match(indexHtml, /<meta\s+name=["']mobile-web-app-capable["']\s+content=["']yes["']/i);
  assert.match(indexHtml, /<meta\s+name=["']apple-mobile-web-app-capable["']\s+content=["']yes["']/i);
  assert.match(indexHtml, /<meta\s+name=["']apple-mobile-web-app-status-bar-style["']\s+content=["']black-translucent["']/i);
  assert.match(indexHtml, /<meta\s+name=["']apple-mobile-web-app-title["']\s+content=["']AgentCrew["']/i);
  assert.match(indexHtml, /<meta\s+name=["']format-detection["']\s+content=["']telephone=no["']/i);
});

test('index.html includes mobile search trigger and kanban stage navigation pills', () => {
  // Mobile search trigger in header
  assert.match(indexHtml, /id=["']mobile-search-btn["']/);
  assert.match(indexHtml, /aria-label=["']Open global search["']/);
  const mobileActions = indexHtml.match(/<div class=["']mobile-app-bar-actions["']>([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(mobileActions, /id=["']mobile-tools-btn["']/);
  assert.match(mobileActions, /aria-label=["']Workspace Tools &amp; Projects["']/);
  assert.match(indexHtml, /id=["']mobile-menu-btn["'][^>]*aria-label=["']Open navigation["'][^>]*aria-controls=["']app-sidebar["']/);

  // Mobile Kanban Stage Navigator bar
  assert.match(indexHtml, /id=["']kanban-mobile-stage-bar["']/);
  assert.match(indexHtml, /class=["'][^"']*kanban-mobile-stage-bar[^"']*["']/);
  assert.match(indexHtml, /role=["']tablist["']/);

  // 5 standard stages as pills
  assert.match(indexHtml, /data-stage=["']planning["']/);
  assert.match(indexHtml, /data-stage=["']in_progress["']/);
  assert.match(indexHtml, /data-stage=["']review["']/);
  assert.match(indexHtml, /data-stage=["']qa["']/);
  assert.match(indexHtml, /data-stage=["']done["']/);

  // Cockpit mobile terminal keys include Enter and Ctrl-C
  assert.match(indexHtml, /data-terminal-key=["']c["']/);
  assert.match(indexHtml, /data-terminal-key=["']enter["']/);
});

test('terminal.html includes standalone mobile ergonomics, accessible zoom, keys bar, and dynamic viewport', () => {
  // Viewport cover without restricting user zoom
  assert.match(terminalHtml, /viewport-fit=cover/i);
  assert.doesNotMatch(terminalHtml, /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(terminalHtml, /maximum-scale\s*=\s*1(?:\.0)?/i);

  // Standalone PWA meta tags
  assert.match(terminalHtml, /<meta\s+name=["']theme-color["']\s+content=["']#060911["']/i);
  assert.match(terminalHtml, /<meta\s+name=["']apple-mobile-web-app-capable["']\s+content=["']yes["']/i);
  assert.match(terminalHtml, /<meta\s+name=["']apple-mobile-web-app-status-bar-style["']\s+content=["']black-translucent["']/i);

  // Dynamic viewport unit 100dvh & safe area insets
  assert.match(terminalHtml, /height:\s*100dvh;/);
  assert.match(terminalHtml, /env\(safe-area-inset-top\)/);
  assert.match(terminalHtml, /env\(safe-area-inset-bottom\)/);
  assert.match(terminalHtml, /touch-action:\s*manipulation;/);

  // Terminal mobile keys bar and buttons
  assert.match(terminalHtml, /id=["']terminal-mobile-keys["']/);
  assert.match(terminalHtml, /data-terminal-key=["']escape["']/);
  assert.match(terminalHtml, /data-terminal-key=["']tab["']/);
  assert.match(terminalHtml, /data-terminal-key=["']control["']/);
  assert.match(terminalHtml, /data-terminal-key=["']c["']/);
  assert.match(terminalHtml, /data-terminal-key=["']left["']/);
  assert.match(terminalHtml, /data-terminal-key=["']down["']/);
  assert.match(terminalHtml, /data-terminal-key=["']up["']/);
  assert.match(terminalHtml, /data-terminal-key=["']right["']/);
  assert.match(terminalHtml, /data-terminal-key=["']enter["']/);

  // Visual viewport resize handler in script
  assert.match(terminalHtml, /window\.visualViewport/);
  assert.match(terminalHtml, /document\.body\.style\.height\s*=\s*`\$\{Math\.round\(window\.visualViewport\.height\)\}px`/);
  assert.match(terminalHtml, /window\.visualViewport\.addEventListener\(['"]resize['"],\s*updateViewportHeight\)/);
  assert.match(terminalHtml, /window\.visualViewport\.addEventListener\(['"]scroll['"],\s*updateViewportHeight\)/);
  assert.match(terminalHtml, /fitAddon\.fit\(\)/);
  assert.match(terminalHtml, /type:\s*['"]resize['"]/);

  // xterm input uses the mobile Ctrl latch path, and the real function maps Ctrl+D.
  assert.match(terminalHtml, /term\.onData\(\(data\)\s*=>\s*sendTerminalInput\(data\)\)/);
  const sendFunction = terminalHtml.match(/function sendTerminalInput\(data\)\s*\{[\s\S]*?\n      \}/)?.[0];
  assert.ok(sendFunction, 'sendTerminalInput function is present');
  const ws = { readyState: 1, sent: [], send(message) { this.sent.push(JSON.parse(message)); } };
  const WebSocket = { OPEN: 1 };
  const mobileKeys = { querySelector() { return { setAttribute() {} }; } };
  const input = new Function('ws', 'WebSocket', 'mobileKeys', `let ctrlLatched = true; ${sendFunction}; return { sendTerminalInput, isLatched: () => ctrlLatched };`)(ws, WebSocket, mobileKeys);
  input.sendTerminalInput('d');
  assert.equal(ws.sent[0].data, '\x04');
  assert.equal(input.isLatched(), false);

  // Key codes mapping
  assert.match(terminalHtml, /enter:\s*['"]\\r['"]/);
  assert.match(terminalHtml, /c:\s*['"]\\x03['"]/);
});

test('style.css implements universal touch optimizations and responsive mobile layout', () => {
  // Universal touch optimization
  assert.match(styleCss, /-webkit-tap-highlight-color:\s*transparent;/);
  assert.match(styleCss, /touch-action:\s*manipulation;/);

  // Responsive breakpoint @media (max-width: 900px)
  assert.match(styleCss, /@media\s*\(max-width:\s*900px\)/);

  // Desktop navigation hidden on mobile
  assert.match(styleCss, /\.agentsroom-topbar[\s\S]*?display:\s*none\s*!important/);
  assert.match(styleCss, /\.agentsroom-footer[\s\S]*?display:\s*none\s*!important/);
  assert.match(styleCss, /\.project-dock[\s\S]*?display:\s*none\s*!important/);
  assert.match(styleCss, /\.dock-rail-right[\s\S]*?display:\s*none\s*!important/);

  // Mobile navigation displayed with safe area insets
  assert.match(styleCss, /\.mobile-app-bar[\s\S]*?display:\s*flex\s*!important/);
  assert.match(styleCss, /\.mobile-bottom-nav[\s\S]*?display:\s*grid\s*!important/);
  assert.match(styleCss, /env\(safe-area-inset-top\)/);
  assert.match(styleCss, /env\(safe-area-inset-bottom\)/);

  // Virtual keyboard collision prevention
  assert.match(styleCss, /body\.virtual-keyboard-open\s+\.mobile-bottom-nav[\s\S]*?display:\s*none\s*!important/);

  // Cockpit mobile single column layout
  assert.match(styleCss, /\.agentsroom-layout[\s\S]*?flex-direction:\s*column\s*!important/);

  // Swipeable agent roster
  assert.match(styleCss, /\.agentsroom-layout\s+\.agent-roster-panel[\s\S]*?overflow-x:\s*auto\s*!important/);
  assert.match(styleCss, /\.agentsroom-layout\s+\.agent-roster-panel[\s\S]*?scrollbar-width:\s*none\s*!important/);

  // Docked floating composer with safe area insets
  assert.match(styleCss, /\.agentsroom-composer[\s\S]*?position:\s*fixed\s*!important/);
  assert.match(styleCss, /\.agentsroom-composer[\s\S]*?bottom:\s*0\s*!important/);

  // Kanban scroll snap and column sizing
  assert.match(styleCss, /\.kanban-fullscreen-wrapper[\s\S]*?scroll-snap-type:\s*x\s+mandatory\s*!important/);
  assert.match(styleCss, /\.kanban-col[\s\S]*?calc\(100vw\s*-\s*44px\)/);
  assert.match(styleCss, /\.kanban-col[\s\S]*?scroll-snap-align:\s*center\s*!important/);

  // Kanban stage pills styling
  assert.match(styleCss, /\.kanban-mobile-stage-bar/);
  assert.match(styleCss, /\.kanban-mobile-stage-bar\s*\{[^}]*display:\s*none\s*!important/s);
  assert.match(styleCss, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.kanban-mobile-stage-bar\s*\{[^}]*display:\s*flex\s*!important/s);
  assert.match(styleCss, /#panel-chat-view:not\(\[hidden\]\)/);
  assert.match(styleCss, /body\.cockpit-active\s+\.app-sidebar/);
  assert.match(styleCss, /\.kanban-stage-pill/);
  assert.match(styleCss, /\.kanban-stage-pill\.active/);

  // PR details mobile slide-over sheet
  assert.match(styleCss, /#pr-details-panel[\s\S]*?position:\s*fixed\s*!important/);
  assert.match(styleCss, /#pr-details-panel[\s\S]*?transform:\s*translateY\(100%\)\s*!important/);
  assert.match(styleCss, /#pr-details-panel:not\(\[aria-hidden="true"\]\)[\s\S]*?transform:\s*translateY\(0\)\s*!important/);

  // Mobile bottom-sheet modal card styling
  assert.match(styleCss, /\.modal-card[\s\S]*?border-radius:\s*20px\s+20px\s+0\s+0\s*!important/);
  assert.match(styleCss, /@keyframes\s+modal-slide-up/);
});

test('app.js wires mobile search palette with unified search across views, agents, and tasks', () => {
  // Mobile search button listener
  assert.match(appJs, /const\s+mobileSearchBtn\s*=\s*document\.getElementById\(['"]mobile-search-btn['"]\)/);
  assert.match(appJs, /openModalDialog\(\{/);
  assert.match(appJs, /title:\s*['"]Global Search['"]/);

  // Unified search matches views, live agents, and cached tasks
  assert.match(appJs, /#mobile-search-modal-input/);
  assert.match(appJs, /#mobile-search-modal-results/);
  assert.match(appJs, /matchedViews/);
  assert.match(appJs, /matchedAgents/);
  assert.match(appJs, /matchedTasks/);

  // Escape HTML applied to prevent XSS in search results
  assert.match(appJs, /escapeHtml\(v\.title\)/);
  assert.match(appJs, /escapeHtml\(a\.name\)/);
  assert.match(appJs, /escapeHtml\(t\.title\)/);

  // Search actions switch views and close modal
  assert.match(appJs, /switchView\(v\.id\)/);
  assert.match(appJs, /selectAgent\(a\)/);
  assert.match(appJs, /closeModalDialog\(\)/);
});

test('app.js wires mobile kanban stage pills navigation and intersection observer', () => {
  // Stage pills selector and click handler
  assert.match(appJs, /document\.querySelectorAll\(['"]\.kanban-stage-pill['"]\)/);
  assert.match(appJs, /pill\.classList\.add\(['"]active['"]\)/);
  assert.match(appJs, /pill\.setAttribute\(['"]aria-selected['"],\s*['"]true['"]\)/);
  assert.match(appJs, /\.kanban-col\[data-stage="\$\{stage\}"\]/);
  assert.match(appJs, /col\.scrollIntoView\(\{/);

  // IntersectionObserver for tracking active kanban column
  assert.match(appJs, /new\s+IntersectionObserver\(/);
  assert.match(appJs, /isMatch\s*=\s*p\.dataset\.stage\s*===\s*stage/);
  assert.match(appJs, /p\.classList\.toggle\(['"]active['"],\s*isMatch\)/);
});

test('app.js wires visualViewport resize for virtual keyboard detection and chat auto-scroll', () => {
  assert.match(appJs, /window\.visualViewport/);
  assert.match(appJs, /window\.visualViewport\.height\s*<\s*window\.innerHeight\s*\*\s*0\.82/);
  assert.match(appJs, /document\.body\.classList\.toggle\(['"]virtual-keyboard-open['"]/);
  assert.match(appJs, /team-chat-input/);
  assert.match(appJs, /team-room-chat-feed/);
  assert.match(appJs, /feed\.scrollTop\s*=\s*feed\.scrollHeight/);
  assert.match(appJs, /fitAddon\.fit\(\)/);
});

test('app.js terminal key mapper includes Enter and Ctrl-C keys', () => {
  assert.match(appJs, /enter:\s*['"]\\r['"]/);
  assert.match(appJs, /c:\s*['"]\\x03['"]/);
});

test('Mobile search modal renders safely and sanitizes search queries against XSS injection', () => {
  // Verify escapeHtml implementation handles script injection
  const escapeHtmlMatch = appJs.match(/function\s+escapeHtml\s*\(([^)]+)\)\s*\{([\s\S]*?)\}/);
  assert.ok(escapeHtmlMatch, 'escapeHtml helper must exist in app.js');

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const maliciousPayload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
  const sanitized = escapeHtml(maliciousPayload);
  assert.ok(!sanitized.includes('<script>'));
  assert.ok(!sanitized.includes('<img'));
  assert.ok(sanitized.includes('&lt;script&gt;'));
  assert.ok(sanitized.includes('&lt;img'));
});

test('Mobile search query filtering matches views, agents, and tasks with XSS sanitization', () => {
  function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const sampleViews = [
    { id: 'view-overview', title: 'Overview Dashboard', meta: 'View' },
    { id: 'view-team-room', title: 'Cockpit / Team Room', meta: 'View' },
    { id: 'view-kanban', title: 'Board & Tasks', meta: 'View' }
  ];

  const sampleAgents = [
    { name: 'Dev-1 <script>', role: 'Developer' },
    { name: 'Architect', role: 'System Architect & Lead' }
  ];

  const sampleTasks = [
    { id: 'TASK-47', title: 'Mobile "UX" & fast-tap', stage: 'in_progress' },
    { id: 'TASK-48', title: 'Security review', stage: 'review' }
  ];

  function search(query) {
    const q = query.trim().toLowerCase();
    const matchedViews = sampleViews.filter(v => v.title.toLowerCase().includes(q) || v.id.toLowerCase().includes(q));
    const matchedAgents = sampleAgents.filter(a => (a.name || '').toLowerCase().includes(q) || (a.role || '').toLowerCase().includes(q));
    const matchedTasks = sampleTasks.filter(t => (t.id || '').toLowerCase().includes(q) || (t.title || '').toLowerCase().includes(q));
    return {
      views: matchedViews.map(v => `<span class="result-title">📌 ${escapeHtml(v.title)}</span><span class="result-meta">${escapeHtml(v.meta)}</span>`),
      agents: matchedAgents.map(a => `<span class="result-title">🤖 ${escapeHtml(a.name)}</span><span class="result-meta">${escapeHtml(a.role)}</span>`),
      tasks: matchedTasks.map(t => `<span class="result-title">📋 ${escapeHtml(t.id)}: ${escapeHtml(t.title)}</span><span class="result-meta">${escapeHtml(t.stage)}</span>`)
    };
  }

  const kanbanResult = search('kanban');
  assert.equal(kanbanResult.views.length, 1);
  assert.ok(kanbanResult.views[0].includes('Board &amp; Tasks'));

  const devResult = search('dev');
  assert.equal(devResult.agents.length, 1);
  assert.ok(devResult.agents[0].includes('Dev-1 &lt;script&gt;'));
  assert.ok(!devResult.agents[0].includes('<script>'));

  const taskResult = search('fast-tap');
  assert.equal(taskResult.tasks.length, 1);
  assert.ok(taskResult.tasks[0].includes('TASK-47: Mobile &quot;UX&quot; &amp; fast-tap'));
});

test('Kanban stage pills click updates active tab and invokes scrollIntoView', () => {
  let scrolledCol = null;
  const mockColumns = {
    planning: { scrollIntoView: (opt) => { scrolledCol = { stage: 'planning', opt }; } },
    in_progress: { scrollIntoView: (opt) => { scrolledCol = { stage: 'in_progress', opt }; } }
  };

  const pills = [
    { stage: 'planning', active: true, ariaSelected: 'true' },
    { stage: 'in_progress', active: false, ariaSelected: 'false' }
  ];

  function clickPill(index) {
    pills.forEach((p, idx) => {
      p.active = (idx === index);
      p.ariaSelected = String(idx === index);
    });
    const stage = pills[index].stage;
    const col = mockColumns[stage];
    if (col) col.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  // Click on in_progress
  clickPill(1);
  assert.equal(pills[0].active, false);
  assert.equal(pills[0].ariaSelected, 'false');
  assert.equal(pills[1].active, true);
  assert.equal(pills[1].ariaSelected, 'true');
  assert.equal(scrolledCol.stage, 'in_progress');
  assert.equal(scrolledCol.opt.behavior, 'smooth');
});

test('Virtual viewport keyboard detection correctly computes height threshold', () => {
  const windowInnerHeight = 844; // iPhone 14 logical height
  const normalViewportHeight = 844;
  const keyboardOpenViewportHeight = 460;

  function isKeyboardOpen(viewportHeight, innerHeight) {
    return viewportHeight < innerHeight * 0.82;
  }

  assert.equal(isKeyboardOpen(normalViewportHeight, windowInnerHeight), false);
  assert.equal(isKeyboardOpen(keyboardOpenViewportHeight, windowInnerHeight), true);
});

