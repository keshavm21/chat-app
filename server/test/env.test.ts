import { describe, expect, it } from 'vitest';
import { ConfigError, parseEnv } from '../config/env.js';

const valid = { DATABASE_URL: 'postgres://u:p@localhost:5432/relay' };

/** Runs parseEnv and returns the ConfigError it throws. */
function configErrorFor(env: Record<string, string | undefined>) {
  try {
    parseEnv(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected parseEnv to throw a ConfigError');
}

describe('parseEnv', () => {
  it('returns the config, applying the current defaults', () => {
    expect(parseEnv(valid)).toEqual({
      nodeEnv: 'development',
      port: 5001,
      clientUrl: 'http://localhost:5173',
      logLevel: 'info',
      database: { url: valid.DATABASE_URL, port: 5432 },
    });
  });

  it('accepts the DB_* variables instead of DATABASE_URL and converts ports to numbers', () => {
    const config = parseEnv({
      PORT: '8080',
      DB_USER: 'relay',
      DB_HOST: 'localhost',
      DB_NAME: 'relay_dev',
      DB_PASSWORD: 'pw',
      DB_PORT: '5433',
    });

    expect(config.port).toBe(8080);
    expect(config.database).toEqual({ user: 'relay', host: 'localhost', name: 'relay_dev', password: 'pw', port: 5433 });
  });

  it('treats an empty value as missing', () => {
    expect(configErrorFor({ DATABASE_URL: '' }).variables).toEqual(['DATABASE_URL']);
    expect(parseEnv({ ...valid, PORT: '' }).port).toBe(5001);
  });

  it('fails when neither DATABASE_URL nor the DB_* variables are set', () => {
    const error = configErrorFor({});

    expect(error.variables).toEqual(['DATABASE_URL']);
    expect(error.message).toContain('DB_USER, DB_HOST, DB_NAME, DB_PASSWORD');
  });

  it('names each missing DB_* variable when only some are set', () => {
    const error = configErrorFor({ DB_USER: 'relay', DB_HOST: 'localhost' });

    expect(error.variables).toEqual(['DB_NAME', 'DB_PASSWORD']);
  });

  it('names invalid variables without ever showing their values', () => {
    const error = configErrorFor({
      ...valid,
      NODE_ENV: 'staging-SENSITIVE',
      PORT: 'not-a-port-SENSITIVE',
      CLIENT_URL: 'not a url SENSITIVE',
    });

    expect(error.variables.sort()).toEqual(['CLIENT_URL', 'NODE_ENV', 'PORT']);
    expect(error.message).not.toContain('SENSITIVE');
  });

  it('returns a frozen config', () => {
    const config = parseEnv(valid);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });
});
