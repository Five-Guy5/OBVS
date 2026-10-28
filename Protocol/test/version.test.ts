import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PROTOCOL_VERSION,
  SUPPORTED_INGEST_VERSIONS,
  isSupportedIngestVersion,
} from "../src/index.js";

describe("protocol versioning", () => {
  it("declares the current version as supported", () => {
    assert.ok(SUPPORTED_INGEST_VERSIONS.includes(PROTOCOL_VERSION));
    assert.equal(isSupportedIngestVersion(PROTOCOL_VERSION), true);
  });

  it("rejects versions the server does not declare", () => {
    assert.equal(isSupportedIngestVersion(PROTOCOL_VERSION + 1), false);
    assert.equal(isSupportedIngestVersion(0), false);
  });

  it("supports a contiguous range ending at the current version", () => {
    const versions = [...SUPPORTED_INGEST_VERSIONS];

    for (let index = 1; index < versions.length; index += 1) {
      assert.equal(versions[index], versions[index - 1]! + 1);
    }

    assert.equal(versions.at(-1), PROTOCOL_VERSION);
  });
});
