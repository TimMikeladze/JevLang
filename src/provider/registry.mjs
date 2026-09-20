// The default registry: the built-in Claude, Codex and fx adapters, then every
// other provider the configuration declares a command for.
import { object, own, requireAt } from '../common.mjs';
import { ProviderRegistry, capabilities } from './core.mjs';
import { loadProviderConfig } from './config.mjs';
import { commandProvider } from './command.mjs';
import { claudeProvider } from './providers/claude.mjs';
import { codexProvider } from './providers/codex.mjs';
import { fxProvider } from './providers/fx.mjs';

const builtIn = { claude: [claudeProvider, 'claude', 2], codex: [codexProvider, 'codex', 4], fx: [fxProvider, 'fx', 2] };

const configured = value => capabilities({
  modes: Array.isArray(value.modes) ? value.modes : ['structured'],
  modalities: Array.isArray(value.modalities) ? value.modalities : ['text'],
  permissions: Array.isArray(value.permissions) ? value.permissions : ['read'],
  controls: Array.isArray(value.controls) ? value.controls : ['structured-output'],
  efforts: Array.isArray(value.efforts) ? value.efforts : [],
  maxParallel: Number.isInteger(value.max_parallel) && value.max_parallel > 0 ? value.max_parallel : 1,
});

export function makeDefaultRegistry(config = loadProviderConfig()) {
  const registry = new ProviderRegistry();
  const providers = object(config.providers) ? config.providers : {};
  for (const [id, [make, defaultCommand, defaultParallel]] of Object.entries(builtIn)) {
    const settings = object(providers[id]) ? providers[id] : {};
    const command = own(settings, 'command') ? settings.command : defaultCommand;
    requireAt(typeof command === 'string', `providers.${id}.command`, 'a built-in provider command must be a string');
    const maxParallel = own(settings, 'max_parallel') ? settings.max_parallel : defaultParallel;
    requireAt(Number.isInteger(maxParallel) && maxParallel > 0, `providers.${id}.max_parallel`, 'max_parallel must be a positive integer');
    registry.register(make({ command, maxParallel }));
  }
  for (const id of Object.keys(providers).sort()) {
    if (own(builtIn, id)) continue;
    const settings = providers[id];
    if (!object(settings) || !own(settings, 'command')) continue;
    registry.register(commandProvider(id, settings.command, {
      caps: configured(object(settings.capabilities) ? settings.capabilities : {}),
      environment: Array.isArray(settings.environment) ? settings.environment : [],
      timeoutSeconds: own(settings, 'timeout_seconds') ? settings.timeout_seconds : 300,
    }));
  }
  return registry;
}
