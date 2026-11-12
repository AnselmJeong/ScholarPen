import React from "react";
import { VStack } from "@astryxdesign/core/VStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Divider } from "@astryxdesign/core/Divider";
import { Link } from "@astryxdesign/core/Link";
import { rpc } from "../../rpc";

/**
 * Shared building blocks for settings surfaces (Settings page, extension
 * settings, plugin settings). Every settings panel uses these so headings,
 * spacing and helper text stay identical across the app.
 */

/** One titled group of fields: heading, optional lead text, divider, fields. */
export function SettingsSection({ title, description, children, label }: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** Accessible name of the section landmark; defaults to the title. */
  label?: string;
}) {
  return (
    <section aria-label={label ?? title}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={3}>{title}</Heading>
          {description && <Text type="supporting" display="block">{description}</Text>}
        </VStack>
        <Divider />
        <VStack gap={5}>{children}</VStack>
      </VStack>
    </section>
  );
}

/** Supporting note under a field or at the end of a section. */
export function SettingsNote({ children, role }: { children: React.ReactNode; role?: "alert" | "status" }) {
  return <Text type="supporting" display="block" as="p" {...(role ? { role } : {})}>{children}</Text>;
}

/** Error message for a settings panel. */
export function SettingsError({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="text-xs text-destructive">{children}</p>;
}

/** Link that opens in the system browser (the webview never navigates away). */
export function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link onClick={() => void rpc.openExternal(href)} isExternalLink>
      {children}
    </Link>
  );
}
