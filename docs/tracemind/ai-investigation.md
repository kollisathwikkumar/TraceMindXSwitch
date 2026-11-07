# TraceMind AI investigation setup

TraceMind can use an OpenAI-compatible chat-completions endpoint to prepare an issue-linked investigation. The generated summary, hypotheses, and recommendations are suggestions for review; they do not prove runtime behavior, verify a check, or resolve an issue.

## Configure a provider

1. Open **TraceMind** in Switch Console Canary and select a local project.
2. Open **Issues & investigations**, then select or create an issue.
3. In the **AI investigation** panel, enter the provider endpoint and model. The default endpoint is `https://api.openai.com/v1`; use the endpoint and model required by your provider.
4. Paste the API key into **API key (saved encrypted; not displayed again)** and select **Save AI provider**. The app stores the credential through Electron `safeStorage` in its encrypted app-secrets store. The key field is cleared after saving; TraceMind does not return the key in provider status.
5. Select **Generate AI investigation** when you are ready to send this issue's bounded retrieved evidence to the configured model. TraceMind does not call the model automatically. The endpoint receives the issue details and the evidence snippets included in that investigation request.

The result is saved to that issue's append-only investigation timeline with its model, timestamp, revision, evidence references, freshness, and limitations. Each cited item shows the saved evidence label and available path/range metadata. Review stale or unknown freshness and heuristic/ambiguous evidence carefully. AI output remains advisory and does not change the issue's status or investigation phase.

To remove the saved credential, select **Clear saved key** in the same panel. To change providers, enter a new endpoint, model, and API key and save again.

## Key handling

- Enter the key only in the password-masked API key field in Switch Console.
- The key is sent to the desktop main process for encrypted storage and is not returned by the provider-status UI.
- Saving a key does not run an investigation. A model request happens only after selecting **Generate AI investigation** for a selected issue.
- Avoid including secrets in issue descriptions or source evidence: the configured model endpoint receives the evidence used for that request.
