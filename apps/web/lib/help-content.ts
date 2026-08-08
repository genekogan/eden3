import { agentSectionHref, isEveUsername } from "./eve";
import { isValidAgentUsername } from "./last-agent";

export const HELP_ARTICLE_IDS = [
  "choose-agent",
  "start-chat",
  "manna-quotes",
  "library-files",
  "connect-channel",
  "safe-errors",
] as const;

export type HelpArticleId = (typeof HELP_ARTICLE_IDS)[number];
type AgentAction = "new-chat" | "library" | "gateway";
type HelpAgentPhase = "idle" | "loading" | "ready" | "missing" | "error";

export type HelpAgentAuthority = {
  loadedUsername?: string | null;
  canManage: boolean;
  phase: HelpAgentPhase;
};

const RESERVED_AGENT_USERNAMES = new Set(["new", "builder", "edit", "api", "media"]);

export type HelpArticle = {
  id: HelpArticleId;
  title: string;
  summary: string;
  keywords: readonly string[];
  steps: readonly string[];
  notes: readonly string[];
  action:
    | {
        kind: "static";
        href: "/agents" | "/agents/new" | "/account/manna" | "/help";
        label: string;
      }
    | { kind: "agent"; target: AgentAction; label: string };
};

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    id: "choose-agent",
    title: "Create or choose an agent",
    summary: "An agent owns its chats, Library, workspace, settings, and Gateway.",
    keywords: ["first agent", "builder", "template", "select", "switch", "eve"],
    steps: [
      "Open Agents. Pick an agent you can access, or choose Create agent.",
      "For a new agent, start from a template and review its name, handle, description, and visibility before saving.",
      "Use the agent selector in the sidebar to switch context. Check the handle above a page before changing settings or uploading files.",
    ],
    notes: [
      "Eve is the built-in starting assistant. Her platform-owned configuration is intentionally not editable.",
      "This is a closed, invitation-only cohort. There is no public signup path.",
    ],
    action: { kind: "static", href: "/agents", label: "Choose an agent" },
  },
  {
    id: "start-chat",
    title: "Start a chat",
    summary: "Open a new chat inside the selected agent and send one clear request.",
    keywords: ["message", "conversation", "prompt", "new chat", "reply"],
    steps: [
      "Select the agent you want to speak with, then choose New Chat.",
      "Describe the result you want and include only the context that agent should use.",
      "Review the displayed quote or tool choice before sending when one is shown.",
      "Wait for the turn to finish. If delivery fails, use the safe recovery guidance below instead of sending many duplicates.",
    ],
    notes: [
      "AI replies can be wrong or incomplete. Review output before relying on or publishing it.",
      "A conversation mirrored from an external channel may be read-only in the web cockpit; reply from that channel.",
    ],
    action: { kind: "agent", target: "new-chat", label: "Start a chat" },
  },
  {
    id: "manna-quotes",
    title: "Understand Manna and quotes",
    summary: "Manna measures test usage; a quote is the shown maximum or estimate for a requested turn.",
    keywords: ["balance", "cost", "billing", "insufficient", "refund", "usage", "stripe"],
    steps: [
      "Check the Manna badge or Manna page for your current test balance and ledger.",
      "Before a Studio generation or supported turn, review the displayed quote and selected quality or tool.",
      "After completion, check the ledger if the final charge or refund matters to your test.",
      "If the balance is insufficient, stop and ask the cohort operator rather than retrying the same paid action in a loop.",
    ],
    notes: [
      "Manna, checkout, subscriptions, vouchers, and prices are test-mode instruments. Manna is not money, stored value, or cryptocurrency, and this cohort offers no live purchase.",
      "A quote is not a promise that a provider will succeed or that output will meet your needs.",
    ],
    action: { kind: "static", href: "/account/manna", label: "Open Manna" },
  },
  {
    id: "library-files",
    title: "Upload and find a Library object",
    summary: "Upload private files and find this agent's creations or all creations you own.",
    keywords: ["file", "media", "image", "upload", "64 mib", "creation", "private"],
    steps: [
      "Confirm the selected agent, then open Library.",
      "Drop files into Upload files or use Choose files. The current browser path supports multiple files up to 64 MiB each.",
      "Leave the page open until each item reports completion. Pause and resume are available for an in-progress upload.",
      "Use This agent for its creations or All mine for creations you own, including Studio output.",
    ],
    notes: [
      "Uploads are private while they are verified. A file that is pending, rejected, quarantined, or not available will not resolve as public media.",
      "Supported file types are limited by the current picker and server verification. An extension alone does not prove the file type.",
    ],
    action: { kind: "agent", target: "library", label: "Open Library" },
  },
  {
    id: "connect-channel",
    title: "Connect a channel",
    summary: "Attach an authorized bot to one agent, then choose who may interact with it.",
    keywords: ["gateway", "discord", "telegram", "x", "bot", "pairing", "allowlist", "token"],
    steps: [
      "Select an agent you own and open its Gateway. Eve's platform configuration is not available.",
      "For Discord, use a bot application you control—never a user token. For Telegram, follow the Managed Bots ownership flow.",
      "After validation, configure direct-message pairing or explicit group and sender allowlists before activation.",
      "Use the separate X owner-publishing section only with an app you own. Review provider permissions and costs in the provider account.",
    ],
    notes: [
      "Channel setup is availability-dependent and may be disabled when the required manager or provider fixture is not configured.",
      "Never paste credentials into chat, help search, reports, or screenshots. Use only the password fields in the exact Gateway flow.",
      "Group memory is isolated and group tools are restricted. A connected bot is not permission to expose private web memory.",
    ],
    action: { kind: "agent", target: "gateway", label: "Open Gateway" },
  },
  {
    id: "safe-errors",
    title: "Recover from common errors safely",
    summary: "Retry only idempotent actions, preserve context, and never disclose credentials to troubleshoot.",
    keywords: ["offline", "failed", "retry", "stuck", "error", "quarantine", "delivery", "support"],
    steps: [
      "Read the error and keep the current page open long enough for a pending operation to reconcile.",
      "For a load failure, retry once. For a send, generation, upload completion, or channel action, check its status or ledger before repeating it.",
      "If a file is rejected, confirm its real type and size; do not rename an unsupported file to bypass verification.",
      "If a channel credential fails, revoke or replace it through the provider and Gateway flow. Never send it to another participant.",
      "When asking the cohort operator for help, share the page name, safe error code, approximate time, and affected agent handle—never a token, password, private prompt, or file unless explicitly required through an approved channel.",
    ],
    notes: [
      "Do not automate repeated retries or attempt to bypass access, moderation, quote, upload, or provider controls.",
      "There is no public support or signup service in this closed cohort. Use the operator contact provided with your invitation.",
    ],
    action: { kind: "static", href: "/help", label: "Review help" },
  },
] as const;

export function helpHref(id: HelpArticleId): `/help#${HelpArticleId}` {
  return `/help#${id}`;
}

export function resolveHelpAction(
  article: HelpArticle,
  authority: HelpAgentAuthority,
): { href: string; label: string } {
  if (article.action.kind === "static") return article.action;
  const loadedUsername = authority.loadedUsername;
  if (
    authority.phase !== "ready" ||
    !isValidAgentUsername(loadedUsername) ||
    RESERVED_AGENT_USERNAMES.has(loadedUsername.toLocaleLowerCase("en-US"))
  ) {
    return { href: "/agents", label: "Choose an agent first" };
  }
  if (
    article.action.target === "gateway" &&
    (!authority.canManage || isEveUsername(loadedUsername))
  ) {
    return { href: "/agents", label: "Choose your own agent" };
  }
  const subpath =
    article.action.target === "new-chat" ? "chats/new" : article.action.target;
  return {
    href: agentSectionHref(loadedUsername, subpath),
    label: article.action.label,
  };
}

function normalizedTokens(query: string): string[] {
  return query
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .trim()
    .slice(0, 120)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
}

export function searchHelpArticles(query: string): readonly HelpArticle[] {
  const tokens = normalizedTokens(query);
  if (tokens.length === 0) return HELP_ARTICLES;

  return HELP_ARTICLES.map((article, index) => {
    const title = article.title.toLocaleLowerCase("en-US");
    const summary = article.summary.toLocaleLowerCase("en-US");
    const keywords = article.keywords.join(" ").toLocaleLowerCase("en-US");
    const details = [...article.steps, ...article.notes].join(" ").toLocaleLowerCase("en-US");
    let score = 0;
    for (const token of tokens) {
      const tokenScore =
        (title.includes(token) ? 8 : 0) +
        (keywords.includes(token) ? 5 : 0) +
        (summary.includes(token) ? 3 : 0) +
        (details.includes(token) ? 1 : 0);
      if (tokenScore === 0) return { article, index, score: -1 };
      score += tokenScore;
    }
    return { article, index, score };
  })
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((candidate) => candidate.article);
}
