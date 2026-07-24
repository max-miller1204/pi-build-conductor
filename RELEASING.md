# Releasing pi-build-conductor

This project uses Semantic Versioning, generated GitHub release notes, immutable Git tags, and an intentionally gated npm publication workflow.
Do not create or manually maintain a `CHANGELOG.md`.

## Version policy

Before 1.0, incompatible behavior, protocol, run-schema, plan-schema, security-policy, or command changes require a minor version bump.
Backward-compatible features also normally use a minor bump while the package remains below 1.0.
Backward-compatible fixes use a patch bump.
Prereleases use standard identifiers such as `1.0.0-beta.1` or `1.0.0-rc.1`.

The supported Pi and server versions are release metadata, not loose compatibility promises.
A change to `conductorCompatibility` must be reviewed with the adapter, compatibility tests, workflows, README matrix, and security policy.

## Prepare a release

Start from a clean, current `main` branch:

```sh
git switch main
git pull --ff-only
npm ci --ignore-scripts
npm run release:check
```

Choose the version and update both package files without creating a tag:

```sh
npm version patch --no-git-tag-version
# Use minor, major, or an exact prerelease version when appropriate.
npm run version:check
```

Submit the package and lockfile change through a pull request.
Wait for CI and the compatible-server workflow to pass on the merged commit.

Create an annotated tag only after the version change is on `main`:

```sh
VERSION=$(node -p "require('./package.json').version")
git tag -a "v$VERSION" -m "pi-build-conductor v$VERSION"
git push origin "v$VERSION"
```

Create a GitHub Release from that exact tag and use GitHub's generated release notes.
Publishing the release starts `.github/workflows/release.yml`, which verifies the tag, package, tests, and compatible server again.

## npm publication status

npm publication is currently disabled by two independent controls:

- `package.json` has `private: true`.
- The repository variable `NPM_PUBLISH_ENABLED` is unset or not equal to `true`.

GitHub installation remains the supported distribution channel while either control is disabled.
Do not add an `NPM_TOKEN` repository secret.

## Enable the first npm release

The package name must be bootstrapped on npm before trusted publishing can be attached to it.
Perform these steps in a dedicated reviewed release change when npm publication is appropriate:

1. Confirm that `pi-build-conductor` is still available on npm.
2. Remove `private: true` from `package.json` and regenerate `package-lock.json`.
3. Run `npm run release:check` and test the packed tarball in a clean environment.
4. Publish the first version manually with maintainer two-factor authentication and public access.
5. Configure npm trusted publishing for repository `max-miller1204/pi-build-conductor`, workflow `release.yml`, and environment `npm-publish`.
6. Configure the GitHub `npm-publish` environment with required reviewers and tag-only deployment rules.
7. Set the repository variable `NPM_PUBLISH_ENABLED` to `true`.
8. Change the README installation section only after `pi install npm:pi-build-conductor@<version>` succeeds in a clean environment.

After bootstrap, every npm publication must come from the release workflow through GitHub-hosted OIDC.
Trusted publishing creates provenance for this public repository without a long-lived npm token.
The workflow publishes stable versions with the `latest` dist-tag and prereleases with `next`.

If npm publication succeeds but a later GitHub step fails, do not publish the same version again.
Diagnose the remaining workflow failure and preserve the immutable npm version.
