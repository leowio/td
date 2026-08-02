# td

An opinionated terminal AI layout workflow for Hyprland.

One command spins up a full dev workspace: your `$EDITOR`, an AI assistant, and terminals — each in its own column, on a dedicated Hyprland workspace.

```
 ┌──────────────┬─────────┬─────────┐
 │              │         │  term   │
 │   editor     │   AI    │─────────│
 │   (50%)      │  (25%)  │  term   │
 │              │         │  (25%)  │
 └──────────────┴─────────┴─────────┘
```

## Usage

```bash
# Open current directory (AI defaults to $TD_AI_CMD or claude)
td

# Use a different AI
td kimi
td codex

# Run commands in terminal panes, adding panes when needed
td -- "npm run dev" "bun test"
td codex -- "npm run dev" "bun test" "tail -f app.log"

# Launch another wrapped agent in the current td workspace
td-agent codex
td-agent claude --dangerously-skip-permissions

# Fork an opencode session into a new window
td-opencode-fork ses_abc123

# Launch a tracked browser window in the current td workspace
td-browser
td-browser https://example.com

# Open an interactive diff against the remote default branch
td-diff
# Or choose a base branch explicitly
td-diff develop
td-diff --direct develop

# Open a git worktree branch
td -w feature-branch
td --worktree feature-branch codex

# Clone repo to a sibling directory and open
td -c my-clone
td --clone my-clone kimi
```

Each project gets its own Hyprland workspace named `td-<project>`. Running `td` again in the same directory switches to the existing workspace instead of creating a new one.

Working-state tracking in the status module is wrapper-backed for supported agents (`claude`, `codex`). Other agents still fall back to lightweight presence detection.

td also keeps lightweight runtime metadata for each spawned td window, so workspace reset/overview logic can use recorded roles instead of relying on terminal class prefixes or process-tree walking.

`td-browser` launches a new browser window, tracks it as a `browser` role, and places it under the editor branch. When you reset the layout, browser windows are restored after the AI and terminal columns are rebuilt, so they stay attached below the editor pane instead of joining the terminal column.

## Scripts

| Script | Purpose |
|---|---|
| `td` | Main entry point — launches the layout or switches to existing workspace |
| `td-agent` | Spawns another wrapped AI terminal in the current `td-*` workspace |
| `td-agent-run` | PTY wrapper that tracks supported AI sessions and writes runtime state |
| `td-browser` | Launches a new tracked browser window in the current `td-*` workspace |
| `td-diff` | Opens an interactive file, commit, and patch browser against a branch or remote default branch |
| `td-opencode-fork` | Forks an opencode session into a new terminal window |
| `td-window-state` | Internal runtime metadata helper for td window roles and workspaces |
| `td-layout` | Spawns the workspace windows and runs optional terminal commands |
| `td-pick` | Fuzzy project switcher — lists active `td-*` workspaces via walker |
| `td-reset-layout` | Resets a messy workspace back to the 3-column layout |
| `td-terminal` | Spawns a new terminal that auto-joins the current td workspace |

## Requirements

- [Hyprland](https://hyprland.org/) (dwindle layout)
- [Alacritty](https://alacritty.org/)
- [walker](https://github.com/abenz1267/walker) (for `td-pick`)
- [fzf](https://github.com/junegunn/fzf) (for `td-diff` fuzzy filtering)
- [sem-cli](https://github.com/Ataraxy-Labs/sem) (optional, for semantic `td-diff` patches)
- `jq`
- `$EDITOR` set to the terminal editor command you want to launch (defaults to `nvim`)
- `$TD_AI_CMD` optionally set to the default AI command (defaults to `claude --dangerously-skip-permissions`)

`td-diff` uses Vim-style normal and query modes. In normal mode, `c`, `f`, and `d` toggle the commit, file-tree, and diff panes; `h`/`l` move pane focus; `j`/`k` navigate; `/` starts an fzf query; and `q` exits. Press `Enter` on a folder to collapse or expand it. `Tab` selects the current commit or file, and on a folder selects every changed file below it. `Ctrl-C` clears the focused selection. In query mode, `Enter` applies the query and `Esc` restores the previous query. Patch rendering is debounced and cached so navigating quickly does not run Git or sem for every file under the cursor.

## Install

```bash
git clone https://github.com/leowio/td.git
cd td
./install.sh
```

Symlinks all scripts to `~/.local/bin/` and skills to `~/.agents/skills/`.
