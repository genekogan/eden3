import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  agentSectionHref,
  isEveConcealedSubpath,
  isEveUsername,
} from "@/lib/eve";

/**
 * Conceal Eve's platform-owned settings before React starts rendering. A
 * layout-level redirect alone can still stream child markup in the RSC HTML.
 */
export function middleware(request: NextRequest) {
  const match = request.nextUrl.pathname.match(/^\/agents\/([^/]+)\/(.+)$/i);
  if (!match?.[1] || !match[2]) return NextResponse.next();

  const username = decodeURIComponent(match[1]);
  if (
    !isEveUsername(username) ||
    !isEveConcealedSubpath(decodeURIComponent(match[2]))
  ) {
    return NextResponse.next();
  }

  const destination = request.nextUrl.clone();
  destination.pathname = agentSectionHref(username, "chats");
  destination.search = "";
  return NextResponse.redirect(destination, 307);
}

export const config = {
  matcher: [
    "/agents/:username/edit",
    "/agents/:username/edit/:path*",
    "/agents/:username/schedule",
    "/agents/:username/schedule/:path*",
    "/agents/:username/settings",
    "/agents/:username/settings/:path*",
    "/agents/:username/workspace",
    "/agents/:username/workspace/:path*",
    "/agents/:username/gateway",
    "/agents/:username/gateway/:path*",
  ],
};
