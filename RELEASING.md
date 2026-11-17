# Releasing Pi Crust

Only Pim publishes a release. The robot (GitHub Actions) builds the installer and makes a DRAFT. A draft is private until you press Publish. Nothing is ever published by itself.

Only two things are ever pushed to the public repo: `main` and release tags. No other branches.

## One-time setup (secrets and rules)

Secrets live in the repo settings: Settings, Secrets and variables, Actions, New repository secret. Never put a value in a file, an issue or a chat. Use the names below exactly.

1. `LEAK_DENYLIST` (required). The list of words that must never appear in the repo. One rule per line, `#` for comments. Copy it from your local `.leak-denylist` file (that file stays on your computer; git ignores it). Without this secret the scan fails on purpose.
2. Signing secrets (optional until Microsoft approves you). Set all seven or none. If only some are set, the release run fails.
   - `AZURE_TENANT_ID`
   - `AZURE_CLIENT_ID`
   - `AZURE_CLIENT_SECRET`
   - `AZURE_SIGN_ENDPOINT` (for example the West Europe address of your signing account)
   - `AZURE_SIGN_ACCOUNT` (the name of the signing account)
   - `AZURE_SIGN_PROFILE` (the name of the certificate profile)
   - `AZURE_SIGN_PUBLISHER` (the name on the certificate, it must match exactly what Windows will show)
3. Repo rules, in Settings: protect `main` and require the CI jobs to pass; limit who may create tags that start with `v`.
4. Write the two expiry dates here and in your calendar (Microsoft starts sending reminders 60 days before):
   - Azure client secret expires: ____
   - Identity validation expires: ____

Without the signing secrets the build still works, but the installer is NOT signed. You will see UNSIGNED BUILD in the run summary and at the top of the draft notes.

## Making a release

1. Check that the latest CI run on `main` is green.
2. Open `CHANGELOG.md`. Move the news from `Unreleased` into a new section `## [X.Y.Z] - date`. Read it as if you were the team: plain words, no secrets, no internal names.
3. Set the same version in `package.json` (`"version": "X.Y.Z"`). Commit both together on `main` and push `main`. Wait for CI to go green again.
4. Create the tag on that commit and push only the tag:
   ```
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   For a trial run use a pre-release version, for example `0.3.0-rc.1` in `package.json` and the tag `v0.3.0-rc.1`.
5. Open the Actions tab and watch the Release run. It checks that the tag matches `package.json` and that the commit is on `main`, scans for leaks, builds the installer, and creates a draft. If it fails, read the red step. Nothing is published when it fails.
6. Open the draft (Releases page, the draft at the top). Check:
   - These four files are attached: `Pi-Crust-Setup-X.Y.Z.exe`, `Pi-Crust-Setup-X.Y.Z.exe.blockmap`, `latest.yml`, `SHA256SUMS.txt`.
   - The notes do not start with UNSIGNED BUILD, unless you want an unsigned release. If they do and you publish anyway, delete that line first.
   - Download the exe. Right click it, Properties, Digital Signatures: the signer must be Nullvorm (or your validated legal name, if Microsoft would not show Nullvorm).
   - In PowerShell, `Get-FileHash .\Pi-Crust-Setup-X.Y.Z.exe -Algorithm SHA256` must equal the line in `SHA256SUMS.txt`.
7. Install it on a clean Windows account. Start the app and check that the version is the new one.
8. Press Publish release on the draft. Tell the team. Tell them that Windows SmartScreen may warn for the first weeks (choose More info, then Run anyway), even when the file is signed.

## If something is wrong

1. Not published yet: just delete the draft, fix the problem on `main`, and make the next version number. Never move or re-use a tag.
2. Already published: tick "Set as a pre-release" on that release or delete it (the tag stays). Tell the team. Then release a fixed version with a higher number.

## Notes

- The trial run: the first time, make a pre-release tag (`-rc.1`) and follow the steps above. Delete the draft and its tag afterwards.
- Pull requests from forks cannot see secrets. The leak scan is skipped there with a notice, and runs when you merge to `main`. Do not merge a fork PR without reading it.
- The Release run needs the `LEAK_DENYLIST` secret every time. If it is missing, the run fails before it builds.
- Names of secrets are listed above. The values are only in the GitHub secrets page and, for the deny-list, your local file.
