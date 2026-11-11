// Pièces jointes Skolengo : leur adresse ne vaut que le temps de la session, et le fichier
// demande le jeton de la session. L'adresse est redemandée au service, puis le fichier est
// téléchargé par skolengojs, qui y met ce jeton.
import type {
  Attachment as SkolengoAttachment,
  Skolengo as SkolengoClient,
} from "skolengojs";

import { allowInstance } from "@/lib/http";
import { addDays } from "@/lib/week";

import { ServiceUnavailable } from "../shared/errors";
import type { Attachment } from "../shared/models";
import type { SkolengoSession } from "./session";

/** Où retrouver une pièce jointe pour en redemander le contenu. */
type Origin =
  { source: "homework"; id: string } | { source: "news"; id: string };

/** La `ref` d'une pièce jointe, ou `null` si elle est illisible. */
export function parseRef(ref: string | undefined): Origin | null {
  let value: unknown;
  try {
    value = JSON.parse(ref ?? "");
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { source, id } = value as { source?: unknown; id?: unknown };
  return typeof id === "string" && (source === "homework" || source === "news")
    ? { source, id }
    : null;
}

/** Une pièce jointe retrouvée chez Skolengo, par son adresse puis par son nom. */
async function findFile(
  client: SkolengoClient,
  ref: Origin,
  name: string,
  url: string
): Promise<SkolengoAttachment | undefined> {
  if (ref.source === "news") {
    const item = (await client.GetNews()).find(
      candidate => candidate.id === ref.id
    );
    const illustration = item?.illustration;
    return illustration &&
      (illustration.url === url || illustration.fileName === name)
      ? illustration
      : undefined;
  }
  // Large autour d'aujourd'hui : un devoir d'une autre semaine doit aussi se retrouver.
  const now = new Date();
  const assignments = await client.GetAssignments(
    addDays(now, -365),
    addDays(now, 365)
  );
  const assignment = assignments.find(candidate => candidate.id === ref.id);
  const files = assignment ? await assignment.getAttachments() : [];
  return (
    files.find(candidate => candidate.url === url) ??
    files.find(candidate => candidate.fileName === name)
  );
}

/** Le contenu d'une pièce jointe, retrouvée là où elle a été vue. */
export const downloadAttachment =
  (session: SkolengoSession) => (attachment: Attachment) =>
    session.run(async client => {
      const ref = parseRef(attachment.ref);
      const file =
        ref && (await findFile(client, ref, attachment.name, attachment.url));
      if (!file) {
        throw new ServiceUnavailable("Pièce jointe introuvable chez Skolengo");
      }
      try {
        await allowInstance(new URL(file.url).origin);
      } catch {
        throw new ServiceUnavailable("Pièce jointe introuvable chez Skolengo");
      }
      return Uint8Array.from(await file.fetchAttachmentBuffer());
    });
