import React, { useState } from "react";
import type * as Y from "yjs";
import { HelpCircle, Send, User } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Card } from "@astryxdesign/core/Card";
import type { ThreadSnapshot } from "../../../shared/collab/threads";
import { answerDecision, answerDecisionsTogether, dismissDecision, openDecisions } from "../../../shared/collab/decisions";
import type { EditLevel } from "../../../shared/collab/writing";
import { PanelActions, PanelBlock, PanelError, PanelQuote } from "./panel-kit";
import { Text } from "@astryxdesign/core/Text";

/**
 * Questions ScholarPen AI needs the author to answer. Each answer goes back
 * to the AI on its thread, or all answers go into one coordinated revision.
 */
export function DecisionQueue({ ydoc, threads, level, reference, onSelect, blocked }: {
  ydoc: Y.Doc;
  threads: ThreadSnapshot[];
  level: EditLevel;
  reference: (threadId: string) => string | null;
  onSelect: (threadId: string) => void;
  /** Why a coordinated revision cannot start now (pending suggestions), if so. */
  blocked?: string | null;
}) {
  const decisions = openDecisions(threads);
  const [answers, setAnswers] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  if (!decisions.length) return null;
  const answered = decisions.filter(thread => answers.get(thread.id)?.trim());

  const run = (action: () => void, clear: string[]) => {
    setError(null);
    try {
      action();
      setAnswers(previous => {
        const next = new Map(previous);
        for (const id of clear) next.delete(id);
        return next;
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return (
    <PanelBlock label="Decisions for you" tone="attention">
      <h3 className="flex items-center gap-1.5">
        <HelpCircle className="h-3.5 w-3.5 text-amber-600" aria-hidden />
        <Text type="label" weight="semibold">Decisions for you · {decisions.length}</Text>
      </h3>
      <ul className="space-y-2">
        {decisions.map(thread => {
          const quoted = thread.meta.scope === "document" ? "Whole manuscript" : reference(thread.id);
          return (
            <li key={thread.id}>
              <Card padding={2}>
                <div className="space-y-1.5">
                  {quoted && <PanelQuote onClick={() => onSelect(thread.id)}>{quoted}</PanelQuote>}
                  <Text type="body" display="block">{thread.meta.decision!.question}</Text>
                  <TextArea label="Your answer" isLabelHidden rows={2} value={answers.get(thread.id) ?? ""}
                    placeholder="Your decision, evidence or source…"
                    onChange={value => setAnswers(previous => new Map(previous).set(thread.id, value))} />
                  <PanelActions>
                    <Button label="Answer · AI continues" size="sm" variant="secondary" isDisabled={!answers.get(thread.id)?.trim()}
                      icon={<Send className="h-3 w-3" aria-hidden />}
                      onClick={() => run(() => answerDecision(ydoc, thread.id, answers.get(thread.id) ?? ""), [thread.id])} />
                    <Button label="I'll handle it" size="sm" variant="ghost" icon={<User className="h-3 w-3" aria-hidden />}
                      onClick={() => run(() => dismissDecision(ydoc, thread.id), [thread.id])} />
                  </PanelActions>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      {decisions.length > 1 && (
        <Button size="sm" variant="primary" isDisabled={!answered.length || !!blocked} tooltip={blocked ?? undefined}
          icon={<Send className="h-3 w-3" aria-hidden />}
          label={`Send ${answered.length || ""} answers · one coordinated revision`}
          onClick={() => run(() => answerDecisionsTogether(ydoc, new Map(answered.map(thread => [thread.id, answers.get(thread.id)!])), level),
            answered.map(thread => thread.id))} />
      )}
      {error && <PanelError>{error}</PanelError>}
    </PanelBlock>
  );
}
