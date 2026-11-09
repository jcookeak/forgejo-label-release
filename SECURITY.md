# Security policy

Security fixes target the latest stable release. Older versions are not maintained;
update to a reviewed full commit SHA from a packaged release. Workflow actions use
`owner/repo@SHA` references resolved by the Forgejo instance's configured default
action source, with version comments for Renovate digest updates.

## Trust boundary

Pull request validation executes contributor code, including dependency install
scripts. It uses a read-only token, checks out the immutable PR head from the base
repository's PR refs, does not persist checkout credentials, and never commits or
pushes formatting changes. Run `npm run format` locally before submitting changes.
The label check reads PR metadata without checking out contributor code.

Forgejo v17 [ignores job `permissions` declarations](https://forgejo.org/docs/v17.0/user/actions/github-actions/).
Its [automatic PR token restriction](https://forgejo.org/docs/v17.0/user/actions/security/#pull-requests)
comes from the `pull_request` event, not the YAML permission declaration. Keep
validation on that event; do not grant it personal tokens or additional secrets.

Approve fork runs only after reviewing the exact head commit and workflow changes;
review again after every update. Use disposable, isolated runners for untrusted
code, with no host mounts, privileged containers, reusable credentials, or access
to sensitive internal services. Keep release runners and credentials isolated from
PR runners. Token restrictions, fork approvals, network isolation, and runner
cleanup must be enforced by the Forgejo administrator; repository files cannot
prove the home runner settings.

Release workflows run trusted code from `main` or published releases. Only their
publication steps receive explicit write credentials; checkout does not retain
credentials for dependency installation or builds. The release job still has a
write-capable job token, so reviewed code and dependencies remain part of its trust
boundary. Do not run it against unreviewed PR code or with `pull_request_target`.

Treat workflow definitions, action inputs, release templates, and dependencies as
trusted configuration. In particular, `server-url` selects the API destination
that receives the token: use the intended trusted HTTPS Forgejo server and a token
scoped to the intended repository. Never derive it or other privileged workflow
inputs from untrusted PR metadata. Event fields and action outputs belong in action
inputs or environment variables, never interpolated into shell source. Validate
commit SHAs and refs before using them; floating tags resolve the published version
tag to a commit rather than following a mutable `target_commitish` branch.

## Reporting a vulnerability

For a suspected vulnerability, open an issue requesting a private reporting
channel without including sensitive details. Once a private channel is arranged,
include the affected version, reproduction, and impact. Do not post exploit
details or credentials in public issues before a fix is available.
