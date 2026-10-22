const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const scriptPath = path.join(__dirname, '../../src/server/public/cockpit-actions.js');
const source = fs.readFileSync(scriptPath, 'utf8');

function loadBrowser(fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ preferences: {} }) })) {
  const listeners = {};
  let eventSource;
  class EventSourceMock {
    constructor(url) { this.url = url; this.listeners = {}; eventSource = this; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) }); }
  }
  class Node {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.className = ''; this.events = {}; this.classList = { add: name => { this.className += ` ${name}`; }, remove: () => {}, toggle: () => {}, contains: name => this.className.split(/\s+/).includes(name) }; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'title') this.title = String(v); if (k === 'type') this.type = String(v); }
    getAttribute(k) { return this.attrs[k] || (k === 'title' ? this.title : null); }
    append(...nodes) { this.children.push(...nodes); nodes.forEach(n => { if (n && typeof n === 'object') n.parentNode = this; }); }
    appendChild(n) { this.append(n); return n; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
    async click() { for (const fn of this.events.click || []) await fn({ target: this, shiftKey: false }); }
    focus() { document.activeElement = this; }
    select() {}
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
    get textContent() { return this._text !== undefined ? this._text : this.children.map(x => x.textContent || '').join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    matches(selector) { return selector.split(',').some(s => { s = s.trim(); if (s.includes('#view-kanban') && (s.includes('.task-card') || s.includes('.task-item'))) return (this.classList.contains('task-card') || this.classList.contains('task-item')) && !!this.closest('#view-kanban'); if (s.includes('[id^=tasks-]')) return /^tasks-/.test(this.id || ''); if (s.includes('[id^=col-]')) return /^col-/.test(this.id || ''); if (s.includes('.agent-workspace-actions') && (s.includes('Copy Output') || s.includes('Share via Email'))) return this.tagName === 'BUTTON' && this.title === (s.includes('Copy Output') ? 'Copy Output' : 'Share via Email'); if (s.startsWith('#')) return this.id === s.slice(1); if (s.startsWith('.')) return this.classList.contains(s.slice(1)); if (s === 'button') return this.tagName === 'BUTTON'; return this.tagName === s.toUpperCase(); }); }
    closest(selector) { for (let n = this; n; n = n.parentNode) if (n.matches(selector) || (selector.includes('.task-card') && n.classList.contains('task-card')) || (selector.includes('.task-item') && n.classList.contains('task-item')) || (selector.includes('.agentsroom-agent-card') && n.classList.contains('agentsroom-agent-card'))) return n; return null; }
    querySelector(selector) { return all(this).find(n => n.matches(selector)) || null; }
    querySelectorAll(selector) { return all(this).filter(n => n.matches(selector)); }
    dispatchEvent(event) { for (const fn of document.events[event.type] || []) fn({ target: this, ...event }); }
  }
  function all(root) { return root.children.flatMap(n => [n, ...all(n)]); }
  const document = {
    readyState: 'loading', events: {}, activeElement: null, body: new Node('body'), documentElement: new Node('html'),
    querySelector(selector) { if (selector.includes('.view-header')) return controls; if (selector === '#view-kanban .view-header .view-controls') return controls; return [this.body, this.documentElement, ...all(this.body)].find(n => n.matches(selector)) || null; },
    querySelectorAll(selector) { return all(this.body).filter(n => n.matches(selector) || (selector.includes('.agentsroom-agent-card') && n.classList.contains('agentsroom-agent-card')) || (selector.includes('.agent-roster-row') && n.classList.contains('agent-roster-row'))); },
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); },
    createElement: tag => new Node(tag),
  };
  const kanban = new Node('section'); kanban.id = 'view-kanban'; kanban.className = 'view';
  const header = new Node(); header.className = 'view-header'; const controls = new Node(); controls.className = 'view-controls'; header.append(controls); kanban.append(header); document.body.append(kanban);
  const context = { document, window: {}, location: { href: 'http://localhost/', search: '' }, navigator: { clipboard: { writeText: async () => {} } }, fetch: fetchImpl, EventSource: EventSourceMock, URL, URLSearchParams, Event: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }, setTimeout, clearTimeout, console };
  vm.createContext(context); vm.runInContext(source, context, { filename: 'cockpit-actions.js' });
  return { context, document, listeners: document.events, Node, kanban, get eventSource() { return eventSource; } };
}

test('cockpit actions wires accessible ideas/backlog, refreshes views, and uses the five board stages', () => {
  assert.match(source, /#btn-open-backlog, #btn-open-ideas/);
  assert.match(source, /node\.tabIndex = 0; node\.setAttribute\('role', 'button'\)/);
  assert.match(source, /agentcrew:roster-rendered/);
  assert.match(source, /include_cleared=1/);
  assert.match(source, /const STAGES = \['planning', 'in_progress', 'review', 'qa', 'done'\]/);
  assert.match(source, /agentCrewRefreshTasks/);
  assert.match(source, /refreshCounts\(\)/);
});

test('cockpit actions parses and exports initializer without unsafe HTML sinks', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /window\.initCockpitActions\s*=\s*bind/);
  assert.match(source, /DOMContentLoaded/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test('initializer is idempotent, exports action methods and exposes a real API helper', async () => {
  const calls = [];
  const { context, listeners } = loadBrowser(async (url, options) => { calls.push([url, options]); return { ok: true, status: 200, json: async () => ({ value: 3, preferences: {} }) }; });
  listeners.DOMContentLoaded[0]();
  const actions = context.window.agentCrewActions;
  for (const name of ['openNewTask', 'openFilesDrawer', 'openCommands', 'openHealth', 'openState', 'openIdeas', 'openBroadcast', 'openSnippets', 'openDiagnostics']) assert.equal(typeof actions[name], 'function');
  assert.equal((await actions.api('/api/v1/health')).value, 3);
  assert.ok(calls.some(([url]) => url === '/api/v1/preferences'));
  assert.equal(context.window.initCockpitActions(), actions);
});

test('API helper surfaces server errors to inline UI callers', async () => {
  const { context, listeners } = loadBrowser(async () => ({ ok: false, status: 409, json: async () => ({ error: 'Scheduler is paused' }) }));
  listeners.DOMContentLoaded[0]();
  await assert.rejects(context.window.agentCrewActions.api('/api/v1/commands'), /Scheduler is paused/);
});

test('Signals renders health and recent job/event data without fetching the SSE endpoint', async () => {
  const calls = [];
  const { context, listeners, document } = loadBrowser(async url => { calls.push(url); return { ok: true, status: 200, json: async () => url.endsWith('/health') ? { ok: true } : { items: [{ id: 'job-1' }] } }; });
  listeners.DOMContentLoaded[0](); const actions = context.window.agentCrewActions; actions.state.lastEvents.push({ type: 'task.created' });
  await actions.openSignals();
  assert.ok(calls.includes('/api/v1/health'));
  assert.ok(calls.includes('/api/v1/state?collection=jobs'));
  assert.ok(!calls.includes('/api/v1/events'));
  assert.ok(document.body.textContent.includes('Runtime health'));
  assert.ok(document.body.textContent.includes('task.created'));
});

test('search filters roster, clearing restores status-filtered cards, and history reapplies a query', async () => {
  const { context, listeners, document, Node } = loadBrowser(); listeners.DOMContentLoaded[0]();
  const grid = new Node(); grid.id = 'team-room-grid'; const alice = new Node(); alice.className = 'agentsroom-agent-card'; alice.textContent = 'Alice Developer'; alice.dataset.status = 'working'; const bob = new Node(); bob.className = 'agentsroom-agent-card'; bob.textContent = 'Bob Architect'; bob.dataset.status = 'idle'; grid.append(alice, bob); document.body.append(grid);
  const input = new Node('input'); input.id = 'agent-search'; document.body.append(input);
  context.window.agentCrewActions.state.statusFilter = 'working';
  input.value = 'bob'; listeners.input[0]({ target: input }); assert.equal(alice.hidden, true); assert.equal(bob.hidden, true);
  input.value = ''; listeners.input[0]({ target: input }); assert.equal(alice.hidden, false); assert.equal(bob.hidden, true);
  input.value = 'bob'; listeners.change[0]({ target: input });
  context.window.agentCrewActions.state.queries.push('alice');
  const history = new Node('button'); history.id = 'btn-search-history'; document.body.append(history);
  await listeners.click[0]({ target: history });
  const dialogButton = document.querySelector('#shared-dialog-body')?.querySelectorAll('button').find(node => node.textContent === 'alice'); await dialogButton.click();
  assert.equal(input.value, 'alice'); assert.equal(alice.hidden, false); assert.equal(bob.hidden, true);
});

test('Copy Output works and real in-progress Kanban task item opens task detail; named SSE events are buffered', async () => {
  let copied = 0;
  const browser = loadBrowser(); const { context, listeners, document, Node } = browser; context.navigator.clipboard.writeText = async () => { copied++; }; listeners.DOMContentLoaded[0]();
  const actions = new Node(); actions.className = 'agent-workspace-actions'; const copy = new Node('button'); copy.title = 'Copy Output'; actions.append(copy); document.body.append(actions);
  const feed = new Node(); feed.id = 'team-room-chat-feed'; feed.textContent = 'transcript'; document.body.append(feed);
  await listeners.click[0]({ target: copy }); await Promise.resolve(); assert.equal(copied, 1);
  const column = new Node(); column.id = 'tasks-in_progress'; const card = new Node(); card.className = 'task-item'; card.dataset.taskId = 'TASK-1'; const id = new Node('span'); id.className = 'task-id'; id.textContent = 'TASK-1'; const title = new Node('div'); title.className = 'task-title'; title.textContent = 'Task one'; card.append(id, title); column.append(card); document.body.querySelector('#view-kanban').append(column);
  await listeners.click[0]({ target: card });
  assert.equal(document.querySelector('#shared-dialog-title').textContent, 'Task Detail & Transition');
  assert.ok(document.querySelector('#shared-dialog-body').textContent.includes('Current stage: in_progress'));
  assert.equal(document.querySelector('#shared-dialog-body').querySelectorAll('button').length, 5);
  assert.ok(browser.eventSource.listeners['command.completed']);
  browser.eventSource.emit('command.completed', { command_id: 'cmd-1', status: 'completed' });
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.agentCrewActions.state.lastEvents.at(-1))), { type: 'command.completed', command_id: 'cmd-1', status: 'completed' });
  for (const type of ['snapshot', 'turn_queued', 'turn_started', 'turn_completed', 'agent_thinking', 'agent_thinking_ended', 'agent_provider_configured', 'takeover_quiesced', 'command_executed', 'iteration_started', 'iteration_completed', 'ping']) assert.ok(browser.eventSource.listeners[type], `listens for ${type}`);
});

test('New Task button submits task.create', async () => {
  const commands = [];
  const { context, listeners, document } = loadBrowser(async (url, options) => { if (url === '/api/v1/commands') commands.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ preferences: {}, result: {} }) }; });
  listeners.DOMContentLoaded[0]();
  const newTask = document.querySelector('#btn-kanban-new-task'); assert.ok(newTask); await newTask.click();
  const create = document.querySelector('#shared-dialog-body').querySelector('button');
  const fields = document.querySelector('#shared-dialog-body').querySelectorAll('input, textarea');
  fields[0].value = 'Test task'; fields[1].value = 'Description'; await create.click();
  assert.equal(commands[0].command_type, 'task.create'); assert.deepEqual(commands[0].payload, { title: 'Test task', description: 'Description' });
});

test('Share transcript fetches room messages and opens export options without recursive overflow', async () => {
  const calls = [];
  const browser = loadBrowser(async url => { calls.push(url); return { ok: true, status: 200, json: async () => url.startsWith('/api/v1/room/messages') ? { messages: [{ text: 'hello', sender_name: 'Dev-1' }] } : { preferences: {} } }; });
  const { context, listeners, document, Node } = browser;
  listeners.DOMContentLoaded[0]();
  const actions = new Node(); actions.className = 'agent-workspace-actions';
  const share = new Node('button'); share.title = 'Share via Email'; actions.append(share); document.body.append(actions);
  await assert.doesNotReject(listeners.click[0]({ target: share }));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(url => url.startsWith('/api/v1/room/messages')));
  assert.equal(document.querySelector('#shared-dialog-title').textContent, 'Share & Export');
  assert.ok(document.querySelector('#shared-dialog-body').textContent.includes('1 messages loaded.'));
});

test('Agent Configuration dialog pre-populates fields, binds to selected agent and saves configuration', async () => {
  const commands = [];
  const browser = loadBrowser(async (url, options) => {
    if (url === '/api/v1/commands') commands.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ preferences: {}, result: { role: 'PO Lead', provider: 'codex', model: 'gpt-6', backup_provider: 'agy', backup_model: 'gemini-2.5-pro' } }) };
  });
  const { context, listeners, document, Node } = browser;
  context.window.agentCrewSelectedAgent = () => ({
    id: 'agent-peter-123',
    name: 'Peter',
    role: 'Product Owner',
    provider: 'agy',
    model: 'gemini-2.5-pro',
    backup_provider: 'codex',
    backup_model: 'gpt-6'
  });
  listeners.DOMContentLoaded[0]();

  const rolePill = new Node('div');
  rolePill.id = 'agent-role-pill';
  rolePill.className = 'dropdown-pill role-dropdown';
  document.body.append(rolePill);

  await listeners.click[0]({ target: rolePill });
  assert.equal(document.querySelector('#shared-dialog-title').textContent, 'Agent Configuration: Peter');

  const selects = document.querySelector('#shared-dialog-body').querySelectorAll('select');
  assert.equal(selects.length, 2, 'Must have primary and backup provider selects');
  assert.equal(selects[0].value, 'agy');

  // Change to codex
  selects[0].value = 'codex';
  const saveBtn = document.querySelector('#shared-dialog-body').querySelectorAll('button').find(b => b.textContent === 'Save configuration');
  assert.ok(saveBtn);
  await saveBtn.click();

  assert.equal(commands.length, 1);
  assert.equal(commands[0].command_type, 'agent.configure');
  assert.equal(commands[0].payload.agent_id, 'agent-peter-123');
  assert.equal(commands[0].payload.provider, 'codex');
});
