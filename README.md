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

# Open a git worktree branch
td -w feature-branch
td --worktree feature-branch codex

# Clone repo to a sibling directory and open
td -c my-clone
td --clone my-clone kimi
```

Each project gets its own Hyprland workspace named `td-<project>`. Running `td` again in the same directory switches to the existing workspace instead of creating a new one.

## Scripts

| Script | Purpose |
|---|---|
| `td` | Main entry point — launches the layout or switches to existing workspace |
| `td-layout` | Spawns the 4 windows (editor, AI, 2 terminals) in dwindle layout |
| `td-pick` | Fuzzy project switcher — lists active `td-*` workspaces via walker |
| `td-reset-layout` | Resets a messy workspace back to the 3-column layout |
| `td-terminal` | Spawns a new terminal that auto-joins the current td workspace |

## Requirements

- [Hyprland](https://hyprland.org/) (dwindle layout)
- [Alacritty](https://alacritty.org/)
- [walker](https://github.com/abenz1267/walker) (for `td-pick`)
- `jq`, `pstree`
- `$EDITOR` set to the terminal editor command you want to launch (defaults to `nvim`)
- `$TD_AI_CMD` optionally set to the default AI command (defaults to `claude --dangerously-skip-permissions`)

## Install

```bash
git clone https://github.com/leowio/td.git
cd td
./install.sh
```

Symlinks all scripts to `~/.local/bin/`.
