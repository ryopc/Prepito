/**
 * Signal Protocol の鍵・セッションストア
 *
 * DB (SQLCipher) と SecureStore に Signal Protocol の状態を永続化する。
 *
 * テーブル:
 * - pre_keys / signed_pre_keys / identity_keys / sender_keys
 *   → encrypted-db.ts が作成する既存テーブル
 * - signal_sessions / signal_remote_identities
 *   → 本モジュールが作成する専用テーブル
 *   (既存の sessions テーブルには session_data カラムが無く、
 *    Double Ratchet の状態 (ratchet 鍵・chain key・message key) を
 *    1 カラムに収める必要があるため専用テーブルを使う)
 */

import { dbGet, dbGetAll, dbRun } from '../db/encrypted-db';
import { getSecureItem, setSecureItem, loadDeviceKeys } from '../../utils/secureStore';
import { base64ToBytes, bytesToBase64 } from './bytes';
import type { Direction, IdentityKeyPair, ProtocolAddress } from './signal-keys';
import { PrivateKey, PublicKey } from './signal-keys';
import { SessionState } from './signal-session';

/* =====================================================================
   テーブル初期化
   ===================================================================== */

let schemaReady: Promise<void> | null = null;

/** crypto モジュール専用のテーブルを作成する (冪等) */
async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await dbRun(
        'CREATE TABLE IF NOT EXISTS signal_sessions (' +
          'conversation_id TEXT NOT NULL,' +
          'conversation_type TEXT NOT NULL,' +
          'session_data TEXT NOT NULL,' +
          'created_at INTEGER NOT NULL,' +
          'updated_at INTEGER NOT NULL,' +
          'is_active INTEGER NOT NULL DEFAULT 1,' +
          'PRIMARY KEY (conversation_id, conversation_type)' +
          ')'
      );
      await dbRun(
        'CREATE TABLE IF NOT EXISTS signal_remote_identities (' +
          'conversation_id TEXT NOT NULL,' +
          'conversation_type TEXT NOT NULL,' +
          'identity_key TEXT NOT NULL,' +
          'created_at INTEGER NOT NULL,' +
          'updated_at INTEGER NOT NULL,' +
          'is_active INTEGER NOT NULL DEFAULT 1,' +
          'PRIMARY KEY (conversation_id, conversation_type)' +
          ')'
      );
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

function conversationTypeOf(address: ProtocolAddress): string {
  return address.name().includes('@') ? 'group' : 'dm';
}

/* =====================================================================
   PreKey Store (low-level helpers)
   ===================================================================== */

type DBPreKeyRow = { key_id: number; private_key: string; public_key: string; used: number };

export async function loadPreKey(
  keyId: number
): Promise<{ keyId: number; privateKey: string; publicKey: string } | null> {
  const row = await dbGet<DBPreKeyRow>(
    'SELECT key_id, private_key, public_key, used FROM pre_keys WHERE key_id = ?',
    [keyId]
  );
  if (!row || row.used) return null;
  return { keyId: row.key_id, privateKey: row.private_key, publicKey: row.public_key };
}

export async function storePreKey(keyId: number, privateKey: PrivateKey): Promise<void> {
  await dbRun(
    'INSERT INTO pre_keys (key_id, private_key, public_key, used, created_at) VALUES (?, ?, ?, 0, ?) ' +
      'ON CONFLICT(key_id) DO UPDATE SET private_key = excluded.private_key, public_key = excluded.public_key',
    [
      keyId,
      bytesToBase64(privateKey.serialize()),
      bytesToBase64(privateKey.getPublicKey().serialize()),
      Date.now(),
    ]
  );
}

export async function removePreKey(keyId: number): Promise<void> {
  await dbRun('DELETE FROM pre_keys WHERE key_id = ?', [keyId]);
}

export async function getUnusedPreKeys(): Promise<{ keyId: number; privateKey: string }[]> {
  const rows = await dbGetAll<DBPreKeyRow>(
    'SELECT key_id, private_key, public_key FROM pre_keys WHERE used = 0 ORDER BY key_id ASC'
  );
  return rows.map((row) => ({ keyId: row.key_id, privateKey: row.private_key }));
}

export async function markPreKeyUsed(keyId: number): Promise<void> {
  await dbRun('UPDATE pre_keys SET used = 1, used_at = ? WHERE key_id = ?', [Date.now(), keyId]);
}

export async function getPreKeyCount(): Promise<{ total: number; unused: number }> {
  const totalRow = await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM pre_keys');
  const unusedRow = await dbGet<{ count: number }>(
    'SELECT COUNT(*) as count FROM pre_keys WHERE used = 0'
  );
  return { total: totalRow?.count || 0, unused: unusedRow?.count || 0 };
}

/* =====================================================================
   Signed PreKey Store
   ===================================================================== */

type DBSignedPreKeyRow = {
  key_id: number;
  private_key: string;
  public_key: string;
  signature: string;
};

export async function loadSignedPreKey(
  keyId: number
): Promise<{ keyId: number; privateKey: string; publicKey: string; signature: string } | null> {
  const row = await dbGet<DBSignedPreKeyRow>(
    'SELECT key_id, private_key, public_key, signature FROM signed_pre_keys WHERE key_id = ? AND is_active = 1',
    [keyId]
  );
  if (!row) return null;
  return {
    keyId: row.key_id,
    privateKey: row.private_key,
    publicKey: row.public_key,
    signature: row.signature,
  };
}

export async function storeSignedPreKey(
  keyId: number,
  signedPreKey: { privateKey: PrivateKey; publicKey: PublicKey; signature: Uint8Array }
): Promise<void> {
  await dbRun(
    'INSERT INTO signed_pre_keys (key_id, private_key, public_key, signature, created_at, is_active) VALUES (?, ?, ?, ?, ?, 1) ' +
      'ON CONFLICT(key_id) DO UPDATE SET private_key = excluded.private_key, public_key = excluded.public_key, signature = excluded.signature, is_active = 1',
    [
      keyId,
      bytesToBase64(signedPreKey.privateKey.serialize()),
      bytesToBase64(signedPreKey.publicKey.serialize()),
      bytesToBase64(signedPreKey.signature),
      Date.now(),
    ]
  );
}

export async function removeSignedPreKey(keyId: number): Promise<void> {
  await dbRun('UPDATE signed_pre_keys SET is_active = 0 WHERE key_id = ?', [keyId]);
}

export async function getActiveSignedPreKey(): Promise<{
  keyId: number;
  record: { privateKey: string; publicKey: string; signature: string };
} | null> {
  const row = await dbGet<DBSignedPreKeyRow>(
    'SELECT key_id, private_key, public_key, signature FROM signed_pre_keys WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1'
  );
  if (!row) return null;
  return {
    keyId: row.key_id,
    record: { privateKey: row.private_key, publicKey: row.public_key, signature: row.signature },
  };
}

/* =====================================================================
   Session Store
   ===================================================================== */

type DBSessionRow = { session_data: string };

export async function saveSession(
  address: ProtocolAddress,
  sessionRecord: SessionState
): Promise<void> {
  await ensureSchema();
  const conversationId = address.name();
  const conversationType = conversationTypeOf(address);
  const serialized = JSON.stringify(sessionRecord.toJSON());
  await dbRun(
    'INSERT INTO signal_sessions (conversation_id, conversation_type, session_data, created_at, updated_at, is_active) ' +
      'VALUES (?, ?, ?, ?, ?, 1) ' +
      'ON CONFLICT(conversation_id, conversation_type) DO UPDATE SET session_data = excluded.session_data, updated_at = excluded.updated_at, is_active = 1',
    [conversationId, conversationType, serialized, Date.now(), Date.now()]
  );
}

export async function loadSession(address: ProtocolAddress): Promise<SessionState | null> {
  await ensureSchema();
  const conversationId = address.name();
  const conversationType = conversationTypeOf(address);
  const row = await dbGet<DBSessionRow>(
    'SELECT session_data FROM signal_sessions WHERE conversation_id = ? AND conversation_type = ? AND is_active = 1',
    [conversationId, conversationType]
  );
  if (!row) return null;
  try {
    return SessionState.fromJSON(JSON.parse(row.session_data) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function loadExistingSessions(addresses: ProtocolAddress[]): Promise<SessionState[]> {
  const results: SessionState[] = [];
  for (const address of addresses) {
    const session = await loadSession(address);
    if (session) results.push(session);
  }
  return results;
}

export async function deleteSession(address: ProtocolAddress): Promise<void> {
  await ensureSchema();
  const conversationId = address.name();
  const conversationType = conversationTypeOf(address);
  await dbRun(
    'UPDATE signal_sessions SET is_active = 0 WHERE conversation_id = ? AND conversation_type = ?',
    [conversationId, conversationType]
  );
}

export async function deleteAllSessions(): Promise<void> {
  await ensureSchema();
  await dbRun('UPDATE signal_sessions SET is_active = 0');
}

/* =====================================================================
   Identity Key Store
   ===================================================================== */

export async function getIdentityKey(): Promise<PrivateKey> {
  // SecureStore が正 (device-keys.ts がここに保存する)
  const bundle = await loadDeviceKeys();
  if (bundle?.identityKeyPrivate) {
    return PrivateKey.deserialize(base64ToBytes(bundle.identityKeyPrivate));
  }

  const row = await getDeviceKeyBundle();
  if (!row) throw new Error('Identity key not found');
  return PrivateKey.deserialize(base64ToBytes(row.private_key));
}

export async function getLocalRegistrationId(): Promise<number> {
  const regId = await getSecureItem('prepito.registration_id');
  if (regId) return parseInt(regId, 10);
  const newRegId = Math.floor(Math.random() * 16380) + 1;
  await setSecureItem('prepito.registration_id', String(newRegId));
  return newRegId;
}

export async function saveIdentity(address: ProtocolAddress, key: PublicKey): Promise<boolean> {
  await ensureSchema();
  const conversationId = address.name();
  const conversationType = conversationTypeOf(address);
  await dbRun(
    'INSERT INTO signal_remote_identities (conversation_id, conversation_type, identity_key, created_at, updated_at, is_active) ' +
      'VALUES (?, ?, ?, ?, ?, 1) ' +
      'ON CONFLICT(conversation_id, conversation_type) DO UPDATE SET identity_key = excluded.identity_key, updated_at = excluded.updated_at, is_active = 1',
    [conversationId, conversationType, bytesToBase64(key.serialize()), Date.now(), Date.now()]
  );
  return true;
}

export async function isTrustedIdentity(
  address: ProtocolAddress,
  key: PublicKey,
  _direction: Direction
): Promise<boolean> {
  const stored = await getIdentity(address);
  // 未登録の相手は TOFU (trust on first use) で信頼する
  if (!stored) return true;
  return stored.equals(key);
}

export async function getIdentity(address: ProtocolAddress): Promise<PublicKey | null> {
  await ensureSchema();
  const row = await dbGet<{ identity_key: string }>(
    'SELECT identity_key FROM signal_remote_identities WHERE conversation_id = ? AND conversation_type = ? AND is_active = 1',
    [address.name(), conversationTypeOf(address)]
  );
  if (!row) return null;
  try {
    return PublicKey.deserialize(base64ToBytes(row.identity_key));
  } catch {
    return null;
  }
}

type DBIdentityRow = { private_key: string; public_key: string };

export async function getDeviceKeyBundle(): Promise<DBIdentityRow | null> {
  const bundle = await loadDeviceKeys();
  if (bundle?.identityKeyPrivate && bundle?.identityKeyPublic) {
    return { private_key: bundle.identityKeyPrivate, public_key: bundle.identityKeyPublic };
  }

  const row = await dbGet<DBIdentityRow>(
    'SELECT private_key, public_key FROM identity_keys WHERE id = 1'
  );
  return row ?? null;
}

export async function saveIdentityKeyPair(identityKeyPair: IdentityKeyPair): Promise<void> {
  const registrationId = await getLocalRegistrationId();
  await dbRun(
    'INSERT INTO identity_keys (id, private_key, public_key, registration_id, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET private_key = excluded.private_key, public_key = excluded.public_key, registration_id = excluded.registration_id, updated_at = excluded.updated_at',
    [
      bytesToBase64(identityKeyPair.privateKey.serialize()),
      bytesToBase64(identityKeyPair.publicKey.serialize()),
      registrationId,
      Date.now(),
      Date.now(),
    ]
  );
}

/* =====================================================================
   Sender Key Store (グループ E2E 用)
   ===================================================================== */

type DBSenderKeyRow = { sender_key: string };

export async function loadSenderKey(
  groupId: string,
  senderId: string
): Promise<{ data: string } | null> {
  const row = await dbGet<DBSenderKeyRow>(
    'SELECT sender_key FROM sender_keys WHERE group_id = ? AND sender_id = ?',
    [groupId, senderId]
  );
  if (!row) return null;
  return { data: row.sender_key };
}

export async function storeSenderKey(
  groupId: string,
  senderId: string,
  record: { serialize(): Uint8Array }
): Promise<void> {
  const serialized = bytesToBase64(record.serialize());
  await dbRun(
    'INSERT INTO sender_keys (group_id, sender_id, sender_key, created_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(group_id, sender_id) DO UPDATE SET sender_key = excluded.sender_key',
    [groupId, senderId, serialized, Date.now()]
  );
}

export async function removeSenderKey(groupId: string, senderId: string): Promise<void> {
  await dbRun('DELETE FROM sender_keys WHERE group_id = ? AND sender_id = ?', [groupId, senderId]);
}

/* =====================================================================
   Store 実装 (libsignal-client 互換のインターフェース)
   ===================================================================== */

/** SessionStore 実装 (Double Ratchet セッション永続化) */
export class SignalSessionStore {
  async saveSession(name: ProtocolAddress, record: SessionState): Promise<void> {
    await saveSession(name, record);
  }
  async getSession(name: ProtocolAddress): Promise<SessionState | null> {
    return loadSession(name);
  }
  async getExistingSessions(addresses: ProtocolAddress[]): Promise<SessionState[]> {
    return loadExistingSessions(addresses);
  }
  async deleteSession(name: ProtocolAddress): Promise<void> {
    await deleteSession(name);
  }
  async deleteAllSessions(): Promise<void> {
    await deleteAllSessions();
  }
}

/** IdentityKeyStore 実装 (アイデンティティ鍵・登録ID) */
export class SignalIdentityStore {
  async getIdentityKey(): Promise<PrivateKey> {
    return getIdentityKey();
  }
  async getLocalRegistrationId(): Promise<number> {
    return getLocalRegistrationId();
  }
  async saveIdentity(name: ProtocolAddress, key: PublicKey): Promise<boolean> {
    return saveIdentity(name, key);
  }
  async isTrustedIdentity(
    name: ProtocolAddress,
    key: PublicKey,
    direction: Direction
  ): Promise<boolean> {
    return isTrustedIdentity(name, key, direction);
  }
  async getIdentity(name: ProtocolAddress): Promise<PublicKey | null> {
    return getIdentity(name);
  }
}

/** PreKeyStore 実装 (One-Time PreKey) */
export class SignalPreKeyStore {
  async savePreKey(id: number, record: { privateKey: PrivateKey }): Promise<void> {
    await storePreKey(id, record.privateKey);
  }
  async getPreKey(id: number): Promise<{ privateKey(): PrivateKey; publicKey(): PublicKey }> {
    const row = await loadPreKey(id);
    if (!row) throw new Error(`PreKey ${id} not found`);
    const privateKey = PrivateKey.deserialize(base64ToBytes(row.privateKey));
    return {
      privateKey: () => privateKey,
      publicKey: () => privateKey.getPublicKey(),
    };
  }
  async removePreKey(id: number): Promise<void> {
    await removePreKey(id);
  }
}

/** SignedPreKeyStore 実装 (Signed PreKey) */
export class SignalSignedPreKeyStore {
  async saveSignedPreKey(
    id: number,
    record: { privateKey(): PrivateKey; publicKey(): PublicKey; signature(): Uint8Array }
  ): Promise<void> {
    await storeSignedPreKey(id, {
      privateKey: record.privateKey(),
      publicKey: record.publicKey(),
      signature: record.signature(),
    });
  }
  async getSignedPreKey(id: number): Promise<{
    privateKey(): PrivateKey;
    publicKey(): PublicKey;
    signature(): Uint8Array;
  }> {
    const row = await loadSignedPreKey(id);
    if (!row) throw new Error(`SignedPreKey ${id} not found`);
    const privateKey = PrivateKey.deserialize(base64ToBytes(row.privateKey));
    return {
      privateKey: () => privateKey,
      publicKey: () => PublicKey.deserialize(base64ToBytes(row.publicKey)),
      signature: () => base64ToBytes(row.signature),
    };
  }
}

/** SenderKeyStore 実装 (グループ Sender Key) */
export class SignalSenderKeyStore {
  async saveSenderKey(
    sender: ProtocolAddress,
    distributionId: string,
    record: { serialize(): Uint8Array }
  ): Promise<void> {
    await storeSenderKey(sender.name(), distributionId, record);
  }
  async getSenderKey(
    sender: ProtocolAddress,
    distributionId: string
  ): Promise<{ serialize(): Uint8Array } | null> {
    const row = await loadSenderKey(sender.name(), distributionId);
    if (!row) return null;
    return { serialize: () => base64ToBytes(row.data) };
  }
}
