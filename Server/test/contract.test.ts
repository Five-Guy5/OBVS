import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PROTOCOL_VERSION,
  SUPPORTED_INGEST_VERSIONS,
} from "@obvs/protocol";

import { DEFAULT_CAPABILITIES, type ServerConfig } from "../src/config.js";
import { logon } from "../src/ingest.js";
import { parseIngestEvent } from "../src/match.js";
import { MatchRegistry } from "../src/registry.js";
import { ingestSequence, logonExchange } from "../../Protocol/test/fixtures/index.js";

const config: ServerConfig = {
  port: 0,
  authKey: logonExchange.request.authKey,
  capabilities: DEFAULT_CAPABILITIES,
};

describe("protocol contract server gating", () => {
  it("accepts the logon fixture", () => {
    const registry = new MatchRegistry();
    const outcome = logon(logonExchange.request, config, registry);

    assert.ok(outcome.response.accepted);
    assert.equal(outcome.response.matchSecret, outcome.match?.secret);
    assert.equal(registry.get(logonExchange.request.groupCode), outcome.match);
  });

  it("accepts every supported ingest version, including the one before the rejected version", () => {
    for (const version of SUPPORTED_INGEST_VERSIONS) {
      const outcome = logon(
        { ...logonExchange.request, protocolVersion: version },
        config,
        new MatchRegistry(),
      );

      assert.ok(outcome.response.accepted, `logon version ${version}`);

      for (const event of ingestSequence) {
        assert.equal(
          parseIngestEvent({ ...event, protocolVersion: version }).ok,
          true,
          `ingest version ${version} ${event.type}`,
        );
      }
    }
  });

  it("rejects an unsupported ingest version at logon and on every event", () => {
    const unsupported = PROTOCOL_VERSION + 1;
    const registry = new MatchRegistry();
    const outcome = logon(
      { ...logonExchange.request, protocolVersion: unsupported },
      config,
      registry,
    );

    assert.deepEqual(outcome.response, {
      accepted: false,
      reason: "Unsupported protocol version.",
    });
    assert.equal(outcome.match, null);
    assert.equal(registry.get(logonExchange.request.groupCode), undefined);

    for (const event of ingestSequence) {
      assert.deepEqual(parseIngestEvent({ ...event, protocolVersion: unsupported }), {
        ok: false,
        reason: "Unsupported protocol version.",
      });
    }
  });
});
