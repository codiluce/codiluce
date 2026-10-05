// ASD-STE100 (Simplified Technical English) for generated text: the writing
// rules given to the models, and a deterministic checker that scores how
// closely a text follows the rules a program can test.
//
// The checker tests, per sentence: length (at most 25 words in a description,
// 20 is better), active voice (no "is/are/was/were/be/been + past
// participle"), no -ing forms (STE uses them only in technical names), no
// contractions, words from a list of common unapproved words that have an
// approved alternative (utilize → use), and per text no more than six
// sentences in a paragraph. Code identifiers, paths and quoted names are
// technical names and are skipped. The score is the share of checks passed,
// 0..1; the target is 0.8 ("80% of the way to ASD-STE100").

export const STE_TARGET = 0.8;
/** Instructions shared by every annotation request (identical text, so providers can cache the prefix). */
export const STE_RULES = `Write all prose in ASD-STE100 Simplified Technical English:
- Use short sentences: at most 20 words. Put one idea in each sentence.
- Use the active voice and the simple present tense ("The service reads the table", not "The table is read").
- Do not use -ing words, except in names from the code. Write "to sync" or "the sync", not "syncing".
- Use simple, approved words: use (not utilize, leverage), help (not facilitate), get (not obtain, retrieve), show (not display, render as a verb), start (not initiate, commence), stop (not terminate), many (not numerous), more (not additional), about (not approximately), through (not via), before (not prior to), after (not subsequent to), make sure (not ensure).
- Keep the articles "a", "an" and "the". Do not use contractions.
- Use names from the code exactly as they are (class, function, path, route, table and command names).
- Write facts that the input shows. Do not guess. If the input does not show a purpose, describe what the code does.`;

const UNAPPROVED: Record<string, string> = {
  utilize: 'use', utilizes: 'uses', utilized: 'used', leverage: 'use', leverages: 'uses', facilitate: 'help', facilitates: 'helps',
  obtain: 'get', obtains: 'gets', retrieve: 'get', retrieves: 'gets', commence: 'start', commences: 'starts', initiate: 'start', initiates: 'starts',
  terminate: 'stop', terminates: 'stops', numerous: 'many', additional: 'more', approximately: 'about', via: 'through', prior: 'before',
  subsequent: 'after', subsequently: 'after', ensure: 'make sure', ensures: 'makes sure', whilst: 'while', endeavor: 'try', sufficient: 'enough',
  'in order to': 'to', various: 'different', robust: 'strong', seamless: 'smooth', seamlessly: 'smoothly', comprehensive: 'full', crucial: 'important',
  essentially: '', basically: '', simply: '', just: '', etc: 'and more', 'e.g.': 'for example', 'i.e.': 'that is', aforementioned: 'this',
};
/** -ing words that are not verb forms (or are approved STE words). */
const ING_ALLOWED = new Set(['during', 'nothing', 'something', 'anything', 'everything', 'thing', 'things', 'string', 'strings', 'ring', 'king', 'bring', 'spring', 'sing', 'wing', 'swing', 'sling', 'evening', 'morning', 'ceiling', 'building', 'meaning', 'ming', 'ping', 'king', 'tiling', 'pudding']);
const PARTICIPLE = /^(?:[a-z]+ed|built|done|made|sent|set|shown|given|taken|written|read|run|found|kept|held|seen|known|put|got|gotten|chosen|drawn|left|bound|thrown|told|paid|split|spent|stored|used)$/;
const BE = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being']);
/** Not participles despite ending in -ed. */
const ED_ALLOWED = new Set(['need', 'speed', 'feed', 'seed', 'bed', 'red', 'shed', 'bleed', 'breed', 'embed', 'proceed', 'succeed', 'exceed', 'indeed', 'hundred', 'deed', 'weed', 'related', 'advanced', 'detailed', 'limited', 'nested', 'named', 'based', 'logged', 'shared', 'signed', 'scheduled', 'required', 'unused', 'unresolved', 'indexed', 'deprecated', 'cached', 'paged', 'paid', 'typed', 'untyped', 'fixed', 'mixed']);

export interface SteResult { score: number; sentences: number; checks: number; issues: string[] }
/** Words with code syntax (identifiers, paths, routes, quoted names) are technical names. */
function technical(word: string): boolean {
  return /[`'"/\\:_.()[\]{}<>@#$=]/.test(word) || /[a-z][A-Z]/.test(word) || /^[A-Z][a-z]+[A-Z]/.test(word) || /^[A-Z0-9_]{2,}$/.test(word) || /\d/.test(word);
}
export function sentencesOf(text: string): string[] {
  // Split on sentence ends that are not inside names like "App\Models" or "v1.2".
  return text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9"'`(])/).map(item => item.trim()).filter(item => item.length > 1);
}
export function steScore(text: string): SteResult {
  const issues: string[] = [];
  let checks = 0, passed = 0;
  const check = (ok: boolean, issue: string) => { checks++; if (ok) passed++; else issues.push(issue); };
  const paragraphs = text.split(/\n\s*\n/).filter(item => item.trim());
  for (const paragraph of paragraphs) check(sentencesOf(paragraph).length <= 6, 'a paragraph has more than six sentences');
  const sentences = sentencesOf(text);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    // Punctuation around a word is not part of it ("read." is a word, "getSettings()" a name).
    const bare = words.map(word => word.replace(/^[("'«]+|[)"'».,;:!?]+$/g, '')).filter(Boolean);
    const plain = bare.filter(word => !technical(word)).map(word => word.toLowerCase().replace(/[^a-z'-]/g, '')).filter(Boolean);
    check(words.length <= 25, `${words.length} words in a sentence (25 at most)`);
    check(words.length <= 20, `${words.length} words in a sentence (20 is better)`);
    let passive: string | undefined;
    for (let i = 0; i < plain.length - 1; i++) {
      if (!BE.has(plain[i]!)) continue;
      // "is not used", "are also read": skip one adverb.
      const next = ['not', 'also', 'only', 'then', 'always', 'never', 'now', 'still'].includes(plain[i + 1]!) ? plain[i + 2] : plain[i + 1];
      if (next && PARTICIPLE.test(next) && !ED_ALLOWED.has(next)) { passive = `${plain[i]} ${next}`; break; }
    }
    check(!passive, `passive voice ("${passive}")`);
    const ing = plain.find(word => word.length > 4 && word.endsWith('ing') && !ING_ALLOWED.has(word));
    check(!ing, `-ing form ("${ing}")`);
    const contraction = plain.find(word => /^[a-z]+'(s|t|re|ll|ve|d|m)$/.test(word) && !/'s$/.test(word));
    check(!contraction, `contraction ("${contraction}")`);
    const lower = ` ${plain.join(' ')} `;
    const unapproved = Object.keys(UNAPPROVED).find(word => lower.includes(` ${word} `));
    check(!unapproved, `unapproved word ("${unapproved}"${unapproved && UNAPPROVED[unapproved] ? `: use "${UNAPPROVED[unapproved]}"` : ''})`);
  }
  return { score: checks ? passed / checks : 1, sentences: sentences.length, checks, issues: [...new Set(issues)] };
}
/** The mean score of several texts (empty texts are skipped). */
export function meanSte(texts: string[]): number {
  const scored = texts.filter(text => text.trim()).map(text => steScore(text).score);
  return scored.length ? scored.reduce((sum, score) => sum + score, 0) / scored.length : 1;
}
