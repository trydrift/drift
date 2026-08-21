import * as fixture from 'fixture-lib';

/**
 * The application's own behaviour, exported so it can be exercised
 * independently of this file's own self-check.
 */
export function shout(name) {
  return fixture.oldQuery(name);
}

const value = shout('Ada');
if (value !== 'ADA') {
  throw new Error(`expected ADA, got ${value}`);
}
