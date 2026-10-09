import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileAspNetPath, matchAspNetPath, matchAspNetHosts, validAspNetHost, reviewedAspNetRequest } from '../src/analysis/routes/aspnet-patterns.js';
const match = (template: string, url: string) => matchAspNetPath(compileAspNetPath(template, 10), url);
test('ASP.NET inbound literals are ASCII case-insensitive and ignore one trailing separator', () => {
    assert.ok(match('/Items', '/items/'));
    assert.ok(!match('/items', '/items%00'));
    assert.ok(match('/{id:int}', '/%0912%09'));
    assert.ok(match('~/items', '/ITEMS'));
    assert.ok(match('/', '/'));
    assert.ok(!match('/items', '/items//'));
    assert.ok(!match('/items/x', '/items//x'));
    assert.ok(!match('/items', '/items/x'));
    assert.ok(match('/{{literal}}', '/%7Bliteral%7D'));
});
test('ASP.NET optional and default parameters use native missing-segment and policy behavior', () => {
    for (const [url, expected] of [['/items', true], ['/items/a', true], ['/items/a/b', false]] as const)
        assert.equal(match('/items/{id?}', url), expected);
    assert.ok(match('/items/{id:int=12}', '/items'));
    assert.ok(!match('/items/{id:int=no}', '/items'));
    assert.ok(match('/items/{id:int?}', '/items'));
    assert.ok(!match('/items/{id:int?}', '/items/no'));
    assert.equal(compileAspNetPath('/{id=12?}', 10).status, 'partial');
});
test('ASP.NET catch-alls preserve consecutive separators and encoded slashes within parameters', () => {
    for (const template of ['/files/{*path}', '/files/{**path}'])
        for (const url of ['/files', '/files/', '/files/a/b', '/files/a//b'])
            assert.ok(match(template, url), template + url);
    assert.ok(match('/items/{id}', '/items/a%2Fb'));
    assert.ok(!match('/items/a/b', '/items/a%2Fb'));
    assert.ok(match('/items/{id:length(5)}', '/items/a%2Fb'));
    assert.equal(compileAspNetPath('/{*path}/x', 10).status, 'partial');
    assert.equal(compileAspNetPath('/{*path?}', 10).status, 'partial');
});
test('ASP.NET complex segments match delimiters from right to left without capture backtracking', () => {
    assert.ok(match('/a{b}c{d}', '/abcd'));
    assert.ok(match('/a{b}c{d}', '/abcccd'));
    assert.ok(!match('/a{b}c{d}', '/abc'));
    assert.ok(!match('/a{b}c{d}', '/acbd'));
    assert.ok(!match('/a{b}c{d}', '/abccd/next'));
    assert.ok(match('/{file}.{ext?}', '/readme'));
    assert.ok(match('/{file}.{ext?}', '/readme.txt'));
    assert.ok(!match('/{file}.{ext?}', '/readme.'));
    assert.equal(compileAspNetPath('/file.{ext?}', 10).status, 'partial');
    assert.equal(compileAspNetPath('/{a}{b}', 10).status, 'partial');
});
test('ASP.NET integer policies use signed CLR bounds and invariant whole numbers', () => {
    for (const value of ['0', '+12', '-12', '2147483647', '-2147483648', '%2012%20'])
        assert.ok(match('/{id:int}', '/' + value));
    for (const value of ['2147483648', '-2147483649', '1.0', '1e2', '0x20', ''])
        assert.ok(!match('/{id:int}', '/' + value));
    assert.ok(match('/{id:long}', '/9223372036854775807'));
    assert.ok(match('/{id:long}', '/-9223372036854775808'));
    assert.ok(!match('/{id:long}', '/9223372036854775808'));
    assert.ok(match('/{id:min(5):max(9)}', '/7'));
    assert.ok(!match('/{id:range(5,9)}', '/9.0'));
    assert.ok(!match('/{id:range(5,9)}', '/10'));
});
test('ASP.NET standard bool, alpha, GUID, length and required constraints retain their native domains', () => {
    assert.ok(match('/{id:bool}', '/tRuE'));
    assert.ok(match('/{id:bool}', '/%20false%20'));
    assert.ok(!match('/{id:bool}', '/1'));
    assert.ok(match('/{id:alpha}', '/aBc'));
    assert.ok(!match('/{id:alpha}', '/abc1'));
    const guid = 'd85b1407-351d-4694-9392-03acc5870eb1';
    for (const value of [guid, guid.replaceAll('-', ''), '{' + guid + '}', '(' + guid + ')'])
        assert.ok(match('/{id:guid}', '/' + encodeURIComponent(value)));
    assert.ok(!match('/{id:guid}', '/bad'));
    for (const value of ['{0xd85b1407,0x351d,0x4694,{0x93,0x92,0x03,0xac,0xc5,0x87,0x0e,0xb1}}', '0x5b1407-+234-0X34-9392-03acc5870eb1'])
        assert.ok(match('/{id:guid}', '/' + encodeURIComponent(value)));
    assert.ok(!match('/{id:guid}', '/' + encodeURIComponent('{0xd85b1407,0x351d,0x4694,{0x193,0x92,0x03,0xac,0xc5,0x87,0x0e,0xb1}}')));
    assert.ok(match('/{id:minlength(2):maxlength(4)}', '/ab'));
    assert.ok(!match('/{id:length(2,4)}', '/a'));
    assert.ok(match('/{id:required}', '/a'));
});
test('Opaque constraints, duplicate parameters, malformed templates and budgets remain partial competitors', () => {
    for (const template of ['/{id:regex(^a$)}', '/{id:custom}', '/{id}/{ID}', '/{x', '/x//y', '/{id:length(-1)}', '/' + Array(29).fill('a').join('/')])
        assert.equal(compileAspNetPath(template, 10).status, 'partial', template);
    assert.ok(match('/{id:custom}', '/anything'));
    assert.deepEqual(compileAspNetPath('/literal/{id:int}/{id2}/{**tail}', 10).aspnet?.precedence, [1, 2, 3, 5]);
    assert.deepEqual(compileAspNetPath('/a{x}/{*tail:int}', 10).aspnet?.precedence, [2, 4]);
});
test('ASP.NET holes stay conservative and non-ASCII request casing cannot certify a route', () => {
    const pattern = compileAspNetPath('/literal/{id:int}', 10);
    assert.ok(matchAspNetPath(pattern, '/literal/{*}'));
    assert.ok(!matchAspNetPath(pattern, '/{*}/12'));
    assert.ok(matchAspNetPath(pattern, '/{*}/12', false));
    assert.equal(compileAspNetPath('/café', 10).status, 'partial');
    assert.ok(!reviewedAspNetRequest('/caf%C3%A9'));
    assert.ok(!reviewedAspNetRequest('/bad%FF'));
    assert.ok(reviewedAspNetRequest('/items/12'));
});
test('ASP.NET host constraints use wildcard suffixes, native default ports and no specificity between host lists', () => {
    for (const value of ['example.com', '*.example.com:443', '*:80', '*: *'.replace(' ', ''), '*'])
        assert.ok(validAspNetHost(value));
    for (const value of ['[::1]:8080', 'x..y', 'example.com:99999', 'scheme://example.com'])
        assert.ok(!validAspNetHost(value));
    assert.ok(matchAspNetHosts(['*.example.com:443'], new URL('https://api.example.com/x')));
    assert.ok(!matchAspNetHosts(['*.example.com'], new URL('https://example.com/x')));
    assert.ok(!matchAspNetHosts(['*:80'], new URL('https://example.com/x')));
    assert.ok(matchAspNetHosts(['example.com'], new URL('http://example.com:9999/x')));
    assert.ok(matchAspNetHosts([], new URL('http://example.com/x')));
});
