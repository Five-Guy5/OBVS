import {
  V1_PROTOCOL_VERSION,
  type LogonRequest,
  type LogonResponse,
} from "../../src/v1/index.js";

export interface LogonExchangeFixture {
  request: LogonRequest;
  accepted: Extract<LogonResponse, { accepted: true }>;
  resume: LogonRequest;
}

/** First logon, its acknowledgement, and the resume frame for the same Match (S.2.1). */
export const logonExchange = {
  request: {
    protocolVersion: V1_PROTOCOL_VERSION,
    groupCode: "obvs-demo",
    observerName: "Fixture Observer",
    clientVersion: "0.1.0",
    authKey: "fixture-auth-key",
  },
  accepted: {
    accepted: true,
    matchSecret: "fixture-match-secret",
    capabilities: {
      gep: true,
      cv: { enabled: false, modelsLoaded: false },
      fields: { map: "gep" },
    },
  },
  resume: {
    protocolVersion: V1_PROTOCOL_VERSION,
    groupCode: "obvs-demo",
    observerName: "Fixture Observer",
    clientVersion: "0.1.0",
    authKey: "fixture-auth-key",
    matchSecret: "fixture-match-secret",
  },
} satisfies LogonExchangeFixture;
