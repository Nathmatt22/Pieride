// Connexion à l'ENT de l'établissement choisi : la page s'ouvre dans une fenêtre à part
// (src-tauri/src/skolengo_login.rs), puis la première synchro. Crée le compte, ou reconnecte un
// service refusé.
import { Check } from "@getpapillon/papicons";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/Button/Button";
import { Card } from "@/components/Card/Card";
import { InfoCard } from "@/components/InfoCard/InfoCard";
import { SettingRow } from "@/components/SettingRow/SettingRow";
import { Spinner } from "@/components/Spinner/Spinner";
import { accountManager } from "@/services";
import type { SyncedCapability } from "@/services/account-manager";
import {
  finalizeLogin,
  isSameStudent,
  loginOf,
  prepareLogin,
  type SkolengoLogin,
  type SkolengoSchool,
} from "@/services/skolengo/login";
import { openSkolengoLogin } from "@/services/skolengo/session";
import { useAccountStore } from "@/stores/accounts";
import { useSyncStore } from "@/stores/sync";

import { BackButton } from "../BackButton";
import styles from "../onboarding.module.scss";
import { AlreadyLinked } from "../pronote/errors";
import { errorKey } from "./errors";
import skolengo from "./skolengo.module.scss";
import type { SkolengoRelink } from "./SkolengoFlow";

type Phase =
  { id: "ready" } | { id: "waiting" } | { id: "syncing"; done: number };

/** Dans l'ordre de la maquette. Les autres données suivent juste après, en arrière-plan. */
const SYNC_STEPS = [
  "TIMETABLE",
  "GRADES",
  "HOMEWORK",
] as const satisfies readonly SyncedCapability[];

export function ConnectStep({
  school,
  relink,
  onBack,
  onDone,
}: {
  school: SkolengoSchool;
  relink?: SkolengoRelink;
  onBack: () => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const setCurrentAccount = useAccountStore(state => state.setCurrentAccount);
  const reload = useSyncStore(state => state.reload);
  const sync = useSyncStore(state => state.sync);
  const [phase, setPhase] = useState<Phase>({ id: "ready" });
  /** Clé i18n du dernier échec. */
  const [error, setError] = useState<string | null>(null);

  const fail = (failure: unknown) => {
    setPhase({ id: "ready" });
    setError(errorKey(failure));
  };

  /** Crée le compte (ou remplace le secret du service refusé), puis la première synchro. */
  const complete = async (login: SkolengoLogin) => {
    setPhase({ id: "syncing", done: 1 });
    const secret = JSON.stringify(login.secret);
    const accountId = relink?.accountId ?? crypto.randomUUID();
    if (relink) {
      await accountManager.relinkService(relink.serviceId, secret);
    } else {
      if (
        await accountManager.findLinkedAccount(
          "skolengo",
          login.instanceUrl,
          isSameStudent(login)
        )
      ) {
        throw new AlreadyLinked();
      }
      await accountManager.addAccount({
        id: accountId,
        ...login.profile,
      });
      try {
        await accountManager.linkService(
          {
            id: crypto.randomUUID(),
            accountId,
            kind: "skolengo",
            instanceUrl: login.instanceUrl,
          },
          secret
        );
      } catch (failure) {
        // Pas de compte Skolengo sans son secret.
        await accountManager.removeAccount(accountId);
        throw failure;
      }
    }
    for (const [index, capability] of SYNC_STEPS.entries()) {
      setPhase({ id: "syncing", done: index + 1 });
      await accountManager.refresh(accountId, capability);
    }
    setCurrentAccount(accountId);
    reload();
    // Actualités, carnet… : une synchro complète, qui ne redemande pas les étapes ci-dessus.
    void sync(accountId);
    onDone?.();
  };

  const open = async () => {
    setError(null);
    setPhase({ id: "waiting" });
    try {
      const flow = await prepareLogin(school);
      const callback = await openSkolengoLogin(
        flow.loginURL,
        t("onboarding.skolengo.windowTitle")
      );
      if (!callback) {
        setPhase({ id: "ready" });
        setError("onboarding.skolengo.closed");
        return;
      }
      if (callback.error !== undefined) {
        throw new Error("login_denied");
      }
      if (!callback.code || !callback.state) {
        throw new Error("login_denied");
      }
      setPhase({ id: "syncing", done: 0 });
      const client = await finalizeLogin(flow, {
        code: callback.code,
        state: callback.state,
      });
      await complete(loginOf(client, flow));
    } catch (failure) {
      fail(failure);
    }
  };

  const message = error && (
    <p className={styles.error} role="alert">
      {t(error)}
    </p>
  );

  if (phase.id === "syncing") {
    const steps = ["login", ...SYNC_STEPS] as const;
    return (
      <div className={styles.step}>
        <h1 className={styles.title}>{t("onboarding.skolengo.syncTitle")}</h1>
        <p className={styles.text}>{t("onboarding.skolengo.syncText")}</p>
        <Spinner size="large" label={t("onboarding.skolengo.syncTitle")} />
        <Card rows className={skolengo.progress}>
          {steps.map((step, index) => (
            <SettingRow
              key={step}
              className={index > phase.done ? skolengo.todo : undefined}
              media={
                index < phase.done ? (
                  <span className={skolengo.doneIcon} aria-hidden="true">
                    <Check size={12} />
                  </span>
                ) : index === phase.done ? (
                  <Spinner />
                ) : (
                  <span className={skolengo.todoIcon} aria-hidden="true" />
                )
              }
              title={t(`onboarding.skolengo.steps.${step}`)}
            >
              {index < phase.done && (
                <span className={skolengo.doneText}>
                  {t("onboarding.skolengo.done")}
                </span>
              )}
            </SettingRow>
          ))}
        </Card>
      </div>
    );
  }

  return (
    <>
      <BackButton onClick={onBack} />
      <div className={styles.step}>
        <p className={styles.eyebrow}>
          {t("onboarding.skolengo.loginEyebrow")}
        </p>
        <h1 className={styles.title}>
          {t("onboarding.skolengo.loginTitle", { name: school.name })}
        </h1>
        <p className={styles.text}>{t("onboarding.skolengo.loginText")}</p>

        {phase.id === "waiting" ? (
          <Card className={skolengo.waiting} role="status">
            <Spinner />
            <span className={skolengo.waitingText}>
              {t("onboarding.skolengo.waiting")}
            </span>
          </Card>
        ) : (
          <InfoCard title={t("onboarding.skolengo.safeTitle")}>
            <p>{t("onboarding.skolengo.safeText")}</p>
          </InfoCard>
        )}
        {message}

        <footer className={styles.footer}>
          <Button
            variant="primary"
            size="large"
            disabled={phase.id === "waiting"}
            onClick={() => void open()}
          >
            {t(
              error ? "onboarding.skolengo.retry" : "onboarding.skolengo.open"
            )}
          </Button>
        </footer>
      </div>
    </>
  );
}
