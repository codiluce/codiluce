import { useRouter } from 'next/navigation';
import { AccountService } from '@/services/AccountService';
import { LoginForm } from '@/components/LoginForm';

export function AccountPanel({ email, ids }: { email: string; ids: number[] }) {
  const router = useRouter();
  const handleSave = async () => {
    if (!email) return;
    await AccountService.getInstance().signIn(email);
    router.push('/users/1');
  };
  const renderRow = (id: number) => <li key={id}>{id}</li>;
  return (
    <section>
      <button onClick={handleSave}>Save</button>
      <button onClick={() => AccountService.getInstance().profile(ids[0] ?? 0)}>Profile</button>
      <ul>{ids.map(renderRow)}</ul>
      <LoginForm />
    </section>
  );
}
