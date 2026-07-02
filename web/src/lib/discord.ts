import type { DiscordStatus } from "./types";
import type { StatusKind } from "../components/ui/status";

export function discordTone(d: DiscordStatus): { kind: StatusKind; text: string } {
  if (!d.configured) return { kind: "disabled", text: "Not configured" };
  if (!d.connected) return { kind: "failed", text: "Disconnected" };
  if (d.lastResult === "error") return { kind: "failed", text: "Error" };
  if (d.lastResult === "ok") return { kind: "completed", text: "Connected" };
  return { kind: "untested", text: "Connected (untested)" };
}
