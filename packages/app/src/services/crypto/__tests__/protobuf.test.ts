/**
 * protobuf.ts (最小限の protobuf codec) のユニットテスト
 *
 * wire.proto (rust/protocol/src/proto/wire.proto) に準拠した
 * varint / length-delimited / uint32 のエンコードとデコード。
 */

import { bytesToHex, hexToBytes } from '../bytes';
import {
  WIRE_TYPE_LENGTH_DELIMITED,
  WIRE_TYPE_VARINT,
  decodeFields,
  encodeBytesField,
  encodeUint32Field,
  encodeVarint,
  getBytesField,
  getUint32Field,
} from '../protobuf';

describe('protobuf codec', () => {
  it('varint をエンコードできる', () => {
    expect(bytesToHex(encodeVarint(0))).toBe('00');
    expect(bytesToHex(encodeVarint(1))).toBe('01');
    expect(bytesToHex(encodeVarint(127))).toBe('7f');
    expect(bytesToHex(encodeVarint(128))).toBe('8001');
    expect(bytesToHex(encodeVarint(300))).toBe('ac02');
  });

  it('bytes フィールドをエンコード/デコードできる', () => {
    const payload = hexToBytes('deadbeef');
    const encoded = encodeBytesField(1, payload);
    // tag(1, LEN) = 0x0a
    expect(encoded[0]).toBe(0x0a);
    expect(encoded[1]).toBe(4);

    const fields = decodeFields(encoded);
    expect(fields.get(1)?.[0]?.wireType).toBe(WIRE_TYPE_LENGTH_DELIMITED);
    expect(bytesToHex(getBytesField(fields, 1)!)).toBe('deadbeef');
  });

  it('uint32 フィールドをエンコード/デコードできる', () => {
    const encoded = encodeUint32Field(2, 300);
    // tag(2, VARINT) = 0x10
    expect(encoded[0]).toBe(0x10);

    const fields = decodeFields(encoded);
    expect(fields.get(2)?.[0]?.wireType).toBe(WIRE_TYPE_VARINT);
    expect(getUint32Field(fields, 2)).toBe(300);
  });

  it('存在しないフィールドは null を返す', () => {
    const fields = decodeFields(new Uint8Array(0));
    expect(getBytesField(fields, 1)).toBeNull();
    expect(getUint32Field(fields, 1)).toBeNull();
  });

  it('複数のフィールドをまとめてデコードできる', () => {
    const encoded = new Uint8Array([
      ...encodeUint32Field(1, 1),
      ...encodeBytesField(2, hexToBytes('aa')),
      ...encodeUint32Field(3, 2),
    ]);
    const fields = decodeFields(encoded);
    expect(getUint32Field(fields, 1)).toBe(1);
    expect(bytesToHex(getBytesField(fields, 2)!)).toBe('aa');
    expect(getUint32Field(fields, 3)).toBe(2);
  });
});
