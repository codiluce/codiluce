#!/bin/sh
# Restarts the scratch BookStack server (agent activity lives in its memory).
pkill -f "state-dir /tmp/claude-1000/-var-www-html-codiluce/cf208a31-b39c-488f-8ffd-c4cc429fa914/scratchpad/state/bookstack --port 4390" ; sleep 1
cd /var/www/html/codiluce && nohup node --experimental-sqlite --import tsx src/cli.ts serve --repo examples/bookstack --state-dir /tmp/claude-1000/-var-www-html-codiluce/cf208a31-b39c-488f-8ffd-c4cc429fa914/scratchpad/state/bookstack --port 4390 > /tmp/claude-1000/-var-www-html-codiluce/cf208a31-b39c-488f-8ffd-c4cc429fa914/scratchpad/serve.log 2>&1 &
for i in $(seq 1 40); do curl -sf localhost:4390/api/agents >/dev/null && break; sleep 0.5; done
curl -s localhost:4390/api/agents
