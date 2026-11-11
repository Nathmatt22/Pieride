// Service Skolengo, branché à l'AccountManager dans services/index.ts. La connexion d'un
// nouveau compte est dans `login.ts`, la session et le jeton dans `session.ts`.
import type { ConnectService } from "../shared/plugin";
import { capabilities } from "./data";
import { downloadAttachment } from "./download";
import { secretOf, SkolengoSession } from "./session";

export const connectSkolengo: ConnectService = async (
  _service,
  secret,
  saveSecret,
  auth
) => {
  const session = new SkolengoSession(secretOf(secret), saveSecret, auth);
  // Vérifie le jeton tout de suite : un refus marque le service « à reconnecter ».
  const client = await session.client();
  return {
    kind: "skolengo",
    capabilities: capabilities(session, client.permissions),
    downloadAttachment: downloadAttachment(session),
  };
};
