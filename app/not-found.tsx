import Link from "next/link";
import { Compass } from "lucide-react";

export default function NotFound() {
  return <div className="error-state"><span><Compass /></span><h1>This path has not been mapped.</h1><p>Return to your command centre and choose the next direction from there.</p><Link className="button button-primary" href="/">Return home</Link></div>;
}
