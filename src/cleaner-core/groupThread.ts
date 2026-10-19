export type GroupSeatRole = "host" | "cleaner" | "other";

export interface GroupSeat {
  phone: string;
  name: string;
  role: GroupSeatRole;
  approved: boolean;
  consent: "pending" | "in" | "out";
}

export type CodeRoute = "private" | "held";

export class GroupNotConfirmed extends Error {
  readonly conversationSid: string | undefined;

  constructor(conversationSid?: string) {
    super("not sent");
    this.name = "GroupNotConfirmed";
    this.conversationSid = conversationSid;
  }
}

export function codeRoute(seats: readonly GroupSeat[]): CodeRoute {
  const cleaner = seats.find((seat) => seat.role === "cleaner");
  if (!cleaner?.approved || cleaner.consent !== "in") return "held";
  return "private";
}
