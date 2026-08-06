"use client";

/**
 * Markdown for agent messages — react-markdown + GFM, styled to the Eden
 * palette entirely through container-level utility variants (no global CSS,
 * no typography plugin). Raw HTML is NOT rendered (react-markdown default),
 * so streamed model output stays inert.
 */

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const REMARK_PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  a({ href, children }) {
    const external = typeof href === "string" && /^https?:\/\//.test(href);
    return (
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className="text-accent-soft underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
      >
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    if (typeof src !== "string" || src.length === 0) return null;
    return (
      // eslint-disable-next-line @next/next/no-img-element -- markdown media
      // URLs render verbatim (legacy CDN or local /media), no optimizer.
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        decoding="async"
        className="my-1 max-h-96 max-w-full rounded-xl"
      />
    );
  },
};

/**
 * One class string, grouped by element. `[&_x]` = descendant selector;
 * spacing rhythm comes from `[&>*+*]:mt-3` on the container.
 */
const MD_CLASS = [
  "min-w-0 text-[15px] leading-relaxed text-foreground/95",
  "[&>*+*]:mt-3",
  // Headings — chat-scale, not article-scale.
  "[&_h1]:text-lg [&_h1]:font-semibold [&_h1]:tracking-tight",
  "[&_h2]:text-base [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_h3]:text-[15px] [&_h3]:font-semibold",
  "[&_h4]:text-[15px] [&_h4]:font-medium [&_h5]:font-medium [&_h6]:font-medium",
  // Lists.
  "[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5",
  "[&_li]:mt-1 [&_li]:marker:text-faint",
  // Inline + block code.
  "[&_code]:font-mono [&_code]:text-[0.875em]",
  "[&_:not(pre)>code]:rounded-md [&_:not(pre)>code]:bg-foreground/[0.07] [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5",
  "[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-edge [&_pre]:bg-black/40 [&_pre]:p-3.5 [&_pre]:text-[13px] [&_pre]:leading-relaxed",
  // Quotes, rules.
  "[&_blockquote]:border-l-2 [&_blockquote]:border-accent/40 [&_blockquote]:pl-3.5 [&_blockquote]:text-muted",
  "[&_hr]:border-edge",
  // Tables (GFM) — scroll inside their own box.
  "[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-sm",
  "[&_th]:border [&_th]:border-edge [&_th]:bg-foreground/[0.04] [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium",
  "[&_td]:border [&_td]:border-edge [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top",
  "[&_strong]:font-semibold",
].join(" ");

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className={MD_CLASS}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
