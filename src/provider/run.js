// Running a request: resolve, run under the provider's parallelism slot, and on
// a retryable failure that did not mutate anything, fall back to the next
// eligible provider. Every attempt is kept, with its usage and cost.
import { ProviderError, unreportedCost } from './core.js';
import { resolveProvider } from './route.js';

const attemptFromError = (target, error) => ({ target, outcome: error.kind, usage: error.usage, cost: error.cost, requestId: null, diagnostic: error.detail });
const successAttempt = result => ({ target: result.target, outcome: 'success', usage: result.usage, cost: result.cost, requestId: result.requestId, diagnostic: null });
const normalizeError = (target, error) => error instanceof ProviderError ? error
  : new ProviderError(`provider ${target.provider.id} failed`, { kind: 'provider-failure', target, detail: 'provider raised an unexpected error' });
const fallbackError = (last, attempts) => new ProviderError('no eligible fallback provider remains', {
  kind: 'unavailable', target: last?.target ?? null, usage: last?.usage ?? null,
  cost: last?.cost ?? unreportedCost(), status: last?.status ?? null, detail: last?.detail ?? null, attempts,
});
const semanticError = (result, diagnostic) => new ProviderError('provider returned semantically invalid output', {
  kind: 'invalid-output', target: result.target, retryable: true, usage: result.usage,
  cost: result.cost, status: result.exitStatus, detail: diagnostic,
});

// validate : output -> a diagnostic string when the output is unusable
export async function runProviderRequest(request, config, registry, { validate = null, observe = null } = {}) {
  const excluded = [], attempts = [];
  let lastError = null;
  for (;;) {
    let resolution;
    try {
      resolution = await resolveProvider(request, config, registry, { exclude: excluded });
    } catch (error) {
      throw attempts.length ? fallbackError(lastError, attempts) : error;
    }
    const target = resolution.target;
    try {
      const result = await registry.withSlot(target.provider, () => target.provider.run(request, target));
      observe?.(result);
      if (validate) {
        let diagnostic = null;
        try { diagnostic = validate(result.output); } catch (error) { diagnostic = error.message; }
        if (diagnostic) throw semanticError(result, diagnostic);
      }
      return { ...result, attempts: [...attempts, ...result.attempts, successAttempt(result)] };
    } catch (raw) {
      const error = normalizeError(target, raw);
      attempts.push(attemptFromError(target, error));
      // A workspace run may have changed files, so it is never retried blindly.
      if (error.retryable && !error.mutated && request.mode !== 'workspace') {
        excluded.push(target); lastError = error;
        continue;
      }
      error.attempts = [...attempts];
      throw error;
    }
  }
}
