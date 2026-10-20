/**
 * Snapshot error classification tests.
 *
 * Covers typed storage/network failures (classified by type) and ambiguous
 * third-party messages (classified by the regex fallback).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SnapshotService } from "./snapshot.service.js";
import { MemorySnapshotAdapter } from "./adapters/memory.adapter.js";
import type { NormalizedEvent } from "../events/types.js";
import { EventType } from "../events/types.js";
import type { ContractSnapshot } from "./types.js";
import {
  isTransientError,
  TransientStorageError,
  PermanentStorageError,
  TransientNetworkError,
  PermanentNetworkError,
} from "./errors.js";

const CONTRACT_ID = "CDUMMYCONTRACT123456789";

test("isTransientError classifies typed errors by disposition, not message", () => {
  // The word "invalid" would win under the old message-based ordering.
  assert.equal(
    isTransientError(new TransientStorageError("invalid socket state")),
    true,
  );
  assert.equal(
    isTransientError(new TransientNetworkError("invalid socket state")),
    true,
  );

  // A permanent error stays permanent even though it mentions transient words.
  assert.equal(
    isTransientError(new PermanentStorageError("lock wait timeout, busy")),
    false,
  );
  assert.equal(
    isTransientError(new PermanentNetworkError("timeout while reading")),
    false,
  );
});

test("isTransientError relaxes/keeps the fallback regexes for third-party errors", () => {
  // `/lock/i` used to match "block"/"clock" — now it requires whole words.
  assert.equal(isTransientError(new Error("block header mismatch")), false);
  assert.equal(isTransientError(new Error("clock skew detected")), false);

  // Genuine contention still matches the fallback.
  assert.equal(isTransientError(new Error("database is locked")), true);
  assert.equal(isTransientError(new Error("write deadlock")), true);
  assert.equal(isTransientError(new Error("connection socket reset")), true);

  // Permanent third-party signals still win over transient words.
  assert.equal(isTransientError(new Error("invalid schema version")), false);
  assert.equal(isTransientError(new Error("constraint violation timeout")), false);
});

class FlakySaveAdapter extends MemorySnapshotAdapter {
  attempts = 0;
  private readonly failure: Error;
  private readonly succeedOnAttempt: number;

  constructor(failure: Error, succeedOnAttempt: number) {
    super();
    this.failure = failure;
    this.succeedOnAttempt = succeedOnAttempt;
  }

  async saveSnapshot(snapshot: ContractSnapshot): Promise<void> {
    this.attempts++;
    if (this.attempts < this.succeedOnAttempt) {
      throw this.failure;
    }
    return super.saveSnapshot(snapshot);
  }
}

function makeSignerAddedEvent(ledger: number): NormalizedEvent {
  return {
    type: EventType.SIGNER_ADDED,
    data: { address: "GADDED", totalSigners: 1 },
    metadata: {
      id: `evt-${ledger}`,
      contractId: CONTRACT_ID,
      ledger,
      ledgerClosedAt: "2026-03-25T12:00:00Z",
    },
  } as NormalizedEvent;
}

test("processEvent retries a transient storage error and eventually succeeds", async () => {
  const adapter = new FlakySaveAdapter(new TransientStorageError("busy"), 3);
  const service = new SnapshotService(adapter);

  const result = await service.processEvent(makeSignerAddedEvent(100));

  assert.equal(result.success, true);
  assert.equal(adapter.attempts, 3);
});

test("processEvent does not retry a permanent storage error", async () => {
  const adapter = new FlakySaveAdapter(
    new PermanentStorageError("invalid schema"),
    Number.MAX_SAFE_INTEGER,
  );
  const service = new SnapshotService(adapter);

  const result = await service.processEvent(makeSignerAddedEvent(101));

  assert.equal(result.success, false);
  assert.equal(adapter.attempts, 1);
});
