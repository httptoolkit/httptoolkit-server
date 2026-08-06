import * as flatbuffers from 'flatbuffers';

import { CT_LOG_STATES, CT_LOG_TYPES, CtLog, CtLogList, CtLogState, CtLogType } from './ct-log-list';

// Android 17's Conscrypt reads its CT log list as a FlatBuffer, rather than the JSON used by
// earlier versions. There's no public schema for this, but it's equivalent to:
//
//     file_identifier "CTFB";
//     table Log {
//         log_id: string (key); // Base64 of the SHA-256 of public_key
//         public_key: [ubyte];  // SPKI DER
//         operator: string;
//         type: byte;           // CT_LOG_TYPES index
//         state: byte;          // CT_LOG_STATES index
//         state_timestamp: long;
//     }
//     table LogList {
//         version_major: long;
//         version_minor: long;
//         timestamp: long;
//         logs: [Log];
//     }
//     root_type LogList;
//
// Conscrypt looks logs up by log id with a binary search, so the logs vector must be sorted
// by log id, and it rejects the entire list if any log it looks at has an unknown state or
// type, or an id that doesn't match its public key.

const CTFB_IDENTIFIER = 'CTFB';

// Field positions within each table's vtable:
const enum LogField {
    LogId = 0,
    PublicKey = 1,
    Operator = 2,
    Type = 3,
    State = 4,
    StateTimestamp = 5
}

const enum LogListField {
    VersionMajor = 0,
    VersionMinor = 1,
    Timestamp = 2,
    Logs = 3
}

export const isCtfbLogList = (content: Buffer) =>
    new flatbuffers.ByteBuffer(content).__has_identifier(CTFB_IDENTIFIER);

export function encodeCtfbLogList(logList: CtLogList): Buffer {
    const builder = new flatbuffers.Builder(16 * 1024);

    // Conscrypt binary searches this vector by log id, so it has to be sorted:
    const logs = [...logList.logs].sort((a, b) => a.logId < b.logId ? -1 : a.logId > b.logId ? 1 : 0);

    // Strings & vectors must all be built before the tables that reference them:
    const logOffsets = logs.map((log) => {
        const logIdOffset = builder.createString(log.logId);
        const publicKeyOffset = builder.createByteVector(log.publicKey);
        const operatorOffset = builder.createString(log.operator);

        builder.startObject(6);
        builder.addFieldOffset(LogField.LogId, logIdOffset, 0);
        builder.addFieldOffset(LogField.PublicKey, publicKeyOffset, 0);
        builder.addFieldOffset(LogField.Operator, operatorOffset, 0);
        builder.addFieldInt8(LogField.Type, CT_LOG_TYPES.indexOf(log.type), 0);
        builder.addFieldInt8(LogField.State, CT_LOG_STATES.indexOf(log.state), 0);
        builder.addFieldInt64(
            LogField.StateTimestamp,
            BigInt(log.stateTimestamp.valueOf()),
            BigInt(0)
        );
        return builder.endObject();
    });

    builder.startVector(4, logOffsets.length, 4);
    for (let i = logOffsets.length - 1; i >= 0; i--) {
        builder.addOffset(logOffsets[i]);
    }
    const logsOffset = builder.endVector();

    builder.startObject(4);
    builder.addFieldInt64(LogListField.VersionMajor, BigInt(logList.versionMajor), BigInt(0));
    builder.addFieldInt64(LogListField.VersionMinor, BigInt(logList.versionMinor), BigInt(0));
    builder.addFieldInt64(LogListField.Timestamp, BigInt(logList.timestamp.valueOf()), BigInt(0));
    builder.addFieldOffset(LogListField.Logs, logsOffset, 0);
    builder.finish(builder.endObject(), CTFB_IDENTIFIER);

    return Buffer.from(builder.asUint8Array());
}

export function decodeCtfbLogList(content: Buffer): CtLogList | undefined {
    if (!isCtfbLogList(content)) return undefined;

    try {
        const buffer = new flatbuffers.ByteBuffer(content);
        const list = buffer.__indirect(buffer.position());

        const { start, length } = readVector(buffer, list, LogListField.Logs);

        const logs: CtLog[] = [];
        for (let i = 0; i < length; i++) {
            const log = decodeLog(buffer, buffer.__indirect(start + i * 4));
            if (log) logs.push(log);
        }

        return {
            versionMajor: Number(readLong(buffer, list, LogListField.VersionMajor)),
            versionMinor: Number(readLong(buffer, list, LogListField.VersionMinor)),
            timestamp: new Date(Number(readLong(buffer, list, LogListField.Timestamp))),
            logs
        };
    } catch (e) {
        return undefined;
    }
}

function decodeLog(buffer: flatbuffers.ByteBuffer, log: number): CtLog | undefined {
    const logId = readString(buffer, log, LogField.LogId);
    const publicKey = readBytes(buffer, log, LogField.PublicKey);
    const operator = readString(buffer, log, LogField.Operator);
    if (!logId || !publicKey || !operator) return undefined;

    const type = CT_LOG_TYPES[readByte(buffer, log, LogField.Type)] as CtLogType | undefined;
    const state = CT_LOG_STATES[readByte(buffer, log, LogField.State)] as CtLogState | undefined;
    if (!type || !state) return undefined;

    return {
        logId,
        publicKey,
        operator,
        type,
        state,
        stateTimestamp: new Date(Number(readLong(buffer, log, LogField.StateTimestamp)))
    };
}

const tableOffset = (field: number) => 4 + field * 2;

const fieldPosition = (buffer: flatbuffers.ByteBuffer, table: number, field: number) => {
    const offset = buffer.__offset(table, tableOffset(field));
    return offset ? table + offset : 0;
};

const readLong = (buffer: flatbuffers.ByteBuffer, table: number, field: number) => {
    const position = fieldPosition(buffer, table, field);
    return position ? buffer.readInt64(position) : BigInt(0);
};

const readByte = (buffer: flatbuffers.ByteBuffer, table: number, field: number) => {
    const position = fieldPosition(buffer, table, field);
    return position ? buffer.readInt8(position) : 0;
};

const readString = (buffer: flatbuffers.ByteBuffer, table: number, field: number) => {
    const position = fieldPosition(buffer, table, field);
    if (!position) return undefined;
    const value = buffer.__string(position);
    return typeof value === 'string' ? value : undefined;
};

const readVector = (buffer: flatbuffers.ByteBuffer, table: number, field: number) => {
    const position = fieldPosition(buffer, table, field);
    return position
        ? { start: buffer.__vector(position), length: buffer.__vector_len(position) }
        : { start: 0, length: 0 };
};

const readBytes = (buffer: flatbuffers.ByteBuffer, table: number, field: number) => {
    if (!fieldPosition(buffer, table, field)) return undefined;
    const { start, length } = readVector(buffer, table, field);
    return Buffer.from(buffer.bytes().subarray(start, start + length));
};
