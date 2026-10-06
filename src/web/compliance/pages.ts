import { COMPLIANCE_PATHS, DEFAULT_PUBLIC_BRAND_NAME, type CompliancePageId, type PublicComplianceConfig } from "./config";

export const PRIVACY_NON_SHARING =
  "We do not sell or share your SMS opt-in data or personal information with third parties for marketing purposes.";

export const MESSAGE_RATES = "Message and data rates may apply.";

export const CARRIERS_NOT_LIABLE = "Carriers are not liable for any delayed or undelivered messages.";

export const LAST_UPDATED = "October 2, 2026";

function pageTitle(id: CompliancePageId, config: PublicComplianceConfig): string {
  switch (id) {
    case "privacy":
      return `${config.brandName} Privacy Policy`;
    case "terms":
      return `${config.brandName} Terms & Conditions`;
    case "sms":
      return `${config.brandName} SMS Messaging`;
  }
}

function pageDescription(id: CompliancePageId, config: PublicComplianceConfig): string {
  const brand = config.brandName;
  const legal = config.legalName;
  switch (id) {
    case "privacy":
      return legal
        ? `Privacy Policy for ${brand}, the self-guided property tour service operated by ${legal}.`
        : `Privacy Policy for ${brand}, a self-guided property tour service.`;
    case "terms":
      return legal
        ? `Terms and Conditions for ${brand}, operated by ${legal}, including SMS messaging terms.`
        : `Terms and Conditions for ${brand}, including SMS messaging terms.`;
    case "sms":
      return `How a prospective renter opts in to ${brand} text messages for a self-guided property tour.`;
  }
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function link(href: string, label: string): string {
  return `<a href="${esc(href)}">${esc(label)}</a>`;
}

/** The first program text after someone messages the keyword TOUR. */
export function campaignDisclosure(privacyUrl: string, termsUrl: string, brand = DEFAULT_PUBLIC_BRAND_NAME): string {
  return [
    `${brand}: You're starting a text conversation about a self-guided property tour.`,
    "",
    `Message frequency varies. ${MESSAGE_RATES}`,
    "",
    "Reply YES to continue, HELP for help, or STOP to opt out.",
    "",
    `Privacy: ${privacyUrl}`,
    `Terms: ${termsUrl}`,
  ].join("\n");
}

export function campaignConfirmation(brand = DEFAULT_PUBLIC_BRAND_NAME): string {
  return [
    `${brand}: You're opted in. I can answer questions about the property and help you schedule and complete a self-guided tour.`,
    "I'll keep a record of your visit times and the doors you use.",
    "",
    "Reply STOP at any time to opt out.",
  ].join("\n");
}

function missingUrlLabel(config: PublicComplianceConfig): string {
  return config.development ? "PUBLIC_BASE_URL is not configured" : "Public URL is not configured";
}

function disclosureFor(config: PublicComplianceConfig): string {
  return campaignDisclosure(config.privacyUrl ?? missingUrlLabel(config), config.termsUrl ?? missingUrlLabel(config), config.brandName);
}

function numberNotice(config: PublicComplianceConfig): string {
  if (config.smsNumber) return "";
  if (config.development) {
    const why = config.smsNumberProblem === "invalid" ? "is not a valid phone number" : "is not set";
      return `<p class="notice" role="status"><strong>Configuration needed.</strong> TOURCORE_PUBLIC_SMS_NUMBER ${why}. This page will show the public ${esc(config.brandName)} number once that value is a valid phone number. No number is invented here.</p>`;
  }
  return `<p class="notice" role="status">The public ${esc(config.brandName)} phone number is not configured.</p>`;
}

function emailNotice(config: PublicComplianceConfig): string {
  if (config.contactEmail) return "";
  if (config.development) {
    const why = config.contactEmailProblem === "invalid" ? "is not a valid email address" : "is not set";
    return `<p class="notice" role="status"><strong>Configuration needed.</strong> TOURCORE_PUBLIC_CONTACT_EMAIL ${why}. Add the support address for this deployment. This page will not invent one.</p>`;
  }
  return `<p class="notice" role="status">A public contact email is not configured.</p>`;
}

function legalNotice(config: PublicComplianceConfig): string {
  if (config.legalName) return "";
  if (config.development) {
    return `<p class="notice" role="status"><strong>Configuration needed.</strong> TOURCORE_PUBLIC_LEGAL_NAME is not set. This page will not invent a legal entity.</p>`;
  }
  return `<p class="notice" role="status">The public legal operator name is not configured.</p>`;
}

function operatorStatement(config: PublicComplianceConfig): string {
  if (!config.legalName) return legalNotice(config);
  return `<p>${esc(config.brandName)} is operated by ${esc(config.legalName)}.</p>`;
}

function contactBlock(config: PublicComplianceConfig): string {
  const email = config.contactEmail
    ? `<p>Email ${link(`mailto:${config.contactEmail}`, config.contactEmail)}.</p>`
    : emailNotice(config);
  const who = config.legalName ? `${esc(config.brandName)}, operated by ${esc(config.legalName)}` : esc(config.brandName);
  return `<section><h2>Contact</h2><p>Questions about ${who} can be sent to:</p>${email}</section>`;
}

function actor(config: PublicComplianceConfig): string {
  return esc(config.legalName ?? config.brandName);
}

function urlNotice(config: PublicComplianceConfig): string {
  if (config.publicBaseUrl) return "";
  if (config.development) {
    return `<p class="notice" role="status"><strong>Configuration needed.</strong> PUBLIC_BASE_URL is not set, so this page cannot yet show absolute Privacy Policy and Terms links inside the sample text. The links on this page still use the ${esc(config.brandName)} paths.</p>`;
  }
  return `<p class="notice" role="status">Absolute Privacy Policy and Terms links are not configured.</p>`;
}

function shell(id: CompliancePageId, config: PublicComplianceConfig, body: string): string {
  const canonical = config.publicBaseUrl ? `<link rel="canonical" href="${esc(absolute(config, COMPLIANCE_PATHS[id]))}">` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(pageTitle(id, config))}</title>
  <meta name="description" content="${esc(pageDescription(id, config))}">
  ${canonical}
  <link rel="stylesheet" href="/styles.css">
  <style>
    .compliance-nav { display: flex; flex-wrap: wrap; gap: 14px; }
    .compliance-nav a { color: var(--accent); font-weight: 600; text-decoration: none; }
    .compliance-nav a:hover, .compliance-nav a[aria-current="page"] { text-decoration: underline; }
    .compliance main { max-width: 760px; }
    .compliance h1 { line-height: 1.2; }
    .compliance section h2 { scroll-margin-top: 12px; }
    .compliance ul, .compliance ol { margin: 0.4em 0 0.8em; padding-left: 1.25em; }
    .compliance li { margin: 0.35em 0; }
    .cta-line { font-size: 1.2rem; font-weight: 650; line-height: 1.35; margin: 0 0 0.6em; }
    .rates { margin: 0; }
    .doc-links { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 14px; font-weight: 600; }
    .phone-mock { max-width: 400px; margin: 8px auto 0; background: #fff; border: 1px solid var(--line); border-radius: 28px; box-shadow: 0 10px 30px rgba(0,0,0,.08); padding: 18px 14px 20px; }
    .phone-mock header { text-align: center; padding-bottom: 10px; border-bottom: 1px solid var(--line); margin-bottom: 8px; }
    .phone-mock header strong { display: block; }
    .bubble .who { display: block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; margin-bottom: 4px; }
    .from-tourcore .who { color: var(--muted); }
    .from-visitor .who { color: rgba(255,255,255,.85); }
    .bubble { overflow-wrap: anywhere; }
    @media (max-width: 640px) {
      .compliance .topbar { flex-direction: column; align-items: flex-start; gap: 8px; }
      .compliance .brand { flex-shrink: 0; }
      .phone-mock { border-radius: 18px; }
      .compliance-nav { gap: 12px 16px; }
    }
  </style>
</head>
<body class="compliance">
  <header class="topbar">
    <a class="brand" href="${COMPLIANCE_PATHS.sms}">${esc(config.brandName)}</a>
    <nav class="compliance-nav" aria-label="${esc(config.brandName)} policies">
      <a href="${COMPLIANCE_PATHS.privacy}"${id === "privacy" ? ' aria-current="page"' : ""}>Privacy Policy</a>
      <a href="${COMPLIANCE_PATHS.terms}"${id === "terms" ? ' aria-current="page"' : ""}>Terms &amp; Conditions</a>
      <a href="${COMPLIANCE_PATHS.sms}"${id === "sms" ? ' aria-current="page"' : ""}>SMS</a>
    </nav>
  </header>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

function absolute(config: PublicComplianceConfig, path: string): string {
  return config.publicBaseUrl ? `${config.publicBaseUrl}${path}` : path;
}

function privacyPage(config: PublicComplianceConfig): string {
  const name = esc(config.brandName);
  const lead = config.legalName
    ? `${name}, operated by ${esc(config.legalName)}, provides AI-assisted self-guided property tours. This policy describes information ${name} may collect and how that information is used.`
    : `${name} provides AI-assisted self-guided property tours. This policy describes information ${name} may collect and how that information is used.`;
  return shell(
    "privacy",
    config,
    `<h1>Privacy Policy</h1>
    <p class="lead">${lead}</p>
    ${operatorStatement(config)}
    <p class="muted">Last updated ${LAST_UPDATED}.</p>
    <section>
      <h2>Information We Collect</h2>
      <p>Depending on how you use ${name}, we may collect:</p>
      <ul>
        <li>Your phone number</li>
        <li>Your legal name, when you provide it</li>
        <li>Your email address, when you provide it</li>
        <li>The property or tourable space you ask about or select</li>
        <li>Reservation and scheduling information, including requested, confirmed, or changed tour times</li>
        <li>Consent records, including whether you agreed to receive messages and to a record of the visit</li>
        <li>Identity-verification status or results where a property asks ${name} to collect them. ${name} records what you submit, such as the name, email, and phone on a form, and whether that step passed or failed. ${name} does not collect biometric identifiers, government ID images, or background-check reports.</li>
        <li>Messages and questions you send to ${name}</li>
        <li>Tour activity, such as booking, arrival, progress through the tour, and completion</li>
        <li>Property-access and audit events related to a tour, such as an access request and whether it was allowed, denied, or revoked</li>
      </ul>
      <p>${name} does not continuously track your precise location. Saying that you have arrived, or that you are at a stop, is a message you choose to send.</p>
    </section>
    <section>
      <h2>How We Use Information</h2>
      <p>${config.legalName ? `${name}, operated by ${esc(config.legalName)},` : name} uses this information to:</p>
      <ul>
        <li>Provide and coordinate self-guided property tours</li>
        <li>Answer property questions</li>
        <li>Provide tour availability</li>
        <li>Schedule or change tours</li>
        <li>Send booking and tour-related SMS</li>
        <li>Verify visitors where a property has configured that step</li>
        <li>Operate access-control policy</li>
        <li>Handle support and exceptions</li>
        <li>Maintain security and audit records</li>
        <li>Improve reliability of the service where appropriate</li>
      </ul>
    </section>
    <section>
      <h2>SMS Messaging</h2>
      <p>${name} text messages are transactional and conversational. They relate to property information and self-guided property tours. Message frequency varies. ${MESSAGE_RATES}</p>
      <p>Reply STOP to opt out. Reply HELP for help. Opting out may prevent ${name} from completing an SMS-based self-guided tour experience.</p>
      <p>${PRIVACY_NON_SHARING}</p>
      <p>Consent to these tour messages is not consent to unrelated marketing.</p>
    </section>
    <section>
      <h2>Service Providers</h2>
      <p>Service providers may process information only as needed to operate ${name}. That can include messaging providers, hosting providers, storage providers, property-access providers, and identity or verification providers where a property has configured one.</p>
      <p>Processing by those providers so ${name} can function is not a sale or share of your information for marketing.</p>
    </section>
    <section>
      <h2>Data Retention</h2>
      <p>${name} retains information only as long as reasonably necessary for the service, security, legal, and operational purposes described in this policy. ${name} does not publish a single deletion deadline, because different records are kept for different operational reasons.</p>
    </section>
    <section>
      <h2>Security</h2>
      <p>${actor(config)} uses reasonable administrative and technical measures intended to protect ${name} information. No method of storage or transmission is perfectly secure, and ${name} does not guarantee that information cannot be accessed, disclosed, or lost.</p>
    </section>
    <section>
      <h2>Your Choices</h2>
      <p>You can choose not to text ${name}. If you have started a text conversation, reply STOP to opt out of SMS and HELP for help. Opting out may prevent ${name} from completing an SMS-based self-guided tour experience.</p>
      <p>${name} does not offer a self-serve deletion portal. You may contact us with a question about information associated with your tour.</p>
    </section>
    <section>
      <h2>Changes to This Policy</h2>
      <p>${actor(config)} may update this policy as ${name} changes. The revised policy will be posted on this page with a new date.</p>
    </section>
    ${contactBlock(config)}
    <section>
      <h2>Last Updated</h2>
      <p>${LAST_UPDATED}</p>
    </section>`,
  );
}

function termsPage(config: PublicComplianceConfig): string {
  const name = esc(config.brandName);
  const lead = config.legalName
    ? `These terms cover use of ${name}, operated by ${esc(config.legalName)}. ${esc(config.legalName)}, operating ${name}, provides the service described here.`
    : `These terms cover use of ${name}. ${name} provides the service described here.`;
  return shell(
    "terms",
    config,
    `<h1>Terms & Conditions</h1>
    <p class="lead">${lead}</p>
    ${operatorStatement(config)}
    <p class="muted">Last updated ${LAST_UPDATED}.</p>
    <section>
      <h2>About ${name}</h2>
      <p>${name} facilitates AI-assisted self-guided property tours. Participating landlords and property operators provide property information. ${name} helps visitors communicate, schedule, and complete tours.</p>
    </section>
    <section>
      <h2>Eligibility / Acceptable Use</h2>
      <p>Use ${name} for a genuine property-tour inquiry. Do not use it to interfere with a property, attempt to obtain access you were not given, impersonate another person, or send unlawful or abusive messages.</p>
    </section>
    <section>
      <h2>Property Information</h2>
      <p>Property details, availability, and tour instructions come from the participating property operator and from what you tell ${name}. ${name} answers from that information. It may be incomplete or change.</p>
    </section>
    <section>
      <h2>Tour Scheduling</h2>
      <p>Tour availability is not guaranteed. A requested time is a request. Not every requested tour time will necessarily be approved or remain available.</p>
    </section>
    <section>
      <h2>Visitor Responsibilities</h2>
      <p>Follow the instructions ${name} and the property give you, provide accurate information when a step asks for it, and treat the property and other people with ordinary care. Leave when your tour is over or if you are asked to.</p>
    </section>
    <section>
      <h2>Access and Security</h2>
      <p>Access requests are subject to ${name} policy and the property's configuration. Not every requested access will necessarily be approved. ${name} does not promise that a particular door, lock, or entry point will open, or that ${name} directly controls the physical property.</p>
    </section>
    <section>
      <h2>SMS Terms</h2>
      <p>Users receive transactional and conversational SMS related to property information and self-guided property tours. Message frequency varies. ${MESSAGE_RATES}</p>
      <p>${CARRIERS_NOT_LIABLE}</p>
      <p>Reply STOP to opt out. Reply HELP for help. SMS consent is not consent to unrelated marketing. Opting out may prevent ${name} from completing an SMS-based self-guided tour experience.</p>
      <p>For customer support, reply HELP${config.contactEmail ? ` or email ${link(`mailto:${config.contactEmail}`, config.contactEmail)}` : ""}. See the ${link(COMPLIANCE_PATHS.privacy, "Privacy Policy")} and the ${link(COMPLIANCE_PATHS.sms, "SMS opt-in page")}.</p>
    </section>
    <section>
      <h2>Service Availability</h2>
      <p>${name} may be unavailable, delayed, or incomplete. A conversation, a booking, or an access step can fail and need a person at the property to help. ${name} is not promising uninterrupted service.</p>
    </section>
    <section>
      <h2>Limitations</h2>
      <p>${name} is a tool for coordinating self-guided property tours. ${actor(config)} does not guarantee that a tour will be available, that an access request will succeed, or that property information is complete.</p>
    </section>
    <section>
      <h2>Changes to Terms</h2>
      <p>${actor(config)} may update these terms. The revised terms will be posted on this page with a new date. Continuing to text ${name} after an update means you are using the service as then described on this page.</p>
    </section>
    ${contactBlock(config)}
    <section>
      <h2>Last Updated</h2>
      <p>${LAST_UPDATED}</p>
    </section>`,
  );
}

function smsCallToAction(config: PublicComplianceConfig): string {
  if (config.smsNumber) {
    return `Text TOUR to ${config.smsNumber.display} to ask questions or schedule a self-guided tour.`;
  }
  if (config.development) {
    return "Text TOUR to [TOUR CORE NUMBER] to ask questions or schedule a self-guided tour.";
  }
  return `Text TOUR to the ${config.brandName} phone number shown on the property to ask questions or schedule a self-guided tour.`;
}

function smsPage(config: PublicComplianceConfig): string {
  const name = esc(config.brandName);
  const lead = config.legalName
    ? `${name}, operated by ${esc(config.legalName)}, uses text messages to help prospective renters ask about a property and complete a self-guided tour.`
    : `${name} uses text messages to help prospective renters ask about a property and complete a self-guided tour.`;
  const numberAttr = config.smsNumber ? ` data-sms-number="${esc(config.smsNumber.canonical)}"` : "";
  const privacyHref = COMPLIANCE_PATHS.privacy;
  const termsHref = COMPLIANCE_PATHS.terms;
  const legalLine = config.legalName ? `<span class="muted">${esc(config.legalName)}</span>` : "";
  return shell(
    "sms",
    config,
    `<h1>${name} SMS</h1>
    <p class="lead">${lead}</p>
    ${operatorStatement(config)}
    ${numberNotice(config)}
    ${urlNotice(config)}
    <section class="card highlight"${numberAttr}>
      <p class="cta-line">${esc(smsCallToAction(config))}</p>
      <p class="rates">Message frequency varies. ${MESSAGE_RATES} Reply HELP for help or STOP to opt out.</p>
      <p class="doc-links">${link(privacyHref, "Privacy Policy")} ${link(termsHref, "Terms & Conditions")}</p>
    </section>
    <section>
      <h2>How you opt in</h2>
      <ol class="flow">
        <li>A prospective renter sees the ${name} phone number on a participating property listing, property website, property sign, QR code, or similar property-tour call-to-action.</li>
        <li>The prospective renter voluntarily texts TOUR to the displayed ${name} number.</li>
        <li>${name} replies with the required messaging disclosure and asks the user to confirm.</li>
        <li>The user replies YES.</li>
        <li>After YES, ${name} may assist with property questions, tour availability, scheduling, rescheduling, identity and consent steps, arrival guidance, access instructions, in-tour questions, and transactional follow-up.</li>
        <li>Replying STOP ends SMS messaging. Opting out may prevent ${name} from completing an SMS-based self-guided tour experience.</li>
      </ol>
      <p>These messages are transactional and conversational. SMS consent is not consent to unrelated marketing.</p>
    </section>
    <section>
      <h2>Example conversation</h2>
      <div class="phone-mock">
        <header>
          <strong>${name}</strong>
          ${legalLine}
        </header>
        <div class="thread" aria-label="Example ${name} text conversation">
          <div class="bubble from-visitor"><span class="who">USER</span>TOUR</div>
          <div class="bubble from-tourcore"><span class="who">${name}</span>${esc(disclosureFor(config))}</div>
          <div class="bubble from-visitor"><span class="who">USER</span>YES</div>
          <div class="bubble from-tourcore"><span class="who">${name}</span>${esc(campaignConfirmation(config.brandName))}</div>
        </div>
      </div>
    </section>
    <section>
      <h2>Help and opt-out</h2>
      <p>Reply HELP for help. Reply STOP to opt out. Message frequency varies. ${MESSAGE_RATES}</p>
      ${config.contactEmail ? `<p>For help, email ${link(`mailto:${config.contactEmail}`, config.contactEmail)}.</p>` : emailNotice(config)}
      <p>Policies: ${link(privacyHref, "Privacy Policy")} and ${link(termsHref, "Terms & Conditions")}.</p>
    </section>`,
  );
}

export function renderCompliancePage(id: CompliancePageId, config: PublicComplianceConfig): string {
  switch (id) {
    case "privacy":
      return privacyPage(config);
    case "terms":
      return termsPage(config);
    case "sms":
      return smsPage(config);
  }
}
