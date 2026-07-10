import type { Metadata } from "next";
import { SkillsClient } from "./skills-client";

export const metadata: Metadata = { title: "Skills" };

export default function SkillsPage() {
  return <SkillsClient />;
}
