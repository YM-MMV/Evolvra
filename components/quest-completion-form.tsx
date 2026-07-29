"use client";

import { useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button, Field, Modal } from "@/components/ui";
import { WORKSPACE_TEXT_LIMITS } from "@/lib/state-schema";
import { terminologyForms } from "@/lib/terminology";
import type { Quest } from "@/lib/types";
import { isFiniteWorkspaceNumber, MAX_WORKSPACE_NUMBER } from "@/lib/utils";

export function QuestCompletionForm({
  goalId,
  quest,
  open,
  onClose,
}: {
  goalId: string;
  quest: Quest;
  open: boolean;
  onClose: () => void;
}) {
  const { state, completeQuest } = useApp();
  const goal = state.goals.find((item) => item.id === goalId);
  const terms = terminologyForms(state.settings.terminology);
  const [duration, setDuration] = useState(quest.durationMinutes === undefined ? "" : String(quest.durationMinutes));
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const initialDeltas = useMemo(
    () => Object.fromEntries(quest.metricDeltas.map((delta) => [delta.metricId, String(delta.amount)])),
    [quest.metricDeltas],
  );
  const [deltas, setDeltas] = useState<Record<string, string>>(initialDeltas);
  const parsedDuration = duration.trim() === "" ? undefined : Number(duration);
  const durationValid = parsedDuration === undefined || isFiniteWorkspaceNumber(parsedDuration, 0);
  const parsedDeltas = goal?.metrics.map((metric) => ({ metricId: metric.id, amount: Number(deltas[metric.id] ?? 0) })) ?? [];
  const deltasValid = parsedDeltas.every((delta) => isFiniteWorkspaceNumber(delta.amount));

  const submit = () => {
    if (!goal || !durationValid || !deltasValid) return;
    completeQuest(goalId, quest.id, {
      ...(parsedDuration === undefined ? {} : { durationMinutes: parsedDuration }),
      ...(note.trim() ? { note: note.trim() } : {}),
      evidence: evidence.split("\n").map((item) => item.trim()).filter(Boolean),
      metricDeltas: parsedDeltas.filter((delta) => delta.amount !== 0),
    });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} eyebrow="Record what happened" title={`Complete ${quest.title}`}>
      <div className="form-stack">
        <Field label="Actual minutes" hint="Optional — change the planned estimate if reality differed.">
          <input
            data-modal-autofocus="true"
            type="number"
            min="0"
            max={MAX_WORKSPACE_NUMBER}
            step="1"
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            placeholder="45"
            aria-invalid={!durationValid}
          />
        </Field>
        <Field label="Completion note" hint="Optional context that will stay with this occurrence.">
          <textarea rows={3} maxLength={WORKSPACE_TEXT_LIMITS.completionNote} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What changed, worked, or needs attention next?" />
        </Field>
        {goal?.metrics.length ? (
          <div className="form-stack">
            <div>
              <strong>Metric changes</strong>
              <p className="muted-copy">Confirm the real change from this occurrence. Leave a metric at zero if it did not move.</p>
            </div>
            <div className="form-grid">
              {goal.metrics.map((metric) => (
                <Field key={metric.id} label={metric.label} hint={metric.unit || undefined}>
                  <input
                    type="number"
                    step="any"
                    min={-MAX_WORKSPACE_NUMBER}
                    max={MAX_WORKSPACE_NUMBER}
                    value={deltas[metric.id] ?? "0"}
                    onChange={(event) => setDeltas((current) => ({ ...current, [metric.id]: event.target.value }))}
                    aria-label={`Change to ${metric.label}`}
                    aria-invalid={!isFiniteWorkspaceNumber(Number(deltas[metric.id] ?? 0))}
                  />
                </Field>
              ))}
            </div>
          </div>
        ) : null}
        <Field label="Evidence notes or links" hint={`Optional — one item per line. File evidence can still be attached from the ${terms.goals.singularLower} page.`}>
          <textarea rows={3} maxLength={WORKSPACE_TEXT_LIMITS.completionEvidenceItem * 100} value={evidence} onChange={(event) => setEvidence(event.target.value.split("\n").slice(0, 100).map((item) => item.slice(0, WORKSPACE_TEXT_LIMITS.completionEvidenceItem)).join("\n"))} placeholder="https://…\nShort note about the result" />
        </Field>
        {(!durationValid || !deltasValid) && <p className="evidence-message" role="alert">Use finite numbers within the supported range before recording this completion.</p>}
        <div className="button-row end">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!durationValid || !deltasValid || !goal} onClick={submit}><CheckCircle2 size={16} /> Record completion</Button>
        </div>
      </div>
    </Modal>
  );
}
