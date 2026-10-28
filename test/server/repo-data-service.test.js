const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { RepoDataService } = require('../../src/server/repo-data-service');

test('RepoDataService unit test suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-repo-data-test-'));

  // Scaffold fixture backlog/tasks directory
  const tasksDir = path.join(tmpDir, 'backlog', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  fs.writeFileSync(
    path.join(tasksDir, 'task-1 - Design Core Architecture.md'),
    `---
id: TASK-1
title: Design Core Architecture
status: Done
priority: high
ordinal: 1000
---

## Description
Design the core architecture.
`
  );

  fs.writeFileSync(
    path.join(tasksDir, 'task-2 - Implement Provider Plugins.md'),
    `---
id: TASK-2
title: Implement Provider Plugins
status: In Progress
priority: medium
ordinal: 2000
---

## Description
Implement plugins.
`
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('getBacklogTasks parses markdown frontmatter and assigns stages', async () => {
    const service = new RepoDataService({ repoPath: tmpDir });
    const tasks = await service.getBacklogTasks();

    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, 'TASK-1');
    assert.equal(tasks[0].stage, 'done');
    assert.equal(tasks[0].priority, 'high');
    assert.equal(tasks[0].owner, 'Arthur (Architect)');

    assert.equal(tasks[1].id, 'TASK-2');
    assert.equal(tasks[1].stage, 'in_progress');
    assert.equal(tasks[1].priority, 'medium');
  });

  await t.test('getBacklogTasks includes active popup tasks', async () => {
    const service = new RepoDataService({ repoPath: tmpDir });
    const popups = [{ id: 'P-101', title: 'Scope change for auth', status: 'proposed', riskLevel: 'high' }];
    const tasks = await service.getBacklogTasks(popups);

    assert.equal(tasks.length, 3);
    const popupTask = tasks.find(t => t.id === 'P-101');
    assert.ok(popupTask);
    assert.equal(popupTask.stage, 'planning');
    assert.equal(popupTask.owner, 'Peter (PO)');
  });

  await t.test('parsePrBodySections extracts problem and approach sections', () => {
    const service = new RepoDataService({ repoPath: tmpDir });
    const markdown = `
## Problem
- Issue with state leakage across agents.
- Operators lacked visibility into concurrent turns.

## What changed
- Isolated session storage in SQLite database.
- Added WebSocket PTY takeover streaming.
`;

    const parsed = service.parsePrBodySections(markdown);
    assert.ok(parsed.problem.length >= 2);
    assert.ok(parsed.problem[0].includes('Issue with state leakage'));
    assert.ok(parsed.approach.length >= 2);
    assert.ok(parsed.approach[0].includes('Isolated session storage'));
  });

  await t.test('getPullRequestReviewContext loads metadata and diff as argument arrays', async () => {
    const service = new RepoDataService({ repoPath: tmpDir });
    const calls = [];
    service.execCommand = async (file, args) => {
      calls.push({ file, args });
      if (args[1] === 'view') {
        return { error: null, stderr: '', stdout: JSON.stringify({
          number: 42,
          title: 'Review title',
          author: { login: 'author' },
          body: 'Review body',
          baseRefName: 'main',
          headRefName: 'feature'
        }) };
      }
      return { error: null, stderr: '', stdout: 'diff --git a/file b/file' };
    };
    const context = await service.getPullRequestReviewContext(42);
    assert.equal(context.title, 'Review title');
    assert.equal(context.author, 'author');
    assert.equal(context.diff, 'diff --git a/file b/file');
    assert.deepEqual(calls.map(call => call.args.slice(0, 3)), [
      ['pr', 'view', '42'],
      ['pr', 'diff', '42']
    ]);
  });

  await t.test('in-flight pull request reads stay pinned to their starting repository', async () => {
    const service = new RepoDataService({ repoPath: path.join(tmpDir, 'repo-a') });
    let releaseA;
    const pendingA = new Promise((resolve) => { releaseA = resolve; });
    service.execCommand = async (_file, args, options) => {
      if (args[0] === 'pr' && options.cwd.endsWith('repo-a')) return pendingA;
      if (args[0] === 'pr') return { error: null, stdout: '[]', stderr: '' };
      return { error: null, stdout: '', stderr: '' };
    };
    const firstRead = service.getPullRequests();
    service.setRepoRoot(path.join(tmpDir, 'repo-b'));
    releaseA({ error: null, stdout: JSON.stringify([{ number: 101, title: 'A project', state: 'OPEN' }]), stderr: '' });
    const [aResults, bResults] = await Promise.all([firstRead, service.getPullRequests()]);
    assert.equal(aResults[0].title, 'A project');
    assert.deepEqual(bResults, []);
    assert.equal(service.cache.has(`${path.join(tmpDir, 'repo-b')}:pullRequests`), true);
    assert.equal(service.cache.has(`${path.join(tmpDir, 'repo-a')}:pullRequests`), false);
  });

  await t.test('getRepositories returns current repository and worktree status', async () => {
    const service = new RepoDataService({ repoPath: process.cwd() });
    const repos = await service.getRepositories();

    assert.ok(Array.isArray(repos));
    assert.ok(repos.length >= 1);
    const mainRepo = repos[0];
    assert.equal(mainRepo.name, path.basename(process.cwd()));
    assert.ok(mainRepo.branch);
    assert.ok(mainRepo.status);
    assert.ok(mainRepo.worktreesCount >= 1);
  });

  await t.test('getAnalytics computes delivered tasks and KPI structures', async () => {
    const service = new RepoDataService({ repoPath: tmpDir });
    const analytics = await service.getAnalytics();

    assert.ok(analytics.kpis);
    assert.ok(analytics.kpis.week);
    assert.ok(analytics.kpis.month);
    const delivKpi = analytics.kpis.week.find(k => k.id === 'delivered');
    assert.ok(delivKpi);
    assert.equal(delivKpi.value, '1'); // 1 Done task in tmpDir
  });
});
