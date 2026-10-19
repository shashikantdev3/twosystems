# Releasing

How a version of twosystems reaches npm and PyPI. Written for the maintainer, Shashikant.

Both registries use trusted publishing: GitHub Actions proves who it is with a short-lived token, so no publishing token is stored anywhere. The workflow is [`.github/workflows/release.yml`](../.github/workflows/release.yml). It runs when a tag such as `v0.1.0-alpha.1` is pushed, checks that the tag matches both package versions, runs every test, then publishes the Python package to PyPI and the TypeScript package to npm.

## Versions

| Tag | npm (`packages/core/package.json`) | PyPI (`python/pyproject.toml`) | npm dist-tag |
|---|---|---|---|
| `v0.1.0-alpha.1` | `0.1.0-alpha.1` | `0.1.0a1` | `alpha` |
| `v0.1.0-rc.1` | `0.1.0-rc.1` | `0.1.0rc1` | `rc` |
| `v0.1.0` | `0.1.0` | `0.1.0` | `latest` |

`node scripts/check-release.mjs v0.1.0-alpha.1` checks a tag before you push it.

## One-time setup

1. **PyPI.** Signed in at pypi.org, open Account, then Publishing, and add a pending publisher: project `twosystems`, owner `shashikantdev3`, repository `twosystems`, workflow `release.yml`, environment `pypi`. A pending publisher does not reserve the name, so publish soon after.
2. **npm, first version only.** npm cannot publish a brand-new package through trusted publishing, so the first version goes up by hand from your machine:

   ```bash
   npm login                       # account shashikantdev3, with two-factor authentication
   npm ci && npm run build && npm test
   npm publish --workspace packages/core --tag alpha --access public
   ```

3. **npm trusted publisher.** On npmjs.com, open the `twosystems` package, then Settings, then Trusted Publisher, and choose GitHub Actions: owner `shashikantdev3`, repository `twosystems`, workflow file `release.yml`, environment `npm`. Allow `npm publish`. The first trusted publish must happen within two days of saving this.

## Each release

1. Update `CHANGELOG.md` and both version numbers, then commit.
2. Check and push the tag:

   ```bash
   node scripts/check-release.mjs v0.1.0-alpha.1
   git tag v0.1.0-alpha.1
   git push origin v0.1.0-alpha.1
   ```

3. Watch the release workflow in the Actions tab. A version that is already on npm (such as the first one, published by hand) is skipped, not treated as an error.
4. Check the pages: https://www.npmjs.com/package/twosystems and https://pypi.org/project/twosystems/.

Alpha versions are installed with `npm install --global twosystems@alpha` and `pip install --pre twosystems`.
