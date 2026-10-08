'use client';

import { useState } from 'react';

export function CopyButton({ text, label = 'Copy to clipboard' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused (insecure origin, permissions); the text stays selectable.
    }
  };
  return (
    <button type="button" className="copy-button" onClick={copy} aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : label}>
      {copied ? (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.5 3.5v-.5A1.5 1.5 0 009 1.5H4A1.5 1.5 0 002.5 3v5A1.5 1.5 0 004 9.5h.5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
      )}
    </button>
  );
}
