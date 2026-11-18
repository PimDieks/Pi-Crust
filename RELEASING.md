# Releasing Pi Crust

Only Pim publishes a release. The robot (GitHub Actions) builds the installer and makes a DRAFT. A draft is private until you press Publish. Nothing is ever published by itself.

Only two things are ever pushed to the public repo: `main` and release tags. No other branches.

## One-time setup (secrets and rules)

Never put a secret value in a file, an issue or a chat. Use the names below exactly. Where each one lives:

- `LEAK_DENYLIST` is a repository secret: Settings, Secrets and variables, Actions, New repository secret.
- The seven `AZURE_*` signing secrets are secrets of the protected environment `release`: Settings, Environments, New environment, name it `release`, tick Required reviewers and add yourself, then add them under Environment secrets. The release job runs in that environment, so every release run waits for your approval (an Approve button in the run) before it builds or can see the Azure secrets.

1. `LEAK_DENYLIST` (required). The list of words that must never appear in the repo. One rule per line, `#` for comments. Copy it from your local `.leak-denylist` file (that file stays on your computer; git ignores it). Without this secret the scan fails on purpose.
2. Signing secrets (optional until Microsoft approves you), in the `release` environment. Set all seven or none. If only some are set, the release run fails.
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
5. Open the Actions tab and watch the Release run. It checks that the tag matches `package.json` and that the commit is on `main` and scans for leaks. Then it stops and waits for your approval: open the run, press Review deployments, tick `release` and Approve. After that it builds the installer and creates a draft. If it fails, read the red step. Nothing is published when it fails.
6. Open the draft (Releases page, the draft at the top). Check:
   - These four files are attached: `Pi-Crust-Setup-X.Y.Z.exe`, `Pi-Crust-Setup-X.Y.Z.exe.blockmap`, `latest.yml`, `SHA256SUMS.txt`.
   - The notes do not start with UNSIGNED BUILD, unless you want an unsigned release. If they do and you publish anyway, delete that line first.
   - Download the exe. Right click it, Properties, Digital Signatures: the signer must be Nullvorm (or your validated legal name, if Microsoft would not show Nullvorm).
   - In PowerShell, `Get-FileHash .\Pi-Crust-Setup-X.Y.Z.exe -Algorithm SHA256` must equal the line in `SHA256SUMS.txt`. The checksum is only in that attached file, not in the release notes, so download `SHA256SUMS.txt` too.
7. Install it on a clean Windows account. Start the app and check that the version is the new one.
8. Press Publish release on the draft. Then wait for the update to appear on a test machine that has the previous release installed (the card **Pi Crust update available** shows within an hour, or press Check again), press Update and Restart now, and check the version. Tell the team. Tell them that Windows SmartScreen may warn for the first weeks (choose More info, then Run anyway), even when the file is signed.

## If something is wrong

1. Not published yet: just delete the draft, fix the problem on `main`, and make the next version number. Never move or re-use a tag.
2. Already published: tick "Set as a pre-release" on that release or delete it (the tag stays). That stops the update for everyone who has not taken it yet. Tell the team. Then release a fixed version with a higher number.
3. For people who already updated: updates only go forward. They go back to a previous version by downloading the older installer from the Releases page and running it over the current one (settings and chats stay). The failed-update card links there too, so keep the older installers on the Releases page.

## Notes

- The trial run: the first time, make a pre-release tag (`-rc.1`) and follow the steps above. Delete the draft and its tag afterwards. If a tag rule protects `v*` tags (step 3 above), GitHub refuses to delete the trial tag: remove it from the Releases page or temporarily lift the rule in Settings, Rules, then run `git push origin --delete vX.Y.Z-rc.1` (and `git tag -d vX.Y.Z-rc.1` locally).
- Pull requests from forks cannot see secrets. The built-in secret patterns still run there, but the word list does not (the summary says so), and the full scan runs when you merge to `main`. Dependabot pull requests get the same treatment. Do not merge a fork PR without reading it.
- Each Release run waits for your approval in the `release` environment. The macOS build is manual and not part of releases.
- The Release run needs the `LEAK_DENYLIST` secret every time. If it is missing, the run fails before it builds.
- Names of secrets are listed above. The values are only in the GitHub secrets page and, for the deny-list, your local file.
