export type GroupSeatRole = "host" | "cleaner" | "other";

export interface GroupSeat {
  phone: string;
  name: string;
  role: GroupSeatRole;
  approved: boolean;
  consent: "pending" | "in" | "out";
}

export type CodeRoute = "group" | "private" | "held";

export function codeRoute(seats: readonly GroupSeat[]): CodeRoute {
  const cleaner = seats.find((seat) => seat.role === "cleaner");
  if (!cleaner?.approved || cleaner.consent !== "in") return "held";
  const members = seats.filter((seat) => seat.consent !== "out");
  const group = members.every((seat) => seat.consent === "in" && (seat.role === "host" || (seat.role === "cleaner" && seat.approved)));
  return group ? "group" : "private";
}

export type GroupTurn = "injury" | "stop" | "problem" | "time" | "host" | "cleaner";

export function groupTurn(input: {
  injury: boolean;
  stop: boolean;
  problem: boolean;
  time: boolean;
  role: GroupSeatRole;
}): GroupTurn {
  if (input.injury) return "injury";
  if (input.stop) return "stop";
  if (input.problem) return "problem";
  if (input.time) return "time";
  if (input.role === "host") return "host";
  return "cleaner";
}

export function isProblemText(text: string): boolean {
  return /\b(problem|problems|issue|issues|stuck|broken|locked out)\b/i.test(text);
}
