const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { TEAM_PRESETS, getRosterForPreset } = require('./team-presets');

const DEFAULT_ROSTER = [
  { name: 'Alice', role: 'Business Analyst', provider: 'agy', model: 'gemini-2.5-pro' },
  { name: 'Peter', role: 'Product Owner', provider: 'agy', model: 'gemini-2.5-pro' },
  { name: 'Arthur', role: 'Architect', provider: 'codex', model: 'o3' },
  { name: 'Dev-1', role: 'Developer', provider: 'codex', model: 'o3' },
  { name: 'Dev-2', role: 'Developer', provider: 'codex', model: 'o3' },
  { name: 'Dev-3', role: 'Developer', provider: 'agy', model: 'gemini-2.5-pro' },
  { name: 'Dev-4', role: 'Developer', provider: 'agy', model: 'gemini-2.5-pro' },
  { name: 'QA-1', role: 'Tester', provider: 'gemini', model: 'gemini-2.5-pro' },
  { name: 'QA-2', role: 'Tester', provider: 'gemini', model: 'gemini-2.5-pro' },
  { name: 'QA-3', role: 'Tester', provider: 'agy', model: 'gemini-2.5-pro' },
  { name: 'QA-4', role: 'Tester', provider: 'agy', model: 'gemini-2.5-pro' },
  { name: 'Integrator-1', role: 'Integrator', provider: 'codex', model: 'o3' },
  { name: 'Integrator-2', role: 'Integrator', provider: 'agy', model: 'gemini-2.5-pro' },
];

class WorkspaceManager {
  constructor(opts = {}) {
    this.baseDir = opts.baseDir || path.join(process.env.HOME || '', '.agentcrew');
  }

  _getRegistryDb() {
    fs.mkdirSync(this.baseDir, { recursive: true });
    const regPath = path.join(this.baseDir, 'registry.db');
    const db = new DatabaseSync(regPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL DEFAULT 'multi_worktree',
        zone TEXT NOT NULL DEFAULT 'work',
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    return db;
  }

  _registerInMaster({ id, name, path: projectPath, mode = 'multi_worktree', zone = 'work', isActive = 0, createdAt }) {
    const regDb = this._getRegistryDb();
    try {
      regDb.prepare(`
        INSERT INTO projects (id, name, path, mode, zone, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          name = excluded.name,
          mode = excluded.mode,
          zone = excluded.zone,
          is_active = CASE WHEN excluded.is_active = 1 THEN 1 ELSE projects.is_active END
      `).run(id, name, projectPath, mode, zone, isActive ? 1 : 0, createdAt || new Date().toISOString());
    } finally {
      regDb.close();
    }
  }

  async listProjects() {
    const db = this._getRegistryDb();
    try {
      const rows = db.prepare('SELECT id, name, path, mode, zone, is_active, created_at FROM projects ORDER BY is_active DESC, created_at DESC').all();
      return rows.map(r => ({ ...r, is_active: Boolean(r.is_active) }));
    } finally {
      db.close();
    }
  }

  async registerProject({ path: targetPath, name, mode = 'multi_worktree', zone = 'work', roster, team_preset, create_if_missing = false } = {}) {
    if (!targetPath || typeof targetPath !== 'string') {
      throw Object.assign(new Error('Project path is required'), { statusCode: 400 });
    }
    const resolvedPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedPath)) {
      if (create_if_missing) {
        fs.mkdirSync(resolvedPath, { recursive: true });
        spawnSync('git', ['init'], { cwd: resolvedPath, stdio: 'ignore' });
      } else {
        throw Object.assign(new Error(`Target path does not exist: ${targetPath}`), { statusCode: 400 });
      }
    }
    const normalized = fs.realpathSync(resolvedPath);
    if (!['independent', 'multi_worktree'].includes(mode)) {
      throw Object.assign(new Error('Invalid project mode: must be independent or multi_worktree'), { statusCode: 400 });
    }
    if (!['work', 'personal', 'side'].includes(zone)) {
      throw Object.assign(new Error('Invalid project zone: must be work, personal, or side'), { statusCode: 400 });
    }
    const db = this._getRegistryDb();
    try {
      const existing = db.prepare('SELECT * FROM projects WHERE path = ?').get(normalized);
      if (existing) {
        return { ...existing, is_active: Boolean(existing.is_active) };
      }
      const count = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
      const isActive = count === 0 ? 1 : 0;
      const projectName = name || path.basename(normalized);
      const res = await this.initProject({ repoPath: normalized, name: projectName, mode, zone, isActive, roster, teamPreset: team_preset });
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(res.id);
      return { ...row, is_active: Boolean(row.is_active), dbPath: res.dbPath };
    } finally {
      db.close();
    }
  }

  async activateProject(projectId) {
    if (!projectId) {
      throw Object.assign(new Error('Project ID is required'), { statusCode: 400 });
    }
    const db = this._getRegistryDb();
    try {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      if (!project) {
        throw Object.assign(new Error(`Project not found: ${projectId}`), { statusCode: 404 });
      }
      db.exec('BEGIN TRANSACTION');
      db.prepare('UPDATE projects SET is_active = 0').run();
      db.prepare('UPDATE projects SET is_active = 1 WHERE id = ?').run(projectId);
      db.exec('COMMIT');
      return { ...project, is_active: true };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      db.close();
    }
  }

  async getActiveProject() {
    const db = this._getRegistryDb();
    try {
      const active = db.prepare('SELECT * FROM projects WHERE is_active = 1 LIMIT 1').get();
      if (active) return { ...active, is_active: true };
      const fallback = db.prepare('SELECT * FROM projects ORDER BY created_at DESC LIMIT 1').get();
      return fallback ? { ...fallback, is_active: Boolean(fallback.is_active) } : null;
    } finally {
      db.close();
    }
  }

  async getOrInitProject({ repoPath, name, mode = 'multi_worktree', zone = 'work' } = {}) {
    const normalized = fs.realpathSync(repoPath);
    const regDb = this._getRegistryDb();
    try {
      const regRow = regDb.prepare('SELECT * FROM projects WHERE path = ?').get(normalized);
      if (regRow) {
        const dbPath = path.join(this.baseDir, 'projects', regRow.id, 'agentcrew.db');
        if (fs.existsSync(dbPath)) {
          return { id: regRow.id, dbPath, projectDir: path.dirname(dbPath) };
        }
      }
    } finally {
      regDb.close();
    }

    const projectsDir = path.join(this.baseDir, 'projects');
    if (fs.existsSync(projectsDir)) {
      for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dbPath = path.join(projectsDir, entry.name, 'agentcrew.db');
        if (!fs.existsSync(dbPath)) continue;
        const db = new DatabaseSync(dbPath);
        try {
          const row = db.prepare('SELECT id, repo_path FROM projects LIMIT 1').get();
          if (row && fs.existsSync(row.repo_path) && fs.realpathSync(row.repo_path) === normalized) {
            this._registerInMaster({
              id: row.id,
              name: name || path.basename(normalized),
              path: normalized,
              mode,
              zone,
              isActive: 1,
              createdAt: new Date().toISOString()
            });
            return { id: row.id, dbPath, projectDir: path.dirname(dbPath) };
          }
        } catch (_) {
          // An unrelated or old database is not this workspace.
        } finally {
          db.close();
        }
      }
    }
    return this.initProject({ repoPath: normalized, name, mode, zone, isActive: 1 });
  }

  async initProject({ repoPath, name, mode = 'multi_worktree', zone = 'work', isActive = 0, roster, teamPreset } = {}) {
    const projectId = crypto.randomUUID();
    const projectDir = path.join(this.baseDir, 'projects', projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    const dbPath = path.join(projectDir, 'agentcrew.db');
    const db = new DatabaseSync(dbPath);

    // Initialize TRD SQLite schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        avatar TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        task_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const now = new Date().toISOString();
    const insertProject = db.prepare(`
      INSERT INTO projects (id, name, repo_path, created_at)
      VALUES (?, ?, ?, ?)
    `);
    insertProject.run(projectId, name || path.basename(repoPath), repoPath, now);

    const insertAgent = db.prepare(`
      INSERT INTO agents (id, project_id, name, role, provider, model, avatar, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let rosterToSeed = DEFAULT_ROSTER;
    if (Array.isArray(roster) && roster.length > 0) {
      rosterToSeed = roster;
    } else if (teamPreset) {
      const presetRoster = getRosterForPreset(teamPreset);
      if (presetRoster) rosterToSeed = presetRoster;
    }

    for (const member of rosterToSeed) {
      insertAgent.run(
        crypto.randomUUID(),
        projectId,
        member.name,
        member.role,
        member.provider || 'codex',
        member.model || 'gpt-6-luna',
        member.avatar || `avatar-${(member.role || 'dev').toLowerCase().replace(/\s+/g, '-')}`,
        now
      );
    }

    db.close();

    this._registerInMaster({
      id: projectId,
      name: name || path.basename(repoPath),
      path: fs.realpathSync(repoPath),
      mode,
      zone,
      isActive,
      createdAt: now,
    });

    return {
      id: projectId,
      dbPath,
      projectDir,
    };
  }

  async listAgents(projectId) {
    const dbPath = path.join(this.baseDir, 'projects', projectId, 'agentcrew.db');
    const db = new DatabaseSync(dbPath);
    this.ensureAgentConfig(db);
    const query = db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY rowid ASC');
    const rows = query.all(projectId);
    db.close();
    return rows;
  }

  ensureAgentConfig(db) {
    const columns = db.prepare('PRAGMA table_info(agents)').all().map((row) => row.name);
    if (!columns.includes('backup_provider')) db.exec('ALTER TABLE agents ADD COLUMN backup_provider TEXT');
    if (!columns.includes('backup_model')) db.exec('ALTER TABLE agents ADD COLUMN backup_model TEXT');
  }

  async setAgentProviderConfig(projectId, agentId, { backupProvider = null, backupModel = null } = {}) {
    if (backupProvider !== null && !['agy', 'codex', 'gemini'].includes(backupProvider)) {
      throw Object.assign(new Error('Unsupported backup provider'), { statusCode: 400 });
    }
    if (backupModel !== null && (typeof backupModel !== 'string' || backupModel.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/.test(backupModel))) {
      throw Object.assign(new Error('Invalid backup model'), { statusCode: 400 });
    }
    const dbPath = path.join(this.baseDir, 'projects', projectId, 'agentcrew.db');
    const db = new DatabaseSync(dbPath);
    try {
      this.ensureAgentConfig(db);
      const row = db.prepare('SELECT provider FROM agents WHERE project_id = ? AND (id = ? OR name = ?)').get(projectId, agentId, agentId);
      if (!row) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
      if (backupProvider === row.provider) throw Object.assign(new Error('Backup provider must differ from primary'), { statusCode: 400 });
      db.prepare('UPDATE agents SET backup_provider = ?, backup_model = ? WHERE project_id = ? AND (id = ? OR name = ?)')
        .run(backupProvider, backupProvider ? backupModel : null, projectId, agentId, agentId);
    } finally {
      db.close();
    }
  }

  ensureProviderConversations(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS provider_conversations (
      project_id TEXT NOT NULL, agent_id TEXT NOT NULL, provider TEXT NOT NULL,
      session_id TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, agent_id, provider)
    )`);
    // Preserve the old single-provider row on first access; never overwrite a newer conversation.
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_sessions'").get();
    if (legacy) db.exec(`INSERT OR IGNORE INTO provider_conversations
      SELECT project_id, agent_id, provider, session_id, updated_at FROM provider_sessions`);
  }

  ensureRoomMessages(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS room_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'team-activity',
      sender_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    )`);
  }

  async listRoomMessages(projectId, { channel = 'team-activity', limit = 100 } = {}) {
    const dbPath = path.join(this.baseDir, 'projects', projectId, 'agentcrew.db');
    if (!fs.existsSync(dbPath)) return [];
    const db = new DatabaseSync(dbPath);
    try {
      this.ensureRoomMessages(db);
      const rows = db.prepare('SELECT * FROM room_messages WHERE project_id = ? AND channel = ? ORDER BY created_at ASC LIMIT ?')
        .all(projectId, channel, limit);
      return rows.map((r) => ({
        ...r,
        metadata: r.metadata ? JSON.parse(r.metadata) : null
      }));
    } finally {
      db.close();
    }
  }

  async addRoomMessage(projectId, { channel = 'team-activity', senderType = 'human', senderId = 'operator', senderName = 'Operator', text, metadata = null } = {}) {
    if (!text || typeof text !== 'string') {
      throw Object.assign(new Error('Message text is required'), { statusCode: 400 });
    }
    const dbPath = path.join(this.baseDir, 'projects', projectId, 'agentcrew.db');
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath);
    try {
      this.ensureRoomMessages(db);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const metaStr = metadata ? JSON.stringify(metadata) : null;
      db.prepare(`
        INSERT INTO room_messages (id, project_id, channel, sender_type, sender_id, sender_name, text, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectId, channel, senderType, senderId, senderName, text, metaStr, now);
      return { id, project_id: projectId, channel, sender_type: senderType, sender_id: senderId, sender_name: senderName, text, metadata, created_at: now };
    } finally {
      db.close();
    }
  }

  async checkReadiness(projectId) {
    const agents = await this.listAgents(projectId);
    const providers = [...new Set(agents.map(a => a.provider))];
    return {
      repoLinked: true,
      databaseReady: true,
      rosterCount: agents.length,
      configuredProviders: providers,
    };
  }

  async getAgentSession(projectId, agentId, provider = null) {
    const dbPath = path.join(this.baseDir, 'projects', projectId, 'agentcrew.db');
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath);
    this.ensureProviderConversations(db);
    const stmt = provider
      ? db.prepare('SELECT session_id, provider FROM provider_conversations WHERE project_id = ? AND agent_id = ? AND provider = ?')
      : db.prepare('SELECT session_id, provider FROM provider_conversations WHERE project_id = ? AND agent_id = ? ORDER BY updated_at DESC LIMIT 1');
    const row = provider ? stmt.get(projectId, agentId, provider) : stmt.get(projectId, agentId);
    db.close();
    return row ? { sessionId: row.session_id, provider: row.provider } : null;
  }

  async saveAgentSession(projectId, agentId, { provider, sessionId } = {}) {
    const dbPath = path.join(this.baseDir, 'projects', projectId, 'agentcrew.db');
    if (!fs.existsSync(dbPath)) return;
    const db = new DatabaseSync(dbPath);
    this.ensureProviderConversations(db);
    const stmt = db.prepare(`
      INSERT INTO provider_conversations (project_id, agent_id, provider, session_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, agent_id, provider) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `);
    stmt.run(projectId, agentId, provider, sessionId, new Date().toISOString());
    db.close();
  }
}

module.exports = { WorkspaceManager, DEFAULT_ROSTER, TEAM_PRESETS };
