'use client';

import { useState } from 'react';
import { INSTALL, type InstallMethod } from '../lib/site';
import { CopyButton } from './CopyButton';

const TABS: { id: InstallMethod; label: string }[] = [
  { id: 'npx', label: 'npx' },
  { id: 'npm', label: 'npm' },
  { id: 'source', label: 'From source' },
];

/** The install command with a method switch; npx is the default because it needs no install step. */
export function InstallCommand({ methods = ['npx', 'npm'] }: { methods?: InstallMethod[] }) {
  const tabs = TABS.filter(tab => methods.includes(tab.id));
  const [method, setMethod] = useState<InstallMethod>(tabs[0]?.id ?? 'npx');
  const lines = INSTALL[method];
  return (
    <div className="install">
      <div className="install-tabs" role="tablist" aria-label="Install method">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={method === tab.id}
            className={method === tab.id ? 'active' : undefined}
            onClick={() => setMethod(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="install-body" role="tabpanel">
        <pre>
          {lines.map(line => (
            <code key={line}><span className="prompt" aria-hidden="true">$ </span>{line}{'\n'}</code>
          ))}
        </pre>
        <CopyButton text={lines.join('\n')} label="Copy the install command" />
      </div>
    </div>
  );
}
