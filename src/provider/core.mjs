// The provider contract: what a provider is, what a request asks for, and the
// registry that holds them. Ids, modes, modalities, permissions and controls are
// plain strings here, where the Racket implementation uses symbols.
import { own, object } from '../common.mjs';

export class ProviderError extends Error {
  constructor(message, { kind = 'provider-failure', target = null, retryable = false, mutated = false, usage = null, cost = unreportedCost(), status = null, detail = null, attempts = [] } = {}) {
    super(message);
    this.name = 'ProviderError';
    Object.assign(this, { kind, target, retryable, mutated, usage, cost, status, detail, attempts });
  }
}
export const unreportedCost = () => ({ mode: 'unreported', usd: null });

// modes: structured, workspace, ...; controls: structured-output, tool-policy
export const capabilities = ({ modes = ['structured'], modalities = ['text'], permissions = ['read'], controls = ['structured-output'], efforts = [], maxParallel = 1 } = {}) =>
  ({ modes, modalities, permissions, controls, efforts, maxParallel });
export const availability = (status, { version = null, billing = 'unreported', detail = null } = {}) => ({ status, version, billing, detail });
export const targetSpec = ({ provider = null, model = null, effort = null, fallback = [] } = {}) => ({ provider, model, effort, fallback });

export const providerRequest = (operation, mode, {
  role = operation, kind = null, tier = null, modalities = ['text'], permissions = ['read'],
  prompt = '', schema = null, images = [], directory = null, target = targetSpec(), limits = {}, metadata = {},
} = {}) => ({ operation, mode, role, kind, tier, modalities, permissions, prompt, schema, images, directory, target, limits, metadata });

// A provider is its id, what it can do, how to discover it, and how to run it.
export const provider = ({ id, caps, discover, run, modelCapabilities = {} }) => ({ id, caps, discover, run, modelCapabilities });

// A counting semaphore, so a provider's advertised parallelism is respected
// even when several requests run at once.
class Slots {
  #free; #waiting = [];
  constructor(limit) { this.#free = limit; }
  async acquire() {
    if (this.#free > 0) { this.#free -= 1; return; }
    await new Promise(resolve => this.#waiting.push(resolve));
  }
  release() {
    const next = this.#waiting.shift();
    if (next) next(); else this.#free += 1;
  }
}

export class ProviderRegistry {
  #order = []; #byId = new Map(); #slots = new Map();
  register(value) {
    if (!value?.id) throw new TypeError('a provider needs an id');
    if (!this.#byId.has(value.id)) this.#order.push(value.id);
    this.#byId.set(value.id, value);
    // A replaced registration may advertise different parallelism.
    this.#slots.delete(value.id);
    return value;
  }
  get(id, fallback = null) { return this.#byId.get(id) ?? fallback; }
  providers() { return this.#order.map(id => this.#byId.get(id)); }
  // Call-local providers, without replacing the application's registry. An
  // existing id wins: it may be an application-owned adapter with narrower
  // capabilities than the built-in of the same name.
  overlay(values, { prepend = false } = {}) {
    const additions = values.filter(v => !this.#byId.has(v.id));
    const next = new ProviderRegistry();
    const ids = prepend ? [...additions.map(v => v.id), ...this.#order] : [...this.#order, ...additions.map(v => v.id)];
    for (const id of ids) next.register(this.#byId.get(id) ?? additions.find(v => v.id === id));
    return next;
  }
  async withSlot(value, thunk) {
    if (!this.#slots.has(value.id)) {
      const limit = value.caps.maxParallel;
      if (!Number.isInteger(limit) || limit <= 0) throw new TypeError(`provider ${value.id} max parallel must be a positive integer`);
      this.#slots.set(value.id, new Slots(limit));
    }
    const slots = this.#slots.get(value.id);
    await slots.acquire();
    try { return await thunk(); } finally { slots.release(); }
  }
}
// Discovery adapters can attach model-specific facts without making the
// provider contract depend on one vendor's catalog shape.
export function modelCapabilitySettings(value, model) {
  const settings = value.modelCapabilities ?? {};
  return model && object(settings) && own(settings, model) ? settings[model] : {};
}
