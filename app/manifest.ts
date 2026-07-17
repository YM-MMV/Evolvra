import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Evolvra · Personal Command Centre",
    short_name: "Evolvra",
    description: "Meaningful goals, genuine progress, and personal development.",
    start_url: "/",
    display: "standalone",
    background_color: "#030403",
    theme_color: "#030403",
    orientation: "portrait-primary",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
