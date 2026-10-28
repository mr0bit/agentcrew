const TEAM_PRESETS = {
  lean: {
    id: 'lean',
    name: 'Lean Dev & Test Squad',
    description: 'Fast, focused execution for small repos, prototypes, or single features. Low token overhead.',
    agentCount: 3,
    roster: [
      { name: 'Dev-1', role: 'Developer', provider: 'codex', model: 'gpt-6-luna', is_lead: true },
      { name: 'QA-1', role: 'Tester', provider: 'codex', model: 'gpt-6-luna' },
      { name: 'Integrator-1', role: 'Integrator', provider: 'codex', model: 'gpt-6-luna' }
    ]
  },
  agile: {
    id: 'agile',
    name: 'Agile Feature Team',
    description: 'Balanced team with backlog ownership, architecture review, dual developers, QA, and git integration.',
    agentCount: 6,
    roster: [
      { name: 'Peter', role: 'Product Owner', provider: 'agy', model: 'gemini-2.5-pro' },
      { name: 'Arthur', role: 'Architect', provider: 'codex', model: 'gpt-6-luna' },
      { name: 'Dev-1', role: 'Developer', provider: 'codex', model: 'gpt-6-luna' },
      { name: 'Dev-2', role: 'Developer', provider: 'codex', model: 'gpt-6-luna' },
      { name: 'QA-1', role: 'Tester', provider: 'agy', model: 'gemini-2.5-pro' },
      { name: 'Integrator-1', role: 'Integrator', provider: 'codex', model: 'gpt-6-luna' }
    ]
  },
  enterprise: {
    id: 'enterprise',
    name: 'Full Enterprise Crew',
    description: 'Autonomous 13-agent crew with full BA, PO, Architect, 4 Developers, 4 Testers, and 2 Integrators.',
    agentCount: 13,
    roster: [
      { name: 'Alice', role: 'Business Analyst', provider: 'agy', model: 'gemini-2.5-pro' },
      { name: 'Peter', role: 'Product Owner', provider: 'agy', model: 'gemini-2.5-pro' },
      { name: 'Arthur', role: 'Architect', provider: 'codex', model: 'gpt-6-luna' },
      { name: 'Dev-1', role: 'Developer', provider: 'codex', model: 'gpt-6-luna' },
      { name: 'Dev-2', role: 'Developer', provider: 'codex', model: 'gpt-6-luna' },
      { name: 'Dev-3', role: 'Developer', provider: 'agy', model: 'gemini-2.5-pro' },
      { name: 'Dev-4', role: 'Developer', provider: 'agy', model: 'gemini-2.5-pro' },
      { name: 'QA-1', role: 'Tester', provider: 'gemini', model: 'gemini-2.5-pro' },
      { name: 'QA-2', role: 'Tester', provider: 'gemini', model: 'gemini-2.5-pro' },
      { name: 'QA-3', role: 'Tester', provider: 'agy', model: 'gemini-2.5-pro' },
      { name: 'QA-4', role: 'Tester', provider: 'agy', model: 'gemini-2.5-pro' },
      { name: 'Integrator-1', role: 'Integrator', provider: 'codex', model: 'gpt-6-luna' },
      { name: 'Integrator-2', role: 'Integrator', provider: 'agy', model: 'gemini-2.5-pro' }
    ]
  }
};

function getRosterForPreset(presetId) {
  const preset = TEAM_PRESETS[presetId];
  return preset ? preset.roster : null;
}

module.exports = { TEAM_PRESETS, getRosterForPreset };
