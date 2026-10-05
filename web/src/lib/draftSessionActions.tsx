import { useState } from "react";
import { useStrings } from "../i18n";
import { Button } from "../ui/Button";

export function DraftSessionActions({ conflict, onDiscard, onCopy, disabled = false }: {
  conflict: boolean;
  onDiscard: () => void;
  onCopy?: () => void;
  disabled?: boolean;
}) {
  const s = useStrings();
  const copy = s.server.config.toml;
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-warn/25 bg-warn/[0.045] p-3" role={conflict ? "status" : undefined}>
      {conflict && <><strong className="text-meta text-warn">{copy.remoteChanged}</strong><p className="text-micro text-text-muted">{copy.draftKept}</p></>}
      {confirming && <p className="text-meta text-text">{copy.discardConfirm}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={disabled} onClick={() => {
          if (!confirming) { setConfirming(true); return; }
          onDiscard(); setConfirming(false);
        }}>{copy.loadRemote}</Button>
        {(conflict || confirming) && <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>{copy.keepDraft}</Button>}
        {onCopy && <Button type="button" variant="secondary" onClick={onCopy}>{copy.copyDraft}</Button>}
      </div>
    </div>
  );
}
