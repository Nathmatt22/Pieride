// Connexion à Skolengo : l'établissement, puis la page de l'ENT et la première synchro. Sert
// au premier lancement, à l'ajout d'un compte et à la reconnexion (Paramètres > Comptes liés).
import { useState } from "react";

import type { SkolengoSchool } from "@/services/skolengo/login";

import { BackButton } from "../BackButton";
import { ConnectStep } from "./ConnectStep";
import { SchoolStep } from "./SchoolStep";

/** Un service Skolengo à reconnecter. L'établissement se choisit à nouveau. */
export interface SkolengoRelink {
  accountId: string;
  serviceId: string;
  name: string;
}

type Step = { id: "school" } | { id: "connect"; school: SkolengoSchool };

export function SkolengoFlow({
  relink,
  onExit,
  onDone,
}: {
  relink?: SkolengoRelink;
  /** « Retour » depuis la première étape. */
  onExit: () => void;
  onDone?: () => void;
}) {
  const [history, setHistory] = useState<Step[]>([{ id: "school" }]);
  const step = history[history.length - 1];
  const go = (next: Step) => setHistory([...history, next]);
  const back = () =>
    history.length > 1 ? setHistory(history.slice(0, -1)) : onExit();

  return (
    <>
      {/* L'étape de connexion a le sien : il disparaît pendant la synchro. */}
      {step.id !== "connect" && <BackButton onClick={back} />}
      {step.id === "school" && (
        <SchoolStep onNext={school => go({ id: "connect", school })} />
      )}
      {step.id === "connect" && (
        <ConnectStep
          school={step.school}
          relink={relink}
          onBack={back}
          onDone={onDone}
        />
      )}
    </>
  );
}
