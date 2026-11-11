// Ajouter un compte depuis Paramètres > Comptes liés : les étapes du premier lancement
// (service scolaire, connexion PRONOTE ou Skolengo, compte hors ligne) dans une boîte de
// dialogue. Sert aussi à reconnecter un service refusé.
import { Cross } from "@getpapillon/papicons";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { OfflineAccountStep } from "@/app/onboarding/OfflineAccountStep";
import { PronoteFlow } from "@/app/onboarding/pronote";
import type { Relink } from "@/app/onboarding/pronote/ConnectStep";
import { ServiceStep } from "@/app/onboarding/ServiceStep";
import { SkolengoFlow, type SkolengoRelink } from "@/app/onboarding/skolengo";
import { onOwnClose, useModalDialog } from "@/hooks/useModalDialog";

import styles from "./settings.module.scss";

/** Ce qu'ouvre la fenêtre : un service, un compte hors ligne, ou la reconnexion d'un service. */
export type AddAccountStart =
  | "service"
  | "offline"
  | (Relink & { kind: "pronote" })
  | (SkolengoRelink & { kind: "skolengo" });

/** `start` : l'étape d'ouverture, `null` quand la fenêtre est fermée. */
export function AddAccountDialog({
  start,
  onClose,
}: {
  start: AddAccountStart | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useModalDialog(start !== null);
  const [chosen, setChosen] = useState<
    "pronote" | "skolengo" | "offline" | null
  >(null);
  const close = () => {
    setChosen(null);
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      className={styles.addAccount}
      aria-label={t("settings.linked.addAccount")}
      onClose={onOwnClose(close)}
    >
      <button
        type="button"
        className={styles.dialogClose}
        aria-label={t("dialog.close")}
        onClick={close}
      >
        <Cross size={18} />
      </button>
      {typeof start === "object" &&
        start !== null &&
        start.kind === "pronote" && (
          <PronoteFlow relink={start} onExit={close} onDone={close} />
        )}
      {typeof start === "object" &&
        start !== null &&
        start.kind === "skolengo" && (
          <SkolengoFlow relink={start} onExit={close} onDone={close} />
        )}
      {(start === "offline" ||
        (start === "service" && chosen === "offline")) && (
        <OfflineAccountStep
          onCancel={start === "offline" ? close : () => setChosen(null)}
          onCreated={close}
        />
      )}
      {start === "service" && chosen === "pronote" && (
        <PronoteFlow onExit={() => setChosen(null)} onDone={close} />
      )}
      {start === "service" && chosen === "skolengo" && (
        <SkolengoFlow onExit={() => setChosen(null)} onDone={close} />
      )}
      {start === "service" && chosen === null && (
        <ServiceStep
          onPronote={() => setChosen("pronote")}
          onSkolengo={() => setChosen("skolengo")}
          onOffline={() => setChosen("offline")}
        />
      )}
    </dialog>
  );
}
