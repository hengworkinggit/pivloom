import { notFound } from "next/navigation";
import { DemoPreview } from "@/components/demo-preview";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{ revision?: string; features?: string }>;
}) {
  const { kind } = await params;
  if (kind !== "events" && kind !== "books" && kind !== "portfolio") notFound();
  const query = await searchParams;
  const revision = Number(query.revision) || 3;
  const features =
    typeof query.features === "string"
      ? query.features
          .split(",")
          .filter((feature) =>
            [
              "registration",
              "search",
              "status-filter",
              "stats",
              "responsive",
              "book-list",
              "reading-status",
              "projects",
              "about",
              "contact",
            ].includes(feature),
          )
      : undefined;
  return <DemoPreview kind={kind} revision={revision} features={features} />;
}
