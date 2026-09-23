import { reservation } from '../../../lib/policies.js';
import { policyRoute } from '../../../lib/route.js';

export const { POST, GET } = policyRoute(reservation);
