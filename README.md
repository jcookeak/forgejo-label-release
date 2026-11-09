# label-release

A Forgejo action that cuts a new semver release based on the labels of pull requests merged since the previous release.

- Walks the commits between the previous release tag and the current commit, extracts the PR numbers, and fetches each PR's labels.
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

## Bump rules

1. Discover the baseline: latest non-prerelease release, or the highest-semver tag if no release exists, or `v0.0.0` if neither.
2. Walk the commits between the baseline tag and `target-commitish`. Extract PR numbers from squash-merge trailers (`… (#N)`) and merge commits (`Merge pull request #N`). If there is no baseline (including `baseline-tag: none`), only merged PRs whose merge SHA is reachable from `target-commitish` are considered, using the local Git history.
3. Collect the labels of every PR. Pick the highest matching bump (major → minor → patch). Label matching is case-insensitive.
4. If nothing matches, exit with `released=false` and `bump=none`. Otherwise apply the bump to the baseline and create the release.

### First-release checkout requirements

Automatic discovery without a baseline requires Git on `PATH` and a checkout of
`repository` in `$GITHUB_WORKSPACE` (or the current working directory outside
Actions). Use `actions/checkout` with `fetch-depth: 0`, and ensure the requested
`target-commitish` is available locally. For a branch name, the local branch must
point at the intended commit; an immutable SHA avoids ambiguity.

The action walks the target's complete ancestry, including the target itself, and
matches Forgejo PR merge SHAs against it. A generated artifact/build commit works
when it descends from the source history. PRs on unrelated branches and PRs merged
after the target are excluded even if their labels would request a larger bump.
No matching PRs means no release. This does not depend on PR numbers in commit
messages or on the target itself being a PR merge commit.

Missing targets, shallow checkouts, unreadable history, and merged PRs with missing
or invalid merge SHAs fail with an error; discovery never falls back to every PR.
No automatic fetch is performed. Explicit `pull-request-numbers` selection and
existing-baseline discovery do not require this local ancestry check.

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
  prs.ts            commit-walk and merge-SHA PR discovery
  ancestry.ts       complete local target history for first releases
  semver.ts         parseSemver / applyBump / decideBump / pickLatest
  release-notes.ts  parseTemplate + renderNotes
  types.ts          shared types
tests/              unit tests per module + main() with a fake client
scripts/smoke.ts    spins up a mock Forgejo server and exercises the full flow
```

The action self-releases on every push to `main` via `.forgejo/workflows/release.yml`.
The workflow builds `dist/` on the `release-artifacts` branch and creates version
tags from that generated commit. Use a version tag when consuming this action;
`@main` is not a packaged release.

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
