type Rule = [string, string, string];

/** @license Frozen English rules translated from Rails v8.1.0:
 * https://github.com/rails/rails/blob/v8.1.0/activesupport/lib/active_support/inflections.rb
 * Only these reviewed rules run; target regex/configuration never executes.
 *
 * Copyright (c) David Heinemeier Hansson
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
const PLURAL: Rule[] = [
  ["$", "", "s"],
  ["s$", "i", "s"],
  ["^(ax|test)is$", "i", "$1es"],
  ["(octop|vir)us$", "i", "$1i"],
  ["(octop|vir)i$", "i", "$1i"],
  ["(alias|status)$", "i", "$1es"],
  ["(bu)s$", "i", "$1ses"],
  ["(buffal|tomat)o$", "i", "$1oes"],
  ["([ti])um$", "i", "$1a"],
  ["([ti])a$", "i", "$1a"],
  ["sis$", "i", "ses"],
  ["(?:([^f])fe|([lr])f)$", "i", "$1$2ves"],
  ["(hive)$", "i", "$1s"],
  ["([^aeiouy]|qu)y$", "i", "$1ies"],
  ["(x|ch|ss|sh)$", "i", "$1es"],
  ["(matr|vert|ind)(?:ix|ex)$", "i", "$1ices"],
  ["^(m|l)ouse$", "i", "$1ice"],
  ["^(m|l)ice$", "i", "$1ice"],
  ["^(ox)$", "i", "$1en"],
  ["^(oxen)$", "i", "$1"],
  ["(quiz)$", "i", "$1zes"],
];
const SINGULAR: Rule[] = [
  ["s$", "i", ""],
  ["(ss)$", "i", "$1"],
  ["(n)ews$", "i", "$1ews"],
  ["([ti])a$", "i", "$1um"],
  ["((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$", "i", "$1sis"],
  ["(^analy)(sis|ses)$", "i", "$1sis"],
  ["([^f])ves$", "i", "$1fe"],
  ["(hive)s$", "i", "$1"],
  ["(tive)s$", "i", "$1"],
  ["([lr])ves$", "i", "$1f"],
  ["([^aeiouy]|qu)ies$", "i", "$1y"],
  ["(s)eries$", "i", "$1eries"],
  ["(m)ovies$", "i", "$1ovie"],
  ["(x|ch|ss|sh)es$", "i", "$1"],
  ["^(m|l)ice$", "i", "$1ouse"],
  ["(bus)(es)?$", "i", "$1"],
  ["(o)es$", "i", "$1"],
  ["(shoe)s$", "i", "$1"],
  ["(cris|test)(is|es)$", "i", "$1is"],
  ["^(a)x[ie]s$", "i", "$1xis"],
  ["(octop|vir)(us|i)$", "i", "$1us"],
  ["(alias|status)(es)?$", "i", "$1"],
  ["^(ox)en", "i", "$1"],
  ["(vert|ind)ices$", "i", "$1ex"],
  ["(matr)ices$", "i", "$1ix"],
  ["(quiz)zes$", "i", "$1"],
  ["(database)s$", "i", "$1"],
];
const IRREGULAR = [['person', 'people'], ['man', 'men'], ['child', 'children'], ['sex', 'sexes'], ['move', 'moves'], ['zombie', 'zombies']];
const UNCOUNTABLE = ['equipment', 'information', 'rice', 'money', 'species', 'series', 'fish', 'sheep', 'jeans', 'police'];
export class RailsInflections {
  private readonly irregular = IRREGULAR.map(pair => [...pair]);
  private readonly uncountable = new Set(UNCOUNTABLE);
  readonly gaps: string[] = [];
  addIrregular(singular: string, plural: string): void { this.irregular.unshift([singular, plural]); this.uncountable.delete(singular.toLowerCase()); this.uncountable.delete(plural.toLowerCase()); }
  addUncountable(words: string[]): void { for (const word of words) this.uncountable.add(word.toLowerCase()); }
  private transform(word: string, plural: boolean): string | undefined {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(word) || this.gaps.length) return;
    if (this.uncountable.has(word.toLowerCase())) return word;
    for (const pair of this.irregular) {
      const forms = plural ? [pair[0]!, pair[1]!] : [pair[1]!, pair[0]!], replacement = pair[plural ? 1 : 0]!;
      for (const form of forms) if (word.toLowerCase().endsWith(form.toLowerCase())) {
        const suffix = word.slice(-form.length); return word.slice(0, -form.length) + suffix[0] + replacement.slice(1);
      }
    }
    for (const [source, flags, replacement] of [...(plural ? PLURAL : SINGULAR)].reverse()) {
      const pattern = new RegExp(source, flags); if (pattern.test(word)) return word.replace(pattern, replacement);
    }
    return word;
  }
  singularize(word: string): string | undefined { return this.transform(word, false); }
  pluralize(word: string): string | undefined { return this.transform(word, true); }
}
