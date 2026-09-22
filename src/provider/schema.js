// The JSON Schema subset a provider's structured output is checked against:
// types, const, enum, allOf/anyOf/oneOf, object properties and required keys,
// closed objects, array items and bounds, string lengths and number ranges.
import { own, object } from '../common.js';

const typeValid = (type, value) => {
  if (Array.isArray(type)) return type.some(one => typeValid(one, value));
  switch (type) {
    case 'object': return object(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function valid(schema, value) {
  if (!object(schema)) return false;
  if (own(schema, 'type') && !typeValid(schema.type, value)) return false;
  if (own(schema, 'const') && !equal(value, schema.const)) return false;
  if (own(schema, 'enum') && !schema.enum.some(one => equal(one, value))) return false;
  if ((schema.allOf ?? []).some(sub => !valid(sub, value))) return false;
  if ((schema.anyOf ?? []).length && !schema.anyOf.some(sub => valid(sub, value))) return false;
  if ((schema.oneOf ?? []).length && schema.oneOf.filter(sub => valid(sub, value)).length !== 1) return false;
  if (object(value)) {
    const properties = schema.properties ?? {};
    if ((schema.required ?? []).some(key => !own(value, key))) return false;
    if (Object.entries(properties).some(([key, sub]) => own(value, key) && !valid(sub, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !own(properties, key))) return false;
  } else if (Array.isArray(value)) {
    if (schema.items && value.some(item => !valid(schema.items, item))) return false;
    if (own(schema, 'minItems') && value.length < schema.minItems) return false;
    if (own(schema, 'maxItems') && value.length > schema.maxItems) return false;
  } else if (typeof value === 'string') {
    if (own(schema, 'minLength') && [...value].length < schema.minLength) return false;
    if (own(schema, 'maxLength') && [...value].length > schema.maxLength) return false;
  } else if (typeof value === 'number') {
    if (own(schema, 'minimum') && value < schema.minimum) return false;
    if (own(schema, 'maximum') && value > schema.maximum) return false;
  }
  return true;
}
export const jsonSchemaValid = (schema, value) => !schema || valid(schema, value);
export function validateJsonSchema(schema, value) {
  if (!jsonSchemaValid(schema, value)) throw new TypeError('value does not match JSON Schema');
  return value;
}
