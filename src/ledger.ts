import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sms } from "./modem.ts";

const SEEN_LIMIT = 2000;

/** Fingerprint of an SMS. Must stay compatible with ledgers written by v1 (Python). */
export function fingerprint(sms: Sms): string {
  const h = createHash("sha256");
  for (const part of [sms.number, sms.timestamp, sms.text, sms.data.toString("hex")]) {
    h.update(part, "utf8");
    h.update("\0");
  }
  return h.digest("hex");
}

/** Persistent set of SMS fingerprints that have already been forwarded. */
export class Ledger {
  readonly path: string;
  /** True until the first scan has seeded the ledger. */
  fresh: boolean;
  private seen: string[] = [];
  private set = new Set<string>();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, "seen.json");
    this.fresh = !existsSync(this.path);
    if (!this.fresh) {
      this.seen = JSON.parse(readFileSync(this.path, "utf8"));
      this.set = new Set(this.seen);
    }
  }

  has(key: string): boolean {
    return this.set.has(key);
  }

  add(key: string): void {
    if (this.set.has(key)) return;
    this.seen.push(key);
    this.set.add(key);
    if (this.seen.length > SEEN_LIMIT) {
      for (const dropped of this.seen.splice(0, this.seen.length - SEEN_LIMIT)) {
        this.set.delete(dropped);
      }
    }
    this.save();
  }

  save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.seen));
    renameSync(tmp, this.path);
  }
}
