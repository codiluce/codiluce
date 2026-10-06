import AuthLayout from '../../layouts/auth-layout';

export default function Register() {
  return <AuthLayout><form method="post" action="/register" /></AuthLayout>;
}
