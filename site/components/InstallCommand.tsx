'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { INSTALL, type InstallMethod } from '../lib/site';
import { CopyButton } from './CopyButton';

const TABS: { id: InstallMethod; label: string }[] = [
  { id: 'npx', label: 'npx' },
  { id: 'npm', label: 'npm' },
  { id: 'agent', label: 'Ask an agent' },
  { id: 'source', label: 'From source' },
];

/** The install command with a method switch; npx is the default because it needs no install step. */
export function InstallCommand({ methods = ['npx', 'npm', 'agent'] }: { methods?: InstallMethod[] }) {
  const id = useId();
  const tabs = TABS.filter(tab => methods.includes(tab.id));
  const [method, setMethod] = useState<InstallMethod>(tabs[0]?.id ?? 'npx');
  const lines = INSTALL[method];
  const isAgent = method === 'agent';
  const switchTab = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex(tab => tab.id === method);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
      : null;
    if (next === null) return;
    const tab = tabs[next];
    if (!tab) return;
    event.preventDefault();
    setMethod(tab.id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div className="install">
      <div className="install-tabs" role="tablist" aria-label="Install method" onKeyDown={switchTab}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${id}-${tab.id}`}
            aria-controls={`${id}-panel`}
            aria-selected={method === tab.id}
            tabIndex={method === tab.id ? 0 : -1}
            className={method === tab.id ? 'active' : undefined}
            onClick={() => setMethod(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="install-body" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${method}`} tabIndex={0}>
        <pre>
          {lines.map(line => (
            <code key={line}>{!isAgent && <span className="prompt" aria-hidden="true">$ </span>}{line}{'\n'}</code>
          ))}
        </pre>
        <CopyButton key={method} text={lines.join('\n')} label={isAgent ? 'Copy the install prompt' : 'Copy the install command'} />
      </div>
      {methods.includes('agent') && (
        <p className="install-note">
          {isAgent ? 'Paste this into ' : 'Or tell '}
          <span className="install-agent"><img src="/agents/claude-code.svg" width="14" height="14" alt="" />Claude Code</span>
          {', '}
          <span className="install-agent"><img src="/agents/codex.svg" width="14" height="14" alt="" />Codex</span>
          {isAgent ? ', or your coding agent.' : ', or your coding agent: '}
          {!isAgent && <button type="button" onClick={() => setMethod('agent')}>“Install codiluce”</button>}
        </p>
      )}
    </div>
  );
}
