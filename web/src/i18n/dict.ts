import type { ru } from "./ru";

// Widen strips the string-literal types `ru.ts`'s `as const` produces so
// another dictionary of the same SHAPE (en.ts) can be typed against it:
// without this, `Dict["nav"]["people"]` would be the literal "Люди" and no
// English translation could ever be assignable.
// The homomorphic mapped type also covers arrays: over a tuple it keeps the
// arity (byteUnits stays five slots, every PluralForms stays three), so
// en.ts must supply exactly as many entries. `readonly` is preserved — an
// object/array literal is still assignable to a readonly shape, and keeping
// it means neither dictionary can be mutated at runtime.
type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };

// Dict is the shape every UI dictionary must have. ru.ts stays the source
// of truth for the shape (06-ui.md: "словари-константы ru.ts/en.ts одной
// формы, типизированы от ru") — a key missing from en.ts is a compile
// error, and an extra one is rejected by the object-literal excess
// property check.
export type Dict = Widen<typeof ru>;

// Locale — the two UI languages the panel ships (06-ui.md §Дизайн-система).
export type Locale = "ru" | "en";

// LocalePreference is what the user picks in Настройки панели: an explicit
// language, or "auto" (follow the browser), which is the default.
export type LocalePreference = Locale | "auto";
