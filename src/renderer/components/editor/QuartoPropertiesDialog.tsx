import React, { useContext, useEffect, useRef, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { blockLabel, collectReferenceTargets, LABEL_PREFIXES, validFigureDimension, validQuartoLabel } from "@shared/quarto-references";
import { FigureDocumentContext, FigureImage } from "../../blocks/figure-image";
import { reloadFigure } from "../../blocks/figure-reload";
import { rpc } from "../../rpc";

const field = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const names: Record<string, string> = { heading: "Section", table: "Table", figure: "Figure", image: "Figure", math: "Equation" };

export function QuartoPropertiesDialog({ editor, blockId, onClose }: {
  editor: BlockNoteEditor<any, any, any>; blockId: string; onClose: () => void;
}) {
  const initial = editor.getBlock(blockId)!;
  const isFigure = initial.type === "figure" || initial.type === "image";
  const { projectPath, documentPath } = useContext(FigureDocumentContext);
  const [sourcePath, setSourcePath] = useState(String(initial.props.sourcePath ?? ""));
  const [sourceChanged, setSourceChanged] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [sourceNotice, setSourceNotice] = useState("");
  const [previewRevision, setPreviewRevision] = useState(0);
  const selectionGeneration = useRef(0);
  const scope = `${projectPath}\0${documentPath}\0${blockId}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  useEffect(() => {
    selectionGeneration.current++;
    return () => { selectionGeneration.current++; };
  }, [scope, editor]);
  const chooseFile = async () => {
    const generation = selectionGeneration.current;
    const current = () => generation === selectionGeneration.current && activeScope.current === scope;
    setSelecting(true);
    setSourceNotice("");
    try {
      const selected = await rpc.selectFigure(projectPath);
      if (!current() || !selected || !editor.getBlock(blockId)) return;
      setSourcePath(selected.sourcePath);
      setSourceChanged(true);
      setPreviewRevision((value) => value + 1);
      setSourceNotice(selected.copied ? "프로젝트에 복사했습니다. 이후에는 아래 경로의 파일을 수정하세요." : "Apply를 누르면 이 파일에 연결됩니다.");
    } catch (error) {
      if (current()) setSourceNotice(error instanceof Error ? error.message : "그림을 연결하지 못했습니다.");
    } finally {
      if (current()) setSelecting(false);
    }
  };
  const [label, setLabel] = useState(blockLabel(initial));
  const [caption, setCaption] = useState(String(initial.props.caption ?? ""));
  const [altText, setAltText] = useState(String(initial.props.altText ?? initial.props.name ?? ""));
  const [width, setWidth] = useState(String(initial.props.width ?? (Number(initial.props.previewWidth) > 0 ? `${initial.props.previewWidth}px` : "")));
  const [height, setHeight] = useState(String(initial.props.height ?? ""));
  const [alignment, setAlignment] = useState(String(initial.props.alignment ?? initial.props.textAlignment ?? "center"));
  const content = initial.type === "table" ? initial.content as any : null;
  const columnCount = content?.rows[0]?.cells.length ?? 0;
  const initialWidths: number[] = Array.from({ length: columnCount }, (_, index) => content.columnWidths?.[index] || 150);
  const sum = initialWidths.reduce((a, b) => a + b, 0);
  const [widths, setWidths] = useState(initialWidths.map((value) => String(Math.round(value / sum * 10000) / 100)));
  const [columnAlignments, setColumnAlignments] = useState<string[]>(content?.rows[0]?.cells.map((cell: any) => cell.props?.textAlignment ?? "left") ?? []);
  const [error, setError] = useState("");
  const prefix = LABEL_PREFIXES[initial.type];

  const apply = () => {
    const block = editor.getBlock(blockId);
    if (!block) { setError("This block was removed. Close properties and select another block."); return; }
    const normalized = label.trim().replace(/^#/, "");
    if (normalized && !validQuartoLabel(normalized, block.type)) {
      setError(`Use ${prefix}- followed by letters, numbers, or hyphens, for example ${prefix}-steady-state.`); return;
    }
    if (normalized && collectReferenceTargets(editor.document).some((target) => target.label === normalized && target.blockId !== blockId)) {
      setError(`The identifier ${normalized} is already used in this document.`); return;
    }
    if (!validFigureDimension(width.trim()) || !validFigureDimension(height.trim())) {
      setError("Enter a positive size such as 70%, 400px, or 10cm, or leave it blank for automatic sizing."); return;
    }
    const props: Record<string, unknown> = { label: normalized };
    if (isFigure) Object.assign(props, {
      url: block.props.url, sourcePath: block.props.sourcePath ?? "",
      ...(sourceChanged ? { sourcePath, url: "" } : {}),
      caption, altText, width: width.trim(), height: height.trim(), alignment,
    });
    if (block.type === "table") props.caption = caption;
    let nextContent: any;
    if (block.type === "table") {
      const table = block.content as any;
      if (table.rows[0]?.cells.length !== columnCount) { setError("The table's columns changed. Reopen properties to edit the current columns."); return; }
      const numeric = widths.map(Number);
      if (numeric.some((value) => !Number.isFinite(value) || value <= 0)) { setError("Every column width must be a positive number."); return; }
      const total = numeric.reduce((a, b) => a + b, 0);
      nextContent = { ...table, columnWidths: numeric.map((value) => value / total * 600),
        rows: table.rows.map((row: any) => ({ ...row, cells: row.cells.map((cell: any, index: number) => ({
          ...(Array.isArray(cell) ? { type: "tableCell", content: cell } : cell),
          props: { ...(cell.props ?? {}), textAlignment: columnAlignments[index] },
        })) })),
      };
    }
    editor.updateBlock(block, { ...(block.type === "image" ? { type: "figure" } : {}), props, ...(nextContent ? { content: nextContent } : {}) });
    if (isFigure) reloadFigure(editor, blockId);
    onClose();
  };

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto"
      onCloseAutoFocus={(event) => { event.preventDefault(); editor.focus(); }}>
      <DialogHeader>
        <DialogTitle>{names[initial.type]} properties</DialogTitle>
        <DialogDescription>{isFigure ? "그림 파일의 연결, 캡션과 표시 방식을 설정합니다." : "Set the reference identifier and how this block appears in Quarto output."}</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); apply(); }}>
        {isFigure && <fieldset className="space-y-2 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">그림 파일</legend>
          <FigureImage sourcePath={sourcePath} url={sourceChanged ? "" : String(initial.props.url ?? "")}
            alt={caption || "그림 미리보기"} inProperties reloadToken={previewRevision}
            style={{ maxHeight: 150, maxWidth: "100%", margin: "0 auto" }} />
          <p className="break-all text-xs text-muted-foreground">{sourcePath ||
            (initial.props.url ? "문서에 저장된 그림입니다. 로컬 파일을 선택해 연결할 수 있습니다." : "연결된 파일이 없습니다.")}</p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={!projectPath || selecting} onClick={chooseFile}>
              {selecting ? "파일 선택 중…" : sourcePath || initial.props.url ? "다시 연결" : "파일 선택"}
            </Button>
            <Button type="button" variant="outline" disabled={!sourcePath && !initial.props.url} onClick={() => {
              setPreviewRevision((value) => value + 1);
              if (!sourceChanged) reloadFigure(editor, blockId);
            }}>Reload</Button>
          </div>
          {sourcePath && <p className="text-xs text-muted-foreground">프로젝트 안의 이 파일을 수정하면 자동 반영됩니다.</p>}
          {sourceNotice && <p role="status" className="text-xs text-muted-foreground">{sourceNotice}</p>}
        </fieldset>}
        <label className="block space-y-1 text-sm font-medium">Identifier
          <div className="flex gap-2">
            <input aria-label="Identifier" className={field} value={label} placeholder={`${prefix}-steady-state`}
              autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
              onChange={(event) => setLabel(event.target.value)} />
            <Button type="button" variant="outline" onClick={() => setLabel(`${prefix}-${blockId.replace(/[^\w-]/g, "")}`)}>Generate</Button>
          </div>
          <span className="block text-xs font-normal text-muted-foreground">Use @{label.trim().replace(/^#/, "") || `${prefix}-steady-state`} to refer to this block. Final numbering is assigned by Quarto.</span>
        </label>
        {(isFigure || initial.type === "table") && <label className="block space-y-1 text-sm font-medium">Caption
          <textarea aria-label="Caption" rows={2} className={field} value={caption} onChange={(event) => setCaption(event.target.value)} />
        </label>}
        {isFigure && <>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm font-medium">Width<input aria-label="Width" className={field} value={width} placeholder="Auto · e.g. 70%" onChange={(event) => setWidth(event.target.value)} /></label>
            <label className="space-y-1 text-sm font-medium">Height<input aria-label="Height" className={field} value={height} placeholder="Auto · e.g. 5cm" onChange={(event) => setHeight(event.target.value)} /></label>
          </div>
          <p className="text-xs text-muted-foreground">Set only width to preserve the image's proportions. Units: %, px, cm, mm, in, pt.</p>
          <label className="block space-y-1 text-sm font-medium">Figure alignment
            <select aria-label="Figure alignment" className={field} value={alignment} onChange={(event) => setAlignment(event.target.value)}>
              {['left', 'center', 'right'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="block space-y-1 text-sm font-medium">Alternative text
            <input aria-label="Alternative text" className={field} value={altText} onChange={(event) => setAltText(event.target.value)} />
          </label>
        </>}
        {initial.type === "table" && <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Columns</legend>
          <p className="text-xs text-muted-foreground">Widths are relative shares. For example, 30 and 70 give 30% and 70%. Alignment applies to every cell in the column.</p>
          {widths.map((value, index) => <div key={index} className="grid grid-cols-[5rem_1fr_1fr] items-center gap-2">
            <span className="text-sm">Column {index + 1}</span>
            <input type="number" min="0.01" step="any" aria-label={`Column ${index + 1} width`} className={field} value={value}
              onChange={(event) => setWidths((old) => old.map((item, i) => i === index ? event.target.value : item))} />
            <select aria-label={`Column ${index + 1} alignment`} className={field} value={columnAlignments[index]}
              onChange={(event) => setColumnAlignments((old) => old.map((item, i) => i === index ? event.target.value : item))}>
              {['left', 'center', 'right'].map((align) => <option key={align} value={align}>{align}</option>)}
            </select>
          </div>)}
        </fieldset>}
        {blockLabel(initial) && label.trim().replace(/^#/, "") !== blockLabel(initial) &&
          <p className="text-xs text-muted-foreground">Existing references use @{blockLabel(initial)}. Update those references if you change this identifier.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={selecting}>Apply</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
