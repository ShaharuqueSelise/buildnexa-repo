// The header's project switcher (PRJ-04), as in the demo app's top bar (mock/src/mock/MockApp.tsx).
import { useEffect, useRef, useState } from "react";
import { Building2, ChevronDown, LayoutGrid } from "lucide-react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { Badge, cx } from "../../shared/m/ui";
import { hueOf, setCurrentProject, stageOf, useProjects } from "./projectsApi";
import type { Stage } from "./projectsApi";

const swatch = (p: { ItemId: string; number: string }) => {
  const hue = hueOf(p);
  return `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${hue + 30} 60% 35%))`;
};
const TONE: Record<Stage, "purple" | "blue" | "amber" | "gray"> = { preconstruction: "purple", construction: "blue", closeout: "amber", archived: "gray" };

export function ProjectSwitcher({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useT();
  const { projects, project, canCreate, query } = useProjects();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (query.isLoading || !query.data) return null;
  const stageLabel = (s: Stage) => t(`prj.stage.${s}`);

  return (
    <div className="m-rel" ref={ref}>
      <button className="m-project-switch" onClick={() => setOpen(!open)}>
        {project ? (
          <>
            <span className="m-proj-swatch" style={{ background: swatch(project) }} />
            <span style={{ minWidth: 0 }}><b>{project.name}</b><small>{project.number} · {stageLabel(stageOf(project))}</small></span>
          </>
        ) : (
          <span style={{ minWidth: 0 }}><b>{t("prj.noneTitle")}</b><small>{t("prj.title")}</small></span>
        )}
        <ChevronDown size={15} />
      </button>
      {open ? (
        <div className="m-popover" style={{ top: 48, left: 0, width: 340 }}>
          <div className="m-popover-title">{t("prj.switchTitle")}</div>
          {projects.map((p) => (
            <button key={p.ItemId} className={cx("m-popover-item", p.ItemId === project?.ItemId && "m-on")} onClick={() => { setCurrentProject(p.ItemId); setOpen(false); }}>
              <span className="m-proj-swatch" style={{ width: 26, height: 26, borderRadius: 6, flex: "0 0 26px", background: swatch(p) }} />
              <span style={{ flex: 1 }}>{p.name}<small>{[p.number, p.address?.city].filter(Boolean).join(" · ")}</small></span>
              <Badge tone={TONE[stageOf(p)]}>{stageLabel(stageOf(p))}</Badge>
            </button>
          ))}
          <hr className="m-sep" style={{ margin: "6px 0" }} />
          <button className="m-popover-item" onClick={() => { onNavigate("/projects"); setOpen(false); }}><LayoutGrid size={15} /> {t("prj.title")}</button>
          {canCreate ? <button className="m-popover-item" onClick={() => { onNavigate("/projects?new=1"); setOpen(false); }}><Building2 size={15} /> {t("prj.newEllipsis")}</button> : null}
        </div>
      ) : null}
    </div>
  );
}
