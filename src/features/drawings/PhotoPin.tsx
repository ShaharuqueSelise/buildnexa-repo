// Pinning a daily log photo on a drawing (Phase 3 small gap): the "Pinned on A-101" chip and the
// sheet picker that starts it. The picker opens the sheet in "place this photo" mode
// (/drawings/<sheetId>?placePhoto=<photoId>), where one tap on the sheet saves the pin
// (functions/drawings, recordType "photo"). Used by the daily log's photo card and the Photos
// gallery; who may pin is checked again by the drawings Function.
import { useMemo, useState } from "react";
import { FileImage, MapPin, Search } from "lucide-react";
import { Button, Dialog, Note, fmt } from "../../shared/m/ui";
import { useDrawings } from "./drawingsApi";
import type { PhotoPinPlace } from "./drawingsApi";
import { errorText } from "./DrawingsPage";
import type { T } from "./DrawingsPage";

/** "Pinned on A-101": opens the sheet with the pin selected. */
export function PinnedChip({ place, onNavigate, t }: { place: PhotoPinPlace; onNavigate: (path: string) => void; t: T }) {
  return (
    <button type="button" className="m-link m-small m-pin-chip" onClick={() => onNavigate(`/drawings/${encodeURIComponent(place.sheetId)}?pin=${encodeURIComponent(place.pinId)}`)}>
      <MapPin size={12} /> {fmt(t("drw.photo.pinnedOn"), { sheet: place.sheetNumber })}
    </button>
  );
}

/** Choose the sheet the photo was taken on; the sheet then opens ready for one tap. */
export function PinPhotoDialog({ projectId, photoId, onNavigate, onClose, t }: {
  projectId: string; photoId: string; onNavigate: (path: string) => void; onClose: () => void; t: T;
}) {
  const register = useDrawings(projectId);
  const [q, setQ] = useState("");
  const sheets = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (register.data?.sheets ?? [])
      .filter((s) => s.current)
      .filter((s) => words.every((w) => `${s.sheetNumber} ${s.title} ${s.discipline}`.toLowerCase().includes(w)));
  }, [register.data, q]);
  const pick = (sheetId: string) => {
    onClose();
    onNavigate(`/drawings/${encodeURIComponent(sheetId)}?placePhoto=${encodeURIComponent(photoId)}`);
  };
  return (
    <Dialog title={<span className="m-row"><MapPin size={17} /> {t("drw.photo.pickTitle")}</span>} onClose={onClose} size="md"
      footer={<Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>}>
      <div className="m-stack-v">
        <p className="m-small m-muted" style={{ margin: 0 }}>{t("drw.photo.pickHint")}</p>
        <label className="m-pin-search">
          <Search size={15} />
          <input className="m-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("drw.photo.searchSheets")} autoFocus />
        </label>
        {register.error ? <Note tone="danger">{errorText(t, register.error)}</Note>
          : !register.data ? (
            <div className="m-pin-sheets" role="status" aria-label={t("common.loading")}>
              {[0, 1, 2].map((i) => (
                <div key={i} className="m-pin-sheet m-pin-sheet-skel" aria-hidden="true">
                  <span className="m-pin-sheet-blank" />
                  <span className="m-pin-sheet-text"><i style={{ width: 54 }} /><i style={{ width: 150 + i * 30 }} /></span>
                </div>
              ))}
            </div>
          )
          : sheets.length === 0 ? <span className="m-muted m-small">{register.data.sheets.length ? t("drw.photo.noMatch") : t("drw.photo.noSheets")}</span>
          : (
            <div className="m-pin-sheets">
              {sheets.slice(0, 60).map((s) => (
                <button key={s.ItemId} type="button" className="m-pin-sheet" onClick={() => pick(s.ItemId)}>
                  {s.current?.thumbUrl ? <img src={s.current.thumbUrl} alt="" loading="lazy" /> : <span className="m-pin-sheet-blank"><FileImage size={18} /></span>}
                  <span className="m-pin-sheet-text">
                    <b className="m-mono">{s.sheetNumber}</b>
                    <small>{s.title}{s.current ? ` · ${fmt(t("drw.rev"), { label: s.current.revisionLabel })}` : ""}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
      </div>
    </Dialog>
  );
}
