import { useMemo, useRef, useState, type ReactNode } from 'react';
import { parseTabular, type Parsed } from '../lib/importParse';
import { autoMap, type ImportField } from '../lib/importMap';

export interface ImportResult { inserted: number; skipped?: number; error?: string; }

interface Props {
  title: string;
  fields: ImportField[];
  onClose: () => void;
  onImport: (rows: Record<string, string>[]) => Promise<ImportResult>;
  intro?: ReactNode;   // e.g. "Formato Buildertrend (Cost Catalog / Vendors)…"
  extra?: ReactNode;   // extra controls shown above the import button
}

export function ImportDialog({ title, fields, onClose, onImport, intro, extra }: Props) {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [fileName, setFileName] = useState('');
  const [map, setMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    setErr(null); setResult(null);
    try {
      const p = await parseTabular(file);
      if (!p.headers.length) throw new Error('Não encontrei cabeçalhos na primeira linha.');
      setParsed(p); setFileName(file.name); setMap(autoMap(p.headers, fields));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  // Build {fieldKey: value} rows from the current column mapping.
  const mappedRows = useMemo(() => {
    if (!parsed) return [];
    return parsed.rows.map((r) => {
      const o: Record<string, string> = {};
      for (const f of fields) {
        const col = map[f.key];
        const idx = col ? parsed.headers.indexOf(col) : -1;
        o[f.key] = idx >= 0 ? (r[idx] ?? '') : '';
      }
      return o;
    }).filter((o) => fields.some((f) => f.required && o[f.key].trim() !== '') || fields.every((f) => !f.required));
  }, [parsed, map, fields]);

  const missingRequired = fields.filter((f) => f.required && !map[f.key]);

  async function doImport() {
    setBusy(true); setErr(null);
    try {
      const valid = mappedRows.filter((o) => fields.every((f) => !f.required || o[f.key].trim() !== ''));
      const res = await onImport(valid);
      setResult(res);
      if (res.error) setErr(res.error);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const previewFields = fields;
  const preview = mappedRows.slice(0, 6);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="link" onClick={onClose}>✕</button>
        </header>

        {intro && <div className="import-intro muted small">{intro}</div>}

        {!parsed ? (
          <div className="import-drop">
            <input ref={inputRef} type="file" accept=".csv,.tsv,.xlsx"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            <p className="muted small">Aceita <strong>.xlsx</strong> (Excel/Buildertrend), <strong>.csv</strong> e <strong>.tsv</strong>.</p>
          </div>
        ) : (
          <>
            <p className="small"><strong>{fileName}</strong> — {parsed.rows.length} linha(s) detectada(s).
              <button className="link" onClick={() => { setParsed(null); setResult(null); setErr(null); }}> trocar arquivo</button>
            </p>

            <div className="map-grid">
              {fields.map((f) => (
                <label key={f.key} className="map-row">
                  <span>{f.label}{f.required && <b className="req"> *</b>}</span>
                  <select value={map[f.key] ?? ''} onChange={(e) => setMap({ ...map, [f.key]: e.target.value })}>
                    <option value="">— ignorar —</option>
                    {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </label>
              ))}
            </div>

            <div className="tablewrap">
              <table className="table small">
                <thead><tr>{previewFields.map((f) => <th key={f.key}>{f.label}</th>)}</tr></thead>
                <tbody>
                  {preview.map((o, i) => (
                    <tr key={i}>{previewFields.map((f) => <td key={f.key}>{o[f.key] || <span className="muted">—</span>}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            {mappedRows.length > preview.length && <p className="muted small">… e mais {mappedRows.length - preview.length} linha(s).</p>}

            {extra}

            {missingRequired.length > 0 &&
              <p className="error small">Mapeie os campos obrigatórios: {missingRequired.map((f) => f.label).join(', ')}.</p>}

            {result && !result.error &&
              <p className="success">Importado: {result.inserted} registro(s){result.skipped ? ` · ${result.skipped} ignorado(s)` : ''}.</p>}
          </>
        )}

        {err && <p className="error">{err}</p>}

        <div className="row-actions modal-foot">
          <button className="btn" onClick={onClose}>{result && !result.error ? 'Fechar' : 'Cancelar'}</button>
          {parsed && !(result && !result.error) &&
            <button className="btn primary" disabled={busy || missingRequired.length > 0 || mappedRows.length === 0} onClick={doImport}>
              {busy ? 'Importando…' : `Importar ${mappedRows.length} linha(s)`}
            </button>}
        </div>
      </div>
    </div>
  );
}
