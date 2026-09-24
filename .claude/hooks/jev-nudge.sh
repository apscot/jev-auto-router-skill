#!/usr/bin/env bash
# UserPromptSubmit hook: skill invocation depends on Claude matching the
# skill's description against the message, which isn't reliable on its own
# (confirmed in testing — it had to be named explicitly). This hook forces
# the reminder into context on every single prompt instead.
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Before doing anything else for this message, invoke the jev-router skill (Skill tool, name: jev-router) to route this task through JEV, then follow exactly what it returns. Do not pick a model or skip this step based on your own judgment of the task."
  }
}
EOF
exit 0
