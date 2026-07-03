import type { Metadata } from "next";
import { Suspense } from "react";
import { NewChatScreen } from "@/components/chat/new-chat";

export const metadata: Metadata = { title: "New Chat" };

/**
 * /chat[?agent=<username>] — pick an agent (no param) or compose the first
 * message to one. The first send POSTs /api/sessions/new/messages and hands
 * the live stream to /sessions/[id]. Client-side surface; Suspense wraps the
 * useSearchParams() bailout.
 */
export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <NewChatScreen />
    </Suspense>
  );
}
