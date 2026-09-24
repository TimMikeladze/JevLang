// The one flag: everything about the hosted product on the site — the Cloud
// nav link, the cloud sections of the landing page, the hero's cloud sentence
// and the footer's Jev Cloud column. Default off. decide() reads FLAG_CLOUD so
// it can be flipped for everyone with an env var; a Vercel Toolbar override
// (the encrypted vercel-flag-overrides cookie, needs FLAGS_SECRET) wins over
// decide. See docs/cloud-flag.md.
import { flag } from 'flags/next';

export const cloud = flag({
  key: 'cloud',
  defaultValue: false,
  options: [{ label: 'Off', value: false }, { label: 'On', value: true }],
  description: 'Show the hosted product on the site: the Cloud nav link, the landing page\'s cloud sections and the footer column.',
  decide() {
    return process.env.FLAG_CLOUD === '1';
  },
});
