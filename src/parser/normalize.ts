import { ukToUs } from '../model/dictionary';

/**
 * Normalise one instruction so the grammar sees a small, predictable vocabulary.
 * See spec/written-instructions.md, step 2.
 */
export function normalize(input: string, terms: 'US' | 'UK' = 'US'): string {
  let s = ' ' + input.toLowerCase().replace(/\bf\/o\b/g, 'fasten off') + ' ';
  s = rewritePhrases(s);
  s = s
    .replace(/[×✕]/g, 'x')
    .replace(/[–—−]/g, '-')
    .replace(/[“”″]/g, '"')
    .replace(/[‘’]/g, "'")
    // ordinals before "st" is touched: 2nd → 2, 1st → 1
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\bslip\s+stitch(es)?\b/g, ' slst ')
    .replace(/\bsl\.?\s*sts?\b/g, ' slst ')
    .replace(/\bslsts?\b/g, ' slst ')
    .replace(/\bss\b/g, ' slst ')
    // post stitches are worked around the post of the stitch below: the same stitch for counting
    .replace(/\b(front|back)\s+post\s+(?=(?:half\s+double|double|single|treble|half\s+treble)\b)/g, (_m, fb) => ` ${fb[0]}p `)
    .replace(/\bhalf\s+double\s+crochets?\b/g, ' hdc ')
    .replace(/\bhalf\s+trebles?(\s+crochets?)?\b/g, ' htr ')
    .replace(/\bdouble\s+trebles?(\s+crochets?)?\b/g, ' dtr ')
    .replace(/\bsingle\s+crochets?\b/g, ' sc ')
    .replace(/\bdouble\s+crochets?\b/g, ' dc ')
    .replace(/\btreble(s)?(\s+crochets?)?\b/g, ' tr ')
    .replace(/\b(magic|adjustable)\s+(ring|circle|loop)\b/g, ' mr ')
    .replace(/\bmc\b/g, ' mr ')
    .replace(/\b(in\s+)?(the\s+)?back\s+loops?(\s+only)?\b/g, ' blo ')
    .replace(/\bbl\s+only\b/g, ' blo ')
    .replace(/\b(in\s+)?(the\s+)?front\s+loops?(\s+only)?\b/g, ' flo ')
    .replace(/\bfl\s+only\b/g, ' flo ')
    .replace(/\b(blo|flo)(\d)/g, '$1 $2') // "BLO24sc"
    // "sc in the back loop of each st" → "sc blo in each st"
    .replace(/\b(blo|flo)\s+of\b/g, '$1 in');

  s = s
    .replace(/\b(fp|bp)\s*(sc|hdc|dc|tr|htr)\b/g, ' $2 post ')
    // "fpdc around next st", "bpdc around the post of next st": into that stitch, not "around" the round
    .replace(/\bpost\s+around\s+(?:the\s+post\s+of\s+)?(?:the\s+)?(?=next|each|same|first)/g, 'post in ')
    .replace(/\bpost\b/g, ' ');

  if (terms === 'UK') s = ukToUs(s);

  s = s
    .replace(/\bsc2tog\b|\binv(isible)?\s*-?\s*dec(rease)?s?\b|\bdecreases?\b|\bdecs?\b|\bdecreasing\b/g, ' dec ')
    .replace(/\bincreases?\b|\bincreasing\b|\bincs?\b/g, ' inc ')
    .replace(/\bstitch(es)?\b|\bsts\b|\bst\b/g, ' st ')
    // "ch-2 space", "ch 3 sp", "chain space", "ch-1 sp", "ch-5 loop": a chain space of the row below
    .replace(/\b(?:ch|chains?)\s*-?\s*\d*\s*-?\s*(?:spaces?|sps?|loops?|arch(?:es)?)\b|\b(?:corner\s+)?spaces?\b/g, ' sp ')
    .replace(/\bchains?\b|\bchs\b/g, ' ch ')
    .replace(/\brepeat\b|\brep\b/g, ' rep ')
    .replace(/\bevery\b|\beach remaining\b|\ball\b/g, ' each ')
    .replace(/\bfollowing\b/g, ' next ')
    .replace(/\binto\b/g, ' in ')
    .replace(/\bloosely\b/g, ' loose ')
    .replace(/\btightly\b/g, ' tight ')
    .replace(/\bcolour\b/g, 'color')
    // "sc 2, inc" → "2 sc, inc" (not "ch 3", "dec 6 times", "sc 2 sts together")
    .replace(/\b(sc|hdc|dc|tr|dtr|slst|inc|dec)\s+(\d+)\b(?!\s*(?:times|x\b|st\b|ch\b|tog|more|-|\)|\]))/g, '$2 $1')
    .replace(/(\d)\s*x\s*(?=\d)/g, '$1 x ')
    .replace(/\bx\s*(\d+)/g, ' x $1 ')
    .replace(/\s+/g, ' ')
    .trim();
  // "hdc + dc in next st", "dc + ch 2 + dc in next st": stitches joined by "+" all go into the one
  // stitch named after them, like "(hdc, dc) in next st"
  const item = '(?:\\d+ )?(?:sc|hdc|dc|tr|dtr|slst|ch)(?: \\d+)?';
  s = s.replace(new RegExp(`\\b(${item}(?: ?\\+ ?${item})+)(?= (?:in|on) )`, 'g'), (m) => `( ${m.replace(/ ?\+ ?/g, ' , ')} )`);
  return s;
}

/** Detect "UK terms" statements or strong UK hints in the whole text. */
export function detectTerms(text: string): { terms: 'US' | 'UK'; explicit: boolean; suspectedUK: boolean } {
  const t = text.toLowerCase();
  if (/\buk\s+(crochet\s+)?terms?\b|\bbritish\s+terms\b/.test(t)) return { terms: 'UK', explicit: true, suspectedUK: false };
  if (/\bus\s+(crochet\s+)?terms?\b|\bamerican\s+terms\b/.test(t)) return { terms: 'US', explicit: true, suspectedUK: false };
  const suspected = /\bhtr\b|\bttr\b/.test(t) || (/\b\d+\s*dc\s+(in|into)\s+(a\s+)?(magic|mr)\b/.test(t) && !/\bsc\b/.test(t));
  return { terms: 'US', explicit: false, suspectedUK: suspected };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20,
};

/**
 * Phrase dictionary: common ways of writing the same thing, rewritten to the wording the grammar knows.
 * Each rule is a paraphrase only (it never needs the stitch count); see tests/parser.test.ts "phrasings".
 */
export function rewritePhrases(input: string): string {
  const words = Object.keys(NUMBER_WORDS).join('|');
  return input
    // "(ch 2 does not count as a stitch)": a note about the turning chain, not an instruction
    .replace(/\((?:[^()]*?\b)?(?:does not|doesn['’]t|do not|don['’]t) count[^()]*\)/g, ' ')
    // advice, not stitches: "ensuring to keep your sl sts loose"
    .replace(/,?\s*\b(?:ensuring|making sure|being sure|taking care)\b[^.,;()]*/g, ' ')
    // "dc's", "ch 1's" → plain abbreviations
    .replace(/\b(sc|hdc|dc|tr|ch|sts?|inc|dec|\d+)['’]s\b/g, '$1')
    // "(sc in next 3 st, inc) repeat 6 times", "(sc, inc) * repeat 6 times", "(7sc, dec)*2" → "(…) x 6"
    .replace(/\)\s*\*?\s*,?\s*(?:repeat|rep)\s*(\d+)\s*times\b/g, ') x $1 ')
    .replace(/\)\s*\*\s*(\d+)\b/g, ') x $1 ')
    .replace(/\bonce more\b/g, ' 1 more times ')
    .replace(/\btwice more\b/g, ' 2 more times ')
    .replace(/\bonce\b/g, ' 1 times ')
    .replace(/\btwice\b/g, ' 2 times ')
    .replace(new RegExp(`\\b(${words})\\b`, 'g'), (w) => String(NUMBER_WORDS[w]))
    // "(picture B)", "(pictures G-H)": references to photos
    .replace(/\(\s*(?:pictures?|photos?|pics?|images?|fig(?:ure)?s?)\b[^)]*\)/g, ' ')
    // "leave the remaining stitches unworked": nothing to do
    .replace(/\bleave (?:the )?(?:remaining|rest of the|other) (?:st|sts|stitch(?:es)?) unworked\b/g, ' ')
    // a picot: "ch 3, start in third ch from hook, slst in this st" is a chain bump, nothing worked below
    .replace(/\bch\s*(\d+)\s*,\s*(?:start(?:ing)?\s+)?(?:in|into)\s+(?:the\s+)?(?:second|third|fourth|2nd|3rd|4th|\d)\s+ch\s+from\s+(?:the\s+)?hook\s*,?\s*(?:sl\s*st|slst|slip stitch)\s+(?:in|into)\s+(?:this|the same|same)\s+(?:st|stitch|ch)/g, ' ch $1 ')
    // a point: "ch 2, start in second ch from hook, sc in this st" is a stitch worked back into the chain just made
    .replace(/(\bch\s*\d+\s*,\s*)start(?:ing)?\s+(?:in|into)\s+(?:the\s+)?(second|third|fourth|2nd|3rd|4th|\d)\s+ch\s+from\s+(?:the\s+)?hook\s*,\s*((?:\d+\s+)?(?:sc|hdc|dc|tr|single crochet|half double crochet|double crochet|treble(?: crochet)?))\s+(?:in|into)\s+(?:this|the same|same|that)\s+(?:st|stitch|ch|chain)\b/g, (_m, ch, w, st) => {
      const n = ({ second: 2, third: 3, fourth: 4, '2nd': 2, '3rd': 3, '4th': 4 } as Record<string, number>)[w] ?? +w;
      return `${ch}${st} in ${n} ch from hook`;
    })
    // "start in second ch from hook, sc in next 30 ch": the first stitch skips the ch(s) next to the hook
    .replace(/^\s*start(?:ing)?\s+(?:in|into)\s+(?:the\s+)?(second|third|fourth|2nd|3rd|4th|2|3|4)\s+(?:ch|chain)\s+from\s+(?:the\s+)?hook\s*,?/g, (_m, w) => {
      const n = ({ second: 2, third: 3, fourth: 4, '2nd': 2, '3rd': 3, '4th': 4 } as Record<string, number>)[w] ?? +w;
      return ` skip ${n - 1} ch, `;
    })
    // "start 6 sc in a magic ring"
    .replace(/^\s*start(?:ing)?\s+(?=\d)/, ' ')
    // "sc in all 10 st", "inc in all12 st", "sc in all 6 sc" → each stitch
    .replace(/\b(?:in\s+)?all\s*\d+\s*(?:st|sts|stitches|stitch|sc|hdc|dc|ch)\b/g, ' in each st ')
    .replace(/\b(\d+)\s+(more\s+)?time\b/g, '$1 $2times')
    // "do this 4 times (in total)", "repeat this 5 more times", "repeat the above 3 times"
    .replace(/\b(?:do|work|repeat|rep)\s+(?:this|these|that|the above|the last \w+|the sequence|from the beginning|from beg\w*)(?:\s+(?:steps?|sequence|instructions?))?\s+(?=\d+\s+(?:more\s+)?times)/g, ' rep ')
    .replace(/\b(\d+\s+times)\s+in\s+total\b/g, '$1')
    // "in each of the next 3", "each of next 4" → "in next 3"
    .replace(/\b(?:in\s+)?each\s+of\s+(?:the\s+)?(?:next\s+|following\s+|first\s+|remaining\s+)?(\d+)/g, ' in next $1 ')
    // "in the first 5", "in remaining 5", "in the following 15" (not "to the last 3", which counts from the end)
    .replace(/(?<!\b(?:to|until)\s(?:the\s)?)\b(?:in\s+)?(?:the\s+)?(?:first|remaining|following)\s+(\d+)/g, ' in next $1 ')
    // "working on the other side of the chain", "continue along the opposite side of the foundation
    // chain", "in the bottom loops of the ch": back along the chain's other side (an oval)
    .replace(/\b(?:(?:then|now)\s+)?(?:(?:rotate|turn)\s+(?:your\s+)?(?:work\s+)?(?:(?:and|to)\s+)?)?(?:(?:continue|continuing|work|working)\s+)?(?:(?:on|along|in|into|down|across)\s+)?(?:the\s+)?(?:other|opposite|bottom|reverse|underside|remaining)\s+(?:side|loops?|bumps?|edge)?\s*(?:of|on)\s+(?:the\s+|your\s+)?(?:foundation\s+|starting\s+|beginning\s+|beg\s+)?(?:ch|chains?)(?:\s*\d+)?\b/g, ' otherside ')
    .replace(/\b(?:(?:continue|continuing|work|working)\s+)?(?:on|along|down)\s+(?:the\s+)?(?:other|opposite)\s+side\b/g, ' otherside ')
    // granny-square wording: "(which is the top of …)" notes, "into the ring, work 3 dc", "on the first
    // side of the square", "in the corner tr", "repeat from * for each side", "in the last corner, …",
    // "in the base of the ch 4" (where the round began), "to finish the corner"
    .replace(/\(\s*which\b[^)]*\)/g, ' ')
    .replace(/(^|[.,;]\s*)(?:in|into)\s+(?:the\s+)?(?:ring|mr|magic ring)\s*,\s*/g, '$1 ')
    .replace(/\b(?:on|along)\s+(?:the\s+)?(?:first|next|this|each|same)?\s*side(?:\s+of\s+the\s+(?:square|hexagon|piece))?\b/g, ' ')
    .replace(/\b(in|into)\s+(?:the\s+)?(?:next\s+)?corner\s+(?:tr|dc|hdc|sc|st|stitch|treble)\b/g, '$1 next st')
    .replace(/\b(?:rep(?:eat)?\s+from\s+\*\s+)(?:for|on|along)\s+(?:each|every|all|the remaining|remaining)\s+(?:\d\s+)?sides?\b/g, 'rep from * around')
    .replace(/(^|[.,;]\s*)in\s+(?:the\s+)?(?:last|final|first)\s+corner\s*,\s*/g, '$1 ')
    .replace(/\bin\s+(?:the\s+)?base\s+of\s+(?:the\s+)?(?:beg(?:inning)?\s+|starting\s+|first\s+|turning\s+)?(?:ch|chain)(?:\s*-?\s*\d+)?\b/g, ' in start st ')
    .replace(/\bto\s+(?:finish|complete|close|make)\s+(?:the|this|that)\s+(?:corner|side)\b/g, ' ')
    // "sl st in next st of the ring": the next stitch, wherever it is
    .replace(/\b(next\s+(?:\d+\s+)?(?:st|sts|stitch(?:es)?|ch))\s+of\s+(?:the\s+)?(?:ring|round|rnd|row|previous round|previous row|last round|last row)\b/g, '$1')
    // "sc around until 2 sts remain" keeps its meaning; "sc to the end" = around
    .replace(/\bto\s+(?:the\s+)?end(?:\s+of\s+(?:the\s+)?(?:row|round|rnd))?\b/g, ' around ')
    .replace(/\bsts?\s+left\b/g, ' st remain ');
}
