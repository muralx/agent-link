import { test } from 'node:test';
import { runScenario } from './e2e.ts';

test('end to end: three edge processes and a spawned hub', { timeout: 60_000 }, async () => {
  await runScenario();
});
