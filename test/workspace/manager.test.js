const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceManager } = require('../../src/workspace/manager');

test('WorkspaceManager initializes SQLite database and project identity', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-test-'));
  const manager = new WorkspaceManager({ baseDir: tmpDir });

  const project = await manager.initProject({
    repoPath: process.cwd(),
    name: 'test-project',
  });

  assert.ok(project.id, 'Project must have a UUID');
  assert.ok(fs.existsSync(project.dbPath), 'agentcrew.db must exist on disk');

  const agents = await manager.listAgents(project.id);
  assert.equal(agents.length, 13, 'Must seed default 13 agent identities');
  
  const roles = agents.map(a => a.role);
  assert.ok(roles.includes('Business Analyst'));
  assert.ok(roles.includes('Product Owner'));
  assert.ok(roles.includes('Architect'));
  assert.equal(roles.filter(r => r === 'Developer').length, 4);
  assert.equal(roles.filter(r => r === 'Tester').length, 4);
  assert.equal(roles.filter(r => r === 'Integrator').length, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('WorkspaceManager retrieves project readiness check', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-test-'));
  const manager = new WorkspaceManager({ baseDir: tmpDir });

  const project = await manager.initProject({
    repoPath: process.cwd(),
    name: 'test-project',
  });

  const readiness = await manager.checkReadiness(project.id);
  assert.equal(readiness.repoLinked, true);
  assert.equal(readiness.databaseReady, true);
  assert.equal(readiness.rosterCount, 13);
  assert.ok(readiness.configuredProviders.length > 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('WorkspaceManager persists and retrieves agent provider session (TASK-29)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-test-'));
  const manager = new WorkspaceManager({ baseDir: tmpDir });

  const project = await manager.initProject({
    repoPath: process.cwd(),
    name: 'test-project',
  });

  // Verify non-existent session
  const none = await manager.getAgentSession(project.id, 'Alice');
  assert.equal(none, null);

  // Save session
  await manager.saveAgentSession(project.id, 'Alice', {
    provider: 'agy',
    sessionId: 'session-alice-uuid-999',
  });

  // Retrieve session
  const session = await manager.getAgentSession(project.id, 'Alice');
  assert.equal(session.provider, 'agy');
  assert.equal(session.sessionId, 'session-alice-uuid-999');

  // Update session
  await manager.saveAgentSession(project.id, 'Alice', {
    provider: 'agy',
    sessionId: 'session-alice-uuid-1000',
  });
  const updated = await manager.getAgentSession(project.id, 'Alice');
  assert.equal(updated.sessionId, 'session-alice-uuid-1000');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('WorkspaceManager persists explicit backup settings and separate provider conversations', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-provider-config-'));
  const manager = new WorkspaceManager({ baseDir: tmpDir });
  const project = await manager.initProject({ repoPath: tmpDir, name: 'test' });
  await manager.setAgentProviderConfig(project.id, 'QA-1', { backupProvider: 'codex', backupModel: 'o3' });
  const qa = (await manager.listAgents(project.id)).find((agent) => agent.name === 'QA-1');
  assert.equal(qa.backup_provider, 'codex');
  assert.equal(qa.backup_model, 'o3');
  await manager.saveAgentSession(project.id, 'QA-1', { provider: 'gemini', sessionId: 'gemini-1' });
  await manager.saveAgentSession(project.id, 'QA-1', { provider: 'codex', sessionId: 'codex-1' });
  assert.equal((await manager.getAgentSession(project.id, 'QA-1', 'gemini')).sessionId, 'gemini-1');
  assert.equal((await manager.getAgentSession(project.id, 'QA-1', 'codex')).sessionId, 'codex-1');
  await assert.rejects(manager.setAgentProviderConfig(project.id, 'QA-1', { backupProvider: 'gemini' }), /differ/);
  await assert.rejects(manager.setAgentProviderConfig(project.id, 'QA-1', { backupProvider: 'codex', backupModel: 'bad model' }), /Invalid backup model/);
  const restarted = new WorkspaceManager({ baseDir: tmpDir });
  const sameProject = await restarted.getOrInitProject({ repoPath: tmpDir, name: 'test' });
  assert.equal(sameProject.id, project.id);
  assert.equal((await restarted.listAgents(project.id)).find((agent) => agent.name === 'QA-1').backup_provider, 'codex');
});

test('WorkspaceManager multi-project registry supports registration, isolation, and activation (TASK-37)', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-multi-project-'));
  const projDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-proj-1-'));
  const projDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-proj-2-'));

  const manager = new WorkspaceManager({ baseDir });

  // List projects initially empty
  const initial = await manager.listProjects();
  assert.equal(initial.length, 0);

  // Register Project 1
  const p1 = await manager.registerProject({
    path: projDir1,
    name: 'Work Engine',
    mode: 'independent',
    zone: 'work'
  });
  assert.ok(p1.id);
  assert.equal(p1.name, 'Work Engine');
  assert.equal(p1.mode, 'independent');
  assert.equal(p1.zone, 'work');
  assert.equal(p1.is_active, true);

  // Register Project 2
  const p2 = await manager.registerProject({
    path: projDir2,
    name: 'Personal Hobby',
    mode: 'multi_worktree',
    zone: 'personal'
  });
  assert.ok(p2.id);
  assert.equal(p2.name, 'Personal Hobby');
  assert.equal(p2.is_active, false);

  // Validation errors
  await assert.rejects(manager.registerProject({ path: '/non/existent/path/xyz' }), /Target path does not exist/);
  await assert.rejects(manager.registerProject({ path: projDir1, mode: 'invalid_mode' }), /Invalid project mode/);
  await assert.rejects(manager.registerProject({ path: projDir1, zone: 'invalid_zone' }), /Invalid project zone/);

  // List projects returns both
  const list = await manager.listProjects();
  assert.equal(list.length, 2);
  const foundP1 = list.find(p => p.id === p1.id);
  const foundP2 = list.find(p => p.id === p2.id);
  assert.equal(foundP1.is_active, true);
  assert.equal(foundP2.is_active, false);

  // Activate Project 2
  const activated = await manager.activateProject(p2.id);
  assert.equal(activated.id, p2.id);
  assert.equal(activated.is_active, true);

  const activeNow = await manager.getActiveProject();
  assert.equal(activeNow.id, p2.id);

  const updatedList = await manager.listProjects();
  assert.equal(updatedList.find(p => p.id === p1.id).is_active, false);
  assert.equal(updatedList.find(p => p.id === p2.id).is_active, true);

  // Isolation: session saved in p1 does not exist in p2
  await manager.saveAgentSession(p1.id, 'Alice', { provider: 'agy', sessionId: 'p1-alice-session' });
  const p1Alice = await manager.getAgentSession(p1.id, 'Alice');
  const p2Alice = await manager.getAgentSession(p2.id, 'Alice');
  assert.equal(p1Alice.sessionId, 'p1-alice-session');
  assert.equal(p2Alice, null);

  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.rmSync(projDir1, { recursive: true, force: true });
  fs.rmSync(projDir2, { recursive: true, force: true });
});

test('WorkspaceManager supports team presets and create_if_missing', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrew-presets-base-'));
  const missingProjDir = path.join(os.tmpdir(), 'agentcrew-missing-' + Date.now());
  const manager = new WorkspaceManager({ baseDir });

  // Register with create_if_missing and lean team preset (3 agents)
  const proj = await manager.registerProject({
    path: missingProjDir,
    name: 'Lean App',
    team_preset: 'lean',
    create_if_missing: true
  });

  assert.ok(fs.existsSync(missingProjDir), 'Must create missing directory');
  assert.ok(fs.existsSync(path.join(missingProjDir, '.git')), 'Must initialize git repo');
  assert.equal(proj.name, 'Lean App');

  const agents = await manager.listAgents(proj.id);
  assert.equal(agents.length, 3, 'Lean preset must seed exactly 3 agents');
  assert.deepEqual(agents.map(a => a.name).sort(), ['Dev-1', 'Integrator-1', 'QA-1']);

  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.rmSync(missingProjDir, { recursive: true, force: true });
});


