import type { TypeScriptFrameworkPack } from './typescript-pack.js';
import { expressPack } from './express.js';
import { nestPack } from './nest.js';
import { vuePack } from './vue.js';
import { sveltePack } from './svelte.js';
import { astroPack } from './astro.js';
import { nuxtPack } from './nuxt.js';

export const typescriptFrameworkPacks: readonly TypeScriptFrameworkPack[] = [expressPack, nestPack, vuePack, sveltePack, astroPack, nuxtPack];
