import { EventEmitter } from "node:events";
import type { AtPort } from "./at.ts";

// RING repeats every ~3 s while the phone rings; if it stops without a
// MISSED_CALL report, assume the caller gave up.
const RING_TIMEOUT_MS = 8000;

export type PhoneState = "idle" | "ringing" | "active";

export interface PhoneEvents {
  incoming: [number: string];
  answered: [];
  ended: [info: { answered: boolean; durationSec: number }];
}

/**
 * Voice call state machine driven by the modem's AT port (SIM7600 URCs).
 *
 * Emits "incoming" (number) when a call starts ringing, "answered" once
 * answered, and "ended" ({ answered, durationSec }) when it is over.
 */
export class Phone extends EventEmitter<PhoneEvents> {
  state: PhoneState = "idle";
  number = "";
  private at: AtPort;
  private ringTimer: NodeJS.Timeout | undefined;
  private startedAt = 0;

  constructor(at: AtPort) {
    super();
    this.at = at;
    at.on("urc", (line: string) => this.onUrc(line));
  }

  async init(): Promise<void> {
    await this.at.command("ATE0");
  }

  private onUrc(line: string): void {
    if (line === "RING") {
      this.onRing().catch((e) => console.warn(`RING handling failed: ${(e as Error).message}`));
    } else if (line.startsWith("MISSED_CALL:") && this.state === "ringing") {
      this.end();
    } else if ((line.startsWith("VOICE CALL: END") || line === "NO CARRIER") && this.state !== "idle") {
      this.end();
    }
  }

  private async onRing(): Promise<void> {
    if (this.state === "active") return;
    clearTimeout(this.ringTimer);
    this.ringTimer = setTimeout(() => this.state === "ringing" && this.end(), RING_TIMEOUT_MS);
    if (this.state === "ringing") return;

    this.state = "ringing";
    this.number = "";
    try {
      // +CLCC: <id>,<dir>,<stat>,<mode>,<mpty>,"<number>",<type>
      for (const l of await this.at.command("AT+CLCC")) {
        const m = l.match(/^\+CLCC: \d+,1,\d+,0,\d+,"([^"]*)"/);
        if (m) this.number = m[1];
      }
    } catch (e) {
      console.warn(`AT+CLCC failed: ${(e as Error).message}`);
    }
    this.emit("incoming", this.number);
  }

  async answer(): Promise<void> {
    if (this.state !== "ringing") throw new Error("no ringing call");
    // ATA may return OK before the call is actually connected ("VOICE CALL: BEGIN").
    const begun = this.waitForUrc((l) => l.startsWith("VOICE CALL: BEGIN"), 5000);
    await this.at.command("ATA", 10_000);
    clearTimeout(this.ringTimer);
    if (!(await begun)) console.warn("no VOICE CALL: BEGIN after ATA, continuing anyway");
    this.state = "active";
    this.startedAt = Date.now();
    this.emit("answered");
  }

  /**
   * Routes call audio to the USB audio port (8 kHz 16-bit mono PCM).
   * The modem rejects this until the call is fully up, so retry for a while.
   */
  async enableUsbAudio(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.at.command("AT+CPCMREG=1", 10_000);
        return;
      } catch (e) {
        if (attempt >= 10 || this.state !== "active") throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  private waitForUrc(match: (line: string) => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const onUrc = (line: string) => {
        if (!match(line)) return;
        clearTimeout(timer);
        this.at.off("urc", onUrc);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.at.off("urc", onUrc);
        resolve(false);
      }, timeoutMs);
      this.at.on("urc", onUrc);
    });
  }

  async hangup(): Promise<void> {
    if (this.state === "idle") return;
    try {
      await this.at.command("AT+CHUP", 10_000);
    } finally {
      // "VOICE CALL: END" may or may not be reported for a rejected call.
      // State may have changed via a URC while awaiting.
      if ((this.state as PhoneState) !== "idle") this.end();
    }
  }

  private end(): void {
    clearTimeout(this.ringTimer);
    const answered = this.state === "active";
    const durationSec = answered ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    this.state = "idle";
    this.emit("ended", { answered, durationSec });
  }
}
