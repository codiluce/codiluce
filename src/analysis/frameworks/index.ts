import type { TypeScriptFrameworkPack } from './typescript-pack.js';
import { expressPack } from './express.js';
import { nestPack } from './nest.js';
import { vuePack } from './vue.js';

export const typescriptFrameworkPacks: readonly TypeScriptFrameworkPack[] = [expressPack, nestPack, vuePack];
