import { reservation } from '../../../lib/policies.js';
import { policySource } from '../../../lib/source.js';
import HostStand from './HostStand.js';

// The policy stays on the server; the client only gets the questions it asks.
export default function Page() {
  return <HostStand questions={reservation.questions({})} source={policySource('reservation')} />;
}
