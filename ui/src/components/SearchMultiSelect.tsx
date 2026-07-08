import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SelectOption } from "@/lib/types";

function splitCsv(s: string) {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

interface SearchMultiSelectProps {
  label?: string;
  options: SelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function SearchMultiSelect({
  label,
  options,
  selected,
  onChange,
  disabled,
  placeholder = "Type to search…",
}: SearchMultiSelectProps) {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const selectedSet = React.useMemo(() => new Set(selected), [selected]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  }, [options, query]);

  React.useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, []);

  const toggle = (value: string) => {
    const next = selectedSet.has(value) ? selected.filter((v) => v !== value) : [...selected, value];
    onChange(next);
  };

  const selectedLabels = React.useMemo(() => {
    const byValue = new Map(options.map((o) => [o.value, o]));
    return selected.map((v) => byValue.get(v)?.label ?? v);
  }, [options, selected]);

  return (
    <div ref={rootRef} className="grid gap-2">
      {label && <span className="text-sm font-medium leading-none">{label}</span>}
      <div
        className={[
          "min-h-10 w-full rounded-md border border-input bg-background px-2 py-1",
          disabled ? "opacity-50 pointer-events-none" : "",
        ].join(" ")}
      >
        <div className="flex flex-wrap gap-2 items-center">
          {selected.map((value) => {
            const idx = selected.indexOf(value);
            const chipLabel = selectedLabels[idx] || value;
            return (
              <Badge key={value} variant="secondary" className="gap-1">
                {chipLabel}
                <button
                  type="button"
                  className="ml-1 text-muted-foreground hover:text-foreground"
                  onClick={() => toggle(value)}
                  aria-label={`Remove ${chipLabel}`}
                >
                  ×
                </button>
              </Badge>
            );
          })}

          <input
            ref={inputRef}
            className="flex-1 min-w-[8rem] bg-transparent outline-none text-sm py-2"
            value={query}
            placeholder={selected.length ? "" : placeholder}
            disabled={disabled}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
          />
        </div>

        {open && (
          <div className="relative">
            <div className="absolute z-50 mt-2 left-0 right-0 rounded-md border bg-card shadow-sm">
              <div className="max-h-56 overflow-y-auto">
                {filtered.length === 0 ? (
                  <div className="p-3 text-sm text-muted-foreground">No matches</div>
                ) : (
                  filtered.map((o) => {
                    const isSelected = selectedSet.has(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => toggle(o.value)}
                        className={[
                          "w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2",
                          isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent",
                        ].join(" ")}
                      >
                        <span className="truncate">{o.label}</span>
                        {isSelected && <span className="text-muted-foreground">✓</span>}
                      </button>
                    );
                  })
                )}
              </div>

              <div className="p-2 border-t text-xs text-muted-foreground">
                {selected.length ? `${selected.length} selected` : "Select options"}
              </div>
            </div>
          </div>
        )}
      </div>

      <input type="hidden" value={splitCsv(selected.join(","))} />
    </div>
  );
}

