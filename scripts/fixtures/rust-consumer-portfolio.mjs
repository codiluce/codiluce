// Manually reviewed ORIGINAL sources, not an inventory inferred from Codiluce.
// Keep the custom form query and legacy route in the full source denominator.
export const rustConsumerPins = {
    rocket: { repository: 'render-examples/rocket-rust-hello-world', commit: 'e230b997c771c64480afe3067cc7bb111d5616f3' },
    benchmark: { repository: 'rousan/rust-web-frameworks-benchmark', commit: '7aaad31609f18ab73668e33378dc1d07e1d7368d' },
};
export const rustConsumerPortfolio = [
    {
        name: 'Rocket 0.5 original consumer', pin: 'rocket', manifest: 'Cargo.toml', file: 'src/main.rs', target: 'hello', edition: '2021', framework: 'rocket', requirement: '0.5', dialect: 'rocket-0.5', beforeQualified: 0,
        declarations: [
            ['tests', 'module', 3], ['Lang', 'enum', 6], ['English', 'variant', 8], ['Russian', 'variant', 11],
            ['Options', 'struct', 15], ['emoji', 'field', 16], ['name', 'field', 17],
            ['world', 'function', 23], ['mir', 'function', 30], ['wave', 'function', 37], ['hello', 'function', 54], ['rocket', 'function', 76],
        ],
        derives: [{ name: 'FromFormField', line: 5 }, { name: 'FromForm', line: 14 }],
        routes: [
            { path: '/hello/world', methods: ['GET', 'HEAD'], handler: 'world', kind: 'function', line: 23 },
            { path: '/hello/мир', methods: ['GET', 'HEAD'], handler: 'mir', kind: 'function', line: 30 },
            { path: '/wave/<name>/<age>', methods: ['GET', 'HEAD'], handler: 'wave', kind: 'function', line: 37 },
            { path: '/?<lang>&<opt..>', methods: ['GET', 'HEAD'], handler: 'hello', kind: 'function', line: 54, conditional: true },
        ],
        boundary: 'Custom Option<Lang>/Options form-query conversion remains a native guard condition; the original hello binding is retained.',
    },
    {
        name: 'Warp 0.3 original control', pin: 'benchmark', manifest: 'warp/Cargo.toml', file: 'warp/src/main.rs', target: 'warp', edition: '2018', framework: 'warp', requirement: '0.3.1', dialect: 'warp-0.3', beforeQualified: 1,
        declarations: [['main', 'function', 4], ['<closure>', 'closure', 6]],
        routes: [{ path: '/hello/<p0>', methods: '*', handler: '<closure>', kind: 'closure', line: 6 }],
        boundary: 'The GET comment is not a method filter: the original path!/map chain accepts all methods and a String capture.',
    },
    {
        name: 'Legacy Rocket 0.4 boundary', pin: 'benchmark', manifest: 'rocket/Cargo.toml', file: 'rocket/src/main.rs', target: 'rocket', edition: '2018', framework: 'rocket', requirement: '0.4.7', beforeQualified: 0,
        declarations: [['index', 'function', 7], ['main', 'function', 11]], routes: [], outsideRoutes: 1,
        boundary: 'One original GET / index route uses Rocket 0.4.7, ignite and nightly compiler features; no Rocket 0.5 contract is borrowed.',
    },
];
