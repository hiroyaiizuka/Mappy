---
name: visual-pr
description: PR 本文を「なぜ・注意点・変更の形（diff 形式の木）」で書く。ワーカーが PR を作る／更新するときに使う。
---

<!-- Adapted from humanlayer/skills (MIT) for Mappy: output goes to artifacts/, header carries the Linear issue, prose is Japanese per AGENTS.md. -->

# Describe a Pull Request

Create or update the pull request for the current task with a concise description that helps a reviewer understand why the change exists and the shape of the implementation.

## Workflow

1. Read the description template:

   `Read({SKILLBASE}/references/pr_description_template.md)`

2. Identify or create the pull request:
   - Check the current branch for a PR with `gh pr view --json url,number,title,state,baseRefName,headRefName 2>/dev/null`.
   - If no PR exists, inspect `git status --short --branch` and the commits on the current branch.
   - Commit task-related changes when needed, push the branch with an upstream, and create a PR for it. Follow the repository's git safety protocol.
   - Ask the user to select a PR only when the current branch has no relevant work and there is no safe current-branch PR to create.

3. Gather only the context needed to explain the change:
   - Read the ticket and any relevant task artifacts.
   - Read the complete PR diff and enough surrounding code to understand behavior and ownership.
   - Use `gh pr view` to collect PR metadata and changed files.
   - Read `{SKILLBASE}/references/show-me.md` for the visual-outline conventions used in the PR body.

4. Write the PR description using the template:
   - Keep **Why the change** to exactly one sentence.
   - Keep **Special things to note** to 1-3 bullets. Prioritize reviewer warnings, migrations, compatibility constraints, deliberate omissions, or surprising decisions. Write `- None.` when there are no special considerations.
   - Make **Change outline** a compact, `/show-me`-inspired structural view rather than prose or a file-by-file changelog.
   - Include only the views that help explain this PR:
     - SQL table and endpoint contract changes, plus pseudocode for business logic.
     - key data structure / type changes
     - A shallow file tree showing changed responsibilities.
     - React component tree changes, including important hooks, state, and package boundaries.
     - Call-tree, call-stack, control-flow, or data-flow changes.
   - Prefer `diff` blocks when showing changes to an existing shape. Show the complete target shape when most of it is new or diff notation would obscure ownership or order.
   - Keep each view focused on what a reviewer needs. Omit categories that did not change.
   - Header: the Linear issue link (`orca linear issue --current --json` gives the URL) and, when relevant, the `docs/product-plan.md` section. Omit the header only when there is no linked issue.

5. Save and publish the description:
   - Save to `artifacts/pr/{number}-description.md` (`artifacts/` is gitignored).
   - Update the PR with `gh pr edit {number} --body-file {output-path}`.
   - Confirm the update succeeded.

6. Report completion:
   - Read `{SKILLBASE}/references/describe_pr_final_answer.md`.
   - Respond using that final answer template with the PR URL, saved description URL, and concise list of changed files.

Always read and follow `{SKILLBASE}/references/pr_description_template.md`. Do not expand the PR body beyond that template.

Write as one human talking to another: avoid jargon and slang, and use simple, coherent, concise language. Prose is Japanese (AGENTS.md); code, identifiers, and tree/diff blocks stay as they are. Keep the repository's PR footer line (`🤖 Generated with [Claude Code](https://claude.com/claude-code)`) at the end of the body.

Mappy-specific views that usually matter: the Markdown text before/after an edit (as a `diff` of the note source), the frontmatter keys touched, and which layer changed (`core` / `layout` / `interaction` / `ui` / `obsidian`). State plainly what was verified on the real Obsidian vault and what was not.
