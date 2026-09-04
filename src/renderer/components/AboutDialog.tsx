import React from "react";
import { PenLine } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: string;
}

export function AboutDialog({ open, onOpenChange, version }: AboutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm px-7 pb-6 pt-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 to-violet-800 shadow-lg shadow-violet-950/25">
          <PenLine className="h-9 w-9 text-white" strokeWidth={1.8} />
        </div>
        <DialogTitle className="mt-5 text-center text-xl">ScholarPen</DialogTitle>
        <DialogDescription className="mt-1 text-center">
          Academic writing workspace
        </DialogDescription>

        <div className="mt-5 space-y-1.5 text-sm">
          <p className="font-medium text-foreground">Version {version}</p>
          <p className="text-muted-foreground">Developed by Anselm Jeong</p>
        </div>

        <Button className="mt-6 w-full" onClick={() => onOpenChange(false)} autoFocus>
          OK
        </Button>
      </DialogContent>
    </Dialog>
  );
}
