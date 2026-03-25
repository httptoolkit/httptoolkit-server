type BridgeClientModule = typeof import('../api/bridge-client');

import { parseArgs } from 'util';

import { Command } from '@oclif/command';

import { IS_PROD_BUILD } from '../constants';
import type { HtkOperation } from '../api/ui-operation-bridge';

function maybeBundleImport<T>(moduleName: string): T {
    if (IS_PROD_BUILD || process.env.OCLIF_TS_NODE === '0') {
        return require('../../bundle/' + moduleName);
    } else {
        return require('../' + moduleName);
    }
}

const { apiRequest } = maybeBundleImport<BridgeClientModule>('api/bridge-client');

// Custom argument parsing setup. Included here as Oclif's parsing can't handle the dynamic command
// config (commands defined by the UI itself) and the logic isn't quite complex enough for a separate dep.

function schemaToParseArgsOptions(
    inputSchema: any
): Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> {
    const options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> = {};
    const properties = inputSchema?.properties || {};

    for (const [key, prop] of Object.entries<any>(properties)) {
        if (prop.type === 'boolean') {
            options[key] = { type: 'boolean' };
        } else if (prop.type === 'array') {
            options[key] = { type: 'string', multiple: true };
        } else if (prop.type === 'object' && prop.properties) {
            for (const [nestedKey, nestedProp] of Object.entries<any>(prop.properties)) {
                options[`${key}.${nestedKey}`] = {
                    type: (nestedProp as any).type === 'boolean' ? 'boolean' : 'string'
                };
            }
        } else {
            options[key] = { type: 'string' };
        }
    }

    return options;
}

function coerceValue(value: string | boolean, schema: any): any {
    if (typeof value === 'boolean') return value;

    const type = schema?.type;
    if (type === 'number' || type === 'integer') {
        const num = Number(value);
        if (isNaN(num)) return value;
        return num;
    }
    if (type === 'boolean') {
        if (value === 'true') return true;
        if (value === 'false') return false;
        return true;
    }
    return value;
}

function coerceArg(value: string | boolean | (string | boolean)[], schema: any): any {
    if (Array.isArray(value)) {
        const itemSchema = schema?.items;
        return value.map(v => coerceValue(v, itemSchema));
    }
    return coerceValue(value, schema);
}

function validateEnum(key: string, value: any, schema: any): string | null {
    if (!schema?.enum) return null;
    const allowed: any[] = schema.enum;
    if (!allowed.includes(value)) {
        return `Invalid value '${value}' for --${key}. Allowed: ${allowed.join(', ')}`;
    }
    return null;
}

function getPositionalParams(inputSchema: any): string[] {
    return inputSchema?.required ?? [];
}

function flagsToParams(
    flagValues: Record<string, string | boolean | (string | boolean)[] | undefined>,
    extraPositional: string[],
    inputSchema: any
): Record<string, any> {
    const params: Record<string, any> = {};
    const properties = inputSchema?.properties || {};

    for (const [key, prop] of Object.entries<any>(properties)) {
        if (prop.default !== undefined) {
            params[key] = prop.default;
        }
    }

    const positionalNames = getPositionalParams(inputSchema);
    for (let i = 0; i < positionalNames.length && i < extraPositional.length; i++) {
        const name = positionalNames[i];
        const value = coerceArg(extraPositional[i], properties[name]);

        const enumErr = validateEnum(name, value, properties[name]);
        if (enumErr) {
            process.stderr.write(`Error: ${enumErr}\n`);
            process.exit(1);
        }

        params[name] = value;
    }

    for (const [key, value] of Object.entries(flagValues)) {
        if (key === 'show-help' || value === undefined) continue;

        const parts = key.split('.');
        if (parts.length === 1) {
            const coerced = coerceArg(value, properties[key]);

            const enumErr = validateEnum(key, coerced, properties[key]);
            if (enumErr) {
                process.stderr.write(`Error: ${enumErr}\n`);
                process.exit(1);
            }

            params[key] = coerced;
        } else {
            let target: any = params;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!(parts[i] in target) || typeof target[parts[i]] !== 'object') {
                    target[parts[i]] = {};
                }
                target = target[parts[i]];
            }
            const leafKey = parts[parts.length - 1];
            const nestedProp = properties[parts[0]]?.properties?.[parts.slice(1).join('.')];
            target[leafKey] = coerceArg(value, nestedProp);
        }
    }

    return params;
}

// Help docs generation (as with parsing, Oclif can't handle dynamic config).
// We override Oclif's --help in in bin/run to use this instead.

function getTerminalWidth(): number {
    return process.stdout.columns || 80;
}

function generateGeneralHelp(operations: HtkOperation[]): string {
    const termWidth = getTerminalWidth();
    const indent = 2;
    const cmdColWidth = 29; // indent + padEnd(27)
    const descWidth = termWidth - cmdColWidth;

    const lines = [
        'HTTP Toolkit Remote Control',
        '',
        'Usage: httptoolkit-ctl <command> [options]',
        '',
        `  ${'status'.padEnd(27)}Check if HTTP Toolkit is running`,
        `  ${'help'.padEnd(27)}Show this help message`,
        ''
    ];

    const byCategory = new Map<string, HtkOperation[]>();
    for (const op of operations) {
        const cat = op.category || 'other';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(op);
    }

    for (const [, ops] of byCategory) {
        for (const op of ops) {
            const cmd = op.name.replace(/\./g, ' ');
            const padded = cmd.padEnd(27);
            // Use first line only, truncated to fit in terminal
            const firstLine = op.description.split('\n')[0];
            const desc = firstLine.length > descWidth
                ? firstLine.slice(0, descWidth - 3) + '...'
                : firstLine;
            lines.push(`  ${padded}${desc}`);
        }
    }

    lines.push('');
    lines.push("Run 'httptoolkit-ctl <command> --help' for details.");
    return lines.join('\n');
}

function generateOperationHelp(op: HtkOperation): string {
    const cmd = op.name.replace(/\./g, ' ');

    const schema = op.inputSchema;
    const positionalNames = getPositionalParams(schema);
    const positionalUsage = positionalNames.map(n => `<${n}>`).join(' ');
    const usageSuffix = positionalUsage
        ? `${positionalUsage} [options]`
        : '[options]';

    const lines = [
        op.description,
        '',
        `Usage: httptoolkit-ctl ${cmd} ${usageSuffix}`
    ];

    if (schema?.properties && Object.keys(schema.properties).length > 0) {
        const positionalSet = new Set(positionalNames);
        const hasFlags = Object.keys(schema.properties).some(k => !positionalSet.has(k));

        if (positionalNames.length > 0) {
            lines.push('');
            lines.push('Arguments:');
            for (const name of positionalNames) {
                const prop = schema.properties[name];
                const desc = prop?.description || '';
                const enumStr = prop?.enum ? ` [${prop.enum.join('|')}]` : '';
                const defaultStr = prop?.default !== undefined ? ` (default: ${JSON.stringify(prop.default)})` : '';
                lines.push(`  ${(`<${name}>`).padEnd(35)}${indentMultilineDesc(desc + enumStr + defaultStr, 37)}`);
            }
        }

        if (hasFlags) {
            lines.push('');
            lines.push('Options:');
            formatHelpParams(schema, lines);
        }
    }

    return lines.join('\n');
}

function indentMultilineDesc(desc: string, indent: number): string {
    const descLines = desc.split('\n');
    if (descLines.length <= 1) return desc;
    const pad = ' '.repeat(indent);
    return descLines[0] + '\n' + descLines.slice(1).map(l => pad + l).join('\n');
}

function formatHelpParams(schema: any, lines: string[], prefix = ''): void {
    if (!schema?.properties) return;
    const positionalSet = new Set<string>(schema.required ?? []);

    for (const [key, prop] of Object.entries<any>(schema.properties)) {
        if (!prefix && positionalSet.has(key)) continue;

        const fullKey = prefix ? `${prefix}.${key}` : key;

        let flag: string;
        if (prop.type === 'boolean') {
            flag = `--[no-]${fullKey}`;
        } else if (prop.enum) {
            flag = `--${fullKey} <${prop.enum.join('|')}>`;
        } else if (prop.type === 'array') {
            const itemType = prop.items?.type || 'value';
            flag = `--${fullKey} <${itemType}>...`;
        } else {
            const typeStr = prop.type ? ` <${prop.type}>` : '';
            flag = `--${fullKey}${typeStr}`;
        }

        const padded = flag.padEnd(35);
        const desc = prop.description || '';
        const defaultStr = prop.default !== undefined ? ` (default: ${JSON.stringify(prop.default)})` : '';
        // 2 leading spaces + 35 padded flag = 37 char indent for continuation lines
        lines.push(`  ${padded}${indentMultilineDesc(desc + defaultStr, 37)}`);

        if (prop.type === 'object' && prop.properties) {
            formatHelpParams(prop, lines, fullKey);
        }
    }
}

// --- Command dispatch ---

async function runCtl(args: string[]): Promise<void> {
    const { positionals } = parseArgs({ args, strict: false, allowPositionals: true });

    if (positionals.length === 0 || positionals[0] === 'help') {
        try {
            const operations: HtkOperation[] = await apiRequest('GET', '/api/operations');
            process.stdout.write(generateGeneralHelp(operations) + '\n');
        } catch {
            process.stdout.write(generateGeneralHelp([]) + '\n');
        }
        return;
    }

    if (positionals[0] === 'status') {
        try {
            const status = await apiRequest('GET', '/api/status');
            process.stdout.write(JSON.stringify({ running: true, ...status }) + '\n');
        } catch {
            process.stdout.write(JSON.stringify({ running: false }) + '\n');
        }
        return;
    }

    let operations: HtkOperation[];
    try {
        operations = await apiRequest('GET', '/api/operations');
    } catch (err: any) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(1);
        return;
    }

    // Match operation: try joining positionals with '.' from longest to shortest
    let matchedOp: HtkOperation | undefined;
    let commandWords = 0;

    for (let n = positionals.length; n >= 1; n--) {
        const candidateName = positionals.slice(0, n).join('.');
        matchedOp = operations.find(op => op.name === candidateName);
        if (matchedOp) {
            commandWords = n;
            break;
        }
    }

    if (!matchedOp) {
        const cmd = positionals.join(' ');
        process.stderr.write(`Error: Unknown command '${cmd}'. Run 'httptoolkit-ctl help'.\n`);
        process.exit(1);
        return;
    }

    // Re-parse with schema knowledge for accurate boolean/array handling
    const options = schemaToParseArgsOptions(matchedOp.inputSchema);
    options['show-help'] = { type: 'boolean' };
    const reparsed = parseArgs({ args, options, strict: false, allowPositionals: true, allowNegative: true });

    if (reparsed.values['show-help']) {
        process.stdout.write(generateOperationHelp(matchedOp) + '\n');
        return;
    }

    const extraPositional = reparsed.positionals.slice(commandWords);
    const params = flagsToParams(reparsed.values, extraPositional, matchedOp.inputSchema);

    try {
        const result = await apiRequest('POST', '/api/execute', {
            name: matchedOp.name,
            args: params
        });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch (err: any) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(1);
    }
}

class CtlCommand extends Command {
    static description = 'remote control a running HTTP Toolkit instance'

    static strict = false

    async run() {
        await runCtl(this.argv);
    }
}

export = CtlCommand;
