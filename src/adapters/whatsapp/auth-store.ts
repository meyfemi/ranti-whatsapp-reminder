import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from 'baileys';
import type pg from 'pg';

/**
 * Postgres-backed Baileys auth state (replaces the file-based useMultiFileAuthState demo helper),
 * so restarts and redeploys don't require re-pairing. Keys are written in one transaction per
 * `set()` call, as Baileys expects key updates to be persisted atomically.
 */
export async function usePostgresAuthState(
  pool: pg.Pool,
  session: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; clear: () => Promise<void> }> {
  const row = await pool.query<{ creds: string }>('select creds from wa_auth_creds where session = $1', [session]);
  const creds: AuthenticationCreds = row.rows[0]
    ? (JSON.parse(row.rows[0].creds, BufferJSON.reviver) as AuthenticationCreds)
    : initAuthCreds();

  const saveCreds = async () => {
    await pool.query(
      `insert into wa_auth_creds (session, creds, updated_at) values ($1, $2, now())
       on conflict (session) do update set creds = excluded.creds, updated_at = now()`,
      [session, JSON.stringify(creds, BufferJSON.replacer)],
    );
  };

  const get = async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
    const out: { [id: string]: SignalDataTypeMap[T] } = {};
    if (ids.length === 0) return out;
    const res = await pool.query<{ key_id: string; value: string }>(
      'select key_id, value from wa_auth_keys where session = $1 and type = $2 and key_id = any($3::text[])',
      [session, type, ids],
    );
    for (const r of res.rows) {
      let value = JSON.parse(r.value, BufferJSON.reviver);
      if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
      out[r.key_id] = value as SignalDataTypeMap[T];
    }
    return out;
  };

  const set = async (data: SignalDataSet) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
        const entries = data[type] ?? {};
        for (const [id, value] of Object.entries(entries)) {
          if (value) {
            await client.query(
              `insert into wa_auth_keys (session, type, key_id, value) values ($1, $2, $3, $4)
               on conflict (session, type, key_id) do update set value = excluded.value`,
              [session, type, id, JSON.stringify(value, BufferJSON.replacer)],
            );
          } else {
            await client.query('delete from wa_auth_keys where session = $1 and type = $2 and key_id = $3', [
              session,
              type,
              id,
            ]);
          }
        }
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  };

  const clear = async () => {
    await pool.query('delete from wa_auth_keys where session = $1', [session]);
    await pool.query('delete from wa_auth_creds where session = $1', [session]);
  };

  return { state: { creds, keys: { get, set, clear } }, saveCreds, clear };
}
