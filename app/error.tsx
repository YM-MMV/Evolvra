"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <div className="error-state"><span><AlertTriangle /></span><h1>The command centre hit a problem.</h1><p>Your saved workspace is still intact. Try reloading this view.</p><button className="button button-primary" onClick={reset}><RotateCcw size={16} /> Try again</button></div>;
}
