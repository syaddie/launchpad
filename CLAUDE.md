# Working on Launchpad

## Merging to main

When a piece of work is finished, merge your branch into `main` and push `main` yourself, without asking first, as long as:

- `npm run typecheck` and `npm test` pass, and
- there's nothing you'd want the owner to decide first.

Pushing `main` deploys: GitHub Actions builds the image and the server's cron job runs it. So stop and ask before merging if any of these apply:

- a check fails, or you couldn't run part of what you changed
- the change could actually lose data that's already stored, with no way back: a migration that rewrites or renames store keys, cleanup that deletes files or records without a grace period, or anything that overwrites data without a copy or undo. Changes to how data is saved or restored don't need asking when nothing existing can be lost (it's validated, tested, and undoable or kept in a copy)
- it changes auth, Cloudflare Access, the terminal or files access, or anything else security-sensitive
- it needs a new env var, secret, volume or setup step on the server
- you weren't sure what was wanted, or you made a judgement call the owner should check

How to merge, matching the existing history:

```bash
git fetch origin main
git checkout main && git pull origin main
git merge --no-ff <your-branch>
git push origin main
git checkout <your-branch>
```

If the merge conflicts, resolve it only when the right answer is clear; otherwise stop and ask. Afterwards, say in your reply that it's merged and deployed.
