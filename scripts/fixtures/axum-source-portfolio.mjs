// Manual source review at the immutable upstream pin, independent of indexer
// output. Route methods include native GET-to-HEAD fallback; ALL / below is the
// original application fallback, not a second literal root route.
export const axumSourcePin = {
    repository: 'szabgab/axum.code-maven.com',
    commit: '0f43fc9e3a2aef8dea26fb6186a5bbea7c1beb18',
    requirement: '0.8.8',
};
const get = (path, handler, file = 'src/main.rs') => ({ path, methods: ['GET', 'HEAD'], handler, file });
const profile = (directory, target, functions, routes, extra = {}) => ({ directory, target, functions, routes, supported: true, ...extra });
export const axumSourcePortfolio = [
    profile('hello-plain-world', 'hello-plain-world', { 'src/main.rs': ['handle_main_page', 'create_router', 'main'] }, [get('/', 'handle_main_page')]),
    profile('hello-html-world', 'hello-html-world', { 'src/main.rs': ['handle_main_page', 'create_router', 'main'] }, [get('/', 'handle_main_page')]),
    profile('path-parameters', 'path-parameters', { 'src/main.rs': ['main_page', 'user_page', 'create_router', 'main'] }, [get('/', 'main_page'), get('/user/{name}', 'user_page')]),
    profile('path-precedence', 'path-parameters', { 'src/main.rs': ['main_page', 'name_page', 'special_page', 'create_router', 'main'] }, [get('/', 'main_page'), get('/{name}', 'name_page'), get('/special', 'special_page')]),
    profile('wildcard-path-parameters', 'path-parameters', { 'src/main.rs': ['main_page', 'access_path', 'handle_root', 'create_router', 'main'] }, [get('/', 'main_page'), get('/root/{*name}', 'access_path'), get('/root/', 'handle_root')]),
    profile('nesting-applications', 'nesting-applications', { 'src/main.rs': ['main_page', 'future_events', 'past_events', 'user_page', 'create_router', 'main'] }, [get('/', 'main_page'), get('/user/{id}', 'user_page'), get('/events/future', 'future_events'), get('/events/past', 'past_events')]),
    profile('nested-applications', 'nested-applications', {
        'src/main.rs': ['main_page', 'create_router', 'main'],
        'src/users.rs': ['user_page', 'create_router'],
        'crates/events/src/lib.rs': ['future_events', 'past_events', 'create_router'],
    }, [get('/', 'main_page'), get('/user/{id}', 'user_page', 'src/users.rs'), get('/events/future', 'future_events', 'crates/events/src/lib.rs'), get('/events/past', 'past_events', 'crates/events/src/lib.rs')], { modules: [{ from: 'src/main.rs', name: 'users', to: 'src/users.rs' }] }),
    profile('calculator-path', 'calculator', {
        'src/main.rs': ['main_page', 'create_router', 'main'],
        'src/v1calc.rs': ['handle_add', 'handle_multiply', 'handle_divide', 'handle_subtraction', 'create_router'],
        'src/v2calc.rs': ['handle_calc', 'create_router'],
    }, [get('/', 'main_page'), get('/v1/add/{a}/{b}', 'handle_add', 'src/v1calc.rs'), get('/v1/mul/{a}/{b}', 'handle_multiply', 'src/v1calc.rs'), get('/v1/div/{a}/{b}', 'handle_divide', 'src/v1calc.rs'), get('/v1/sub/{a}/{b}', 'handle_subtraction', 'src/v1calc.rs'), get('/v2/{op}/{a}/{b}', 'handle_calc', 'src/v2calc.rs')], { modules: [{ from: 'src/main.rs', name: 'v1calc', to: 'src/v1calc.rs' }, { from: 'src/main.rs', name: 'v2calc', to: 'src/v2calc.rs' }] }),
    profile('head-request', 'head-request', { 'src/main.rs': ['main_page', 'show_method', 'just_head', 'just_get', 'get_head_handler', 'create_route', 'main'] }, [get('/', 'main_page'), { path: '/separate', methods: ['HEAD'], handler: 'just_head', file: 'src/main.rs' }, { path: '/separate', methods: ['GET'], handler: 'just_get', file: 'src/main.rs' }, get('/get-head', 'get_head_handler'), get('/show', 'show_method')]),
    profile('custom-404-page', 'custom-404-page', { 'src/main.rs': ['main_page', 'handler_404', 'create_router', 'main'] }, [get('/', 'main_page'), { path: '/', methods: '*', handler: 'handler_404', file: 'src/main.rs', fallback: 'path' }]),
    // These original profiles are deliberately outside the declared supported
    // subset. Serde derives retain crate-wide generation gaps. Built-in Debug
    // is already reviewed; the custom Version extractor must retain its own
    // handler-entry condition without hiding the known root registration.
    { directory: 'api-calculator', target: 'api-calculator', supported: false, sourceRoutes: 1, boundary: 'Original serde/Debug derive macros can change crate items; expansion is unavailable.' },
    { directory: 'versioning-get', target: 'versioning', supported: false, sourceRoutes: 2, knownRoutes: [get('/', 'main_page')], constrainedRoutes: [get('/api/{version}/status', 'handle_api')], boundary: 'Original custom FromRequestParts Version extractor retains unreviewed handler-entry proof; the root route and both original registration bindings remain known.' },
];
