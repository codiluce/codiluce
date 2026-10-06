import type { ReactNode } from 'react';

export default ({ children }: { children: ReactNode }) => (
  <main className="auth">{children}</main>
);
