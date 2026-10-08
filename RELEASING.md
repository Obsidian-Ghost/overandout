# Releasing

Releases are automatic. You never edit a version number or run `publish` by hand.

## How it works

1. Merge normal PRs into `main` using **Conventional Commit** titles:
   - `feat: ...` → minor bump (0.2.0 → 0.3.0 while below 1.0)
   - `fix: ...` → patch bump (0.2.0 → 0.2.1)
   - `feat!: ...` or a `BREAKING CHANGE:` footer → major bump
   - `docs:`, `chore:`, `ci:`, `test:`, `refactor:` → no release on their own
2. The **Release** workflow (`.github/workflows/release.yml`) runs on every push to `main`. It uses
   [release-please](https://github.com/googleapis/release-please) to open or update one PR titled
   `chore(release): vX.Y.Z` that bumps, in lockstep:
   - `package.json` (npm package `overandout`, command `overandout-relay`)
   - `py/pyproject.toml`, `py/overandout/__init__.py` (PyPI package `overandout`, commands `overandout` / `oao`)
   - `src/version.ts` (the relay's reported version)
   - `CHANGELOG.md`
3. **Merging that PR** tags `vX.Y.Z`, creates the GitHub Release, builds both packages, verifies that
   every version string matches the tag, and publishes:
   - npm via Trusted Publishing (OIDC, provenance attached, no token)
   - PyPI via Trusted Publishing (`pypa/gh-action-pypi-publish`, no token)

## Safety switches (repository variables)

Until these are set, automatic runs **build and dry-run only**; nothing is uploaded.

| Variable | Value | Effect |
|---|---|---|
| `RELEASE_NPM` | `publish` | upload to npm (anything else = dry-run) |
| `RELEASE_PYPI` | `pypi` or `testpypi` | upload to that index (anything else = dry-run) |

Set them under *Settings → Secrets and variables → Actions → Variables*.

## One-time setup

1. **GitHub → Settings → Actions → General → Workflow permissions**: tick *Allow GitHub Actions to create
   and approve pull requests* (release-please needs it to open the release PR).
2. **GitHub → Settings → Environments**: create `npm` and `pypi` (and `testpypi` if you use it).
   Optionally add yourself as a required reviewer on `pypi`/`npm` for a manual approval gate.
3. **npm** (package must already exist, it does): npmjs.com → package `overandout` → *Settings → Trusted
   Publisher → GitHub Actions*: owner `Obsidian-Ghost`, repository `overandout`, workflow `release.yml`,
   environment `npm`.
4. **PyPI**: pypi.org → project `overandout` → *Manage → Publishing → Add a new publisher*: owner
   `Obsidian-Ghost`, repository `overandout`, workflow `release.yml`, environment `pypi`.
   (TestPyPI is a separate account and a separate publisher entry with environment `testpypi`.)
5. Set `RELEASE_NPM=publish` and `RELEASE_PYPI=pypi`.

After this, the local `~/.pypirc` / `npm login` are no longer needed for releases; delete the PyPI token.

## Manual runs

*Actions → Release → Run workflow* lets you build any tag (or `main`) and choose `dry-run` / `publish`
for npm and `dry-run` / `testpypi` / `pypi` for PyPI. Useful to test the pipeline or to re-publish a tag
whose upload failed. A tag never changes meaning: the workflow refuses to publish if the tag does not
match the version in the files.

## Rules

- Never bump versions by hand; release-please owns them (`.github/release-manifest.json` is its memory).
- A published version can never be re-uploaded on either registry; if a release is bad, ship a `fix:` and
  let the next release PR carry the fix.
- Keep publishing inside `release.yml`: both registries identify the trusted publisher by that filename.
