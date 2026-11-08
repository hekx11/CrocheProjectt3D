import { ukToUs } from '../model/dictionary';

/**
 * Normalise one instruction so the grammar sees a small, predictable vocabulary.
 * See spec/written-instructions.md, step 2.
 */
export function normalize(input: string, terms: 'US' | 'UK' = 'US'): string {
  let s = ' ' + input.toLowerCase() + ' ';
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
    .replace(/\bfl\s+only\b/g, ' flo ');

  if (terms === 'UK') s = ukToUs(s);

  s = s
    .replace(/\bsc2tog\b|\binv(isible)?\s*-?\s*dec(rease)?s?\b|\bdecreases?\b|\bdecs?\b/g, ' dec ')
    .replace(/\bincreases?\b|\bincs?\b/g, ' inc ')
    .replace(/\bstitch(es)?\b|\bsts\b|\bst\b/g, ' st ')
    .replace(/\bchains?\b|\bchs\b/g, ' ch ')
    .replace(/\brepeat\b|\brep\b/g, ' rep ')
    .replace(/\bevery\b|\beach remaining\b|\ball\b/g, ' each ')
    .replace(/\bfollowing\b/g, ' next ')
    .replace(/\binto\b/g, ' in ')
    .replace(/\bloosely\b/g, ' loose ')
    .replace(/\btightly\b/g, ' tight ')
    .replace(/\bcolour\b/g, 'color')
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
