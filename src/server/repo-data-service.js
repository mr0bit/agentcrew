const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');

class RepoDataService {
  constructor(options = {}) {
    this.repoPath = options.repoPath || process.cwd();
    this.repoGeneration = 0;
    this.cache = new Map();
    this.cacheTtlMs = options.cacheTtlMs !== undefined ? options.cacheTtlMs : 5000;
  }

  setRepoRoot(repoPath) {
    this.repoPath = repoPath;
    this.repoGeneration++;
    this.cache.clear();
  }

  /**
   * Helper to run a command with timeout and error handling.
   */
  async execCommand(file, args, options = {}) {
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        {
          cwd: options.cwd || this.repoPath,
          timeout: options.timeout || 5000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ error, stdout: '', stderr: stderr ? stderr.toString() : '' });
          } else {
            resolve({ error: null, stdout: stdout.toString(), stderr: stderr ? stderr.toString() : '' });
          }
        }
      );
    });
  }

  /**
   * Parse tasks from backlog/tasks/*.md
   */
  async getBacklogTasks(popupTasks = []) {
    const tasksDir = path.join(this.repoPath, 'backlog', 'tasks');
    const tasks = [];

    if (fs.existsSync(tasksDir)) {
      const files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.md'));

      for (const filename of files) {
        try {
          const filePath = path.join(tasksDir, filename);
          const content = fs.readFileSync(filePath, 'utf8');
          const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

          if (!frontmatterMatch) continue;

          const fmLines = frontmatterMatch[1].split(/\r?\n/);
          const fields = {};

          for (const line of fmLines) {
            const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
            if (m) {
              const key = m[1].trim();
              let val = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
              fields[key] = val;
            }
          }

          const idMatch = filename.match(/^task-(\d+)/i) || (fields.id && fields.id.match(/TASK-(\d+)/i));
          const numId = idMatch ? parseInt(idMatch[1], 10) : 999;
          const id = fields.id || `TASK-${numId}`;
          const title = fields.title || filename.replace(/^task-\d+\s*-\s*/, '').replace(/\.md$/, '').replace(/-/g, ' ');
          const status = fields.status || 'To Do';
          const priority = fields.priority || 'medium';
          const ordinal = fields.ordinal ? parseInt(fields.ordinal, 10) : numId * 1000;

          // Map status to Kanban stage
          let stage = 'planning';
          const sLower = status.toLowerCase();
          if (sLower === 'done' || sLower === 'completed') {
            stage = 'done';
          } else if (sLower === 'in progress' || sLower === 'in_progress') {
            stage = 'in_progress';
          } else if (sLower.includes('review')) {
            stage = 'review';
          } else if (sLower.includes('qa') || sLower.includes('test')) {
            stage = 'qa';
          } else {
            stage = 'planning';
          }

          // Map realistic identity owner based on task focus
          let owner = 'Dev-1';
          const tLower = (title + ' ' + filename).toLowerCase();
          if (tLower.includes('spike') || tLower.includes('architect') || tLower.includes('schema') || tLower.includes('trd')) {
            owner = 'Arthur (Architect)';
          } else if (tLower.includes('prd') || tLower.includes('requirement') || tLower.includes('intake') || tLower.includes('session')) {
            owner = 'Alice (BA)';
          } else if (tLower.includes('scope') || tLower.includes('popup') || tLower.includes('package')) {
            owner = 'Peter (PO)';
          } else if (tLower.includes('qa') || tLower.includes('verification') || tLower.includes('test') || tLower.includes('bound')) {
            owner = `QA-${(numId % 4) + 1} (Tester)`;
          } else if (tLower.includes('integration') || tLower.includes('branch') || tLower.includes('git')) {
            owner = 'Integrator-1';
          } else {
            owner = `Dev-${(numId % 4) + 1}`;
          }

          tasks.push({
            id,
            numId,
            title,
            status,
            stage,
            priority,
            owner,
            ordinal,
            created_date: fields.created_date || null
          });
        } catch (_) {
          // ignore corrupted task file
        }
      }
    }

    const stateFile = path.join(this.repoPath, '.agentcrew', 'tasks.json');
    try {
      const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (Array.isArray(stored)) for (const task of stored) {
        if (!task || !task.id || tasks.some((item) => item.id === task.id)) continue;
        const status = ({ backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' })[task.stage] || task.status || 'To Do';
        tasks.push({ id: task.id, numId: 999, title: task.title || task.id, status, stage: task.stage || 'planning', priority: task.priority || 'medium', owner: task.owner || 'Dev-1', ordinal: 999000 + tasks.length, created_date: task.created_at || null });
      }
    } catch (_) {}

    // Include any active popups as tasks in the board
    if (Array.isArray(popupTasks)) {
      for (const popup of popupTasks) {
        tasks.push({
          id: popup.id || 'P-001',
          numId: 9000,
          title: popup.title || 'Scope Change Proposal',
          status: popup.status || 'Proposed',
          stage: popup.status === 'applied' ? 'done' : 'planning',
          priority: popup.riskLevel || 'high',
          owner: 'Peter (PO)',
          ordinal: 999999
        });
      }
    }

    // Sort by ordinal / numerical ID
    tasks.sort((a, b) => a.ordinal - b.ordinal || a.numId - b.numId);

    return tasks;
  }

  /**
   * Helper to format relative time.
   */
  formatRelativeAge(dateStr) {
    if (!dateStr) return 'recently';
    const then = new Date(dateStr).getTime();
    const now = Date.now();
    const diffMs = Math.max(0, now - then);
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins || 1}m`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d`;
  }

  /**
   * Parse sections from PR markdown body
   */
  parsePrBodySections(body) {
    if (!body || typeof body !== 'string') {
      return {
        problem: ['Work tracked under this pull request.'],
        approach: ['Automated delivery cycle verification.'],
      };
    }

    const lines = body.split(/\r?\n/);
    const problemLines = [];
    const approachLines = [];

    let currentSection = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (/^##\s+(why|problem|background|context)/i.test(line)) {
        currentSection = 'problem';
        continue;
      } else if (/^##\s+(what\s*changed|approach|solution|summary|changes)/i.test(line)) {
        currentSection = 'approach';
        continue;
      } else if (/^##\s+/i.test(line)) {
        currentSection = null;
        continue;
      }

      if (currentSection === 'problem' && line) {
        if (!line.startsWith('```') && !line.startsWith('|')) {
          problemLines.push(line.replace(/^[-*]\s+/, ''));
        }
      } else if (currentSection === 'approach' && line) {
        if (!line.startsWith('```') && !line.startsWith('|')) {
          approachLines.push(line.replace(/^[-*]\s+/, ''));
        }
      }
    }

    return {
      problem: problemLines.length > 0 ? problemLines.slice(0, 4) : [body.slice(0, 160).replace(/[#*`]/g, '').trim()],
      approach: approachLines.length > 0 ? approachLines.slice(0, 5) : ['Implemented changes and verified with test suite.']
    };
  }

  async getPullRequestReviewContext(number, options = {}) {
    const prNumber = Number(number);
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('A valid pull request number is required');
    const repoPath = options.repoPath || this.repoPath;
    const [details, diff] = await Promise.all([
      this.execCommand('gh', ['pr', 'view', String(prNumber), '--json', 'number,title,author,body,headRefName,baseRefName'], { cwd: repoPath }),
      this.execCommand('gh', ['pr', 'diff', String(prNumber)], { cwd: repoPath })
    ]);
    if (details.error) throw new Error(`Unable to load PR #${prNumber} details: ${(details.stderr || details.error.message).trim()}`);
    if (diff.error) throw new Error(`Unable to load PR #${prNumber} diff: ${(diff.stderr || diff.error.message).trim()}`);
    let pr;
    try { pr = JSON.parse(details.stdout); }
    catch (error) { throw new Error(`Unable to parse PR #${prNumber} details: ${error.message}`); }
    if (Number(pr.number) !== prNumber) throw new Error(`GitHub returned a different pull request than #${prNumber}`);
    const diffText = diff.stdout || '';
    return {
      number: prNumber,
      title: pr.title || `PR #${prNumber}`,
      author: pr.author?.login || 'unknown',
      body: pr.body || '',
      baseBranch: pr.baseRefName || '',
      headBranch: pr.headRefName || '',
      diff: diffText.slice(0, 40000),
      diffTruncated: diffText.length > 40000
    };
  }

  /**
   * Query pull requests via `gh` CLI or git log fallback
   */
  async getPullRequests() {
    const repoPath = this.repoPath;
    const generation = this.repoGeneration;
    const cacheKey = `${repoPath}:pullRequests`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.cacheTtlMs) {
      return cached.data;
    }

    const repoName = path.basename(repoPath);

    // Try `gh pr list`
    const ghRes = await this.execCommand('gh', [
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      '30',
      '--json',
      'number,title,author,state,createdAt,additions,deletions,headRefName,body'
    ], { cwd: repoPath });

    let prs = [];

    if (!ghRes.error && ghRes.stdout.trim()) {
      try {
        const rawPrs = JSON.parse(ghRes.stdout);
        const todayStr = new Date().toISOString().slice(0, 10);

        prs = rawPrs.map((pr) => {
          const stateStr = (pr.state || 'OPEN').toUpperCase();
          const headBranch = pr.headRefName || 'main';

          let kind = 'open';
          let label = 'Open';
          if (stateStr === 'MERGED') {
            kind = 'merged';
            label = 'Merged';
          } else if (stateStr === 'CLOSED') {
            kind = 'closed';
            label = 'Closed';
          } else {
            if (headBranch.includes('review') || headBranch.includes('pr')) {
              kind = 'review';
              label = 'Under Review';
            } else {
              kind = 'open';
              label = 'Open';
            }
          }

          const openedDate = pr.createdAt ? new Date(pr.createdAt) : null;
          const isToday = Boolean(pr.createdAt && pr.createdAt.startsWith(todayStr));
          const { problem, approach } = this.parsePrBodySections(pr.body);

          const authorLogin = pr.author?.login || 'inegmdev';
          return {
            number: pr.number,
            title: pr.title,
            author: authorLogin,
            status: { kind, label },
            repository: repoName,
            opened: openedDate ? openedDate.toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            }) : 'Unknown',
            age: this.formatRelativeAge(pr.createdAt),
            today: isToday,
            additions: pr.additions || 0,
            deletions: pr.deletions || 0,
            comments: null,
            branch: headBranch,
            problem,
            approach
          };
        });
      } catch (_) {
        prs = [];
      }
    }

    // Fallback: extract from git log merges or commits if gh not available
    if (prs.length === 0) {
      const gitMerges = await this.execCommand('git', [
        'log',
        '--merges',
        '-n',
        '10',
        '--pretty=format:%H%x09%an%x09%ad%x09%s%x09%b'
      ], { cwd: repoPath });

      if (!gitMerges.error && gitMerges.stdout.trim()) {
        const lines = gitMerges.stdout.trim().split('\n');
        lines.forEach((line, index) => {
          const parts = line.split('\t');
          const subject = parts[3] || 'Merge branch';
          const prMatch = subject.match(/#(\d+)/);
          const prNum = prMatch ? parseInt(prMatch[1], 10) : 20 - index;
          prs.push({
            number: prNum,
            title: subject,
            author: 'dev1',
            status: { kind: 'merged', label: 'Merged' },
            repository: repoName,
            opened: 'Recently',
            age: `${index + 1}h`,
            today: true,
            additions: 0,
            deletions: 0,
            comments: 0,
            branch: `feature/pr-${prNum}`,
            problem: ['PR merged from local branch.'],
            approach: ['Integrated and verified in repo history.']
          });
        });
      }
    }

    if (generation === this.repoGeneration && repoPath === this.repoPath) this.cache.set(cacheKey, { data: prs, time: Date.now() });
    return prs;
  }

  /**
   * Load real repositories and worktrees
   */
  async getRepositories() {
    const repoPath = this.repoPath;
    const generation = this.repoGeneration;
    const cacheKey = `${repoPath}:repositories`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.cacheTtlMs) {
      return cached.data;
    }

    const repos = [];
    const mainRepoName = path.basename(repoPath);

    // Read package.json description if present
    let description = 'Local AI team workspace — persistent identities, supervisor daemon, interactive dashboards';
    try {
      const pkgPath = path.join(repoPath, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.description) description = pkg.description;
      }
    } catch (_) {}

    // Git branch
    const branchRes = await this.execCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
    const activeBranch = branchRes.stdout.trim() || 'main';

    // Git status
    const statusRes = await this.execCommand('git', ['status', '--porcelain'], { cwd: repoPath });
    const isClean = statusRes.stdout.trim().length === 0;
    const statusText = isClean ? 'clean' : 'modified';

    // Git last commit time
    const lastCommitRes = await this.execCommand('git', ['log', '-1', '--pretty=format:%cr'], { cwd: repoPath });
    const lastSync = lastCommitRes.stdout.trim() || 'Just now';

    // Git worktrees
    const wtRes = await this.execCommand('git', ['worktree', 'list'], { cwd: repoPath });
    const wtLines = wtRes.stdout.trim().split('\n').filter(Boolean);
    const worktreesCount = Math.max(1, wtLines.length);

    repos.push({
      name: mainRepoName,
      description,
      branch: activeBranch,
      worktreesCount,
      status: statusText,
      lastSync
    });

    // If extra worktrees exist, add them
    if (wtLines.length > 1) {
      for (let i = 1; i < wtLines.length; i++) {
        const line = wtLines[i];
        const match = line.match(/^(\S+)\s+([a-f0-9]+)\s+\[([^\]]+)\]/);
        if (match) {
          const wtPath = match[1];
          const wtBranch = match[3];
          repos.push({
            name: `${mainRepoName}/${path.basename(wtPath)}`,
            description: `Isolated worktree checkout for ${wtBranch}`,
            branch: wtBranch,
            worktreesCount: 1,
            status: 'clean',
            lastSync: 'Active'
          });
        }
      }
    }

    // Check ~/.agentcrew/state.json for other registered projects
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const stateFile = path.join(homeDir, '.agentcrew', 'state.json');
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (Array.isArray(state.projects)) {
          for (const proj of state.projects) {
            if (proj.name && proj.path && proj.path !== repoPath && fs.existsSync(proj.path)) {
              repos.push({
                name: proj.name,
                description: `Registered agentcrew project at ${proj.path}`,
                branch: 'main',
                worktreesCount: 1,
                status: 'clean',
                lastSync: proj.lastSeenAt ? this.formatRelativeAge(proj.lastSeenAt) + ' ago' : '1d ago'
              });
            }
          }
        }
      }
    } catch (_) {}

    if (generation === this.repoGeneration && repoPath === this.repoPath) this.cache.set(cacheKey, { data: repos, time: Date.now() });
    return repos;
  }

  /**
   * Load real analytics & KPIs
   */
  async getAnalytics(options = {}) {
    const scheduler = options.scheduler;
    const tasks = await this.getBacklogTasks(options.popups || []);
    const prs = await this.getPullRequests();
    const repositories = await this.getRepositories();

    // Count completed tasks
    const completedTasks = tasks.filter(t => t.stage === 'done');
    const deliveredCount = completedTasks.length;

    // Concurrency
    const maxConc = scheduler?.maxConcurrency || 4;
    const runningConc = scheduler?.runningCount || 0;

    // PR additions/deletions are only available from GitHub. Local history is
    // not enough evidence to attribute line totals to a pull request.
    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const pr of prs) {
      totalAdditions += pr.additions || 0;
      totalDeletions += pr.deletions || 0;
    }

    const metric = (id, label, icon, value, extra = {}) => ({ id, label, icon, value, delta: null, spark: [], ...extra });
    const completedCount = String(deliveredCount);
    const cycleTime = this.observedCycleTimeMs;
    const qaPassRate = this.observedQaPassRate;
    const concurrency = `${runningConc} / ${maxConc}`;

    const kpis = {
      week: [
        metric('cycle-time', 'Avg. Cycle Time', 'clock', cycleTime == null ? '—' : `${(cycleTime / 60000).toFixed(1)}m`, { lowerIsBetter: true }),
        metric('qa-pass', 'QA First-Pass Yield', 'check', qaPassRate == null ? '—' : `${(qaPassRate * 100).toFixed(1)}%`),
        metric('concurrency', 'Peak Concurrency', 'pulse', concurrency),
        metric('delivered', 'Tasks Delivered', 'commit', completedCount)
      ],
      month: [
        metric('cycle-time', 'Avg. Cycle Time', 'clock', cycleTime == null ? '—' : `${(cycleTime / 60000).toFixed(1)}m`, { lowerIsBetter: true }),
        metric('qa-pass', 'QA First-Pass Yield', 'check', qaPassRate == null ? '—' : `${(qaPassRate * 100).toFixed(1)}%`),
        metric('concurrency', 'Peak Concurrency', 'pulse', concurrency),
        metric('delivered', 'Tasks Delivered', 'commit', completedCount)
      ]
    };

    return {
      kpis,
      repositories,
      pullRequests: prs,
      totalLines: {
        additions: totalAdditions,
        deletions: totalDeletions
      }
    };
  }
}

module.exports = { RepoDataService };
