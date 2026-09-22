// JSON Schema (2020-12) views of a policy's action declarations, for MCP tool
// listings and anything else that speaks JSON Schema. The mapping, per type:
//
//   string            {"type": "string"}
//   boolean           {"type": "boolean"}
//   number            {"type": "number"}, with "minimum"/"maximum" from min/max
//   one-of            {"type": "string", "enum": [...]}
//   json              {} (any value)
//   list-of           {"type": "array", "items": <T>}
//   member-of         {} plus a description and "x-jev-member-of": the allowed
//                     values come from the facts at run time, so no static
//                     enum exists
//
// An optional parameter is left out of "required". The object is closed, because
// the dispatcher rejects unknown parameters anyway. The safety rules are not
// JSON Schema, so they travel beside it: confirm becomes destructiveHint, and
// all of them appear under the "jev/" _meta prefix.
import { own } from './common.js';

export function parameterSchema(t) {
  switch (t.type) {
    case 'string': return { type: 'string' };
    case 'boolean': return { type: 'boolean' };
    case 'number': return {
      type: 'number',
      ...(own(t, 'min') ? { minimum: t.min } : {}),
      ...(own(t, 'max') ? { maximum: t.max } : {}),
    };
    case 'one-of': return { type: 'string', enum: t.values };
    case 'list-of': return { type: 'array', items: parameterSchema(t.of) };
    case 'member-of': return {
      description: `one of the values in the facts' ${t.field} list, known only at run time`,
      'x-jev-member-of': t.field,
    };
    default: return {};
  }
}
export const actionInputSchema = a => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(a.params).map(([k, t]) => [k, parameterSchema(t)])),
  required: Object.entries(a.params).filter(([, t]) => !t.optional).map(([k]) => k),
  additionalProperties: false,
});
// Nothing here claims an action is read-only or idempotent: a declaration does
// not say. A confirmed action is destructive.
export const actionAnnotations = a => ({ destructiveHint: a.confirm === true });
// A declared inverse travels as its action name and its arguments, where a
// parameter of the action it undoes appears as ["param", name].
const undoArgument = x => x.op === 'variable' ? ['param', x.args[0]] : x.args[0];
export const actionMeta = a => ({
  'jev/confirm': a.confirm === true,
  'jev/min_confidence': a.minConfidence ?? null,
  'jev/cooldown_seconds': a.cooldown ?? null,
  'jev/allow': a.allow ?? null,
  'jev/timeout_seconds': a.timeout ?? null,
  'jev/undo': a.undo ? { name: a.undo.target, args: Object.fromEntries(Object.entries(a.undo.params).map(([k, x]) => [k, undoArgument(x)])) } : null,
});
export const actionTool = (name, a) => ({
  name,
  ...(typeof a.doc === 'string' ? { description: a.doc } : {}),
  inputSchema: actionInputSchema(a),
  annotations: actionAnnotations(a),
  _meta: actionMeta(a),
});
// What `jev schema --json` shows, and what an MCP tool listing carries.
export const policyActions = policy => {
  const p = policy.policy ?? policy;
  return { policy: p.name ?? null, actions: Object.entries(p.actions ?? {}).map(([name, a]) => actionTool(name, a)) };
};
