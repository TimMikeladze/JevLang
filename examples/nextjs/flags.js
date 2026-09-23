// The one flag: the Cloud link in the site nav, which opens cloud.jevlang.sh's
// sign-in page in a new tab. Default off. decide() reads FLAG_CLOUD_NAV so the
// link can be flipped for everyone with an env var; a Vercel Toolbar override
// (the encrypted vercel-flag-overrides cookie, needs FLAGS_SECRET) wins over
// decide. See docs/cloud-nav-flag.md.
import { flag } from 'flags/next';

export const cloudNav = flag({
  key: 'cloud-nav',
  defaultValue: false,
  options: [{ label: 'Off', value: false }, { label: 'On', value: true }],
  description: 'Show the Cloud link in the site nav (opens cloud.jevlang.sh sign-in in a new tab).',
  decide() {
    return process.env.FLAG_CLOUD_NAV === '1';
  },
});
