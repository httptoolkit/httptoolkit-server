import * as crypto from 'crypto';
import _ from 'lodash';

import { getCertificateTransparencyLogs } from 'mockttp';

import { decodeCtfbLogList, encodeCtfbLogList, isCtfbLogList } from './ct-log-list-fbs';

// Both formats index these by position, so the order matters:
export const CT_LOG_STATES = [
    'unknown', 'pending', 'qualified', 'usable', 'readonly', 'retired', 'rejected'
] as const;
export const CT_LOG_TYPES = ['unknown', 'rfc6962', 'static'] as const;

export type CtLogState = typeof CT_LOG_STATES[number];
export type CtLogType = typeof CT_LOG_TYPES[number];

export interface CtLog {
    logId: string; // Base64 of the SHA-256 of the public key
    publicKey: Buffer; // SPKI DER
    operator: string;
    type: CtLogType;
    state: CtLogState;
    stateTimestamp: Date;
    description?: string; // JSON only
    url?: string; // JSON only
}

export interface CtLogList {
    versionMajor: number;
    versionMinor: number;
    timestamp: Date;
    logs: CtLog[];
}

const CT_OPERATOR_NAME_PREFIX = 'HTTP Toolkit CT Operator';

const DAY = 24 * 60 * 60 * 1000;

// Conscrypt ignores lists timestamped in the future entirely (assuming a bad device clock) and
// expires them after 70 days, so we backdate ours a little to allow for clock skew:
const defaultListTimestamp = () => new Date(Date.now() - DAY);

// Conscrypt parses JSON timestamps with SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssX"), which
// rejects the milliseconds that toISOString() includes:
const jsonTimestamp = (date: Date) => date.toISOString().replace(/\.\d+Z$/, 'Z');
const JSON_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isValidLog = (log: CtLog) =>
    // Conscrypt checks this itself, and rejects the whole list if it doesn't match:
    crypto.createHash('sha256')
        .update(log.publicKey)
        .digest()
        .equals(Buffer.from(log.logId, 'base64')) &&
    // Logs in an unknown state or of an unknown type are rejected outright by the FlatBuffer
    // parser, and ignored by the CT policy in the JSON parser, so they're no use to us either way:
    log.state !== 'unknown' &&
    log.type !== 'unknown';

const toArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function parseJsonLog(value: unknown, operator: string, type: CtLogType): CtLog | undefined {
    if (!isRecord(value)) return undefined;
    if (!isString(value.log_id) || !isString(value.key)) return undefined;
    if (!isString(value.description) || !isString(value.url)) return undefined;

    if (!isRecord(value.state)) return undefined;
    const [stateName, ...extraStates] = Object.keys(value.state);
    if (extraStates.length || !CT_LOG_STATES.includes(stateName as CtLogState)) return undefined;
    const state = value.state[stateName];
    if (!isRecord(state) || !isString(state.timestamp)) return undefined;
    if (!JSON_TIMESTAMP_PATTERN.test(state.timestamp)) return undefined;

    return {
        logId: value.log_id,
        publicKey: Buffer.from(value.key, 'base64'),
        operator,
        type,
        state: stateName as CtLogState,
        stateTimestamp: new Date(state.timestamp),
        description: value.description,
        url: value.url
    };
}

function parseJsonLogList(content: string): CtLogList | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        return undefined;
    }

    if (!isRecord(parsed) || !Array.isArray(parsed.operators)) return undefined;

    const [versionMajor, versionMinor] = isString(parsed.version)
        ? parsed.version.split('.').map((part) => parseInt(part, 10))
        : [];

    const logs = parsed.operators.flatMap((operator): CtLog[] => {
        if (!isRecord(operator) || !isString(operator.name)) return [];
        const name = operator.name;

        // Newer versions read tiled (static) logs from a separate field:
        return [
            ...toArray(operator.logs).map((log) => parseJsonLog(log, name, 'rfc6962')),
            ...toArray(operator.tiled_logs).map((log) => parseJsonLog(log, name, 'static'))
        ].filter((log): log is CtLog => !!log);
    });

    return {
        versionMajor: versionMajor || 1,
        versionMinor: versionMinor || 0,
        timestamp: isString(parsed.log_list_timestamp) &&
                JSON_TIMESTAMP_PATTERN.test(parsed.log_list_timestamp)
            ? new Date(parsed.log_list_timestamp)
            : defaultListTimestamp(),
        logs
    };
}

export function parseCtLogList(content: Buffer | undefined): CtLogList | undefined {
    if (!content?.length) return undefined;

    const logList = isCtfbLogList(content)
        ? decodeCtfbLogList(content)
        : parseJsonLogList(content.toString('utf8'));

    if (!logList) return undefined;

    return {
        ...logList,
        logs: logList.logs.filter(isValidLog)
    };
}

const getOurLogs = (caCertPem: string): CtLog[] =>
    getCertificateTransparencyLogs(caCertPem).map((log, i) => ({
        logId: log.logId.toString('base64'),
        publicKey: log.publicKey,
        operator: `${CT_OPERATOR_NAME_PREFIX} ${i + 1}`,
        type: 'rfc6962' as const,
        state: 'usable' as const,
        // Mockttp's usableSince is the CA's own notBefore, which it backdates by 24h, so this
        // always precedes the equally backdated SCTs in the certificates it issues. Conscrypt
        // requires both: it ignores SCTs from logs that weren't usable yet, and rejects the
        // entire list if a log's state starts in the future.
        stateTimestamp: log.usableSince,
        description: `HTTP Toolkit CT Log ${i + 1}`,
        // Required but never used:
        url: `https://ct.httptoolkit.test/log${i + 1}/`
    }));

export function buildCtLogList(caCertPem: string, existingList?: CtLogList): CtLogList {
    const ourLogs = getOurLogs(caCertPem);
    const ourLogIds = ourLogs.map(({ logId }) => logId);

    const existingLogs = (existingList?.logs ?? []).filter(({ logId, operator }) =>
        // Drop any logs we injected previously, e.g. for a since-regenerated CA:
        !operator.startsWith(CT_OPERATOR_NAME_PREFIX) &&
        !ourLogIds.includes(logId)
    );

    return {
        versionMajor: existingList?.versionMajor ?? 1,
        versionMinor: existingList?.versionMinor ?? 0,
        timestamp: existingList?.timestamp ?? defaultListTimestamp(),
        logs: [...existingLogs, ...ourLogs]
    };
}

function serializeJsonLogList(logList: CtLogList): Buffer {
    const operators = _.groupBy(logList.logs, ({ operator }) => operator);

    return Buffer.from(JSON.stringify({
        version: `${logList.versionMajor}.${logList.versionMinor}`,
        log_list_timestamp: jsonTimestamp(logList.timestamp),
        operators: Object.entries(operators).map(([name, logs]) => ({
            name,
            logs: logs.map((log) => ({
                description: log.description ?? `${log.operator} log`,
                key: log.publicKey.toString('base64'),
                log_id: log.logId,
                url: log.url ?? `https://ct.invalid/${log.logId}/`,
                state: { [log.state]: { timestamp: jsonTimestamp(log.stateTimestamp) } }
            }))
        }))
    }));
}

export function serializeCtLogLists(logList: CtLogList) {
    return {
        json: serializeJsonLogList(logList),
        ctfb: encodeCtfbLogList(logList)
    };
}

export function ctLogListIncludesCa(existingList: CtLogList | undefined, caCertPem: string) {
    if (!existingList) return false;

    const existingLogIds = existingList.logs.map(({ logId }) => logId);
    return getOurLogs(caCertPem).every(({ logId }) => existingLogIds.includes(logId));
}
