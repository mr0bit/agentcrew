const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatService, ROLE_CONTRACTS } = require('../../src/chat/chat-service');
const { TurnScheduler } = require('../../src/scheduler/turn-scheduler');
const { AgyAdapter } = require('../../src/providers/agy-adapter');
const { CodexAdapter } = require('../../src/providers/codex-adapter');

test('ChatService builds role instructions from PRD §6 role contracts', () => {
  const service = new ChatService({ liveProviders: false });
  
  // Verify role contracts definition
  assert.ok(ROLE_CONTRACTS['Business Analyst'], 'Must define BA contract');
  assert.ok(ROLE_CONTRACTS['Architect'], 'Must define Architect contract');
  assert.ok(ROLE_CONTRACTS['Developer'], 'Must define Developer contract');
  assert.ok(ROLE_CONTRACTS['Tester'], 'Must define Tester contract');

  const baContract = ROLE_CONTRACTS['Business Analyst'];
  assert.ok(baContract.accepts.includes('Source snapshots') || baContract.accepts.includes('clarification'));
  assert.ok(baContract.produces.includes('Requirement IDs') || baContract.produces.includes('spec revisions'));
  assert.ok(baContract.authority.includes('cannot silently change approved scope'));

  const prompt = service.buildRolePrompt({
    agentName: 'Alice',
    role: 'Business Analyst',
    gitContext: 'Head: 1234567 feat',
    userPrompt: 'What requirements are missing?'
  });

  assert.ok(prompt.includes('Alice'));
  assert.ok(prompt.includes('Business Analyst'));
  assert.ok(prompt.includes(baContract.authority));
  assert.ok(prompt.includes('What requirements are missing?'));
});

test('ChatService routes chat turns through TurnScheduler enforcing concurrency cap', async () => {
  const scheduler = new TurnScheduler({ maxConcurrency: 4 });
  let enqueueCalled = false;
  const originalEnqueue = scheduler.enqueue.bind(scheduler);
  scheduler.enqueue = (turnId, taskFn) => {
    enqueueCalled = true;
    return originalEnqueue(turnId, taskFn);
  };

  const service = new ChatService({
    scheduler,
    liveProviders: false
  });

  const response = await service.generateResponse('Alice', 'Hello');
  assert.ok(enqueueCalled, 'Turn must be enqueued through TurnScheduler');
  assert.ok(response.includes('Alice'));
  assert.ok(response.includes('[offline]'));
});

test('ChatService uses adapter buildSpawnArgs when invoking provider', async () => {
  let agySpawnArgsCalled = false;
  const mockAgy = new AgyAdapter();
  mockAgy.buildSpawnArgs = (opts) => {
    agySpawnArgsCalled = true;
    return ['-p', '--disable-slash-commands'];
  };

  const executedCommands = [];
  const mockPty = {
    activeSessions: new Map(),
    async execute(cmd, opts) {
      executedCommands.push({ cmd, opts });
      return { stdout: '{"response":"I am Alice"}', stderr: '', code: 0 };
    },
    async executeCommand(binary, args, opts) {
      executedCommands.push({ binary, args, opts });
      return { stdout: '{"response":"I am Alice"}', stderr: '', code: 0 };
    }
  };

  const service = new ChatService({
    liveProviders: true,
    adapters: { agy: mockAgy, codex: new CodexAdapter() },
    ptyManager: mockPty,
    which: (bin) => bin === 'agy'
  });

  const reply = await service.generateResponse('Alice', 'Explain the scope');
  assert.ok(agySpawnArgsCalled, 'Must call agyAdapter.buildSpawnArgs');
  assert.ok(reply.includes('I am Alice'));
});

test('ChatService publishes provider deltas as stdout arrives and returns their assembled reply', async () => {
  const chunks = [];
  const mockCodex = new CodexAdapter();
  mockCodex.buildSpawnArgs = () => ['exec', '--json'];
  const service = new ChatService({
    liveProviders: true,
    adapters: { codex: mockCodex },
    which: (bin) => bin === 'codex',
    ptyManager: {
      async executeCommand(_binary, _args, options) {
        options.onStdout('{"type":"delta","delta":"Hello "}\n');
        options.onStdout('{"type":"delta","delta":"there"}\n');
        return { stdout: '', stderr: '', code: 0 };
      }
    }
  });

  const answer = await service.generateResponse('Arthur', 'Say hello', {
    onChunk: (chunk) => chunks.push(chunk)
  });

  assert.deepEqual(chunks, ['Hello ', 'there']);
  assert.ok(answer.includes('Hello there'));
});

test('ChatService fails over to next available provider if primary fails', async () => {
  const mockAgy = new AgyAdapter();
  mockAgy.buildSpawnArgs = () => ['-p'];

  const mockCodex = new CodexAdapter();
  mockCodex.buildSpawnArgs = () => ['exec', '--json'];

  const callLog = [];
  const mockPty = {
    async executeCommand(binary, args, opts) {
      callLog.push(binary);
      if (binary === 'agy') {
        return { stdout: '', stderr: 'Quota exceeded 429', code: 1 };
      }
      if (binary === 'codex') {
        return { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"Codex answers"}}', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: 'unknown', code: 1 };
    }
  };

  const service = new ChatService({
    liveProviders: true,
    adapters: { agy: mockAgy, codex: mockCodex },
    ptyManager: mockPty,
    which: () => true,
    workspace: { async listAgents() { return [{ name: 'Alice', role: 'Business Analyst', provider: 'agy', model: 'gemini-2.5-pro', backup_provider: 'codex', backup_model: 'o3' }]; } },
    projectId: 'test',
  });

  const reply = await service.generateResponse('Alice', 'Hello Alice');
  assert.ok(callLog.includes('agy'), 'Must attempt agy first');
  assert.ok(callLog.includes('codex'), 'Must failover to codex');
  assert.ok(reply.includes('Codex answers'), `Reply must contain failover text: ${reply}`);
  assert.ok(reply.includes('[provider: codex · explicit backup]'), `Reply must identify the responding provider: ${reply}`);
  assert.equal((await service.probeProviders()).find((p) => p.name === 'agy').status, 'quota_limited');
});

test('ChatService probes adapters and reports missing Gemini explicitly', async () => {
  const probed = [];
  const makeAdapter = (id, available) => ({
    async probe() { probed.push(id); return { id, available, capabilities: [] }; },
  });
  const service = new ChatService({
    adapters: {
      agy: makeAdapter('agy', true),
      codex: makeAdapter('codex', true),
      gemini: makeAdapter('gemini', false),
    },
    which: () => true,
  });
  const reports = await service.probeProviders();
  assert.deepEqual(probed.sort(), ['agy', 'codex', 'gemini']);
  assert.equal(reports.find((provider) => provider.name === 'gemini').status, 'unavailable');
  assert.equal(reports.find((provider) => provider.name === 'gemini').available, false);
});

test('ChatService records quota reset hints from provider errors', async () => {
  const service = new ChatService({
    liveProviders: true,
    adapters: { agy: new AgyAdapter() },
    ptyManager: {
      async execute() { return { stdout: '', stderr: 'RESOURCE_EXHAUSTED (429), resets in 9 minutes', code: 1 }; },
      async executeCommand() { return { stdout: '', stderr: 'RESOURCE_EXHAUSTED (429), resets in 9 minutes', code: 1 }; },
    },
    which: (bin) => bin === 'agy',
  });
  await service.generateResponse('Alice', 'Hello');
  const agy = (await service.probeProviders()).find((provider) => provider.name === 'agy');
  assert.equal(agy.status, 'quota_limited');
  assert.ok(Date.parse(agy.reset_at) > Date.now());
});

test('ChatService does not silently route a Gemini agent to agy', async () => {
  let invoked = false;
  const gemini = { command: 'gemini', buildSpawnArgs: () => { invoked = true; return []; } };
  const agy = new AgyAdapter();
  const service = new ChatService({
    liveProviders: true,
    adapters: { gemini, agy },
    which: (bin) => bin === 'agy',
    ptyManager: {
      async execute() { return { stdout: '', code: 0 }; },
      async executeCommand(binary, args) {
        assert.equal(binary, 'agy');
        return { stdout: '{"response":"Fallback response"}', stderr: '', code: 0 };
      },
    },
  });
  await assert.rejects(service.generateResponse('QA-1', 'Review this change', {
    throwOnProviderError: true,
  }), /gemini.*unavailable|unavailable.*gemini/i);
  assert.equal(invoked, false);
});

test('ChatService never displays provider metadata as an assistant answer', async () => {
  const chunks = [];
  const service = new ChatService({
    liveProviders: true,
    which: (bin) => bin === 'agy',
    ptyManager: {
      async executeCommand(_binary, _args, options) {
        const stdout = '{"event":"init","conversation_id":"conv-1"}\n{"event":"step_update","step_update":{"status":"thinking"}}\n';
        options.onStdout(stdout);
        return { stdout, stderr: '', code: 0 };
      },
    },
  });
  await assert.rejects(service.generateResponse('Alice', 'Hello', {
    throwOnProviderError: true,
    onChunk: (chunk) => chunks.push(chunk),
  }), /no readable assistant response/i);
  assert.deepEqual(chunks, []);
});

test('ChatService does not call plain Codex stdout an assistant reply', async () => {
  const chunks = [];
  const service = new ChatService({
    liveProviders: true,
    which: (bin) => bin === 'codex',
    ptyManager: {
      async executeCommand(_binary, _args, options) {
        const stdout = '{"type":"thread.started","thread_id":"thread-1"}\nCodex initialized\n';
        options.onStdout(stdout);
        return { stdout, stderr: '', code: 0 };
      },
    },
  });
  await assert.rejects(service.generateResponse('Arthur', 'Hello', {
    throwOnProviderError: true,
    onChunk: (chunk) => chunks.push(chunk),
  }), /no readable assistant response/i);
  assert.deepEqual(chunks, []);
});

test('ChatService does not start a fresh provider conversation when session storage fails', async () => {
  let invoked = false;
  const service = new ChatService({
    liveProviders: true,
    projectId: 'project-1',
    workspace: {
      async listAgents() { return [{ name: 'Alice', role: 'Business Analyst', provider: 'agy', model: 'gemini-2.5-pro' }]; },
      async getAgentSession() { throw new Error('session database unavailable'); },
    },
    which: (bin) => bin === 'agy',
    ptyManager: { async executeCommand() { invoked = true; return { stdout: '', stderr: '', code: 0 }; } },
  });
  await assert.rejects(service.generateResponse('Alice', 'Hello', { throwOnProviderError: true }), /session database unavailable/);
  assert.equal(invoked, false);
});

test('ChatService includes review context in provider prompt and throws when all providers fail', async () => {
  let invokedPrompt = '';
  const mockAgy = new AgyAdapter();
  mockAgy.buildSpawnArgs = () => ['-p'];
  const service = new ChatService({
    liveProviders: true,
    adapters: { agy: mockAgy },
    ptyManager: {
      async executeCommand(_binary, args) {
        invokedPrompt = args.find(arg => arg.startsWith('-p=')) || '';
        return { stdout: '', stderr: 'quota exceeded', code: 1 };
      }
    },
    which: bin => bin === 'agy'
  });

  await assert.rejects(
    service.generateResponse('Arthur (Architect)', 'Assess this change', {
      reviewContext: '{"title":"PR context","diff":"changed line"}',
      throwOnProviderError: true
    }),
    /agy: quota exceeded/
  );
  assert.match(invokedPrompt, /PR context/);
  assert.match(invokedPrompt, /changed line/);
  assert.match(invokedPrompt, /Assess this change/);
});

test('ChatService preserves provider session ID across multi-turn messages (TASK-29)', async () => {
  const agyCalls = [];
  const mockAgy = new AgyAdapter();
  mockAgy.buildSpawnArgs = (opts) => {
    agyCalls.push(opts);
    const args = ['-p', '--disable-slash-commands'];
    if (opts.resumeFrom) {
      args.push('--conversation', opts.resumeFrom);
    }
    return args;
  };

  const mockPty = {
    async executeCommand(binary, args, opts) {
      // First turn returns conversation_id 'conv-alice-42'
      if (!args.includes('conv-alice-42')) {
        return {
          stdout: JSON.stringify({
            conversation_id: 'conv-alice-42',
            status: 'SUCCESS',
            response: 'Recorded 01000079031'
          }),
          stderr: '',
          code: 0
        };
      }
      // Second turn with conversation_id returns the recalled number
      return {
        stdout: JSON.stringify({
          conversation_id: 'conv-alice-42',
          status: 'SUCCESS',
          response: 'The number is 01000079031'
        }),
        stderr: '',
        code: 0
      };
    }
  };

  const service = new ChatService({
    liveProviders: true,
    adapters: { agy: mockAgy },
    ptyManager: mockPty,
    which: (bin) => bin === 'agy'
  });

  // Turn 1
  const res1 = await service.generateResponse('Alice', 'Remember number 01000079031');
  assert.ok(res1.includes('Recorded 01000079031'));
  assert.equal(agyCalls[0].resumeFrom, undefined, 'First turn should not have resumeFrom');

  // Verify session is stored
  const session = await service.getAgentSession('Alice');
  assert.equal(session?.sessionId, 'conv-alice-42', 'Must store conversation_id in session store');

  // Turn 2
  const res2 = await service.generateResponse('Alice', 'Recall the number');
  assert.ok(res2.includes('The number is 01000079031'));
  assert.equal(agyCalls[1].resumeFrom, 'conv-alice-42', 'Second turn must carry resumeFrom conversation_id');
});

test('ChatService preserves Codex thread ID across multi-turn messages (TASK-29)', async () => {
  const codexCalls = [];
  const mockCodex = new CodexAdapter();
  mockCodex.buildSpawnArgs = (opts) => {
    codexCalls.push(opts);
    const args = ['exec'];
    if (opts.resumeFrom) {
      args.push('resume', opts.resumeFrom);
    }
    args.push('--json');
    return args;
  };

  const mockPty = {
    async executeCommand(binary, args, opts) {
      if (!args.includes('thread-dev-99')) {
        return {
          stdout: '{"type":"thread.started","thread_id":"thread-dev-99"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Code noted: 49281"}}',
          stderr: '',
          code: 0
        };
      }
      return {
        stdout: '{"type":"thread.started","thread_id":"thread-dev-99"}\n{"type":"item.completed","item":{"type":"agent_message","text":"The code was 49281"}}',
        stderr: '',
        code: 0
      };
    }
  };

  const service = new ChatService({
    liveProviders: true,
    adapters: { codex: mockCodex },
    ptyManager: mockPty,
    which: (bin) => bin === 'codex'
  });

  // Turn 1 on Dev-1
  const res1 = await service.generateResponse('Dev-1', 'Remember code 49281');
  assert.ok(res1.includes('Code noted: 49281'));
  assert.equal(codexCalls[0].resumeFrom, undefined);

  // Verify session is stored
  const session = await service.getAgentSession('Dev-1');
  assert.equal(session?.sessionId, 'thread-dev-99');

  // Turn 2
  const res2 = await service.generateResponse('Dev-1', 'What was the code?');
  assert.ok(res2.includes('The code was 49281'));
  assert.equal(codexCalls[1].resumeFrom, 'thread-dev-99', 'Second turn must carry resumeFrom thread_id');
});

test('ChatService parses real agy stream-json with result.response and step_update.text_delta', async () => {
  const chunks = [];
  const service = new ChatService({
    liveProviders: true,
    adapters: { agy: new AgyAdapter() },
    which: (bin) => bin === 'agy',
    ptyManager: {
      async executeCommand(_binary, _args, options) {
        const stream = [
          '{"event":"init","conversation_id":"conv-real-123","init":{"cwd":"/repo"}}\n',
          '{"event":"step_update","step_update":{"conversation_id":"conv-real-123","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"I am "}}\n',
          '{"event":"step_update","step_update":{"conversation_id":"conv-real-123","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Alice"}}\n',
          '{"event":"result","result":{"conversation_id":"conv-real-123","status":"SUCCESS","response":"I am Alice"}}\n'
        ];
        for (const line of stream) {
          options.onStdout(line);
        }
        return { stdout: stream.join(''), stderr: '', code: 0 };
      },
    },
  });

  const reply = await service.generateResponse('Alice', 'Who are you?', {
    onChunk: (chunk) => chunks.push(chunk),
  });
  assert.ok(reply.includes('I am Alice'));
  assert.equal(chunks.join(''), 'I am Alice');
  const session = await service.getAgentSession('Alice');
  assert.equal(session?.sessionId, 'conv-real-123');
});

test('ChatService filters stdin banners and reports clean error messages', async () => {
  const service = new ChatService({
    liveProviders: true,
    adapters: { codex: new CodexAdapter() },
    which: (bin) => bin === 'codex',
    ptyManager: {
      async executeCommand() {
        return {
          stdout: '{"type":"error","message":"{\\"type\\":\\"error\\",\\"error\\":{\\"message\\":\\"The model is not supported\\"}}"}\n',
          stderr: 'Reading additional input from stdin...\n',
          code: 1,
        };
      },
    },
  });

  await assert.rejects(
    service.generateResponse('Dev-1', 'Hello', { throwOnProviderError: true }),
    /The model is not supported/
  );
});

