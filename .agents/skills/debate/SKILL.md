---
name: debate
description: Two-model debate review of a GitHub PR, GitLab MR, Azure DevOps PR, or local working tree, posted as inline comments or printed. Alias for debate-review.
license: MIT
compatibility: Requires Node 18+, Git 2.31+, `gh` (GitHub), `glab` (GitLab) or `az` (Azure DevOps) authenticated, and delegate-skills installed for the main/debate lanes.
metadata:
  version: 0.2.0
---

# debate

Two models argue before anything is posted or decided. A main reviewer finds issues. A debate reviewer tries to
knock them down and may add its own. The main reviewer then makes the final call.

Runs against PRs, MRs, or a local working tree (`--local`), or debates architectural plans.

## Run it

```bash
# Review current local repository branch / working tree with two debating models
node "<skill-dir>/../debate-review/scripts/review-pr.mjs" --local [--base <ref>]

# Review a live PR with two debating models
node "<skill-dir>/../debate-review/scripts/review-pr.mjs" <pr-url | number> [--dry-run]
```

See [debate-review](../debate-review/SKILL.md) for full documentation, schema, and contracts.
