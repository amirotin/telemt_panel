import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGeoIpSettingsOptions, getGeoIpSettingsQueryKey,
  putGeoIpSettingsMutation, updateGeoIpMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type { GeoIpConfig, GeoIpSettings } from "../../lib/api/generated/types.gen";
import { fill, localeOf, useStrings } from "../../i18n";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/Skeleton";
import { apiErrorMessage } from "../../people/apiError";
import { geoIPConfigError, geoIPKinds, normalizeGeoIPConfig, sameGeoIPConfig, switchGeoIPSource } from "./geoip.helpers";
import "./geoip.css";

export function GeoIPSettings() {
  const strings = useStrings();
  const s = strings.geoip;
  const locale = localeOf(strings);
  const client = useQueryClient();
  const query = useQuery({ ...getGeoIpSettingsOptions(), refetchInterval: query => query.state.data?.status.state === "updating" ? 1500 : 30_000 });
  const [draft, setDraft] = useState<GeoIpConfig | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState(false);
  const previousStatus = useRef(query.data?.status);
  useEffect(() => {
    if (previousStatus.current !== query.data?.status) {
      previousStatus.current = query.data?.status;
      void client.invalidateQueries({ queryKey: [{ _id: "getUserIpHistory" }] });
    }
  }, [query.data?.status, client]);

  function accepted(data: GeoIpSettings) {
    client.setQueryData(getGeoIpSettingsQueryKey(), data);
    setDraft(null); setError(""); setFeedback(true);
    void client.invalidateQueries({ queryKey: [{ _id: "getUserIpHistory" }] });
  }
  const save = useMutation({ ...putGeoIpSettingsMutation(), onSuccess: accepted, onError: error => setError(apiErrorMessage(error, strings)) });
  const update = useMutation({ ...updateGeoIpMutation(), onSuccess: accepted, onError: error => setError(apiErrorMessage(error, strings)) });
  const data = query.data;
  const config = draft ?? data?.config;
  const status = data?.status;
  const failure = status?.last_error && Object.hasOwn(s.failures, status.last_error)
    ? s.failures[status.last_error as keyof typeof s.failures] : s.errors.generic;
  const busy = save.isPending || update.isPending || status?.state === "updating";
  const changed = !!data && !!config && !sameGeoIPConfig(data.config, config);
  function edit(next: GeoIpConfig) { setDraft(next); setFeedback(false); setError(""); }
  function submit() {
    if (!config || busy) return;
    const body = normalizeGeoIPConfig({ ...config, enabled: true });
    const invalid = geoIPConfigError(body);
    if (invalid) { setError(s.errors[invalid]); return; }
    save.mutate({ body });
  }
  const date = (epoch: number) => {
    const value = new Date(epoch * 1000);
    return epoch > 0 && Number.isFinite(value.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(value) : "—";
  };

  return <section id="geoip" className="geoip-settings" aria-labelledby="geoip-title">
    <header className="geoip-heading"><h2 id="geoip-title">{s.title}</h2><p>{s.subtitle}</p></header>
    {!config || !status ? query.isError
      ? <div className="geoip-card geoip-section" role="alert"><p>{s.errors.load}</p><Button variant="secondary" onClick={() => void query.refetch()}>{s.errors.retry}</Button></div>
      : <Skeleton className="h-80 w-full rounded-2xl" />
      : <div className="geoip-layout">
        <form className="geoip-card" noValidate onSubmit={event => { event.preventDefault(); submit(); }}>
          <fieldset disabled={busy} className="geoip-form-fields">
            <legend className="sr-only">{s.title}</legend>
            <div className="geoip-section">
              <h3>{s.sourceTitle}</h3><p className="geoip-muted">{s.sourceNote}</p>
              <fieldset className="geoip-sources"><legend className="sr-only">{s.sourceLegend}</legend>
                {(["community", "urls", "files"] as const).map(source => <label key={source}>
                  <input type="radio" name="geoip-source" value={source} checked={config.source === source} onChange={() => edit(switchGeoIPSource(config, source))} />
                  <span><strong>{s.sources[source]}</strong><small>{s.sourceHints[source]}</small></span>
                  {source === "community" && <em>{s.defaultSource}</em>}
                </label>)}
              </fieldset>
              <p className="geoip-source-note">{s.sourceNotes[config.source]}</p>
            </div>
            <div className="geoip-section">
              <h3>{s.datasetsTitle}</h3>
              <div className="geoip-datasets">{geoIPKinds.map(kind => <label key={kind}>
                <input type="checkbox" data-geoip-kind={kind} aria-label={s.kinds[kind]} checked={config[kind].enabled} onChange={event => edit({ ...config, [kind]: { ...config[kind], enabled: event.target.checked } })} />
                <span><strong>{s.kinds[kind]}</strong><small>{s.kindHints[kind]}</small></span><b>{kind === "asn" ? "ASN" : kind === "city" ? "City" : "Country"}</b>
              </label>)}</div>
              {config.source !== "community" && <div className="geoip-fields">{geoIPKinds.filter(kind => config[kind].enabled).map(kind => <label key={`${config.source}-${kind}`}>
                <span>{s.kinds[kind]} · {config.source === "urls" ? "HTTPS" : ".mmdb"}</span>
                <input type="text" inputMode={config.source === "urls" ? "url" : "text"} autoComplete="off" spellCheck={false} maxLength={2048}
                  placeholder={config.source === "urls" ? `https://example.org/${kind}.mmdb` : `/srv/geoip/${kind}.mmdb`}
                  value={config[kind].location} onChange={event => edit({ ...config, [kind]: { ...config[kind], location: event.target.value } })} />
              </label>)}</div>}
            </div>
            {config.source !== "files" && <div className="geoip-section" data-geoip-schedule><label className="geoip-update">
              <span><strong>{s.scheduleTitle}</strong><small>{s.scheduleNote}</small></span>
              <select value={config.schedule} onChange={event => edit({ ...config, schedule: event.target.value as GeoIpConfig["schedule"] })}>
                {(["weekly", "daily", "manual"] as const).map(cadence => <option key={cadence} value={cadence}>{s.schedules[cadence]}</option>)}
              </select>
            </label></div>}
          </fieldset>
          <footer className="geoip-save-row">
            {error && <p className="geoip-error" role="alert">{error}</p>}
            <p role="status">{changed ? s.draftNote : feedback ? s.savedNote : data.config.enabled ? s.unchangedNote : s.initialNote}</p>
            <div>{changed && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setDraft(null); setError(""); }}>{s.reset}</Button>}
              <Button type="submit" disabled={busy || (data.config.enabled && !changed)}>{busy ? s.applying : data.config.enabled ? s.save : s.connect}</Button></div>
          </footer>
        </form>
        <aside className="geoip-sidebar">
          <section className="geoip-card geoip-status-card" aria-labelledby="geoip-status-title">
            <header><span className="geoip-status-mark" aria-hidden="true">◎</span><div><small>{s.current}</small><h3 id="geoip-status-title">{s.states[status.state]}</h3></div></header>
            <p className="geoip-state-note" role="status">{s.stateNotes[status.state]}</p>
            {status.state === "error" && <p className="geoip-error">{failure}</p>}
            {status.available && (status.state === "error" || status.state === "updating") && <p className="geoip-muted">{s.previousActive}</p>}
            {status.active_source && <p className="geoip-active-source" data-geoip-active-source>{s.sources[status.active_source]}</p>}
            {status.databases.map(db => <div className="geoip-db" key={db.kind}><strong>{s.kinds[db.kind]}</strong>
              <span>{fill(s.built, { date: date(db.build_epoch_secs) })}</span><small>{fill(s.loaded, { date: date(db.loaded_epoch_secs) })}</small>
            </div>)}
            {status.databases.length > 0 && <p className="geoip-age-note">{s.ageNote}</p>}
            {data.config.enabled && <div className="geoip-status-actions"><Button type="button" variant="secondary" data-geoip-update disabled={busy || changed} onClick={() => update.mutate({})}>{data.config.source === "files" ? s.reload : s.update}</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => save.mutate({ body: { ...data.config, enabled: false } })}>{s.disable}</Button></div>}
          </section>
          <section className="geoip-privacy"><h3>{s.privacyTitle}</h3><p>{s.privacyNote}</p><p>{s.independent}</p></section>
        </aside>
      </div>}
    <p className="geoip-attribution">{s.attribution} <a href="https://github.com/P3TERX/GeoLite.mmdb" target="_blank" rel="noreferrer">{s.sourceLink} ↗</a></p>
  </section>;
}
