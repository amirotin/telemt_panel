import { useEffect, useState } from "react";

// useDebouncedValue delays reflecting `value` by `delayMs` — the list
// page's search input (06-ui.md: "поиск (имя, debounced)") filters against
// the debounced value, not every keystroke.
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
