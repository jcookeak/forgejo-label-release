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
2. Walk the commits between the baseline tag and `target-commitish`. Extract PR numbers from squash-merge trailers (`… (#N)`) and merge commits (`Merge pull request #N`). If there is no baseline, every merged PR is considered.
3. Collect the labels of every PR. Pick the highest matching bump (major → minor → patch). Label matching is case-insensitive.
4. If nothing matches, exit with `released=false` and `bump=none`. Otherwise apply the bump to the baseline and create the release.

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
npm run build       # tsc + ncc → dist/index.js (commit the result)
```

Source layout:

```
src/
  index.ts          entry point
  main.ts           orchestrator (injectable clientFactory for testing)
  runtime.ts        Runtime abstraction + ActionRuntime (inputs/outputs/logs/files)
  inputs.ts         parse + validate action inputs
  forgejo.ts        ForgejoClient interface + HTTP implementation
  prs.ts            commit-walk PR discovery
  semver.ts         parseSemver / applyBump / decideBump / pickLatest
  release-notes.ts  parseTemplate + renderNotes
  types.ts          shared types
tests/              unit tests per module + main() with a fake client
scripts/smoke.ts    spins up a mock Forgejo server and exercises the full flow
```

The action self-releases on every push to `main` via `.forgejo/workflows/release.yml`, which invokes `uses: ./`. `dist/` is committed and CI fails if it's out of sync with source.
