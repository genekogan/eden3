import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const LAST_TOOL_COOKIE = "eden3_last_tool";
const DEFAULT_TOOL = "image_generate";

/** /studio → the last-used tool, else the default (image). */
export default async function StudioIndexPage() {
  const store = await cookies();
  const last = store.get(LAST_TOOL_COOKIE)?.value;
  const tool = last && /^[a-zA-Z0-9_-]{1,80}$/.test(last) ? last : DEFAULT_TOOL;
  redirect(`/studio/${encodeURIComponent(tool)}`);
}
