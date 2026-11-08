import { ukToUs } from '../model/dictionary';

/**
 * Normalise one instruction so the grammar sees a small, predictable vocabulary.
 * See spec/written-instructions.md, step 2.
 */
export function normalize(input: string, terms: 'US' | 'UK' = 'US'): string {
  let s = ' ' + input.toLowerCase() + ' ';
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
    .replace(/\b(blo|flo)(\d)/g, '$1 $2'); // "BLO24sc"

  if (terms === 'UK') s = ukToUs(s);

  s = s
    .replace(/\bsc2tog\b|\binv(isible)?\s*-?\s*dec(rease)?s?\b|\bdecreases?\b|\bdecs?\b|\bdecreasing\b/g, ' dec ')
    .replace(/\bincreases?\b|\bincreasing\b|\bincs?\b/g, ' inc ')
    .replace(/\bstitch(es)?\b|\bsts\b|\bst\b/g, ' st ')
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
    // "(sc, inc) * repeat 6 times", "(7sc, dec)*2" → "(…) x 6"
    .replace(/\)\s*\*\s*(?:repeat|rep)\s*(\d+)\s*times\b/g, ') x $1 ')
    .replace(/\)\s*\*\s*(\d+)\b/g, ') x $1 ')
    .replace(/\bonce more\b/g, ' 1 more times ')
    .replace(/\btwice more\b/g, ' 2 more times ')
    .replace(/\bonce\b/g, ' 1 times ')
    .replace(/\btwice\b/g, ' 2 times ')
    .replace(new RegExp(`\\b(${words})\\b`, 'g'), (w) => String(NUMBER_WORDS[w]))
    .replace(/\b(\d+)\s+(more\s+)?time\b/g, '$1 $2times')
    // "do this 4 times (in total)", "repeat this 5 more times", "repeat the above 3 times"
    .replace(/\b(?:do|work|repeat|rep)\s+(?:this|these|that|the above|the last \w+|the sequence|from the beginning|from beg\w*)(?:\s+(?:steps?|sequence|instructions?))?\s+(?=\d+\s+(?:more\s+)?times)/g, ' rep ')
    .replace(/\b(\d+\s+times)\s+in\s+total\b/g, '$1')
    // "in each of the next 3", "each of next 4" → "in next 3"
    .replace(/\b(?:in\s+)?each\s+of\s+(?:the\s+)?(?:next\s+|following\s+|first\s+|remaining\s+)?(\d+)/g, ' in next $1 ')
    // "in the first 5", "in remaining 5", "in the following 15" (not "to the last 3", which counts from the end)
    .replace(/(?<!\b(?:to|until)\s(?:the\s)?)\b(?:in\s+)?(?:the\s+)?(?:first|remaining|following)\s+(\d+)/g, ' in next $1 ')
    // "sc around until 2 sts remain" keeps its meaning; "sc to the end" = around
    .replace(/\bto\s+(?:the\s+)?end(?:\s+of\s+(?:the\s+)?(?:row|round|rnd))?\b/g, ' around ')
    .replace(/\bsts?\s+left\b/g, ' st remain ');
}
