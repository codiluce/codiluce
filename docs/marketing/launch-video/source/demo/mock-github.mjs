// Stands in for the GitHub REST API while capturing the launch film: the storefront repository is invented, so its
// one open pull request (#2841, the agent's branch) is served from here. Everything else goes to the real fetch.
const real = globalThis.fetch;
const OPEN = [{
  number: 2841, title: 'Add coupons and gift cards at checkout', html_url: 'https://github.com/storefront-dev/storefront/pull/2841',
  user: { login: 'claude' }, state: 'open', draft: false,
  created_at: '2026-10-16T08:12:00Z', updated_at: '2026-10-16T09:31:00Z', closed_at: null, merged_at: null, merge_commit_sha: null,
  head: { ref: 'claude/coupons-and-gift-cards', sha: 'e40c43fefa5454dad68f7a1f2a07e234e2cb1ad8' }, base: { ref: 'main' },
}];
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (!href.startsWith('https://api.github.com/repos/storefront-dev/storefront/')) return real(url, init);
  const body = /pulls\?state=open/.test(href) ? OPEN : /pulls\?state=closed/.test(href) ? [] : null;
  if (!body) return new Response('{"message":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' } });
};
