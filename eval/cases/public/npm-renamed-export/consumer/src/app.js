import { oldName } from 'fixture-lib';

const value = oldName('Ada');
if (value !== 'ADA') {
  throw new Error(`expected ADA, got ${value}`);
}
