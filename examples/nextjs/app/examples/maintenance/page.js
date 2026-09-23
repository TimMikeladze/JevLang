import { maintenance } from '../../../lib/policies.js';
import { policySource } from '../../../lib/source.js';
import Hotline from './Hotline.js';

export const metadata = {
  title: 'JevLang example — Tenant hotline',
  description: "A gas smell at 3am pages on-call; a drip at noon waits for today's plumber. A JevLang policy on a Next.js route.",
  openGraph: { images: [{ url: '/og-examples-maintenance.png', width: 1200, height: 630 }] },
  twitter: { card: 'summary_large_image', images: ['/og-examples-maintenance.png'] },
};

// The policy stays on the server; the client only gets the questions it asks.
export default function Page() {
  return <Hotline questions={maintenance.questions({})} source={policySource('maintenance')} />;
}
