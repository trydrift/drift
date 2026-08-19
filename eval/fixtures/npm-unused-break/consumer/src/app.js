import { usedFn } from 'fixture-lib';

const value = usedFn('Ada');
if (value !== 'ADA') {
  throw new Error(`expected ADA, got ${value}`);
}
