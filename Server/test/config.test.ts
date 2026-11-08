import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_BROADCAST_PORT,
  DEFAULT_MAX_SUBSCRIBERS,
  DEFAULT_PRODUCTION,
  loadConfig,
} from "../src/config.js";

describe("server config", () => {
  it("uses defaults when nothing is set", () => {
    const config = loadConfig({});

    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 3000);
    assert.equal(config.broadcastPort, DEFAULT_BROADCAST_PORT);
    assert.equal(config.maxSubscribers, DEFAULT_MAX_SUBSCRIBERS);
    assert.equal(config.authKey, null);
    assert.deepEqual(config.production, DEFAULT_PRODUCTION);
  });

  it("reads broadcast settings from the environment", () => {
    const config = loadConfig({ OBVS_BROADCAST_PORT: "4001", OBVS_MAX_SUBSCRIBERS: "8" });

    assert.equal(config.broadcastPort, 4001);
    assert.equal(config.maxSubscribers, 8);
  });

  it("rejects invalid values", () => {
    assert.throws(() => loadConfig({ OBVS_BROADCAST_PORT: "70000" }), /OBVS_BROADCAST_PORT/);
    assert.throws(() => loadConfig({ OBVS_BROADCAST_PORT: "abc" }), /OBVS_BROADCAST_PORT/);
    assert.throws(() => loadConfig({ OBVS_MAX_SUBSCRIBERS: "0" }), /OBVS_MAX_SUBSCRIBERS/);
    assert.throws(() => loadConfig({ OBVS_MAX_SUBSCRIBERS: "1.5" }), /OBVS_MAX_SUBSCRIBERS/);
  });
});
