const { which } = require('../lib/shell');

/**
 * Adapter for Codex CLI satisfying the ProviderPlugin interface (TRD §5).
 */
class CodexAdapter {
  constructor(opts = {}) {
    this.command = opts.command || 'codex';
    this.manifest = {
      id: 'codex',
      contract_version: 1,
      implementation_version: '1.0.0',
    };
  }

  async probe(context = {}) {
    const resolve = context.which || which;
    const isPresent = Boolean(resolve(this.command));
    return {
      id: 'codex',
      contract_version: 1,
      available: isPresent,
      reason: isPresent ? null : `Runner '${this.command}' was not found on PATH`,
      capabilities: [
        'stream_messages',
        'send_followup',
        'native_resume',
        'interrupt_turn',
        'tool_events',
        'permission_decisions',
        'disable_native_delegation',
      ],
    };
  }

  buildSpawnArgs({ cwd, sessionId, resumeFrom, model } = {}) {
    const args = ['exec', '--json'];

    if (cwd) {
      args.push('--cd', cwd);
    }

    if (model) {
      args.push('--model', model);
    }

    // Enforce roster-only delegation by disabling multi-agent sub-agents
    args.push('-c', 'features.multi_agent=false');

    // Always skip git repo check to prevent safe.directory failures on external/virtual mounts
    args.push('--skip-git-repo-check');

    if (resumeFrom) {
      args.push('resume', resumeFrom);
    }

    return args;
  }

  parseStreamEvent(rawLine) {
    if (!rawLine || !rawLine.trim()) return null;
    try {
      const data = JSON.parse(rawLine.trim());
      if ((data.type === 'item_completed' || data.type === 'item.completed') && data.item && data.item.type === 'agent_message') {
        return {
          type: 'message.assistant',
          text: data.item.text,
        };
      }
      return data;
    } catch {
      return { type: 'raw.output', text: rawLine };
    }
  }
}

module.exports = { CodexAdapter };
