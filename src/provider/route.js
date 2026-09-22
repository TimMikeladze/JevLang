// Deterministic provider resolution.
//
// The order is: an explicit request target, then the environment, the package's
// role or tier settings, the project configuration, the user configuration, and
// the defaults — because that is the order the configuration layers are
// consulted in. A route in a layer can override a field for a given operation,
// role, kind or tier, and the most specific matching route in the
// highest-precedence layer wins.
//
// Exact effort is honoured or rejected, never silently changed: when the caller
// or the configuration named a provider, an unsupported effort is an error, and
// otherwise that provider is only passed over.
import { object, own } from '../common.js';
import { configLayers } from './config.js';
import { ProviderError, availability, modelCapabilitySettings, unreportedCost } from './core.js';

const discoveryCache = new WeakMap();
export function clearProviderDiscoveryCache(registry = null) {
  if (!registry) return;
  for (const value of registry.providers()) discoveryCache.delete(value);
}
async function safeDiscover(value) {
  try {
    const result = await value.discover();
    return object(result) && typeof result.status === 'string' ? result : availability('unavailable', { detail: 'discovery returned an invalid value' });
  } catch (error) {
    return availability('unavailable', { detail: error.message });
  }
}
export async function discoverProviders(registry, { refresh = false } = {}) {
  const out = [];
  for (const value of registry.providers()) {
    if (refresh) discoveryCache.delete(value);
    if (!discoveryCache.has(value)) discoveryCache.set(value, await safeDiscover(value));
    out.push({ provider: value, availability: discoveryCache.get(value) });
  }
  return out;
}

const requiresToolPolicy = request => Array.isArray(request.metadata?.disallowed) && request.metadata.disallowed.length > 0;
export const capable = (caps, request) =>
  caps.modes.includes(request.mode)
  && request.modalities.every(m => caps.modalities.includes(m))
  && request.permissions.every(p => caps.permissions.includes(p))
  && (!request.schema || caps.controls.includes('structured-output'))
  && (!requiresToolPolicy(request) || caps.controls.includes('tool-policy'));

const routeFields = ['operation', 'role', 'kind', 'tier'];
export const routeSpecificity = route => routeFields.filter(f => own(route.when ?? {}, f)).length;
const requestField = (request, field) => routeFields.includes(field) ? request[field] ?? null : null;
const sameConfigValue = (actual, expected) => String(actual) === String(expected);
const routeMatches = (route, request) => Object.entries(route.when ?? {}).every(([field, expected]) => {
  const actual = requestField(request, field);
  const values = Array.isArray(expected) ? expected : [expected];
  return actual != null && values.some(one => sameConfigValue(actual, one));
});
function bestRouteInLayer(layer, request) {
  let best = null, bestScore = -1;
  for (const route of layer.routes ?? []) {
    const score = routeSpecificity(route);
    if (routeMatches(route, request) && score > bestScore) { best = route; bestScore = score; }
  }
  return best;
}
function selectRoute(config, request) {
  for (const [source, layer] of configLayers(config)) {
    const route = bestRouteInLayer(layer, request);
    if (route) return { source, value: route };
  }
  return null;
}
export const matchingProviderRoute = (config, request) => selectRoute(config, request)?.value ?? null;

const absent = Symbol('absent');
// A field is taken from the highest-precedence layer that sets it, and a route
// in that layer wins over the layer's own setting.
function layerField(config, route, fields) {
  for (const [source, layer] of configLayers(config)) {
    const use = route && source === route.source ? route.value.use ?? {} : null;
    if (use) {
      for (const field of fields) {
        const value = own(use, field) ? use[field] : absent;
        if (value !== absent) return { value, source: `${source}-route` };
      }
    }
    for (const field of fields) if (own(layer, field)) return { value: layer[field], source };
  }
  return null;
}
const keyRef = (table, key, fallback = null) => object(table) && key != null && own(table, String(key)) ? table[String(key)] : fallback;
const providerSettings = (config, id) => keyRef(config.providers ?? {}, id, {});
const providerKeyed = (value, id) => object(value) ? keyRef(value, id, null) : value;
const isAuto = value => typeof value === 'string' && value.toLowerCase() === 'auto';
const normalizeFallbackTarget = value => object(value)
  ? { provider: value.provider ?? 'auto', model: value.model ?? null, effort: value.effort ?? 'auto', fallback: [] }
  : value;

const fieldSourceLayer = source => source.replace(/-route$/, '');
const fieldSourcePriority = (config, source) => configLayers(config).findIndex(([name]) => name === fieldSourceLayer(source));
const higherPrecedenceField = (config, higher, lower) => {
  if (!higher || !lower) return false;
  const h = fieldSourcePriority(config, higher.source), l = fieldSourcePriority(config, lower.source);
  return h >= 0 && l >= 0 && h < l;
};

function candidateOrder(request, config, route, registry) {
  const requestProvider = request.target.provider ?? null;
  const targetProvider = requestProvider && !isAuto(requestProvider) ? requestProvider : null;
  const providerField = layerField(config, route, ['provider']);
  const preferenceField = layerField(config, route, ['prefer', 'preferences']);
  const configured = !requestProvider && providerField ? providerField.value : null;
  const exact = targetProvider
    ?? (configured && configured !== 'auto' && !higherPrecedenceField(config, preferenceField, providerField) ? configured : null);
  const preferences = preferenceField ? (Array.isArray(preferenceField.value) ? preferenceField.value : [preferenceField.value]) : [];
  const configuredFallback = layerField(config, route, ['fallback']);
  const fallback = [
    ...(request.target.fallback ?? []),
    ...(configuredFallback ? (Array.isArray(configuredFallback.value) ? configuredFallback.value : [configuredFallback.value]) : []),
  ].map(normalizeFallbackTarget);
  const declared = registry.providers().map(p => p.id);
  const order = exact
    ? [targetProvider ? { ...request.target, provider: exact, fallback: [] } : exact, ...fallback]
    : [...preferences, ...fallback, ...declared];
  const seen = new Set();
  return order.filter(candidate => {
    const key = JSON.stringify(candidate);
    return !seen.has(key) && seen.add(key);
  });
}
const candidateProvider = candidate => object(candidate) ? candidate.provider : candidate;
const candidateRequest = (request, candidate) => object(candidate) ? { ...request, target: { ...candidate, fallback: [] } } : request;
const sameResolvedTarget = (a, b) => a.provider.id === b.provider.id && a.model === b.model && a.effectiveEffort === b.effectiveEffort;
const candidateExcluded = (candidate, resolved, excluded) => object(candidate)
  ? excluded.some(prior => sameResolvedTarget(resolved, prior))
  : excluded.some(prior => candidate === prior.provider.id);

const refineCapabilities = (base, settings) => ({
  modes: Array.isArray(settings.modes) ? settings.modes : base.modes,
  modalities: Array.isArray(settings.modalities) ? settings.modalities : base.modalities,
  permissions: Array.isArray(settings.permissions) ? settings.permissions : base.permissions,
  controls: Array.isArray(settings.controls) ? settings.controls : base.controls,
  efforts: Array.isArray(settings.efforts) ? settings.efforts : base.efforts,
  maxParallel: own(settings, 'max_parallel') ? settings.max_parallel : base.maxParallel,
});
const tierSetting = (table, tier) => tier ? keyRef(table, tier, null) : null;

function resolveModel(request, config, route, id, settings) {
  const configured = layerField(config, route, ['model']);
  const raw = request.target.model
    ?? (configured ? providerKeyed(configured.value, id) : null)
    ?? tierSetting(settings.models ?? {}, request.tier)
    ?? settings.model ?? settings.default_model ?? null;
  return object(raw) ? raw.id ?? null : raw;
}
function resolveEffort(request, config, route, id, settings, modelSettings) {
  const requested = request.target.effort ?? null;
  const explicit = requested && !isAuto(requested) ? requested : null;
  const configured = layerField(config, route, ['effort']);
  const configuredEffort = configured ? providerKeyed(configured.value, id) : null;
  const modelDefault = modelSettings.default_effort ?? null;
  if (explicit) return [explicit, explicit];
  if (requested && isAuto(requested)) return ['auto', modelDefault];
  if (configuredEffort && isAuto(configuredEffort)) return ['auto', modelDefault];
  if (configuredEffort) return [configuredEffort, configuredEffort];
  const providerDefault = tierSetting(settings.efforts ?? {}, request.tier) ?? settings.effort ?? settings.default_effort ?? null;
  return providerDefault ? [providerDefault, providerDefault] : [null, modelDefault];
}
const resolutionError = (kind, target, detail, message) => new ProviderError(message, { kind, target, detail, cost: unreportedCost() });

// Returns { target, rejections, matchedRoute }. Every provider passed over is
// reported with why, so a failure names what was tried.
export async function resolveProvider(request, config, registry, { refresh = false, exclude = [] } = {}) {
  const route = selectRoute(config, request);
  const order = candidateOrder(request, config, route, registry);
  const providerField = layerField(config, route, ['provider']);
  const requestProvider = request.target.provider ?? null;
  const exactRequest = requestProvider && !isAuto(requestProvider) ? requestProvider : null;
  const exact = Boolean(exactRequest || (!requestProvider && providerField && providerField.value !== 'auto'));
  const discovered = new Map((await discoverProviders(registry, { refresh })).map(entry => [entry.provider.id, entry]));
  const rejections = [];
  const reject = (id, kind, detail) => rejections.push({ provider: id, kind, detail });
  let winner = null;
  for (const candidate of order) {
    const id = candidateProvider(candidate);
    const candidateReq = candidateRequest(request, candidate);
    const settings = providerSettings(config, id);
    const discovery = discovered.get(id);
    if (settings.enabled === false) { reject(id, 'disabled', 'disabled by configuration'); continue; }
    if (!discovery) { reject(id, 'missing', 'provider is not registered'); continue; }
    const value = discovery.provider, available = discovery.availability;
    if (available.status !== 'ready') { reject(id, available.status, available.detail); continue; }
    const model = resolveModel(candidateReq, config, route, id, settings);
    const modelSettings = { ...modelCapabilitySettings(value, model), ...(model ? keyRef(settings.model_capabilities ?? {}, model, {}) : {}) };
    const caps = refineCapabilities(value.caps, modelSettings);
    const [requestedEffort, effectiveEffort] = resolveEffort(candidateReq, config, route, id, settings, modelSettings);
    if (!capable(caps, candidateReq)) {
      reject(id, 'unsupported-capability', 'provider/model lacks a requested mode, modality, permission, or structured output');
      continue;
    }
    if (effectiveEffort && !caps.efforts.includes(effectiveEffort)) {
      const detail = `effort ${effectiveEffort} is unsupported; accepts: ${caps.efforts.join(', ')}`;
      if (exact || object(candidate)) {
        throw resolutionError('configuration',
          { provider: value, model, requestedEffort, effectiveEffort, sources: { provider: 'request' } },
          detail, `provider ${id} model ${model ?? '<default>'} ${detail}`);
      }
      reject(id, 'unsupported-effort', detail);
      continue;
    }
    // The candidate's own target decides the source, so a fallback target that
    // named a provider is reported as a request, exactly as a caller's would be.
    const candidateExact = candidateReq.target.provider && !isAuto(candidateReq.target.provider);
    const resolved = {
      provider: value, model, requestedEffort, effectiveEffort,
      sources: {
        provider: candidateExact ? 'request' : providerField ? 'config' : 'preference',
        model: candidateReq.target.model ? 'request' : 'config',
        effort: candidateReq.target.effort && !isAuto(candidateReq.target.effort) ? 'request' : 'config',
      },
    };
    if (!candidateExcluded(candidate, resolved, exclude)) { winner = resolved; break; }
  }
  if (!winner) {
    throw resolutionError(exact ? 'unavailable' : 'unsupported-capability', null, rejections,
      `no eligible provider for ${request.operation}/${request.mode}`);
  }
  return { target: winner, rejections, matchedRoute: route?.value ?? null };
}
