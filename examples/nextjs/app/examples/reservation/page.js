import { reservation } from '../../../lib/policies.js';
import { policySource } from '../../../lib/source.js';
import HostStand from './HostStand.js';

export const metadata = {
  title: 'JevLang example — SMS host',
  description: 'Allergies reach the kitchen, a full house offers the waitlist, big parties go to the events manager. A JevLang policy on a Next.js route.',
  openGraph: { images: [{ url: '/og-examples-reservation.png', width: 1200, height: 630 }] },
  twitter: { card: 'summary_large_image', images: ['/og-examples-reservation.png'] },
};

// The policy stays on the server; the client only gets the questions it asks.
export default function Page() {
  return <HostStand questions={reservation.questions({})} source={policySource('reservation')} />;
}
