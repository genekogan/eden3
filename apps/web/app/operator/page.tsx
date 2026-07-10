import type { Metadata } from "next";
import { OperatorClient } from "./operator-client";

export const metadata: Metadata = { title: "Operator" };

export default function OperatorPage() {
  return <OperatorClient />;
}
