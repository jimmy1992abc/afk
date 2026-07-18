# afk config — all optional; omit a line to auto-detect. Personal, gitignored.

## commands
test:  <cmd>
lint:  <cmd>
build: <cmd>

## external gate
priority: codex > claude > kimi > glm # preferred order
min-pass: 1              # independent gates that must pass clean
mode:     waterfall      # waterfall: try in order, stop at min-pass · parallel: run at once
design-gate: off         # opt-in pilot: one gate over the design doc before code
                         #   off (default) · risky (design-heavy/high-blast-radius only) · on (every issue)
# implementer:           # who writes the code, if not the driver (relay). May only
                         # BLOCK a gate, never permit one: a value here is written
                         # once and goes stale, so it must not outrank a live signal.

## merge
policy: leave-open       # leave-open · merge-to-unblock · merge-when-green

## invariants            # must-check rules a reviewer applies — one per line
