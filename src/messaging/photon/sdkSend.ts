import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { MessagingError } from "../Messenger";

/**
 * Outbound text through the current Spectrum cloud iMessage provider
 * (`spectrum-ts` 12.x, `spectrum-ts/providers/imessage`). Tour Core does not
 * import `@photon-ai/advanced-imessage` or the local Messages package.
 * Rich iMessage features are not used.
 */
export async function sendPhotonText(
  credentials: { projectId: string; projectSecret: string },
  input: { to: string; text: string; from?: string },
): Promise<{ providerMessageId: string }> {
  let app: Awaited<ReturnType<typeof Spectrum>>;
  try {
    app = await Spectrum({
      projectId: credentials.projectId,
      projectSecret: credentials.projectSecret,
      providers: [imessage.config()],
    });
  } catch {
    throw new MessagingError("PHOTON_UNREACHABLE", "Couldn't reach Photon.", { retryable: true });
  }
  try {
    const im = imessage(app);
    const user = await im.user(input.to);
    const space = input.from ? await im.space.create(user, { phone: input.from }) : await im.space.create(user);
    const sent = await space.send(input.text);
    const id = sent && typeof sent === "object" && "id" in sent && typeof sent.id === "string" ? sent.id : undefined;
    if (!id) throw new MessagingError("PHOTON_REJECTED", "Photon didn't accept the message.");
    return { providerMessageId: id };
  } catch (err) {
    if (err instanceof MessagingError) throw err;
    throw new MessagingError("PHOTON_FAILED", "Sending through Photon failed.");
  }
}
