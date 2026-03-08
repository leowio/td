function td
    set -l dir $PWD
    set -l project (basename "$dir" | tr '.:/ ' '----')
    set -l ai_cmd (string join ' ' $argv)
    test -z "$ai_cmd"; and set ai_cmd "claude --dangerously-skip-permissions"
    hyprctl dispatch exec "td-layout 'td-$project' '$dir' '$ai_cmd'"
    exit
end
