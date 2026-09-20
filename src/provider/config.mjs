// Layered provider configuration: defaults, then the user file, the project
// file, the package (with its per-role settings), the environment, and the
// request. Each layer is remembered, because resolution reports which layer
// decided a field.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { object, requireAt } from '../common.mjs';

export const layerOrder = ['default', 'user', 'project', 'package', 'environment', 'request'];
export const environmentReader = { get: name => process.env[name] };
export const userConfigPath = () => {
  const xdg = environmentReader.get('XDG_CONFIG_HOME');
  return join(xdg && xdg !== '' ? xdg : join(homedir(), '.config'), 'jev', 'providers.json');
};
export const projectConfigName = join('.jev', 'providers.json');

const asConfig = value => value == null ? {} : (requireAt(object(value), 'config', 'provider configuration must be a JSON object'), value);
const deepMerge = (lower, higher) => {
  const result = { ...lower };
  for (const [key, high] of Object.entries(higher)) {
    const low = result[key];
    result[key] = object(low) && object(high) ? deepMerge(low, high) : high;
  }
  return result;
};
const roleSettings = (pkg, role) => {
  if (!role) return {};
  const agents = pkg.agents;
  return object(agents) && object(agents[role]) ? agents[role] : {};
};

export function mergeProviderConfig({ defaults = {}, user = {}, project = {}, package: pkg = {}, environment = {}, request = {}, role = null } = {}) {
  const raw = { default: asConfig(defaults), user: asConfig(user), project: asConfig(project), package: asConfig(pkg), environment: asConfig(environment), request: asConfig(request) };
  const layers = layerOrder.map(name => [name, name === 'package' ? deepMerge(raw.package, roleSettings(raw.package, role)) : raw[name]]);
  const merged = layers.reduce((result, [, layer]) => deepMerge(result, layer), {});
  // Reversed, so the highest-precedence layer is consulted first.
  return { ...merged, _layers: [...layers].reverse(), _role: role };
}
export const configLayers = config => config._layers ?? [['config', config]];

const readConfig = path => {
  if (!path || !existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, 'utf8'));
  requireAt(object(value), path, 'provider configuration must be a JSON object');
  return value;
};
const startingDirectory = value => {
  const complete = resolve(value);
  try { if (statSync(complete).isDirectory()) return complete; } catch { /* not a directory */ }
  return dirname(complete);
};
// The search stops at a repository boundary, so a checkout cannot pick up a
// configuration from outside it.
export function findProjectConfig(start) {
  let directory = startingDirectory(start);
  for (;;) {
    const candidate = join(directory, projectConfigName);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(directory, '.git'))) return null;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
const environmentConfig = () => Object.fromEntries([['JEV_PROVIDER', 'provider'], ['JEV_MODEL', 'model'], ['JEV_EFFORT', 'effort']]
  .map(([name, key]) => [key, environmentReader.get(name)])
  .filter(([, value]) => value != null && value !== ''));

export function loadProviderConfig({ start = process.cwd(), defaults = {}, package: pkg = {}, request = {}, role = null } = {}) {
  const alternate = environmentReader.get('JEV_PROVIDER_CONFIG');
  const projectPath = alternate && alternate !== '' ? (isAbsolute(alternate) ? alternate : resolve(alternate)) : findProjectConfig(start);
  return mergeProviderConfig({
    defaults, user: readConfig(userConfigPath()), project: readConfig(projectPath),
    package: pkg, environment: environmentConfig(), request, role,
  });
}
