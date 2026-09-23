import { maintenance } from '../../../lib/policies.js';
import { policySource } from '../../../lib/source.js';
import Hotline from './Hotline.js';

// The policy stays on the server; the client only gets the questions it asks.
export default function Page() {
  return <Hotline questions={maintenance.questions({})} source={policySource('maintenance')} />;
}
