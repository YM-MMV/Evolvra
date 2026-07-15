"use client";

import { useState } from "react";
import { ArrowRight, Check, Layers3, ShieldCheck, Sparkles, Target } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button, Field } from "@/components/ui";

export function Onboarding() {
  const { completeOnboarding } = useApp();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [starter, setStarter] = useState(true);

  return (
    <div className="onboarding-shell">
      <div className="onboarding-glow" />
      <main className="onboarding-card">
        <div className="brand brand-centred"><span className="brand-mark"><Sparkles size={21} /></span><span>Evolvra</span></div>
        <div className="step-dots" aria-label={`Step ${step + 1} of 3`}>
          {[0, 1, 2].map((item) => <span key={item} className={item <= step ? "active" : ""} />)}
        </div>

        {step === 0 && (
          <div className="onboarding-content">
            <p className="eyebrow">Your private command centre</p>
            <h1>Build a life you can see evolving.</h1>
            <p className="lead">Connect meaningful goals to real-world progress, focused actions, and the qualities you are developing — without guilt, punishment, or fragile streaks.</p>
            <div className="principle-grid">
              <div><Target /><span><strong>Real progress</strong><small>Measure outcomes, not busywork.</small></span></div>
              <div><ShieldCheck /><span><strong>Nothing is failed</strong><small>Pause, adapt, and keep what you earned.</small></span></div>
              <div><Layers3 /><span><strong>Your system</strong><small>Custom areas, stats, scoring, and language.</small></span></div>
            </div>
            <Button onClick={() => setStep(1)}>Begin setup <ArrowRight size={17} /></Button>
          </div>
        )}

        {step === 1 && (
          <div className="onboarding-content">
            <p className="eyebrow">Make it yours</p>
            <h1>Welcome. What should we call you?</h1>
            <p className="lead">Your birth date is optional. It powers the life calendar on your dashboard and never leaves this workspace unless you enable cloud sync.</p>
            <div className="form-stack">
              <Field label="Display name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" /></Field>
              <Field label="Birth date" hint="Optional — used only for your age and year map"><input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} /></Field>
            </div>
            <div className="button-row"><Button variant="ghost" onClick={() => setStep(0)}>Back</Button><Button disabled={!name.trim()} onClick={() => setStep(2)}>Continue <ArrowRight size={17} /></Button></div>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-content">
            <p className="eyebrow">Choose a starting point</p>
            <h1>Start guided or start clean.</h1>
            <p className="lead">Both options include the suggested areas and stats. Starter mode also adds three editable goals so you can explore every part of the system.</p>
            <div className="choice-grid">
              <button className={starter ? "choice active" : "choice"} onClick={() => setStarter(true)}><span className="choice-check"><Check size={15} /></span><Sparkles /><strong>Starter workspace</strong><small>See goals, quests, metrics, milestones, and reviews in action.</small></button>
              <button className={!starter ? "choice active" : "choice"} onClick={() => setStarter(false)}><span className="choice-check"><Check size={15} /></span><Target /><strong>Clean workspace</strong><small>Keep the suggested structure, but create every goal yourself.</small></button>
            </div>
            <div className="button-row"><Button variant="ghost" onClick={() => setStep(1)}>Back</Button><Button onClick={() => completeOnboarding(name, starter, birthDate || undefined)}>Enter command centre <ArrowRight size={17} /></Button></div>
          </div>
        )}
      </main>
      <p className="onboarding-footnote">Local-first by default · Optional private cloud sync · Your data remains yours</p>
    </div>
  );
}
