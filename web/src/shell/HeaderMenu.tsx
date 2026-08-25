import { useState } from "react";
import { IconButton } from "../ui/IconButton";
import { Sheet } from "../ui/Sheet";
import { Button } from "../ui/Button";
import { ru } from "../i18n/ru";
import { ThemeToggle } from "../components/ThemeToggle";
import { DisplayModeSwitch } from "../display-mode";
import { useLogout } from "../auth/useLogout";

// HeaderMenu — the shell's minimal overflow menu: theme + display mode +
// sign out. Both switchers move to Сервер → Настройки once that page
// exists (Task 8); this is their only home for now (Task 4 brief).
export function HeaderMenu() {
  const [open, setOpen] = useState(false);
  const logout = useLogout();

  return (
    <>
      <IconButton aria-label={ru.shell.menu} onClick={() => setOpen(true)}>
        ⋮
      </IconButton>
      <Sheet open={open} onClose={() => setOpen(false)} title={ru.shell.menu}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-text-muted">{ru.displayMode.label}</span>
            <DisplayModeSwitch />
          </div>
          <ThemeToggle />
          <Button
            variant="secondary"
            onClick={() => logout.mutate({})}
            disabled={logout.isPending}
          >
            {ru.auth.signOut}
          </Button>
        </div>
      </Sheet>
    </>
  );
}
