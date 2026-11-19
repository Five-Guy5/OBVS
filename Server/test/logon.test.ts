import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROTOCOL_VERSION } from "@obvs/protocol";

import { DEFAULT_CAPABILITIES, type ServerConfig } from "../src/config.js";
import { logon } from "../src/ingest.js";
import { isAuthorized, parseLogonRequest } from "../src/logon.js";
import { MatchRegistry } from "../src/registry.js";

const validRequest = {
  protocolVersion: PROTOCOL_VERSION,
  groupCode: "group_1",
  observerName: "Observer",
  clientVersion: "0.1.0",
  authKey: null,
};

function config(authKey: string | null = null): ServerConfig {
  return { port: 0, authKey, capabilities: DEFAULT_CAPABILITIES };
}

function reasonFor(patch: Record<string, unknown>): string | undefined {
  const result = parseLogonRequest({ ...validRequest, ...patch });

  return result.ok ? undefined : result.reason;
}

describe("logon request parsing", () => {
  it("accepts a well-formed request", () => {
    const result = parseLogonRequest(validRequest);

    assert.equal(result.ok, true);
  });

  it("gates on the protocol version before other fields", () => {
    const result = parseLogonRequest({ protocolVersion: PROTOCOL_VERSION + 1 });

    assert.deepEqual(result, { ok: false, reason: "Unsupported protocol version." });
  });

  it("rejects malformed fields", () => {
    assert.match(reasonFor({ groupCode: "bad.code" })!, /Group code/);
    assert.match(reasonFor({ observerName: "   " })!, /display name/);
    assert.match(reasonFor({ observerName: "bad\u0001name" })!, /display name/);
    assert.match(reasonFor({ clientVersion: 1 })!, /Client version/);
    assert.match(reasonFor({ clientVersion: "9.9.9" })!, /Unsupported client version/);
    assert.match(reasonFor({ authKey: "" })!, /Auth key/);
    assert.match(reasonFor({ matchSecret: 42 })!, /Match secret/);
  });

  it("rejects non-object input", () => {
    assert.equal(parseLogonRequest(null).ok, false);
    assert.equal(parseLogonRequest("logon").ok, false);
  });
});

describe("auth key check", () => {
  it("allows any client on open ingest", () => {
    assert.equal(isAuthorized(null, null), true);
    assert.equal(isAuthorized(null, "anything"), true);
  });

  it("requires an exact match when the server has a key", () => {
    assert.equal(isAuthorized("secret", "secret"), true);
    assert.equal(isAuthorized("secret", "Secret"), false);
    assert.equal(isAuthorized("secret", "secret-longer"), false);
    assert.equal(isAuthorized("secret", null), false);
  });
});

describe("logon", () => {
  it("returns a Match Secret and capabilities when accepted", () => {
    const registry = new MatchRegistry();
    const { response, match } = logon(validRequest, config(), registry);

    assert.ok(response.accepted);
    assert.equal(response.matchSecret, match?.secret);
    assert.deepEqual(response.capabilities, DEFAULT_CAPABILITIES);
    assert.equal(registry.get("group_1"), match);
  });

  it("rejects a wrong auth key without creating a Match", () => {
    const registry = new MatchRegistry();
    const { response } = logon({ ...validRequest, authKey: "wrong" }, config("secret"), registry);

    assert.deepEqual(response, { accepted: false, reason: "Auth key rejected." });
    assert.equal(registry.get("group_1"), undefined);
  });

  it("rejects a second Observer for the same group code", () => {
    const registry = new MatchRegistry();
    const first = logon(validRequest, config(), registry);
    const second = logon({ ...validRequest, observerName: "Other" }, config(), registry);

    assert.equal(second.response.accepted, false);
    assert.equal(second.match, null);
    assert.equal(registry.get("group_1"), first.match);
  });

  it("resumes a disconnected Match with the correct secret", () => {
    const registry = new MatchRegistry();
    const first = logon(validRequest, config(), registry);

    assert.ok(first.response.accepted);
    const match = first.match!;
    const resumed = logon({ ...validRequest, matchSecret: match.secret }, config(), registry);

    assert.ok(resumed.response.accepted);
    assert.equal(resumed.match, match);
    assert.equal(resumed.response.matchSecret, match.secret);
  });

  it("rejects a wrong or missing secret while a Match exists", () => {
    const registry = new MatchRegistry();
    const first = logon(validRequest, config(), registry);

    assert.ok(first.response.accepted);
    const match = first.match!;

    assert.equal(
      logon({ ...validRequest, matchSecret: "wrong" }, config(), registry).response.accepted,
      false,
    );
    assert.equal(logon(validRequest, config(), registry).response.accepted, false);
    assert.equal(registry.get("group_1"), match);
  });

  it("rejects a resume while the Observer is still connected", () => {
    const registry = new MatchRegistry();
    const first = logon(validRequest, config(), registry);

    assert.ok(first.response.accepted);
    const match = first.match!;
    match.attach({});

    const resumed = logon({ ...validRequest, matchSecret: match.secret }, config(), registry);
    assert.equal(resumed.response.accepted, false);
  });

  it("keeps separate Matches for separate group codes", () => {
    const registry = new MatchRegistry();
    const first = logon(validRequest, config(), registry);
    const second = logon({ ...validRequest, groupCode: "group_2" }, config(), registry);

    assert.equal(second.response.accepted, true);
    assert.notEqual(first.match?.secret, second.match?.secret);
  });
});
