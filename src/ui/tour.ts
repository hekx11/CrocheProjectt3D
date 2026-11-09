/** A short guided tour: dims the page, rings one part of it at a time and explains it in plain words. */
export interface TourStep {
  /** CSS selector of the part to point at; none = a centred card. */
  target?: string;
  title: string;
  /** Trusted HTML written in this file's caller, never user text. */
  body: string;
  /** Called before the step shows, e.g. to switch to the right tab on a phone. */
  before?: () => void;
}

export function startTour(steps: TourStep[], onDone: () => void = () => {}) {
  if (document.querySelector('.tour')) return;
  const root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = `<div class="tour-spot none"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div class="tour-step"></div><h2 id="tour-title"></h2><div class="tour-body"></div>
      <div class="tour-nav"><div class="tour-pips"></div><button type="button" class="tour-skip">Skip</button><button type="button" class="btn soft tour-back">Back</button><button type="button" class="btn primary tour-next">Next</button></div>
    </div>`;
  document.body.append(root);
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const spot = q('.tour-spot'), card = q('.tour-card'), next = q<HTMLButtonElement>('.tour-next'), back = q<HTMLButtonElement>('.tour-back');
  const before = document.activeElement as HTMLElement | null;
  let i = 0;

  function place() {
    const s = steps[i];
    const el = s.target ? document.querySelector<HTMLElement>(s.target) : null;
    const r = el?.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight, cw = card.offsetWidth, ch = card.offsetHeight, gap = 16, m = 12;
    if (!r || !r.width) {
      spot.className = 'tour-spot none';
      spot.removeAttribute('style');
      card.style.left = `${(vw - cw) / 2}px`;
      card.style.top = `${Math.max(m, (vh - ch) / 2)}px`;
      return;
    }
    const pad = 6;
    const box = { l: Math.max(4, r.left - pad), t: Math.max(4, r.top - pad), r: Math.min(vw - 4, r.right + pad), b: Math.min(vh - 4, r.bottom + pad) };
    spot.className = 'tour-spot';
    Object.assign(spot.style, { left: `${box.l}px`, top: `${box.t}px`, width: `${box.r - box.l}px`, height: `${box.b - box.t}px` });
    const clampX = (x: number) => Math.min(vw - cw - m, Math.max(m, x));
    const clampY = (y: number) => Math.min(vh - ch - m, Math.max(m, y));
    const midX = clampX((box.l + box.r) / 2 - cw / 2), midY = clampY((box.t + box.b) / 2 - ch / 2);
    let x: number, y: number;
    if (vw - box.r >= cw + gap + m) [x, y] = [box.r + gap, midY];          // to the right
    else if (box.l >= cw + gap + m) [x, y] = [box.l - gap - cw, midY];     // to the left
    else if (vh - box.b >= ch + gap + m) [x, y] = [midX, box.b + gap];     // below
    else if (box.t >= ch + gap + m) [x, y] = [midX, box.t - gap - ch];     // above
    else [x, y] = [midX, (box.t + box.b) / 2 < vh / 2 ? vh - ch - m : m];  // no room: the emptier end of the screen
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  function show(n: number) {
    i = Math.min(steps.length - 1, Math.max(0, n));
    const s = steps[i];
    s.before?.();
    q('.tour-step').textContent = i === 0 ? 'Welcome' : `Step ${i} of ${steps.length - 1}`;
    q('.tour-card h2').textContent = s.title;
    q('.tour-body').innerHTML = s.body;
    q('.tour-pips').innerHTML = steps.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('');
    back.hidden = i === 0;
    q('.tour-skip').hidden = i === steps.length - 1;
    next.textContent = i === 0 ? 'Show me around' : i === steps.length - 1 ? 'Start crocheting' : 'Next';
    place();
    // a tab switch lays the page out again a moment later
    requestAnimationFrame(place);
    next.focus();
  }

  function close() {
    removeEventListener('resize', place);
    removeEventListener('keydown', onKey, true);
    root.remove();
    before?.focus?.();
    onDone();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') show(i + 1);
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'Tab') {
      // keep the keyboard inside the card
      const f = [...card.querySelectorAll<HTMLElement>('button:not([hidden])')];
      const at = f.indexOf(document.activeElement as HTMLElement);
      f[(at + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      e.preventDefault();
    } else return;
    e.stopPropagation();
  }
  next.addEventListener('click', () => (i === steps.length - 1 ? close() : show(i + 1)));
  back.addEventListener('click', () => show(i - 1));
  q('.tour-skip').addEventListener('click', close);
  addEventListener('resize', place);
  addEventListener('keydown', onKey, true);
  show(0);
}
