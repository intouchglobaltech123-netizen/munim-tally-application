'use client';

import { useEffect, useState } from 'react';
import { useApi } from '../lib/useApi';
import { post, patch, del, type SavedView, type ViewConfig } from '../lib/api';
import { toCsv, downloadCsv, exportName, type Column } from '../lib/csv';
import { Badge, Button, Card } from './ui';
import { printDocument } from '../lib/share';
import ShareButton from './ShareButton';
import {
  Bookmark, BookmarkPlus, Check, Columns3, Download, Printer, Star, Trash2,
  X, Users, Settings2,
} from 'lucide-react';

/**
 * Saving how a report is arranged, and getting it out.
 *
 * The same strip appears above every report, so an accountant learns it once.
 * A view is personal by default - one person's preferred columns are not an
 * opinion the whole business should inherit.
 */
export default function ReportToolbar<T>({
  report, title, config, onConfig, columns, rows, allColumns, company, period,
}: {
  report: string;
  title: string;
  config: ViewConfig;
  onConfig: (c: ViewConfig) => void;
  /** The columns as currently displayed, for export. */
  columns: Column<T>[];
  rows: T[];
  /** Everything this report could show, for the column chooser. */
  allColumns?: { key: string; label: string }[];
  company?: string;
  period?: string;
}) {
  const views = useApi<{ views: SavedView[] }>(`/v1/views?report=${report}`, [report]);
  const [saving, setSaving] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [picker, setPicker] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

  /*
   * Open the default view once, on arrival.
   *
   * Guarded on `applied` so it does not fight the user: without it, every
   * change they make would be undone by this effect firing again.
   */
  useEffect(() => {
    if (applied || !views.data) return;
    const def = views.data.views.find((v) => v.isDefault);
    if (def) {
      onConfig(def.config);
      setApplied(def.id);
    } else {
      setApplied('none');
    }
  }, [views.data, applied, onConfig]);

  async function save(asDefault: boolean) {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await post('/v1/views', { report, name: name.trim(), config, isDefault: asDefault });
      setName(''); setNaming(false);
      views.reload();
    } finally { setSaving(false); }
  }

  function exportCsv() {
    downloadCsv(exportName(title, company, period), toCsv(rows, columns));
  }

  const shown = new Set(config.columns ?? allColumns?.map((c) => c.key) ?? []);

  return (
    <div className="no-print mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Saved views */}
        {views.data && views.data.views.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Bookmark size={14} className="text-slate-400" />
            {views.data.views.map((v) => (
              <span key={v.id} className="group inline-flex items-center rounded-lg
                                          bg-slate-100 transition hover:bg-slate-200">
                <button onClick={() => { onConfig(v.config); setApplied(v.id); }}
                  title={v.mine ? 'Your view' : `Shared by ${v.owner}`}
                  className={`py-1.5 pl-2.5 pr-1 text-xs font-semibold ${
                    applied === v.id ? 'text-brand-700' : 'text-slate-600'}`}>
                  {v.isDefault && <Star size={10} className="mr-1 inline fill-amber-400 text-amber-500" />}
                  {!v.mine && <Users size={10} className="mr-1 inline text-slate-400" />}
                  {v.name}
                </button>
                {v.mine && (
                  <button onClick={async () => { await del(`/v1/views/${v.id}`); views.reload(); }}
                    title="Delete this view" className="py-1.5 pl-0.5 pr-2">
                    <X size={11} className="text-slate-400 opacity-0 transition
                                            group-hover:opacity-100 hover:text-rose-600" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {allColumns && allColumns.length > 0 && (
            <Button variant="ghost" icon={Columns3} onClick={() => setPicker(!picker)}>
              Columns
            </Button>
          )}
          <Button variant="ghost" icon={BookmarkPlus} onClick={() => setNaming(!naming)}>
            Save view
          </Button>
          <Button variant="ghost" icon={Download} onClick={exportCsv}>CSV</Button>
          <Button variant="ghost" icon={Printer} onClick={() => printDocument(title)}>Print / PDF</Button>
          <ShareButton kind="report" subject={title} label="Share" compact
            extra={{
              period,
              // The lines as displayed, so what is shared matches the screen.
              lines: rows.slice(0, 40).map((r) =>
                columns.map((c) => `${c.label}: ${c.value(r) ?? ''}`).join(' · ')),
            }} />
        </div>
      </div>

      {naming && (
        <Card>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1">
              <label className="text-xs font-semibold text-slate-600">Name this view</label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Month end, no opening column"
                onKeyDown={(e) => { if (e.key === 'Enter') save(false); }}
                autoFocus
                className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm
                           outline-none focus:border-brand-500" />
            </div>
            <Button onClick={() => save(false)} disabled={saving || !name.trim()}>Save</Button>
            <Button variant="ghost" icon={Star} onClick={() => save(true)}
              disabled={saving || !name.trim()}>
              Save as default
            </Button>
            <Button variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Saves the columns, sorting and filters you have now. Only you see it
            unless you share it.
          </p>
        </Card>
      )}

      {picker && allColumns && (
        <Card>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-600">
            <Settings2 size={13} /> Which columns to show
          </div>
          <div className="flex flex-wrap gap-1.5">
            {allColumns.map((c) => {
              const on = shown.has(c.key);
              return (
                <button key={c.key}
                  onClick={() => {
                    const next = on
                      ? [...shown].filter((k) => k !== c.key)
                      : [...shown, c.key];
                    // At least one column, or the report becomes a blank page.
                    if (next.length === 0) return;
                    onConfig({ ...config, columns: next });
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5
                              text-xs font-semibold transition ${
                    on ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600'}`}>
                  {on && <Check size={11} />} {c.label}
                </button>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
