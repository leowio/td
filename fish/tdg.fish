function tdg
    if test -z "$argv[1]"
        echo "Usage: tdg <branch>"
        return 1
    end

    set -l branch "$argv[1]"
    set -l repo_root (git rev-parse --show-toplevel 2>/dev/null)

    if test -z "$repo_root"
        echo "Not in a git repository."
        return 1
    end

    set -l worktree_dir "$repo_root/../$branch"

    if test -d "$worktree_dir"
        echo "Worktree already exists at $worktree_dir, using it."
    else
        if git show-ref --verify --quiet "refs/heads/$branch"
            git worktree add "$worktree_dir" "$branch"
        else if git show-ref --verify --quiet "refs/remotes/origin/$branch"
            git worktree add "$worktree_dir" "$branch"
        else
            echo "Branch '$branch' not found locally or on origin. Creating new branch."
            git worktree add -b "$branch" "$worktree_dir"
        end
    end

    if test $status -ne 0
        echo "Failed to create worktree."
        return 1
    end

    cd "$worktree_dir"
    td $argv[2..]
end
