import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { Button } from "./Button";

export interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  className?: string;
}

// ErrorState — human-readable error + retry (06-ui.md's mandatory "error"
// state: an envelope error code turned into Russian text by the caller,
// never the raw {code,message} shown verbatim).
export function ErrorState({ message, onRetry, className }: ErrorStateProps) {
  const s = useStrings();
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-error/25 bg-error/8 px-6 py-8 text-center",
        className,
      )}
    >
      <p className="text-sm text-error">{message}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          {s.common.retry}
        </Button>
      )}
    </div>
  );
}
