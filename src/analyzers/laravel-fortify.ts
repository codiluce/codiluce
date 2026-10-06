// Laravel Fortify: authentication routes registered by a package.
//
// Fortify's routes live in vendor/laravel/fortify/routes/routes.php, which is
// never indexed; which of them exist is decided by the application:
// config/fortify.php enables features (`Features::registration()`…), sets the
// prefix, middleware, path overrides and whether GET views are served, and a
// service provider binds each view (`Fortify::registerView(fn () =>
// Inertia::render('auth/register'))`) and each action class
// (`Fortify::createUsersUsing(CreateNewUser::class)`). The route table below
// mirrors Fortify 1.x; from it and those declarations come the endpoints: a
// view endpoint renders its Inertia page (the inertia-linker joins it), an
// action endpoint is handled by the bound class's method. Endpoints served
// only by Fortify's own controllers still exist, so client requests match.
import path from 'node:path';
import type { AnalysisContext } from '../core/analyzer.js';
import { evidence, type Entity, type Evidence } from '../core/graph.js';
import type { ApplicationConfig } from '../core/config.js';
import { args, ast, classConstant, inertiaPageOf, literal, name, nodes, resolve, scopedChildren, text, walk, type Ast, type ParsedFile } from './php-ast.js';

const FORTIFY = 'laravel\\fortify\\fortify';
type Feature = 'registration' | 'resetPasswords' | 'emailVerification' | 'updateProfileInformation' | 'updatePasswords' | 'twoFactorAuthentication';
interface FortifyRoute {
  method: string; uri: string; name: string; controller: string; action: string;
  /** Enabled by this feature (else always registered). */
  feature?: Feature;
  /** The `Fortify::<view>View(...)` binding a GET view route serves; only registered while views are enabled. */
  view?: string;
  /** The `Fortify::<binding>(Class::class)` action contract the controller calls, and its method. */
  binding?: { register: string; method: string };
}
const C = 'Laravel\\Fortify\\Http\\Controllers\\';
export const FORTIFY_ROUTES: FortifyRoute[] = [
  { method: 'GET', uri: '/login', name: 'login', controller: 'AuthenticatedSessionController', action: 'create', view: 'loginView' },
  { method: 'POST', uri: '/login', name: 'login.store', controller: 'AuthenticatedSessionController', action: 'store' },
  { method: 'POST', uri: '/logout', name: 'logout', controller: 'AuthenticatedSessionController', action: 'destroy' },
  { method: 'GET', uri: '/forgot-password', name: 'password.request', controller: 'PasswordResetLinkController', action: 'create', feature: 'resetPasswords', view: 'requestPasswordResetLinkView' },
  { method: 'GET', uri: '/reset-password/{token}', name: 'password.reset', controller: 'NewPasswordController', action: 'create', feature: 'resetPasswords', view: 'resetPasswordView' },
  { method: 'POST', uri: '/forgot-password', name: 'password.email', controller: 'PasswordResetLinkController', action: 'store', feature: 'resetPasswords' },
  { method: 'POST', uri: '/reset-password', name: 'password.update', controller: 'NewPasswordController', action: 'store', feature: 'resetPasswords', binding: { register: 'resetUserPasswordsUsing', method: 'reset' } },
  { method: 'GET', uri: '/register', name: 'register', controller: 'RegisteredUserController', action: 'create', feature: 'registration', view: 'registerView' },
  { method: 'POST', uri: '/register', name: 'register.store', controller: 'RegisteredUserController', action: 'store', feature: 'registration', binding: { register: 'createUsersUsing', method: 'create' } },
  { method: 'GET', uri: '/email/verify', name: 'verification.notice', controller: 'EmailVerificationPromptController', action: '__invoke', feature: 'emailVerification', view: 'verifyEmailView' },
  { method: 'GET', uri: '/email/verify/{id}/{hash}', name: 'verification.verify', controller: 'VerifyEmailController', action: '__invoke', feature: 'emailVerification' },
  { method: 'POST', uri: '/email/verification-notification', name: 'verification.send', controller: 'EmailVerificationNotificationController', action: 'store', feature: 'emailVerification' },
  { method: 'PUT', uri: '/user/profile-information', name: 'user-profile-information.update', controller: 'ProfileInformationController', action: 'update', feature: 'updateProfileInformation', binding: { register: 'updateUserProfileInformationUsing', method: 'update' } },
  { method: 'PUT', uri: '/user/password', name: 'user-password.update', controller: 'PasswordController', action: 'update', feature: 'updatePasswords', binding: { register: 'updateUserPasswordsUsing', method: 'update' } },
  { method: 'GET', uri: '/user/confirm-password', name: 'password.confirm', controller: 'ConfirmablePasswordController', action: 'show', view: 'confirmPasswordView' },
  { method: 'GET', uri: '/user/confirmed-password-status', name: 'password.confirmation', controller: 'ConfirmedPasswordStatusController', action: 'show' },
  { method: 'POST', uri: '/user/confirm-password', name: 'password.confirm.store', controller: 'ConfirmablePasswordController', action: 'store' },
  { method: 'GET', uri: '/two-factor-challenge', name: 'two-factor.login', controller: 'TwoFactorAuthenticatedSessionController', action: 'create', feature: 'twoFactorAuthentication', view: 'twoFactorChallengeView' },
  { method: 'POST', uri: '/two-factor-challenge', name: 'two-factor.login.store', controller: 'TwoFactorAuthenticatedSessionController', action: 'store', feature: 'twoFactorAuthentication' },
  { method: 'POST', uri: '/user/two-factor-authentication', name: 'two-factor.enable', controller: 'TwoFactorAuthenticationController', action: 'store', feature: 'twoFactorAuthentication' },
  { method: 'POST', uri: '/user/confirmed-two-factor-authentication', name: 'two-factor.confirm', controller: 'ConfirmedTwoFactorAuthenticationController', action: 'store', feature: 'twoFactorAuthentication' },
  { method: 'DELETE', uri: '/user/two-factor-authentication', name: 'two-factor.disable', controller: 'TwoFactorAuthenticationController', action: 'destroy', feature: 'twoFactorAuthentication' },
  { method: 'GET', uri: '/user/two-factor-qr-code', name: 'two-factor.qr-code', controller: 'TwoFactorQrCodeController', action: 'show', feature: 'twoFactorAuthentication' },
  { method: 'GET', uri: '/user/two-factor-secret-key', name: 'two-factor.secret-key', controller: 'TwoFactorSecretKeyController', action: 'show', feature: 'twoFactorAuthentication' },
  { method: 'GET', uri: '/user/two-factor-recovery-codes', name: 'two-factor.recovery-codes', controller: 'RecoveryCodeController', action: 'index', feature: 'twoFactorAuthentication' },
  { method: 'POST', uri: '/user/two-factor-recovery-codes', name: 'two-factor.regenerate-recovery-codes', controller: 'RecoveryCodeController', action: 'store', feature: 'twoFactorAuthentication' },
];
/** RoutePath::for keys: a route's `fortify.paths` override is keyed by its name without `.store`. */
const pathKey = (route: FortifyRoute) => route.name === 'password.confirm.store' ? 'password.confirm' : route.name === 'two-factor.regenerate-recovery-codes' ? 'two-factor.recovery-codes' : route.name.replace(/\.store$/, '');

interface Binding { parsed: ParsedFile; node: Ast; page?: string; view?: string; actionClass?: string }
interface FortifyConfig { parsed: ParsedFile; features: Set<string>; prefix: string; views: boolean; middleware: string[]; paths: Map<string, string>; facts: Evidence[] }

function readConfig(parsed: ParsedFile): FortifyConfig {
  const config: FortifyConfig = { parsed, features: new Set(), prefix: '', views: true, middleware: ['web'], paths: new Map(), facts: [evidence('framework', 'php-laravel', parsed.file.path, 1, 'Fortify configuration (config/fortify.php): features, prefix, middleware, views')] };
  let returned: Ast | undefined;
  walk(parsed.ast, node => { if (!returned && node.kind === 'return' && ast(node.expr)?.kind === 'array') returned = ast(node.expr); });
  for (const item of nodes(returned?.items)) {
    const key = literal(item.key), value = ast(item.value);
    if (!key || !value) continue;
    if (key === 'prefix') config.prefix = literal(value) ?? '';
    else if (key === 'views' && value.kind === 'boolean') config.views = value.value !== false && value.raw !== 'false';
    else if (key === 'middleware' && value.kind === 'array') config.middleware = nodes(value.items).map(entry => literal(entry.value)).filter((entry): entry is string => !!entry);
    else if (key === 'paths' && value.kind === 'array') for (const entry of nodes(value.items)) { const from = literal(entry.key), to = literal(entry.value); if (from && to) config.paths.set(from, to); }
    else if (key === 'features' && value.kind === 'array') for (const entry of nodes(value.items)) {
      // Features::registration(), Features::twoFactorAuthentication([...])
      const call = ast(entry.value), what = call?.kind === 'call' ? ast(call.what) : undefined;
      if (what?.kind === 'staticlookup' && name(what.offset)) config.features.add(name(what.offset)!);
    }
  }
  return config;
}

/** Declare an application's Fortify endpoints; true when Fortify is configured or bound in it. */
export function declareFortify(context: AnalysisContext, app: ApplicationConfig, appId: string, parsedFiles: Map<string, ParsedFile>, methods: Map<string, Entity>): boolean {
  const { graph } = context;
  const base = app.path === '.' ? '' : app.path;
  const configFile = parsedFiles.get(path.posix.join(base, 'config/fortify.php'));
  const bindings = new Map<string, Binding>();
  let ignoreRoutes: Binding | undefined;
  for (const parsed of parsedFiles.values()) {
    if (parsed.file.application?.name !== app.name || !/\bFortify\b/.test(parsed.content)) continue;
    scopedChildren(parsed.ast, { namespace: '', imports: new Map() }, (children, scope) => {
      for (const child of children) walk(child, node => {
        if (node.kind !== 'call') return;
        const what = ast(node.what);
        if (what?.kind !== 'staticlookup' || resolve(what.what, scope)?.toLowerCase() !== FORTIFY) return;
        const method = name(what.offset);
        if (!method) return;
        const argument = args(node)[0];
        if (method === 'ignoreRoutes') ignoreRoutes = { parsed, node };
        else if (method.endsWith('View')) bindings.set(method, { parsed, node, ...(argument && ['closure', 'arrowfunc'].includes(argument.kind) ? { page: inertiaPageOf(argument, scope) } : literal(argument) ? { view: literal(argument) } : {}) });
        else if (method.endsWith('Using')) bindings.set(method, { parsed, node, actionClass: classConstant(argument, scope) ?? literal(argument)?.replace(/^\\/, '') });
      });
    });
  }
  if (!configFile && !bindings.size) return false;
  if (ignoreRoutes) {
    graph.diagnose({ analyzer: 'php-laravel', severity: 'info', code: 'fortify-routes-ignored', file: ignoreRoutes.parsed.file.path, line: ignoreRoutes.node.loc?.start.line, reason: 'Fortify::ignoreRoutes(): the application registers its own authentication routes' });
    return true;
  }
  // Without config/fortify.php, Fortify reads no features and serves views.
  const config = configFile ? readConfig(configFile) : undefined;
  const features = config?.features ?? new Set<string>();
  const views = config?.views ?? true;
  const anchor = config?.parsed ?? [...bindings.values()][0]!.parsed;
  const anchorFacts = config?.facts ?? [evidence('framework', 'php-laravel', anchor.file.path, 1, 'Fortify bindings (no config/fortify.php: default prefix, middleware and views)')];
  // A route the application declares itself wins over the package's (as Laravel's route collection does with a later registration).
  const own = new Set([...graph.entities.values()].filter(entity => entity.type === 'api_endpoint' && entity.parentId === appId).map(entity => entity.name));
  let declared = 0;
  for (const route of FORTIFY_ROUTES) {
    if (route.feature && !features.has(route.feature)) continue;
    if (route.view && !views) continue;
    const binding = route.view ? bindings.get(route.view) : route.binding ? bindings.get(route.binding.register) : undefined;
    const uri = config?.paths.get(pathKey(route)) ?? route.uri;
    const fullPath = `/${[config?.prefix ?? '', uri].map(part => part.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
    const handler = binding?.actionClass && route.binding ? methods.get(`${app.name}:${binding.actionClass.toLowerCase()}::${route.binding.method}`) : undefined;
    const where = binding?.parsed ?? anchor;
    const bound = binding ? [{ ...evidence('framework', 'php-laravel', binding.parsed.file.path, binding.node.loc?.start.line, `Fortify::${route.view ?? route.binding!.register}(${text(args(binding.node)[0], binding.parsed).slice(0, 60)}) serves ${route.method} ${fullPath}`), endLine: binding.node.loc?.end.line }] : [];
    const facts = [...anchorFacts, ...bound, evidence('framework', 'php-laravel', where.file.path, binding?.node.loc?.start.line, `laravel/fortify registers ${route.method} ${fullPath} (${route.name}) → ${route.controller}@${route.action}${route.feature ? `, with Features::${route.feature}()` : ''}`)];
    const handlerKind = handler ? 'method' : binding?.page ? 'closure' : 'package';
    for (const method of route.method === 'GET' ? ['GET', 'HEAD'] : [route.method]) {
      const id = graph.id('endpoint', app.name, method, fullPath, 'laravel/fortify', route.name);
      if (graph.entities.has(id) || own.has(`${method} ${fullPath}`)) continue;
      const endpoint = graph.contain({ id, type: 'api_endpoint', name: `${method} ${fullPath}`, path: where.file.path, parentId: appId, sourceRange: binding?.node.loc ? { startLine: binding.node.loc.start.line, endLine: binding.node.loc.end.line } : undefined, metadata: { method, routePath: fullPath, framework: 'laravel', routeFile: where.file.path, api: false, registration: 'package', package: 'laravel/fortify', middleware: config?.middleware ?? ['web'], constraintsUnresolved: false, handlerKind, routeName: route.name, controller: C + route.controller, controllerMethod: route.action, ...(binding?.page ? { inertiaPage: binding.page } : {}), ...(binding?.view ? { view: binding.view } : {}) }, evidence: facts });
      if (handler) graph.relate(endpoint.id, handler.id, 'handles', [...facts, ...handler.evidence]);
      declared++;
    }
    if (route.binding && binding?.actionClass && !handler) graph.diagnose({ analyzer: 'php-laravel', severity: 'warning', code: 'fortify-action-unresolved', file: binding.parsed.file.path, line: binding.node.loc?.start.line, reason: `Fortify::${route.binding.register} binds ${binding.actionClass}, but no ${binding.actionClass}::${route.binding.method}() is indexed` });
  }
  graph.diagnose({ analyzer: 'php-laravel', severity: 'info', code: 'package-routes', file: anchor.file.path, reason: `${app.name}: ${declared} laravel/fortify endpoints from ${config ? `config/fortify.php (features: ${[...features].join(', ') || 'none'})` : 'Fortify bindings'}; the package's own controllers are not indexed` });
  return true;
}
