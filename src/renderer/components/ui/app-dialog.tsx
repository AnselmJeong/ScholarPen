import React from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";

/**
 * The one dialog frame for ScholarPen: Astryx Dialog with a titled header
 * (close button), a scrolling body and an optional end-aligned action row.
 * Every modal in the app (core and plugins) uses this, so titles, padding,
 * dividers and button placement are identical everywhere.
 */
export function AppDialog({
  isOpen,
  onOpenChange,
  title,
  subtitle,
  width = 440,
  purpose = "info",
  footer,
  footerStart,
  children,
  hasCloseButton = true,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  width?: number | string;
  /** info: Escape and backdrop close; form: backdrop stops closing once edited; required: neither. */
  purpose?: "info" | "form" | "required";
  /** Buttons at the end of the action row (Cancel first, primary last). */
  footer?: React.ReactNode;
  /** Status text or secondary content at the start of the action row. */
  footerStart?: React.ReactNode;
  children: React.ReactNode;
  hasCloseButton?: boolean;
}) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={width} purpose={purpose}>
      <Layout
        header={<DialogHeader title={title} subtitle={subtitle} onOpenChange={hasCloseButton ? onOpenChange : undefined} />}
        content={
          <LayoutContent>
            <VStack gap={3}>{children}</VStack>
          </LayoutContent>
        }
        footer={footer || footerStart ? (
          <LayoutFooter hasDivider>
            <HStack gap={2} vAlign="center" hAlign="between">
              <div className="min-w-0 flex-1">{footerStart}</div>
              <HStack gap={2}>{footer}</HStack>
            </HStack>
          </LayoutFooter>
        ) : undefined}
      />
    </Dialog>
  );
}
