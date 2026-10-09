/**
 * The languages and frameworks Codiluce analyzes: the home page, the docs and the README graphics
 * (scripts/readme-graphics.ts) all read this file. Logos are public/stacks/<logo>.svg, colored for dark
 * backgrounds; `light` is the fill to use on light backgrounds when it differs.
 *
 * Order is by use (Stack Overflow Developer Survey 2025) weighted by how deep the analysis goes.
 */
export interface Stack {
  id: string;
  name: string;
  /** Logo file in public/stacks/, when not `id`. Frameworks without a logo borrow their language's. */
  logo?: string;
  /** Logo fill on light backgrounds, when the dark one would vanish. */
  light?: string;
  /** Shown under the name: the language, or what the entry covers. */
  note?: string;
}

/**
 * Stacks the published npm package (lib/site.ts VERSION) analyzes. The others are on main: they run from a
 * source checkout today and ship in the next release. Once a version with every pack is published, list
 * them all here.
 */
export const PUBLISHED = new Set(['typescript', 'javascript', 'php', 'react', 'nextjs', 'laravel', 'inertia']);

export const LANGUAGES: Stack[] = [
  { id: 'typescript', name: 'TypeScript' },
  { id: 'javascript', name: 'JavaScript' },
  { id: 'python', name: 'Python' },
  { id: 'java', name: 'Java' },
  { id: 'csharp', name: 'C#' },
  { id: 'php', name: 'PHP' },
  { id: 'go', name: 'Go' },
  { id: 'rust', name: 'Rust', light: '#000000' },
  { id: 'kotlin', name: 'Kotlin' },
  { id: 'ruby', name: 'Ruby', light: '#CC342D' },
];

/** The featured frameworks: one logo each on the home page and in the README. */
export const FRAMEWORKS: Stack[] = [
  { id: 'react', name: 'React', note: 'TypeScript · JavaScript', light: '#087EA4' },
  { id: 'nextjs', name: 'Next.js', note: 'App Router', light: '#000000' },
  { id: 'express', name: 'Express', note: 'Node.js', light: '#000000' },
  { id: 'aspnetcore', name: 'ASP.NET Core', note: 'C#' },
  { id: 'vue', name: 'Vue', note: 'Vue Router' },
  { id: 'fastapi', name: 'FastAPI', note: 'Python' },
  { id: 'spring', name: 'Spring', note: 'Java · Kotlin' },
  { id: 'flask', name: 'Flask', note: 'Python' },
  { id: 'django', name: 'Django', note: 'Python', light: '#092E20' },
  { id: 'laravel', name: 'Laravel', note: 'PHP' },
  { id: 'svelte', name: 'Svelte', note: 'SvelteKit' },
  { id: 'nestjs', name: 'NestJS', note: 'Node.js' },
  { id: 'rails', name: 'Ruby on Rails', note: 'Ruby', light: '#D30001' },
  { id: 'gin', name: 'Gin', note: 'Go' },
];

/** Also analyzed, shown smaller. */
export const MORE_FRAMEWORKS: Stack[] = [
  { id: 'nuxt', name: 'Nuxt' },
  { id: 'astro', name: 'Astro' },
  { id: 'inertia', name: 'Inertia' },
  { id: 'echo', name: 'Echo', logo: 'go' },
  { id: 'fiber', name: 'Fiber', logo: 'go' },
  { id: 'chi', name: 'Chi', logo: 'go' },
  { id: 'gorilla', name: 'Gorilla Mux', logo: 'go' },
  { id: 'nethttp', name: 'net/http', logo: 'go' },
  { id: 'axum', name: 'Axum', logo: 'rust', light: '#000000' },
  { id: 'actix', name: 'Actix Web', light: '#000000' },
  { id: 'rocket', name: 'Rocket' },
  { id: 'warp', name: 'Warp', logo: 'rust', light: '#000000' },
];

/** Recognized from their manifests and mapped with files, lines and Git metrics; their code is not analyzed yet. */
export const DETECTED = [
  'Angular', 'Remix', 'Fastify', 'Koa', 'Hono', 'React Native', 'Expo', 'Electron', 'Tauri', 'Capacitor',
  'Symfony', 'Drupal', 'CakePHP', 'Yii', 'Slim', 'Livewire', 'Celery', 'Sinatra', 'Hanami', 'Sidekiq', 'Jekyll',
  'Quarkus', 'Micronaut', 'Ktor', 'Play', 'Akka HTTP', 'http4s', 'Android', 'Blazor', '.NET MAUI', 'WPF',
  'Windows Forms', 'Vapor', 'Shopify themes',
];

export const logoOf = (stack: Stack) => `/stacks/${stack.logo ?? stack.id}.svg`;
