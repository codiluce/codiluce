'use client';
import { useEffect, useRef, useState } from 'react';
import { SCENE_EVENT, type SceneId } from './MapDemo';

/** What a diff cannot answer, each with the demo scene that shows the answer. */
const QUESTIONS: { q: string; a: string; scene: SceneId; tool: string }[] = [
  { q: 'What does this code do?', a: 'Ask your agent. Its answer is saved beside the map, and every file, symbol and flow it names lights up.', scene: 'explain', tool: 'Explanations' },
  { q: 'What is my agent touching right now?', a: 'Each session’s reads, edits and searches mark the map as they happen, one color per agent.', scene: 'agents', tool: 'Agents' },
  { q: 'Which flow is it part of?', a: 'Pages, requests, commands and scheduled tasks are traced end to end, so every file says which flows reach it.', scene: 'flows', tool: 'Flows' },
  { q: 'What changed, and what can it break?', a: 'Compare any two commits in place, then follow the blast radius of anything, hop by hop.', scene: 'history', tool: 'History and Impact' },
];

/** An agent's branch, as a reviewer meets it: one long diff. */
const DIFF: [' ' | '+' | '-' | '@', string][] = [
  ['@', 'app/Services/ResetService.php'],
  ['+', 'public function send(string $email): void'],
  ['+', '{'],
  ['+', '    $user = User::where(\'email\', $email)->first();'],
  ['+', '    if (! $user) return;'],
  ['+', '    $token = Str::random(64);'],
  ['+', '    $this->tokens->store($user, $token);'],
  ['+', '    SendResetLink::dispatch($user, $token);'],
  ['+', '}'],
  ['@', 'web/components/ResetForm.tsx'],
  ['-', 'const [error, setError] = useState(null);'],
  ['+', 'const { mutate, isPending } = useResetLink();'],
  [' ', 'return ('],
  ['+', '  <form onSubmit={submit} aria-busy={isPending}>'],
  ['@', 'app/Console/ImportOrders.php'],
  ['-', '    foreach ($rows as $row) Order::create($row);'],
  ['+', '    Order::upsert($rows->all(), [\'external_id\']);'],
  ['+', '    $this->info("Imported {$rows->count()} orders");'],
  ['@', 'routes/api.php'],
  ['+', 'Route::post(\'/password/email\', [PasswordController::class, \'store\']);'],
  ['+', 'Route::post(\'/password/reset\', [PasswordController::class, \'update\']);'],
  ['@', 'app/Services/AuthService.php'],
  ['-', '    $hash = TokenHelper::legacyHash($token);'],
  ['+', '    $hash = hash(\'sha256\', $token);'],
  ['@', 'web/hooks/useSession.ts'],
  ['+', '  const refresh = useCallback(async () => {'],
  ['+', '    const res = await api.get(\'/api/session\');'],
  ['+', '    setSession(res.data);'],
  ['+', '  }, []);'],
  ['@', 'database/migrations/create_password_resets.php'],
  ['+', '    $table->string(\'email\')->index();'],
  ['+', '    $table->string(\'token\');'],
];
const CYCLE_MS = 4200;

/**
 * The goal, made visible: an agent's diff keeps scrolling (and growing) on one side; on the other, the questions a
 * team still needs answered, each pointing at the part of the demo that answers it.
 */
export function GoalDiff() {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [held, setHeld] = useState(false);
  const [stats, setStats] = useState({ files: 38, added: 2417, removed: 583 });
  const [visible, setVisible] = useState(false);
  const [still, setStill] = useState(false);

  useEffect(() => {
    setStill(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const element = root.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { threshold: 0.25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The branch keeps growing while you read.
  useEffect(() => {
    if (!visible || still) return;
    const timer = setInterval(() => setStats(s => ({ files: s.files + (Math.random() < 0.18 ? 1 : 0), added: s.added + 3 + Math.floor(Math.random() * 14), removed: s.removed + Math.floor(Math.random() * 5) })), 260);
    return () => clearInterval(timer);
  }, [visible, still]);
  useEffect(() => {
    if (!visible || still || held) return;
    const timer = setTimeout(() => setActive(index => (index + 1) % QUESTIONS.length), CYCLE_MS);
    return () => clearTimeout(timer);
  }, [visible, still, held, active]);

  const show = (scene: SceneId) => {
    window.dispatchEvent(new CustomEvent(SCENE_EVENT, { detail: scene }));
    document.getElementById('demo')?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
  };

  return (
    <div ref={root} className="goal" data-scrolling={visible && !still} data-cycling={visible && !still && !held}>
      <figure className="goal-diff" aria-label="A coding agent's branch as a reviewer meets it: one long diff that keeps growing.">
        <figcaption className="goal-diff-head">
          <span className="goal-branch">agent/password-reset</span>
          <span className="goal-stat">{stats.files} files</span>
          <span className="goal-stat add">+{stats.added.toLocaleString('en-US')}</span>
          <span className="goal-stat del">−{stats.removed.toLocaleString('en-US')}</span>
        </figcaption>
        <div className="goal-diff-body" aria-hidden="true">
          <div className="goal-diff-scroll">
            {[0, 1].map(copy => (
              <div key={copy}>
                {DIFF.map(([sign, text], index) => (
                  <code key={index} className={`goal-line ${sign === '+' ? 'add' : sign === '-' ? 'del' : sign === '@' ? 'file' : ''}`}>
                    <span>{sign === '@' ? '@@' : sign}</span>{text}
                  </code>
                ))}
              </div>
            ))}
          </div>
        </div>
        <p className="goal-diff-foot">A diff says which lines changed. Not what they mean.</p>
      </figure>

      <div className="goal-bridge" aria-hidden="true"><span /></div>

      <div className="goal-answers" onMouseLeave={() => setHeld(false)}>
        <p className="goal-answers-title">What the people responsible need to know</p>
        <ol className="goal-questions">
          {QUESTIONS.map((item, index) => (
            <li key={item.q} className={index === active ? 'is-active' : ''} onMouseEnter={() => { setActive(index); setHeld(true); }}>
              <button type="button" className="goal-question" aria-expanded={index === active} onClick={() => setActive(index)} onFocus={() => { setActive(index); setHeld(true); }}>
                <span className="question-index">0{index + 1}</span>
                <span className="goal-q">{item.q}</span>
              </button>
              <div className="goal-answer">
                <div>
                  <p>{item.a}</p>
                  <button type="button" className="text-link goal-see" tabIndex={index === active ? 0 : -1} onClick={() => show(item.scene)}>See it in the demo: {item.tool} ↑</button>
                </div>
              </div>
              <span className="goal-timer" aria-hidden="true" style={{ animationDuration: `${CYCLE_MS}ms` }} />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
