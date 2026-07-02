import type { QueueCategory } from "./types";

// One cold tonal ramp so the queue reads as a single system, not rainbow labels.
export const CATEGORY_META: Record<QueueCategory, { label: string; color: string }> = {
  "ready": { label: "Ready", color: "#34d3a6" },
  "auto-mergeable": { label: "Auto-mergeable", color: "#2fd0c0" },
  "refined": { label: "Refined", color: "#4aa8ff" },
  "needs-plan-review": { label: "Needs Plan Review", color: "#67e8f9" },
  "needs-refinement": { label: "Needs Refinement", color: "#8ea2ff" },
  "needs-review-addressing": { label: "Needs Review Addressing", color: "#e0b34a" },
  "needs-triage": { label: "Needs Triage", color: "#fb5a76" },
};

export function categoryMeta(cat: QueueCategory) {
  return CATEGORY_META[cat] ?? { label: cat, color: "#9fb3cc" };
}
