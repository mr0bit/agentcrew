const http = require('node:http');
const url = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { PopupScopeChangeEngine } = require('../workflow/popup-engine');
const { ObservabilityEngine } = require('../observability/engine');
const { VirtualTeamRoom } = require('../ui/team-room');
const { IterationRunner } = require('../workflow/iteration-runner');
const { WebSocketConnection } = require('./websocket');
const { PtyManager } = require('../session/pty-manager');
const { AgentTerminal } = require('../session/agent-terminal');
const { TakeoverController } = require('../session/takeover-controller');
const { TurnScheduler } = require('../scheduler/turn-scheduler');
const { ChatService } = require('../chat/chat-service');
const { RepoDataService } = require('./repo-data-service');
const { which } = require('../lib/shell');
const { resolveInput } = require('../session/input-mode');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

class SupervisorServer {
  constructor(options = {}) {
    this.port = options.port !== undefined ? options.port : 3000;
    this.host = options.host || '127.0.0.1';
    this.repoPath = options.repoPath || process.cwd();
    this.workspace = options.workspace;
    this.projectId = options.projectId || null;
    this.activeProjectId = this.projectId;
    this.inFlightMutations = 0;
    this.pendingRoomDispatches = new Set();
    this.projectName = options.projectName || 'AgentCrew Workspace';
    this.scheduler = options.scheduler || new TurnScheduler({ maxConcurrency: 4 });
    this.takeoverController = options.takeoverController || new TakeoverController();
    this.takeoverProjectContexts = new Map();
    this.popupEngine = options.popupEngine || new PopupScopeChangeEngine();
    this.observability = options.observability || new ObservabilityEngine();
    this.teamRoom = options.teamRoom || new VirtualTeamRoom();
    this.staticDir = options.staticDir || path.join(__dirname, 'public');
    this.ptyManager = options.ptyManager || new PtyManager({ cwd: this.repoPath });
    this.which = options.which || which;
    this.agentTerminalFactory = options.agentTerminalFactory || ((opts) => new AgentTerminal(opts));
    // When true, chat replies come from the real provider CLIs (agy/codex); tests disable this.
    this.liveProviders = options.liveProviders !== false;

    this.chatService = options.chatService || new ChatService({
      repoPath: this.repoPath,
      scheduler: this.scheduler,
      ptyManager: this.ptyManager,
      workspace: this.workspace,
      projectId: this.projectId,
      liveProviders: this.liveProviders,
      which: this.which,
    });
    this.takeoverController.quiesceAgent = (agentId, opts) => this.chatService.quiesceAgent(agentId, { ...opts, projectId: this.takeoverProjectContexts.get(agentId) });

    this.repoDataService = options.repoDataService || new RepoDataService({ repoPath: this.repoPath });

    this.eventBus = options.eventBus || new EventEmitter();
    this.sseClients = new Set();
    this.wsClients = new Set();
    this.ptyOwners = new Map();
    this.agentTerminals = new Map();
    this.agentTerminalStarts = new Set();
    this.humanTurns = new Map();
    this.cursorCounter = 0;
    this.httpServer = null;
    this.heartbeatInterval = null;
    this.startedAt = Date.now();
    this.schedulerPaused = false;
    this.schedulerPausedProjects = new Set();
    this.commandJobs = new Map();
    this.sessionViewCutoffs = new Map();
    this.preferences = new Map();

    // Connect scheduler event bus to server event bus if present
    if (this.scheduler && this.scheduler.eventBus) {
      this.scheduler.eventBus.on('turn_queued', (d) => this.broadcastEvent('turn_queued', d));
      this.scheduler.eventBus.on('turn_started', (d) => this.broadcastEvent('turn_started', d));
      this.scheduler.eventBus.on('turn_completed', (d) => this.broadcastEvent('turn_completed', d));
    }
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error('Unhandled server error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      });

      this.httpServer.on('upgrade', (req, socket, head) => {
        this.handleUpgrade(req, socket, head).catch(() => socket.destroy());
      });

      this.httpServer.on('error', reject);

      this.httpServer.listen(this.port, this.host, () => {
        this.startHeartbeat();
        resolve(this);
      });
    });
  }

  async handleUpgrade(req, socket, head) {
    const entryProjectId = this.activeProjectId || this.projectId;
    if (this.projectSwitching) {
      socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nProject switch in progress');
      socket.destroy();
      return;
    }
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!this.isSameOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (parsedUrl.pathname === '/api/v1/pty') {
      const requestedAgentId = parsedUrl.searchParams.get('agent_id') || parsedUrl.searchParams.get('agent') || 'Dev-1';
      this.inFlightMutations++;
      let agentId;
      try {
        agentId = (await this.chatService.resolveAgent(requestedAgentId)).name;
        if (this.rejectProjectAdmission(socket, entryProjectId)) return;
      } finally { this.inFlightMutations--; }
      const takeoverToken = parsedUrl.searchParams.get('token') || parsedUrl.searchParams.get('takeover_token');
      const mode = parsedUrl.searchParams.get('mode') || (takeoverToken ? 'agent_tui' : 'chat');
      if (!['agent_tui', 'shell'].includes(mode) || !this.takeoverController.validateToken(agentId, takeoverToken)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (mode === 'agent_tui') {
        this.inFlightMutations++;
        try {
          if (this.rejectProjectAdmission(socket, entryProjectId)) return;
          return await this.handleAgentTerminalUpgrade(req, socket, agentId, takeoverToken);
        } finally { this.inFlightMutations--; }
      }
      const ws = WebSocketConnection.accept(req, socket);
      if (!ws) return;
      this.wsClients.add(ws);
      const ptySession = mode === 'shell'
        ? this.ptyManager.createSession({ sessionId: `pty-${agentId}-${Date.now()}` })
        : null;
      const ptyOwner = ptySession ? { agentId, takeoverToken, ptySession, ws, revoking: false } : null;
      if (ptySession) this.ptyOwners.set(ptySession.id, ptyOwner);
      const activeChatTurns = new Set();
      const finishThinking = (turnId, outcome) => {
        if (!activeChatTurns.delete(turnId)) return;
        const state = activeChatTurns.size ? 'thinking' : 'idle';
        this.teamRoom.updateAgentState(agentId, { state: state === 'idle' ? 'takeover' : state });
        this.broadcastEvent('agent_thinking_ended', { turn_id: turnId, agent_id: agentId, state, outcome });
      };

      if (ptySession) {
        ptySession.child.stdout.on('data', (chunk) => {
          ws.send(JSON.stringify({ type: 'output', data: chunk.toString('utf8') }));
        });
        ptySession.child.stderr.on('data', (chunk) => {
          ws.send(JSON.stringify({ type: 'output', data: chunk.toString('utf8') }));
        });
      }

      // Send initial greeting
      ws.send(JSON.stringify({
        type: 'ready',
        sessionId: ptySession?.id || null,
        agentId,
        cwd: ptySession?.cwd || this.repoPath,
        mode
      }));

      ws.on('message', async (msg) => {
        try {
          if (ptyOwner?.revoking) return;
          if (!this.takeoverController.validateToken(agentId, takeoverToken)) {
            ws.close();
            ptySession?.terminateTree();
            return;
          }
          const parsed = typeof msg === 'string' ? JSON.parse(msg) : JSON.parse(msg.toString('utf8'));
          if (parsed.type === 'input') {
            const input = resolveInput(parsed.data, parsed.mode || mode);
            if (!input.text) return;
            if (mode === 'shell') {
              if (input.mode !== 'shell') throw new Error('Shell socket accepts shell input only');
              ptySession.write(`${input.text}\n`);
            } else if (input.mode === 'shell') {
              this.beginHumanTurn(agentId);
              try {
                const result = await this.ptyManager.execute(input.text, { cwd: this.repoPath });
                ws.send(JSON.stringify({ type: 'output', data: result.stdout || result.stderr || '' }));
              } finally {
                this.endHumanTurn(agentId);
              }
            } else {
              const turnId = crypto.randomUUID();
              activeChatTurns.add(turnId);
              this.beginHumanTurn(agentId);
              let outcome = 'failed';
              const wsSend = (frame) => ws.send(JSON.stringify({ turn_id: turnId, agent_id: agentId, ...frame }));
              this.teamRoom.updateAgentState(agentId, { state: 'thinking' });
              this.broadcastEvent('agent_thinking', { turn_id: turnId, agent_id: agentId, state: 'thinking' });
              wsSend({ type: 'chat_started' });
              try {
                const response = await this.chatService.generateResponse(agentId, input.text, {
                  source: 'human',
                  throwOnProviderError: true,
                  onChunk: (text, provider) => wsSend({ type: 'chat_chunk', text, provider }),
                  onRetry: (provider) => wsSend({ type: 'chat_retry', provider }),
                });
                outcome = 'completed';
                wsSend({ type: 'chat_completed', answer: response });
                this.broadcastEvent('agent_answered', {
                  agent_id: agentId,
                  pr_number: 'live',
                  question: input.text,
                  answer: response,
                  cli_grounded: this.liveProviders,
                  timestamp: new Date().toISOString()
                });
              } catch (error) {
                wsSend({ type: 'chat_failed', error: error.message });
              } finally {
                finishThinking(turnId, outcome);
                this.endHumanTurn(agentId);
              }
            }
          } else if (parsed.type === 'resize') {
            // resize event if available
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', data: `Invalid ${mode} input: ${error.message}` }));
        }
      });

      ws.on('close', () => {
        this.wsClients.delete(ws);
        for (const turnId of [...activeChatTurns]) finishThinking(turnId, 'disconnected');
        if (ptySession) {
          this.ptyOwners.delete(ptySession.id);
          ptySession.kill();
        }
      });

      ws.on('error', () => {
        this.wsClients.delete(ws);
        for (const turnId of [...activeChatTurns]) finishThinking(turnId, 'disconnected');
        if (ptySession) {
          this.ptyOwners.delete(ptySession.id);
          ptySession.kill();
        }
      });
    } else {
      socket.destroy();
    }
  }

  async handleAgentTerminalUpgrade(req, socket, agentId, takeoverToken) {
    if (!req.headers['sec-websocket-key']) {
      socket.destroy();
      return;
    }
    let owner = this.agentTerminals.get(agentId);
    if (this.agentTerminalStarts.has(agentId) || (owner?.ws && !owner.ws.isClosed)) {
      socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!owner) {
      this.agentTerminalStarts.add(agentId);
      try {
        const agent = await this.chatService.resolveAgent(agentId);
        const reports = await this.chatService.probeProviders();
        const available = new Map(reports.map((report) => [report.name, report.available]));
        const candidates = [agent.provider, agent.backupProvider].filter(Boolean);
        const provider = candidates.find((name) => ['agy', 'codex'].includes(name) && available.get(name) && this.which(name));
        if (!provider) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        const session = this.workspace && this.projectId
          ? await this.workspace.getAgentSession(this.projectId, agentId, provider)
          : await this.chatService.getAgentSession(agentId, provider);
        const terminal = this.agentTerminalFactory({
          agent: { ...agent, provider, model: provider === agent.provider ? agent.model : agent.backupModel },
          session,
          cwd: this.repoPath,
          which: this.which,
        }).start();
        owner = { agentId, projectId: this.projectId, takeoverToken, terminal, ws: null, provider, fallback: provider !== agent.provider, revoking: false };
        this.agentTerminals.set(agentId, owner);
        terminal.on('exit', ({ exitCode, signal }) => {
          if (owner.ws && !owner.ws.isClosed) owner.ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
          this.agentTerminals.delete(agentId);
        });
      } finally {
        this.agentTerminalStarts.delete(agentId);
      }
    }
    const ws = WebSocketConnection.accept(req, socket);
    if (!ws) return;
    owner.ws = ws;
    this.wsClients.add(ws);
    ws.send(JSON.stringify({
      type: 'ready', mode: 'agent_tui', agentId, provider: owner.provider,
      fallback: owner.fallback, resumeRequested: Boolean(owner.terminal.session?.sessionId),
      sessionId: owner.terminal.session?.sessionId || null, cwd: this.repoPath,
    }));
    if (owner.terminal.output) ws.send(JSON.stringify({ type: 'output', data: owner.terminal.output }));
    const onData = (data) => {
      if (owner.ws === ws) ws.send(JSON.stringify({ type: 'output', data }));
    };
    owner.terminal.on('data', onData);
    ws.on('message', (message) => {
      try {
        if (owner.revoking || !this.takeoverController.validateToken(agentId, takeoverToken)) return ws.close();
        const frame = JSON.parse(String(message));
        if (frame.type === 'input') owner.terminal.write(frame.data);
        else if (frame.type === 'resize') owner.terminal.resize(frame.cols, frame.rows);
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', data: error.message }));
      }
    });
    const detach = () => {
      this.wsClients.delete(ws);
      owner.terminal.off('data', onData);
      if (owner.ws === ws) owner.ws = null;
    };
    ws.on('close', detach);
    ws.on('error', detach);
  }

  async stop() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const ws of this.wsClients) {
      try {
        ws.close();
      } catch (_) {}
    }
    this.wsClients.clear();

    for (const owner of this.agentTerminals.values()) await owner.terminal.terminateTree();
    this.agentTerminals.clear();

    await Promise.all([...this.commandJobs.values()].filter((job) => job.processAlive).map((job) => this.terminateCommandJob(job, 'server stopped')));

    if (this.ptyManager) {
      this.ptyManager.killAll();
    }

    for (const client of this.sseClients) {
      try {
        client.end();
      } catch (_) {}
    }
    this.sseClients.clear();

    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer.close(() => resolve());
      });
    }
  }

  terminateCommandJob(job, reason = 'cancelled') {
    if (!job.child || !job.processAlive) return Promise.resolve();
    job.status = reason === 'cancelled' ? 'cancelling' : 'failed';
    job.error = reason === 'cancelled' ? undefined : reason;
    if (job.terminationPromise) return job.terminationPromise;
    job.terminationPromise = new Promise((resolve) => {
      let settled = false;
      let killTimer;
      const finish = () => {
        job.processAlive = false;
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      job.child.once('exit', finish);
      job.child.once('close', finish);
      killTimer = setTimeout(() => {
        if (job.processAlive) {
          try { if (job.child.pid && process.platform !== 'win32') process.kill(-job.child.pid, 'SIGKILL'); else job.child.kill('SIGKILL'); }
          catch (_) { try { job.child.kill('SIGKILL'); } catch (_) {} }
        }
      }, 150);
      try { if (job.child.pid && process.platform !== 'win32') process.kill(-job.child.pid, 'SIGTERM'); else job.child.kill('SIGTERM'); }
      catch (_) { try { job.child.kill('SIGTERM'); } catch (_) {} }
    });
    return job.terminationPromise;
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.broadcastEvent('ping', { timestamp: new Date().toISOString() });
    }, 15000);
  }

  isSameOrigin(req) {
    if (!req.headers.origin) return true;
    try {
      const origin = new URL(req.headers.origin);
      return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
    } catch (_) {
      return false;
    }
  }

  beginHumanTurn(agentId) {
    this.humanTurns.set(agentId, (this.humanTurns.get(agentId) || 0) + 1);
  }

  endHumanTurn(agentId) {
    const remaining = (this.humanTurns.get(agentId) || 1) - 1;
    if (remaining) this.humanTurns.set(agentId, remaining);
    else this.humanTurns.delete(agentId);
  }

  broadcastEvent(eventType, data) {
    this.cursorCounter++;
    const eventData = { project_id: this.activeProjectId || this.projectId || null, ...data };
    const payload = `id: ${this.cursorCounter}\nevent: ${eventType}\ndata: ${JSON.stringify(eventData)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch (_) {
        this.sseClients.delete(client);
      }
    }
  }

  async handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (!this.isSameOrigin(req)) return this.jsonResponse(res, 403, { error: 'Cross-origin request rejected' });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, POST, OPTIONS' });
      res.end();
      return;
    }

    // API Routes
    if (pathname.startsWith('/api/v1/')) {
      return this.handleApi(pathname, req, res, parsedUrl);
    }

    // Static Assets
    return this.handleStatic(pathname, res);
  }

  async handleApi(pathname, req, res, parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)) {
    const method = req.method;

    if (pathname === '/api/v1/health' && method === 'GET') return this.jsonResponse(res, 200, {
      status: 'ok', host: this.host, port: this.httpServer?.address()?.port || this.port,
      project_id: this.activeProjectId || this.projectId || null, repo_path: this.repoPath,
      scheduler: { running: this.scheduler.activeCount || 0, max_concurrency: this.scheduler.maxConcurrency || 4, paused: this.schedulerPausedProjects.has(this.activeProjectId || this.projectId) },
      sse_clients: this.sseClients.size, active_ptys: this.agentTerminals ? this.agentTerminals.size : 0,
      uptime_sec: Math.floor(process.uptime())
    });

    if (pathname === '/api/v1/git/status' && method === 'GET') {
      const repoPath = this.repoPath;
      const projectId = this.activeProjectId || this.projectId || null;
      const result = await this.repoDataService.execCommand('git', ['status', '--porcelain=v1', '-b', '-z'], { cwd: repoPath });
      if (result.error) return this.jsonResponse(res, 422, { error: result.stderr || result.error.message });
      const entries = result.stdout.split('\0').filter(Boolean);
      const branchLine = entries.shift() || '';
      const branch = branchLine.replace(/^##\s+/, '').split('...')[0];
      const files = [];
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const status = entry.slice(0, 2).trim() || '??';
        const file = { path: entry.slice(3), indexStatus: entry[0], workingTreeStatus: entry[1], status };
        if (/[RC]/.test(status) && entries[index + 1]) file.originalPath = entries[++index];
        files.push(file);
      }
      return this.jsonResponse(res, 200, { branch, files, clean: files.length === 0, project_id: projectId });
    }

    if (pathname === '/api/v1/git/diff' && method === 'GET') {
      const repoPath = this.repoPath;
      const projectId = this.activeProjectId || this.projectId || null;
      const filePath = parsedUrl.searchParams.get('path');
      const view = parsedUrl.searchParams.get('view') || 'working';
      if (!['working', 'staged'].includes(view)) return this.jsonResponse(res, 400, { error: 'view must be working or staged' });
      const root = fs.realpathSync(repoPath);
      let safePath = null;
      if (filePath) {
        if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..')) return this.jsonResponse(res, 400, { error: 'path must stay inside the repository' });
        const target = path.resolve(root, filePath);
        const parent = path.dirname(target);
        let canonicalParent;
        try { canonicalParent = fs.realpathSync(parent); } catch (_) { canonicalParent = parent; }
        if (canonicalParent !== root && !canonicalParent.startsWith(root + path.sep)) return this.jsonResponse(res, 400, { error: 'path must stay inside the repository' });
        safePath = path.relative(root, path.join(canonicalParent, path.basename(target)));
      }
      const args = ['diff', ...(view === 'staged' ? ['--staged'] : []), '--', ...(safePath ? [safePath] : [])];
      const result = await this.repoDataService.execCommand('git', args, { cwd: repoPath });
      if (result.error) return this.jsonResponse(res, 422, { error: result.stderr || result.error.message });
      let raw = result.stdout || '';
      if (safePath && view === 'working' && !raw) {
        const status = await this.repoDataService.execCommand('git', ['status', '--porcelain', '--', safePath], { cwd: repoPath });
        if ((status.stdout || '').startsWith('??')) {
          const absolute = path.join(root, safePath);
          try {
            const stat = fs.lstatSync(absolute);
            const canonical = fs.realpathSync(absolute);
            if (stat.isSymbolicLink() || (canonical !== root && !canonical.startsWith(root + path.sep))) {
              raw = `Skipped untracked symlink or out-of-repository file: ${safePath}`;
              return this.jsonResponse(res, 200, { path: filePath || null, view, diff: raw, truncated: false, project_id: projectId });
            }
            if (!stat.isFile()) {
              raw = `Skipped non-regular file: ${safePath}`;
              return this.jsonResponse(res, 200, { path: filePath || null, view, diff: raw, truncated: false, project_id: projectId });
            }
            if (stat.size > 65536) {
              raw = `Skipped untracked file larger than 64 KB: ${safePath}`;
              return this.jsonResponse(res, 200, { path: filePath || null, view, diff: raw, truncated: false, project_id: projectId });
            }
            const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            let contents;
            try {
              const opened = fs.fstatSync(fd);
              if (!opened.isFile() || opened.size > 65536) throw new Error('File changed or exceeded the 64 KB limit');
              const buffer = Buffer.alloc(Math.min(opened.size, 65536));
              const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
              contents = buffer.subarray(0, bytes).toString('utf8');
            } finally { fs.closeSync(fd); }
            const lines = contents.split(/\r?\n/);
            raw = [`diff --git a/${safePath} b/${safePath}`, 'new file mode 100644', '--- /dev/null', `+++ b/${safePath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');
          } catch (_) {}
        }
      }
      return this.jsonResponse(res, 200, { path: filePath || null, view, diff: raw.slice(0, 200 * 1024), truncated: raw.length > 200 * 1024, project_id: projectId });
    }

    if (pathname === '/api/v1/context' && method === 'GET') {
      const repoPath = this.repoPath;
      const projectId = this.activeProjectId || this.projectId || null;
      const kind = parsedUrl.searchParams.get('kind');
      if (!['files', 'branches', 'docs'].includes(kind)) return this.jsonResponse(res, 400, { error: 'kind must be files, branches, or docs' });
      if (kind === 'files') {
        const result = await this.repoDataService.execCommand('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoPath });
        const files = result.error ? [] : result.stdout.split('\0').filter(Boolean).slice(0, 200);
        return this.jsonResponse(res, 200, { files, truncated: !result.error && result.stdout.split('\0').filter(Boolean).length > 200, project_id: projectId });
      }
      if (kind === 'branches') {
        const result = await this.repoDataService.execCommand('git', ['branch', '--format=%(refname:short)%00%(HEAD)'], { cwd: repoPath });
        const branches = result.error ? [] : result.stdout.split(/\r?\n/).filter(Boolean).map((line) => { const [name, head] = line.split('\0'); return { name, current: head === '*' }; });
        return this.jsonResponse(res, 200, { branches, current: branches.find((branch) => branch.current)?.name || null, project_id: projectId });
      }
      const root = fs.realpathSync(repoPath);
      const candidates = ['AGENTS.md', 'README.md'];
      const docsDir = path.join(root, 'docs');
      if (fs.existsSync(docsDir)) for (const name of fs.readdirSync(docsDir)) if (name.endsWith('.md')) candidates.push(path.join('docs', name));
      const docs = [];
      for (const name of candidates.slice(0, 200)) {
        const full = path.join(root, name);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
        const canonical = fs.realpathSync(full);
        if (!canonical.startsWith(root + path.sep)) continue;
        let handle;
        try {
          handle = await fs.promises.open(canonical, 'r');
          const buffer = Buffer.alloc(2048);
          const { bytesRead } = await handle.read(buffer, 0, 2048, 0);
          docs.push({ path: name, snippet: buffer.subarray(0, bytesRead).toString('utf8').slice(0, 500).replace(/\0/g, '') });
        } finally { if (handle) await handle.close(); }
      }
      return this.jsonResponse(res, 200, { docs, project_id: projectId });
    }

    if (pathname === '/api/v1/state' && method === 'GET') {
      const collection = parsedUrl.searchParams.get('collection');
      if (!['projects', 'agents', 'tasks', 'sessions', 'jobs'].includes(collection)) return this.jsonResponse(res, 400, { error: 'Invalid state collection' });
      const projectId = this.activeProjectId || this.projectId;
      let items = [];
      if (collection === 'projects') items = this.workspace ? await this.workspace.listProjects() : [];
      if (collection === 'agents') items = this.workspace && projectId ? await this.workspace.listAgents(projectId) : [];
      if (collection === 'tasks') { const combined = [...await this.repoDataService.getBacklogTasks(), ...this.readProjectCollection(projectId, 'tasks')]; const byId = new Map(); for (const task of combined) { const old = byId.get(task.id); if (!old || String(task.updated_at || task.created_at || '') >= String(old.updated_at || old.created_at || '')) byId.set(task.id, task); } items = [...byId.values()]; }
      if (collection === 'jobs') items = [...this.commandJobs.values()].filter((job) => job.project_id === projectId).map(({ child, ...job }) => job);
      if (collection === 'sessions') {
        items = [...(this.chatService.sessionCache || new Map()).entries()].filter(([key]) => key.startsWith(`${projectId}@`) || key.startsWith(`${projectId}:`)).map(([key, value]) => ({ key, provider: value.provider, session_id: value.sessionId, source: 'memory' }));
        if (this.workspace && projectId) {
          const { DatabaseSync } = require('node:sqlite');
          const dbPath = path.join(this.workspace.baseDir, 'projects', projectId, 'agentcrew.db');
          if (fs.existsSync(dbPath)) {
            const db = new DatabaseSync(dbPath);
            try {
              const hasConversations = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_conversations'").get();
              if (hasConversations) items.push(...db.prepare('SELECT agent_id, provider, session_id, updated_at FROM provider_conversations WHERE project_id = ?').all(projectId).map((row) => ({ ...row, source: 'persisted' })));
              items.push(...db.prepare('SELECT id, agent_id, task_id, status, created_at FROM sessions WHERE project_id = ?').all(projectId).map((row) => ({ ...row, source: 'workspace' })));
            } finally { db.close(); }
          }
        }
      }
      items = items.map((item) => { const { takeover_token, token, secret, ...safe } = item; return safe; });
      return this.jsonResponse(res, 200, { collection, items, project_id: projectId || null });
    }

    if (pathname === '/api/v1/command-catalog' && method === 'GET') return this.jsonResponse(res, 200, { commands: this.getCommandCatalog() });
    if (pathname === '/api/v1/preferences' && method === 'GET') {
      const projectId = this.activeProjectId || this.projectId || 'default';
      const file = path.join(this.workspace?.baseDir || path.join(process.cwd(), '.agentcrew'), 'preferences', `${projectId}.json`);
      let preferences = this.preferences.get(projectId) || {};
      try { if (fs.existsSync(file)) preferences = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      this.preferences.set(projectId, preferences);
      return this.jsonResponse(res, 200, { preferences });
    }

    if (pathname === '/api/v1/workspace' && method === 'GET') {
      const agents = this.workspace && this.projectId ? await this.workspace.listAgents(this.projectId) : [];
      return this.jsonResponse(res, 200, {
        workspace: { id: this.projectId || 'ws-default', name: this.projectName || 'AgentCrew Workspace' },
        agents,
        active_turn_limit: 4,
        public_http_warning: !['127.0.0.1', '::1', 'localhost'].includes(this.host),
      });
    }

    if (pathname === '/api/v1/team-presets' && method === 'GET') {
      const { TEAM_PRESETS } = require('../workspace/team-presets');
      return this.jsonResponse(res, 200, { presets: Object.values(TEAM_PRESETS) });
    }

    if (pathname === '/api/v1/fs/browse' && method === 'GET') {
      const requestedDir = parsedUrl.searchParams.get('dir') || process.env.HOME || process.cwd();
      try {
        const resolved = path.resolve(requestedDir);
        if (!fs.existsSync(resolved)) {
          return this.jsonResponse(res, 404, { error: `Directory does not exist: ${requestedDir}` });
        }
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
          return this.jsonResponse(res, 400, { error: 'Path is not a directory' });
        }
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const directories = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => ({
            name: e.name,
            path: path.join(resolved, e.name),
            is_git_repo: fs.existsSync(path.join(resolved, e.name, '.git'))
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        const parent = path.dirname(resolved) !== resolved ? path.dirname(resolved) : null;
        return this.jsonResponse(res, 200, {
          current: resolved,
          parent,
          is_git_repo: fs.existsSync(path.join(resolved, '.git')),
          directories
        });
      } catch (err) {
        return this.jsonResponse(res, 500, { error: err.message });
      }
    }

    if (pathname === '/api/v1/fs/mkdir' && method === 'POST') {
      if (req.headers['content-type'] && !req.headers['content-type'].includes('application/json')) {
        return this.jsonResponse(res, 415, { error: 'Content-Type must be application/json' });
      }
      try {
        const body = await this.readJsonBody(req);
        if (!body.path || typeof body.path !== 'string') {
          return this.jsonResponse(res, 400, { error: 'path is required' });
        }
        const resolved = path.resolve(body.path);
        fs.mkdirSync(resolved, { recursive: true });
        let gitInitialized = false;
        if (body.init_git || !fs.existsSync(path.join(resolved, '.git'))) {
          const { spawnSync } = require('node:child_process');
          const gitRes = spawnSync('git', ['init'], { cwd: resolved, stdio: 'ignore' });
          gitInitialized = gitRes.status === 0;
        }
        return this.jsonResponse(res, 200, {
          status: 'ok',
          path: resolved,
          git_initialized: gitInitialized
        });
      } catch (err) {
        return this.jsonResponse(res, 400, { error: err.message });
      }
    }

    if (pathname === '/api/v1/projects' && method === 'GET') {
      const projects = this.workspace ? await this.workspace.listProjects() : [];
      return this.jsonResponse(res, 200, { projects });
    }

    if (pathname === '/api/v1/projects' && method === 'POST') {
      if (req.headers['content-type'] && !req.headers['content-type'].includes('application/json')) {
        return this.jsonResponse(res, 415, { error: 'Content-Type must be application/json' });
      }
      try {
        const body = await this.readJsonBody(req);
        if (!this.workspace) {
          return this.jsonResponse(res, 500, { error: 'Workspace manager not initialized' });
        }
        const project = await this.workspace.registerProject(body);
        return this.jsonResponse(res, 201, { project });
      } catch (err) {
        return this.jsonResponse(res, err.statusCode || 400, { error: err.message });
      }
    }

    const activateMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/activate$/);
    if (activateMatch && method === 'POST') {
      const targetId = activateMatch[1];
      const activationBody = method === 'POST' ? await this.readJsonBody(req).catch(() => ({})) : {};
      const force = activationBody.force === true || activationBody.force === 'true' || ['1', 'true'].includes((parsedUrl.searchParams.get('force') || '').toLowerCase());
      const currentProjectId = this.activeProjectId || this.projectId;
      if (this.projectSwitching || this._activatingProject) return this.jsonResponse(res, 409, { status: 'error', code: 'PROJECT_BUSY', error: 'A project activation is already in progress' });
      const activeTurnKeys = [...(this.chatService?.activeTurns || new Map()).keys()].filter((key) => key.startsWith(`${currentProjectId}@`));
      const queuedTurnKeys = (this.scheduler?.queue || []).filter((turn) => turn.agentId?.startsWith(`${currentProjectId}:`));
      const scheduledActiveKeys = [...(this.scheduler?.activeByAgent || new Map()).keys()].filter((key) => key.startsWith(`${currentProjectId}:`));
      const pendingDispatches = [...(this.pendingRoomDispatches || new Set())].filter((d) => d.projectId === currentProjectId && !d.cancelled);
      const ownedAgents = [...(this.takeoverController?.sessions || new Map()).entries()].filter(([, session]) => session.state === 'human_owned').map(([agentId]) => agentId);
      const projectBusy = this.inFlightMutations > 0 || [...(this.agentTerminals || new Map()).values()].some((owner) => !owner.projectId || owner.projectId === currentProjectId) || [...(this.ptyOwners || new Map()).values()].some((owner) => !owner.projectId || owner.projectId === currentProjectId) || [...(this.commandJobs || new Map()).values()].some((job) => job.project_id === currentProjectId && job.processAlive) || activeTurnKeys.length > 0 || queuedTurnKeys.length > 0 || scheduledActiveKeys.length > 0 || pendingDispatches.length > 0 || ownedAgents.length > 0;
      if (this.inFlightMutations > 0 || (!force && projectBusy)) return this.jsonResponse(res, 409, { status: 'error', code: 'PROJECT_BUSY', error: 'Current project has active work' });
      this._activatingProject = targetId;
      this.projectSwitching = true;
      try {
        if (!this.workspace) {
          return this.jsonResponse(res, 500, { error: 'Workspace manager not initialized' });
        }
        if (force && currentProjectId) {
          for (const d of pendingDispatches) d.cancelled = true;
          for (const [agentId, owner] of [...this.agentTerminals]) {
            if (owner.projectId && owner.projectId !== currentProjectId) continue;
            if (!await owner.terminal.terminateTree().catch(() => false)) throw Object.assign(new Error(`Could not stop agent terminal for ${agentId}`), { statusCode: 409, code: 'PROJECT_BUSY' });
            owner.ws?.close(); this.agentTerminals.delete(agentId);
          }
          for (const [sessionId, owner] of [...this.ptyOwners]) {
            if (owner.projectId && owner.projectId !== currentProjectId) continue;
            if (!await owner.ptySession.terminateTree().catch(() => false)) throw Object.assign(new Error(`Could not stop PTY session ${sessionId}`), { statusCode: 409, code: 'PROJECT_BUSY' });
            owner.ws?.close(); this.ptyOwners.delete(sessionId);
          }
          for (const job of this.commandJobs.values()) if (job.project_id === currentProjectId && job.processAlive) {
            await this.terminateCommandJob(job, 'Project activation forced');
            if (job.processAlive) throw Object.assign(new Error('Could not stop active command job'), { statusCode: 409, code: 'PROJECT_BUSY' });
          }
          const roster = await this.workspace.listAgents(currentProjectId);
          for (const agent of roster) {
            const schedulerAgentId = `${currentProjectId}:${agent.name}`;
            this.scheduler?.cancelQueuedForAgent?.(schedulerAgentId);
            if (activeTurnKeys.some((key) => key.endsWith(`:${agent.name}`)) || scheduledActiveKeys.includes(schedulerAgentId) || pendingDispatches.some((d) => d.agentId === agent.name)) {
              let stopped;
              try { stopped = await this.chatService.quiesceAgent(agent.name, { projectId: currentProjectId, timeoutMs: 10000 }); }
              finally { this.scheduler?.releaseAgent(schedulerAgentId); }
              if (!stopped?.quiescent) throw Object.assign(new Error(`Could not stop active turn for ${agent.name}`), { statusCode: 409, code: 'PROJECT_BUSY' });
            }
            if (this.takeoverController.getState(agent.name) === 'human_owned') {
              try { await this.takeoverController.release({ agentId: agent.name, guidance: 'Released for forced project switch' }); } catch (_) {}
              this.chatService.resumeAgent(agent.name, { projectId: currentProjectId });
              this.teamRoom.updateAgentState(agent.name, { state: 'idle', activeTaskId: null });
            }
          }
        }
        const project = await this.workspace.activateProject(targetId);
        this.projectId = project.id;
        this.activeProjectId = project.id;
        this.projectName = project.name;
        this.repoPath = project.path;
        this.repoDataService.setRepoRoot(project.path);
        this.ptyManager.cwd = project.path;
        if (this.chatService) {
          this.chatService.projectId = project.id;
          this.chatService.repoPath = project.path;
        }
        this.broadcastEvent('project.activated', { project, project_id: project.id });
        return this.jsonResponse(res, 200, { success: true, project });
      } catch (err) {
        return this.jsonResponse(res, err.statusCode || 400, { error: err.message });
      } finally { this.projectSwitching = false; this._activatingProject = null; }
    }

    if (pathname === '/api/v1/room/messages' && method === 'GET') {
      const channel = parsedUrl.searchParams.get('channel') || 'team-activity';
      const requestedProjectId = parsedUrl.searchParams.get('project_id');
      const projectId = requestedProjectId || this.activeProjectId || this.projectId;
      const messages = this.workspace && projectId === (this.activeProjectId || this.projectId)
        ? await this.workspace.listRoomMessages(projectId, { channel }) : [];
      const cutoff = this.sessionViewCutoffs;
      const persistedCutoffs = this.readProjectCollection(projectId, 'cutoffs');
      const persistedSqlCutoffs = [];
      if (this.workspace && projectId) {
        try {
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(path.join(this.workspace.baseDir, 'projects', projectId, 'agentcrew.db'), { readOnly: true });
          try {
            const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_view_cutoffs'").get();
            if (exists) persistedSqlCutoffs.push(...db.prepare('SELECT agent_id, cutoff_at FROM session_view_cutoffs WHERE project_id = ?').all(projectId));
          } finally { db.close(); }
        } catch (_) {}
      }
      const includeCleared = parsedUrl.searchParams.get('include_cleared') === '1';
      const visible = includeCleared ? messages : messages.filter((message) => {
        const identities = [message.sender_name, message.sender_id, message.metadata?.target_agent].filter(Boolean);
        const matching = [...identities.flatMap((agentId) => [cutoff.get(`${projectId}:${channel}:${agentId}`), cutoff.get(`${projectId}:*:${agentId}`)]), cutoff.get(`${projectId}:${channel}:*`), cutoff.get(`${projectId}:*:*`), ...persistedCutoffs.filter((item) => identities.includes(item.agent_id) || (item.agent_id === '*' && (!item.channel || item.channel === '*' || item.channel === channel))).map((item) => item.cutoff_at || item.at), ...persistedSqlCutoffs.filter((item) => identities.includes(item.agent_id) || item.agent_id === '*').map((item) => item.cutoff_at)];
        const at = matching.filter(Boolean).sort().at(-1);
        return !at || message.created_at > at;
      });
      return this.jsonResponse(res, 200, { messages: visible });
    }

    if (pathname === '/api/v1/room/messages' && method === 'POST') {
      const entryProjectId = this.activeProjectId || this.projectId;
      let mutationAdmitted = false;
      try {
        const body = await this.readJsonBody(req);
        if (this.rejectProjectAdmission(res, entryProjectId)) return;
        this.inFlightMutations++;
        mutationAdmitted = true;
        const messageProjectId = entryProjectId;
        const messageRepoPath = this.repoPath;
        if (!this.workspace || !messageProjectId) {
          return this.jsonResponse(res, 400, { error: 'No active project' });
        }
        const message = await this.workspace.addRoomMessage(messageProjectId, {
          channel: body.channel || 'team-activity',
          senderType: 'human',
          senderId: body.sender_id || 'operator',
          senderName: body.sender_name || 'Operator',
          text: body.text,
          metadata: body.metadata || null
        });
        this.broadcastEvent('room.message', { ...message, project_id: messageProjectId });

        const agents = this.chatService ? await this.workspace.listAgents(messageProjectId) : [];
        const normalize = (value) => String(value || '').trim().toLowerCase();
        const rosterNames = [...agents].sort((a, b) => Math.max(b.name.length, b.id.length) - Math.max(a.name.length, a.id.length));
        const mentionMatches = [];
        const sourceText = String(body.text || '');
        for (const match of sourceText.matchAll(/@/g)) {
          const tail = sourceText.slice(match.index + 1).toLowerCase();
          let alias = null;
          const target = rosterNames.find((agent) => (alias = [agent.name, agent.id].find((value) => tail.startsWith(String(value).toLowerCase()) && (!tail[String(value).length] || !/[\w.-]/.test(tail[String(value).length])))) != null);
          if (target) mentionMatches.push({ target, token: sourceText.slice(match.index, match.index + 1 + alias.length) });
        }
        const targets = mentionMatches.length
          ? mentionMatches.map((match) => match.target)
          : [agents.find((agent) => normalize(agent.name) === normalize(body.metadata?.target_agent) || normalize(agent.id) === normalize(body.metadata?.target_agent))].filter(Boolean);
        const uniqueTargets = [...new Map(targets.map((agent) => [agent.id, agent])).values()];
        let dispatch = { dispatched: false, reason: 'No matching target agent' };
        if (this.schedulerPausedProjects.has(messageProjectId)) dispatch = { dispatched: false, reason: 'Scheduler is paused' };
        else if (uniqueTargets.length && this.chatService) {
          dispatch = { dispatched: true };
          this.pendingRoomDispatches ||= new Set();
          for (const targetAgent of uniqueTargets) {
            const pendingEntry = { projectId: messageProjectId, agentId: targetAgent.name, cancelled: false };
            this.pendingRoomDispatches.add(pendingEntry);
            setImmediate(async () => {
              let thinkingStarted = false;
              try {
                if (pendingEntry.cancelled || this.projectSwitching || (this.activeProjectId || this.projectId) !== messageProjectId || this.schedulerPausedProjects.has(messageProjectId)) return;
                thinkingStarted = true;
                this.broadcastEvent('agent.thinking_started', { agent_id: targetAgent.name, project_id: messageProjectId });
                const prompt = mentionMatches.reduce((text, mention) => text.replace(mention.token, ''), String(body.text || '')).trim() || 'Please follow up on the team discussion.';
                const answer = await this.chatService.generateResponse(targetAgent.name, prompt, { projectId: messageProjectId, repoPath: messageRepoPath, onDelta: (delta) => this.broadcastEvent('agent.delta', { agent_id: targetAgent.name, delta, project_id: messageProjectId }) });
                if (pendingEntry.cancelled || (this.activeProjectId || this.projectId) !== messageProjectId) return;
                const replyMessage = await this.workspace.addRoomMessage(messageProjectId, { channel: body.channel || 'team-activity', senderType: 'agent', senderId: targetAgent.id, senderName: targetAgent.name, text: answer, metadata: { in_reply_to: message.id, agent_role: targetAgent.role } });
                this.broadcastEvent('room.message', { ...replyMessage, project_id: messageProjectId });
              } catch (err) {
                if (!pendingEntry.cancelled) {
                  const errorMessage = await this.workspace.addRoomMessage(messageProjectId, { channel: body.channel || 'team-activity', senderType: 'system', senderId: 'system', senderName: 'System', text: `Failed to dispatch turn to ${targetAgent.name}: ${err.message}`, metadata: { error: true } });
                  this.broadcastEvent('room.message', { ...errorMessage, project_id: messageProjectId });
                }
              } finally {
                this.pendingRoomDispatches.delete(pendingEntry);
                if (thinkingStarted) this.broadcastEvent('agent.thinking_ended', { agent_id: targetAgent.name, project_id: messageProjectId });
              }
            });
          }
        }

        return this.jsonResponse(res, 201, { message, ...dispatch });
      } catch (err) {
        return this.jsonResponse(res, err.statusCode || 400, { error: err.message });
      } finally { if (mutationAdmitted) this.inFlightMutations--; }
    }

    if (pathname === '/api/v1/readiness' && method === 'GET') {
      const currentProjectId = this.activeProjectId || this.projectId;
      const readiness = this.workspace && currentProjectId
        ? await this.workspace.checkReadiness(currentProjectId)
        : { databaseReady: true, rosterCount: 13 };
      const providers = await this.chatService.probeProviders();
      const agents = this.workspace && currentProjectId ? await this.workspace.listAgents(currentProjectId) : [];
      for (const provider of providers) {
        provider.agents = agents.filter((agent) => agent.provider === provider.name).map((agent) => agent.name);
      }
      const unavailableAssignments = providers.filter((provider) => provider.agents.length && !provider.available);
      return this.jsonResponse(res, 200, {
        status: unavailableAssignments.length ? 'blocked' : 'ready',
        readiness,
        available_providers: providers.filter((provider) => provider.available).map((provider) => provider.name),
        qualified_providers: [],
        providers
      });
    }

    if (pathname === '/api/v1/settings' && method === 'GET') {
      return this.jsonResponse(res, 200, {
        concurrency_ceiling: 4,
        takeover_budget_ms: 10000,
        allowed_providers: ['agy', 'codex', 'gemini'],
        integration_strategy: 'iteration_branch',
        human_merge_required: true
      });
    }

    if (pathname === '/api/v1/agents' && method === 'GET') {
      const currentProjectId = this.activeProjectId || this.projectId;
      const agents = this.workspace && currentProjectId ? await this.workspace.listAgents(currentProjectId) : [];
      const providerReports = await this.chatService.probeProviders();
      const providerAvailable = new Map(providerReports.map((report) => [report.name, report.available]));
      const stations = this.teamRoom.getStations();
      const enriched = agents.map((agent, idx) => {
        const station = stations[idx] || null;
        const liveState = this.teamRoom.getAgentState(agent.name) || { state: 'idle', activeTaskId: null };
        return {
          ...agent,
          provider_status: providerAvailable.get(agent.provider) ? 'cli_detected' : 'disconnected',
          active_provider: providerAvailable.get(agent.provider) ? agent.provider
            : agent.backup_provider && providerAvailable.get(agent.backup_provider) ? agent.backup_provider : null,
          station: station ? station.grid_position : null,
          state: liveState.state || 'idle',
          active_task_id: liveState.activeTaskId || null,
          activity_badge: liveState.state === 'takeover' ? 'needs-you' : (liveState.state || 'idle')
        };
      });
      return this.jsonResponse(res, 200, { agents: enriched });
    }

    if ((pathname === '/api/v1/ideas' || pathname === '/api/v1/snippets') && method === 'GET') {
      const projectId = this.activeProjectId || this.projectId || 'default';
      const kind = pathname.endsWith('/ideas') ? 'ideas' : 'snippets';
      return this.jsonResponse(res, 200, { [kind]: this.readProjectCollection(projectId, kind), project_id: projectId });
    }

    if (pathname === '/api/v1/diagnostics' && method === 'GET') {
      const projectId = this.activeProjectId || this.projectId;
      const jobs = [...this.commandJobs.values()].filter((job) => job.project_id === projectId).slice(-20).map(({ child, output, ...job }) => job);
      const agents = this.workspace && projectId ? await this.workspace.listAgents(projectId) : [];
      const counts = agents.reduce((out, agent) => { out[agent.status || 'idle'] = (out[agent.status || 'idle'] || 0) + 1; return out; }, {});
      return this.jsonResponse(res, 200, { health: { status: 'ok', uptime_sec: Math.floor((Date.now() - this.startedAt) / 1000) }, project_id: projectId, config: { host: this.host, port: this.port, repo_path: '[redacted]', providers_enabled: this.liveProviders }, command_jobs: jobs, agent_status_counts: counts });
    }

    if (pathname === '/api/v1/tasks' && method === 'GET') {
      const popupTasks = Array.from(this.popupEngine.popups.values());
      const tasks = await this.repoDataService.getBacklogTasks(popupTasks);
      const projectId = this.activeProjectId || this.projectId || 'default';
      const byId = new Map(); for (const task of [...tasks, ...this.readProjectCollection(projectId, 'tasks')]) { const normalized = { ...task, stage: this.normalizeTaskStage(task.stage) }; const old = byId.get(normalized.id); if (!old || String(normalized.updated_at || normalized.created_at || '') >= String(old.updated_at || old.created_at || '')) byId.set(normalized.id, normalized); }
      return this.jsonResponse(res, 200, { tasks: [...byId.values()] });
    }

    if (pathname === '/api/v1/pull-requests' && method === 'GET') {
      const pullRequests = await this.repoDataService.getPullRequests();
      return this.jsonResponse(res, 200, { pullRequests });
    }

    if (pathname === '/api/v1/repositories' && method === 'GET') {
      const repositories = await this.repoDataService.getRepositories();
      return this.jsonResponse(res, 200, { repositories });
    }

    if (pathname === '/api/v1/analytics' && method === 'GET') {
      const analytics = await this.repoDataService.getAnalytics({
        scheduler: this.scheduler,
        popups: Array.from(this.popupEngine.popups.values())
      });
      return this.jsonResponse(res, 200, { analytics });
    }

    if (pathname === '/api/v1/popups' && method === 'GET') {
      return this.jsonResponse(res, 200, {
        popups: Array.from(this.popupEngine.popups.values())
      });
    }

    if (pathname === '/api/v1/metrics' && method === 'GET') {
      const delivery = this.observability.getDeliveryMetrics();
      const tasks = await this.repoDataService.getBacklogTasks();
      const completedTaskCount = tasks.filter((task) => task.stage === 'done').length;
      const metrics = {
        completed_task_count: completedTaskCount,
        cycle_time_minutes: this.observability.taskMetrics.length ? delivery.averageCycleTimeMs / 60000 : null,
        pass_rate: this.observability.taskMetrics.length ? delivery.qaPassRate : null
      };
      return this.jsonResponse(res, 200, { metrics });
    }

    if (pathname === '/api/v1/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ status: 'connected', cursor: this.cursorCounter, project_id: this.activeProjectId || this.projectId || null })}\n\n`);
      this.sseClients.add(res);

      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    if (pathname === '/api/v1/commands' && method === 'POST') {
      const entryProjectId = this.activeProjectId || this.projectId;
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) {
        return this.jsonResponse(res, 415, { error: 'application/json Content-Type required' });
      }
      const body = await this.readJsonBody(req);
      if (this.rejectProjectAdmission(res, entryProjectId)) return;
      return this.handleCommand(body, res, entryProjectId);
    }

    return this.jsonResponse(res, 404, { error: `Route not found: ${pathname}` });
  }

  rejectProjectAdmission(target, entryProjectId) {
    if (this.projectSwitching || (entryProjectId && (this.activeProjectId || this.projectId) !== entryProjectId)) {
      const payload = { status: 'error', code: 'PROJECT_SWITCH_IN_PROGRESS', error: 'Project switch in progress or active project changed' };
      if (typeof target?.writeHead === 'function') {
        this.jsonResponse(target, 409, payload);
      } else if (target?.write && target?.destroy) {
        target.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nProject switch in progress or active project changed');
        target.destroy();
      }
      return true;
    }
    return false;
  }

  async handleCommand(body, res, entryProjectId = this.activeProjectId || this.projectId) {
    if (this.rejectProjectAdmission(res, entryProjectId)) return;
    const commandProjectId = entryProjectId;
    const commandRepoPath = this.repoPath;
    if (body?.project_id && body.project_id !== commandProjectId) return this.jsonResponse(res, 409, { status: 'error', code: 'PROJECT_MISMATCH', error: 'Active project changed' });
    this.commandReceipts ||= new Map();
    if (!body || (!body.command_type && !body.action)) {
      return this.jsonResponse(res, 400, { error: 'Missing command_type or action in request body' });
    }

    const command_type = body.command_type || (body.action ? `session.${body.action}` : null);
    const payload = body.payload || body;
    const receiptKey = body?.idempotency_key ? `${commandProjectId}:${String(body.idempotency_key).slice(0, 200)}` : null;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ command: command_type, payload, projectId: commandProjectId })).digest('hex');
    this.commandInFlight ||= new Map();
    if (receiptKey && this.commandReceipts.has(receiptKey)) {
      const stored = this.commandReceipts.get(receiptKey);
      if (stored.fingerprint !== fingerprint) return this.jsonResponse(res, 409, { status: 'error', code: 'IDEMPOTENCY_CONFLICT', error: 'idempotency_key was already used for a different command' });
      return this.jsonResponse(res, 200, stored.receipt);
    }
    if (receiptKey && this.commandInFlight.has(receiptKey)) {
      const inFlight = this.commandInFlight.get(receiptKey);
      return this.jsonResponse(res, 409, { status: 'error', code: inFlight.fingerprint === fingerprint ? 'COMMAND_IN_PROGRESS' : 'IDEMPOTENCY_CONFLICT', error: inFlight.fingerprint === fingerprint ? 'An identical command is already in progress' : 'idempotency_key is in use for a different command' });
    }
    if (receiptKey) this.commandInFlight.set(receiptKey, { fingerprint });
    const commandId = `cmd-${Date.now()}`;
    const supportedCommands = new Set([
      'agent.provider_config', 'session.takeover', 'session.release', 'session.exec', 'session.command',
      'iteration.run', 'popup.propose', 'agent.ask', 'command.run', 'command.cancel',
      'agent.configure', 'specialist.hire', 'scheduler.pause', 'scheduler.resume', 'scheduler.run_next',
      'message.broadcast', 'session.clear_view', 'session.reset', 'preferences.update'
      , 'idea.save', 'idea.promote', 'snippet.save', 'snippet.delete', 'task.create', 'task.transition'
    ]);
    if (!supportedCommands.has(command_type)) {
      if (receiptKey) this.commandInFlight.delete(receiptKey);
      return this.jsonResponse(res, 400, {
        status: 'error', code: 'UNKNOWN_COMMAND', error: `Unsupported command_type: ${command_type}`
      });
    }

    this.inFlightMutations++;
    try {
      let result = null;

      if (command_type === 'idea.save') {
        const title = String(payload.title || '').trim(); if (!title) throw Object.assign(new Error('Idea title is required'), { statusCode: 400 });
        const idea = { id: crypto.randomUUID(), title: title.slice(0, 200), description: String(payload.description || '').slice(0, 10000), tags: Array.isArray(payload.tags) ? payload.tags.slice(0, 30) : [], created_at: new Date().toISOString(), project_id: commandProjectId };
        this.writeProjectCollection(commandProjectId, 'ideas', [...this.readProjectCollection(commandProjectId, 'ideas'), idea]); result = idea;
      } else if (command_type === 'idea.promote') {
        const ideas = this.readProjectCollection(commandProjectId, 'ideas'); const idea = ideas.find((item) => item.id === payload.id);
        if (!idea) throw Object.assign(new Error('Idea not found'), { statusCode: 404 });
        if (idea.promoted_task_id) throw Object.assign(new Error('Idea has already been promoted'), { statusCode: 409 });
        const task = { id: `task-${crypto.randomUUID()}`, title: idea.title, description: idea.description, stage: 'planning', created_at: new Date().toISOString(), project_id: commandProjectId };
        idea.promoted_task_id = task.id; this.writeProjectCollection(commandProjectId, 'ideas', ideas);
        this.writeProjectCollection(commandProjectId, 'tasks', [...this.readProjectCollection(commandProjectId, 'tasks'), task]);
        this.persistTaskFile(commandRepoPath, task); this.repoDataService.cache?.clear();
        this.persistTaskFile(commandRepoPath, task);
        result = task;
      } else if (command_type === 'snippet.save') {
        const title = String(payload.title || '').trim(); if (!title) throw Object.assign(new Error('Snippet title is required'), { statusCode: 400 });
        const snippets = this.readProjectCollection(commandProjectId, 'snippets'); const snippet = { id: payload.id || crypto.randomUUID(), title: title.slice(0, 200), content: String(payload.content || '').slice(0, 50000), kind: payload.kind === 'code' ? 'code' : 'prompt', created_at: new Date().toISOString(), project_id: commandProjectId };
        this.writeProjectCollection(commandProjectId, 'snippets', [...snippets.filter((item) => item.id !== snippet.id), snippet]); result = snippet;
      } else if (command_type === 'snippet.delete') {
        const snippets = this.readProjectCollection(commandProjectId, 'snippets'); const next = snippets.filter((item) => item.id !== payload.id);
        if (next.length === snippets.length) throw Object.assign(new Error('Snippet not found'), { statusCode: 404 });
        this.writeProjectCollection(commandProjectId, 'snippets', next); result = { id: payload.id, deleted: true };
      } else if (command_type === 'task.create') {
        const title = String(payload.title || '').trim(); const stages = ['backlog', 'planning', 'todo', 'in_progress', 'review', 'qa', 'done'];
        if (!title || (payload.stage && !stages.includes(payload.stage))) throw Object.assign(new Error('Valid task title and stage are required'), { statusCode: 400 });
        result = { id: `task-${crypto.randomUUID()}`, title: title.slice(0, 200), description: String(payload.description || '').slice(0, 10000), stage: this.normalizeTaskStage(payload.stage || 'planning'), created_at: new Date().toISOString(), project_id: commandProjectId };
        this.writeProjectCollection(commandProjectId, 'tasks', [...this.readProjectCollection(commandProjectId, 'tasks'), result]); this.persistTaskFile(commandRepoPath, result); this.repoDataService.cache?.clear();
      } else if (command_type === 'task.transition') {
        const stages = ['backlog', 'planning', 'todo', 'in_progress', 'review', 'qa', 'done'];
        if (!stages.includes(payload.stage)) throw Object.assign(new Error('Invalid task stage'), { statusCode: 400 });
        const nextStage = this.normalizeTaskStage(payload.stage);
        const tasks = this.readProjectCollection(commandProjectId, 'tasks'); const index = tasks.findIndex((task) => task.id === payload.id);
        const updated = index >= 0 ? { ...tasks[index], stage: nextStage, updated_at: new Date().toISOString() } : null;
        const fileTask = this.transitionTaskFile(commandRepoPath, payload.id, nextStage);
        if (!updated && !fileTask) throw Object.assign(new Error('Task not found'), { statusCode: 404 });
        if (updated) { tasks[index] = updated; this.writeProjectCollection(commandProjectId, 'tasks', tasks); }
        if (!fileTask && updated) this.persistTaskFile(commandRepoPath, updated);
        this.repoDataService.cache?.clear(); result = updated || { ...fileTask, stage: nextStage };
      } else if (command_type === 'command.run') {
        const catalog = this.getCommandCatalog(true);
        const entry = catalog.find((item) => item.id === payload.job_id);
        if (!entry) throw Object.assign(new Error('job_id is not in the active repository command catalog'), { statusCode: 400 });
        const runId = crypto.randomUUID();
        if ([...this.commandJobs.values()].filter((job) => job.processAlive).length >= 4) throw Object.assign(new Error('Command job capacity reached'), { statusCode: 429, code: 'COMMAND_CAPACITY' });
        const jobProjectId = commandProjectId || null;
        const jobRepoPath = commandRepoPath;
        const child = spawn(entry.executable, entry.args, { cwd: jobRepoPath, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        const job = { job_id: entry.id, run_id: runId, project_id: jobProjectId, repo_path: jobRepoPath, status: 'running', processAlive: true, output: '', exit_code: null, started_at: new Date().toISOString(), child };
        this.commandJobs.set(runId, job);
        this.broadcastEvent('command.started', { job_id: entry.id, run_id: runId, project_id: jobProjectId });
        const capture = (chunk) => {
          job.output = (job.output + chunk.toString()).slice(-200 * 1024);
          this.broadcastEvent('command.output', { job_id: entry.id, run_id: runId, output: chunk.toString(), project_id: jobProjectId });
        };
        child.stdout.on('data', capture); child.stderr.on('data', capture);
        child.once('exit', (code) => { job.processAlive = false; job.exit_code = code; });
        child.once('close', (code) => { job.processAlive = false; if (code !== null) job.exit_code = code; });
        const timeout = setTimeout(() => this.terminateCommandJob(job, 'Command timed out'), 30000);
        timeout.unref?.();
        child.on('error', (err) => {
          clearTimeout(timeout);
          job.status = 'failed'; job.error = err.message; job.completed_at = new Date().toISOString();
          delete job.child;
          this.broadcastEvent('command.completed', { job_id: entry.id, run_id: runId, status: 'failed', error: err.message, project_id: jobProjectId });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timeout);
          job.exit_code = code ?? null; job.signal = signal || null; job.status = job.status === 'cancelling' ? 'cancelled' : code === 0 ? 'completed' : 'failed'; job.completed_at = new Date().toISOString(); delete job.child;
          this.broadcastEvent('command.completed', { job_id: entry.id, run_id: runId, status: job.status, exit_code: job.exit_code, signal: job.signal, project_id: jobProjectId });
        });
        while ([...this.commandJobs.values()].filter((job) => job.status !== 'running' && !job.child).length > 50) {
          const oldest = [...this.commandJobs.entries()].find(([, job]) => job.status !== 'running' && !job.child);
          if (!oldest) break; this.commandJobs.delete(oldest[0]);
        }
        result = { job_id: entry.id, run_id: runId, status: job.status, output: job.output, exit_code: job.exit_code };
      } else if (command_type === 'command.cancel') {
        const job = this.commandJobs.get(payload.run_id);
        if (!job || !job.child) throw Object.assign(new Error('Running command job not found'), { statusCode: 404 });
        if (job.project_id !== commandProjectId) throw Object.assign(new Error('Command job not found'), { statusCode: 404 });
        await this.terminateCommandJob(job); result = { run_id: payload.run_id, status: job.status };
      } else if (command_type === 'agent.provider_config' || command_type === 'agent.configure') {
        if (!this.workspace || !commandProjectId) throw Object.assign(new Error('Workspace is unavailable'), { statusCode: 503 });
        const agentId = (await this.chatService.resolveAgent(payload.agent_id, { projectId: commandProjectId })).name;
        const activeTurn = [...(this.chatService.activeTurns || new Map()).keys()].some((key) => key.startsWith(`${commandProjectId}@`) && key.endsWith(`:${agentId}`));
        if (this.takeoverController?.getState?.(agentId) === 'human_owned' || activeTurn) throw Object.assign(new Error('Agent has active work in progress'), { statusCode: 409, code: 'AGENT_ACTIVE' });
        if (command_type === 'agent.configure') {
          const { DatabaseSync } = require('node:sqlite');
          const dbPath = path.join(this.workspace.baseDir, 'projects', commandProjectId, 'agentcrew.db');
          const db = new DatabaseSync(dbPath);
          try {
            const provider = payload.provider;
            const model = payload.model !== undefined ? payload.model : null;
            if (provider && !['agy', 'codex', 'gemini'].includes(provider)) throw Object.assign(new Error('Unsupported provider'), { statusCode: 400 });
            if (model && (typeof model !== 'string' || model.length > 120)) throw Object.assign(new Error('Invalid model'), { statusCode: 400 });
            db.prepare('UPDATE agents SET role = COALESCE(?, role), provider = COALESCE(?, provider), model = COALESCE(?, model) WHERE project_id = ? AND (id = ? OR name = ?)').run(payload.role || null, provider || null, model || null, commandProjectId, agentId, agentId);
          } finally { db.close(); }
          if (payload.backup_provider !== undefined || payload.backup_model !== undefined) {
            await this.workspace.setAgentProviderConfig(commandProjectId, agentId, {
              backupProvider: payload.backup_provider || null,
              backupModel: payload.backup_model || null,
            });
          }
          result = (await this.workspace.listAgents(commandProjectId)).find((agent) => agent.name === agentId);
          this.broadcastEvent('agent.updated', { agent: result, project_id: commandProjectId });
        } else {
          await this.workspace.setAgentProviderConfig(commandProjectId, agentId, { backupProvider: payload.backup_provider || null, backupModel: payload.backup_model || null });
          result = { agent_id: agentId, backup_provider: payload.backup_provider || null, backup_model: payload.backup_model || null };
          this.broadcastEvent('agent_provider_configured', result);
        }
      } else if (command_type === 'specialist.hire') {
        if (!this.workspace || !commandProjectId) throw Object.assign(new Error('Workspace is unavailable'), { statusCode: 503 });
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(path.join(this.workspace.baseDir, 'projects', commandProjectId, 'agentcrew.db'));
        const agent = { id: crypto.randomUUID(), project_id: commandProjectId, name: String(payload.name || '').trim(), role: String(payload.role || 'Specialist'), provider: payload.provider || 'codex', model: payload.model || '' };
        if (!agent.name || agent.name.length > 80 || !['agy', 'codex', 'gemini'].includes(agent.provider)) { db.close(); throw Object.assign(new Error('Valid name and provider are required'), { statusCode: 400 }); }
        try { db.prepare('INSERT INTO agents (id, project_id, name, role, provider, model, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(agent.id, agent.project_id, agent.name, agent.role, agent.provider, agent.model, 'avatar-specialist', new Date().toISOString()); } finally { db.close(); }
        result = agent; this.broadcastEvent('agent.updated', { agent, project_id: commandProjectId });
      } else if (command_type === 'scheduler.pause' || command_type === 'scheduler.resume') {
        const paused = command_type === 'scheduler.pause'; this.schedulerPaused = paused;
        if (paused) this.schedulerPausedProjects.add(commandProjectId); else this.schedulerPausedProjects.delete(commandProjectId);
        result = { paused, status: paused ? 'paused' : 'resumed', project_id: commandProjectId };
      } else if (command_type === 'scheduler.run_next') {
        if (this.schedulerPausedProjects.has(commandProjectId)) throw Object.assign(new Error('Scheduler is paused for this project'), { statusCode: 409, code: 'SCHEDULER_PAUSED', status: 'paused' });
        result = { status: 'unavailable', reason: 'No approved eligible task dispatcher is configured' };
      } else if (command_type === 'message.broadcast') {
        const projectId = commandProjectId;
        if (this.schedulerPausedProjects.has(projectId)) throw Object.assign(new Error('Scheduler is paused'), { statusCode: 409, code: 'SCHEDULER_PAUSED' });
        const repoPath = commandRepoPath;
        const roster = this.workspace && projectId ? await this.workspace.listAgents(projectId) : [];
        const requested = payload.agent_ids || roster.map((agent) => agent.name);
        const recipients = [...new Set(requested.map((id) => roster.find((agent) => agent.id === id || agent.name.toLowerCase() === String(id).toLowerCase())?.name).filter(Boolean))];
        if (recipients.length !== requested.length || !recipients.length) throw Object.assign(new Error('Every recipient must belong to the active project roster'), { statusCode: 400, code: 'INVALID_RECIPIENT' });
        const messages = [];
        for (const agentId of recipients) {
          const text = String(payload.text || '').trim(); if (!text) break;
          const owned = this.agentTerminals.has(agentId) || this.takeoverController?.getState?.(agentId) === 'human_owned';
          if (owned) { messages.push({ agent_id: agentId, status: 'skipped_human_owned' }); continue; }
          const message = await this.workspace?.addRoomMessage(projectId, { senderType: 'operator', senderId: 'operator', senderName: 'Operator', text: `@${agentId} ${text}`, channel: payload.channel || 'team-activity' });
          if (message) {
            messages.push(message);
            this.broadcastEvent('room.message', { ...message, project_id: projectId });
            try {
              const answer = await this.chatService.generateResponse(agentId, text, { projectId, repoPath });
              const reply = await this.workspace.addRoomMessage(projectId, { channel: payload.channel || 'team-activity', senderType: 'agent', senderId: agentId, senderName: agentId, text: answer, metadata: { in_reply_to: message.id } });
              if (reply) { messages.push(reply); this.broadcastEvent('room.message', { ...reply, project_id: projectId }); }
            } catch (error) {
              const failed = await this.workspace.addRoomMessage(projectId, { channel: payload.channel || 'team-activity', senderType: 'system', senderId: 'system', senderName: 'System', text: `Failed to dispatch to ${agentId}: ${error.message}`, metadata: { error: true } });
              if (failed) messages.push(failed);
            }
          }
        }
        result = { status: 'recorded', messages };
      } else if (command_type === 'session.clear_view' || command_type === 'session.reset') {
        const projectId = commandProjectId;
        const agentId = (await this.chatService.resolveAgent(payload.agent_id, { projectId })).name;
        const key = `${projectId}:${agentId}`;
        this.sessionCutoffs ||= new Map();
        const cutoff = { action: command_type, at: new Date().toISOString() };
        if (command_type === 'session.reset' && (this.agentTerminals.has(agentId) || this.takeoverController?.getState?.(agentId) === 'human_owned' || [...(this.chatService.activeTurns || new Map()).keys()].some((activeKey) => activeKey.startsWith(`${projectId}@`) && activeKey.endsWith(`:${agentId}`)))) throw Object.assign(new Error('Cannot reset a session while agent has active work or terminal'), { statusCode: 409, code: 'SESSION_ACTIVE' });
        this.sessionCutoffs.set(key, cutoff);
        this.sessionViewCutoffs.set(`${projectId}:team-activity:${agentId}`, cutoff.at);
        const cutoffs = this.readProjectCollection(projectId, 'cutoffs');
        this.writeProjectCollection(projectId, 'cutoffs', [...cutoffs.filter((item) => !(item.agent_id === agentId && (!item.channel || item.channel === 'team-activity'))), { agent_id: agentId, channel: 'team-activity', action: command_type, cutoff_at: cutoff.at }]);

        if (this.workspace && projectId) {
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(path.join(this.workspace.baseDir, 'projects', projectId, 'agentcrew.db'));
          try {
            db.exec('CREATE TABLE IF NOT EXISTS session_view_cutoffs (project_id TEXT NOT NULL, agent_id TEXT NOT NULL, action TEXT NOT NULL, cutoff_at TEXT NOT NULL, PRIMARY KEY(project_id, agent_id))');
            db.prepare('INSERT INTO session_view_cutoffs (project_id, agent_id, action, cutoff_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, agent_id) DO UPDATE SET action=excluded.action, cutoff_at=excluded.cutoff_at').run(projectId, agentId, command_type, cutoff.at);
            if (command_type === 'session.reset') {
              const hasConversations = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_conversations'").get();
              if (hasConversations) db.prepare('DELETE FROM provider_conversations WHERE project_id = ? AND agent_id = ?').run(projectId, agentId);
            }
          } finally { db.close(); }
        }
        if (command_type === 'session.reset') for (const cacheKey of (this.chatService.sessionCache || new Map()).keys()) if (cacheKey.startsWith(`${projectId}@`) && cacheKey.includes(`:${agentId}:`)) this.chatService.sessionCache.delete(cacheKey);
        result = this.sessionCutoffs.get(key);
      } else if (command_type === 'preferences.update') {
        const projectId = commandProjectId || 'default';
        const file = path.join(this.workspace?.baseDir || path.join(process.cwd(), '.agentcrew'), 'preferences', `${projectId}.json`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const current = this.preferences.get(projectId) || (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
        const allowed = ['pins', 'stars', 'tags', 'turbo', 'theme', 'accent', 'operator_name', 'autoscroll'];
        const updates = Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.includes(key)));
        if ('theme' in updates && !['light', 'dark', 'system'].includes(updates.theme)) throw Object.assign(new Error('Invalid theme preference'), { statusCode: 400 });
        if ('accent' in updates && !['blue', 'violet', 'teal', 'amber'].includes(updates.accent)) throw Object.assign(new Error('Invalid accent preference'), { statusCode: 400 });
        for (const key of ['pins', 'stars', 'tags']) if (key in updates && (!Array.isArray(updates[key]) || updates[key].length > 500)) throw Object.assign(new Error(`${key} must be a bounded array`), { statusCode: 400 });
        if ('turbo' in updates && typeof updates.turbo !== 'boolean') throw Object.assign(new Error('turbo must be a boolean'), { statusCode: 400 });
        if ('operator_name' in updates && (typeof updates.operator_name !== 'string' || updates.operator_name.length > 100)) throw Object.assign(new Error('operator_name must be a string up to 100 characters'), { statusCode: 400 });
        if ('autoscroll' in updates && typeof updates.autoscroll !== 'boolean') throw Object.assign(new Error('autoscroll must be a boolean'), { statusCode: 400 });
        const updated = { ...current, ...updates };
        fs.writeFileSync(file, JSON.stringify(updated, null, 2)); this.preferences.set(projectId, updated); result = updated;
      } else if (command_type === 'session.takeover') {
        const agentId = (await this.chatService.resolveAgent(payload.agent_id, { projectId: commandProjectId })).name;
        this.takeoverProjectContexts.set(agentId, commandProjectId);
        let resObj;
        try { resObj = await this.takeoverController.requestTakeover(agentId); }
        finally { this.takeoverProjectContexts.delete(agentId); }
        this.teamRoom.updateAgentState(agentId, { state: 'takeover' });
        result = {
          agent_id: agentId,
          state: resObj.state,
          status: resObj.status,
          takeover_token: resObj.token || resObj.takeover_token || crypto.randomUUID()
        };
        const { takeover_token: _privateToken, ...publicTakeover } = result;
        this.broadcastEvent('takeover_started', publicTakeover);
        this.broadcastEvent('takeover_quiesced', publicTakeover);
      } else if (command_type === 'session.release') {
        const agentId = (await this.chatService.resolveAgent(payload.agent_id, { projectId: commandProjectId })).name;
        if (!this.takeoverController.validateToken(agentId, payload.takeover_token)) {
          throw Object.assign(new Error('Valid takeover token required'), { statusCode: 403, code: 'INVALID_TAKEOVER_TOKEN' });
        }
        if (this.humanTurns.get(agentId)) {
          throw Object.assign(new Error('Human turn is still active; wait for it to finish before release'), { statusCode: 409, code: 'HUMAN_TURN_ACTIVE' });
        }
        const agentTerminal = this.agentTerminals.get(agentId);
        if (agentTerminal) {
          agentTerminal.revoking = true;
          const quiescent = await agentTerminal.terminal.terminateTree();
          if (!quiescent) {
            agentTerminal.revoking = false;
            throw Object.assign(new Error('Agent CLI did not confirm exit; takeover remains active'), { statusCode: 409, code: 'AGENT_CLI_QUIESCENCE_UNKNOWN' });
          }
          agentTerminal.ws?.close();
          this.agentTerminals.delete(agentId);
        }
        for (const [sessionId, owner] of this.ptyOwners) {
          if (owner.agentId !== agentId) continue;
          owner.revoking = true;
          const quiescent = await owner.ptySession.terminateTree();
          if (!quiescent) {
            owner.revoking = false;
            throw Object.assign(new Error('Shell process tree did not confirm exit; takeover remains active'), { statusCode: 409, code: 'SHELL_QUIESCENCE_UNKNOWN' });
          }
          owner.ws.close();
          this.ptyOwners.delete(sessionId);
        }
        const notes = payload.guidance_notes || payload.guidance || '';
        const resObj = await this.takeoverController.release({ agentId, guidance: notes });
        this.chatService.resumeAgent(agentId, { projectId: commandProjectId });
        this.teamRoom.updateAgentState(agentId, { state: 'idle', activeTaskId: null });
        result = { agent_id: agentId, state: resObj.state, notes: resObj.guidance };
        this.broadcastEvent('takeover_released', result);
      } else if (command_type === 'session.exec' || command_type === 'session.command') {
        const requestedAgentId = payload.agent_id || 'Dev-1';
        const agentId = (await this.chatService.resolveAgent(requestedAgentId)).name;
        const input = resolveInput(payload.command || payload.instruction, payload.mode);
        if (!this.takeoverController.validateToken(agentId, payload.takeover_token)) {
          throw Object.assign(new Error('Valid takeover token required'), { statusCode: 403, code: 'INVALID_TAKEOVER_TOKEN' });
        }
        if (input.mode === 'chat' && this.agentTerminals.has(agentId)) {
          throw Object.assign(new Error('Agent CLI is active; use its terminal instead of starting a parallel headless turn'), { statusCode: 409, code: 'AGENT_CLI_ACTIVE' });
        }
        if (!input.text) throw Object.assign(new Error('Input is required'), { statusCode: 400 });

        let output = '';
        if (input.mode === 'chat' && input.text.length > 0) {
          // Route dialogue directly to active Agent Persona reasoning
          this.beginHumanTurn(agentId);
          try {
            output = await this.chatService.generateResponse(agentId, input.text, { source: 'human', projectId: commandProjectId, repoPath: commandRepoPath });
          } finally {
            this.endHumanTurn(agentId);
          }
          this.broadcastEvent('agent_answered', {
            agent_id: agentId,
            pr_number: 'live',
            question: input.text,
            answer: output,
            cli_grounded: true,
            timestamp: new Date().toISOString()
          });
        } else {
          this.beginHumanTurn(agentId);
          try {
            if (input.mode !== 'shell' || !input.text) throw Object.assign(new Error('A shell command is required'), { statusCode: 400 });
            const execRes = await this.ptyManager.execute(input.text, { cwd: commandRepoPath });
            output = [execRes.stdout, execRes.stderr].filter(Boolean).join('\n');
            const exitCode = execRes.code ?? null;
            if (exitCode !== 0 || execRes.timedOut) {
              const failure = Object.assign(new Error(execRes.timedOut ? 'Command timed out' : output || `Command exited with code ${exitCode}`), {
                statusCode: 500, code: 'COMMAND_FAILED', exit_code: exitCode, output
              });
              throw failure;
            }
          } catch (e) {
            if (e.code === 'COMMAND_FAILED') throw e;
            throw Object.assign(new Error(`Command execution failed: ${e.message}`), {
              statusCode: e.statusCode || 500, code: e.code || 'COMMAND_EXECUTION_FAILED', exit_code: e.exit_code ?? null, output: e.output || ''
            });
          } finally {
            this.endHumanTurn(agentId);
          }
        }

        result = { agent_id: agentId, command: input.text, mode: input.mode, output, status: 'success' };
        this.broadcastEvent('command_executed', result);
      } else if (command_type === 'iteration.run') {
        const runner = new IterationRunner({
          baseDir: path.join(this.staticDir, '../..', '.scratch')
        });
        this.broadcastEvent('iteration_started', { timestamp: new Date().toISOString() });
        result = await runner.runIteration({
          repoPath: process.cwd(),
          iterationGoal: payload.goal || 'Complete AI Team Workspace delivery cycle',
          rawRequirements: payload.requirements || 'id,title,priority\nREQ-01,Verify multi-turn workflows,high\nREQ-02,Commit-bound QA approvals,high'
        });
        this.broadcastEvent('iteration_completed', { timestamp: new Date().toISOString(), result });
      } else if (command_type === 'popup.propose') {
        const ticket = this.popupEngine.proposeScopeChange({
          title: payload.title,
          affectedTasks: payload.estimated_impact?.affected_tasks,
          estimatedDelayHours: payload.estimated_impact?.delay_hours
        });
        result = { ticket };
        this.broadcastEvent('popup_created', result);
      } else if (command_type === 'agent.ask') {
        const agentId = payload.agent_id || 'Arthur (Architect)';
        const prNumber = Number(payload.pr_number);
        const question = payload.question || '';
        if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('A valid pull request number is required');
        if (!question.trim()) throw new Error('A review question is required');
        if (!this.liveProviders || !this.chatService) throw new Error('Live providers are unavailable for code review');

        const pr = await this.repoDataService.getPullRequestReviewContext(prNumber, { repoPath: commandRepoPath });
        const reviewContext = JSON.stringify({
          number: pr.number,
          title: pr.title,
          author: pr.author,
          baseBranch: pr.baseBranch,
          headBranch: pr.headBranch,
          description: pr.body,
          diff: pr.diff,
          diffTruncated: pr.diffTruncated
        });
        const prompt = `Review PR #${pr.number} (${pr.title}) by @${pr.author}. Answer the operator's question using the supplied PR metadata and diff. Cite relevant files or hunks when possible, distinguish evidence from uncertainty, and do not claim tests or checks passed unless the diff or provided context proves it.\n\nOperator question: ${question}`;
        const answer = await this.chatService.generateResponse(agentId, prompt, {
          reviewContext,
          throwOnProviderError: true, projectId: commandProjectId, repoPath: commandRepoPath
        });

        result = {
          agent_id: agentId,
          pr_number: prNumber,
          question,
          answer,
          author: pr.author,
          cli_grounded: true,
          timestamp: new Date().toISOString()
        };
        this.broadcastEvent('agent_answered', result);
      }

      const receipt = {
        command_id: commandId,
        status: 'acknowledged',
        result
      };
      if (receiptKey) { this.commandReceipts.set(receiptKey, { fingerprint, receipt }); while (this.commandReceipts.size > 200) this.commandReceipts.delete(this.commandReceipts.keys().next().value); }
      return this.jsonResponse(res, 200, receipt);
    } catch (err) {
      return this.jsonResponse(res, err.statusCode || 500, {
        status: 'error', error: err.message, code: err.code,
        ...(err.exit_code !== undefined ? { exit_code: err.exit_code } : {}),
        ...(err.output ? { output: err.output } : {})
      });
    } finally {
      this.inFlightMutations--;
      if (receiptKey) this.commandInFlight.delete(receiptKey);
    }
  }

  getCommandCatalog(includeRuntime = false) {
    let scripts = {};
    try { scripts = JSON.parse(fs.readFileSync(path.join(this.repoPath, 'package.json'), 'utf8')).scripts || {}; } catch (_) {}
    const commands = Object.keys(scripts).sort().map((name) => ({ id: `script:${name}`, label: name, command: `npm run ${name}`, source: 'package.json', executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', name] }));
    commands.push(
      { id: 'git:status', label: 'Git status', command: 'git status --short --branch', source: 'built-in', executable: 'git', args: ['status', '--short', '--branch'] },
      { id: 'git:branch', label: 'Git branches', command: 'git branch', source: 'built-in', executable: 'git', args: ['branch'] },
      { id: 'git:log', label: 'Recent commits', command: 'git log -n 5 --oneline', source: 'built-in', executable: 'git', args: ['log', '-n', '5', '--oneline'] }
    );
    return includeRuntime ? commands : commands.map(({ id, label, command, source }) => ({ id, label, command, source }));
  }

  projectCollectionPath(projectId, kind) {
    const safeId = String(projectId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.workspace?.baseDir || path.join(process.cwd(), '.agentcrew'), 'project-state', safeId, `${kind}.json`);
  }

  readProjectCollection(projectId, kind) {
    try { const value = JSON.parse(fs.readFileSync(this.projectCollectionPath(projectId, kind), 'utf8')); return Array.isArray(value) ? value : []; }
    catch (_) { return []; }
  }

  writeProjectCollection(projectId, kind, values) {
    const file = this.projectCollectionPath(projectId, kind);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(values, null, 2));
  }

  taskStatus(stage) {
    return ({ backlog: 'Backlog', planning: 'Planning', todo: 'To Do', in_progress: 'In Progress', review: 'Review', qa: 'QA', done: 'Done' })[stage] || 'To Do';
  }

  normalizeTaskStage(stage) {
    if (stage === 'backlog' || stage === 'todo') return 'planning';
    return ['planning', 'in_progress', 'review', 'qa', 'done'].includes(stage) ? stage : 'planning';
  }

  persistTaskFile(repoPath, task) {
    const tasksDir = path.join(repoPath, 'backlog', 'tasks');
    if (fs.existsSync(tasksDir)) {
      const file = path.join(tasksDir, `${task.id}.md`);
      const quote = (value) => JSON.stringify(String(value ?? ''));
      const frontmatter = ['---', `id: ${quote(task.id)}`, `title: ${quote(task.title)}`, `status: ${quote(this.taskStatus(task.stage))}`, `created_at: ${quote(task.created_at || new Date().toISOString())}`, '---', '', String(task.description || '')].join('\n');
      fs.writeFileSync(file, frontmatter);
    } else {
      const file = path.join(repoPath, '.agentcrew', 'tasks.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let tasks = [];
      try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(value)) tasks = value; } catch (_) {}
      const next = { ...task, status: this.taskStatus(task.stage) };
      fs.writeFileSync(file, JSON.stringify([...tasks.filter((item) => item.id !== task.id), next], null, 2));
    }
  }

  transitionTaskFile(repoPath, id, stage) {
    const tasksDir = path.join(repoPath, 'backlog', 'tasks');
    if (!fs.existsSync(tasksDir)) return null;
    for (const filename of fs.readdirSync(tasksDir).filter((name) => name.endsWith('.md'))) {
      const file = path.join(tasksDir, filename);
      let content;
      try { content = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match) continue;
      const fields = Object.fromEntries(match[1].split(/\r?\n/).map((line) => { const at = line.indexOf(':'); return at < 0 ? ['', ''] : [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
      if (fields.id !== id) continue;
      const status = this.taskStatus(stage);
      const updatedAt = new Date().toISOString();
      let updated = match[1].match(/^status:.*$/m) ? match[1].replace(/^status:.*$/m, `status: ${JSON.stringify(status)}`) : `${match[1]}\nstatus: ${JSON.stringify(status)}`;
      updated = /^updated_at:.*$/m.test(updated) ? updated.replace(/^updated_at:.*$/m, `updated_at: ${JSON.stringify(updatedAt)}`) : `${updated}\nupdated_at: ${JSON.stringify(updatedAt)}`;
      fs.writeFileSync(file, content.replace(match[1], updated));
      return { id, title: fields.title, created_at: fields.created_at, updated_at: updatedAt };
    }
    return null;
  }

  handleStatic(pathname, res) {
    const terminalAssets = {
      '/vendor/xterm.js': require.resolve('@xterm/xterm'),
      '/vendor/xterm.css': path.join(path.dirname(require.resolve('@xterm/xterm')), '../css/xterm.css'),
      '/vendor/addon-fit.js': require.resolve('@xterm/addon-fit'),
    };
    if (terminalAssets[pathname]) {
      const asset = terminalAssets[pathname];
      res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(asset)] || 'application/octet-stream' });
      fs.createReadStream(asset).pipe(res);
      return;
    }
    let filePath = pathname === '/' ? '/index.html' : (pathname === '/terminal' ? '/terminal.html' : pathname);
    const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(this.staticDir, safePath);

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(fullPath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
        if (body.length > 65536) { // 64 KiB limit per TRD §12.1
          reject(new Error('Request payload exceeds 64 KiB limit'));
        }
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  jsonResponse(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

module.exports = {
  SupervisorServer
};
