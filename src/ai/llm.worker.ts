import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

// Runs the local model off the main thread so typing and the 3D view stay smooth.
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg);
