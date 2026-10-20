# Short-term memory

Append-only working log. One `## YYYY-MM-DD` section per day, newest at the
bottom. Write here freely and without judgement — cheap to add, cheap to throw
away.

Agents read the **recent** sections at session start, not the whole file. That
window is the point: it keeps session cost flat no matter how long the project
runs.

## 🧹 Archiving

This file is cleaned up periodically, never truncated:

1. Move old day sections into a new file in `docs/memory/archived/`, named
   `session_YYYY_MM_DD.md`.
2. Clear those sections from **Active logs** below.
3. Link the new file under **Archive index**.

The archive keeps the complete, untouched context of past conversations —
deleting is what this policy exists to prevent.

## Archive index

<!-- One link per archived session, newest last. -->

- [session_2026_08_22](archived/session_2026_08_22.md) — memory layer moved
  under `docs/memory/`; AGENTS.md became the only rules file (0.5.0).
- [session_2026_09_12](archived/session_2026_09_12.md) — grill session on the
  CLIProxyAPI + Hermes design doc; produced decision-1 and decision-2.

## Active logs

<!-- Day sections follow. Append today's notes under `## YYYY-MM-DD`. -->

## 2026-10-20

Updated the HTTP API test server fixture to pass `repoPath: tmpDir`, keeping
`task.create` and `idea.promote` test writes inside the temporary repository.
Verified the HTTP API and phase-6 functionality suites; checked for generated
untracked backlog task files.

## 2026-10-18

Session opened by loading long-term memory, recent short-term memory, and the
product/architecture docs. Current worktree is clean; latest recorded state is
the live repository data feed with 75 passing tests. No implementation task has
been selected yet.

## 2026-09-19

Design session that reversed decision-1: **we build the orchestrator, not
Hermes.** The forcing requirement is human takeover of a running session, which
is impossible when another program owns the session internally.

The full argument now lives in `backlog/decisions/`, so read decision-3 through
decision-6 rather than re-deriving it here. What is worth keeping loose:

- Both `claude` and `agy` expose the same shape: `--session-id <uuid>`,
  `--resume`, `--input-format stream-json`, `--output-format stream-json`, and
  lifecycle hooks. That convergence is what makes one supervisor viable.
- `Notification` hook types include `agent_needs_input`, `permission_prompt`
  and `idle_prompt`, so "the agent is stuck asking a question" arrives as a
  push rather than an inference.
- Traps found while reading the docs, all recorded in decision-3: never pass
  `--bare` (it skips hook discovery); keep the watchdog above
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`; check a child-written nonce rather
  than a pid.
- Terms sweep stands: no vendor credentials anywhere near CI, and no exposed
  endpoint at all (decision-2, decision-6).

**Written up and committed:** decision-1 superseded, decision-2 revised and
accepted, decision-3 to decision-6 written and accepted, board seeded with
task-1 through task-9 where task-1 is the gating spike. MEMORY.md decision 4
corrected (permitted CLI, not install rights) and distilled back under its
line cap. Gemini stays as a mocked adapter for legacy corporate users, shipped
unverified until someone records a real session.


## 2026-10-11

Implemented the documentation plan from the October design interview; application
implementation remains future work. Added detailed `docs/PRD.md` and `docs/TRD.md`:
role contracts, setup/settings, session control, handoffs, popup change tracking,
worktrees/integration, memory/skills, dashboard suite, metrics, diagnostics, and
requirement-to-test traceability.

Preserved the September `PRODUCT.md` body under
`docs/archive/PRODUCT-supervisor-2026-09-19.md`. `PRODUCT.md` now preserves its old
numbered headings as mappings into the new documents; README distinguishes the
built installer/watcher from the proposed workspace.

Corrections to September assumptions: provider protocols are not interchangeable;
internal session IDs differ from native IDs; Gemini streaming output does not prove
interactive control. Earlier claims about provider retirement/account terms are
historical and must be freshly verified before use. Human takeover allows
human-directed tools. Frontend dependencies are allowed; full autopilot may apply
memory proposals, while diagnostic governing-rule changes still need human approval.

Provider requirement is now agy + Codex + Gemini; no authenticated provider tests or
Gemini install performed during documentation work. Proposed engineering defaults
(Node 24, React/TypeScript/Vite, HTTP/SSE, database worker) are labeled proposals,
not interview-selected technology. Existing package/runtime behavior is unchanged.

Backlog CLI absent from PATH. Temporary Backlog.md 1.52.0 installation used for task
and decision records; its bookkeeping requires writes under `.git/backlog.md`.
Existing untracked `package-lock.json` is unrelated and left untouched.

Decision-7 records accepted product changes and explicit supersessions of
September assumptions; decision-8 records the proposed technical baseline.
Documentation task: task-12. Validation passed: local links/anchors, balanced
code fences, all 54 requirement mappings and 16 acceptance scenarios, all 57
legacy numbered headings preserved, historical spec body byte-for-byte in the
archive, long-term memory at 200 lines, and `git diff --check`. No application
tests/CI run: documentation-only changes and no existing suite/workflow.

Verified PRD and TRD documents against the Codex design transcript; confirmed
full coverage of team contracts, provider qualifications, popup tickets, and
dashboards. Opened PR #7 for AI Team Workspace documentation.

Executed full TDD implementation across all 12 tasks in milestone m-1 (TASK-13
through TASK-24). Built ProviderPlugin adapters (agy, Codex, Gemini), MockCLI test
harness, WorkspaceManager with 13 agent identities, TurnScheduler with 4-concurrency
limit, TakeoverController, RequirementsManager, TaskLifecycleManager with Architect
gates, QualityVerificationManager with commit-bound approvals, IntegrationStrategyManager,
PopupScopeChangeEngine, VirtualTeamRoom, ObservabilityEngine, and IterationRunner.
All 31 unit, contract, and integration tests passing green.

Executed full TDD implementation for milestone m-2 (TASK-25, TASK-26, TASK-27):
built SupervisorServer HTTP/SSE daemon implementing TRD §12 (/api/v1/workspace,
/readiness, /settings, /agents, /tasks, /popups, /metrics, /commands, /events),
interactive Web UI single-page dashboard bundle in src/server/public/ with
4x4 isometric Virtual Team Room, Kanban board, takeover console, and observability,
and added `agentcrew server [port]` CLI command to bin/wizard.js and npm run server.
All 49 unit, contract, and integration tests passing green.

Implemented authentic 2.5D pixel-art isometric virtual room in `src/server/public/pixel-room.js`
with PixelRoomRenderer: 6x6 isometric floor tiles, office walls, window skyline,
water cooler, potted plants, server rack, 13 custom workstation desks with glowing screens,
custom pixel avatars with role-themed attire, animated speech/activity bubbles,
and interactive hover/click inspector. 50 tests passing green.

Revamped Web UI dashboard with Impeccable design standards: left sidebar navigation
with brand header and stream telemetry; dual theme support (light as default, dark
toggleable) with CSS design tokens and localStorage persistence; theme-adaptive
PixelRoomRenderer palettes (light parquet/office walls vs dark cyber-office); and
creative free SVG vector icons throughout sidebar and full-screen view headers.
All 50 unit and integration tests passing green.

Integrated complete modern Analytics Dashboard style & data architecture:
built typed `src/server/public/analytics-dashboard-data.ts` and `.js` with all 13
agent identities, KPI metrics with sparklines and rolling slot-machine values,
SVG activity & commit chart, searchable repositories/worktrees grid, and
Code Review queue with docked/sliding PR details panel (problem, approach, stats)
and interactive AI Assistant Q&A composer with thinking shimmer. Added Settings
appearance accent color switcher (blue, violet, teal, amber). All 51 tests passing green.

Configured `docs/assets/logo.jpeg` as the official web application logo and favicon:
added JPEG MIME type mapping to `SupervisorServer`, updated `.brand-icon` and
`<link rel="icon">` in `index.html`, and added test assertions. 52 tests passing green.

Closed GitHub Issue #8 (Spec: AI Team Workspace v1) following merge of PR #7 to main.
Added `agentcrew iterate [goal]` CLI command in `bin/wizard.js` orchestrating full 13-agent
iteration lifecycles. Connected interactive operator command execution bar in Web UI
Takeover Console (`session.exec`) streaming outputs directly to the terminal log.
All 53 unit, contract, and workflow tests passing green.

Created branch `feat/dogfooding-and-packaging` to support self-hosting / dogfooding:
- Added `importFromBacklog()` to `RequirementsManager` and connected `--from-backlog` flag to
  `agentcrew iterate` in `bin/wizard.js` and `IterationRunner`, dynamically executing pending
  tasks directly from `backlog/tasks/*.md`.
- Verified `npm pack` tarball contents: all Web UI static assets, pixel-room engine, logo.jpeg,
  and scripts are properly bundled.
- Tested installation of packaged tarball (`agentcrew-0.5.0.tgz`) into an external isolated
  repository (`/tmp/external-agentcrew-test`): executed `npx agentcrew iterate` and verified
  `SupervisorServer` serves Web UI and `logo.jpeg` with HTTP 200. 54 tests passing green.

Reconciled backlog and implemented WebSocket PTY interface on branch `feat/pty-terminal-and-cleanup`:
- Reconciled obsolete September prototype tasks (TASK-1 through TASK-10) marking them Done
  with label `superseded` and linking to Decision-7/8 and tasks TASK-13..27.
- Built native RFC 6455 `WebSocketConnection` (`src/server/websocket.js`) with zero dependencies.
- Built `PtyManager` (`src/session/pty-manager.js`) spawning interactive pseudo-terminal shells
  and piping bidirectional stdin/stdout streams.
- Upgraded `SupervisorServer` to accept WebSocket upgrade requests on `/api/v1/pty?agent_id=...`.
- Integrated live WebSocket PTY streaming in Web UI Takeover Console (`src/server/public/app.js`),
  attaching on takeover acquisition and disconnecting on release.
- Created TASK-28 in backlog and verified all acceptance criteria.
- Added comprehensive unit and contract tests in `test/server/pty-terminal.test.js`.
- All 56 tests passing green.

Connected Code Review Assistant directly to live agent backend (`feat/live-agent-ask-endpoint`):
- Added `agent.ask` command handler in `SupervisorServer` (`src/server/supervisor-server.js`)
  dispatching questions to targeted agent identities (Arthur Architect, QA Lead, or PR Author).
- Connected Web UI Code Review Drawer (`src/server/public/app.js`) to POST `/api/v1/commands`
  with `command_type: 'agent.ask'`, passing PR number, title, question, and author.
- Added automated contract test in `test/server/http-api.test.js`.
- All 57 tests passing green.

Piped chat boxes across Web UI to real CLI execution (`feat/pipe-all-chats-to-cli`):
- Added `execute(command)` to `PtyManager` executing commands in child shell processes with real stdout/stderr capture and timeout management.
- Connected `session.exec` and `agent.ask` in `SupervisorServer` to execute against real shell process and active PTY sessions in the repository workspace.
- Grounded PR review responses with live git verification data (`git log -n 1 --oneline`) and active terminal notifications.
- All 57 tests passing green.

Connected Takeover Console to Agent Persona Reasoning & Fixed Terminal Output:
- Diagnosed takeover chat silence: interactive bash child process was interpreting natural language text like "Hi" as missing shell binaries without conversational reasoning, while ANSI/OSC terminal escape sequences (`]2;...`, `]7;...`) cluttered the web terminal.
- Implemented `generateAgentResponse(agentId, prompt)` in `SupervisorServer` (`src/server/supervisor-server.js`):
  - Automatically identifies whether an input is a standard shell command (`ls`, `git`, `cd`, `npm`, etc.) or conversational dialogue.
  - Generates specialized role responses for Alice (Business Analyst), Peter (Product Owner), Arthur (Architect), Dev-1..Dev-4 (Developers), QA-1..QA-4 (Testers), and Integrators grounded with live git commit state.
  - Emits real-time SSE `agent_answered` events updating visual speech bubbles over agent characters in the 2.5D Isometric Team Room.
- Sanitized raw ANSI escape sequences and OSC window title/CWD escape codes in `app.js` (`ptySocket.onmessage`).
- Fixed `loadReadiness()` in `app.js` and `GET /api/v1/readiness` to gracefully supply `qualified_providers`, resolving the `forEach of undefined` client error.
- All 58 tests passing green (`npm test`). Server running cleanly on `0.0.0.0:3000`.

### 2026-10-11 (late) — real CLI chat + findings for next session

Chat in the Takeover Console is now backed by real `agy`/`codex` (was canned text — "Requirement review noted…" was a hardcoded template). Failover agy→codex; if all fail the real error is shown. 58 tests green; `liveProviders:false` keeps tests offline.

Gotchas worth remembering:
- `PtyManager.execute` must `stdin.end()`: `codex exec` waits on piped stdin ("Reading additional input from stdin…") and times out otherwise.
- `agy` hit quota 429 (resets ~9 min) mid-session; chat silently needed codex. `gemini` CLI is not installed.
- `codex exec` stdout = answer only; banner is on stderr.
- Direct pushes to main happened this session (no PR); no `.github/workflows` exists.

Next-session todo (all in backlog, high first):
- TASK-29 persistent per-agent sessions (multi-turn memory)
- TASK-30 ChatService behind ProviderPlugin + TurnScheduler (remove `generateAgentResponse` from supervisor-server)
- TASK-31 Code Review `agent.ask` still templated
- TASK-32 takeover is cosmetic (global state, 20ms fake wait, fresh bash not agent session)
- TASK-33 chat-vs-shell regex is fragile ("find the riskiest module" runs `find`)
- TASK-34 provider health/quota UX; readiness hardcodes "ready"
- TASK-35 streaming replies + typing state
- TASK-36 ops: LAN/cloudflared over localtunnel, CI workflow, no direct pushes to main

Implemented TASK-30 (`feat/task-30-chatservice-plugin-scheduler`):
- Extracted deep `ChatService` module (`src/chat/chat-service.js`) with PRD §6 role contracts (BA, PO, Architect, Developer, Tester, Integrator) and grounding in repo Git commits.
- Enforced global 4-turn concurrency ceiling via `TurnScheduler.enqueue`.
- Used `AgyAdapter` and `CodexAdapter.buildSpawnArgs()` directly with clean binary spawn in `PtyManager.executeCommand` without shell string concatenation.
- Normalized Codex JSONL stream events supporting both `item.completed` and `item_completed`.
- Safely handled provider model selection (avoiding invalid `gemini-2.5-pro` on `agy` and unsupported `o3` on ChatGPT accounts for `codex`, preserving automatic defaults).
- Completely removed `generateAgentResponse` from `SupervisorServer` and delegated to `chatService.generateResponse`.
- Added unit tests in `test/chat/chat-service.test.js`. All 62 unit and integration tests passing green.

Implemented TASK-29 (`feat/task-29-persistent-agent-sessions`):
- Added `provider_sessions` table in SQLite (`src/workspace/manager.js`) with `saveAgentSession` and `getAgentSession`.
- Maintained in-memory and database session mapping in `ChatService` (`this.sessionCache`).
- Automatically extracted `conversation_id` from `agy` (`--output-format json`) and `thread_id` from `codex` (`thread.started`).
- Re-passed `resumeFrom` on follow-up chat turns via `agy --conversation <id>` and `codex exec ... resume <thread_id>`.
- Verified live end-to-end memory recall across multi-turn chats:
  - Alice recalled secret number `01000079031` on turn 2.
  - Dev-1 recalled build token `alpha-9482` on turn 2.
- Added comprehensive unit and contract tests in `test/chat/chat-service.test.js` and `test/workspace/manager.test.js`.
- All 65 unit, contract, and workflow tests passing green (`npm test`).
Implemented Live Repository Data Feed (`feat/live-repository-data-feed`):
- Created deep `RepoDataService` (`src/server/repo-data-service.js`):
  - Parsed all real tasks from `backlog/tasks/*.md` (35 tasks: 29 Done, 6 To Do/Planning) with YAML frontmatter mapping to Kanban stages (`planning`, `in_progress`, `review`, `qa`, `done`), priority badges, and crew identity owners.
  - Queried real pull requests from `gh pr list` (#15, #14, #13, etc.) with additions, deletions, branch names, and extracted Problem and Approach sections from PR markdown bodies; provided git merge fallback.
  - Inspected live repository state via git commands: repository name, active branch (`feat/live-repository-data-feed`), active worktrees count, working tree clean/modified status, and last commit timestamp.
  - Aggregated live analytics & KPIs: delivered task count (29 tasks), active turn concurrency from `TurnScheduler`, line counts (+44k / -3.9k).
- Added endpoints in `SupervisorServer` (`src/server/supervisor-server.js`):
  - `GET /api/v1/tasks`: returns real backlog tasks array.
  - `GET /api/v1/pull-requests`: returns live PR array.
  - `GET /api/v1/repositories`: returns active repositories & worktrees.
  - `GET /api/v1/analytics`: returns live KPIs and engineering metrics.
- Updated Web UI client (`src/server/public/app.js`):
  - Connected `loadTasks()` to `/api/v1/tasks` dynamically populating Kanban board columns.
  - Added `loadRealRepositoryData()` fetching `/api/v1/pull-requests`, `/api/v1/repositories`, and `/api/v1/analytics`.
  - Added author avatar fallback using Dicebear bots seed for GitHub logins (`inegmdev`, `Claude`).
- Added unit and contract tests in `test/server/repo-data-service.test.js` and `test/server/http-api.test.js`.
- All 75 tests passing green (`npm test`). Server daemon restarted and serving live data on `http://127.0.0.1:3000`.

## 2026-10-12

Updated the cloud checkout from the older installer-only snapshot to current `main`
(`7eb5c0b`) and ran the real AgentCrew AI Team Workspace through an HTTPS
Tunnelmole endpoint. Reworked the dashboard for mobile and tablet use while
preserving the desktop visual system: sticky mobile app bar, five-destination
bottom navigation, accessible secondary-navigation drawer, safe-area support,
44px touch targets, responsive KPI and content grids, roster-first Team Room,
swipeable Kanban columns, and an accessible pull-request details bottom sheet.
Added reduced-motion behavior and fixed narrow-screen wrapping/overflow in the
review assistant. Chromium checks at 320, 390, 768, 1024, and 1440px found no
document overflow; all 75 tests and the focused 8-test UI bundle suite passed.
Added a compact motion system for directional view changes, mode and analytics
refreshes, theme changes, tap feedback, navigation state, and interruptible
drawer/review-sheet transitions, with a reduced-motion path. Fixed the mobile
review sheet's minimum width so its close control stays on-screen and works at
phone widths.

## 2026-10-16

Compared AgentCrew's Team Room with the live AgentsRoom demo and reshaped the
default view into a status-grouped agent roster with search and filters beside
a selected-agent workspace, session output, takeover controls, and prompt
composer. Kept the isometric map available as a secondary view. Connected roster
status and takeover ownership to the live agent API, used local initials instead
of remote avatar images, and checked desktop and phone layouts with Playwright.

## 2026-10-18

Implemented TASK-31 on `feat/task-31`: Code Review `agent.ask` obtains selected
PR metadata and diff from `gh`, supplies them to the provider-backed ChatService,
and surfaces GitHub/provider failures without generating fallback review text.
Drawer renders returned text safely. Added API/provider-path, provider-error,
ChatService context/error, and live PR-context tests. TRD §12 documents behavior.

TASK-36 makes `agentcrew server` bind to `127.0.0.1` by default; `--host` is
required for LAN binding. README documents LAN and email-protected Cloudflare Quick
Tunnel access, and the repository convention requires PRs for `main`. Added a
Linux pull-request workflow that runs `npm test`.

TASK-33 adds explicit Chat/Shell input routing in the Takeover Console. Chat is the
default; `!` forces one shell command. A shared `src/session/input-mode.js` resolver
serves WebSocket and HTTP session execution, and the server requires `human_owned`
before shell execution. PRD/TRD, UI, and routing/ownership tests updated.

TASK-34: readiness calls each provider adapter probe; reports distinguish
available, unavailable, and quota-limited, include a known reset time and
assigned agents, and the UI renders those states. Chat replies identify the
provider that answered, including after failover. Gemini remains explicitly
unavailable even when installed: the required roster-only delegation guard is
not verified in the official CLI contract. Assigned unavailable providers block
readiness; binary detection is not recorded as qualification.

TASK-35 adds incremental provider stdout callbacks through `PtyManager` and
`ChatService`, PTY WebSocket chat turn frames, and SSE room-thinking lifecycle
events. Thinking cleanup is idempotent across completion, failure/timeout, and
socket close. Provider output is line-normalized; exact delta event shapes remain
provider-dependent. The frame contract and UI behavior are recorded in PRD/TRD.
Cross-task review hardened same-origin/JSON command handling, prevented release
while a human chat turn remains active, and fixed a WebSocket mode-switch race.

Follow-up after mobile testing: QA-1/QA-2 remained Gemini-assigned despite no
qualified Gemini CLI, because ChatService silently fell back to agy; metadata-only
agy JSON was also displayed as chat. Replaced implicit routing with strict primary
and persisted opt-in per-agent backup provider/model. Native conversations are now
stored per provider. The browser takeover surface defaults to an interactive
node-pty/xterm CLI terminal with keystrokes, resize, mobile keys, and same-tab PTY
reattachment; Shell remains separate. Existing native IDs resume in a new process;
fresh TUI conversations are marked new and not claimed as resumable. Server startup
reuses the workspace database to preserve settings. Non-loopback HTTP remains an
explicit, unauthenticated short-lived test mode with a prominent warning.
Two-axis review corrected stale README routing prose and premature resume wording,
added Linux process-group exit confirmation, Windows fake takeover/WebSocket CI,
and prevented a parallel headless turn while an agent TUI is active. A newly
interactive conversation still lacks a reliable provider-native ID for later
resume; the limitation is explicit rather than silently claiming continuity.
Independent mobile UI review fixed hidden connection errors, stale Connected state,
xterm screen-reader mode, 44px touch keys, and the Ctrl-key latch. Browser smoke
confirmed a missing Gemini agent shows a visible unavailable reason and a fake
Codex PTY survives same-tab refresh, accepts input, and releases cleanly.

Created Milestone m-3 (AgentsRoom Cockpit & Specialist Store) and applied the
to-tickets skill to break down the product roadmap into 19 vertical-slice tickets
(TASK-37 through TASK-55). Implemented TASK-37 on branch
`feat/task-37-multi-project-registry`: established central master registry SQLite
database (`registry.db`) in `WorkspaceManager` with projects table (id, name, path,
mode: independent vs multi_worktree, zone: work/personal/side, is_active, created_at),
added `GET /api/v1/projects`, `POST /api/v1/projects`, and `POST /api/v1/projects/:id/activate`
routes on `SupervisorServer`, and verified multi-project registration, isolation,
and atomic context switching with 103 passing tests.

Implemented TASK-38 & TASK-39: styled dashboard with Dark Sea Blue oceanic palette,
added leftmost multi-project navigation dock grouped into zones (work/personal/side)
with instant workspace switching and glow badges. Implemented project onboarding wizard
modal with dual-mode selector (Independent Repo vs. Multi-Worktree mode). Integrated
TASK-46 pop-out terminal (`/terminal`) enabling detached floating xterm windows via
`window.open`. All 103 tests pass cleanly. Fired background test server on
`http://127.0.0.1:3000`.

## 2026-10-19

Audited current UI/backend for the Antigravity functionality planning handoff;
saved `docs/FUNCTIONALITY_PLAN.md` with control mapping, proposed endpoints,
implementation ownership/order and behavioral release gates. No application changes
made by this audit; existing dirty UI work preserved. Confirmed seeded demo chat,
sample task fallbacks, fabricated analytics/iteration evidence, unknown commands
accepted without execution, undefined parsedUrl in room message GET, unsafe content
interpolation and incomplete project-context switching. Node 24 baseline: all 103
tests pass, but current tests do not establish functional completeness. Requested
`codex exec -m sol-6` with medium effort failed because the model is unsupported
for the configured ChatGPT account; no independent CLI debate or Antigravity
agreement claimed. Implementation plan remains proposed, not an accepted ADR.

Redesigning AgentCrew Web UI to match the AgentsRoom Cockpit layout and Dark Sea Blue
aesthetic from the user's reference screenshot (`/home/inegm/Pictures/agentsroom.png`).
Implementing top navigation bar with project switcher and needs-input pill, 3-column
cockpit layout (categorized agent roster, center conversational feed with structured
tool execution cards and floating prompt composer, right vertical dock with 'FILES & CHANGES'),
bottom utility tabs (`Terminal`, `Commands`, `Servers`, `Databases`), and status footer.
Converted the remote HTTP unauthenticated warning into a dismissible security toast
notification with entrance/exit animation and sessionStorage persistence.

Audited browser screenshot (`/home/inegm/Pictures/sceenshot.png`) and fixed visual artifacts:
1. Added universal `[hidden] { display: none !important; }` in `style.css` so buttons and
   optional boxes (`#provider-backup-setting-box`, `#btn-takeover`, `#btn-release`,
   `#selected-agent-status`, hidden filters) never override HTML5 hidden attributes.
2. Filtered PTY socket reconnection/error logs so they stay inside the terminal emulator log
   rather than spamming `#team-room-chat-feed` as cards.
3. Added edge-to-edge cockpit layout overrides: hiding `.project-dock` and `.app-sidebar`
   in `#view-team-room` mode, clearing `.dashboard-container` padding and overflow, ensuring
   the full 3-column layout, bottom utility bar, and floating prompt composer are visible
   without vertical clipping or double sidebars.
4. Styled `.project-dock-tooltip` as an absolute floating hover tooltip to fix text overflow
   on project dock buttons.
5. Set `flex-wrap: nowrap` and `white-space: nowrap` on `.agent-name-line` to keep agent
   identity and role dropdowns neatly aligned on one line.
6. Harmonized application UI to Option A composition + LIX aesthetic:
   - Added interactive GPU WebGL holographic AI Orb (`src/server/public/ai-orb.js`)
     featuring fluid chromatic caustics, magnetic pointer follow, and tap ripple shockwaves.
   - Dialed active indicators from neon cyan to calm, solid matte cerulean blue (#0284c7)
     with zero glare, matching the reference inspiration.
   - Scaled element proportions down and opened spacious negative space across all views.
   - Retired redundant app-sidebar on desktop, elevating navigation to universal topbar tabs.
   - Restyled floating prompt composer with recessed dark glass and upward-arrow send button.
All 103 unit/integration tests pass. Restarted daemon on port 3000.






## 2026-10-20

Backend hardening and Phase 4/5 API work on the current shared AgentCrew worktree:
project-scoped jobs/sessions and cancellation, command job process limits, scheduler
pause isolation, session reset/cutoff handling, roster validation, bounded docs
reads, and project state endpoints for ideas, snippets, tasks, and diagnostics.
Added HTTP API regressions. Node 24 server tests pass: 54/54. Existing parallel
frontend and backend edits were preserved; frontend files were not changed here.

Frontend Phase 3–5 follow-up: updated cockpit Kanban stage extraction to recognize
`tasks-*` columns alongside `col-*`, registered the complete server SSE event list,
and added a functional-controls regression for clicking a `.task-item` in
`#tasks-in_progress`. Node 24 targeted test passes (7/7).

Added `test/server/phase6-full-functionality.test.js`, an acceptance suite for
disposable Git repositories, working/staged diffs, repository context, named job
execution and cancellation, roster/scheduler/content/preference commands, project
isolation, diagnostics, and static assets. Node 24 targeted run passes (6/6).
Fixed three backend project-switch/task-stage blockers: forced quiesce releases scoped scheduler holds, commands/room posts/PTY upgrades reject during teardown, and legacy backlog/todo stages normalize to planning across fallback, merged tasks, create, and promotion. Added regressions in HTTP API and Phase 6 suites; syntax checks pass. Existing UI and unrelated worktree edits preserved.

Closed the remaining project-switch admission race: command and room POSTs pin the
entry project before body parsing, recheck after parsing, and contribute to an
in-flight mutation count until completion. PTY upgrades recheck project identity
after async agent resolution; project activation rejects while any admitted mutation
is in flight. Added an HTTP API regression for a project change during body parsing.

Mobile terminal follow-up: restored user zoom in `/terminal`, routed xterm input
through the mobile Ctrl latch, resized the document to `visualViewport.height`
on viewport resize/scroll, and added a mobile workspace tools button. Expanded
`test/ui/mobile-ergonomics.test.js` for these behaviors and for the concurrent
responsive CSS requirements. Focused test currently awaits the parallel stylesheet
updates; the terminal and tools-button assertions pass.
