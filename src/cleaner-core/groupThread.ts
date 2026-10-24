export type GroupSeatRole = "host" | "cleaner" | "other";

export interface GroupSeat {
  phone: string;
  name: string;
  role: GroupSeatRole;
  approved: boolean;
  consent: "pending" | "in" | "out";
}

export type CodeRoute = "private" | "held";

/** A phone Twilio answered with an error when it was added to the group, and Twilio's code and message. */
export interface RefusedPhone {
  phone: string;
  code?: number;
  message?: string;
}

export class GroupNotConfirmed extends Error {
  readonly conversationSid: string | undefined;
  /** Set when Twilio refused one of the phones. */
  readonly refused: RefusedPhone | undefined;

  constructor(conversationSid?: string, refused?: RefusedPhone) {
    super("not sent");
    this.name = "GroupNotConfirmed";
    this.conversationSid = conversationSid;
    this.refused = refused;
  }
}

export function codeRoute(seats: readonly GroupSeat[]): CodeRoute {
  const cleaner = seats.find((seat) => seat.role === "cleaner");
  if (!cleaner?.approved || cleaner.consent !== "in") return "held";
  return "private";
}
