import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import { SiteFooter, SiteHeader } from '../components/SiteChrome';

export const metadata: Metadata = {
  title: { default: 'Codiluce — Bring your code to light', template: '%s · Codiluce' },
  description: 'Codiluce maps a repository as an isometric city: every page, request, command and table, linked by evidence, through its whole Git history. Local, deterministic, open source.',
  applicationName: 'Codiluce',
  openGraph: { title: 'Codiluce — Bring your code to light', description: 'An evidenced, zoomable map of your codebase: flows, history and data, from page to table.', type: 'website' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0a0a0b', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
