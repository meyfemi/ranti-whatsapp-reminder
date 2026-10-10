import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { usePostgresAuthState } from '../src/adapters/whatsapp/auth-store.js';
import { createDb } from '../src/db/client.js';

const handle = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => handle.close());
beforeEach(() => handle.pool.query('truncate wa_auth_creds, wa_auth_keys'));

describe('usePostgresAuthState', () => {
  it('persists creds (including binary keys) across "restarts"', async () => {
    const first = await usePostgresAuthState(handle.pool, 'main');
    const original = first.state.creds;
    original.registered = true;
    await first.saveCreds();

    const second = await usePostgresAuthState(handle.pool, 'main');
    expect(second.state.creds.registered).toBe(true);
    expect(second.state.creds.registrationId).toBe(original.registrationId);
    expect(Buffer.from(second.state.creds.noiseKey.private).equals(Buffer.from(original.noiseKey.private))).toBe(true);
    expect(Buffer.isBuffer(second.state.creds.noiseKey.private)).toBe(true);

    // Sessions are isolated by name.
    const other = await usePostgresAuthState(handle.pool, 'other');
    expect(other.state.creds.registered).toBe(false);
  });

  it('stores, reads, overwrites and deletes signal keys atomically', async () => {
    const { state } = await usePostgresAuthState(handle.pool, 'main');
    const keyPair = { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) };
    await state.keys.set({
      'pre-key': { '1': keyPair, '2': keyPair },
      session: { 'abc.0': Buffer.from('session-bytes') },
      'app-state-sync-key': { K1: { keyData: Buffer.from([9, 9]), timestamp: 123 } },
      'lid-mapping': { '2348000000001': '11111111111111@lid' },
    });

    const pre = await state.keys.get('pre-key', ['1', '2', '3']);
    expect(Object.keys(pre).sort()).toEqual(['1', '2']);
    expect(Buffer.from(pre['1']!.private).equals(keyPair.private)).toBe(true);

    const app = await state.keys.get('app-state-sync-key', ['K1']);
    expect(Buffer.from(app.K1!.keyData!).equals(Buffer.from([9, 9]))).toBe(true);
    expect((await state.keys.get('lid-mapping', ['2348000000001']))['2348000000001']).toBe('11111111111111@lid');

    await state.keys.set({ 'pre-key': { '1': null, '2': { ...keyPair, private: Buffer.from([7]) } } });
    const after = await state.keys.get('pre-key', ['1', '2']);
    expect(after['1']).toBeUndefined();
    expect(Buffer.from(after['2']!.private).equals(Buffer.from([7]))).toBe(true);
  });

  it('clear() removes the session', async () => {
    const auth = await usePostgresAuthState(handle.pool, 'main');
    await auth.saveCreds();
    await auth.state.keys.set({ session: { x: Buffer.from('y') } });
    await auth.clear();
    const { rows } = await handle.pool.query('select count(*)::int as n from wa_auth_keys');
    expect(rows[0].n).toBe(0);
    expect((await usePostgresAuthState(handle.pool, 'main')).state.creds.registered).toBe(false);
  });
});
