// Turning typed text into names (src/lib/names.ts), under Node's own test runner (`npm test`).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { searchPrefix, toChannelName } from '../src/lib/names.ts';

describe('searchPrefix', () => {
  it('drops a leading # or @ and spaces, and lowercases', () => {
    assert.equal(searchPrefix('  #Gen '), 'gen');
    assert.equal(searchPrefix('@Ann_B'), 'ann_b');
    assert.equal(searchPrefix(''), '');
  });

  it('is null for text no channel or username could start with', () => {
    assert.equal(searchPrefix('has space'), null);
    assert.equal(searchPrefix('50%'), null);
    assert.equal(searchPrefix('é'), null);
    assert.equal(searchPrefix('x'.repeat(101)), null);
  });
});

describe('toChannelName', () => {
  it('makes a valid channel name of what is typed', () => {
    assert.equal(toChannelName('#Team Chat!'), 'team-chat');
    assert.equal(toChannelName('Q3 plans 2026'), 'q3-plans-2026');
    assert.equal(toChannelName('x'.repeat(50)).length, 40);
    assert.equal(toChannelName('!!!'), '');
  });
});
