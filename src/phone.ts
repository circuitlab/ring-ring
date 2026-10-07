import { EventEmitter } from "node:events";
import type { AtPort } from "./at.ts";

// RING repeats every ~3 s while the phone rings; if it stops without a
// MISSED_CALL report, assume the caller gave up.
const RING_TIMEOUT_MS = 8000;
// Give up on an outgoing call nobody picks up.
const DIAL_TIMEOUT_MS = 60_000;

export type PhoneState = "idle" | "ringing" | "dialing" | "active";

/** Why an unanswered call ended: no answer, busy line, or other failure. */
export type EndReason = "normal" | "no-answer" | "busy";

export interface EndInfo {
  answered: boolean;
  durationSec: number;
  reason: EndReason;
}

export interface PhoneEvents {
  incoming: [number: string];
  answered: [];
  ended: [info: EndInfo];
}

/**
 * Voice call state machine driven by the modem's AT port (SIM7600 URCs).
 *
 * Emits "incoming" (number) when a call starts ringing, "answered" once an
 * incoming call is answered or an outgoing call is picked up, and "ended"
 * when it is over.
 */
export class Phone extends EventEmitter<PhoneEvents> {
  state: PhoneState = "idle";
  number = "";
  private at: AtPort;
  private ringTimer: NodeJS.Timeout | undefined;
  private dialTimer: NodeJS.Timeout | undefined;
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
    } else if (line.startsWith("VOICE CALL: BEGIN") && this.state === "dialing") {
      clearTimeout(this.dialTimer);
      this.state = "active";
      this.startedAt = Date.now();
      this.emit("answered");
    } else if (line === "BUSY" && this.state === "dialing") {
      this.end("busy");
    } else if (line === "NO ANSWER" && this.state === "dialing") {
      this.end("no-answer");
    } else if ((line.startsWith("VOICE CALL: END") || line === "NO CARRIER") && this.state !== "idle") {
      this.end();
    }
  }

  private async onRing(): Promise<void> {
    // Only one call at a time; a second call keeps ringing on its own.
    if (this.state === "active" || this.state === "dialing") return;
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

  /** Places an outgoing voice call; "answered" fires when the callee picks up. */
  async dial(number: string): Promise<void> {
    if (this.state !== "idle") throw new Error("the line is busy");
    this.state = "dialing";
    this.number = number;
    this.dialTimer = setTimeout(() => {
      if (this.state !== "dialing") return;
      console.info("outgoing call not answered in time, hanging up");
      this.at.command("AT+CHUP", 10_000).catch(() => {}).finally(() => this.state === "dialing" && this.end("no-answer"));
    }, DIAL_TIMEOUT_MS);
    try {
      // The trailing ';' makes it a voice call.
      await this.at.command(`ATD${number};`, 10_000);
    } catch (e) {
      if (this.state !== "dialing") throw e;
      const message = (e as Error).message;
      // A busy or unreachable callee is an outcome, not a failure.
      if (/BUSY/.test(message)) return this.end("busy");
      if (/NO ANSWER|NO CARRIER/.test(message)) return this.end("no-answer");
      // Left in "dialing": the caller reports the failure and hangs up, which ends the call.
      throw e;
    }
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

  private end(reason: EndReason = "normal"): void {
    clearTimeout(this.ringTimer);
    clearTimeout(this.dialTimer);
    const answered = this.state === "active";
    const durationSec = answered ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    this.state = "idle";
    this.emit("ended", { answered, durationSec, reason });
  }
}
