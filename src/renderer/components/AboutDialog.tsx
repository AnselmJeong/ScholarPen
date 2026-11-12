import React from "react";
import { PenLine } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { AppDialog } from "./ui/app-dialog";

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: string;
}

export function AboutDialog({ open, onOpenChange, version }: AboutDialogProps) {
  return (
    <AppDialog isOpen={open} onOpenChange={onOpenChange} title="About ScholarPen" width={360}
      footer={<Button label="OK" variant="primary" onClick={() => onOpenChange(false)} />}>
      <VStack gap={3} hAlign="center" paddingBlock={2}>
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <PenLine className="h-8 w-8" strokeWidth={1.8} aria-hidden="true" />
        </div>
        <VStack gap={0.5} hAlign="center">
          <Text type="large" display="block">ScholarPen</Text>
          <Text type="supporting" display="block">Academic writing workspace</Text>
        </VStack>
        <VStack gap={0.5} hAlign="center">
          <Text type="label" display="block" hasTabularNumbers>Version {version}</Text>
          <Text type="supporting" display="block">Developed by Anselm Jeong</Text>
        </VStack>
      </VStack>
    </AppDialog>
  );
}
