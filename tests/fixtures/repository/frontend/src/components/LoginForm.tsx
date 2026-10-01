export async function login(email: string) {
  return fetch('https://api.fixture.test/auth/login', { method: 'POST', body: email });
}
export function LoginForm() {
  return <form onSubmit={() => login('demo@example.com')}><button>Login</button></form>;
}
