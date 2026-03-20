import { notify as slackNotify } from "./slack.js";

export function notify(text: string): void {
  slackNotify(text);
  // Discord notify will be added in Task 5
}
