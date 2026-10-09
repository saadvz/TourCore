// QA posts new cases in the room and the agent adds them here.
export interface RoomQuestion {
  question: string;
  expected: "answered" | "held";
  source: string;
}

/**
 * Room and unit questions from the repo's tests, including #70.
 * `answered` is a saved bedroom or bathroom count. `held` is passed to the landlord.
 */
export const ROOM_QUESTIONS: RoomQuestion[] = [
  { question: "How many bedrooms?", expected: "answered", source: "earlier" },
  { question: "how many bedrooms?", expected: "answered", source: "earlier" },
  { question: "How many bathrooms?", expected: "answered", source: "visitor safety" },
  { question: "How many bathrooms does it have?", expected: "answered", source: "earlier" },
  { question: "How many bedrooms does 1A have?", expected: "answered", source: "earlier" },
  { question: "How many bedrooms is this?", expected: "answered", source: "earlier" },
  { question: "I have a question. How many bedrooms are in the unit?", expected: "answered", source: "earlier" },
  { question: "Sorry, how many bedrooms again?", expected: "answered", source: "earlier" },
  { question: "How many bedrooms are in unit 101?", expected: "answered", source: "earlier" },
  { question: "How big is the bedroom", expected: "held", source: "visitor safety" },
  { question: "What size is the bedroom", expected: "held", source: "room size" },
  { question: "Does the bedroom have a closet?", expected: "held", source: "visitor safety" },
  { question: "Do the bedrooms have windows?", expected: "held", source: "visitor safety" },
  { question: "Is the master bedroom carpeted?", expected: "held", source: "visitor safety" },
  { question: "Is the bathroom updated?", expected: "held", source: "visitor safety" },
  { question: "is there a bathroom in the bedroom", expected: "held", source: "visitor safety" },
  { question: "Does the bedroom have a washer?", expected: "held", source: "visitor safety" },
  { question: "Can I paint the bedroom walls?", expected: "held", source: "visitor safety" },
  { question: "Can I smoke in the bedroom?", expected: "held", source: "visitor safety" },
  { question: "Can my pets stay in the bedroom?", expected: "held", source: "visitor safety" },
  { question: "How big is 2B?", expected: "held", source: "earlier" },
];
