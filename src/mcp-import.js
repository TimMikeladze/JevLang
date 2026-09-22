// An MCP server's tools as a policy's action declarations.
//
//   const snapshot = await mcpImportSnapshot(client);
//   await writeMcpImport(snapshot, 'tools.json');   // tools.json + tools.actions.js
//
// The JSON file is the tools/list snapshot, verbatim, with the server's info,
// the protocol version, the source and the time. Beside it goes a module of
// portable action declarations, so a policy spreads them into its actions and
// the validator becomes the check: an act against a tool that no longer exists,
// or with a parameter it does not take, fails validation. snapshotDrift reports
// what changed against a live server.
//
// The mapping is the inverse of json-schema.js:
//   string with an enum of plain words  one-of
//   string                              string
//   boolean                             boolean
//   number, integer                     number, with a range only when both
//                                       minimum and maximum are given
//   array with an item schema           list-of
//   x-jev-member-of                     member-of
//   anything else                       json
//   not in "required"                   optional
// A tool is confirmed unless readOnlyHint is true or destructiveHint is false.
// Those are MCP's own defaults: a tool with no annotations may be destructive.
// A tool a Jev policy serves carries its safety rules in _meta, and those come
// back as minConfidence, cooldown, allow, timeout and undo.
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { canonical, object, own, finite, requireAt } from './common.js';
import { mcpListTools } from './mcp-client.js';

const identifier = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const toolName = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const reservedActions = ['hold', 'confirm', 'computed', 'plan'];
// A decision's own metadata keys, so a parameter cannot take their names.
const reservedParams = ['reason', 'show'];

export const mcpImportSnapshot = async (client, { source = client.source } = {}) => ({
  source,
  serverInfo: client.serverInfo ?? null,
  protocolVersion: client.version ?? null,
  era: client.era,
  captured_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  tools: await mcpListTools(client),
});
export async function readMcpSnapshot(path) {
  const snapshot = JSON.parse(await readFile(path, 'utf8'));
  requireAt(object(snapshot) && Array.isArray(snapshot.tools), path,
    'not a tools snapshot', 'Expected a JSON object with a "tools" list, as the import writes.');
  return snapshot;
}

// MCP's own defaults: a tool with no annotations may be destructive.
export const toolConfirm = tool => {
  const a = object(tool.annotations) ? tool.annotations : {};
  return !(a.readOnlyHint === true || a.destructiveHint === false);
};
const plainWordEnum = values => Array.isArray(values) && values.length > 0
  && values.every(v => typeof v === 'string' && identifier.test(v))
  && new Set(values).size === values.length;

export function jsonSchemaToParameter(property, required) {
  const p = object(property) ? property : {};
  const optional = required ? {} : { optional: true };
  const memberField = p['x-jev-member-of'];
  if (typeof memberField === 'string' && identifier.test(memberField)) return { type: 'member-of', field: memberField, ...optional };
  if (p.type === 'string' && plainWordEnum(p.enum)) return { type: 'one-of', values: p.enum, ...optional };
  if (p.type === 'string') return { type: 'string', ...optional };
  if (p.type === 'boolean') return { type: 'boolean', ...optional };
  if (p.type === 'number' || p.type === 'integer') {
    return finite(p.minimum) && finite(p.maximum) && p.minimum < p.maximum
      ? { type: 'number', min: p.minimum, max: p.maximum, ...optional }
      : { type: 'number', ...optional };
  }
  if (p.type === 'array' && object(p.items)) {
    // An element type takes no range, so a bounded number inside is just a number.
    const { optional: _drop, min, max, ...inner } = jsonSchemaToParameter(p.items, true);
    return { type: 'list-of', of: inner, ...optional };
  }
  return { type: 'json', ...optional };
}
// The 2.2 _meta form {"name": ..., "args": {k: ["param", x] | ["value", v]}}
const undoFrom = u => {
  if (!object(u) || typeof u.name !== 'string' || !toolName.test(u.name) || !object(u.args)) return null;
  const params = {};
  for (const key of Object.keys(u.args).sort()) {
    const v = u.args[key];
    if (Array.isArray(v) && v.length === 2 && v[0] === 'param' && typeof v[1] === 'string' && identifier.test(v[1])) {
      params[key] = { op: 'variable', args: [v[1]] };
    } else if (Array.isArray(v) && v.length === 2 && v[0] === 'value' && ['string', 'number', 'boolean'].includes(typeof v[1])) {
      params[key] = { op: 'literal', args: [v[1]] };
    } else return null;
  }
  return { action: 'act', target: u.name, params };
};

// -> { name, action } for a tool a policy can declare, else { warning }.
export function toolToAction(tool) {
  const name = object(tool) ? tool.name : null;
  const schema = object(tool?.inputSchema) ? tool.inputSchema : {};
  const properties = object(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter(r => typeof r === 'string') : [];
  const names = Object.keys(properties);
  const bad = names.filter(n => !identifier.test(n)).sort();
  const clash = names.filter(n => reservedParams.includes(n)).sort();
  if (typeof name !== 'string' || !toolName.test(name)) {
    return { warning: `skipped tool ${JSON.stringify(name)}: its name is not one a policy can declare ([A-Za-z_][A-Za-z0-9_.-]*)` };
  }
  if (reservedActions.includes(name)) return { warning: `skipped tool ${name}: '${name}' is reserved in a policy` };
  if (bad.length) {
    return { warning: `skipped tool ${name}: parameter name${bad.length === 1 ? '' : 's'} ${bad.map(b => JSON.stringify(b)).join(', ')} ${bad.length === 1 ? 'is' : 'are'} not an identifier ([A-Za-z_][A-Za-z0-9_-]*)` };
  }
  if (clash.length) return { warning: `skipped tool ${name}: a parameter named '${clash[0]}' collides with a decision's own ${clash[0]}` };
  // Required parameters first, in the schema's order, then the rest by name.
  const ordered = [...required.filter(r => names.includes(r)), ...names.filter(n => !required.includes(n)).sort()];
  const meta = object(tool._meta) ? tool._meta : {};
  const minConfidence = meta['jev/min_confidence'];
  const cooldown = meta['jev/cooldown_seconds'];
  const allow = meta['jev/allow'];
  const timeout = meta['jev/timeout_seconds'];
  const undo = undoFrom(meta['jev/undo']);
  const doc = typeof tool.description === 'string' && tool.description.length > 0 ? tool.description : null;
  return {
    name,
    action: {
      ...(doc ? { doc } : {}),
      params: Object.fromEntries(ordered.map(n => [n, jsonSchemaToParameter(properties[n], required.includes(n))])),
      ...(toolConfirm(tool) ? { confirm: true } : {}),
      ...(finite(minConfidence) && minConfidence > 0 && minConfidence < 1 ? { minConfidence } : {}),
      ...(finite(cooldown) && cooldown > 0 ? { cooldown } : {}),
      ...(Array.isArray(allow) && allow.length && allow.every(r => typeof r === 'string' && identifier.test(r)) ? { allow } : {}),
      ...(finite(timeout) && timeout > 0 ? { timeout } : {}),
      ...(undo ? { undo } : {}),
    },
  };
}
// -> { actions, warnings }
export function snapshotToActions(snapshot) {
  const actions = {}, warnings = [];
  for (const tool of snapshot.tools) {
    const imported = toolToAction(tool);
    if (imported.warning) warnings.push(imported.warning);
    else actions[imported.name] = imported.action;
  }
  return { actions, warnings };
}

const oneLine = s => String(s).replace(/[\r\n]+/g, ' ');
// The module a policy imports its actions from.
export function formatActionsModule(snapshot, { actions, warnings }, snapshotName) {
  const info = object(snapshot.serverInfo) ? snapshot.serverInfo : null;
  return [
    `// Generated from ${oneLine(snapshot.source ?? '?')}`,
    `// ${info ? oneLine(`${info.name ?? '?'} ${info.version ?? ''}`.trim()) : 'an unnamed server'}, MCP ${snapshot.protocolVersion ?? '?'}, captured ${snapshot.captured_at ?? '?'}`,
    `// Do not edit it: re-import. Drift against the live server is reported from ${snapshotName}.`,
    '// A policy spreads these into its actions, so validation checks every act.',
    ...warnings.map(w => `// ${oneLine(w)}`),
    '',
    `export const actions = ${JSON.stringify(actions, null, 2)};`,
    '',
  ].join('\n');
}
// Writes <jsonPath> and, beside it, <name>.actions.js.
// -> { modulePath, actions, warnings }
export async function writeMcpImport(snapshot, jsonPath) {
  const imported = snapshotToActions(snapshot);
  const name = basename(jsonPath).replace(/\.json$/, '');
  const modulePath = join(dirname(jsonPath), `${name}.actions.js`);
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(modulePath, formatActionsModule(snapshot, imported, basename(jsonPath)));
  return { modulePath, ...imported };
}

// old, new : tools/list entries. Drift is a tool missing or new, or a changed
// inputSchema or annotations, compared as canonical JSON. A changed description
// is only a note.
export function snapshotDrift(oldTools, newTools) {
  const byName = tools => new Map(tools.filter(t => object(t) && typeof t.name === 'string').map(t => [t.name, t]));
  const o = byName(oldTools), n = byName(newTools);
  const canon = (t, key) => canonical(own(t, key) ? t[key] : null);
  const item = (kind, tool, detail) => ({ kind, tool, detail });
  const drift = [
    ...[...o.keys()].sort().filter(name => !n.has(name)).map(name => item('missing', name, 'the server no longer lists it')),
    ...[...n.keys()].sort().filter(name => !o.has(name)).map(name => item('new', name, "the server lists it, and the snapshot doesn't")),
    ...[...o.keys()].sort().filter(name => n.has(name)).flatMap(name => {
      const a = o.get(name), b = n.get(name);
      return [
        ...(canon(a, 'inputSchema') === canon(b, 'inputSchema') ? []
          : [item('schema', name, `inputSchema was ${canon(a, 'inputSchema')}\n      now ${canon(b, 'inputSchema')}`)]),
        ...(canon(a, 'annotations') === canon(b, 'annotations') ? []
          : [item('annotations', name, `annotations were ${canon(a, 'annotations')}\n      now ${canon(b, 'annotations')}`)]),
      ];
    }),
  ];
  const notes = [...o.keys()].sort()
    .filter(name => n.has(name) && canon(o.get(name), 'description') !== canon(n.get(name), 'description'))
    .map(name => item('description', name, 'its description changed; read it before re-importing'));
  return { drift, notes };
}
