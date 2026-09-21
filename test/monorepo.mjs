// Differential tests read the Racket implementation and its recorded fixtures
// at ../../jev-lang (the sibling package inside the monorepo). Outside the
// monorepo those tests skip; everything else runs with no Racket anywhere.
import { existsSync } from 'node:fs';

export const inMonorepo = existsSync(new URL('../../jev-lang/info.rkt', import.meta.url));

export function skipUnlessInMonorepo(t) {
  if (!inMonorepo) t.skip('the Racket monorepo is not checked out next to this package');
  return !inMonorepo;
}
