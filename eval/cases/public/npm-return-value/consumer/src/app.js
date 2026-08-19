import { formatUser } from 'fixture-lib';

/**
 * The application's own behaviour, exported so it can be exercised
 * independently of this file's own self-check.
 */
export function displayName(user) {
  return formatUser(user);
}

const value = displayName({ name: 'Ada' });
if (value !== 'ADA') {
  throw new Error(`expected ADA, got ${value}`);
}
