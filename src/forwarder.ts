import type { Ledger } from "./ledger.ts";
import { fingerprint } from "./ledger.ts";
import type { ModemManager, Sms } from "./modem.ts";
import {
  SMS_PDU_TYPE_STATUS_REPORT, SMS_PDU_TYPE_SUBMIT, SMS_STATE_RECEIVED, SMS_STATE_RECEIVING,
} from "./modem.ts";

export type PostFn = (sms: Sms, modemLabel: string) => Promise<void>;

export interface ForwarderOptions {
  deleteAfterForward: boolean;
  forwardExisting: boolean;
}

/** Scans the modems for received SMS and hands new ones to `post`. */
export class Forwarder {
  private running = false;
  private rerun = false;
  private timer: NodeJS.Timeout | undefined;

  private mm: ModemManager;
  private ledger: Ledger;
  private post: PostFn;
  private opts: ForwarderOptions;

  constructor(mm: ModemManager, ledger: Ledger, post: PostFn, opts: ForwarderOptions) {
    this.mm = mm;
    this.ledger = ledger;
    this.post = post;
    this.opts = opts;
  }

  /** Debounced scan: multipart SMS fire several signals in a row. */
  schedule(delayMs = 1500): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scan();
    }, delayMs);
  }

  async scan(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      await this.scanOnce();
    } catch (e) {
      console.warn(`scan failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        void this.scan();
      }
    }
  }

  private async scanOnce(): Promise<void> {
    const seed = this.ledger.fresh && !this.opts.forwardExisting;
    let incomplete = false;

    for (const modem of await this.mm.modems()) {
      const label = `${modem.model} (${modem.ownNumbers.join(", ") || "?"})`;
      for (const path of modem.messages) {
        let sms: Sms;
        try {
          sms = await this.mm.readSms(path);
        } catch {
          continue; // deleted in the meantime
        }
        // Multipart messages stay in RECEIVING until all parts arrive.
        if (sms.state === SMS_STATE_RECEIVING) incomplete = true;
        if (sms.state !== SMS_STATE_RECEIVED) continue;
        if (sms.pduType === SMS_PDU_TYPE_SUBMIT || sms.pduType === SMS_PDU_TYPE_STATUS_REPORT) continue;

        const key = fingerprint(sms);
        if (this.ledger.has(key)) {
          await this.maybeDelete(modem.path, path);
          continue;
        }
        if (seed) {
          console.info(`first run: marking existing ${path} as seen`);
          this.ledger.add(key);
          continue;
        }
        try {
          await this.post(sms, label);
        } catch (e) {
          console.error(`failed to forward ${path}: ${(e as Error).message}`);
          continue;
        }
        console.info(`forwarded ${path} from ${sms.number}`);
        this.ledger.add(key);
        await this.maybeDelete(modem.path, path);
      }
    }

    if (seed) {
      this.ledger.fresh = false;
      this.ledger.save();
    }
    if (incomplete) this.schedule(5000);
  }

  private async maybeDelete(modemPath: string, smsPath: string): Promise<void> {
    if (!this.opts.deleteAfterForward) return;
    try {
      await this.mm.deleteSms(modemPath, smsPath);
      console.info(`deleted ${smsPath} from modem`);
    } catch (e) {
      console.warn(`could not delete ${smsPath}: ${(e as Error).message}`);
    }
  }
}
