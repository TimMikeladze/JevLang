import type { JSONValue } from './index.js';
import type { Handler } from './dispatch.js';

export function loadHandlers(source: string | { handlers: Record<string, JSONValue> }): Promise<Record<string, Handler>>;
export function handlerFromSpec(target: string, spec: Record<string, JSONValue>, baseDir?: string): Handler;
export function registerHandlerType(type: string, make: (spec: Record<string, JSONValue>, baseDir: string) => Handler): void;
export function confirmHandler(handler: Handler): Handler;
export function fillTemplate(text: string, vars: Record<string, JSONValue>, who: string): string;
export function mqttPublish(host: string, port: number, topic: string, payload: string | Uint8Array, options?: {
  qos?: 0 | 1; retain?: boolean; clientId?: string | null; username?: string | null;
  password?: string | null; tls?: boolean; timeoutSeconds?: number;
}): Promise<void>;
