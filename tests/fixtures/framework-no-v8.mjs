import v8 from 'node:v8';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
const serialize=v8.serialize;
v8.serialize=value=>{if(value&&Object.hasOwn(value,'facts'))throw Error('Owned forbidden full-framework V8 serialization');return serialize(value);};
syncBuiltinESMExports();await import(process.env.CODILUCE_OWNED_FRAMEWORK_WORKER?pathToFileURL(process.env.CODILUCE_OWNED_FRAMEWORK_WORKER):new URL('../../src/analysis/embedded/native-framework-worker.mjs',import.meta.url));
