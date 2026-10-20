/**
 * 最小限の Protocol Buffers エンコーダ / デコーダ
 *
 * Signal Protocol の wire format (libsignal-client v0.40) は
 * Protobuf ベースなので、必要なフィールドだけを自前で実装する。
 *
 * 参照: rust/protocol/src/proto/wire.proto
 *
 * Node core ( crypto / buffer 等 ) は import しない。
 */

import { concatBytes } from './bytes';

export const WIRE_TYPE_VARINT = 0;
export const WIRE_TYPE_LENGTH_DELIMITED = 2;

/** デコード済みフィールド */
export interface ProtobufField {
  wireType: number;
  /** wireType が 0 なら varint 値、2 ならバイト列 */
  value: number | Uint8Array;
}

/** varint のエンコード (7 ビットずつ LSB 先行) */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid varint value: ${value}`);
  }
  const out: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    out.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  out.push(remaining);
  return new Uint8Array(out);
}

/** タグ (フィールド番号 + ワイヤータイプ) のエンコード */
export function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

/** bytes フィールド (wireType 2) のエンコード */
export function encodeBytesField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return concatBytes(
    encodeTag(fieldNumber, WIRE_TYPE_LENGTH_DELIMITED),
    encodeVarint(value.length),
    value
  );
}

/** uint32 フィールド (wireType 0) のエンコード */
export function encodeUint32Field(fieldNumber: number, value: number): Uint8Array {
  return concatBytes(encodeTag(fieldNumber, WIRE_TYPE_VARINT), encodeVarint(value));
}

/** varint の読み取り */
function readVarint(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 1;
  let position = offset;
  while (position < bytes.length) {
    const byte = bytes[position];
    value += (byte & 0x7f) * shift;
    position += 1;
    if ((byte & 0x80) === 0) {
      return { value, offset: position };
    }
    shift *= 128;
    if (shift > 2 ** 53) {
      throw new Error('Invalid varint: too long');
    }
  }
  throw new Error('Invalid varint: truncated');
}

/**
 * メッセージのデコード
 *
 * @returns フィールド番号 → フィールド配列 のマップ
 */
export function decodeFields(bytes: Uint8Array): Map<number, ProtobufField[]> {
  const fields = new Map<number, ProtobufField[]>();
  let offset = 0;

  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;

    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;

    if (fieldNumber === 0) {
      throw new Error('Invalid protobuf: field number 0');
    }

    if (wireType === WIRE_TYPE_VARINT) {
      const parsed = readVarint(bytes, offset);
      offset = parsed.offset;
      appendField(fields, fieldNumber, { wireType, value: parsed.value });
    } else if (wireType === WIRE_TYPE_LENGTH_DELIMITED) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > bytes.length) {
        throw new Error('Invalid protobuf: truncated bytes field');
      }
      appendField(fields, fieldNumber, {
        wireType,
        value: bytes.slice(offset, end),
      });
      offset = end;
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
  }

  return fields;
}

function appendField(
  fields: Map<number, ProtobufField[]>,
  fieldNumber: number,
  field: ProtobufField
): void {
  const existing = fields.get(fieldNumber);
  if (existing) {
    existing.push(field);
  } else {
    fields.set(fieldNumber, [field]);
  }
}

/** bytes フィールドの取得 (未設定なら null) */
export function getBytesField(
  fields: Map<number, ProtobufField[]>,
  fieldNumber: number
): Uint8Array | null {
  const entries = fields.get(fieldNumber);
  if (!entries || entries.length === 0) return null;
  const last = entries[entries.length - 1];
  if (last.wireType !== WIRE_TYPE_LENGTH_DELIMITED) {
    throw new Error(`Invalid protobuf: field ${fieldNumber} is not bytes`);
  }
  return last.value as Uint8Array;
}

/** uint32 フィールドの取得 (未設定なら null) */
export function getUint32Field(
  fields: Map<number, ProtobufField[]>,
  fieldNumber: number
): number | null {
  const entries = fields.get(fieldNumber);
  if (!entries || entries.length === 0) return null;
  const last = entries[entries.length - 1];
  if (last.wireType !== WIRE_TYPE_VARINT) {
    throw new Error(`Invalid protobuf: field ${fieldNumber} is not varint`);
  }
  return last.value as number;
}
