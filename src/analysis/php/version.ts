import { createRequire } from 'node:module';
import { ANALYZER_VERSION } from '../../core/graph.js';

export const PHP_PARSER_VERSION: string = createRequire(import.meta.url)('php-parser/package.json').version;
export const PHP_STRUCTURE_VERSION = `${ANALYZER_VERSION}:php-original-structure:1`;
export const PHP_SOURCE_PROFILE = 'php-parser-8.4-original-source';
