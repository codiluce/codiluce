import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import { SiteFooter, SiteHeader } from '../components/SiteChrome';
import { GA_ID } from '../lib/site';

export const metadata: Metadata = {
  metadataBase: new URL('https://codiluce.com'),
  title: { default: 'Codiluce — Bring your code to light', template: '%s · Codiluce' },
  description: 'Codiluce helps engineers understand their code and its architecture while agents keep changing it: every flow from the interface to the data, every commit, and every file an agent touches, you now get it.',
  applicationName: 'Codiluce',
  openGraph: {
    title: 'Codiluce — Bring your code to light',
    description: 'Understand your code and its architecture as agents keep changing it: an evidenced, zoomable map of flows and history, where your agents explain the code and you watch them work.',
    type: 'website',
    images: [{ url: '/social-preview.png', width: 1280, height: 640, alt: 'Codiluce — Bring your code to light. An amber eclipse lights a map of code.' }],
  },
  twitter: {
    card: 'summary_large_image',
    images: [{ url: '/social-preview.png', alt: 'Codiluce — Bring your code to light. An amber eclipse lights a map of code.' }],
  },
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
