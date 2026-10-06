import { AccountPanel } from '@/components/AccountPanel';
import { Badge } from '@/components';

export default function AccountPage() {
  return <><Badge label="account" /><AccountPanel email="demo@example.com" ids={[1, 2]} /></>;
}
