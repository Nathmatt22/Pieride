// Le parcours Skolengo, chargé à la demande : skolengojs et ses dépendances ne servent qu'à
// se connecter. Les écrans l'importent d'ici, jamais directement.
import { type ComponentProps, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "@/components/Spinner/Spinner";

export type { SkolengoRelink } from "./SkolengoFlow";

const Flow = lazy(() =>
  import("./SkolengoFlow").then(module => ({ default: module.SkolengoFlow }))
);

export function SkolengoFlow(props: ComponentProps<typeof Flow>) {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<Spinner size="large" label={t("app.loading")} />}>
      <Flow {...props} />
    </Suspense>
  );
}
