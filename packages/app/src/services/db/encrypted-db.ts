/**
 * Encrypted Database Service
 * SQLite with SQLCipher for secure local storage
 * 
 * Tables:
 * - identity_keys: Local identity key pair
 * - pre_keys: One-time prekeys (X3DH)
 * - signed_pre_keys: Signed prekeys (X3DH)
 * - sessions: Double Ratchet sessions per conversation
 * - sender_keys: Group Sender Keys
 * - message_index: Message indexing for search
 */

import * as SQLite from 'expo-sqlite';
import { getSecureItem, setSecureItem } from '@/utils/secureStore';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';

/** データベース名 */
const DB_NAME = 'prepito_encrypted.db';

/** SQLCipher 暗号化キー取得 (SecureStore から取得、なければ生成) */
async function getEncryptionKey(): Promise<string> {
  const KEY_NAME = 'prepito.db_encryption_key';
  
  let key = await getSecureItem(KEY_NAME);
  if (!key) {
    // 256-bit キー生成 (32 bytes = 64 hex chars)
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    key = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    await setSecureItem(KEY_NAME, key);
  }
  return key;
}

/** データベースインスタンス取得 (シングルトン) */
let _db: SQLite.SQLiteDatabase | null = null;

export async function getEncryptedDB(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  
  const encryptionKey = await getEncryptionKey();
  
  // SQLite データベースオープン (SQLCipher 暗号化)
  _db = SQLite.openDatabaseSync(DB_NAME, {
    // SQLCipher 用オプション
    // iOS/Android 両対応
    useNewConnection: true,
  });
  
  // 暗号化設定 (PRAGMA key)
  // 注意: expo-sqlite では openDatabaseSync 後に PRAGMA key を実行
  try {
    _db.execSync(`PRAGMA key = "x'${encryptionKey}';`);
    _db.execSync(`PRAGMA cipher_page_size = 4096;`);
    _db.execSync(`PRAGMA kdf_iter = 256000;`);
    _db.execSync(`PRAGMA cipher_hmac_algorithm = HMAC_SHA512;`);
    _db.execSync(`PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512;`);
  } catch (e) {
    console.error('[EncryptedDB] Failed to set encryption pragmas:', e);
    throw e;
  }
  
  // テーブル作成
  await initTables(_db);
  
  console.log('[EncryptedDB] Database initialized with SQLCipher');
  return _db;
}

/** テーブル初期化 */
async function initTables(db: SQLite.SQLiteDatabase): Promise<void> {
  // トランザクションで一括実行
  db.execSync(`
    -- Identity Keys (ローカルユーザーの長期鍵)
    CREATE TABLE IF NOT EXISTS identity_keys (
      id INTEGER PRIMARY KEY CHECK (id = 1),  -- 常に1レコードのみ
      private_key TEXT NOT NULL,               -- base64 encoded
      public_key TEXT NOT NULL,                -- base64 encoded
      registration_id INTEGER NOT NULL,        -- 1-16380
      created_at INTEGER NOT NULL,             -- Unix timestamp (ms)
      updated_at INTEGER NOT NULL
    );

    -- One-Time PreKeys (X3DH 用短期鍵)
    CREATE TABLE IF NOT EXISTS pre_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id INTEGER NOT NULL UNIQUE,          -- PreKey ID (0-16380)
      private_key TEXT NOT NULL,               -- base64 encoded
      public_key TEXT NOT NULL,                -- base64 encoded
      used INTEGER NOT NULL DEFAULT 0,         -- 0=unused, 1=used
      created_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pre_keys_unused ON pre_keys (used) WHERE used = 0;
    CREATE INDEX IF NOT EXISTS idx_pre_keys_key_id ON pre_keys (key_id);

    -- Signed PreKeys (X3DH 用中期間鍵)
    CREATE TABLE IF NOT EXISTS signed_pre_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id INTEGER NOT NULL UNIQUE,          -- Signed PreKey ID
      private_key TEXT NOT NULL,               -- base64 encoded
      public_key TEXT NOT NULL,                -- base64 encoded
      signature TEXT NOT NULL,                 -- base64 encoded (identity key で署名)
      created_at INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1     -- 現在有効なもの
    );
    CREATE INDEX IF NOT EXISTS idx_signed_pre_keys_active ON signed_pre_keys (is_active) WHERE is_active = 1;

    -- Double Ratchet Sessions (会話ごとのセッション)
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,           -- DM: recipientId, Group: groupId
      conversation_type TEXT NOT NULL,         -- 'dm' | 'group'
      -- Root chain
      root_key TEXT NOT NULL,                  -- base64 (32 bytes)
      -- Sending chain
      sending_chain_key TEXT,                  -- base64 (32 bytes)
      sending_message_number INTEGER DEFAULT 0,
      -- Receiving chain
      receiving_chain_key TEXT,                -- base64 (32 bytes)
      receiving_message_number INTEGER DEFAULT 0,
      receiving_chain_keys TEXT,               -- JSON map: message_number -> chain_key
      -- Remote identity
      remote_identity_key TEXT NOT NULL,       -- base64 (X25519 public)
      remote_registration_id INTEGER NOT NULL,
      -- Local identity
      local_registration_id INTEGER NOT NULL,
      -- State
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON sessions (conversation_id, conversation_type);
    CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions (is_active) WHERE is_active = 1;

    -- Sender Keys (グループ E2E 用)
    CREATE TABLE IF NOT EXISTS sender_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,                 -- sender userId
      sender_key TEXT NOT NULL,                -- base64 (Sender Key, 32 bytes)
      created_at INTEGER NOT NULL,
      UNIQUE(group_id, sender_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sender_keys_group ON sender_keys (group_id);

    -- Message Index (検索用・順序保証)
    CREATE TABLE IF NOT EXISTS message_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      conversation_type TEXT NOT NULL,         -- 'dm' | 'group'
      message_id TEXT NOT NULL,                -- サーバー側のメッセージID
      local_id TEXT NOT NULL UNIQUE,           -- ローカル生成ID (送信時の楽観的ID)
      sender_id TEXT NOT NULL,
      message_type TEXT NOT NULL,              -- 'text' | 'image' | 'file' | 'system'
      content TEXT,                            -- 暗号文 (base64) または平文 (オフライン復元用)
      content_hash TEXT,                       -- 暗号化コンテンツのハッシュ (検索用)
      timestamp INTEGER NOT NULL,              -- メッセージ作成時刻
      is_outgoing INTEGER NOT NULL,            -- 1=送信, 0=受信
      status TEXT NOT NULL DEFAULT 'sent',     -- 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_index_conv ON message_index (conversation_id, conversation_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_message_index_local_id ON message_index (local_id);
    CREATE INDEX IF NOT EXISTS idx_message_index_sender ON message_index (sender_id);

    -- App Settings (アプリ設定・状態)
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Database version (マイグレーション用)
    CREATE TABLE IF NOT EXISTS db_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  
  // 初期バージョン記録
  const versionResult = db.getFirstSync<{ version: number }>('SELECT version FROM db_version ORDER BY version DESC LIMIT 1');
  if (!versionResult) {
    db.runSync('INSERT INTO db_version (version, applied_at) VALUES (1, ?)', [Date.now()]);
  } else if (versionResult.version < 2) {
    // マイグレーション v1→v2: message_index に content カラムを追加
    try {
      db.execSync('ALTER TABLE message_index ADD COLUMN content TEXT');
    } catch {
      // カラムが既に存在する場合は無視
    }
    db.runSync('UPDATE db_version SET version = 2, applied_at = ? WHERE version = 1', [Date.now()]);
  }
  
  console.log('[EncryptedDB] Tables initialized');
}

/** データベースクローズ */
export function closeEncryptedDB(): void {
  if (_db) {
    _db.closeSync();
    _db = null;
  }
}

/** データベース削除 (ログアウト時等) */
export async function deleteEncryptedDB(): Promise<void> {
  closeEncryptedDB();
  try {
    const dbPath = `${FileSystem.documentDirectory}${DB_NAME}`;
    await FileSystem.deleteAsync(dbPath, { idempotent: true });
    console.log('[EncryptedDB] Database deleted');
  } catch (e) {
    console.warn('[EncryptedDB] Failed to delete database file:', e);
  }
}

/** ヘルパー: 単一行取得 */
export async function dbGet<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const db = await getEncryptedDB();
  return db.getFirstSync<T>(sql, params as unknown as SQLite.SQLiteBindParams);
}

/** ヘルパー: 複数行取得 */
export async function dbGetAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await getEncryptedDB();
  return db.getAllSync<T>(sql, params as unknown as SQLite.SQLiteBindParams);
}

/** ヘルパー: 実行 (INSERT/UPDATE/DELETE) */
export async function dbRun(sql: string, params: unknown[] = []): Promise<{ lastInsertRowId: number; changes: number }> {
  const db = await getEncryptedDB();
  const result = db.runSync(sql, params as unknown as SQLite.SQLiteBindParams);
  return { lastInsertRowId: result.lastInsertRowId, changes: result.changes };
}

/** ヘルパー: トランザクション実行 (manual BEGIN/COMMIT/ROLLBACK) */
export async function dbTransaction<T>(fn: (db: SQLite.SQLiteDatabase) => T): Promise<T> {
  const db = await getEncryptedDB();
  db.execSync('BEGIN TRANSACTION');
  try {
    const result = fn(db);
    db.execSync('COMMIT');
    return result;
  } catch (e) {
    db.execSync('ROLLBACK');
    throw e;
  }
}

/* =====================================================================
   メッセージ永続化ヘルパー (message_index テーブル)
   ===================================================================== */

type DBMessageRow = {
  id: number;
  conversation_id: string;
  conversation_type: string;
  message_id: string;
  local_id: string;
  sender_id: string;
  message_type: string;
  content: string | null;
  content_hash: string | null;
  timestamp: number;
  is_outgoing: number;
  status: string;
  created_at: number;
};

/** メッセージを1件保存 (UPSERT) */
export async function saveMessage(message: {
  conversationId: string;
  conversationType: 'dm' | 'group';
  messageId: string;
  localId: string;
  senderId: string;
  messageType: string;
  content?: string | null;
  contentHash?: string | null;
  timestamp: number;
  isOutgoing: boolean;
  status: string;
}): Promise<void> {
  await dbRun(
    'INSERT INTO message_index (conversation_id, conversation_type, message_id, local_id, sender_id, message_type, content, content_hash, timestamp, is_outgoing, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(local_id) DO UPDATE SET message_id = excluded.message_id, content = excluded.content, content_hash = excluded.content_hash, status = excluded.status, updated_at = excluded.created_at',
    [
      message.conversationId,
      message.conversationType,
      message.messageId,
      message.localId,
      message.senderId,
      message.messageType,
      message.content ?? null,
      message.contentHash ?? null,
      message.timestamp,
      message.isOutgoing ? 1 : 0,
      message.status,
      message.timestamp,
    ]
  );
}

/** メッセージステータス更新 */
export async function updateMessageStatus(localId: string, status: string): Promise<void> {
  await dbRun('UPDATE message_index SET status = ? WHERE local_id = ?', [status, localId]);
}

/** 会話のメッセージ一覧を時系列で取得 */
export async function loadMessages(
  conversationId: string,
  conversationType: 'dm' | 'group',
  limit: number = 100
): Promise<DBMessageRow[]> {
  return dbGetAll<DBMessageRow>(
    'SELECT * FROM message_index WHERE conversation_id = ? AND conversation_type = ? ORDER BY timestamp ASC LIMIT ?',
    [conversationId, conversationType, limit]
  );
}

/** 未読メッセージ数取得 (受信・未読のみ) */
export async function loadUnreadCount(conversationId: string, conversationType: 'dm' | 'group'): Promise<number> {
  const row = await dbGet<{ count: number }>(
    'SELECT COUNT(*) as count FROM message_index WHERE conversation_id = ? AND conversation_type = ? AND is_outgoing = 0 AND status != ?',
    [conversationId, conversationType, 'read']
  );
  return row?.count || 0;
}

/** メッセージを既読にする */
export async function markMessagesRead(conversationId: string, conversationType: 'dm' | 'group'): Promise<void> {
  await dbRun(
    'UPDATE message_index SET status = ? WHERE conversation_id = ? AND conversation_type = ? AND is_outgoing = 0',
    ['read', conversationId, conversationType]
  );
}