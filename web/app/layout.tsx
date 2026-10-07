import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/nunito';
// The typefaces of the other themes; each downloads only once a theme uses it.
import '@fontsource-variable/inter';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/archivo/standard.css';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/unbounded';
import './globals.css';

export const metadata: Metadata = { title: 'Codiluce — Bring your code to light', description: 'Bring your code to light' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
