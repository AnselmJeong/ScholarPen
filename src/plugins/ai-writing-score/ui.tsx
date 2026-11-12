import React from "react";
import { AIDetectorSetup } from "./ui/AIDetectorSetup";
import type { ExtensionUIProps } from "../../renderer/extensions/slots";
export default function PluginUI({ workspace, projectPath }: ExtensionUIProps) {
  return <AIDetectorSetup  />;
}
