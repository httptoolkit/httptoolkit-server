import * as crypto from 'crypto';
import * as path from 'path';
import { expect } from 'chai';
import { generateCACertificate, getCertificateTransparencyLogs } from 'mockttp';
import { getCA } from 'mockttp/dist/util/certificates';

import { readFile } from '../../src/util/fs';
import {
    buildCtLogList,
    CtLog,
    CtLogList,
    ctLogListIncludesCa,
    parseCtLogList,
    serializeCtLogLists
} from '../../src/interceptors/android/ct-log-list';
import {
    decodeCtfbLogList,
    encodeCtfbLogList,
    isCtfbLogList
} from '../../src/interceptors/android/ct-log-list-fbs';

// A real log list, as installed on an Android 17 emulator:
const DEVICE_LOG_LIST = path.join(__dirname, '..', 'fixtures', 'android-ct-log-list.ctfb');

// Matches Conscrypt's SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssX") - notably no milliseconds:
const JSON_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

interface JsonLogList {
    version: string;
    log_list_timestamp: string;
    operators: Array<{
        name: string,
        logs: Array<{
            description: string,
            key: string,
            log_id: string,
            url: string,
            state: { [state: string]: { timestamp: string } }
        }>
    }>;
}

const generateCA = () => generateCACertificate({
    subject: { commonName: 'HTTP Toolkit CA' }
});

// A leaf certificate, issued exactly as the intercepting proxy issues them:
const generateLeafCertificate = async (caCert: string, caKey: string) => {
    const ca = await getCA({ cert: caCert, key: caKey, certificateTransparency: true });
    return ca.generateCertificate('localhost');
};

// Each SCT's 8-byte timestamp immediately follows its 32-byte log id, so we can read them
// straight out of the certificate's DER:
const getEmbeddedSctTimestamps = async (caCert: string, caKey: string) => {
    const { cert } = await generateLeafCertificate(caCert, caKey);
    const der = new crypto.X509Certificate(cert).raw;

    return getCertificateTransparencyLogs(caCert).map(({ logId }) => {
        const index = der.indexOf(logId);
        expect(index, 'no SCT for this log in the certificate').to.be.greaterThan(-1);
        return Number(der.readBigUInt64BE(index + logId.length));
    });
};

const getLogIds = (caCert: string) =>
    getCertificateTransparencyLogs(caCert).map((log) => log.logId.toString('base64'));

const parseJson = (content: Buffer) => JSON.parse(content.toString('utf8')) as JsonLogList;
const getJsonLogs = (list: JsonLogList) => list.operators.flatMap(({ logs }) => logs);

const anExistingLog = (description: string): CtLog => {
    const publicKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .publicKey
        .export({ format: 'der', type: 'spki' });

    return {
        logId: crypto.createHash('sha256').update(publicKey).digest('base64'),
        publicKey,
        operator: 'Real operator',
        type: 'rfc6962',
        state: 'usable',
        stateTimestamp: new Date('2020-01-01T00:00:00Z'),
        description,
        url: `https://ct.example.com/${description}/`
    };
};

const anExistingList = (logs: CtLog[]): CtLogList => ({
    versionMajor: 89,
    versionMinor: 1,
    timestamp: new Date('2026-07-28T13:39:07Z'),
    logs
});

describe("The Android CT log list", () => {

    let caCert: string;
    let caKey: string;

    before(async () => {
        ({ cert: caCert, key: caKey } = await generateCA());
    });

    it("should include the CA's logs, from two distinct operators", () => {
        const logList = buildCtLogList(caCert);
        const expectedLogs = getCertificateTransparencyLogs(caCert);

        expect(logList.logs.length).to.equal(2);
        expect(new Set(logList.logs.map(({ operator }) => operator)).size).to.equal(2);
        expect(logList.logs.map(({ logId }) => logId)).to.deep.equal(
            expectedLogs.map((log) => log.logId.toString('base64'))
        );
        expect(logList.logs.every(({ state }) => state === 'usable')).to.equal(true);
    });

    it("should use timestamps that are always in the past", () => {
        const logList = buildCtLogList(caCert);

        expect(logList.timestamp.valueOf()).to.be.lessThan(Date.now());
        logList.logs.forEach((log) => {
            expect(log.stateTimestamp.valueOf()).to.be.lessThan(Date.now());
        });
    });

    describe("against the certificates Mockttp issues", () => {
        // Conscrypt rejects a list outright if any log it reads became usable in the future,
        // and ignores SCTs from logs that weren't usable at verification time, so our state
        // timestamps have to sit at least 24 hours back regardless of the CA we're given.
        it("should backdate log states past the SCTs in a generated certificate", async () => {
            const logList = buildCtLogList(caCert);
            const sctTimestamps = await getEmbeddedSctTimestamps(caCert, caKey);

            expect(sctTimestamps.length).to.equal(2);
            sctTimestamps.forEach((sctTimestamp) => {
                logList.logs.forEach((log) => {
                    expect(log.stateTimestamp.valueOf(), `${log.operator} vs SCT`)
                        .to.be.at.most(sctTimestamp);
                });
            });
        });

        it("should be enough for certificates of the lifetime Mockttp issues", async () => {
            // Conscrypt requires SCTs from 3 distinct logs for certificates valid for over
            // 180 days, but only 2 at or below that. We only have 2 logs to offer, so this
            // only works while Mockttp stays inside that regime.
            const { cert } = await generateLeafCertificate(caCert, caKey);
            const leaf = new crypto.X509Certificate(cert);
            const lifetimeDays = (
                new Date(leaf.validTo).valueOf() - new Date(leaf.validFrom).valueOf()
            ) / (24 * 60 * 60 * 1000);

            expect(lifetimeDays).to.be.at.most(180);
            expect(buildCtLogList(caCert).logs.length).to.equal(2);
        });
    });

    it("should preserve the existing logs on the device", () => {
        const logList = buildCtLogList(caCert, anExistingList([anExistingLog('real-log')]));

        expect(logList.versionMajor).to.equal(89);
        expect(logList.versionMinor).to.equal(1);
        expect(logList.timestamp.toISOString()).to.equal('2026-07-28T13:39:07.000Z');
        expect(logList.logs.map(({ description }) => description)).to.deep.equal([
            'real-log',
            'HTTP Toolkit CT Log 1',
            'HTTP Toolkit CT Log 2'
        ]);
    });

    it("should replace previously injected logs, rather than duplicating them", async () => {
        const previousCa = (await generateCA()).cert;
        const previousList = buildCtLogList(
            previousCa,
            anExistingList([anExistingLog('real-log')])
        );

        const logList = buildCtLogList(caCert, previousList);

        expect(logList.logs.map(({ operator }) => operator)).to.deep.equal([
            'Real operator',
            'HTTP Toolkit CT Operator 1',
            'HTTP Toolkit CT Operator 2'
        ]);

        const logIds = logList.logs.map(({ logId }) => logId);
        expect(logIds).to.include.members(getLogIds(caCert));
        expect(logIds).to.not.include.members(getLogIds(previousCa));
    });

    describe("in v3 (FlatBuffers) format", () => {
        it("should round-trip the logs it's given", () => {
            const logList = buildCtLogList(caCert, anExistingList([anExistingLog('real-log')]));
            const encoded = encodeCtfbLogList(logList);

            expect(isCtfbLogList(encoded)).to.equal(true);
            expect(encoded.subarray(4, 8).toString()).to.equal('CTFB');

            const decoded = decodeCtfbLogList(encoded)!;
            expect(decoded.versionMajor).to.equal(logList.versionMajor);
            expect(decoded.versionMinor).to.equal(logList.versionMinor);
            expect(decoded.timestamp.valueOf()).to.equal(logList.timestamp.valueOf());
            expect(decoded.logs.length).to.equal(logList.logs.length);

            logList.logs.forEach((log) => {
                const decodedLog = decoded.logs.find(({ logId }) => logId === log.logId)!;
                expect(decodedLog, `missing log ${log.logId}`).to.not.equal(undefined);
                expect(decodedLog.publicKey.equals(log.publicKey)).to.equal(true);
                expect(decodedLog.operator).to.equal(log.operator);
                expect(decodedLog.type).to.equal(log.type);
                expect(decodedLog.state).to.equal(log.state);
                expect(decodedLog.stateTimestamp.valueOf()).to.equal(log.stateTimestamp.valueOf());
            });
        });

        it("should sort the logs by id, as Conscrypt's lookup requires", () => {
            const logs = Array.from({ length: 20 }, (_, i) => anExistingLog(`log-${i}`));
            const encoded = encodeCtfbLogList(buildCtLogList(caCert, anExistingList(logs)));

            const logIds = decodeCtfbLogList(encoded)!.logs.map(({ logId }) => logId);
            expect(logIds).to.deep.equal([...logIds].sort());
            expect(logIds.length).to.equal(22);
        });

        it("should parse a real device log list", async () => {
            const logList = parseCtLogList(await readFile(DEVICE_LOG_LIST))!;

            expect(logList.versionMajor).to.equal(89);
            expect(logList.versionMinor).to.equal(1);
            expect(logList.timestamp.toISOString()).to.equal('2026-07-28T13:39:07.000Z');
            expect(logList.logs.length).to.equal(62);
            expect(new Set(logList.logs.map(({ operator }) => operator)).size).to.equal(8);

            logList.logs.forEach((log) => {
                const logId = crypto.createHash('sha256').update(log.publicKey).digest('base64');
                expect(log.logId).to.equal(logId);
            });
        });

        it("should merge into a real device log list", async () => {
            const existingList = parseCtLogList(await readFile(DEVICE_LOG_LIST))!;
            const logList = buildCtLogList(caCert, existingList);

            const encoded = serializeCtLogLists(logList).ctfb;
            const decoded = decodeCtfbLogList(encoded)!;

            expect(decoded.logs.length).to.equal(64);
            expect(decoded.logs.map(({ logId }) => logId)).to.include.members(getLogIds(caCert));
            expect(decoded.timestamp.valueOf()).to.equal(existingList.timestamp.valueOf());

            const logIds = decoded.logs.map(({ logId }) => logId);
            expect(logIds).to.deep.equal([...logIds].sort());
        });
    });

    describe("in v1/v2 (JSON) format", () => {
        it("should group logs by operator, in Conscrypt's format", () => {
            const logList = buildCtLogList(caCert, anExistingList([anExistingLog('real-log')]));
            const json = parseJson(serializeCtLogLists(logList).json);
            expect(json.version).to.equal('89.1');
            expect(json.log_list_timestamp).to.match(JSON_TIMESTAMP);
            expect(json.operators.map(({ name }) => name)).to.deep.equal([
                'Real operator',
                'HTTP Toolkit CT Operator 1',
                'HTTP Toolkit CT Operator 2'
            ]);

            getJsonLogs(json).forEach((log) => {
                expect(log.description).to.be.a('string');
                expect(log.url).to.be.a('string');
                expect(Object.keys(log.state).length).to.equal(1);
                expect(log.state.usable.timestamp).to.match(JSON_TIMESTAMP);

                const logId = crypto.createHash('sha256')
                    .update(Buffer.from(log.key, 'base64'))
                    .digest('base64');
                expect(log.log_id).to.equal(logId);
            });
        });

        it("should round-trip through parsing", () => {
            const logList = buildCtLogList(caCert, anExistingList([anExistingLog('real-log')]));
            const json = serializeCtLogLists(logList).json;

            const parsed = parseCtLogList(json)!;
            expect(parsed.versionMajor).to.equal(89);
            expect(parsed.versionMinor).to.equal(1);
            expect(parsed.logs.map(({ logId }) => logId))
                .to.deep.equal(logList.logs.map(({ logId }) => logId));
            expect(parsed.logs.map(({ operator }) => operator))
                .to.deep.equal(logList.logs.map(({ operator }) => operator));
        });

        it("should drop entries that Conscrypt would reject", () => {
            const mismatchedLogId = anExistingLog('mismatched-log-id');
            mismatchedLogId.logId = crypto.createHash('sha256').update('nope').digest('base64');

            const validLog = anExistingLog('valid-log');
            const json = serializeCtLogLists(anExistingList([mismatchedLogId, validLog])).json;

            const parsed = parseCtLogList(json)!;
            expect(parsed.logs.map(({ description }) => description)).to.deep.equal(['valid-log']);
        });

        it("should ignore content that isn't a valid list", () => {
            expect(parseCtLogList(undefined)).to.equal(undefined);
            expect(parseCtLogList(Buffer.from(''))).to.equal(undefined);
            expect(parseCtLogList(Buffer.from('base64: /x: No such file or directory')))
                .to.equal(undefined);
            expect(parseCtLogList(Buffer.from('{ "operators": "not-an-array" }')))
                .to.equal(undefined);
        });
    });

    describe("installation check", () => {
        it("should detect a list that includes the CA's logs", () => {
            expect(ctLogListIncludesCa(buildCtLogList(caCert), caCert)).to.equal(true);
        });

        it("should detect a list that doesn't include the CA's logs", async () => {
            const otherCa = (await generateCA()).cert;
            expect(ctLogListIncludesCa(buildCtLogList(otherCa), caCert)).to.equal(false);
        });

        it("should treat a missing list as not installed", () => {
            expect(ctLogListIncludesCa(undefined, caCert)).to.equal(false);
        });
    });
});
