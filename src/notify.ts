import { notify as slackNotify } from "./slack.js";
import { notify as discordNotify } from "./discord.js";

export function notify(text: string): void {
  slackNotify(text);
  discordNotify(text);
}
