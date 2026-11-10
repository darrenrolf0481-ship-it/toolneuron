import { createFileRoute } from "@tanstack/react-router";
import { CrimsonOS } from "@/components/crimson/shell";

export const Route = createFileRoute("/")({
  component: CrimsonOS,
});
