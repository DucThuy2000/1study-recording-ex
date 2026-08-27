import { describe, it, expect } from 'vitest';
import { SessionLedger } from '../session-ledger';
import { InMemoryStore } from '../../adapters/storage';

describe('SessionLedger', () => {
  it('starts a session with zeroed counters', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 1000 });
    expect(await ledger.get('s1')).toEqual({
      sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 1000,
      status: 'RECORDING', totalChunks: 0, bytesTotal: 0,
    });
  });

  it('accumulates chunk counts and bytes', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0 });
    await ledger.recordChunk('s1', 1000);
    await ledger.recordChunk('s1', 2000);
    const entry = await ledger.get('s1');
    expect(entry?.totalChunks).toBe(2);
    expect(entry?.bytesTotal).toBe(3000);
  });

  it('recordChunk on an unknown session is a no-op', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await expect(ledger.recordChunk('missing', 100)).resolves.toBeUndefined();
    expect(await ledger.get('missing')).toBeUndefined();
  });

  it('updates status without touching counters', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await ledger.start({ sessionId: 's1', meetingCode: 'abc-defg-hij', tabId: 1, startedAtMs: 0 });
    await ledger.recordChunk('s1', 500);
    await ledger.setStatus('s1', 'DONE');
    const entry = await ledger.get('s1');
    expect(entry?.status).toBe('DONE');
    expect(entry?.bytesTotal).toBe(500);
  });

  it('lists every started session', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await ledger.start({ sessionId: 's1', meetingCode: 'a', tabId: 1, startedAtMs: 0 });
    await ledger.start({ sessionId: 's2', meetingCode: 'b', tabId: 2, startedAtMs: 1 });
    const all = await ledger.list();
    expect(all.map((e) => e.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('setChunkCount overwrites totals directly (crash-recovery reconciliation)', async () => {
    const ledger = new SessionLedger(new InMemoryStore());
    await ledger.start({ sessionId: 's1', meetingCode: 'a', tabId: 1, startedAtMs: 0 });
    await ledger.recordChunk('s1', 500);
    await ledger.setChunkCount('s1', 3, 9000);
    const entry = await ledger.get('s1');
    expect(entry?.totalChunks).toBe(3);
    expect(entry?.bytesTotal).toBe(9000);
  });
});
