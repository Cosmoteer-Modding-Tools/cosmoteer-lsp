# Deployment

Two GitHub Actions workflows live in `.github/workflows/`:

| Workflow | Trigger | Secrets | What it does |
|----------|---------|---------|--------------|
| `ci.yml` | push to `master`, any pull request | none | Type-check, lint, server tests, package the VSIX, build the plugin. Safe on forks. |
| `release.yml` | push a `v*` tag, or manual dispatch | per environment | Build + verify both, attach to a GitHub Release, then publish behind approval gates. |

## How a release works

1. Bump the version in **both** places (they must match the tag):
   - `package.json` → `"version"`
   - `jetbrains/build.gradle.kts` → `version = "…"`
2. Update `CHANGELOG.md` and `jetbrains/CHANGELOG.md` (the plugin's change notes are read from the latter).
3. Commit, then tag and push:
   ```bash
   git tag v0.4.0
   git push origin v0.4.0
   ```
4. The `build` job runs, verifies the versions match the tag, runs the full plugin verifier, and creates a GitHub Release with the VSIX and the plugin zip attached.
5. The `publish-vscode` and `publish-jetbrains` jobs then wait for approval. Approve them from the run page (Actions → the run → *Review deployments*). Nothing reaches a marketplace until you click **Approve**.

A pre-release version such as `0.4.0-eap.1` publishes the plugin to an `eap` channel instead of the default one, keeping it off users' stable feed.

## Notes

- Actions are pinned to major version tags (`@v4`). For stricter supply-chain hardening you can
  pin them to full commit SHAs later.
- The publish jobs run only after `build` succeeds, so a failing verifier or a version mismatch
  blocks every marketplace call.
- To dry-run without a tag, use **Actions → Release → Run workflow** and enter the version. It still
  requires the environment approvals before publishing.
