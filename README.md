# label-release

A Forgejo action that cuts a new semver release based on the labels of pull requests merged since the previous release.

- Walks the commits between the previous release tag and the current commit, looks up their recorded Forgejo PRs, and reads each PR's labels.
- Picks the highest-priority bump that matches: `major` > `minor` > `patch`. If no labels match any of the configured lists, the action **skips** the release.
- Creates the tag and release in one step via Forgejo's release API. Optionally renders release notes from a GitHub-style `release.yml` template.

## Usage

```yaml
# .forgejo/workflows/release.yml
name: Release
on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-arm-latest
    permissions:
      contents: write
      pull-requests: read
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
      - uses: your-org/label-release@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          release-template: .forgejo/release.yml
```

### Inputs

| Input              | Default                                  | Description                                                                    |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `token`            | `$GITHUB_TOKEN` / `$FORGEJO_TOKEN`       | API token with `contents: write` and PR read access.                           |
| `server-url`       | `$GITHUB_SERVER_URL`                     | Forgejo base URL.                                                              |
| `repository`       | `$GITHUB_REPOSITORY`                     | `owner/repo`.                                                                  |
| `target-commitish` | `$GITHUB_SHA`                            | The commit/branch the release should point at.                                 |
| `major-labels`     | `breaking,major,semver:major`            | Comma- or newline-separated labels that trigger a major bump.                  |
| `minor-labels`     | `feature,enhancement,minor,semver:minor` | Labels that trigger a minor bump.                                              |
| `patch-labels`     | `bug,fix,patch,semver:patch`             | Labels that trigger a patch bump.                                              |
| `tag-prefix`       | `v`                                      | Prefix prepended to generated tags.                                            |
| `release-template` | `.forgejo/release.yml`                   | Path to a GitHub-style changelog config (see below). Missing file = flat list. |
| `draft`            | `false`                                  | Create the release as a draft.                                                 |
| `prerelease`       | `false`                                  | Mark the release as a prerelease.                                              |
| `dry-run`          | `false`                                  | Compute the bump and notes but skip the API call.                              |

### Outputs

| Output         | Description                                          |
| -------------- | ---------------------------------------------------- |
| `released`     | `true` if a release was created, `false` if skipped. |
| `tag`          | The tag that was (or would have been) created.       |
| `previous-tag` | The previous release tag used as the baseline.       |
| `bump`         | `major`, `minor`, `patch`, or `none`.                |
| `notes`        | The rendered release notes.                          |

The runner must provide a writable `GITHUB_OUTPUT` file (or `FORGEJO_OUTPUT`
as a fallback). The entry point checks this before release processing; legacy
stdout output commands are not supported. See [SECURITY.md](SECURITY.md) for
workflow trust boundaries and safe runner configuration.

## Bump rules

1. Discover the baseline: latest non-prerelease release, or the highest-semver tag if no release exists, or `v0.0.0` if neither.
2. Walk the exact local Git range `baseline-tag..target-commitish`. Look up each full SHA through Forgejo's commit-to-PR endpoint and deduplicate PRs. Ordinary commits are ignored; commit messages are never parsed. If there is no baseline (including `baseline-tag: none`), only merged PRs whose merge SHA is reachable from `target-commitish` are considered, using the local Git history.
3. Collect the labels of every PR. Pick the highest matching bump (major → minor → patch). Label matching is case-insensitive.
4. If nothing matches, exit with `released=false` and `bump=none`. Otherwise apply the bump to the baseline and create the release.

### Automatic discovery checkout requirements

Automatic discovery requires Git on `PATH` and a checkout of
`repository` in `$GITHUB_WORKSPACE` (or the current working directory outside
Actions). Use `actions/checkout` with `fetch-depth: 0`, and ensure the requested
`target-commitish` and baseline tag (when present) are available locally, with both
complete histories. For a branch name, the local branch must
point at the intended commit; an immutable SHA avoids ambiguity.

Without a baseline, the action walks the target's complete ancestry, including the target itself, and
matches Forgejo PR merge SHAs against it. A generated artifact/build commit works
when it descends from the source history. PRs on unrelated branches and PRs merged
after the target are excluded even if their labels would request a larger bump.
No matching PRs means no release. This does not depend on PR numbers in commit
messages or on the target itself being a PR merge commit.

Missing targets, shallow checkouts, unreadable history, and merged PRs with missing
or invalid merge SHAs fail with an error; discovery never falls back to every PR.
No automatic fetch is performed. Explicit `pull-request-numbers` selection does
not require local ancestry or the commit-to-PR endpoint.

With a baseline, discovery uses commits reachable from the target but not from
the baseline **tag**, including all parent paths. Release `target_commitish`
metadata (which can be a moving branch) does not define the baseline boundary.
Old and current artifact commits can be siblings off source history: old source
ancestors are excluded, new source merges are included, and unassociated artifact
commits are ignored. No special parent inference or merge-time ordering is used.
Missing history fails instead of returning a truncated range.

Baseline discovery requires **Forgejo 17 or newer** and repository/code read
access. It checks the Forgejo version and repository access, then calls
`GET /api/v1/repos/{owner}/{repo}/commits/{sha}/pull` in the PR's base repository.
This returns one PR for the exact stored merge-result SHA, including recorded
squash/rebase results. It does not identify arbitrary PR member commits, externally
merged PRs without a recorded association, or every PR if several share one SHA.

A lookup 404 is accepted as no association only after the same commit can be read
through the repository's Git API. Push generated artifact commits before discovery;
a local-only commit, wrong repository, or inaccessible code must fail. Authentication,
network and other API errors propagate. Unsupported versions fail explicitly;
there is no fallback to message parsing or repository-wide PRs. A server/proxy
that advertises a supported version but hides only the lookup route behind 404
cannot be distinguished from missing associations; the standard Forgejo API routes
must be exposed unchanged.

The Forgejo 17 [compare handler](https://codeberg.org/forgejo/forgejo/src/tag/v17.0.0/routers/api/v1/repo/compare.go)
uses PR comparison machinery and offers no pagination parameter or continuation
contract. Local complete ancestry avoids depending on compare response completeness
or compare-route permissions for release membership.

## Release notes template

The template follows GitHub's [automatically generated release notes configuration](https://docs.github.com/en/repos/releases/automatically-generated-release-notes#configuration-options):

```yaml
# .forgejo/release.yml
changelog:
  exclude:
    labels: [skip-changelog, dependencies]
    authors: [forgejo-actions]
  categories:
    - title: Breaking Changes
      labels: [breaking, semver:major]
    - title: New Features
      labels: [feature, enhancement, semver:minor]
    - title: Bug Fixes
      labels: [bug, fix, semver:patch]
    - title: Other Changes
      labels: ["*"]
```

- PRs are placed into the **first** category whose labels match.
- `"*"` matches any PR that wasn't claimed by an earlier category.
- `exclude.labels` / `exclude.authors` can be set at the root (drops the PR entirely) or on a single category (drops the PR only from that category).
- If no template is present, notes are a flat bullet list of all included PRs.

## Development

Requires Node 24.

```bash
npm install
npm run typecheck   # tsc
npm test            # vitest
npm run smoke       # end-to-end with a mock Forgejo server
npm run build       # tsc + ncc → dist/index.js (release workflow only)
```

Source layout:

```
src/
  index.ts          entry point
  main.ts           orchestrator (injectable clientFactory for testing)
  runtime.ts        Runtime abstraction + ActionRuntime (inputs/outputs/logs/files)
  inputs.ts         parse + validate action inputs
  forgejo.ts        ForgejoClient interface + HTTP implementation
  prs.ts            exact commit association and merge-SHA PR discovery
  ancestry.ts       complete local history and baseline reachable-set difference
  semver.ts         parseSemver / applyBump / decideBump / pickLatest
  release-notes.ts  parseTemplate + renderNotes
  types.ts          shared types
tests/              unit tests per module + main() with a fake client
scripts/smoke.ts    spins up a mock Forgejo server and exercises the full flow
```

### Repository self-release and mirrors

The action self-releases on pushes to `main` via `.forgejo/workflows/release.yml`.
After building, the workflow runs the **local built action** in `dry-run` mode at
the immutable source SHA. This preserves the complete source range for PR discovery.
No matching bump means no branch, tag or release writes.

For a planned `vX.Y.Z`, the workflow creates `releases/vX.Y.Z` with a single build
commit directly above that source SHA, containing generated `dist/` and
`.forgejo/self-release-plan.json`. This repository-specific metadata records the
source, exact version, notes, bump and baseline. The local action then publishes
that exact plan at the artifact SHA with `publish-tag`; floating `vX` and `vX.Y`
tags move only after successful publication. Source `main` stays free of build
commits. Use a version tag when consuming the action; `@main` is not packaged.

Mirror **both branch and tag refs**: `refs/heads/main`, `refs/heads/releases/*`,
and `refs/tags/*`. Mirroring release branches alone does not mirror version or
floating tags. Configure the destination to accept floating tag updates. Existing
`release-artifacts`, historical commits and version tags remain intact; this is
an additive layout change, with no migration rewrite or deletion.

Forgejo 17 supports workflow-level `concurrency`. Both publication workflows use
one repository-wide group with `cancel-in-progress: false`. The instance must keep
`[actions].CONCURRENCY_GROUP_QUEUE_ENABLED = true` (the default); this is implemented
in Forgejo's [workflow concurrency handling](https://codeberg.org/forgejo/forgejo/src/tag/v17.0.0/services/actions/workflows.go)
and [instance configuration](https://codeberg.org/forgejo/forgejo/src/tag/v17.0.0/modules/setting/actions.go).
This serialization covers planning through floating tags. Administrators must
preserve that setting and serialize any manual publishers with these workflows;
YAML cannot enforce instance settings or lock out external writers.

Retries must rerun the **same source SHA**. Before recalculating anything, the
workflow finds that source's version branch and recovers its original plan,
including after a successful publication whose response was lost. It rebuilds and
compares the entire artifact tree and the exact single source parent. Matching
contents reuse the existing commit despite different build-commit timestamps.
Changed artifacts, notes, ancestry, malformed metadata, or multiple plans for one
source fail for manual reconciliation. A failed build before a branch exists has
not reserved a version. Recover failed publications before advancing to newer
sources; do not relabel PRs or delete branches/tags to manufacture another version.

Version branches use an **absent-ref lease**: even a fast-forward cannot overwrite
an existing version branch. A creation race loser fails without publishing; rerun
it to reconcile a matching winner. The release API rejects conflicting version
tags/releases. Git push and release creation are separate operations: failure may
leave a recoverable branch, an orphan version tag, or a published release awaiting
aliases. There is no automatic deletion or rollback. Resolve conflicts explicitly;
do not force-push a version branch. Aliases use compare-and-swap pushes, skip an
older version when a newer version tag exists in the same alias series, and may
be partially updated if one push fails; rerunning completes them. These guards
limit race damage but do not replace the queue or serialize API and Git writes.

## Calculate first, publish later

The action is stateless: it creates no plan files or Git commits. Use the existing
`dry-run` outputs, then pass the chosen tag and notes back when artifacts are ready.

```yaml
- uses: ./label-release
  id: version
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    baseline-tag: v1.4.2
    pull-request-numbers: "42,43"
    target-commitish: ${{ github.sha }}
    major-labels: breaking
    minor-labels: enhancement
    patch-labels: bug,dependency,non-functional
    dry-run: "true"

# The consumer validates and publishes its artifacts here.
- uses: ./label-release
  if: steps.version.outputs.tag != ''
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    publish-tag: ${{ steps.version.outputs.tag }}
    release-notes: ${{ steps.version.outputs.notes }}
    target-commitish: ${{ github.sha }}
```

`baseline-tag` selects a stable baseline explicitly; `none` means no prior release.
Omit it to discover the baseline from repository releases and tags. An explicit baseline lets a
v1 maintenance branch ignore newer v2 releases. `pull-request-numbers` requires an
explicit baseline and accepts the merged PRs already verified by the consumer.
Omit documentation from the impact-label lists to skip documentation-only changes.

`publish-tag` accepts a stable SemVer tag and requires an immutable target commit
SHA. It uses `release-notes` directly, without recalculating either value. Repeating
the same publication succeeds; conflicting commits, notes or release flags fail.
Matching orphan tags and lost successful create responses are reconciled. Existing
one-step consumers continue to work unchanged.

Consumers must serialize releases and own any artifact recovery. There is no plan
schema, local release state, artifact metadata format, or special `next` channel in
this action. Preview aliases belong to the image workflow and storage provider.
