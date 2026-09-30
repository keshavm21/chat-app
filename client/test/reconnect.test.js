// Runs under Node's own test runner (`npm test`): no browser and no test library.
// Node strips the TypeScript types of the imported module.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createHandshakeRetry, isAuthenticationError, retryDelay } from '../src/lib/reconnect.ts';

const noJitter = () => 0.5; // 0.75 + 0.5 * 0.5 = 1: the delay itself

describe('retryDelay', () => {
  it('doubles from baseMs and stops at maxMs', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelay(attempt, { random: noJitter }));
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('spreads each delay by 25 % either way', () => {
    assert.equal(retryDelay(3, { random: () => 0 }), 3000);
    assert.equal(retryDelay(3, { random: () => 0.999999 }), 5000);
  });
});

describe('isAuthenticationError', () => {
  it("tells the server's session refusals from its temporary failures", () => {
    assert.equal(isAuthenticationError('Authentication error: invalid or expired token'), true);
    assert.equal(isAuthenticationError('Server error: could not check the session'), false);
    assert.equal(isAuthenticationError('Server error: could not load your conversations'), false);
  });
});

describe('createHandshakeRetry', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('connects again after the delay, backing off with each refusal', () => {
    const connect = mock.fn();
    const retry = createHandshakeRetry(connect, { random: noJitter });

    assert.equal(retry.schedule(), 1000);
    mock.timers.tick(999);
    assert.equal(connect.mock.callCount(), 0);
    mock.timers.tick(1);
    assert.equal(connect.mock.callCount(), 1);

    assert.equal(retry.schedule(), 2000); // refused again
    mock.timers.tick(2000);
    assert.equal(connect.mock.callCount(), 2);
  });

  it('starts over from the first delay once connected', () => {
    const connect = mock.fn();
    const retry = createHandshakeRetry(connect, { random: noJitter });
    retry.schedule();
    retry.schedule();

    retry.reset();

    mock.timers.tick(60_000);
    assert.equal(connect.mock.callCount(), 0); // reset also cancels the pending attempt
    assert.equal(retry.schedule(), 1000);
  });

  it('keeps one attempt pending at a time', () => {
    const connect = mock.fn();
    const retry = createHandshakeRetry(connect, { random: noJitter });

    retry.schedule();
    retry.schedule();
    mock.timers.tick(60_000);

    assert.equal(connect.mock.callCount(), 1);
  });

  it('does nothing more once stopped (the page went away)', () => {
    const connect = mock.fn();
    const retry = createHandshakeRetry(connect, { random: noJitter });
    retry.schedule();

    retry.stop();

    assert.equal(retry.schedule(), undefined);
    mock.timers.tick(60_000);
    assert.equal(connect.mock.callCount(), 0);
  });
});
