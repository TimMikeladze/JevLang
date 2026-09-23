import { doorstep } from '../../../lib/policies.js';
import { policySource } from '../../../lib/source.js';
import Demo from './Demo.js';

export const metadata = {
  title: 'JevLang example — Courier app',
  description: 'Parcel value and weather decide door, locker or tomorrow; a loose dog means nobody risks it. A JevLang policy on a Next.js route.',
  openGraph: { images: [{ url: '/og-examples-doorstep.png', width: 1200, height: 630 }] },
  twitter: { card: 'summary_large_image', images: ['/og-examples-doorstep.png'] },
};

// The policy stays on the server; the client only gets the questions it asks.
export default function Page() {
  return <Demo questions={doorstep.questions({})} source={policySource('doorstep')} />;
}
