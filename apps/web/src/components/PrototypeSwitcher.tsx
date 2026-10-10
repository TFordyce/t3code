// PROTOTYPE: floating variant switcher for throwaway UI prototypes. Never ships.
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

export function PrototypeSwitcher({
  variants,
  current,
  onChange,
  children,
}: {
  variants: ReadonlyArray<{ key: string; name: string }>;
  current: string;
  onChange: (key: string) => void;
  /** Extra prototype-only controls shown beside the variant label. */
  children?: ReactNode;
}) {
  const index = Math.max(
    0,
    variants.findIndex((variant) => variant.key === current),
  );
  const step = (delta: number) =>
    onChange(variants[(index + delta + variants.length) % variants.length]!.key);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.closest("input, textarea, select, [contenteditable='true']") !== null ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!import.meta.env.DEV) return null;
  const variant = variants[index]!;
  return (
    <div className="fixed bottom-4 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-2 rounded-full border-2 border-fuchsia-500 bg-zinc-950 px-2 py-1.5 text-xs text-white shadow-2xl">
      <span className="rounded-full bg-fuchsia-500 px-2 py-0.5 font-bold tracking-wide">
        PROTOTYPE
      </span>
      <button
        type="button"
        className="rounded-full p-1 hover:bg-white/15"
        aria-label="Previous variant"
        onClick={() => step(-1)}
      >
        <ChevronLeftIcon className="size-4" />
      </button>
      <span className="min-w-44 text-center font-medium">
        {variant.key} ({variant.name})
      </span>
      <button
        type="button"
        className="rounded-full p-1 hover:bg-white/15"
        aria-label="Next variant"
        onClick={() => step(1)}
      >
        <ChevronRightIcon className="size-4" />
      </button>
      {children}
    </div>
  );
}
