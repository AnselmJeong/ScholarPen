import React, { useContext, useEffect, useRef, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { StackItem } from "@astryxdesign/core/Layout";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { AppDialog } from "@/components/ui/app-dialog";
import { blockLabel, collectReferenceTargets, LABEL_PREFIXES, validFigureDimension, validQuartoLabel } from "@shared/quarto-references";
import { FigureDocumentContext, FigureImage } from "../../../renderer/blocks/figure-image";
import { reloadFigure } from "../../../renderer/blocks/figure-reload";
import { rpc } from "../../../renderer/rpc";

const ALIGNMENTS = ["left", "center", "right"].map((value) => ({ value, label: value }));
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
  // Return the caret to the manuscript once the dialog is gone.
  const close = () => { onClose(); setTimeout(() => editor.focus(), 0); };

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
    close();
  };

  const currentLabel = label.trim().replace(/^#/, "");
  return <AppDialog isOpen onOpenChange={(open) => { if (!open) close(); }} purpose="form" width={560}
    title={`${names[initial.type]} properties`}
    subtitle={isFigure ? "그림 파일의 연결, 캡션과 표시 방식을 설정합니다." : "Set the reference identifier and how this block appears in Quarto output."}
    footerStart={error ? <p role="alert" className="text-xs text-destructive">{error}</p> : undefined}
    footer={<>
      <Button label="Cancel" variant="secondary" onClick={close} />
      <Button label="Apply" variant="primary" isDisabled={selecting} onClick={apply} />
    </>}>
    {isFigure && <Card variant="muted" padding={3}>
      <VStack gap={2}>
        <Heading level={4}>그림 파일</Heading>
        <FigureImage sourcePath={sourcePath} url={sourceChanged ? "" : String(initial.props.url ?? "")}
          alt={caption || "그림 미리보기"} inProperties reloadToken={previewRevision}
          style={{ maxHeight: 150, maxWidth: "100%", margin: "0 auto" }} />
        <Text type="supporting" display="block" wordBreak="break-all">{sourcePath ||
          (initial.props.url ? "문서에 저장된 그림입니다. 로컬 파일을 선택해 연결할 수 있습니다." : "연결된 파일이 없습니다.")}</Text>
        <HStack gap={2}>
          <Button variant="secondary" size="sm" isDisabled={!projectPath || selecting} isLoading={selecting} onClick={chooseFile}
            label={selecting ? "파일 선택 중…" : sourcePath || initial.props.url ? "다시 연결" : "파일 선택"} />
          <Button label="Reload" variant="secondary" size="sm" isDisabled={!sourcePath && !initial.props.url} onClick={() => {
            setPreviewRevision((value) => value + 1);
            if (!sourceChanged) reloadFigure(editor, blockId);
          }} />
        </HStack>
        {sourcePath && <Text type="supporting" display="block">프로젝트 안의 이 파일을 수정하면 자동 반영됩니다.</Text>}
        {sourceNotice && <Text type="supporting" display="block" role="status">{sourceNotice}</Text>}
      </VStack>
    </Card>}
    <HStack gap={2} vAlign="end">
      <StackItem size="fill">
        <TextInput label="Identifier" value={label} placeholder={`${prefix}-steady-state`} onEnter={apply}
          description={`Use @${currentLabel || `${prefix}-steady-state`} to refer to this block. Final numbering is assigned by Quarto.`}
          autoCapitalize="none" hasAutoCorrect={false} autoComplete="off" hasSpellCheck={false}
          onChange={setLabel} />
      </StackItem>
      <Button label="Generate" variant="secondary" onClick={() => setLabel(`${prefix}-${blockId.replace(/[^\w-]/g, "")}`)} />
    </HStack>
    {(isFigure || initial.type === "table") && <TextArea label="Caption" rows={2} value={caption} onChange={setCaption} />}
    {isFigure && <>
      <HStack gap={3}>
        <StackItem size="fill"><TextInput label="Width" value={width} placeholder="Auto · e.g. 70%" onChange={setWidth} onEnter={apply} /></StackItem>
        <StackItem size="fill"><TextInput label="Height" value={height} placeholder="Auto · e.g. 5cm" onChange={setHeight} onEnter={apply} /></StackItem>
      </HStack>
      <Text type="supporting" display="block">Set only width to preserve the image's proportions. Units: %, px, cm, mm, in, pt.</Text>
      <Selector label="Figure alignment" value={alignment} options={ALIGNMENTS} onChange={(value) => { if (value) setAlignment(value); }} />
      <TextInput label="Alternative text" value={altText} onChange={setAltText} onEnter={apply} />
    </>}
    {initial.type === "table" && <VStack gap={2}>
      <Heading level={4}>Columns</Heading>
      <Text type="supporting" display="block">Widths are relative shares. For example, 30 and 70 give 30% and 70%. Alignment applies to every cell in the column.</Text>
      {widths.map((value, index) => <HStack key={index} gap={2} vAlign="center">
        <Text type="label" display="block">Column {index + 1}</Text>
        <StackItem size="fill">
          <TextInput label={`Column ${index + 1} width`} isLabelHidden inputMode="decimal" value={value} onEnter={apply}
            onChange={(next) => setWidths((old) => old.map((item, i) => i === index ? next : item))} />
        </StackItem>
        <StackItem size="fill">
          <Selector label={`Column ${index + 1} alignment`} isLabelHidden value={columnAlignments[index]} options={ALIGNMENTS}
            onChange={(next) => { if (next) setColumnAlignments((old) => old.map((item, i) => i === index ? next : item)); }} />
        </StackItem>
      </HStack>)}
    </VStack>}
    {blockLabel(initial) && currentLabel !== blockLabel(initial) &&
      <Text type="supporting" display="block">Existing references use @{blockLabel(initial)}. Update those references if you change this identifier.</Text>}
  </AppDialog>;
}
