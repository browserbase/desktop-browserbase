/** Keep connection URLs and API credentials out of logs and renderer errors. */
export function safeError(error: unknown): Error {
  let message = error instanceof Error ? error.message : "Unexpected error";
  // Playwright includes the complete CDP endpoint in connection failure messages.
  // Debug URLs may also carry signed access without an API key parameter.
  message = message.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, "[URL redacted]");
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (apiKey) {
    message = message.split(apiKey).join("[credential redacted]");
  }
  return new Error(message);
}
