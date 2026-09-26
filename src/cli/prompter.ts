import { createInterface, type Interface } from "node:readline";

export class InputClosedError extends Error {}

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
export const style = { bold: paint("1"), dim: paint("2"), green: paint("32"), red: paint("31"), cyan: paint("36"), yellow: paint("33") };

export interface Choice<T> {
  label: string;
  hint?: string;
  value: T;
}

/**
 * One-question-at-a-time terminal I/O. Lines are queued, so answers piped in
 * from a file work the same as typed answers.
 */
export class Prompter {
  private readonly rl: Interface;
  private readonly queue: string[] = [];
  private waiting: ((line: string | undefined) => void) | undefined;
  private closed = false;
  readonly interactive = !!process.stdin.isTTY;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: this.interactive });
    this.rl.on("line", (line) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(line);
      } else this.queue.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      this.waiting?.(undefined);
    });
  }

  say(text = ""): void {
    console.log(text);
  }

  async ask(question: string, suggestion?: string): Promise<string> {
    const hint = suggestion ? style.dim(` [${suggestion}]`) : "";
    this.say(`${question}${hint}`);
    this.rl.setPrompt("> ");
    this.rl.prompt();
    const line = await this.nextLine();
    if (!this.interactive) process.stdout.write(`${line}\n`);
    return line.trim() || suggestion || "";
  }

  async askRequired(question: string, suggestion?: string, nudge = "I need an answer to keep going."): Promise<string> {
    for (;;) {
      const answer = await this.ask(question, suggestion);
      if (answer) return answer;
      this.say(style.yellow(nudge));
    }
  }

  /** Re-asks until `parse` returns a value; `problem` explains what went wrong in plain words. */
  async askParsed<T>(question: string, suggestion: string | undefined, parse: (answer: string) => T | undefined, problem: string): Promise<T> {
    for (;;) {
      const value = parse(await this.ask(question, suggestion));
      if (value !== undefined) return value;
      this.say(style.yellow(problem));
    }
  }

  async confirm(question: string, suggestion = true): Promise<boolean> {
    return this.askParsed(
      question,
      suggestion ? "Yes" : "No",
      (a) => (/^(y|yes|yeah|yep|sure|ok|okay)$/i.test(a) ? true : /^(n|no|nope)$/i.test(a) ? false : undefined),
      "Please answer yes or no.",
    );
  }

  async choose<T>(question: string, choices: Choice<T>[], suggestion = 1): Promise<T> {
    this.say(question);
    choices.forEach((c, i) => this.say(`  ${i + 1}. ${c.label}${c.hint ? style.dim(` - ${c.hint}`) : ""}`));
    const pick = await this.askParsed(
      "Pick a number",
      String(suggestion),
      (a) => {
        const n = Number(a);
        return Number.isInteger(n) && n >= 1 && n <= choices.length ? n : undefined;
      },
      `Please pick a number from 1 to ${choices.length}.`,
    );
    return choices[pick - 1]!.value;
  }

  async pause(ms: number): Promise<void> {
    if (this.interactive) await new Promise((r) => setTimeout(r, ms));
  }

  close(): void {
    this.rl.close();
  }

  private nextLine(): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new InputClosedError());
    return new Promise((resolve, reject) => {
      this.waiting = (line) => (line === undefined ? reject(new InputClosedError()) : resolve(line));
    });
  }
}
