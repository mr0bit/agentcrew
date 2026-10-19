(function () {
  'use strict';
  const STAGES = ['backlog', 'todo', 'in_progress', 'review', 'done'];
  const CHANNELS = ['team-activity', 'general', 'deployments', 'architecture'];
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const el = (tag, text, attrs = {}) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'checked' || key === 'disabled') node[key] = Boolean(value);
      else if (key === 'value') node.value = value;
      else node.setAttribute(key, value);
    }
    return node;
  };
  const state = { selectedAgent: null, selectedAgentId: null, channel: 'team-activity', speech: false, starsOnly: false, statusFilter: '', queries: [], lastEvents: [], preferences: {}, audioFeed: false };

  function toast(message, error = false) {
    let host = $('#global-toast-container');
    if (!host) { host = el('div', undefined, { id: 'global-toast-container', 'aria-live': 'polite' }); document.body.append(host); }
    const item = el('div', message, { role: error ? 'alert' : 'status', class: error ? 'cockpit-toast error' : 'cockpit-toast' });
    host.append(item); setTimeout(() => item.remove(), 4500);
  }
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  const command = (command_type, payload = {}) => api('/api/v1/commands', { method: 'POST', body: JSON.stringify({ command_type, payload }) });
  function showDialog(title, content, subtitle = '') {
    const prior = document.activeElement;
    let overlay = $('#shared-dialog-modal');
    if (!overlay) {
      overlay = el('div', undefined, { id: 'shared-dialog-modal', class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shared-dialog-title' });
      const card = el('div', undefined, { class: 'modal-card' });
      const header = el('div', undefined, { class: 'modal-header' });
      const textWrap = el('div'); header.append(textWrap);
      const heading = el('h2', title, { id: 'shared-dialog-title', class: 'modal-title' });
      const sub = el('p', subtitle, { id: 'shared-dialog-subtitle', class: 'modal-subtitle' });
      textWrap.append(heading, sub);
      const close = el('button', '×', { type: 'button', class: 'modal-close-btn', 'aria-label': 'Close dialog' });
      header.append(close);
      const body = el('div', undefined, { id: 'shared-dialog-body', class: 'modal-body' });
      card.append(header, body); overlay.append(card); document.body.append(overlay);
      close.addEventListener('click', () => hideDialog());
      overlay.addEventListener('click', event => { if (event.target === overlay) hideDialog(); });
      overlay.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); hideDialog(); } });
      overlay._parts = { heading, sub, body, close };
    }
    const parts = overlay._parts || { heading: $('#shared-dialog-title', overlay), sub: $('#shared-dialog-subtitle', overlay), body: $('#shared-dialog-body', overlay), close: $('.modal-close-btn', overlay) };
    parts.heading.textContent = title; parts.sub.textContent = subtitle; parts.sub.hidden = !subtitle;
    parts.body.replaceChildren(content); overlay.hidden = false; overlay._returnFocus = prior; parts.close.focus();
    return overlay;
  }
  function hideDialog() {
    const overlay = $('#shared-dialog-modal'); if (!overlay || overlay.hidden) return;
    overlay.hidden = true; overlay._returnFocus?.focus?.();
  }
  function paragraph(text) { return el('p', text); }
  function errorLine(parent, error) { let line = $('.cockpit-inline-error', parent); if (!line) { line = el('p', '', { class: 'cockpit-inline-error', role: 'alert' }); parent.append(line); } line.textContent = error.message || String(error); }
  function button(label, fn, attrs = {}) { const b = el('button', label, { type: 'button', ...attrs }); b.addEventListener('click', fn); return b; }
  function field(labelText, type = 'text', value = '') {
    const wrap = el('label', undefined, { class: 'cockpit-field' }); wrap.append(el('span', labelText));
    const input = type === 'textarea' ? el('textarea') : el('input', undefined, { type });
    input.value = value || ''; wrap.append(input); return { wrap, input };
  }
  function pre(text) { return el('pre', typeof text === 'string' ? text : JSON.stringify(text, null, 2), { class: 'cockpit-data' }); }
  function download(name, contents, type) {
    const blob = new Blob([contents], { type }); const link = el('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  function selected() {
    const name = $('#selected-agent-name')?.textContent?.trim();
    const card = $$('.agentsroom-agent-card, .agent-roster-row').find(item => item.classList.contains('selected'));
    return { name: state.selectedAgent || name || '', id: state.selectedAgentId || card?.dataset?.agentId || name || '' };
  }
  async function messages(channel = state.channel) { const result = await api(`/api/v1/room/messages?channel=${encodeURIComponent(channel)}`); return result.messages || []; }
  function messageText(items) { return items.map(m => `[${m.created_at || ''}] ${m.sender_name || m.sender_id || 'Unknown'}: ${m.text || ''}`).join('\n'); }
  async function copy(text) {
    try { if (!text) throw new Error('There is no text to copy.'); if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.'); await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); }
    catch (error) {
      const box = el('div'); box.append(paragraph(`${error.message} Select and copy the text below.`));
      const input = el('textarea', undefined, { rows: '8', 'aria-label': 'Text to copy' }); input.value = text || ''; box.append(input); showDialog('Copy text', box); input.focus(); input.select();
    }
  }
  function renderMessages(target, items) {
    target.replaceChildren();
    for (const m of items) { const row = el('article', undefined, { class: 'cockpit-message' }); row.append(el('strong', m.sender_name || m.sender_id || 'Unknown'), el('p', m.text || ''), el('small', m.created_at || '')); target.append(row); }
    if (!items.length) target.append(paragraph('No messages in this channel yet.'));
  }
  async function loadFeed(channel = state.channel) {
    try { state.channel = channel; const feed = $('#team-room-chat-feed'); if (feed) renderMessages(feed, await messages(channel)); }
    catch (error) { toast(error.message, true); }
  }
  function safeCardFilter(status) {
    state.statusFilter = status;
    $$('#team-room-grid .agentsroom-agent-card, #team-room-grid .agent-roster-row').forEach(card => {
      const text = `${card.dataset.status || ''} ${card.textContent}`.toLowerCase();
      const statusMatch = !status || (status === 'needs-you' ? /needs.?you|takeover|blocked/.test(text) : status === 'to-review' ? /review/.test(text) : /work|execut|active/.test(text));
      const starMatch = !state.starsOnly || (card.dataset.starred === 'true' || card.classList.contains('starred'));
      card.hidden = !(statusMatch && starMatch);
    });
  }
  function filterAgentCards(query) {
    const q = String(query || '').trim().toLowerCase();
    safeCardFilter(state.statusFilter);
    if (!q) return;
    $$('#team-room-grid .agentsroom-agent-card, #team-room-grid .agent-roster-row').forEach(card => {
      card.hidden = card.hidden || !card.textContent.toLowerCase().includes(q);
    });
  }
  function rememberQuery(query) {
    const q = String(query || '').trim();
    if (q && state.queries[state.queries.length - 1] !== q) state.queries.push(q);
  }
  function updateClass(selector, active) { $$(selector).forEach(b => { b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }); }
  async function toggleTurbo() {
    const next = !Boolean(state.preferences.turbo);
    try { const result = await command('preferences.update', { turbo: next }); state.preferences = result.result || result.preferences || { ...state.preferences, turbo: next }; updateClass(".cockpit-utility-bar button[title='Fast Execution'], .roster-quick-icons button[title='Turbo turns']", next); toast(`Turbo mode ${next ? 'enabled' : 'disabled'}.`); }
    catch (e) { toast(e.message, true); }
  }
  async function togglePreferenceArray(key, value, selector) {
    try { const prefs = (await api('/api/v1/preferences')).preferences || {}; const values = new Set(prefs[key] || []); values.has(value) ? values.delete(value) : values.add(value); state.preferences = (await command('preferences.update', { [key]: [...values] })).result || { ...prefs, [key]: [...values] }; updateClass(selector, values.has(value)); renderRosterBadges(); }
    catch (e) { toast(e.message, true); }
  }
  function renderRosterBadges() {
    const pins = new Set(state.preferences.pins || []), stars = new Set(state.preferences.stars || []);
    $$('#team-room-grid .agentsroom-agent-card, #team-room-grid .agent-roster-row').forEach(card => {
      const name = card.dataset.agentName || card.querySelector('.agent-card-name')?.textContent?.trim() || '';
      card.dataset.starred = String(stars.has(name)); card.classList.toggle('starred', stars.has(name));
      let badge = $('.cockpit-pin-badge', card); if (pins.has(name) && !badge) { badge = el('span', 'Pinned', { class: 'cockpit-pin-badge' }); card.append(badge); } else if (!pins.has(name)) badge?.remove();
    });
  }

  async function openTranscript() {
    try { const data = await messages(); const body = el('div'); body.append(paragraph(`${data.length} messages loaded.`), button('Download Markdown (.md)', () => download('transcript.md', messageText(data), 'text/markdown')), button('Download JSON (.json)', () => download('transcript.json', JSON.stringify(data, null, 2), 'application/json')), button('Open Email Draft (mailto:)', () => { location.href = `mailto:?subject=${encodeURIComponent('AgentCrew transcript')}&body=${encodeURIComponent(messageText(data))}`; })); showDialog('Share & Export', body); }
    catch (e) { toast(e.message, true); }
  }
  function openMore() {
    const body = el('div');
    body.append(button('Export Transcript (JSON)', async () => { try { download('transcript.json', JSON.stringify(await messages(), null, 2), 'application/json'); } catch (e) { errorLine(body, e); } }), button('Export Transcript (Markdown)', async () => { try { download('transcript.md', messageText(await messages()), 'text/markdown'); } catch (e) { errorLine(body, e); } }));
    for (const [label, type] of [['Clear Session View', 'session.clear_view'], ['Reset Conversation', 'session.reset']]) body.append(button(label, async () => { try { await command(type, { agent_id: selected().id }); await loadFeed(); toast(`${label} completed.`); hideDialog(); } catch (e) { errorLine(body, e); } }));
    showDialog('More Options', body);
  }
  function openAgentConfig() {
    const agent = selected(), box = el('div'); const role = field('Role'), model = field('Model'), provider = field('Provider');
    role.input.value = $('#selected-agent-role')?.textContent?.trim() || ''; model.input.value = $('#selected-agent-model')?.textContent?.trim() || '';
    provider.input.setAttribute('list', 'cockpit-provider-list'); const list = el('datalist', undefined, { id: 'cockpit-provider-list' }); ['agy', 'codex', 'gemini'].forEach(x => list.append(el('option', undefined, { value: x })));
    box.append(role.wrap, model.wrap, provider.wrap, list); box.append(button('Save configuration', async () => { try { const result = await command('agent.configure', { agent_id: agent.id, role: role.input.value, model: model.input.value, provider: provider.input.value }); const updated = result.result || {}; if ($('#selected-agent-role')) $('#selected-agent-role').textContent = updated.role || role.input.value; if ($('#selected-agent-model')) $('#selected-agent-model').textContent = updated.model || model.input.value; if ($('#selected-agent-provider')) $('#selected-agent-provider').textContent = updated.provider || provider.input.value; toast('Agent configuration saved.'); hideDialog(); } catch (e) { errorLine(box, e); } })); showDialog('Agent Configuration', box);
  }
  async function openCommands() {
    const box = el('div'); showDialog('Command Runner', box);
    try { const catalog = (await api('/api/v1/command-catalog')).commands || []; for (const job of catalog) { const row = el('section'); row.append(el('strong', job.name || job.id), el('p', job.description || '')); const status = el('p', 'Ready', { role: 'status' }); const output = el('pre'); row.append(status, output, button('Run', async () => { try { status.textContent = 'Running'; const res = await command('command.run', { job_id: job.id }); const run = res.result || {}; output.textContent = run.output || ''; const cancel = run.run_id && run.status === 'running' ? button('Cancel', async () => { try { const done = await command('command.cancel', { run_id: run.run_id }); status.textContent = (done.result || {}).status || 'Cancelled'; cancel.remove(); } catch (e) { errorLine(row, e); } }) : null; if (cancel) row.append(cancel); status.textContent = `${run.status || 'running'}${run.exit_code == null ? '' : ` · exit ${run.exit_code}`}`; if (run.run_id && run.status === 'running') { const poll = async () => { try { const jobs = await api('/api/v1/state?collection=jobs'); const current = (jobs.items || []).find(item => item.run_id === run.run_id); if (!current) return; status.textContent = `${current.status}${current.exit_code == null ? '' : ` · exit ${current.exit_code}`}`; output.textContent = current.output || output.textContent; if (current.status === 'running' && !box.closest('[hidden]')) setTimeout(poll, 800); else cancel?.remove(); } catch (e) { errorLine(row, e); } }; setTimeout(poll, 800); } } catch (e) { errorLine(row, e); status.textContent = 'Failed'; } })); box.append(row); } if (!catalog.length) box.append(paragraph('No runnable commands are configured.')); }
    catch (e) { errorLine(box, e); }
  }
  async function openHealth(title = 'Servers & Runtime Health') { const box = el('div'); showDialog(title, box); async function refresh() { try { const h = await api('/api/v1/health'); box.replaceChildren(button('Refresh', refresh), pre(h)); } catch (e) { errorLine(box, e); } } await refresh(); }
  async function openState(collection = 'projects') { const box = el('div'), nav = el('nav', undefined, { 'aria-label': 'State collections' }), output = el('div'); box.append(nav, output); showDialog('Redacted State Inspector', box); async function load(name) { try { const data = await api(`/api/v1/state?collection=${encodeURIComponent(name)}`); output.replaceChildren(pre(data.items || [])); } catch (e) { errorLine(output, e); } } ['projects', 'agents', 'tasks', 'sessions', 'jobs'].forEach(name => nav.append(button(name, () => load(name), { 'aria-pressed': String(name === collection) }))); await load(collection); }
  function openTags() { const box = el('div'), input = field('Project tag'); box.append(input.wrap); showDialog('Project Tags', box); api('/api/v1/preferences').then(({ preferences = {} }) => { state.preferences = preferences; const list = el('div'); (preferences.tags || []).forEach(tag => list.append(button(`Remove ${tag}`, async () => save((preferences.tags || []).filter(x => x !== tag))))); box.append(list); }).catch(e => errorLine(box, e)); const save = async tags => { try { const result = await command('preferences.update', { tags }); state.preferences = result.result || { ...state.preferences, tags }; toast('Tags updated.'); hideDialog(); } catch (e) { errorLine(box, e); } }; box.append(button('Add tag', () => { const tag = input.input.value.trim(); if (tag) save([...(state.preferences.tags || []), tag]); })); }
  function toggleSplit() { document.body.classList.toggle('cockpit-split-view'); const chat = $('#panel-chat-view'), terminal = $('#panel-terminal-view'); if (document.body.classList.contains('cockpit-split-view')) { if (chat) chat.hidden = false; if (terminal) terminal.hidden = false; } }
  async function openGit() { const box = el('div'), files = el('div'), diff = el('pre'); let view = 'working'; box.append(el('div', 'View: '), button('Working', () => { view = 'working'; if (state.gitPath) showDiff(state.gitPath); }), button('Staged', () => { view = 'staged'; if (state.gitPath) showDiff(state.gitPath); }), files, diff); showDialog('Files & Git Changes', box); async function showDiff(path) { state.gitPath = path; try { const data = await api(`/api/v1/git/diff?path=${encodeURIComponent(path)}&view=${view}`); diff.textContent = data.diff || 'No diff.'; } catch (e) { errorLine(box, e); } } try { const data = await api('/api/v1/git/status'); box.insertBefore(paragraph(`Branch: ${data.branch || 'unknown'}`), files); for (const file of data.files || []) files.append(button(`${file.status} ${file.path}`, () => showDiff(file.path))); if (!data.files?.length) files.append(paragraph('Working tree is clean.')); } catch (e) { errorLine(box, e); } }
  function openChannels() { const box = el('div'), nav = el('nav', undefined, { 'aria-label': 'Channels' }), feed = el('div'), text = field('Message', 'textarea'); const post = button('Post message', async () => { try { if (!text.input.value.trim()) return; await api('/api/v1/room/messages', { method: 'POST', body: JSON.stringify({ channel: state.channel, text: text.input.value }) }); text.input.value = ''; await load(); } catch (e) { errorLine(box, e); } }); box.append(nav, feed, text.wrap, post); showDialog('Channel Discussions', box); async function load() { try { renderMessages(feed, await messages(state.channel)); } catch (e) { errorLine(box, e); } } CHANNELS.forEach(channel => nav.append(button(channel, () => { state.channel = channel; load(); }))); load(); }
  function startAudio() { if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) { toast('Speech synthesis is unavailable in this browser.', true); return; } state.audioFeed = !state.audioFeed; updateClass('#btn-rail-audio', state.audioFeed); toast(`Incoming message speech ${state.audioFeed ? 'enabled' : 'disabled'}.`); }
  async function openIdeas() { const box = el('div'), list = el('div'), title = field('Idea title'), desc = field('Description', 'textarea'); box.append(title.wrap, desc.wrap, button('Save idea', async () => { try { await command('idea.save', { title: title.input.value, description: desc.input.value }); await load(); } catch (e) { errorLine(box, e); } }), list); showDialog('Idea Radar', box); async function load() { try { const data = await api('/api/v1/ideas'); const items = data.ideas || []; list.replaceChildren(); items.forEach(idea => { const item = el('article'); item.append(el('strong', idea.title), paragraph(idea.description), button('Promote to Task', async () => { try { await command('idea.promote', { id: idea.id }); await load(); const count = $('#backlog-tasks-count'); if (count) count.textContent = String(Number(count.textContent || 0) + 1); } catch (e) { errorLine(item, e); } })); list.append(item); }); const count = $('#idea-radar-count'); if (count) count.textContent = String(items.length); } catch (e) { errorLine(list, e); } } load(); }
  function openNewTask() { const box = el('div'), title = field('Task title'), description = field('Description', 'textarea'); box.append(title.wrap, description.wrap, button('Create task', async () => { try { await command('task.create', { title: title.input.value, description: description.input.value }); toast('Task created.'); hideDialog(); } catch (e) { errorLine(box, e); } })); showDialog('New Task', box); }
  async function schedulerRun() { try { const result = await command('scheduler.run_next'); showDialog('Scheduler result', pre(result.result || result)); } catch (e) { toast(e.message, true); } }
  async function openBroadcast() { const box = el('div'), text = field('Prompt', 'textarea'), recipients = el('div'); box.append(text.wrap, recipients); showDialog('Broadcast Prompt', box); try { const data = await api('/api/v1/agents'); (data.agents || []).forEach(agent => { const label = el('label'); const check = el('input', undefined, { type: 'checkbox', value: agent.name }); label.append(check, document.createTextNode(agent.name)); recipients.append(label); }); box.append(button('Broadcast', async () => { try { const ids = $$('input:checked', recipients).map(x => x.value); await command('message.broadcast', { agent_ids: ids, text: text.input.value, channel: state.channel }); toast('Broadcast sent.'); hideDialog(); } catch (e) { errorLine(box, e); } })); } catch (e) { errorLine(box, e); } }
  async function hireSpecialist() { const box = el('div'), name = field('Name'), role = field('Role'), provider = field('Provider'), model = field('Model'); box.append(name.wrap, role.wrap, provider.wrap, model.wrap, button('Hire specialist', async () => { try { await command('specialist.hire', { name: name.input.value, role: role.input.value, provider: provider.input.value || 'codex', model: model.input.value }); toast('Specialist added. Refresh the roster to load it.'); hideDialog(); } catch (e) { errorLine(box, e); } })); showDialog('Hire Specialist', box); }
  async function openSignals() { const box = el('div'); showDialog('Signals', box); try { const [health, jobs] = await Promise.all([api('/api/v1/health'), api('/api/v1/state?collection=jobs')]); box.append(el('h3', 'Runtime health'), pre(health), el('h3', 'Recent jobs'), pre(jobs.items || []), el('h3', 'Recent events'), pre(state.lastEvents)); } catch (e) { errorLine(box, e); } }
  async function openInbox() { const box = el('div'); showDialog('Handoff Inbox', box); try { const items = await messages(); renderMessages(box, items.filter(m => /@operator|operator|handoff/i.test(`${m.text} ${m.sender_name}`))); } catch (e) { errorLine(box, e); } }
  async function openAlerts() { const box = el('div'); showDialog('Alerts & Gates', box); try { const [tasks, jobs] = await Promise.all([api('/api/v1/tasks'), api('/api/v1/state?collection=jobs')]); box.append(el('h3', 'Blocked tasks'), pre((tasks.tasks || []).filter(t => /blocked|gate/i.test(`${t.stage} ${t.status}`))), el('h3', 'Recent jobs'), pre(jobs.items || [])); } catch (e) { errorLine(box, e); } }
  async function openKnowledge() { const box = el('div'); showDialog('Knowledge Base', box); try { const data = await api('/api/v1/context?kind=docs'); (data.docs || []).forEach(doc => { box.append(el('h3', doc.path), pre(doc.snippet)); }); } catch (e) { errorLine(box, e); } }
  async function openSnippets() { const box = el('div'), title = field('Title'), content = field('Content', 'textarea'), list = el('div'); box.append(title.wrap, content.wrap, button('Save snippet', async () => { try { await command('snippet.save', { title: title.input.value, content: content.input.value }); await load(); } catch (e) { errorLine(box, e); } }), button('Insert into chat input', () => { const input = $('#team-chat-input'); if (input) { input.value += content.input.value; input.focus(); } else toast('Chat input is unavailable.', true); }), list); showDialog('Snippets Manager', box); async function load() { try { const data = await api('/api/v1/snippets'); list.replaceChildren(); (data.snippets || []).forEach(snippet => { const row = el('div'); row.append(el('strong', snippet.title), paragraph(snippet.content), button('Insert', () => { content.input.value = snippet.content; const input = $('#team-chat-input'); if (input) input.value = snippet.content; }), button('Delete', async () => { try { await command('snippet.delete', { id: snippet.id }); await load(); } catch (e) { errorLine(row, e); } })); list.append(row); }); } catch (e) { errorLine(list, e); } } load(); }
  async function openTask(task) { const box = el('div'); box.append(el('h3', task.title || task.id), paragraph(task.description || ''), paragraph(`Current stage: ${task.stage || 'unknown'}`)); STAGES.forEach(stage => box.append(button(`Move to ${stage}`, async () => { try { await command('task.transition', { id: task.id, stage }); toast(`Task moved to ${stage}.`); hideDialog(); } catch (e) { errorLine(box, e); } }))); showDialog('Task Detail & Transition', box); }
  async function openSystem() { const box = el('div'); showDialog('System & Scheduler Controls', box); try { const health = await api('/api/v1/health'); box.append(pre(health), button(health.scheduler?.paused ? 'Resume scheduler' : 'Pause scheduler', async () => { try { await command(health.scheduler?.paused ? 'scheduler.resume' : 'scheduler.pause'); openSystem(); } catch (e) { errorLine(box, e); } }), button('Run next', schedulerRun)); } catch (e) { errorLine(box, e); } }
  function openSecurity() { showDialog('Security & Sandboxing', paragraph('This local supervisor exposes its browser API without an authentication layer. Provider credentials remain managed by the official local CLI tools. No sandbox or command policy details are reported by the current health API.')); }
  function openBrowser() { const box = el('div'); [['Clipboard', Boolean(navigator.clipboard?.writeText)], ['Fullscreen', Boolean(document.documentElement.requestFullscreen)], ['Speech synthesis', Boolean(window.speechSynthesis)], ['Speech recognition', Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)], ['WebSocket', Boolean(window.WebSocket)], ['Service worker', Boolean(navigator.serviceWorker)]].forEach(([name, supported]) => box.append(paragraph(`${name}: ${supported ? 'available' : 'unavailable'}`))); showDialog('Browser Capabilities', box); }
  async function openDiagnostics() { const box = el('div'); showDialog('Redacted Diagnostics', box); try { const data = await api('/api/v1/diagnostics'); box.append(pre(data), button('Download JSON', () => download('agentcrew-diagnostics.json', JSON.stringify(data, null, 2), 'application/json'))); } catch (e) { errorLine(box, e); } }
  function openMobile() { showDialog('Mobile Access', paragraph(`This dashboard is available at the supervisor address shown in Servers & Runtime Health. To use it on a phone, the browser must be able to reach this machine; no remote tunnel or authentication setup is created by this control.`)); }
  async function loadPreferences() { try { state.preferences = (await api('/api/v1/preferences')).preferences || {}; updateClass(".cockpit-utility-bar button[title='Fast Execution'], .roster-quick-icons button[title='Turbo turns']", Boolean(state.preferences.turbo)); renderRosterBadges(); } catch (_) {} }
  function bind() {
    if (window.agentCrewActions?.initialized) return window.agentCrewActions;
    const actions = window.agentCrewActions = { initialized: true, api, command, showDialog, hideDialog, loadFeed, selected, state, openNewTask, openFilesDrawer: openGit, openCommands, openHealth, openState, openIdeas, openBroadcast, openSnippets, openDiagnostics, openSignals, toggleSplit };
    const kanbanControls = $('#view-kanban .view-header .view-controls') || $('#view-kanban .view-header');
    if (kanbanControls && !$('#btn-kanban-new-task')) kanbanControls.append(button('+ New Task', openNewTask, { id: 'btn-kanban-new-task', class: 'btn btn-primary btn-sm' }));
    document.addEventListener('click', async event => {
      const target = event.target.closest('button, [role="button"], .task-card, .task-item, .status-summary-item, #btn-open-backlog'); if (!target) return;
      const title = target.getAttribute('title') || '';
      if (target.matches(".agent-workspace-actions button[title='Session Link']")) { const url = new URL(location.href); url.searchParams.set('agent', selected().name); let project = new URLSearchParams(location.search).get('project'); if (!project) { try { project = (await api('/api/v1/health')).project_id; } catch (_) {} } if (project) url.searchParams.set('project', project); await copy(url.href); }
      else if (target.matches(".agent-workspace-actions button[title='Copy Output']")) await copy($$('#team-room-chat-feed .cockpit-message, #team-room-chat-feed [data-message-id]').map(x => x.textContent.trim()).join('\n') || $('#team-room-chat-feed')?.textContent?.trim() || '');
      else if (target.matches(".agent-workspace-actions button[title='Share via Email']")) openTranscript(); else if (target.matches(".agent-workspace-actions button[title='More Options']")) openMore();
      else if (target.id === 'agent-role-pill' || target.id === 'agent-model-pill') openAgentConfig();
      else if (target.id === 'btn-utility-commands') openCommands(); else if (target.id === 'btn-utility-servers') openHealth(); else if (target.id === 'btn-utility-databases') openState();
      else if (title === 'Fast Execution' || title === 'Turbo turns') toggleTurbo(); else if (title === 'Tags') openTags(); else if (title === 'Split Screen') toggleSplit();
      else if (target.id === 'btn-toggle-files-changes') openGit(); else if (title === 'Collapse Rail') $('#dock-rail-right')?.classList.toggle('collapsed');
      else if (title === 'Fullscreen') { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); toast('Fullscreen state changed.'); } catch (e) { toast(`Fullscreen unavailable: ${e.message}`, true); } }
      else if (target.id === 'btn-rail-chat') openChannels(); else if (target.id === 'btn-rail-audio') startAudio();
      else if (target.id === 'btn-open-ideas') openIdeas(); else if (target.id === 'btn-open-backlog') { const nav = $('[data-view="view-kanban"]'); nav?.click(); if (kanbanControls && !$('#btn-kanban-new-task')) kanbanControls.append(button('+ New Task', openNewTask, { id: 'btn-kanban-new-task', class: 'btn btn-primary btn-sm' })); }
      else if (target.matches('.roster-play-btn')) schedulerRun();
      else if (target.matches('.status-summary-item.needs-you')) safeCardFilter('needs-you'); else if (target.matches('.status-summary-item.to-review')) safeCardFilter('to-review'); else if (target.matches('.status-summary-item.working')) safeCardFilter('working');
      else if (target.id === 'btn-search-history') { const box = el('div'); (state.queries.slice(-10).reverse()).forEach(q => box.append(button(q, () => { const input = $('#agent-search'); if (input) { input.value = q; filterAgentCards(q); input.dispatchEvent(new Event('input', { bubbles: true })); } hideDialog(); }))); if (!state.queries.length) box.append(paragraph('No recent searches.')); showDialog('Recent Agent Searches', box); }
      else if (target.id === 'btn-search-ai') { const box = el('div'), input = field('Filter by role'); box.append(input.wrap, button('Apply filter', () => { const q = input.input.value.toLowerCase(); state.queries.push(q); $$('#team-room-grid .agentsroom-agent-card, #team-room-grid .agent-roster-row').forEach(card => { card.hidden = !card.textContent.toLowerCase().includes(q); }); hideDialog(); })); showDialog('Smart Role Filter', box); }
      else if (title === 'Pin selected') { const prefs = (await api('/api/v1/preferences').catch(() => ({ preferences: {} }))).preferences || {}; state.preferences = prefs; await togglePreferenceArray('pins', selected().name, ".roster-quick-icons button[title='Pin selected']"); }
      else if (title === 'Broadcast') openBroadcast(); else if (title === 'Starred crew') { const prefs = (await api('/api/v1/preferences').catch(() => ({ preferences: {} }))).preferences || {}; state.preferences = prefs; if (event.shiftKey) { state.starsOnly = !state.starsOnly; safeCardFilter(state.statusFilter); updateClass(".roster-quick-icons button[title='Starred crew']", state.starsOnly); } else await togglePreferenceArray('stars', selected().name, ".roster-quick-icons button[title='Starred crew']"); }
      else if (title === 'Add specialist') hireSpecialist(); else if (target.id === 'dock-tab-tools' || target.id === 'dock-tab-knowledge') { updateClass('#dock-tab-tools, #dock-tab-knowledge', false); target.classList.add('active'); target.setAttribute('aria-pressed', 'true'); }
      else if (title === 'Terminal') $('#btn-utility-terminal')?.click(); else if (title === 'Signals') openSignals(); else if (title === 'Mail') openInbox(); else if (title === 'Alerts') openAlerts(); else if (title === 'Knowledge Base') openKnowledge(); else if (title === 'Snippets') openSnippets();
      else if (target.matches('#view-kanban .task-card, #view-kanban .task-item') && !event.target.closest('button')) { const card = event.target.closest('#view-kanban .task-card, #view-kanban .task-item'); const id = card.dataset.taskId || card.dataset.id || $('.task-id', card)?.textContent?.trim(); const titleNode = $('.task-title, h3, h4', card); if (id) openTask({ id, title: titleNode?.textContent?.trim() || card.textContent.trim(), stage: card.dataset.stage || card.closest('[id^=tasks-], [id^=col-]')?.id?.replace(/^(tasks-|col-)/, '') || '' }); }
      else if (target.matches('.agentsroom-footer .footer-btn') && /MOBILE/.test(target.textContent)) openMobile(); else if (target.matches('.agentsroom-footer .footer-btn') && /MACHINES/.test(target.textContent)) openHealth('Machine / Daemon Health'); else if (target.matches('.agentsroom-footer .footer-btn') && /CHROME/.test(target.textContent)) openBrowser();
      else if (title === 'System Controls') openSystem(); else if (title === 'Security & Sandboxing') openSecurity();
      else if (title === 'Coffee Break') { const paused = $('.footer-status-pill')?.textContent.includes('Paused'); try { await command(paused ? 'scheduler.resume' : 'scheduler.pause'); const pill = $('.footer-status-pill'); if (pill) pill.textContent = paused ? '● ✦ Live' : '⏸ Paused'; toast(paused ? 'Scheduler resumed.' : 'Scheduler paused.'); } catch (e) { toast(e.message, true); } }
      else if (title === 'Bug report / Diagnostics') openDiagnostics();
    });
    document.addEventListener('click', event => { const card = event.target.closest('#team-room-grid .agentsroom-agent-card, #team-room-grid .agent-roster-row'); if (card) { state.selectedAgent = card.dataset.agentName || $('.agent-card-name', card)?.textContent?.trim() || ''; state.selectedAgentId = card.dataset.agentId || state.selectedAgent; } });
    document.addEventListener('input', event => { if (event.target.id === 'agent-search') filterAgentCards(event.target.value); });
    document.addEventListener('change', event => { if (event.target.id === 'agent-search') rememberQuery(event.target.value); });
    document.addEventListener('focusout', event => { if (event.target.id === 'agent-search') rememberQuery(event.target.value); });
    $('.agent-workspace-actions button[title="Session Link"]')?.setAttribute('aria-label', 'Copy session link');
    ['#agent-role-pill', '#agent-model-pill'].forEach(selector => { const node = $(selector); if (node) { node.tabIndex = 0; node.setAttribute('role', 'button'); node.setAttribute('aria-haspopup', 'dialog'); node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAgentConfig(); } }); } });
    $$('.status-summary-item.needs-you, .status-summary-item.to-review, .status-summary-item.working').forEach(node => { node.tabIndex = 0; node.setAttribute('role', 'button'); node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); node.click(); } }); });
    $$('.agent-workspace-actions button[title="Session Link"]')?.forEach?.(() => {});
    if (location.search) { const agentName = new URLSearchParams(location.search).get('agent'); if (agentName) { const card = $$('#team-room-grid .agentsroom-agent-card, #team-room-grid .agent-roster-row').find(item => (item.dataset.agentName || item.textContent).toLowerCase().includes(agentName.toLowerCase())); if (card) card.click(); else state.deepLinkAgent = agentName; } }
    loadPreferences();
    try { const es = new EventSource('/api/v1/events'); const eventNames = ['snapshot', 'turn_queued', 'turn_started', 'turn_completed', 'agent_thinking', 'agent_thinking_ended', 'agent_provider_configured', 'takeover_quiesced', 'command_executed', 'iteration_started', 'iteration_completed', 'ping', 'room.message', 'agent.thinking_started', 'agent.thinking_ended', 'command.started', 'command.output', 'command.completed', 'agent.updated', 'project.activated', 'takeover_started', 'takeover_released', 'popup_created', 'agent_answered']; const recordEvent = (type, e) => { try { state.lastEvents.push({ type, ...JSON.parse(e.data) }); state.lastEvents = state.lastEvents.slice(-30); } catch (_) {} }; es.addEventListener('message', e => { try { state.lastEvents.push(JSON.parse(e.data)); state.lastEvents = state.lastEvents.slice(-30); } catch (_) {} }); eventNames.forEach(type => es.addEventListener(type, e => { recordEvent(type, e); if (type === 'room.message') { try { const data = JSON.parse(e.data); if (state.audioFeed && data.text && data.sender_type === 'agent') window.speechSynthesis.speak(new SpeechSynthesisUtterance(data.text)); } catch (_) {} } })); } catch (_) {}
    return actions;
  }
  window.initCockpitActions = bind;
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true }); else bind(); }
})();
