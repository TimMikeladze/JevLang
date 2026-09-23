// The Flags Explorer discovery endpoint: what makes the flag show up in the
// Vercel Toolbar, where it can be toggled per browser. Requires FLAGS_SECRET.
import { createFlagsDiscoveryEndpoint, getProviderData } from 'flags/next';
import { cloudNav } from '../../../../flags.js';

export const GET = createFlagsDiscoveryEndpoint(() => getProviderData({ cloudNav }));
