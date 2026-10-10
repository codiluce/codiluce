// Independent review of ALL original user route registrations, including misses.
// GET carries native HEAD only for Axum. Static service mounts are separate.
const route = (path, methods, file, line, handlerFile, handler, handlerLine, status) =>
    ({ path, methods, file, line, handlerFile, handler, handlerLine, status });
const module = (file, line, name, status = 'unsupported') => ({ file, line, name, status });
export const rustBroaderConsumers = [
    {
        key:'axum-plus', repository:'dfberry/rust-axum-hello-world-plus', commit:'930c68f004fa0019847d97ba81fcdfae3861272c',
        target:'example-hello-world', edition:'2021', framework:'axum', requirement:{version:'0.7.4'}, dialect:'axum-0.7', compilations:1,
        selectedFiles:['src/main.rs','src/database.rs','src/route_lists.rs','src/route_items.rs','src/types.rs'],
        modules:['database','route_items','route_lists','types'].map((name,i)=>module('src/main.rs',20+i,name)),
        routes:[
            route('/',['GET','HEAD'],'src/main.rs',31,'src/main.rs','handler_root',59,'qualified'),
            route('/lists',['GET','HEAD'],'src/main.rs',32,'src/route_lists.rs','get_lists',23,'qualified'),
            route('/lists',['POST'],'src/main.rs',33,'src/route_lists.rs','add_list',43,'conditional'),
            route('/lists/:id',['DELETE'],'src/main.rs',34,'src/route_lists.rs','delete_list',59,'conditional'),
            route('/lists/:id',['PUT'],'src/main.rs',35,'src/route_lists.rs','update_list_by_id',72,'conditional'),
            route('/lists/:id',['GET','HEAD'],'src/main.rs',36,'src/route_lists.rs','get_lists_by_id',31,'conditional'),
            route('/lists/:id/items',['GET','HEAD'],'src/main.rs',37,'src/route_items.rs','get_items',25,'conditional'),
            route('/lists/:id/items',['POST'],'src/main.rs',38,'src/route_items.rs','add_item',37,'conditional'),
            route('/lists/:id/items/:itemId',['GET','HEAD'],'src/main.rs',39,'src/route_items.rs','get_item_by_id',48,'qualified'),
            route('/lists/:id/items/:itemId',['PUT'],'src/main.rs',40,'src/route_items.rs','update_item_by_id',57,'conditional'),
            route('/lists/:id/items/:itemId',['DELETE'],'src/main.rs',44,'src/route_items.rs','delete_item_by_id',68,'qualified'),
            route('/state/:state',['GET','HEAD'],'src/main.rs',48,'src/route_items.rs','get_items_by_state',78,'conditional'),
            route('/state/:state',['PUT'],'src/main.rs',49,'src/route_items.rs','update_items_state',89,'conditional'),
        ], services:[],
        boundary:'Four native route/handler pairs qualify. Nine original handlers bind with unreviewed custom query/JSON extractors. General imports remain opaque despite framework-only original handler proof. MongoDB calls and runtime configuration are unreviewed.',
    },
    {
        key:'axum-course', repository:'jeremychone-channel/rust-axum-course', commit:'027104139e9b2770061d05f0d3b5fab185bf8bc8',
        target:'rust-axum-intro',edition:'2024',framework:'axum',requirement:'0.7',dialect:'axum-0.7',compilations:1,
        selectedFiles:['src/main.rs','src/ctx.rs','src/error.rs','src/log.rs','src/model.rs','src/web/mod.rs','src/web/mw_auth.rs','src/web/routes_login.rs','src/web/routes_tickets.rs'],
        modules:[...['ctx','error','log','model','web'].map((name,i)=>module('src/main.rs',18+i,name)),...['mw_auth','routes_login','routes_tickets'].map((name,i)=>module('src/web/mod.rs',1+i,name))],
        routes:[
            route('/hello',['GET','HEAD'],'src/main.rs',103,'src/main.rs','handler_hello',113,'missing'),
            route('/hello2/:name',['GET','HEAD'],'src/main.rs',104,'src/main.rs','handler_hello2',121,'missing'),
            route('/api/login',['POST'],'src/web/routes_login.rs',9,'src/web/routes_login.rs','api_login',12,'missing'),
            route('/api/tickets',['POST'],'src/web/routes_tickets.rs',10,'src/web/routes_tickets.rs','create_ticket',16,'missing'),
            route('/api/tickets',['GET','HEAD'],'src/web/routes_tickets.rs',10,'src/web/routes_tickets.rs','list_tickets',28,'missing'),
            route('/api/tickets/:id',['DELETE'],'src/web/routes_tickets.rs',11,'src/web/routes_tickets.rs','delete_ticket',39,'missing'),
        ], services:[{file:'src/main.rs',line:97,kind:'fallback static directory service'}],
        boundary:'All six explicit source routes are missed. Custom derives, state, authentication/response middleware, merge/nest helpers, static fallback and formatting remain opaque. The emitted conditional automatic 404 is excluded from source route recall.',
    },
    {
        key:'warp-placey', repository:'bekapod/placey',commit:'33cf3147fc7bae85af3a82523d2f76ddfde1e43b',
        target:'placey',edition:'2024',framework:'warp',requirement:{version:'0.4',features:['server']},dialect:'warp-0.4',compilations:2,
        selectedFiles:['src/main.rs','src/lib.rs','src/colour.rs','src/placeholder.rs'],
        modules:[module('src/lib.rs',1,'colour','resolved'),module('src/lib.rs',2,'placeholder')],
        routes:[
            route('/',['GET'],'src/main.rs',8,'src/main.rs','<closure>',10,'missing'),
            route('/g/<p0>',['GET'],'src/main.rs',27,'src/main.rs','<closure>',33,'missing'),
            route('/g/<p0>/<p1>',['GET'],'src/main.rs',28,'src/main.rs','<closure>',39,'missing'),
            route('/g/<p0>/<p1>/<p2>',['GET'],'src/main.rs',29,'src/main.rs','<closure>',47,'missing'),
            route('/g/<p0>/<p1>/<p2>/<p3>',['GET'],'src/main.rs',31,'src/main.rs','<closure>',57,'missing'),
        ],services:[{file:'src/main.rs',line:86,kind:'/dist static directory prefix'},{file:'src/main.rs',line:87,kind:'/meta static directory prefix'}],
        boundary:'Five source callbacks are missed. Serving is delegated through tracing::instrument outer; include_str!, filter boxing, trace/log wrappers and static services remain unreviewed. The original library and bin remain separate compilation contexts; bench/test client calls supply no serving routes.',
    },
    {
        key:'warp-qa',repository:'abdulaziz7225/qa-web-service',commit:'3dec7ad4cc1eb02ce7a595d4c552339144e18764',
        target:'qa-web-service',edition:'2024',framework:'warp',requirement:{version:'0.4.2',features:['server']},dialect:'warp-0.4',compilations:1,
        selectedFiles:['src/main.rs'],modules:[],
        routes:[
            route('/questions',['GET'],'src/main.rs',224,'src/main.rs','get_questions',127,'unbound'),
            route('/questions',['POST'],'src/main.rs',231,'src/main.rs','add_question',164,'unbound'),
            route('/questions/<p0>',['PUT'],'src/main.rs',238,'src/main.rs','update_question',177,'unbound'),
            route('/questions/<p0>',['DELETE'],'src/main.rs',246,'src/main.rs','delete_question',189,'unbound'),
            route('/comments',['POST'],'src/main.rs',253,'src/main.rs','add_answer',196,'unbound'),
        ],services:[],
        boundary:'All five original path/method registrations are conditional with no handler winner. Serde derives, custom state filters, query/body/form extraction, CORS and rejection recovery retain gaps; Store initialization and included JSON are never executed.',
    },
];

// Same independent original denominator. This phase changes only whether the
// five original Q&A callback declarations bind under a reviewed namespace.
export const rustDeriveConsumers = rustBroaderConsumers.map(sample => sample.key !== 'warp-qa' ? sample : {
    ...sample,
    routes: sample.routes.map(item => ({...item,status:'conditional'})),
    boundary:'All five original callbacks now bind conditionally through recorded canonical Serde derive namespace proof. Custom state filters, query/body/form extraction, CORS, rejection recovery, generated traits and runtime behavior remain unreviewed; no newly qualified routing/request pairs follow.',
});

export const rustWarpExtractionConsumers = rustDeriveConsumers.map(sample => sample.key !== 'warp-qa' ? sample : {
    ...sample,
    extractions:[{file:'src/main.rs',line:217,callbackLine:217}],
    boundary:'All five original callbacks remain conditional. The original state mapper at line 217 is a deferred extraction reference for each endpoint, with one ordered output slot. Native query/JSON/form slots preserve callback arity; state output types, captured Clone/Send bounds, CORS, recovery and request predicates remain unreviewed. No new qualified pairs follow.',
});

export const rustWarpWrapperConsumers = rustWarpExtractionConsumers.map(sample=>sample.key!=='warp-placey'?sample:{
    ...sample,routes:sample.routes.map((item,index)=>({...item,status:'conditional',registrationStartLine:[8,33,39,47,56][index],mappingLine:[10,33,39,47,56][index]})),
    wrapperSites:[{file:'src/main.rs',line:89,kind:'log'},{file:'src/main.rs',line:90,kind:'trace'}],
    instrument:{file:'src/main.rs',line:83,handler:'outer',providerLine:2049,testProviderLine:2007},
    boundary:'All five original source callbacks now bind conditionally through the recorded parameter-free tracing instrument helper and native default Warp log/trace wrappers. Native Tokio test functions are excluded only in the recorded non-test bin context. Original included text is not read. Captured values, wrapper Reply/Send/Clone/IsReject bounds, generated instrumentation, custom placeholder types and static services remain unreviewed; no new qualified request pairs follow.',
});
