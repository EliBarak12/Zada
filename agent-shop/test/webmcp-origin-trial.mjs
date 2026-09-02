// Regression test: Chrome's WebMCP origin trial is enabled with an
// origin-scoped token delivered by the storefront response.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = 4994;
const token = 'test-webmcp-origin-trial-token';
const server = spawn('node', ['server/index.mjs'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    WEBMCP_ORIGIN_TRIAL_TOKEN: token,
    PRICE_DB: '/tmp/zada-webmcp-origin-trial-prices.json',
    PROFILE_DB: '/tmp/zada-webmcp-origin-trial-profile.json',
    CART_DB: '/tmp/zada-webmcp-origin-trial-cart.json',
    SIGNALS_DB: '/tmp/zada-webmcp-origin-trial-signals.json',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

try {
  await once(server.stdout, 'data');
  const response = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('origin-agent-cluster'), '?1');
  assert.equal(
    response.headers.get('origin-trial'),
    token,
    'the storefront must send the configured WebMCP Origin Trial token',
  );
  console.log('WEBMCP ORIGIN TRIAL: PASS');
} finally {
  server.kill();
}
