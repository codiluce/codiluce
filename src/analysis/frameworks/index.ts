import type { TypeScriptFrameworkPack } from './typescript-pack.js';
import { expressPack } from './express.js';
import { nestPack } from './nest.js';

export const typescriptFrameworkPacks: readonly TypeScriptFrameworkPack[] = [expressPack, nestPack];
