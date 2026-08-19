import * as fixture from 'fixture-lib';

const value = fixture.oldQuery('Ada');
if (value !== 'ADA') {
  throw new Error(`expected ADA, got ${value}`);
}
