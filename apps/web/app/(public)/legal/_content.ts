export type LegalSection = {
  heading: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
};

export type LegalDocument = {
  slug: "terms" | "privacy" | "content" | "cookies";
  title: string;
  summary: string;
  version: string;
  sections: readonly LegalSection[];
};

const draftIdentity =
  "This is a pre-live working draft for a closed test cohort. It is not effective, is not legal advice, and has not been approved by Eden or legal counsel.";

export const legalDocuments: readonly LegalDocument[] = [
  {
    slug: "terms",
    title: "Draft Terms of Service",
    summary: "Proposed rules for using Eden's creative-agent test service.",
    version: "Draft 0.1 · August 8, 2026 · Proposed effective date: not set",
    sections: [
      {
        heading: "Draft status and product identity",
        paragraphs: [
          draftIdentity,
          "Eden is a creative-agent service for conversation, memory, media generation, collaborative sessions, and optional third-party channels. The operator name, notice address, governing law, and launch date still require written approval.",
        ],
      },
      {
        heading: "Closed cohort and test mode",
        paragraphs: [
          "The current service is a limited, invitation-only test. There is no public signup offer. Features may change, stop, or lose test data, and availability is not guaranteed.",
          "Manna, balances, quotes, and payment screens are test instruments only. They are not money, stored value, cryptocurrency, a purchase promise, or a claim against Eden. Live billing must not begin until separate terms and pricing are approved.",
        ],
      },
      {
        heading: "Accounts and eligibility",
        paragraphs: [
          "The proposed launch posture is adults only, with a minimum age of 18. Eligibility, geographic restrictions, and any age-assurance method remain counsel decisions. Test participants must keep account access secure and provide accurate information.",
        ],
      },
      {
        heading: "Your content and permissions",
        paragraphs: [
          "You keep whatever rights you lawfully hold in prompts, uploads, agent materials, and creations. AI output may not be unique, and Eden does not promise that output is copyrightable, non-infringing, accurate, or suitable for a particular use.",
          "You give Eden a limited, non-exclusive license to host, copy, transform, transmit, display, and moderate your content only as needed to operate, secure, support, and improve the requested service, comply with law, and honor your sharing choices. The final scope, model-training posture, promotional-use posture, and post-deletion exceptions require legal and product sign-off before launch.",
        ],
      },
      {
        heading: "Your responsibilities",
        paragraphs: [
          "You must have the rights and permissions needed for content and connected accounts, review AI output before relying on or publishing it, and comply with the Draft Content and Copyright Policy and applicable third-party terms.",
        ],
        bullets: [
          "Do not use Eden for unlawful activity, deception, abuse, exploitation, privacy violations, malware, or unauthorized access.",
          "Do not present AI output as professional medical, legal, financial, or safety advice.",
          "Do not evade access controls, quotas, moderation, or provider restrictions.",
        ],
      },
      {
        heading: "AI and third-party services",
        paragraphs: [
          "Requests may be processed by selected AI, hosting, identity, storage, monitoring, and other service providers. Connecting Discord, Telegram, X, OpenClaw, or another service authorizes the requested connection and also subjects you to that provider's terms. Connected services can fail, change, retain data, or apply their own moderation.",
        ],
      },
      {
        heading: "Sharing, moderation, and removal",
        paragraphs: [
          "You control whether supported content is private, shared by an unlisted link, or public, subject to product controls. Eden may restrict access or remove content or accounts to protect people or the service, respond to reports, enforce these drafts during testing, or comply with law. The final appeal and notice process is unresolved.",
        ],
      },
      {
        heading: "Ending use and account deletion",
        paragraphs: [
          "You may stop using the test service. A deletion and export design is under review; any production promise depends on successful implementation, backup-retention rules, fraud and legal holds, and external-provider deletion capabilities.",
        ],
      },
      {
        heading: "Disclaimers and unresolved legal terms",
        paragraphs: [
          "The test service and AI output are provided as available and may be incomplete, inaccurate, or unavailable. No warranty, liability cap, indemnity, dispute process, class-action waiver, governing law, venue, or termination clause in this draft is approved. Counsel must supply or approve those terms before this document can become effective.",
        ],
      },
      {
        heading: "Contact and related drafts",
        paragraphs: [
          "General legal contact: [LEGAL CONTACT REQUIRED]. Copyright notices: [DMCA AGENT REQUIRED]. See the Draft Privacy Policy, Draft Content and Copyright Policy, and Draft Cookie Notice.",
        ],
      },
    ],
  },
  {
    slug: "privacy",
    title: "Draft Privacy Policy",
    summary: "A pre-live map of data Eden expects to handle and why.",
    version: "Draft 0.1 · August 8, 2026 · Proposed effective date: not set",
    sections: [
      {
        heading: "Draft status and scope",
        paragraphs: [
          draftIdentity,
          "This draft covers Eden's web application, creative agents, media tools, collaborative sessions, memories, and optional channel integrations. The controller identity, notice address, jurisdictions, and final service inventory are not yet approved.",
        ],
      },
      {
        heading: "Information we expect to handle",
        bullets: [
          "Account and profile data, such as identity-provider identifiers, username, display information, roles, and account settings.",
          "Prompts, messages, agent instructions, memories, files, generated media, reactions, reports, collections, and sharing choices.",
          "Connection data for services you choose to link, including encrypted credentials or scoped references, provider account identifiers, channel configuration, and delivery records.",
          "Usage, quote, manna, test-billing, and transaction records. The current cohort does not offer live payments.",
          "Device, browser, network, security, diagnostic, and audit information, including IP-derived request data and timestamps.",
          "Support, moderation, copyright, privacy, export, and deletion communications.",
        ],
      },
      {
        heading: "How we expect to use information",
        bullets: [
          "Provide, authenticate, personalize, meter, and troubleshoot the service.",
          "Run requested AI inference and media generation, preserve conversation context, and deliver requested channel messages.",
          "Protect accounts and infrastructure, investigate abuse, moderate content, and maintain audit evidence.",
          "Respond to support, privacy, copyright, and legal requests.",
          "Understand and improve reliability and product experience. Any use for general model training, advertising, or promotional content requires a separately approved disclosure and permission basis.",
        ],
      },
      {
        heading: "AI providers and other recipients",
        paragraphs: [
          "Content and related metadata may be sent to AI or media providers selected for the action you request. Eden may also use identity, hosting, database, object-storage, monitoring, communications, and test-payment providers. Connected third-party services receive the information needed for the connection you activate.",
          "The final subprocessor list, provider retention and training settings, data locations, contractual safeguards, and cross-border transfer mechanism are launch blockers listed in LEGAL-QUESTIONS.md.",
        ],
      },
      {
        heading: "Sharing and public visibility",
        paragraphs: [
          "Private content is not intended for public discovery. If you create a public item or an unlisted share link, recipients may view and copy the shared material. Channel participants may also receive content you send through a connected service. Eden may disclose information when required by valid legal process or needed to protect rights and safety, subject to final counsel review.",
        ],
      },
      {
        heading: "Retention",
        paragraphs: [
          "Draft posture: retain account and content data while needed to provide the test, then delete or de-identify it after an approved deletion request, subject to backup aging, security records, dispute or legal holds, and external-provider limits. Shorter operational retention should apply to capabilities and transient logs.",
          "Concrete periods for application records, prompts and outputs, provider copies, logs, backups, audit evidence, copyright records, and deleted-account tombstones are not yet approved and must be filled in before launch.",
        ],
      },
      {
        heading: "Access, export, correction, and deletion",
        paragraphs: [
          "The intended product posture is to let authenticated users review or correct supported profile data and request export or deletion. Production behavior, response time, identity verification, exceptions, authorized-agent handling, appeals, and jurisdiction-specific rights require implementation evidence and counsel approval. Contact: [PRIVACY CONTACT REQUIRED].",
        ],
      },
      {
        heading: "Security",
        paragraphs: [
          "Eden uses access controls and technical safeguards appropriate to a test service, but no system is perfectly secure. This draft does not claim a certification, regulatory compliance status, guaranteed encryption coverage, or breach-notification timeline.",
        ],
      },
      {
        heading: "Children and age posture",
        paragraphs: [
          "The proposed service is not directed to children and the proposed minimum age is 18. The audience analysis, neutral age screen, response to actual knowledge of a child's use, and regional age rules require counsel and product decisions before public access.",
        ],
      },
      {
        heading: "Cookies and local storage",
        paragraphs: [
          "Eden expects to use necessary session/security storage and local preferences. Analytics, advertising, consent signals, and regional cookie requirements remain unapproved. See the Draft Cookie Notice.",
        ],
      },
      {
        heading: "Changes and contact",
        paragraphs: [
          "No change-notice method or effective date is approved. Questions can be directed to [PRIVACY CONTACT REQUIRED] after the operator designates and monitors that address.",
        ],
      },
    ],
  },
  {
    slug: "content",
    title: "Draft Content and Copyright Policy",
    summary: "Proposed safety rules, reporting posture, and DMCA process.",
    version: "Draft 0.1 · August 8, 2026 · Proposed effective date: not set",
    sections: [
      {
        heading: "Draft status",
        paragraphs: [
          draftIdentity,
          "These rules apply provisionally to prompts, uploads, generated media, messages, agents, memories, links, and connected-channel activity in the test cohort.",
        ],
      },
      {
        heading: "Content that is not allowed",
        bullets: [
          "Child sexual abuse material, sexualization or exploitation of minors, grooming, or content that facilitates abuse.",
          "Non-consensual intimate imagery, sexual violence, coerced sexual content, or sexual deepfakes of an identifiable person without consent.",
          "Credible threats, instructions to cause serious harm, terrorist support, targeted harassment, hateful abuse, or glorification of violence against protected people.",
          "Doxxing, stalking, privacy invasion, identity theft, deceptive impersonation, fraud, scams, spam, malware, credential theft, or unauthorized access.",
          "Content or activity that infringes copyright, trademark, publicity, privacy, or other rights.",
          "Any other content or conduct that is unlawful or creates a concrete safety risk.",
        ],
      },
      {
        heading: "Provisional adult-content posture",
        paragraphs: [
          "Eden's frozen provisional posture is that lawful adult sexual content may be allowed only where every depicted person is an adult, participation and depiction are consensual, and creation and distribution are lawful. This is not a final permission or launch commitment.",
          "Counsel and product owners must decide age assurance, performer consent evidence, synthetic-person rules, public visibility, regional restrictions, provider restrictions, moderation thresholds, and reporting obligations. Until those controls are approved, public adult-content distribution must remain disabled or limited to the closed test scope.",
        ],
      },
      {
        heading: "Moderation and enforcement",
        paragraphs: [
          "Eden may limit generation, quarantine media, restrict sharing, remove content, disconnect integrations, suspend test access, preserve evidence, or refer urgent threats to appropriate authorities. Context, severity, history, and safety may affect the response. A final notice, appeal, emergency-escalation, and transparency process is still required.",
        ],
      },
      {
        heading: "How to report content",
        paragraphs: [
          "Use the in-product reporting control where available. For urgent safety, privacy, or abuse reports, use [SAFETY CONTACT REQUIRED]. Do not send illegal imagery as an attachment; provide the URL or identifier and enough context to locate it. The monitored mailbox, service levels, escalation roster, and evidence-retention rules are launch blockers.",
        ],
      },
      {
        heading: "Copyright notice procedure",
        paragraphs: [
          "A copyright owner or authorized agent may send a written notice to [DMCA AGENT NAME, ADDRESS, PHONE, AND EMAIL REQUIRED]. The operator has not confirmed in this draft that an agent has been registered with the U.S. Copyright Office.",
        ],
        bullets: [
          "Identify and sign for the copyright owner or authorized agent.",
          "Identify the copyrighted work, or a representative list for multiple works.",
          "Identify the material and provide information reasonably sufficient to locate it.",
          "Provide contact information.",
          "State a good-faith belief that the complained-of use is not authorized by the owner, its agent, or law.",
          "State that the notice is accurate and, under penalty of perjury, that the sender is authorized to act for the owner.",
        ],
      },
      {
        heading: "Removal, counter-notice, and repeat infringement",
        paragraphs: [
          "After receiving a substantially compliant notice, the proposed process is to locate the material, preserve a minimal audit record, remove or disable access where appropriate, notify the affected user, and evaluate a valid counter-notice before restoration. Counter-notice contents, waiting periods, repeat-infringer termination, misrepresentation handling, and non-U.S. copyright procedures must be implemented and approved by counsel before launch.",
        ],
      },
      {
        heading: "Official process sources",
        paragraphs: [
          "The notice checklist is based on 17 U.S.C. § 512(c)(3), and the designated-agent draft note is based on U.S. Copyright Office Section 512 guidance. These sources describe legal process; this draft does not claim Eden qualifies for a safe harbor.",
        ],
      },
    ],
  },
  {
    slug: "cookies",
    title: "Draft Cookie and Local Storage Notice",
    summary: "The proposed pre-live browser-storage and consent posture.",
    version: "Draft 0.1 · August 8, 2026 · Proposed effective date: not set",
    sections: [
      {
        heading: "Draft status",
        paragraphs: [draftIdentity],
      },
      {
        heading: "Current test posture",
        paragraphs: [
          "Eden uses or expects to use browser storage that is necessary for authentication, session continuity, security, theme and display preferences, and remembering selected workspace or agent context. Some third-party identity or connected-service flows may set their own storage under their policies.",
          "The draft posture is no advertising cookies and no sale of cookie-derived profiles. A verified production cookie scan and vendor inventory have not yet been completed, so this is not an assurance about every deployed dependency.",
        ],
      },
      {
        heading: "Storage categories",
        bullets: [
          "Strictly necessary: authentication, security, load balancing, and service continuity.",
          "Preferences: theme, display choices, and recently selected in-app context.",
          "Analytics and diagnostics: not approved for public launch until the exact tools, fields, retention, and regional consent basis are inventoried.",
          "Advertising or cross-site profiling: not part of the proposed launch posture.",
        ],
      },
      {
        heading: "Choices and consent",
        paragraphs: [
          "Browser controls can delete or block storage, but necessary features may stop working. Eden has not yet approved a consent banner or preference center. Before public launch, counsel must decide which storage is strictly necessary, which regions require prior consent, how withdrawal works, and how consent evidence is retained.",
        ],
      },
      {
        heading: "Contact and updates",
        paragraphs: [
          "Questions can be sent to [PRIVACY CONTACT REQUIRED] once designated. The final notice must list actual cookie or storage names, providers, purposes, and durations from a production-shaped scan.",
        ],
      },
    ],
  },
] as const;

export function legalDocument(slug: LegalDocument["slug"]): LegalDocument {
  const document = legalDocuments.find((candidate) => candidate.slug === slug);
  if (!document) throw new Error(`Unknown legal document: ${slug}`);
  return document;
}
