const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { SupervisorServer } = require('../../src/server/supervisor-server');
const { WorkspaceManager } = require('../../src/workspace/manager');
const { TurnScheduler } = require('../../src/scheduler/turn-scheduler');

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'phase6@example.test');
  git(repo, 'config', 'user.name', 'Phase 6 Test');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: name.toLowerCase(), scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Repository rules\nUse small changes.\n');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'committed baseline\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'working tree change\n');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged change\n');
  git(repo, 'add', 'staged.txt');
  return repo;
}

async function json(response) {
  return response.json();
}

async function post(baseUrl, command_type, payload = {}) {
  return fetch(`${baseUrl}/api/v1/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command_type, payload })
  });
}

test('Phase 6 full functionality acceptance gates', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-phase6-'));
  const repoA = createRepo(root, 'project-a');
  const repoB = createRepo(root, 'project-b');
  const workspace = new WorkspaceManager({ baseDir: path.join(root, 'workspace') });
  const projectA = await workspace.initProject({ repoPath: repoA, name: 'Project A' });
  const projectB = await workspace.registerProject({ path: repoB, name: 'Project B', mode: 'independent', zone: 'work' });
  const server = new SupervisorServer({
    port: 0, workspace, projectId: projectA.id, projectName: projectA.name, repoPath: repoA,
    scheduler: new TurnScheduler({ maxConcurrency: 4 }), liveProviders: false
  });
  await server.start();
  const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  t.after(async () => {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('real git status, working/staged diffs, context, and validation', async () => {
    const statusRes = await fetch(`${baseUrl}/api/v1/git/status`);
    assert.equal(statusRes.status, 200);
    const status = await json(statusRes);
    assert.equal(status.project_id, projectA.id);
    assert.equal(status.clean, false);
    assert.ok(status.files.some((file) => file.path === 'tracked.txt'));
    assert.ok(status.files.some((file) => file.path === 'staged.txt'));

    const working = await json(await fetch(`${baseUrl}/api/v1/git/diff?path=tracked.txt&view=working`));
    assert.match(working.diff, /working tree change/);
    const staged = await json(await fetch(`${baseUrl}/api/v1/git/diff?path=staged.txt&view=staged`));
    assert.match(staged.diff, /staged change/);
    assert.equal((await fetch(`${baseUrl}/api/v1/git/diff?path=../outside`)).status, 400);
    fs.writeFileSync(path.join(repoA, 'large-untracked.txt'), 'x'.repeat(65537));
    const largeDiff = await json(await fetch(`${baseUrl}/api/v1/git/diff?path=large-untracked.txt`));
    assert.match(largeDiff.diff, /larger than 64 KB/);
    fs.writeFileSync(path.join(root, 'outside-target.txt'), 'outside secret');
    let symlinkCreated = false;
    try { fs.symlinkSync(path.join(root, 'outside-target.txt'), path.join(repoA, 'outside-target-link')); symlinkCreated = true; } catch (_) {}
    if (symlinkCreated) {
      const symlinkDiff = await json(await fetch(`${baseUrl}/api/v1/git/diff?path=outside-target-link`));
      assert.match(symlinkDiff.diff, /Skipped untracked symlink/);
      assert.doesNotMatch(symlinkDiff.diff, /outside secret/);
    }

    const files = await json(await fetch(`${baseUrl}/api/v1/context?kind=files`));
    assert.ok(files.files.includes('AGENTS.md'));
    assert.ok(files.files.includes('tracked.txt'));
    const branches = await json(await fetch(`${baseUrl}/api/v1/context?kind=branches`));
    assert.ok(branches.branches.some((branch) => branch.name));
    const docs = await json(await fetch(`${baseUrl}/api/v1/context?kind=docs`));
    assert.ok(docs.docs.some((doc) => doc.path === 'AGENTS.md'));

    const unknown = await post(baseUrl, 'unknown.command');
    assert.equal(unknown.status, 400);
    assert.equal((await json(unknown)).code, 'UNKNOWN_COMMAND');
  });

  await t.test('catalog, named job execution/cancellation, and redacted jobs projection', async () => {
    const catalog = await json(await fetch(`${baseUrl}/api/v1/command-catalog`));
    assert.ok(catalog.commands.some((command) => command.id === 'git:status'));
    assert.ok(catalog.commands.some((command) => command.id === 'script:test'));

    const run = await post(baseUrl, 'command.run', { job_id: 'git:status' });
    assert.equal(run.status, 200);
    const runId = (await json(run)).result.run_id;
    assert.ok(runId);

    const originalCatalog = server.getCommandCatalog;
    server.getCommandCatalog = () => [{ id: 'test:long', executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] }];
    const longRun = await post(baseUrl, 'command.run', { job_id: 'test:long' });
    assert.equal(longRun.status, 200);
    const longRunId = (await json(longRun)).result.run_id;
    const deadline = Date.now() + 3000;
    while (!server.commandJobs.get(longRunId)?.child && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const cancel = await post(baseUrl, 'command.cancel', { run_id: longRunId });
    assert.equal(cancel.status, 200);
    server.getCommandCatalog = originalCatalog;
    const jobs = await json(await fetch(`${baseUrl}/api/v1/state?collection=jobs`));
    assert.equal(jobs.collection, 'jobs');
    assert.ok(jobs.items.some((job) => job.run_id === runId));
    assert.ok(jobs.items.some((job) => job.run_id === longRunId));
    assert.ok(jobs.items.every((job) => job.project_id === projectA.id));
  });

  await t.test('specialists, configuration, broadcast, scheduler, ideas, tasks, snippets, preferences and diagnostics', async () => {
    const hire = await post(baseUrl, 'specialist.hire', { name: 'Release Specialist', role: 'Release Manager', provider: 'codex', model: 'gpt-5' });
    assert.equal(hire.status, 200);
    assert.ok((await workspace.listAgents(projectA.id)).some((agent) => agent.name === 'Release Specialist'));

    const configure = await post(baseUrl, 'agent.configure', { agent_id: 'Dev-2', role: 'Developer', provider: 'agy', model: 'safe-model' });
    assert.equal(configure.status, 200);
    const dev2 = (await workspace.listAgents(projectA.id)).find((agent) => agent.name === 'Dev-2');
    assert.equal(dev2.provider, 'agy');
    assert.equal(dev2.model, 'safe-model');

    const broadcast = await post(baseUrl, 'message.broadcast', { agent_ids: ['Dev-1', 'Dev-2'], text: 'Review the release checklist' });
    assert.equal(broadcast.status, 200);
    const invalidBroadcast = await post(baseUrl, 'message.broadcast', { agent_ids: ['Unknown-Agent'], text: 'No delivery' });
    assert.equal(invalidBroadcast.status, 400);
    assert.equal((await json(invalidBroadcast)).code, 'INVALID_RECIPIENT');

    assert.equal((await post(baseUrl, 'scheduler.pause')).status, 200);
    assert.equal((await post(baseUrl, 'scheduler.run_next')).status, 409);
    assert.equal((await post(baseUrl, 'scheduler.resume')).status, 200);
    assert.equal((await post(baseUrl, 'scheduler.run_next')).status, 200);

    const idea = await json(await post(baseUrl, 'idea.save', { title: 'Improve release flow', description: 'Add a checklist' }));
    assert.ok(idea.result.id);
    const promote = await post(baseUrl, 'idea.promote', { id: idea.result.id });
    assert.equal(promote.status, 200);
    assert.equal((await json(promote)).result.stage, 'planning');
    assert.ok((await json(await fetch(`${baseUrl}/api/v1/tasks`))).tasks.length);

    fs.mkdirSync(path.join(repoA, 'backlog', 'tasks'), { recursive: true });
    const createTask = await json(await post(baseUrl, 'task.create', { title: 'Phase 6 transition task', stage: 'todo' }));
    const transition = await post(baseUrl, 'task.transition', { id: createTask.result.id, stage: 'review' });
    assert.equal(createTask.result.stage, 'planning');
    assert.equal(transition.status, 200);
    assert.equal((await json(transition)).result.stage, 'review');
    const taskMarkdown = fs.readFileSync(path.join(repoA, 'backlog', 'tasks', `${createTask.result.id}.md`), 'utf8');
    assert.match(taskMarkdown, /updated_at:/);
    assert.match(taskMarkdown, /status: "Review"/);

    const snippet = await json(await post(baseUrl, 'snippet.save', { title: 'Release prompt', content: 'Check release notes' }));
    assert.ok(snippet.result.id);
    assert.equal((await post(baseUrl, 'snippet.delete', { id: snippet.result.id })).status, 200);

    assert.equal((await post(baseUrl, 'preferences.update', { theme: 'dark', accent: 'violet', turbo: true })).status, 200);
    const prefs = await json(await fetch(`${baseUrl}/api/v1/preferences`));
    assert.equal(prefs.preferences.theme, 'dark');
    assert.equal(prefs.preferences.accent, 'violet');
    assert.equal((await fetch(`${baseUrl}/api/v1/health`)).status, 200);
    const diagnostics = await json(await fetch(`${baseUrl}/api/v1/diagnostics`));
    assert.equal(diagnostics.project_id, projectA.id);
    assert.equal(diagnostics.config.repo_path, '[redacted]');
  });

  await t.test('activating Project B isolates repository, tasks, messages, projections, and preferences', async () => {
    await post(baseUrl, 'preferences.update', { theme: 'dark', accent: 'violet' });
    await post(baseUrl, 'task.create', { title: 'Only in Project A', stage: 'todo' });
    const messageA = await fetch(`${baseUrl}/api/v1/room/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'phase6', text: 'Message A' }) });
    assert.equal(messageA.status, 201);
    await server.workspace.addRoomMessage(projectB.id, { channel: 'phase6', senderType: 'human', senderId: 'operator', senderName: 'Operator', text: 'Message B' });

    const activation = await fetch(`${baseUrl}/api/v1/projects/${projectB.id}/activate`, { method: 'POST' });
    assert.equal(activation.status, 200);
    assert.equal((await json(await fetch(`${baseUrl}/api/v1/git/status`))).project_id, projectB.id);
    const status = await json(await fetch(`${baseUrl}/api/v1/git/status`));
    assert.ok(status.files.every((file) => file.path !== 'Only in Project A'));
    const tasks = await json(await fetch(`${baseUrl}/api/v1/tasks`));
    assert.ok(!tasks.tasks.some((task) => task.title === 'Only in Project A'));
    const messages = await json(await fetch(`${baseUrl}/api/v1/room/messages?channel=phase6`));
    assert.deepEqual(messages.messages.map((message) => message.text), ['Message B']);
    const state = await json(await fetch(`${baseUrl}/api/v1/state?collection=jobs`));
    assert.ok(state.items.every((job) => job.project_id === projectB.id));
    const prefs = await json(await fetch(`${baseUrl}/api/v1/preferences`));
    assert.notEqual(prefs.preferences.theme, 'dark');
  });

  await t.test('idempotent commands, task deduplication, idea single-promotion, and untracked diffs', async () => {
    fs.mkdirSync(path.join(repoA, 'backlog', 'tasks'), { recursive: true });
    const request = (body) => fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const first = await request({ command_type: 'task.create', payload: { title: 'Deduplicated task', stage: 'planning' }, idempotency_key: 'task-create-1' });
    const firstReceipt = await json(first);
    const sameRetryResponse = await request({ command_type: 'task.create', payload: { title: 'Deduplicated task', stage: 'planning' }, idempotency_key: 'task-create-1' });
    const retryReceipt = await json(sameRetryResponse);
    assert.equal(retryReceipt.command_id, firstReceipt.command_id);
    const conflictingRetry = await request({ command_type: 'task.create', payload: { title: 'Different retry body' }, idempotency_key: 'task-create-1' });
    assert.equal(conflictingRetry.status, 409);
    assert.equal((await json(conflictingRetry)).code, 'IDEMPOTENCY_CONFLICT');
    const mismatch = await request({ project_id: projectA.id, command_type: 'task.create', payload: { title: 'wrong project' } });
    assert.equal(mismatch.status, 409);
    assert.equal((await json(mismatch)).code, 'PROJECT_MISMATCH');
    const listed = await json(await fetch(`${baseUrl}/api/v1/tasks`));
    assert.equal(listed.tasks.filter((task) => task.id === firstReceipt.result.id).length, 1);

    const idea = await json(await post(baseUrl, 'idea.save', { title: 'Promote once' }));
    const promoted = await post(baseUrl, 'idea.promote', { id: idea.result.id });
    assert.equal(promoted.status, 200);
    const duplicatePromotion = await post(baseUrl, 'idea.promote', { id: idea.result.id });
    assert.equal(duplicatePromotion.status, 409);
    assert.match((await json(duplicatePromotion)).error, /already been promoted/);

    fs.writeFileSync(path.join(repoB, 'untracked.txt'), 'untracked content\n');
    const diff = await json(await fetch(`${baseUrl}/api/v1/git/diff?path=untracked.txt`));
    assert.match(diff.diff, /untracked content/);
  });

  await t.test('static application and terminal assets are served', async () => {
    for (const asset of ['/', '/terminal', '/cockpit-actions.js', '/ai-orb.js']) {
      const response = await fetch(`${baseUrl}${asset}`);
      assert.equal(response.status, 200, `${asset} should be served`);
    }
  });
});
