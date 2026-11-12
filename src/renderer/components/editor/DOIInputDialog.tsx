import React, { useState, useEffect } from "react";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { AppDialog } from "../ui/app-dialog";

interface DOIInputDialogProps {
  isOpen: boolean;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (doi: string) => void;
}

export function DOIInputDialog({
  isOpen,
  isLoading,
  error,
  onClose,
  onSubmit,
}: DOIInputDialogProps) {
  const [doi, setDoi] = useState("");

  // Start empty each time the dialog opens.
  useEffect(() => {
    if (isOpen) setDoi("");
  }, [isOpen]);

  const submit = () => {
    const trimmed = doi.trim();
    if (trimmed && !isLoading) onSubmit(trimmed);
  };

  return (
    <AppDialog isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }} title="Insert Citation via DOI" width={440} purpose="form"
      footer={<>
        <Button label="Cancel" variant="secondary" isDisabled={isLoading} onClick={onClose} />
        <Button label={isLoading ? "Resolving…" : "Add & Insert"} variant="primary" isLoading={isLoading}
          isDisabled={isLoading || !doi.trim()} onClick={submit} />
      </>}>
      <TextInput label="DOI" value={doi} onChange={setDoi} onEnter={submit} placeholder="10.1038/s41586-021-03819-2"
        isDisabled={isLoading} hasAutoFocus hasSpellCheck={false} autoCapitalize="off"
        status={error ? { type: "error", message: error } : undefined} statusVariant="detached" />
    </AppDialog>
  );
}
