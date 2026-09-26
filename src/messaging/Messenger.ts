export interface OutgoingMessage {
  to: string;
  audience: "PROSPECT" | "OPERATOR";
  body: string;
}

/** Delivers a text. Tour Core records every message itself; adapters only deliver. */
export interface Messenger {
  readonly channel: string;
  send(message: OutgoingMessage): Promise<void>;
}

export class ConsoleMessenger implements Messenger {
  readonly channel = "console";
  constructor(private readonly log: (line: string) => void = (line) => console.log(line)) {}

  async send(message: OutgoingMessage): Promise<void> {
    const label = message.audience === "OPERATOR" ? "TEXT -> operator" : "TEXT -> prospect";
    this.log(`    [${label} ${message.to}]`);
    for (const line of message.body.split("\n")) this.log(`      ${line}`);
  }
}
