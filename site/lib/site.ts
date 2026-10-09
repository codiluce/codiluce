export const GITHUB_URL = 'https://github.com/codiluce/codiluce';
export const ISSUES_URL = `${GITHUB_URL}/issues`;
export const NPM_URL = 'https://www.npmjs.com/package/codiluce';
export const CALL_URL = 'https://calendly.com/mikeltorresugarte-ynlf/30min';
export const GA_ID = 'G-M9ZTKE5NLC';
export const VERSION = '0.1.1';

export const INSTALL = {
  npx: ['npx codiluce@latest start .'],
  npm: ['npm install --global codiluce', 'codiluce start .'],
  source: ['git clone https://github.com/codiluce/codiluce.git', 'cd codiluce && npm ci', 'npm start -- /path/to/repository'],
} as const;

export type InstallMethod = keyof typeof INSTALL;

export const DOCS_NAV = [
  { href: '/docs/', title: 'Getting started' },
  { href: '/docs/stacks/', title: 'Languages & frameworks' },
  { href: '/docs/map/', title: 'Using the map' },
  { href: '/docs/history/', title: 'History' },
  { href: '/docs/cli/', title: 'CLI & API' },
  { href: '/docs/configuration/', title: 'Configuration' },
  { href: '/docs/how-it-works/', title: 'How it works' },
] as const;
