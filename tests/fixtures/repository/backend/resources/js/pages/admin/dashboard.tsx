import { Link, router, useForm } from '@inertiajs/react';

export default function Dashboard({ users }: { users: { id: number }[] }) {
  const form = useForm({ daily: true });
  const { post } = useForm({});
  const rebuild = () => router.post('/admin/rebuild');
  const again = () => form.post('/admin/rebuild');
  const third = () => post('/admin/rebuild');
  return (
    <div>
      <Link href="/about">About</Link>
      <Link href="/admin/rebuild" method="post">Rebuild</Link>
      {users.map(user => <Link key={user.id} href={user.id > 0 ? `/admin/${user.id}` : '/'}>{user.id}</Link>)}
      <button onClick={rebuild}>Rebuild</button>
      <button onClick={again}>Again</button>
      <button onClick={third}>Third</button>
    </div>
  );
}
