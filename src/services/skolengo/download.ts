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
import { getCourseContents } from "./data";
import type { SkolengoSession } from "./session";

/** Où retrouver une pièce jointe pour en redemander le contenu. */
type Origin =
  | { source: "homework"; id: string }
  | { source: "news"; id: string }
  | { source: "lesson"; id: string; url: string };

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
  const { source, id, url } = value as {
    source?: unknown;
    id?: unknown;
    url?: unknown;
  };
  if (typeof id !== "string") {
    return null;
  }
  if (source === "homework" || source === "news") {
    return { source, id };
  }
  return source === "lesson" && typeof url === "string"
    ? { source, id, url }
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

/** Le contenu d'une pièce jointe d'un cours, avec le jeton de la session. */
async function downloadLessonFile(
  client: SkolengoClient,
  ref: Extract<Origin, { source: "lesson" }>,
  name: string,
  url: string
): Promise<Uint8Array> {
  const contents = await getCourseContents(client, ref.id);
  const file = contents
    .flatMap(content => content.attachments)
    .find(
      candidate =>
        candidate.kind === "file" &&
        (candidate.url === url || candidate.name === name)
    );
  if (!file) {
    throw new ServiceUnavailable("Pièce jointe introuvable chez Skolengo");
  }
  try {
    await allowInstance(new URL(file.url).origin);
  } catch {
    throw new ServiceUnavailable("Pièce jointe introuvable chez Skolengo");
  }
  const token = (client as unknown as { accessToken?: string }).accessToken;
  if (!token) {
    throw new ServiceUnavailable("Session Skolengo sans jeton");
  }
  const response = await fetch(file.url, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(`${response.status}: Skolengo`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Le contenu d'une pièce jointe, retrouvée là où elle a été vue. */
export const downloadAttachment =
  (session: SkolengoSession) => (attachment: Attachment) =>
    session.run(async client => {
      const ref = parseRef(attachment.ref);
      if (ref?.source === "lesson") {
        return downloadLessonFile(client, ref, attachment.name, attachment.url);
      }
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
