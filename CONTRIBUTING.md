# Contributing to OBVS

This repository uses two long-lived branches:

- `dev` — the integration branch. All normal work merges here first.
- `main` — the stable branch. It is updated occasionally by merging `dev` into it.

Both branches are protected. You cannot commit directly to `dev` or `main`, and you cannot
force-push either branch. All changes must arrive through a pull request (PR).

## 1. Pick an issue

1. Open the repository Issues or the project board.
2. Choose an unassigned issue, or ask a maintainer to assign one to you.
3. Read the issue body and its parent user story before starting.
4. Check the issue's dependency links. If it is blocked, wait for the blocking issue to finish
   unless a maintainer tells you otherwise.

## 2. Create a branch from `dev`

Always start from the latest `dev`:

```sh
git switch dev
git pull origin dev
git switch -c feature/short-description
```

Use this naming pattern:

- `feature/...` for feature issues
- `task/...` for testing, verification, or other task issues

Examples:

```sh
git switch -c feature/client-settings
git switch -c task/protocol-contract-tests
```

Use lowercase words separated by hyphens. Keep the name short but recognizable.

## 3. Do the work

- Make small commits with clear messages.
- Keep unrelated changes out of the branch.
- Run the checks before opening the PR:

```sh
npm install
npm test
npm run build
npm run typecheck
```

If a command does not exist yet, use the commands listed in the README or ask a maintainer.

## 4. Push your branch and open a PR against `dev`

```sh
git push -u origin feature/short-description
```

On GitHub, open a pull request with:

- **Base branch:** `dev`
- **Compare branch:** your `feature/...` or `task/...` branch
- A title that describes the change
- A description that includes the issue number, for example:

```text
Closes #42
```

The `Closes #...` line is required. When the PR is merged into `dev`, GitHub closes the linked
issue automatically. If you are linking more than one issue, add one `Closes #...` line for each.

In the PR description, also include:

- What changed
- How you tested it
- Anything the reviewer should pay special attention to

## 5. Review and approval

- At least **one other developer** must approve the PR. You cannot approve your own PR.
- New commits dismiss previous approvals, so ask for another review after pushing changes.
- Resolve every review conversation before merging.
- If CI fails, fix the problem on your branch and push again.

Do not merge until the PR has the required approval and the checks are green.

## 6. Merge into `dev`

Merge the PR through GitHub. Do not push the merge manually.

After merging:

- The linked issue closes automatically.
- Delete your feature/task branch if GitHub offers to do so.
- Update `dev` locally before starting your next issue:

```sh
git switch dev
git pull origin dev
```

## 7. Merging `dev` into `main`

`main` is updated only after `dev` has been tested and verified.

1. Open a PR from `dev` into `main`.
2. Give it a clear title, such as `Release: verified dev changes`.
3. At least **one other developer** must approve it.
4. Merge through GitHub.

Do not commit directly to `main` and do not force-push it.

## Branch protection rules

`dev` and `main` are protected:

- Direct commits are blocked.
- Force pushes are blocked.
- Branch deletion is blocked.
- A PR with at least one approving review is required.
- Review conversations must be resolved before merging.

If you think you need to bypass a rule, stop and ask a maintainer. Do not try to disable
protection or force-push a protected branch.

## Quick checklist

- [ ] Issue is assigned and not blocked
- [ ] Branch created from latest `dev`
- [ ] Branch named `feature/...` or `task/...`
- [ ] Tests, build, and typecheck pass locally
- [ ] PR targets `dev`
- [ ] PR body contains `Closes #...`
- [ ] At least one other developer approved
- [ ] All review conversations resolved
- [ ] Merged through GitHub, not by direct push
