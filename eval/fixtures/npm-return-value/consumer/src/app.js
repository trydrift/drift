import { formatUser } from 'fixture-lib';

const value = formatUser({ name: 'Ada' });
if (value !== 'ADA') {
  throw new Error(`expected ADA, got ${value}`);
}
