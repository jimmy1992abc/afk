# afk config — all optional; omit a line to auto-detect. Personal, gitignored.

## commands
test:  <cmd>
lint:  <cmd>
build: <cmd>

## external gate
priority: codex > kimi > glm # preferred order
min-pass: 1              # independent gates that must pass clean
mode:     waterfall      # waterfall: try in order, stop at min-pass · parallel: run at once

## merge
policy: leave-open       # leave-open · merge-to-unblock · merge-when-green

## invariants            # must-check rules a reviewer applies — one per line
