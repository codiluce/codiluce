#!/bin/sh
# Serves the invented storefront repository on port 4391, with the GitHub stand-in for its open pull request.
pkill -f "state-dir /tmp/claude-1000/-var-www-html-codiluce/cf208a31-b39c-488f-8ffd-c4cc429fa914/scratchpad/state/storefront --port 4391" ; sleep 1
cd /var/www/html/codiluce && GITHUB_TOKEN=demo nohup node --experimental-sqlite --import tsx --import /tmp/claude-1000/-var-www-html-codiluce/cf208a31-b39c-488f-8ffd-c4cc429fa914/scratchpad/demo/mock-github.mjs src/cli.ts serve --repo /tmp/claude-1000/-var-www-html-codiluce/cf208a31-b39c-488f-8ffd-c4cc429fa914/scratchpad/demo/storefront --state-dir /tmp/claude-1000/-var-www-html-codiluce/cf208a31-b39c-488f-8ffd-c4cc429fa914/scratchpad/state/storefront --port 4391 --pr-metadata github > /tmp/claude-1000/-var-www-html-codiluce/cf208a31-b39c-488f-8ffd-c4cc429fa914/scratchpad/serve-storefront.log 2>&1 &
for i in $(seq 1 60); do curl -sf localhost:4391/api/agents >/dev/null && break; sleep 0.5; done
curl -s localhost:4391/api/agents | head -c 200; echo
