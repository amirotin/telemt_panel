import { useState, type ReactNode } from "react";
import {
  Avatar,
  Button,
  Chip,
  CountBadge,
  IconButton,
  Input,
  Select,
  Stepper,
  Sheet,
  StatCard,
  KVRow,
  StatePill,
  QuotaBar,
  CopyField,
  QR,
  Sparkline,
  Skeleton,
  EmptyState,
  ErrorState,
  IconPlus,
  IconServer,
  IconSort,
  IconStar,
} from "../ui";
import { pushToast, ToastViewport } from "../ui/Toast";
import { ru } from "../i18n/ru";

// /dev/ui — dev-only primitive showcase, replaces Storybook per 06-ui.md.
// Every primitive, every documented state. Only ever imported behind the
// import.meta.env.DEV guard in routes/dev.ui.tsx, so this whole module
// (and its only-here-for-the-showcase code) is tree-shaken out of
// production builds.
export function UIShowcase() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [stepperValue, setStepperValue] = useState(3);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <h1 className="text-xl font-semibold text-text">/dev/ui — витрина примитивов</h1>

      <Section title="Button">
        <div className="flex flex-wrap gap-2">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm">Small primary</Button>
          <Button size="sm" variant="secondary">
            Small secondary
          </Button>
          <Button size="sm" variant="danger">
            Small danger
          </Button>
        </div>
      </Section>

      <Section title="IconButton">
        <div className="flex gap-2">
          <IconButton aria-label="Пример">
            <IconStar />
          </IconButton>
          <IconButton aria-label="Пример solid" variant="solid">
            <IconServer />
          </IconButton>
          <IconButton aria-label="Пример accent" variant="accent">
            <IconPlus />
          </IconButton>
          <IconButton aria-label="Пример disabled" disabled>
            <IconStar />
          </IconButton>
        </div>
      </Section>

      <Section title="Chip / CountBadge">
        <div className="flex flex-wrap items-center gap-2">
          <Chip active count={1234}>
            Все
          </Chip>
          <Chip count={51}>Онлайн</Chip>
          <Chip count={99}>Проблемы</Chip>
          <Chip icon={<IconSort className="h-3 w-3" />}>Активность</Chip>
        </div>
        <div className="flex items-center gap-2">
          <CountBadge>3</CountBadge>
          <CountBadge tone="error">стоп</CountBadge>
          <CountBadge tone="warn">срок</CountBadge>
          <CountBadge tone="muted">выкл</CountBadge>
        </div>
      </Section>

      <Section title="Avatar">
        <div className="flex flex-wrap items-center gap-3">
          {["marat", "lena", "work_backup", "family_pro", "olga_home", "kirill_tv_32"].map((n) => (
            <Avatar key={n} name={n} online />
          ))}
          <Avatar name="offline_user" tone="idle" />
          <Avatar name="over_quota" tone="alert" />
          <Avatar name="small" size="sm" online />
          <Avatar name="medium" size="md" />
        </div>
      </Section>

      <Section title="Input">
        <div className="flex max-w-xs flex-col gap-2">
          <Input placeholder="Обычный" />
          <Input placeholder="Моноширинный" monospace autoCapitalize="off" />
          <Input placeholder="Отключён" disabled />
        </div>
      </Section>

      <Section title="Select">
        <Select className="max-w-xs" defaultValue="gb">
          <option value="mb">МБ</option>
          <option value="gb">ГБ</option>
          <option value="inf">Без лимита</option>
        </Select>
      </Section>

      <Section title="Stepper">
        <Stepper value={stepperValue} onChange={setStepperValue} min={0} max={10} />
      </Section>

      <Section title="Sheet">
        <Button onClick={() => setSheetOpen(true)}>Открыть Sheet</Button>
        <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Пример Sheet">
          <p className="text-sm text-text-muted">
            Нижняя шторка на мобайле, модал на lg:. Escape и клик по фону закрывают.
          </p>
        </Sheet>
      </Section>

      <Section title="Toast">
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => pushToast("Обычное уведомление")}>
            Default
          </Button>
          <Button variant="secondary" onClick={() => pushToast("Успешно", "ok")}>
            Ok
          </Button>
          <Button variant="secondary" onClick={() => pushToast("Ошибка", "error")}>
            Error
          </Button>
        </div>
        <ToastViewport />
      </Section>

      <Section title="StatCard">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Соединения" value={128} />
          <StatCard
            label="Трафик"
            value="4.2 ГБ"
            delta="+3%"
            sparkline={<Sparkline values={[3, 5, 4, 8, 6, 9, 7, 10]} />}
          />
        </div>
      </Section>

      <Section title="KVRow">
        <div className="max-w-sm rounded-xl bg-surface px-3.5">
          <KVRow label="Версия" value="2.0.0-draft1" />
          <KVRow label="Секрет" value="a1b2c3d4e5f6" monospace />
        </div>
      </Section>

      <Section title="StatePill">
        <div className="flex gap-2">
          <StatePill state="ok">ok</StatePill>
          <StatePill state="warn">warn</StatePill>
          <StatePill state="error">error</StatePill>
          <StatePill state="muted">muted</StatePill>
        </div>
      </Section>

      <Section title="QuotaBar">
        <div className="flex max-w-xs flex-col gap-4">
          <QuotaBar usedBytes={2_500_000_000} limitBytes={10_000_000_000} />
          <QuotaBar usedBytes={9_800_000_000} limitBytes={10_000_000_000} />
          <QuotaBar usedBytes={11_000_000_000} limitBytes={10_000_000_000} />
          <QuotaBar usedBytes={5_000_000_000} limitBytes={null} />
        </div>
      </Section>

      <Section title="CopyField">
        <div className="max-w-sm">
          <CopyField label="Sub-ссылка" value="https://panel.example/sub/abc123def456" />
          <p className="mt-2 text-xs text-text-muted">
            Клик копирует через Clipboard API (HTTPS/localhost), иначе через
            execCommand, иначе выделяет значение и показывает тост
            «{ru.common.copyManually}» — см. src/lib/copyText.ts.
          </p>
        </div>
      </Section>

      <Section title="QR">
        <QR value="https://panel.example/sub/abc123def456" size={140} />
      </Section>

      <Section title="Sparkline">
        <Sparkline values={[1, 4, 2, 6, 3, 8, 5, 9, 7]} width={160} height={40} />
      </Section>

      <Section title="Skeleton">
        <div className="flex max-w-xs flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-20 w-full" />
        </div>
      </Section>

      <Section title="EmptyState">
        <EmptyState
          title="Пользователей пока нет"
          description="Создайте первого пользователя, чтобы выдать доступ"
          action={<Button>Создать</Button>}
        />
      </Section>

      <Section title="ErrorState">
        <ErrorState message="Не удалось загрузить данные" onRetry={() => {}} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default UIShowcase;
