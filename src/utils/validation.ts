import type { ZodError } from "zod";

// رسالة خطأ مفهومة للعميل بدل JSON بتاع zod ("String must contain at least 1
// character(s)") - أول مشكلة بس، باسم الخانة بالإنجليزي البسيط
const LABELS: Record<string, string> = {
  tableLabel: "your table",
  customerName: "your name",
  customerPhone: "your WhatsApp number",
  customerEmail: "your email",
  phone: "the phone number",
  email: "the email",
  name: "the name",
  items: "at least one item",
  resourceId: "a specialist or place",
  date: "a day",
  hour: "a time",
  mode: "dine-in or pickup",
  paymentMethodId: "a payment method",
};

export function zodMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Please check the form and try again.";
  const key = String(issue.path.find((p) => typeof p === "string") ?? "");
  const label = LABELS[key];
  if (label) {
    if (issue.code === "invalid_string" && (issue as { validation?: string }).validation === "email") return `Please enter a valid ${label.replace(/^your /, "")}.`;
    if (key === "items") return "Please add at least one item to your order.";
    return `Please enter ${label}.`;
  }
  return issue.message || "Please check the form and try again.";
}
