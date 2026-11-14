import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/Button";
import { IconCheck, IconChevronDown, IconClose } from "../../ui/icons";

const VISIBLE_PROFILE_LIMIT = 3;
const DROPDOWN_USER_LIMIT = 20;

export interface WebUserChoices {
  usernames?: string[];
  usersPending?: boolean;
  usersError?: boolean;
  onRetryUsers?: () => void;
  onRequestUsers?: () => void;
}

export function WebProfilesField({ enabled, profiles, onChange, usernames = [], usersPending = false, usersError = false, onRetryUsers, onRequestUsers }: WebUserChoices & {
  enabled: boolean;
  profiles: Array<Record<string, unknown>>;
  onChange: (profiles: Array<Record<string, unknown>>) => void;
}) {
  const s = useStrings(), copy = s.server.config.catalog;
  const id = useId();
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const viewAction = useRef<HTMLButtonElement>(null);
  const dropdownToggle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const selected = useMemo(() => new Set(profiles.map((profile) => `${String(profile["user"])}\0${String(profile["secret_mode"])}`)), [profiles]);
  const selectedUsers = useMemo(() => [...new Set(profiles.map((profile) => String(profile["user"])))], [profiles]);
  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (selectedOnly ? selectedUsers : usernames).filter((name) => name.toLowerCase().includes(query));
  }, [search, selectedOnly, selectedUsers, usernames]);
  const choicesPending = !selectedOnly && usersPending;
  const choicesError = !selectedOnly && usersError;
  const options = choicesPending || choicesError ? [] : matches.slice(0, DROPDOWN_USER_LIMIT).flatMap((user) => ["plain", "dd"].filter((mode) => !selectedOnly || selected.has(`${user}\0${mode}`)).map((mode) => ({ user, mode })));
  const hiddenProfiles = Math.max(0, profiles.length - VISIBLE_PROFILE_LIMIT);
  const activeIndex = Math.min(active, options.length - 1);
  const activeId = open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!field.current || !input.current || !popup.current) return;
      const box = field.current.getBoundingClientRect();
      const inputBox = input.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const below = top + height - inputBox.bottom - 16, above = inputBox.top - top - 16;
      const down = below >= 180 || below >= above;
      const popupWidth = Math.min(box.width, Math.max(0, width - 24));
      popup.current.style.width = `${popupWidth}px`;
      popup.current.style.maxHeight = `${Math.max(0, Math.min(320, down ? below : above))}px`;
      popup.current.style.left = `${Math.max(left + 12, Math.min(box.left, left + width - popupWidth - 12))}px`;
      const popupHeight = popup.current.getBoundingClientRect().height;
      popup.current.style.top = `${Math.max(top + 12, down ? inputBox.bottom + 8 : inputBox.top - popupHeight - 8)}px`;
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (field.current) observer?.observe(field.current);
    if (popup.current) observer?.observe(popup.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !field.current?.contains(event.target) && !popup.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, search, selectedOnly, profiles.length]);

  const toggle = (user: string, mode: string) => {
    const exists = selected.has(`${user}\0${mode}`);
    onChange(exists ? profiles.filter((profile) => profile["user"] !== user || profile["secret_mode"] !== mode) : [...profiles, { user, secret_mode: mode }]);
    setSearch("");
    setActive(0);
    input.current?.focus();
  };
  const hint = enabled && profiles.length === 0 ? copy.webFirstProfileRequired : !enabled && profiles.length === 0 ? copy.webProfilesLater : selectedOnly ? copy.webSelectedProfilesHint : copy.webProfilesFieldHint;

  return <div className="mt-3">
    <div ref={field} className={cn("flex min-h-14 flex-wrap items-center gap-1.5 rounded-xl border bg-bg/30 p-1.5 transition-[border-color,box-shadow] focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/10", enabled && profiles.length === 0 ? "border-warn/40" : "border-border-strong")}>
      {profiles.slice(0, VISIBLE_PROFILE_LIMIT).map((profile, index) => {
        const user = String(profile["user"] ?? ""), mode = String(profile["secret_mode"] ?? "");
        return <span key={`${user}:${mode}`} className="inline-flex min-h-11 max-w-full items-center overflow-hidden rounded-lg border border-accent/15 bg-accent/8 pl-2.5 text-meta">
          <span className="min-w-0 truncate font-semibold text-text" title={user}>{user}</span>
          <span className="ml-2 rounded bg-surface/60 px-1.5 py-0.5 font-mono text-micro font-semibold text-accent">{mode}</span>
          <button type="button" className="ml-0.5 grid size-11 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-bad/10 hover:text-bad focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" aria-label={copy.webRemoveProfile.replace("{profile}", `${user} · ${mode}`)} onClick={() => { onChange(profiles.filter((_, item) => item !== index)); input.current?.focus(); }}><IconClose className="size-3.5" /></button>
        </span>;
      })}
      {hiddenProfiles > 0 && <button type="button" className="min-h-11 shrink-0 rounded-lg border border-border px-3 text-meta font-semibold tabular-nums text-accent transition-colors hover:bg-accent/8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" aria-label={copy.webHiddenProfiles.replace("{count}", String(hiddenProfiles))} onClick={() => { setSelectedOnly(true); setSearch(""); setActive(0); input.current?.focus(); setOpen(true); }}>+{hiddenProfiles}</button>}
      <div className="flex min-w-[150px] flex-1 items-center">
        <input ref={input} role="combobox" aria-label={copy.webProfilesTitle} aria-autocomplete="list" aria-expanded={open} aria-controls={open ? `${id}-listbox` : undefined} aria-activedescendant={activeId} aria-describedby={`${id}-hint`} autoComplete="off" autoCapitalize="off" spellCheck={false} value={search} placeholder={profiles.length ? copy.webAddMoreProfiles : copy.webChooseProfiles} className="h-11 min-w-0 flex-1 bg-transparent px-2 text-base text-text outline-none placeholder:text-text-faint" onFocus={() => { onRequestUsers?.(); setOpen(true); }} onChange={(event) => { setSearch(event.target.value); setActive(0); setOpen(true); }} onBlur={(event) => {
          if (event.relatedTarget instanceof Node && !field.current?.contains(event.relatedTarget) && !popup.current?.contains(event.relatedTarget)) setOpen(false);
        }} onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setActive(open ? Math.max(0, Math.min(options.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1))) : event.key === "ArrowDown" ? 0 : Math.max(0, options.length - 1));
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            const option = options[activeIndex];
            if (option) toggle(option.user, option.mode);
          } else if (event.key === "Escape") {
            event.preventDefault(); setOpen(false);
          } else if (event.key === "Tab") {
            if (open && !event.shiftKey && viewAction.current) { event.preventDefault(); viewAction.current.focus(); }
            else setOpen(false);
          }
        }} />
        <button ref={dropdownToggle} type="button" aria-label={copy.webToggleProfiles} aria-expanded={open} className="grid size-11 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => { const show = !open || selectedOnly; setSelectedOnly(false); input.current?.focus(); setOpen(show); }}><IconChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} /></button>
      </div>
    </div>
    <p id={`${id}-hint`} className={cn("mt-2 text-micro leading-relaxed", enabled && profiles.length === 0 ? "text-warn" : "text-text-faint")} role={enabled && profiles.length === 0 ? "status" : undefined}>{hint}</p>
    {usersError && <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-meta text-warn"><p className="min-w-0 flex-1">{copy.webUsersUnavailable}</p>{onRetryUsers && <Button type="button" variant="secondary" onClick={() => { onRetryUsers(); input.current?.focus(); setOpen(true); }}>{s.common.retry}</Button>}</div>}
    {open && createPortal(<div ref={popup} className="fixed z-[80] overflow-y-auto overscroll-contain rounded-xl border border-border-strong bg-surface p-1.5 shadow-xl" onMouseDown={(event) => event.preventDefault()}>
      {(hiddenProfiles > 0 || selectedOnly) && <div className="sticky top-0 z-10 flex min-h-11 items-center justify-between gap-2 border-b border-border bg-surface px-2 pb-1">
        <span className="min-w-0 text-micro font-semibold text-text-muted">{selectedOnly ? copy.webSelectedProfiles : copy.webProfileOptions}</span>
        <button ref={viewAction} type="button" className="min-h-11 shrink-0 rounded-lg px-2 text-meta font-semibold text-accent hover:bg-accent/8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => { setSelectedOnly(!selectedOnly); setSearch(""); setActive(0); input.current?.focus(); }} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); input.current?.focus(); setOpen(false); }
          else if (event.key === "Tab") {
            event.preventDefault();
            if (event.shiftKey) input.current?.focus();
            else { setOpen(false); dropdownToggle.current?.focus(); }
          }
        }}>{selectedOnly ? copy.webAllUsers : copy.webOnlySelected}</button>
      </div>}
      <div id={`${id}-listbox`} role="listbox" aria-label={selectedOnly ? copy.webSelectedProfiles : copy.webProfileOptions} aria-multiselectable="true">
        {options.map(({ user, mode }, index) => {
          const checked = selected.has(`${user}\0${mode}`);
          return <div key={`${user}:${mode}`} id={`${id}-option-${index}`} role="option" aria-label={`${user} · ${mode}`} aria-selected={checked} onPointerMove={(event) => { if (event.pointerType !== "touch") setActive(index); }} onClick={() => toggle(user, mode)} className={cn("flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-meta transition-colors", index === activeIndex ? "bg-accent/10" : "hover:bg-surface-2")}>
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg text-micro font-bold", checked ? "bg-accent/15 text-accent" : "bg-surface-2 text-text-muted")}>{user.slice(0, 1).toUpperCase()}</span>
            <span className="min-w-0 flex-1 truncate font-medium text-text">{user}</span>
            <span className={cn("rounded-md px-2 py-1 font-mono text-micro font-semibold", mode === "dd" ? "bg-accent/8 text-accent" : "bg-surface-2 text-text-muted")}>{mode}</span>
            <span className="grid size-5 shrink-0 place-items-center text-accent">{checked && <IconCheck className="size-4" />}</span>
          </div>;
        })}
      </div>
      {choicesPending ? <p role="status" className="px-3 py-4 text-meta text-text-muted">{s.common.loading}</p>
        : choicesError ? <p className="px-3 py-3 text-meta text-warn">{copy.webUsersUnavailable}</p>
        : options.length === 0 ? <p role="status" className="px-3 py-4 text-meta text-text-muted">{selectedOnly && selectedUsers.length === 0 ? copy.webNoSelectedProfiles : (selectedOnly ? selectedUsers : usernames).length ? copy.webUserNoMatch : copy.webNoAccessUsers}</p> : null}
      {!choicesPending && !choicesError && matches.length > DROPDOWN_USER_LIMIT && <p className="border-t border-border px-3 py-2 text-micro leading-relaxed text-text-faint">{copy.webUsersShown.replace("{shown}", String(DROPDOWN_USER_LIMIT)).replace("{total}", String(matches.length))}. {copy.webRefineUserSearch}</p>}
    </div>, document.body)}
  </div>;
}
