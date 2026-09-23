import { doorstep } from '../../../lib/policies.js';
import { policySource } from '../../../lib/source.js';
import CourierApp from './CourierApp.js';

// The policy stays on the server; the client only gets the questions it asks.
export default function Page() {
  return <CourierApp questions={doorstep.questions({})} source={policySource('doorstep')} />;
}
