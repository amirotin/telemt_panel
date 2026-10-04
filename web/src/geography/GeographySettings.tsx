import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGeographySettingsOptions,
  getGeographySettingsQueryKey,
  putGeographySettingsMutation,
} from "../lib/api/generated/@tanstack/react-query.gen";
import type { ServerLocationConfig } from "../lib/api/generated/types.gen";
import { useStrings } from "../i18n";
import { Button } from "../ui/Button";
import { invalidateGeography } from "./queries";
import "./geography.css";

export function GeographySettings() {
  const strings = useStrings(),
    s = strings.geography,
    client = useQueryClient(),
    id = useId();
  const query = useQuery({ ...getGeographySettingsOptions(), staleTime: 10_000 });
  const [draft, setDraft] = useState<ServerLocationConfig | null>(null),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const active = draft ?? query.data?.server_location;
  const mutation = useMutation({
    ...putGeographySettingsMutation(),
    onSuccess: async (data) => {
      client.setQueryData(getGeographySettingsQueryKey(), data);
      setDraft(null);
      setError("");
      setSaved(true);
      await invalidateGeography(client);
    },
    onError: () => setError(s.settingsError),
  });
  function edit(next: ServerLocationConfig) {
    setDraft(next);
    setError("");
    setSaved(false);
  }
  function apply() {
    if (!active) return;
    if (
      [...active.label].length > 80 ||
      (active.mode === "manual" &&
        (active.latitude === null ||
          active.longitude === null ||
          !Number.isFinite(active.latitude) ||
          !Number.isFinite(active.longitude) ||
          Math.abs(active.latitude) > 90 ||
          Math.abs(active.longitude) > 180))
    ) {
      setError(s.settingsError);
      return;
    }
    mutation.mutate({ body: { server_location: active } });
  }
  return (
    <section className="geo-settings" aria-labelledby={`${id}-title`}>
      <header>
        <h2 id={`${id}-title`}>{s.settingsTitle}</h2>
        <p>{s.settingsNote}</p>
      </header>
      {query.isError && (
        <div role="alert" className="geo-banner geo-error">
          {s.error}
          <Button
            variant="ghost"
            onClick={() => {
              void query.refetch();
            }}
          >
            {strings.common.retry}
          </Button>
        </div>
      )}
      {!active ? (
        !query.isError && <p role="status">{strings.common.loading}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <fieldset disabled={mutation.isPending} className="geo-form">
            <legend className="sr-only">{s.settingsTitle}</legend>
            <div className="geo-segments">
              {(["hidden", "manual", "ip"] as const).map((mode) => (
                <label key={mode}>
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    checked={active.mode === mode}
                    onChange={() =>
                      edit({
                        ...active,
                        mode,
                        public_ip: mode === "ip" ? "" : null,
                        latitude: mode === "manual" ? 0 : null,
                        longitude: mode === "manual" ? 0 : null,
                      })
                    }
                  />
                  <span>{s.modes[mode]}</span>
                </label>
              ))}
            </div>
            <label>
              {s.label}
              <input
                value={active.label}
                maxLength={80}
                onChange={(event) => edit({ ...active, label: event.target.value })}
              />
            </label>
            {active.mode === "manual" && (
              <div className="geo-coordinate-fields">
                <label>
                  {s.latitude}
                  <input
                    type="number"
                    step="any"
                    min={-90}
                    max={90}
                    value={active.latitude ?? ""}
                    onChange={(event) =>
                      edit({
                        ...active,
                        latitude: event.target.value === "" ? null : Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  {s.longitude}
                  <input
                    type="number"
                    step="any"
                    min={-180}
                    max={180}
                    value={active.longitude ?? ""}
                    onChange={(event) =>
                      edit({
                        ...active,
                        longitude: event.target.value === "" ? null : Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
            )}
            {active.mode === "ip" && (
              <>
                <label>
                  {s.publicIP}
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={active.public_ip ?? ""}
                    onChange={(event) => edit({ ...active, public_ip: event.target.value })}
                  />
                </label>
                <p className="geo-note">{s.ipNote}</p>
              </>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="geo-error">
              {error}
            </p>
          )}
          {saved && <p role="status">{s.saved}</p>}
          <Button type="submit" disabled={mutation.isPending || !draft}>
            {strings.common.save}
          </Button>
        </form>
      )}
    </section>
  );
}
