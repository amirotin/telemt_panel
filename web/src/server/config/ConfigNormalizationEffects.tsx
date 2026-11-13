import type { TelemtConfigNormalization } from "../../lib/api/generated/types.gen";
import { useStrings } from "../../i18n";

export function ConfigNormalizationEffects({ effects }: { effects: TelemtConfigNormalization[] }) {
  const copy = useStrings().server.config.native;
  if (effects.length === 0) return null;
  return <div className="space-y-2">
    <strong className="text-meta">{copy.normalized}</strong>
    {effects.map((effect, index) => <p key={index} className="break-words text-meta">
      <code className="font-mono text-micro">{effect.path}</code>{": "}
      {(copy.normalizationCodes as Record<string, string>)[effect.code] ?? copy.normalizationCodes.normalized}
    </p>)}
  </div>;
}
