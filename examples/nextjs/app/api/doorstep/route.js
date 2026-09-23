import { doorstep } from '../../../lib/policies.js';
import { policyRoute } from '../../../lib/route.js';

export const { POST, GET } = policyRoute(doorstep);
