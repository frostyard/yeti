import { notify as discordNotify } from "./discord.js";

export function notify(text: string): void {
  discordNotify(text);
}
