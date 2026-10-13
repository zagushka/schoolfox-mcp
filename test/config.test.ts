import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

test('configuration defaults allow an unconfigured read-only status', () => {
  assert.deepEqual(loadConfig({}), {
    token: undefined,
    email: undefined,
    password: undefined,
    timeoutMs: 10000,
    maxResponseBytes: 1048576,
    maxDownloadBytes: 10485760,
    downloadDir: resolve('./downloads')
  });
});

test('login credentials must be complete and cannot be mixed with a token', () => {
  assert.throws(() => loadConfig({ SCHOOLFOX_EMAIL: ' user@example.test ' }), /Set both SCHOOLFOX_EMAIL and SCHOOLFOX_PASSWORD/);
  assert.throws(() => loadConfig({ SCHOOLFOX_PASSWORD: 'secret' }), /Set both SCHOOLFOX_EMAIL and SCHOOLFOX_PASSWORD/);
  assert.throws(() => loadConfig({ SCHOOLFOX_EMAIL: 'user@example.test', SCHOOLFOX_PASSWORD: 'secret', SCHOOLFOX_TOKEN: 'token' }), /Use either SCHOOLFOX_TOKEN or login credentials/);
  const login = loadConfig({ SCHOOLFOX_EMAIL: ' user@example.test ', SCHOOLFOX_PASSWORD: 'secret' });
  assert.equal(login.email, 'user@example.test');
  assert.equal(login.password, 'secret');
  assert.equal(login.token, undefined);
  const token = loadConfig({ SCHOOLFOX_TOKEN: ' token ' });
  assert.equal(token.token, 'token');
  assert.equal(token.email, undefined);
});

test('numeric limits accept boundaries and reject invalid values', () => {
  const limits = [
    ['SCHOOLFOX_TIMEOUT_MS', 1000, 60000],
    ['SCHOOLFOX_MAX_RESPONSE_BYTES', 1024, 10485760],
    ['SCHOOLFOX_MAX_DOWNLOAD_BYTES', 1024, 104857600]
  ] as const;
  for (const [name, low, high] of limits) {
    for (const accepted of [low, high]) {
      assert.equal(loadConfig({ [name]: String(accepted) })[name === 'SCHOOLFOX_TIMEOUT_MS' ? 'timeoutMs' : name === 'SCHOOLFOX_MAX_RESPONSE_BYTES' ? 'maxResponseBytes' : 'maxDownloadBytes'], accepted);
    }
    for (const rejected of [String(low - 1), String(high + 1), '1.5', 'NaN', 'Infinity']) {
      assert.throws(() => loadConfig({ [name]: rejected }), new RegExp(`${name} must be an integer`));
    }
  }
});

test('download path resolves relative to the current working directory', () => {
  assert.equal(loadConfig({ SCHOOLFOX_DOWNLOAD_DIR: './safe-files' }).downloadDir, resolve('./safe-files'));
  const absolute = join(tmpdir(), 'schoolfox-fixture');
  assert.equal(loadConfig({ SCHOOLFOX_DOWNLOAD_DIR: absolute }).downloadDir, absolute);
});
