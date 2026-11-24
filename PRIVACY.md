# Privacy statement: Worktrees Manager

Applies to the Worktrees Manager mod for Claude Code (`powermods-worktrees`), published at https://github.com/netgfx/claude-worktrees-mod.

## What it collects

On your own machine, the mod keeps:

- Each worktree's name, color, one-sentence task and port block, in the repository's own git config (`.git/config`, keys `wtmod.*`).
- The port blocks in use on the machine, with the repository and worktree paths and names.
- For each running Claude Code session that runs the mod: its session id, repository path, worktree, model, effort level, agent name and whether it is working.
- Whether the port guard is on.

It collects no personal data, no account details and no credentials. It reads `.env` files only when you turn on `copyEnvFiles` or press the Copy button that names them, and then only to copy them into the new worktree; it keeps nothing of them.

## Where it is stored

- Worktree names, colors, tasks and ports: in each repository's `.git/config`.
- Port blocks, sessions and the guard setting: in the plugin's local store, a JSON file under `~/.claude/plugins/store/` whose name starts with `powermods-worktrees_`. Every Claude Code session on the same machine can read it.

## What leaves your machine

Only these model requests, sent through Claude Code to Anthropic and billed to your own Claude plan or API key:

- the one-sentence task of a new worktree, to name its branch;
- the first prompt sent in a worktree that has no task (first 4,000 characters), with its branch, recent commit subjects and a summary of changed files, to write a one-sentence task;
- the branch, recent commit subjects and changed-file summary when you press Suggest.

The mod reaches no other host and sends nothing to the author or anyone else.

## Retention and deletion

- Session entries: deleted when the session ends; entries older than 24 hours are deleted by the next session.
- Port blocks: until the worktree is removed or its folder is gone.
- Git config entries: until the worktree is removed from the panel, or `git config --remove-section wtmod.<id>`.
- To remove everything: delete the store file named above and run `git config --remove-section` for the `wtmod.*` sections.

## Sharing

No data is sold or shared with anyone.

## Children

The mod is a developer tool and is not directed at anyone under 18.

## Contact

Questions or concerns: https://github.com/netgfx/claude-worktrees-mod/issues
