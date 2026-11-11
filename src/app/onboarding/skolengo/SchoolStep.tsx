// Choisis ton établissement Skolengo : une recherche par nom, puis la liste des résultats.
import { GraduationHat } from "@getpapillon/papicons";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/Button/Button";
import { Card } from "@/components/Card/Card";
import { SearchField } from "@/components/SearchField/SearchField";
import { SettingRow } from "@/components/SettingRow/SettingRow";
import { Spinner } from "@/components/Spinner/Spinner";
import { useLookup } from "@/hooks/useLookup";
import { findSchools, type SkolengoSchool } from "@/services/skolengo/login";

import styles from "../onboarding.module.scss";
import { logFailure } from "./errors";
import skolengo from "./skolengo.module.scss";

/** L'écran n'affiche qu'un message général : le détail d'un échec va au journal. */
const search = (query: string) =>
  findSchools(query).catch((error: unknown) => {
    logFailure("recherche Skolengo", error);
    throw error;
  });

export function SchoolStep({
  onNext,
}: {
  onNext: (school: SkolengoSchool) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const text = query.trim();
  const lookup = useLookup(text.length >= 2 ? text : "", search);
  const schools = lookup.status === "ready" ? lookup.data : [];
  const chosen = schools.find(school => school.id === selected);

  return (
    <div className={`${styles.step} ${skolengo.step}`}>
      <p className={styles.eyebrow}>{t("onboarding.skolengo.eyebrow")}</p>
      <h1 className={styles.title}>{t("onboarding.skolengo.searchTitle")}</h1>
      <p className={styles.text}>{t("onboarding.skolengo.searchText")}</p>

      <SearchField
        size="large"
        value={query}
        onChange={setQuery}
        placeholder={t("onboarding.skolengo.searchPlaceholder")}
      />

      {lookup.status === "loading" && (
        <p className={skolengo.status}>
          <Spinner />
          {t("onboarding.skolengo.searching")}
        </p>
      )}
      {lookup.status === "error" && (
        <p className={styles.error} role="alert">
          {t("onboarding.skolengo.searchFailed")}
        </p>
      )}
      {lookup.status === "ready" && schools.length === 0 && (
        <p className={skolengo.status}>{t("onboarding.skolengo.noSchool")}</p>
      )}
      {schools.length > 0 && (
        <Card
          rows
          className={skolengo.schools}
          role="radiogroup"
          aria-label={t("onboarding.skolengo.searchTitle")}
        >
          {schools.map(school => (
            <SettingRow
              key={school.id}
              as="label"
              icon={GraduationHat}
              title={school.name}
              text={[school.city, school.postalCode]
                .filter(Boolean)
                .join(" · ")}
            >
              <input
                type="radio"
                name="skolengo-school"
                checked={school === chosen}
                onChange={() => setSelected(school.id)}
              />
            </SettingRow>
          ))}
        </Card>
      )}

      <footer className={styles.footer}>
        <Button
          variant="primary"
          size="large"
          disabled={!chosen}
          onClick={() => chosen && onNext(chosen)}
        >
          {t("onboarding.continue")}
        </Button>
      </footer>
    </div>
  );
}
