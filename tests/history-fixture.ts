// A Git repository with a small, scripted history over the fixture
// repository, shared by the history tests. Commits (oldest first):
//   A initial       the fixture as is, plus a `notes` file
//   B edits         login() body changed (LoginForm.tsx); Signup component added; AuthService::authenticate edited; `notes` file becomes a `notes/` directory
//   C renames       LoginForm.tsx moved to components/auth/ (git rename); AuthController::user gains a parameter; GET users/{id} route removed
//   D relocation    backend/ moved to server/ (the configured application lives elsewhere)
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const fixture = fileURLToPath(new URL('./fixtures/repository', import.meta.url));
export interface HistoryFixture { root: string; state: string; commits: { A: string; B: string; C: string; D: string }; cleanup(): Promise<void> }
export const FIXTURE_CONFIG = { repository: { name: 'fixture' }, applications: [{ name: 'frontend', path: 'frontend', type: 'nextjs' }, { name: 'backend', path: 'backend', type: 'laravel', apiOrigins: ['https://api.fixture.test'], apiOriginEnv: ['NEXT_PUBLIC_API_URL'] }] };

export async function createHistoryFixture(): Promise<HistoryFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-history-'));
  const state = await mkdtemp(path.join(tmpdir(), 'atlas-history-state-'));
  await cp(fixture, root, { recursive: true });
  await writeFile(path.join(state, 'config.yml'), stringify(FIXTURE_CONFIG));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_CONFIG_NOSYSTEM: '1', HOME: root };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const commit = (message: string, date: string) => { git('add', '-A'); execFileSync('git', ['commit', '-q', '-m', message], { cwd: root, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }); return git('rev-parse', 'HEAD'); };
  const edit = async (relative: string, change: (text: string) => string) => { const file = path.join(root, relative); await writeFile(file, change(await readFile(file, 'utf8'))); };
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'notes'), 'plain file\n');
  const A = commit('Initial import', '2026-01-01T10:00:00Z');
  await edit('frontend/src/components/LoginForm.tsx', text => text.replace("return fetch('https://api.fixture.test/auth/login', { method: 'POST', body: email });", "const body = email.trim();\n  return fetch('https://api.fixture.test/auth/login', { method: 'POST', body });"));
  await writeFile(path.join(root, 'frontend/src/components/Signup.tsx'), "export function Signup() {\n  return <form><button>Sign up</button></form>;\n}\n");
  await edit('backend/app/Services/AuthService.php', text => text.replace("return User::where('email', $email)->first();", "return User::where('email', strtolower($email))->first();"));
  await rm(path.join(root, 'notes'));
  await mkdir(path.join(root, 'notes'));
  await writeFile(path.join(root, 'notes/readme.md'), '# Notes\n');
  const B = commit('Edit login, add signup', '2026-01-02T10:00:00Z');
  await mkdir(path.join(root, 'frontend/src/components/auth'));
  git('mv', 'frontend/src/components/LoginForm.tsx', 'frontend/src/components/auth/LoginForm.tsx');
  await edit('frontend/src/components/index.ts', text => text.replace("'./LoginForm'", "'./auth/LoginForm'"));
  await edit('backend/app/Http/Controllers/AuthController.php', text => text.replace('public function user(int $id) {', 'public function user(int $id, bool $full = false) {'));
  await edit('backend/routes/api.php', text => text.replace("Route::get('users/{id}', [LoginController::class, 'user']);\n", ''));
  const C = commit('Move LoginForm, change user signature, drop users route', '2026-01-03T10:00:00Z');
  git('mv', 'backend', 'server');
  const D = commit('Move the backend to server/', '2026-01-04T10:00:00Z');
  return { root, state, commits: { A, B, C, D }, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); } };
}
