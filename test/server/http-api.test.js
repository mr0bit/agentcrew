const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const EventEmitter = require('node:events');

const { SupervisorServer } = require('../../src/server/supervisor-server');
const { RepoDataService } = require('../../src/server/repo-data-service');
const { WorkspaceManager } = require('../../src/workspace/manager');
const { TurnScheduler } = require('../../src/scheduler/turn-scheduler');
const { TakeoverController } = require('../../src/session/takeover-controller');
const { ChatService } = require('../../src/chat/chat-service');

test('SupervisorServer serves TRD §12 API routes and SSE stream', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-server-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const workspace = new WorkspaceManager({ baseDir: tmpDir });
  const project = await workspace.initProject({
    repoPath: tmpDir,
    name: 'Server Test Project'
  });

  const scheduler = new TurnScheduler({ maxConcurrentTurns: 4 });
  const takeover = new TakeoverController({ softBudgetMs: 500 });

  const server = new SupervisorServer({
    port: 0, // ephemeral port for test
    workspace,
    projectId: project.id,
    projectName: 'Server Test Project',
    repoPath: tmpDir,
    scheduler,
    takeoverController: takeover,
    staticDir: path.join(__dirname, 'fixtures'),
    liveProviders: false
  });
  let providerFailure = false;
  let capturedReview = null;
  server.liveProviders = true;
  server.repoDataService.getPullRequestReviewContext = async (number) => ({
    number,
    title: 'Live provider review title',
    author: 'review-author',
    body: 'PR description from GitHub',
    baseBranch: 'main',
    headBranch: 'feature/review',
    diff: 'diff --git a/src/example.js b/src/example.js\n+const reviewed = true;',
    diffTruncated: false
  });
  server.chatService = {
    resolveAgent: (agentId) => server.workspace.listAgents(server.projectId).then((agents) => {
      const match = agents.find((agent) => agent.name.toLowerCase() === agentId.toLowerCase());
      return { name: match?.name || agentId };
    }),
    async quiesceAgent() { return { quiescent: true }; },
    resumeAgent() {},
    async probeProviders() {
      return [
        { name: 'agy', status: 'available', available: true, capabilities: [] },
        { name: 'codex', status: 'available', available: true, capabilities: [] },
        { name: 'gemini', status: 'unavailable', available: false, capabilities: [], reason: "Runner 'gemini' was not found on PATH" },
      ];
    },
    async generateResponse(agentId, prompt, options) {
      capturedReview = { agentId, prompt, options };
      if (providerFailure) throw new Error('codex: quota exceeded');
      return '[Arthur (Architect)]: Provider reviewed the supplied diff.';
    }
  };

  await server.start();
  const address = server.httpServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('GET /api/v1/workspace returns workspace identity and agent roster', async () => {
    const res = await fetch(`${baseUrl}/api/v1/workspace`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.workspace.id, project.id);
    assert.equal(data.agents.length, 13);
  });

  await t.test('GET and POST /api/v1/projects manage project registry and activation (TASK-37)', async () => {
    // 1. GET /api/v1/projects
    const listRes = await fetch(`${baseUrl}/api/v1/projects`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.ok(Array.isArray(listData.projects));
    assert.ok(listData.projects.length >= 1);
    assert.equal(listData.projects[0].id, project.id);

    // 2. Reject non-JSON POST
    const nonJsonRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'invalid'
    });
    assert.equal(nonJsonRes.status, 415);

    // 3. Reject non-existent path
    const invalidPathRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/non/existent/repo/dir' })
    });
    assert.equal(invalidPathRes.status, 400);

    // 4. Register new valid project
    const newProjDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-api-proj-'));
    const registerRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: newProjDir,
        name: 'Secondary Repo',
        mode: 'independent',
        zone: 'personal'
      })
    });
    assert.equal(registerRes.status, 201);
    const regData = await registerRes.json();
    assert.equal(regData.project.name, 'Secondary Repo');
    assert.equal(regData.project.zone, 'personal');
    assert.equal(regData.project.mode, 'independent');

    // 5. Activate the new project
    const activateRes = await fetch(`${baseUrl}/api/v1/projects/${regData.project.id}/activate`, {
      method: 'POST'
    });
    assert.equal(activateRes.status, 200);
    const actData = await activateRes.json();
    assert.equal(actData.success, true);
    assert.equal(actData.project.id, regData.project.id);
    assert.equal(server.projectId, regData.project.id);
    assert.equal(server.projectName, 'Secondary Repo');
    assert.equal(server.activeProjectId, regData.project.id);
    assert.equal(server.repoDataService.repoPath, newProjDir);

    // 6. Verify workspace now reflects new project
    const wsRes = await fetch(`${baseUrl}/api/v1/workspace`);
    const wsData = await wsRes.json();
    assert.equal(wsData.workspace.id, regData.project.id);

    fs.rmSync(newProjDir, { recursive: true, force: true });
  });

  await t.test('room messages filter by channel and active project', async () => {
    const activate = await fetch(`${baseUrl}/api/v1/projects/${project.id}/activate`, { method: 'POST' });
    assert.equal(activate.status, 200);
    const alpha = await fetch(`${baseUrl}/api/v1/room/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'alpha', text: 'alpha message' })
    });
    const beta = await fetch(`${baseUrl}/api/v1/room/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'beta', text: 'beta message' })
    });
    assert.equal(alpha.status, 201);
    assert.equal(beta.status, 201);
    const alphaMessages = await (await fetch(`${baseUrl}/api/v1/room/messages?channel=alpha&project_id=${project.id}`)).json();
    assert.deepEqual(alphaMessages.messages.map(message => message.text), ['alpha message']);
    assert.equal(alphaMessages.messages[0].project_id, project.id);
    const otherProject = await (await fetch(`${baseUrl}/api/v1/room/messages?channel=alpha&project_id=another-project`)).json();
    assert.deepEqual(otherProject.messages, []);

    let mentionResolved;
    const mention = new Promise((resolve) => { mentionResolved = resolve; });
    const previousGenerateResponse = server.chatService.generateResponse;
    server.chatService.generateResponse = async (_agent, _prompt, options) => { mentionResolved(options); return 'pinned response'; };
    await fetch(`${baseUrl}/api/v1/room/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'alpha', text: '@Dev-2 review this' })
    });
    const options = await Promise.race([mention, new Promise((resolve) => setTimeout(() => resolve(null), 1000))]);
    assert.equal(options.projectId, project.id);
    assert.equal(options.repoPath, server.repoPath);
    server.chatService.generateResponse = previousGenerateResponse;
  });

  await t.test('unknown command types are rejected with a stable error', async () => {
    const response = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'agent.teleport' })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      status: 'error', code: 'UNKNOWN_COMMAND', error: 'Unsupported command_type: agent.teleport'
    });
  });

  await t.test('git, context, health and state queries are bounded and project-scoped', async () => {
    server.repoPath = process.cwd();
    server.repoDataService.setRepoRoot(server.repoPath);
    server.ptyManager.cwd = server.repoPath;
    server.chatService.repoPath = server.repoPath;
    const health = await (await fetch(`${baseUrl}/api/v1/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.host, server.host);
    assert.equal(health.port, address.port);
    assert.equal(health.project_id, project.id);
    assert.ok(Number.isInteger(health.uptime_sec));

    const gitStatus = await (await fetch(`${baseUrl}/api/v1/git/status`)).json();
    assert.equal(typeof gitStatus.branch, 'string');
    assert.ok(Array.isArray(gitStatus.files));
    assert.equal(typeof gitStatus.clean, 'boolean');
    assert.equal(gitStatus.project_id, project.id);

    const diff = await (await fetch(`${baseUrl}/api/v1/git/diff?path=package.json&view=working`)).json();
    assert.equal(diff.path, 'package.json');
    assert.equal(diff.view, 'working');
    assert.ok(diff.diff.length <= 200 * 1024);
    assert.equal((await fetch(`${baseUrl}/api/v1/git/diff?path=../../etc/passwd`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/v1/git/diff?view=invalid`)).status, 400);
    const escapeLink = path.join(tmpDir, 'outside-link');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'passwd'), 'outside');
    fs.symlinkSync(outsideDir, escapeLink, 'dir');
    server.repoPath = tmpDir;
    server.repoDataService.setRepoRoot(tmpDir);
    assert.equal((await fetch(`${baseUrl}/api/v1/git/diff?path=outside-link/passwd`)).status, 400);
    fs.rmSync(outsideDir, { recursive: true, force: true });
    server.repoPath = process.cwd();
    server.repoDataService.setRepoRoot(server.repoPath);

    const files = await (await fetch(`${baseUrl}/api/v1/context?kind=files`)).json();
    assert.ok(Array.isArray(files.files));
    assert.ok(files.files.length <= 200);
    const branches = await (await fetch(`${baseUrl}/api/v1/context?kind=branches`)).json();
    assert.ok(Array.isArray(branches.branches));
    const docs = await (await fetch(`${baseUrl}/api/v1/context?kind=docs`)).json();
    assert.ok(Array.isArray(docs.docs));
    assert.ok(docs.docs.every((doc) => doc.snippet.length <= 500));

    for (const collection of ['projects', 'agents', 'tasks', 'sessions', 'jobs']) {
      const state = await (await fetch(`${baseUrl}/api/v1/state?collection=${collection}`)).json();
      assert.equal(state.collection, collection);
      assert.ok(Array.isArray(state.items));
      assert.ok(state.items.every((item) => !('takeover_token' in item) && !('token' in item)));
    }
    assert.equal((await fetch(`${baseUrl}/api/v1/state?collection=secrets`)).status, 400);
  });

  await t.test('command catalog runs only named jobs and preferences persist per project', async () => {
    const catalog = await (await fetch(`${baseUrl}/api/v1/command-catalog`)).json();
    assert.ok(catalog.commands.some((command) => command.id === 'git:status'));
    assert.ok(catalog.commands.some((command) => command.id === 'script:test'));
    const rejected = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'command.run', payload: { job_id: 'git:status;touch /tmp/unsafe' } })
    });
    assert.equal(rejected.status, 400);
    const run = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'command.run', payload: { job_id: 'git:status' } })
    });
    assert.equal(run.status, 200);
    const receipt = await run.json();
    assert.ok(receipt.result.run_id);
    assert.ok(['running', 'completed', 'failed'].includes(receipt.result.status));

    const prefs = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'preferences.update', payload: { theme: 'dark', accent: 'violet', turbo: true } })
    });
    assert.equal(prefs.status, 200);
    const saved = await (await fetch(`${baseUrl}/api/v1/preferences`)).json();
    assert.equal(saved.preferences.theme, 'dark');
    assert.equal(saved.preferences.accent, 'violet');

    for (const [command_type, expected] of [['scheduler.pause', true], ['scheduler.resume', false]]) {
      const response = await fetch(`${baseUrl}/api/v1/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command_type })
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).result.paused, expected);
    }
  });

  await t.test('typed team, specialist and session commands make observable changes', async () => {
    const configure = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'agent.configure', payload: { agent_id: 'Dev-2', role: 'Developer', provider: 'agy', model: 'safe-model' } })
    });
    assert.equal(configure.status, 200);
    const configured = (await server.workspace.listAgents(project.id)).find((agent) => agent.name === 'Dev-2');
    assert.equal(configured.provider, 'agy');
    assert.equal(configured.model, 'safe-model');

    const hire = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'specialist.hire', payload: { name: 'Release Specialist', role: 'Release Manager', provider: 'codex', model: 'gpt-5' } })
    });
    assert.equal(hire.status, 200);
    assert.ok((await server.workspace.listAgents(project.id)).some((agent) => agent.name === 'Release Specialist'));

    const broadcast = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'message.broadcast', payload: { agent_ids: ['Dev-3'], text: 'check release notes' } })
    });
    assert.equal(broadcast.status, 200);
    assert.equal((await broadcast.json()).result.status, 'recorded');
    const room = await server.workspace.listRoomMessages(project.id, { channel: 'team-activity' });
    assert.ok(room.some((message) => message.text.includes('@Dev-3 check release notes')));
    assert.ok(room.some((message) => message.text.includes('Provider reviewed')));
    const { DatabaseSync } = require('node:sqlite');
    const projectDb = new DatabaseSync(path.join(workspace.baseDir, 'projects', project.id, 'agentcrew.db'));
    projectDb.prepare('DELETE FROM agents WHERE project_id = ? AND name = ?').run(project.id, 'Release Specialist');
    projectDb.close();

    for (const command_type of ['session.clear_view', 'session.reset']) {
      const response = await fetch(`${baseUrl}/api/v1/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command_type, payload: { agent_id: 'Dev-3' } })
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).result.action, command_type);
    }
    const next = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'scheduler.run_next' })
    });
    assert.equal((await next.json()).result.status, 'unavailable');
  });

  await t.test('scheduler pause, roster validation, session guards and phase 4/5 resources', async () => {
    const post = async (command_type, payload = {}) => fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_type, payload }) });
    await post('scheduler.pause');
    const paused = await post('scheduler.run_next');
    assert.equal(paused.status, 409);
    assert.equal((await paused.json()).status, 'error');
    const mention = await fetch(`${baseUrl}/api/v1/room/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '@Dev-1 held' }) });
    const mentionData = await mention.json(); assert.equal(mentionData.dispatched, false); assert.equal(mentionData.reason, 'Scheduler is paused');
    await post('scheduler.resume');

    const invalidRecipients = await post('message.broadcast', { agent_ids: ['not-on-roster'], text: 'hello' });
    assert.equal(invalidRecipients.status, 400);
    assert.equal((await invalidRecipients.json()).code, 'INVALID_RECIPIENT');

    server.chatService.activeTurns = new Map([[`${project.id}@${server.repoPath}:Dev-1`, { controller: new AbortController() }]]);
    const reset = await post('session.reset', { agent_id: 'Dev-1' });
    assert.equal(reset.status, 409);
    server.chatService.activeTurns.clear();

    const idea = await (await post('idea.save', { title: 'Ship diagnostics', description: 'Add support bundle', tags: ['ops'] })).json();
    assert.equal(idea.result.project_id, project.id);
    assert.equal((await (await fetch(`${baseUrl}/api/v1/ideas`)).json()).ideas.length, 1);
    const promoted = await post('idea.promote', { id: idea.result.id });
    assert.equal(promoted.status, 200);
    const promotedTask = (await promoted.json()).result;
    assert.equal(promotedTask.stage, 'planning');
    const promotedFile = path.join(server.repoPath, 'backlog', 'tasks', `${promotedTask.id}.md`);
    assert.ok(fs.existsSync(promotedFile));
    assert.match(fs.readFileSync(promotedFile, 'utf8'), /status: \"Planning\"/);
    fs.rmSync(promotedFile, { force: true });
    const snippet = await post('snippet.save', { title: 'Review prompt', content: 'Check edge cases' });
    assert.equal(snippet.status, 200);
    const snippetId = (await snippet.json()).result.id;
    assert.equal((await (await fetch(`${baseUrl}/api/v1/snippets`)).json()).snippets.length, 1);
    assert.equal((await post('snippet.delete', { id: snippetId })).status, 200);

    const defaultCreated = await (await post('task.create', { title: 'Default API task stage' })).json();
    assert.equal(defaultCreated.result.stage, 'planning');
    const defaultTaskFile = path.join(server.repoPath, 'backlog', 'tasks', `${defaultCreated.result.id}.md`);
    assert.match(fs.readFileSync(defaultTaskFile, 'utf8'), /status: \"Planning\"/);
    fs.rmSync(defaultTaskFile, { force: true });

    const created = await (await post('task.create', { title: 'New API task', stage: 'todo' })).json();
    assert.equal(created.result.stage, 'planning');
    assert.ok((await (await fetch(`${baseUrl}/api/v1/tasks`)).json()).tasks.some((task) => task.id === created.result.id));
    const taskFile = path.join(server.repoPath, 'backlog', 'tasks', `${created.result.id}.md`);
    assert.ok(fs.existsSync(taskFile));
    assert.match(fs.readFileSync(taskFile, 'utf8'), /status: "Planning"/);
    assert.equal((await post('task.transition', { id: created.result.id, stage: 'review' })).status, 200);
    assert.match(fs.readFileSync(taskFile, 'utf8'), /status: "Review"/);
    assert.match(fs.readFileSync(taskFile, 'utf8'), /New API task/);
    assert.ok((await (await fetch(`${baseUrl}/api/v1/tasks`)).json()).tasks.some((task) => task.id === created.result.id));
    fs.rmSync(taskFile, { force: true });
    assert.equal((await post('task.transition', { id: created.result.id, stage: 'invalid' })).status, 400);
    const diagnostics = await (await fetch(`${baseUrl}/api/v1/diagnostics`)).json();
    assert.equal(diagnostics.project_id, project.id);
    assert.equal(diagnostics.config.repo_path, '[redacted]');
  });

  await t.test('state excludes jobs and memory sessions from other projects', async () => {
    server.commandJobs.set('foreign-job', { project_id: 'foreign-project', status: 'completed' });
    server.chatService.sessionCache = new Map([['foreign-project@/tmp/other:Dev-1:codex', { provider: 'codex', sessionId: 'private-session' }]]);
    const jobs = await (await fetch(`${baseUrl}/api/v1/state?collection=jobs`)).json();
    const sessions = await (await fetch(`${baseUrl}/api/v1/state?collection=sessions`)).json();
    assert.ok(jobs.items.every((job) => job.project_id === project.id));
    assert.ok(sessions.items.every((session) => !session.key.startsWith('foreign-project@')));
    server.commandJobs.delete('foreign-job');
    server.chatService.sessionCache.clear();
  });

  await t.test('cancel is project-scoped, spawn errors are recorded, and cleared messages are hidden', async () => {
    server.commandJobs.set('other-run', { project_id: 'foreign-project', status: 'running', child: { kill() {} } });
    const cancel = await fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_type: 'command.cancel', payload: { run_id: 'other-run' } }) });
    assert.equal(cancel.status, 404);
    server.commandJobs.delete('other-run');

    const originalCatalog = server.getCommandCatalog;
    server.getCommandCatalog = () => [{ id: 'missing:binary', executable: '/definitely/not/an/agentcrew-command', args: [] }];
    const failedRun = await fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_type: 'command.run', payload: { job_id: 'missing:binary' } }) });
    assert.equal(failedRun.status, 200);
    const { result } = await failedRun.json();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const jobState = await (await fetch(`${baseUrl}/api/v1/state?collection=jobs`)).json();
    assert.equal(jobState.items.find((job) => job.run_id === result.run_id).status, 'failed');
    server.getCommandCatalog = originalCatalog;

    await server.workspace.addRoomMessage(project.id, { channel: 'team-activity', senderType: 'agent', senderId: 'dev-1', senderName: 'Dev-1', text: 'old turn' });
    await fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_type: 'session.clear_view', payload: { agent_id: 'Dev-1' } }) });
    const hidden = await (await fetch(`${baseUrl}/api/v1/room/messages?channel=team-activity`)).json();
    assert.ok(!hidden.messages.some((message) => message.text === 'old turn'));
    const included = await (await fetch(`${baseUrl}/api/v1/room/messages?channel=team-activity&include_cleared=1`)).json();
    assert.ok(included.messages.some((message) => message.text === 'old turn'));
  });

  await t.test('command API rejects cross-origin and non-JSON browser requests', async () => {
    const body = JSON.stringify({ command_type: 'session.takeover', payload: { agent_id: 'Dev-1' } });
    const crossOrigin = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.headers.get('access-control-allow-origin'), null);
    const plainText = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body
    });
    assert.equal(plainText.status, 415);
    assert.equal(takeover.getState('Dev-1'), 'auto');
  });

  await t.test('GET /api/v1/readiness reports qualified provider status', async () => {
    const res = await fetch(`${baseUrl}/api/v1/readiness`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'blocked');
    assert.deepEqual(data.qualified_providers, []);
    assert.ok(Array.isArray(data.providers));
    assert.deepEqual(data.providers.map(provider => provider.name).sort(), ['agy', 'codex', 'gemini']);
    assert.ok(data.providers.every(provider => ['available', 'unavailable', 'quota_limited'].includes(provider.status)));
    assert.equal(data.providers.find(provider => provider.name === 'gemini').status, 'unavailable');
    assert.deepEqual(data.providers.find(provider => provider.name === 'gemini').agents, ['QA-1', 'QA-2']);
  });

  await t.test('GET /api/v1/agents returns all 13 agent identities with status badges', async () => {
    const res = await fetch(`${baseUrl}/api/v1/agents`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.agents.length, 13);
    const dev1 = data.agents.find(a => a.name === 'Dev-1');
    assert.ok(dev1);
    assert.equal(dev1.role, 'Developer');
    const qa1 = data.agents.find(a => a.name === 'QA-1');
    assert.equal(qa1.provider_status, 'disconnected');
    assert.equal(qa1.active_provider, null);
  });

  await t.test('provider backup is opt-in and saved on the selected agent', async () => {
    const response = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'agent.provider_config', payload: {
        agent_id: 'QA-1', backup_provider: 'codex', backup_model: 'o3',
      } }),
    });
    assert.equal(response.status, 200);
    const qa1 = (await (await fetch(`${baseUrl}/api/v1/agents`)).json()).agents.find(a => a.name === 'QA-1');
    assert.equal(qa1.backup_provider, 'codex');
    assert.equal(qa1.backup_model, 'o3');
  });

  await t.test('POST /api/v1/commands executes takeover and release cycle', async () => {
    // 1. Initiate Takeover
    const takeoverRes = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command_type: 'session.takeover',
        payload: { agent_id: 'dev-1', reason: 'User requested manual correction' },
        idempotency_key: 'cmd-takeover-1'
      })
    });
    assert.equal(takeoverRes.status, 200);
    const takeoverData = await takeoverRes.json();
    assert.equal(takeoverData.status, 'acknowledged');
    assert.equal(takeoverData.result.agent_id, 'Dev-1');
    assert.equal(takeoverData.result.state, 'human_owned');
    const token = takeoverData.result.takeover_token;
    const configureOwned = await fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_type: 'agent.configure', payload: { agent_id: 'Dev-1', role: 'Blocked update' } }) });
    assert.equal(configureOwned.status, 409);
    assert.equal((await configureOwned.json()).code, 'AGENT_ACTIVE');
    const resetOwned = await fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_type: 'session.reset', payload: { agent_id: 'Dev-1' } }) });
    assert.equal(resetOwned.status, 409);
    assert.equal((await resetOwned.json()).code, 'SESSION_ACTIVE');

    const conflictRes = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'session.takeover', payload: { agent_id: 'dev-1' } })
    });
    assert.equal(conflictRes.status, 409, 'a second tab cannot take the same agent');

    const invalidChatRes = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'session.exec', payload: { agent_id: 'dev-1', command: 'hello', mode: 'chat', takeover_token: 'wrong' } })
    });
    assert.equal(invalidChatRes.status, 403);

    const validChatRes = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'session.exec', payload: { agent_id: 'dev-1', command: 'hello', mode: 'chat', takeover_token: token } })
    });
    assert.equal(validChatRes.status, 200, 'human chat is allowed during an agent hold');

    let finishChat;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const previousGenerate = server.chatService.generateResponse;
    server.chatService.generateResponse = async () => {
      markStarted();
      return new Promise((resolve) => { finishChat = resolve; });
    };
    const pendingChat = fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'session.exec', payload: { agent_id: 'dev-1', command: 'long answer', mode: 'chat', takeover_token: token } })
    });
    await started;
    const prematureRelease = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'session.release', payload: { agent_id: 'dev-1', takeover_token: token } })
    });
    assert.equal(prematureRelease.status, 409);
    assert.equal(takeover.getState('Dev-1'), 'human_owned');
    finishChat('done');
    assert.equal((await pendingChat).status, 200);
    server.chatService.generateResponse = previousGenerate;

    let finishShell;
    let markShellStarted;
    const shellStarted = new Promise((resolve) => { markShellStarted = resolve; });
    const previousExecute = server.ptyManager.execute;
    server.ptyManager.execute = async () => {
      markShellStarted();
      return new Promise((resolve) => { finishShell = resolve; });
    };
    const pendingShell = fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'session.exec', payload: { agent_id: 'dev-1', command: 'pwd', mode: 'shell', takeover_token: token } })
    });
    await shellStarted;
    const releaseDuringShell = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'session.release', payload: { agent_id: 'dev-1', takeover_token: token } })
    });
    assert.equal(releaseDuringShell.status, 409);
    finishShell({ stdout: '/repo', stderr: '', code: 0 });
    assert.equal((await pendingShell).status, 200);
    server.ptyManager.execute = previousExecute;

    server.ptyManager.execute = async () => ({ stdout: '', stderr: 'bad command', code: 7 });
    const failedShell = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_type: 'session.exec', payload: { agent_id: 'dev-1', command: 'false', mode: 'shell', takeover_token: token } })
    });
    assert.equal(failedShell.status, 500);
    const failedShellBody = await failedShell.json();
    assert.equal(failedShellBody.status, 'error');
    assert.equal(failedShellBody.code, 'COMMAND_FAILED');
    assert.equal(failedShellBody.exit_code, 7);
    assert.match(failedShellBody.error, /bad command/);
    server.ptyManager.execute = previousExecute;

    for (const outcome of [{ stdout: 'terminated', stderr: '', code: null }, { stdout: '', stderr: 'deadline', code: 0, timedOut: true }]) {
      server.ptyManager.execute = async () => outcome;
      const failed = await fetch(`${baseUrl}/api/v1/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command_type: 'session.exec', payload: { agent_id: 'dev-1', command: 'kill -TERM $$', mode: 'shell', takeover_token: token } })
      });
      assert.equal(failed.status, 500);
      const body = await failed.json();
      assert.equal(body.status, 'error');
      assert.equal(body.code, 'COMMAND_FAILED');
      assert.equal(body.exit_code, outcome.code);
      assert.ok('output' in body);
    }
    server.ptyManager.execute = previousExecute;

    // 2. Release Takeover
    const releaseRes = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command_type: 'session.release',
        payload: { agent_id: 'dev-1', takeover_token: token, guidance_notes: 'Fixed typo in test assertion' },
        idempotency_key: 'cmd-release-1'
      })
    });
    assert.equal(releaseRes.status, 200);
    const releaseData = await releaseRes.json();
    assert.equal(releaseData.result.state, 'auto');
  });

  await t.test('POST /api/v1/commands handles popup scope creation and decisions', async () => {
    const popupRes = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command_type: 'popup.propose',
        payload: {
          title: 'Add JWT token expiry',
          description: 'Security finding requires immediate token expiry handling',
          change_type: 'security_patch',
          estimated_impact: { affected_tasks: ['TASK-14'], delay_hours: 2 }
        }
      })
    });
    assert.equal(popupRes.status, 200);
    const popupData = await popupRes.json();
    assert.ok(popupData.result.ticket.id.startsWith('P-'));

    // Check GET /api/v1/popups
    const listRes = await fetch(`${baseUrl}/api/v1/popups`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.popups.length, 1);
  });

  await t.test('agent.ask sends live PR context to the provider and returns its answer', async () => {
    const askRes = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command_type: 'agent.ask',
        payload: {
          agent_id: 'Arthur (Architect)',
          pr_number: 26,
          pr_title: 'Interactive Web UI',
          question: 'What is the architectural blast radius?',
          author: 'Dev-2'
        }
      })
    });
    assert.equal(askRes.status, 200);
    const askData = await askRes.json();
    assert.equal(askData.status, 'acknowledged');
    assert.ok(askData.result.answer.includes('Provider reviewed'));
    assert.equal(askData.result.pr_number, 26);
    assert.equal(askData.result.author, 'review-author');
    assert.equal(capturedReview.agentId, 'Arthur (Architect)');
    assert.match(capturedReview.prompt, /Live provider review title/);
    assert.match(capturedReview.options.reviewContext, /review-author/);
    assert.match(capturedReview.options.reviewContext, /diff --git a\/src\/example.js/);
    assert.equal(capturedReview.options.throwOnProviderError, true);
  });

  await t.test('agent.ask returns provider failures instead of fabricated review text', async () => {
    providerFailure = true;
    const askRes = await fetch(`${baseUrl}/api/v1/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command_type: 'agent.ask',
        payload: { pr_number: 26, question: 'What changed?' }
      })
    });
    const askData = await askRes.json();
    assert.equal(askRes.status, 500);
    assert.match(askData.error, /quota exceeded/);
    assert.equal(askData.result, undefined);
    providerFailure = false;
  });

  await t.test('GET /api/v1/tasks returns backlog tasks array', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.tasks));
  });

  await t.test('RepoDataService reads tasks from project state when no backlog tasks directory exists', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-task-state-'));
    try {
      fs.mkdirSync(path.join(repo, '.agentcrew'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.agentcrew', 'tasks.json'), JSON.stringify([
        { id: 'task-state-1', title: 'Stored task', stage: 'in_progress', created_at: '2026-10-20T00:00:00.000Z' },
        { id: 'task-state-backlog', title: 'Legacy backlog', stage: 'backlog' },
        { id: 'task-state-todo', title: 'Legacy todo', stage: 'todo' }
      ]));
      const tasks = await new RepoDataService({ repoPath: repo }).getBacklogTasks();
      assert.ok(tasks.some((task) => task.id === 'task-state-1' && task.stage === 'in_progress'));
      assert.ok(tasks.some((task) => task.id === 'task-state-backlog' && task.stage === 'planning'));
      assert.ok(tasks.some((task) => task.id === 'task-state-todo' && task.stage === 'planning'));
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  await t.test('GET /api/v1/tasks normalizes legacy merged task stages', async () => {
    const original = server.readProjectCollection(project.id, 'tasks');
    try {
      server.writeProjectCollection(project.id, 'tasks', [
        { id: 'legacy-backlog-task', title: 'Legacy backlog', stage: 'backlog' },
        { id: 'legacy-todo-task', title: 'Legacy todo', stage: 'todo' }
      ]);
      const tasks = (await (await fetch(`${baseUrl}/api/v1/tasks`)).json()).tasks;
      assert.equal(tasks.find((task) => task.id === 'legacy-backlog-task').stage, 'planning');
      assert.equal(tasks.find((task) => task.id === 'legacy-todo-task').stage, 'planning');
    } finally { server.writeProjectCollection(project.id, 'tasks', original); }
  });

  await t.test('project switch rejects new commands, room messages, and terminal upgrades', async () => {
    server.projectSwitching = true;
    try {
      const command = await fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_type: 'task.create', payload: { title: 'blocked' } }) });
      assert.equal(command.status, 409);
      assert.deepEqual(await command.json(), { status: 'error', code: 'PROJECT_SWITCH_IN_PROGRESS', error: 'Project switch in progress or active project changed' });
      const message = await fetch(`${baseUrl}/api/v1/room/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'blocked' }) });
      assert.equal(message.status, 409);
      assert.deepEqual(await message.json(), { status: 'error', code: 'PROJECT_SWITCH_IN_PROGRESS', error: 'Project switch in progress or active project changed' });
      let wire = '';
      const socket = { write(value) { wire += value; }, destroy() {} };
      await server.handleUpgrade({ url: '/api/v1/pty', headers: { host: 'localhost' } }, socket, Buffer.alloc(0));
      assert.match(wire, /^HTTP\/1\.1 409 Conflict/);
      assert.match(wire, /Project switch in progress/);
    } finally { server.projectSwitching = false; }
  });

  await t.test('POST mutation rejects if project changes while its body is being read', async () => {
    const originalProjectId = server.activeProjectId;
    const originalReadJsonBody = server.readJsonBody;
    let bodyReadStarted;
    let releaseBody;
    const started = new Promise((resolve) => { bodyReadStarted = resolve; });
    const bodyGate = new Promise((resolve) => { releaseBody = resolve; });
    server.readJsonBody = async () => { bodyReadStarted(); await bodyGate; return { command_type: 'task.create', payload: { title: 'stale project write' } }; };
    try {
      const pending = fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await started;
      server.activeProjectId = 'switched-project';
      releaseBody();
      const response = await pending;
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { status: 'error', code: 'PROJECT_SWITCH_IN_PROGRESS', error: 'Project switch in progress or active project changed' });
    } finally {
      releaseBody();
      server.activeProjectId = originalProjectId;
      server.readJsonBody = originalReadJsonBody;
    }
  });

  await t.test('forced project switch releases quiesced agent scheduler holds', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-force-switch-'));
    try {
      const target = await workspace.registerProject({ path: targetDir, name: 'Forced Switch Target', mode: 'independent', zone: 'work' });
      const activeKey = `${project.id}@${server.repoPath}:Dev-1`;
      server.chatService.activeTurns = new Map([[activeKey, { controller: new AbortController() }]]);
      const originalQuiesce = server.chatService.quiesceAgent;
      server.chatService.quiesceAgent = async (agentId, { projectId: scopedProjectId }) => {
        const key = `${scopedProjectId}:${agentId}`;
        scheduler.holdAgent(key);
        return { quiescent: true };
      };
      try {
        const response = await fetch(`${baseUrl}/api/v1/projects/${target.id}/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) });
        assert.equal(response.status, 200);
        assert.equal(scheduler.heldAgents.has(`${project.id}:Dev-1`), false);
        const back = await fetch(`${baseUrl}/api/v1/projects/${project.id}/activate`, { method: 'POST' });
        assert.equal(back.status, 200);
      } finally {
        server.chatService.quiesceAgent = originalQuiesce;
        server.chatService.activeTurns.clear();
      }
    } finally { fs.rmSync(targetDir, { recursive: true, force: true }); }
  });

  await t.test('persisted room cutoffs filter matching agent messages in every channel', async () => {
    const old = await workspace.addRoomMessage(project.id, { channel: 'random', senderType: 'agent', senderId: 'dev-1', senderName: 'Dev-1', text: 'old persisted message' });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(tmpDir, 'projects', project.id, 'agentcrew.db'));
    try {
      db.exec('CREATE TABLE IF NOT EXISTS session_view_cutoffs (project_id TEXT NOT NULL, agent_id TEXT NOT NULL, action TEXT NOT NULL, cutoff_at TEXT NOT NULL, PRIMARY KEY(project_id, agent_id))');
      db.prepare('INSERT OR REPLACE INTO session_view_cutoffs (project_id, agent_id, action, cutoff_at) VALUES (?, ?, ?, ?)').run(project.id, 'Dev-1', 'session.clear_view', new Date(Date.now() + 1000).toISOString());
    } finally { db.close(); }
    const response = await fetch(`${baseUrl}/api/v1/room/messages?channel=random`);
    assert.ok(!(await response.json()).messages.some((message) => message.id === old.id));
  });

  await t.test('scheduler pause is rechecked inside deferred mention dispatch', async () => {
    const originalImmediate = global.setImmediate;
    const originalGenerate = server.chatService.generateResponse;
    let dispatch;
    let generated = false;
    server.chatService.generateResponse = async () => { generated = true; return 'unexpected'; };
    global.setImmediate = (fn) => { dispatch = fn; return { unref() {} }; };
    try {
      const response = await fetch(`${baseUrl}/api/v1/room/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '@Dev-1 queued before pause' }) });
      assert.equal(response.status, 201);
      const pause = await fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_type: 'scheduler.pause', payload: {} }) });
      assert.equal(pause.status, 200);
    } finally { global.setImmediate = originalImmediate; }
    await dispatch();
    assert.equal(generated, false);
    await fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_type: 'scheduler.resume', payload: {} }) });
    server.chatService.generateResponse = originalGenerate;
  });

  await t.test('command termination escalates and waits for child exit', async () => {
    for (let index = 0; index < 4; index++) server.commandJobs.set(`capacity-${index}`, { processAlive: true, status: 'cancelling' });
    const command = server.getCommandCatalog().find((entry) => entry.id === 'git:status');
    const capacity = await fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_type: 'command.run', payload: { job_id: command.id } }) });
    assert.equal(capacity.status, 429);
    for (let index = 0; index < 4; index++) server.commandJobs.delete(`capacity-${index}`);

    const child = new EventEmitter();
    child.pid = null;
    const signals = [];
    child.kill = (signal) => { signals.push(signal); if (signal === 'SIGKILL') setTimeout(() => child.emit('exit', null, signal), 5); return true; };
    const job = { child, processAlive: true, status: 'running' };
    const termination = server.terminateCommandJob(job, 'cancelled');
    await termination;
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    job.processAlive = false;

    const stoppingServer = new SupervisorServer({ repoPath: tmpDir, liveProviders: false });
    const stoppingChild = new EventEmitter();
    stoppingChild.pid = null;
    stoppingChild.kill = (signal) => { if (signal === 'SIGTERM') setTimeout(() => stoppingChild.emit('exit', 0, signal), 10); return true; };
    stoppingServer.commandJobs.set('stopping', { child: stoppingChild, processAlive: true, status: 'running' });
    let stopped = false;
    const stopping = stoppingServer.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(stopped, false);
    await stopping;
    assert.equal(stopped, true);
  });

  await t.test('ChatService quiesces only the requested project turn', async () => {
    const service = Object.create(ChatService.prototype);
    const aborted = { controller: new AbortController(), done: Promise.resolve(), quiescent: true };
    const untouched = { controller: new AbortController(), done: Promise.resolve(), quiescent: true };
    service.activeTurns = new Map([[`project-a@/repo-a:Dev-1`, aborted], [`project-b@/repo-b:Dev-1`, untouched]]);
    const held = [];
    const cancelled = [];
    const released = [];
    service.scheduler = {
      holdAgent(key) { held.push(key); },
      cancelQueuedForAgent(key) { cancelled.push(key); },
      releaseAgent(key) { released.push(key); },
    };
    service.resolveAgent = async (id) => ({ name: id });
    await service.quiesceAgent('Dev-1', { projectId: 'project-a', timeoutMs: 10 });
    assert.equal(aborted.controller.signal.aborted, true);
    assert.equal(untouched.controller.signal.aborted, false);
    assert.deepEqual(held, ['project-a:Dev-1']);
    assert.deepEqual(cancelled, ['project-a:Dev-1']);
    service.resumeAgent('Dev-1', { projectId: 'project-a' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(released, ['project-a:Dev-1']);

    service.projectId = 'project-a';
    await service.quiesceAgent('Dev-1', { projectId: 'project-a', timeoutMs: 10 });
    assert.equal(held.at(-1), 'project-a:Dev-1');
    service.resumeAgent('Dev-1', { projectId: 'project-a' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(released.at(-1), 'project-a:Dev-1');
  });

  await t.test('GET /api/v1/pull-requests returns PR array', async () => {
    const res = await fetch(`${baseUrl}/api/v1/pull-requests`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.pullRequests));
  });

  await t.test('GET /api/v1/repositories returns active repositories and worktrees', async () => {
    const res = await fetch(`${baseUrl}/api/v1/repositories`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.repositories));
    assert.ok(data.repositories.length >= 1);
  });

  await t.test('GET /api/v1/analytics returns KPIs and repository activity', async () => {
    const res = await fetch(`${baseUrl}/api/v1/analytics`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.analytics);
    assert.ok(data.analytics.kpis);
    assert.ok(data.analytics.repositories);
  });

  await t.test('GET /api/v1/metrics returns cycle time and utilization metrics', async () => {
    const before = server.observability.taskMetrics.length;
    const res = await fetch(`${baseUrl}/api/v1/metrics`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.metrics);
    assert.ok('cycle_time_minutes' in data.metrics);
    assert.ok('pass_rate' in data.metrics);
    await fetch(`${baseUrl}/api/v1/metrics`);
    assert.equal(server.observability.taskMetrics.length, before, 'GET must not add synthetic observations');
  });

  await t.test('GET /api/v1/events establishes SSE stream with cursor header', async () => {
    return new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/api/v1/events`, (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'text/event-stream');

        let received = '';
        res.on('data', (chunk) => {
          received += chunk.toString();
          if (received.includes('event: snapshot')) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', (err) => {
        // Ignored when destroyed
        if (err.code !== 'ECONNRESET') reject(err);
      });
    });
  });
});
