/// <reference lib="webworker" />
import { Solver, type SolverInput } from './solver';

// One solve at a time; a new "start" message replaces the running one.
let solver: Solver | null = null;
let job = 0;

self.onmessage = (e: MessageEvent<{ type: 'start'; job: number; input: SolverInput; frames: number }>) => {
  const msg = e.data;
  if (msg.type !== 'start') return;
  job = msg.job;
  solver = new Solver(msg.input);
  const my = job;
  let frame = 0;
  const tick = () => {
    if (my !== job || !solver) return;
    const move = solver.step(10);
    frame++;
    const done = frame >= msg.frames || move < 0.002;
    const pos = solver.pos.slice();
    (self as unknown as Worker).postMessage({ type: 'frame', job: my, pos, done, frame }, [pos.buffer]);
    if (!done) setTimeout(tick, 0);
  };
  tick();
};
