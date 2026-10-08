import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import { SiteFooter, SiteHeader } from '../components/SiteChrome';
import { GA_ID } from '../lib/site';

export const metadata: Metadata = {
  title: { default: 'Codiluce — Bring your code to light', template: '%s · Codiluce' },
  description: 'Codiluce helps engineers understand their code and its architecture as agents keep changing it: every flow from the interface to the data, linked by evidence, through its whole Git history. Local and open source.',
  applicationName: 'Codiluce',
  openGraph: { title: 'Codiluce — Bring your code to light', description: 'Understand your code and its architecture as agents keep changing it: an evidenced, zoomable map of flows, history and data.', type: 'website' },
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
        {/* Google tag (gtag.js), production builds only so local development is not counted. */}
        {process.env.NODE_ENV === 'production' ? (
          <>
            <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
            <Script id="gtag-init" strategy="afterInteractive">
              {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_ID}');`}
            </Script>
          </>
        ) : null}
      </body>
    </html>
  );
}
