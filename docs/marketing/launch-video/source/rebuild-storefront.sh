#!/bin/sh
# Rebuilds the invented storefront: the repository, its index (with the web → api proxy), the GitHub stand-in for
# PR #2841, the explanation tour of that PR, and the server on port 4391.
set -e
S=/tmp/claude-1000/-var-www-html-codiluce/cf208a31-b39c-488f-8ffd-c4cc429fa914/scratchpad
pkill -f "state-dir $S/state/storefront --port 4391" || true
python3 $S/demo/make_storefront.py $S/demo/storefront 2745
rm -rf $S/state/storefront && mkdir -p $S/state/storefront
cat > $S/state/storefront/config.yml <<'YML'
repository:
  name: storefront
applications:
  - name: web
    path: web
    frameworks: [nextjs]
    apiProxies:
      - pathPrefix: /api
        target: api
  - name: api
    path: api
    frameworks: [laravel]
YML
cd /var/www/html/codiluce
node --experimental-sqlite --import tsx src/cli.ts index --repo $S/demo/storefront --state-dir $S/state/storefront > $S/index-storefront.log 2>&1 || true
TIP=$(git -C $S/demo/storefront rev-parse claude/coupons-and-gift-cards)
sed -i "s/sha: '[0-9a-f]*'/sha: '$TIP'/" $S/demo/mock-github.mjs
S=$S node $S/scripts/publish-pr-tour.mjs 2>&1 | grep -o '"saved\\":\\"[^\\]*' || true
$S/scripts/serve-storefront.sh
