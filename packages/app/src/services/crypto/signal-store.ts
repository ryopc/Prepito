/**
 * Signal Protocol Store Implementation
 * Simple wrapper functions & store classes for libsignal-client v0.40
 * Avoids complex abstract class implementations
 */

import {
  ProtocolAddress,
  PreKeyBundle,
  PreKeyRecord,
  SignedPreKeyRecord,
  SenderKeyRecord,
  IdentityKeyPair,
  PrivateKey,
  PublicKey,
  SessionRecord,
  SessionStore,
  IdentityKeyStore,
  PreKeyStore,
  SignedPreKeyStore,
  SenderKeyStore,
  Direction,
} from '@signalapp/libsignal-client';
import {
  getEncryptedDB,
  dbGet,
  dbGetAll,
  dbRun,
} from '../db/encrypted-db';
import {
  getSecureItem,
  setSecureItem,
} from '../../utils/secureStore';

/* =====================================================================
   Helpers
   ===================================================================== */

function toBase64(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

function base64ToPrivateKey(base64: string): PrivateKey {
  return PrivateKey.deserialize(fromBase64(base64));
}

function base64ToPublicKey(base64: string): PublicKey {
  return PublicKey.deserialize(fromBase64(base64));
}

/* =====================================================================
   PreKey Store (low-level helpers)
   ===================================================================== */

type DBPreKeyRow = { key_id: number; private_key: string; public_key: string; used: number };

export async function loadPreKey(keyId: number): Promise<{ keyId: number; privateKey: string; publicKey: string } | null> {
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
    [keyId, toBase64(privateKey.serialize()), toBase64(privateKey.getPublicKey().serialize()), Date.now()]
  );
}

export async function removePreKey(keyId: number): Promise<void> {
  await dbRun('DELETE FROM pre_keys WHERE key_id = ?', [keyId]);
}

export async function getUnusedPreKeys(): Promise<Array<{ keyId: number; privateKey: string }>> {
  const rows = await dbGetAll<DBPreKeyRow>(
    'SELECT key_id, private_key, public_key FROM pre_keys WHERE used = 0 ORDER BY key_id ASC'
  );
  return rows.map(row => ({ keyId: row.key_id, privateKey: row.private_key }));
}

export async function markPreKeyUsed(keyId: number): Promise<void> {
  await dbRun('UPDATE pre_keys SET used = 1, used_at = ? WHERE key_id = ?', [Date.now(), keyId]);
}

export async function getPreKeyCount(): Promise<{ total: number; unused: number }> {
  const totalRow = await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM pre_keys');
  const unusedRow = await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM pre_keys WHERE used = 0');
  return { total: totalRow?.count || 0, unused: unusedRow?.count || 0 };
}

/* =====================================================================
   Signed PreKey Store
   ===================================================================== */

type DBSignedPreKeyRow = { key_id: number; private_key: string; public_key: string; signature: string };

export async function loadSignedPreKey(keyId: number): Promise<{ keyId: number; privateKey: string; publicKey: string; signature: string } | null> {
  const row = await dbGet<DBSignedPreKeyRow>(
    'SELECT key_id, private_key, public_key, signature FROM signed_pre_keys WHERE key_id = ? AND is_active = 1',
    [keyId]
  );
  if (!row) return null;
  return { keyId: row.key_id, privateKey: row.private_key, publicKey: row.public_key, signature: row.signature };
}

export async function storeSignedPreKey(keyId: number, signedPreKey: { privateKey: PrivateKey; publicKey: PublicKey; signature: Buffer }): Promise<void> {
  await dbRun(
    'INSERT INTO signed_pre_keys (key_id, private_key, public_key, signature, created_at, is_active) VALUES (?, ?, ?, ?, ?, 1) ' +
    'ON CONFLICT(key_id) DO UPDATE SET private_key = excluded.private_key, public_key = excluded.public_key, signature = excluded.signature, is_active = 1',
    [keyId, toBase64(signedPreKey.privateKey.serialize()), toBase64(signedPreKey.publicKey.serialize()), toBase64(signedPreKey.signature), Date.now()]
  );
}

export async function removeSignedPreKey(keyId: number): Promise<void> {
  await dbRun('UPDATE signed_pre_keys SET is_active = 0 WHERE key_id = ?', [keyId]);
}

export async function getActiveSignedPreKey(): Promise<{ keyId: number; record: { privateKey: string; publicKey: string; signature: string } } | null> {
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

export async function saveSession(address: ProtocolAddress, sessionRecord: SessionRecord): Promise<void> {
  const conversationId = address.name();
  const conversationType = conversationId.includes('@') ? 'dm' : 'group';
  const serialized = toBase64(sessionRecord.serialize());
  await dbRun(
    'INSERT INTO sessions (conversation_id, conversation_type, session_data, created_at, updated_at, is_active) VALUES (?, ?, ?, ?, ?, 1) ' +
    'ON CONFLICT(conversation_id) DO UPDATE SET session_data = excluded.session_data, updated_at = excluded.updated_at, is_active = 1',
    [conversationId, conversationType, serialized, Date.now(), Date.now()]
  );
}

export async function loadSession(address: ProtocolAddress): Promise<SessionRecord | null> {
  const conversationId = address.name();
  const conversationType = conversationId.includes('@') ? 'dm' : 'group';
  const row = await dbGet<DBSessionRow>(
    'SELECT session_data FROM sessions WHERE conversation_id = ? AND conversation_type = ? AND is_active = 1',
    [conversationId, conversationType]
  );
  if (!row) return null;
  try {
    return SessionRecord.deserialize(fromBase64(row.session_data));
  } catch {
    return null;
  }
}

export async function loadExistingSessions(addresses: ProtocolAddress[]): Promise<SessionRecord[]> {
  const results: SessionRecord[] = [];
  for (const address of addresses) {
    const session = await loadSession(address);
    if (session) results.push(session);
  }
  return results;
}

export async function deleteSession(address: ProtocolAddress): Promise<void> {
  const conversationId = address.name();
  const conversationType = conversationId.includes('@') ? 'dm' : 'group';
  await dbRun(
    'UPDATE sessions SET is_active = 0 WHERE conversation_id = ? AND conversation_type = ?',
    [conversationId, conversationType]
  );
}

export async function deleteAllSessions(): Promise<void> {
  await dbRun('UPDATE sessions SET is_active = 0');
}

/* =====================================================================
   Identity Key Store
   ===================================================================== */

export async function getIdentityKey(): Promise<PrivateKey> {
  const bundle = await getDeviceKeyBundle();
  if (!bundle) throw new Error('Identity key not found');
  return base64ToPrivateKey(bundle.private_key);
}

export async function getLocalRegistrationId(): Promise<number> {
  let regId = await getSecureItem('prepito.registration_id');
  if (regId) return parseInt(regId, 10);
  const newRegId = Math.floor(Math.random() * 16380) + 1;
  await setSecureItem('prepito.registration_id', String(newRegId));
  return newRegId;
}

export async function saveIdentity(address: ProtocolAddress, key: PublicKey): Promise<boolean> {
  return true;
}

export async function isTrustedIdentity(address: ProtocolAddress, key: PublicKey, direction: Direction): Promise<boolean> {
  return true;
}

export async function getIdentity(address: ProtocolAddress): Promise<PublicKey | null> {
  return null;
}

type DBIdentityRow = { private_key: string; public_key: string };

export async function getDeviceKeyBundle(): Promise<DBIdentityRow | null> {
  return dbGet<DBIdentityRow>('SELECT private_key as identityKeyPrivate, public_key as identityKeyPublic FROM identity_keys WHERE id = 1');
}

export async function saveIdentityKeyPair(identityKeyPair: IdentityKeyPair): Promise<void> {
  const registrationId = await getLocalRegistrationId();
  await dbRun(
    'INSERT INTO identity_keys (id, private_key, public_key, registration_id, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET private_key = excluded.private_key, public_key = excluded.public_key, registration_id = excluded.registration_id, updated_at = excluded.updated_at',
    [toBase64(identityKeyPair.privateKey.serialize()), toBase64(identityKeyPair.publicKey.serialize()), registrationId, Date.now(), Date.now()]
  );
}

/* =====================================================================
   Sender Key Store
   ===================================================================== */

type DBSenderKeyRow = { sender_key: string };

export async function loadSenderKey(groupId: string, senderId: string): Promise<{ data: string } | null> {
  const row = await dbGet<DBSenderKeyRow>(
    'SELECT sender_key FROM sender_keys WHERE group_id = ? AND sender_id = ?',
    [groupId, senderId]
  );
  if (!row) return null;
  return { data: row.sender_key };
}

export async function storeSenderKey(groupId: string, senderId: string, record: SenderKeyRecord): Promise<void> {
  const serialized = toBase64(record.serialize());
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
   libsignal-client Store Implementations
   ===================================================================== */

/** SessionStore 実装 (Double Ratchet セッション永続化) */
export class SignalSessionStore extends SessionStore {
  async saveSession(name: ProtocolAddress, record: SessionRecord): Promise<void> {
    await saveSession(name, record);
  }
  async getSession(name: ProtocolAddress): Promise<SessionRecord | null> {
    return loadSession(name);
  }
  async getExistingSessions(addresses: ProtocolAddress[]): Promise<SessionRecord[]> {
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
export class SignalIdentityStore extends IdentityKeyStore {
  async getIdentityKey(): Promise<PrivateKey> {
    return getIdentityKey();
  }
  async getLocalRegistrationId(): Promise<number> {
    return getLocalRegistrationId();
  }
  async saveIdentity(name: ProtocolAddress, key: PublicKey): Promise<boolean> {
    return saveIdentity(name, key);
  }
  async isTrustedIdentity(name: ProtocolAddress, key: PublicKey, direction: Direction): Promise<boolean> {
    return isTrustedIdentity(name, key, direction);
  }
  async getIdentity(name: ProtocolAddress): Promise<PublicKey | null> {
    return getIdentity(name);
  }
}

/** PreKeyStore 実装 (One-Time PreKey) */
export class SignalPreKeyStore extends PreKeyStore {
  async savePreKey(id: number, record: PreKeyRecord): Promise<void> {
    await storePreKey(id, record.privateKey());
  }
  async getPreKey(id: number): Promise<PreKeyRecord> {
    const row = await loadPreKey(id);
    if (!row) throw new Error(`PreKey ${id} not found`);
    return PreKeyRecord.new(id, base64ToPublicKey(row.publicKey), base64ToPrivateKey(row.privateKey));
  }
  async removePreKey(id: number): Promise<void> {
    await removePreKey(id);
  }
}

/** SignedPreKeyStore 実装 (Signed PreKey) */
export class SignalSignedPreKeyStore extends SignedPreKeyStore {
  async saveSignedPreKey(id: number, record: SignedPreKeyRecord): Promise<void> {
    await storeSignedPreKey(id, {
      privateKey: record.privateKey(),
      publicKey: record.publicKey(),
      signature: record.signature(),
    });
  }
  async getSignedPreKey(id: number): Promise<SignedPreKeyRecord> {
    const row = await loadSignedPreKey(id);
    if (!row) throw new Error(`SignedPreKey ${id} not found`);
    return SignedPreKeyRecord.new(
      id,
      Date.now(),
      base64ToPublicKey(row.publicKey),
      base64ToPrivateKey(row.privateKey),
      fromBase64(row.signature)
    );
  }
}

/** SenderKeyStore 実装 (グループ Sender Key) */
export class SignalSenderKeyStore extends SenderKeyStore {
  async saveSenderKey(sender: ProtocolAddress, distributionId: string, record: SenderKeyRecord): Promise<void> {
    await storeSenderKey(sender.name(), distributionId, record);
  }
  async getSenderKey(sender: ProtocolAddress, distributionId: string): Promise<SenderKeyRecord | null> {
    const row = await loadSenderKey(sender.name(), distributionId);
    if (!row) return null;
    return SenderKeyRecord.deserialize(fromBase64(row.data));
  }
}
