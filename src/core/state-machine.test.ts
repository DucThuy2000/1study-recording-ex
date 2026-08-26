import { describe, it, expect } from 'vitest';
import { SessionStateMachine } from './state-machine';
import { InMemoryStore } from '../adapters/storage';
import { createLogger } from './logger';

function makeMachine() {
  const store = new InMemoryStore();
  const logger = createLogger('test', 'error');
  return { machine: new SessionStateMachine('session-1', store, logger), store };
}

describe('SessionStateMachine', () => {
  it('starts in IDLE', () => {
    const { machine } = makeMachine();
    expect(machine.getState()).toBe('IDLE');
  });

  it('allows IDLE -> READY -> RECORDING and persists each transition', async () => {
    const { machine, store } = makeMachine();
    await machine.transition('READY', 'preflight ok');
    await machine.transition('RECORDING', 'start');
    expect(machine.getState()).toBe('RECORDING');
    expect(await store.get('session:session-1:state')).toBe('RECORDING');
  });

  it('allows RECORDING <-> DEGRADED without losing the recording', async () => {
    const { machine } = makeMachine();
    await machine.transition('READY', 'preflight ok');
    await machine.transition('RECORDING', 'start');
    const toDegraded = await machine.transition('DEGRADED', 'mic silent');
    expect(toDegraded.ok).toBe(true);
    const backToRecording = await machine.transition('RECORDING', 'mic recovered');
    expect(backToRecording.ok).toBe(true);
  });

  it('rejects an invalid transition and leaves the state unchanged', async () => {
    const { machine, store } = makeMachine();
    const result = await machine.transition('DONE', 'skip everything');
    expect(result.ok).toBe(false);
    expect(machine.getState()).toBe('IDLE');
    expect(await store.get('session:session-1:state')).toBeUndefined();
  });
});
