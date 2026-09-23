import type { VercelConfig } from '@vercel/config/v1';

// No crons: decision records expire in Redis on their own (DECISION_RETENTION_HOURS).
export const config: VercelConfig = {
  framework: 'nextjs',
};
