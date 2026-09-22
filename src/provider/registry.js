// The default registry: the built-in Claude, Codex, fx and laya adapters, then
// every other provider the configuration declares a command for.
import { object, own, requireAt } from '../common.js';
import { ProviderRegistry, capabilities } from './core.js';
import { loadProviderConfig } from './config.js';
import { commandProvider } from './command.js';
import { claudeProvider } from './providers/claude.js';
import { codexProvider } from './providers/codex.js';
import { fxProvider } from './providers/fx.js';
import { layaProvider } from './providers/laya.js';

const builtIn = { claude: [claudeProvider, 'claude', 2], codex: [codexProvider, 'codex', 4], fx: [fxProvider, 'fx', 2], laya: [layaProvider, 'python3', 1] };

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
    const timeoutSeconds = own(settings, 'timeout_seconds') ? settings.timeout_seconds : 600;
    requireAt(typeof timeoutSeconds === 'number' && timeoutSeconds > 0, `providers.${id}.timeout_seconds`, 'timeout_seconds must be a positive number');
    registry.register(make({ command, maxParallel,
      environment: Array.isArray(settings.environment) ? settings.environment : [],
      timeoutSeconds }));
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
