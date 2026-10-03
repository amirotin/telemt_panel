import type { LogSourceDiagnostic } from "../lib/api/generated/types.gen";
import { useStrings } from "../i18n";
import { Button } from "../ui/Button";

interface LogSourceErrorNoticeProps {
  diagnostic: LogSourceDiagnostic;
  onRetry: () => void;
  retryLabel?: string;
}

export function LogSourceErrorNotice({ diagnostic, onRetry, retryLabel }: LogSourceErrorNoticeProps) {
  const s = useStrings();
  return (
    <div role="alert" className="flex min-w-0 flex-col gap-3 rounded-xl border border-error/25 bg-error/8 p-4">
      <div>
        <h2 className="text-sm font-semibold text-error">{s.journal.sourceErrorTitle}</h2>
        <p className="mt-1 text-sm text-text-muted">{s.journal.sourceErrors[diagnostic.reason]}</p>
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta">
        <dt className="text-text-faint">{s.journal.sourceErrorSource}</dt>
        <dd className="min-w-0 break-all text-text-muted">{diagnostic.source}</dd>
        {diagnostic.target && <>
          <dt className="text-text-faint">{s.journal.sourceErrorTarget}</dt>
          <dd className="min-w-0 break-all font-mono text-text-muted">{diagnostic.target}</dd>
        </>}
        {diagnostic.exit_code !== undefined && <>
          <dt className="text-text-faint">{s.journal.sourceErrorExitCode}</dt>
          <dd className="text-text-muted">{diagnostic.exit_code}</dd>
        </>}
      </dl>
      <Button variant="secondary" size="sm" className="self-start" onClick={onRetry}>{retryLabel ?? s.journal.retryStream}</Button>
    </div>
  );
}
