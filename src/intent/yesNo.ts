/**
 * Shared YES/NO reading used at consent, follow-up, tour confirmations,
 * and a pending next-opening offer. Visitors do not use one exact phrase.
 */

const YES_EXACT = /^(y|yes|yeah|yea|yeh|ya|yah|yep|yup|ye|yass|yes please|sure|ok|okay|k|kk|affirmative|correct|absolutely|definitely|certainly|of course)$/;
const NO_EXACT = /^(n|no|nope|nah|no thanks|no thank you)$/;
const YES_LEAD =
  /^(yes|y|yeah|yea|yeh|ya|yah|yep|yup|yass|sure|ok|okay|fine|absolutely|definitely|certainly|of course|course|agreed|i agree|agree|i consent|consent|i accept|accept|go ahead|go for it|do it|sounds (good|great|fine)|that works|works for me|that is (fine|ok|okay|good|great|perfect)|that would be (great|good|nice|helpful|awesome|perfect|lovely|fine)|that would help|would be (great|good|nice|helpful)|please|please do|i would (like|love|appreciate) (that|it)|would love (that|it)|perfect|great|awesome|cool|alright|all right|correct|affirmative|you bet|for sure|totally|no problem|no worries|not a problem|have (someone|somebody|them|the team) (reach out|call|text|contact|follow up|get in touch|get back)|(someone|somebody) (can|could|should) (reach out|call|text|contact|follow up)|(please )?(reach out|follow up|contact me|get in touch)|i am in|count me in)\b/;
const NO_LEAD =
  /^(no|n|nope|nah|na|no thanks|no thank you|not (right )?now|not right|not really|not interested|no need|nothing|never mind|nevermind|i do not|(please )?do not|i decline|decline|rather not|i would rather not|maybe later|not today|no way|i will pass|pass)\b/;
const SOFT_NO = /^(i am good|i am ok|i am okay|i am fine|all good|i am all set|we are good|we are all set)\b/;
const NOT_NEGATIVE = /\b(no problem|no worries|not a problem)\b/g;
const HEDGE = /\b(but|only|unless|except|maybe|not sure|i guess|kinda|kind of|depends|what if|if)\b/;
const NEGATION = /\b(no|not|nope|nah|never|without|rather not|stop|cancel|decline|refuse|unsubscribe)\b/;

/** Bare "that" after an offered slot, plus "I'll take it" which is not a general yes. */
const THAT_OPENING = /^(that|that one|that day|that time|that works|yes that|yes that one|yeah that)$/;
const TAKE_OPENING = /^(i will take (it|that|that one)|we will take (it|that|that one)|take (it|that|that one))$/;

export interface YesNo {
  answer?: "yes" | "no";
  confidence: number;
  soft?: boolean;
}

export function yesNo(t: string): YesNo {
  if (YES_EXACT.test(t)) return { answer: "yes", confidence: 1 };
  if (NO_EXACT.test(t)) return { answer: "no", confidence: 1 };
  if (SOFT_NO.test(t)) return { answer: "no", confidence: 0.8, soft: true };
  if (NO_LEAD.test(t) && !/^(no problem|no worries|not a problem)\b/.test(t)) {
    const rest = t.replace(NO_LEAD, "").trim();
    return YES_LEAD.test(rest) && !/^(thanks|thank you)/.test(rest) ? { confidence: 0.3 } : { answer: "no", confidence: 0.9 };
  }
  if (YES_LEAD.test(t)) {
    const rest = t.replace(YES_LEAD, "").replace(NOT_NEGATIVE, "").trim();
    if (NEGATION.test(rest)) return { confidence: 0.3 };
    if (HEDGE.test(rest)) return { answer: "yes", confidence: 0.6 };
    return { answer: "yes", confidence: 0.9 };
  }
  return { confidence: 0 };
}

/** Same bar as other yes/no steps: a clear yes, not a hedged or mixed reply. */
export function isFlexibleYes(t: string): boolean {
  const yn = yesNo(t);
  return yn.answer === "yes" && yn.confidence >= 0.75;
}

/**
 * A pending next-opening offer: flexible yes, "that", or "I'll take it".
 * `t` is already normalized and filler-stripped.
 */
export function acceptsNextOpening(t: string): boolean {
  return THAT_OPENING.test(t) || TAKE_OPENING.test(t) || isFlexibleYes(t);
}
