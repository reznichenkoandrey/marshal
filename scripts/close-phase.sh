#!/bin/sh
set -eu

if [ "$#" -lt 2 ]; then
  echo 'Usage: ./scripts/close-phase.sh "<phase-slug>" "<commit-message>" [--merge]'
  exit 1
fi

PHASE_SLUG=$1
COMMIT_MESSAGE=$2
MERGE_NOW=${3:-}

BRANCH=$(git branch --show-current)

if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  BRANCH="codex/$PHASE_SLUG"
  git checkout -b "$BRANCH"
fi

npm run typecheck
git add -A

if ! git diff --cached --quiet; then
  git commit -m "$COMMIT_MESSAGE"
fi

git push -u origin "$BRANCH"

if gh pr view "$BRANCH" >/dev/null 2>&1; then
  PR_URL=$(gh pr view "$BRANCH" --json url --jq '.url')
else
  PR_URL=$(GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 gh pr create --fill --head "$BRANCH")
fi

echo "PR: $PR_URL"

if [ "$MERGE_NOW" = "--merge" ]; then
  gh pr merge "$BRANCH" --squash --delete-branch
fi
